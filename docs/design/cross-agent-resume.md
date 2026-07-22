# 跨 Agent Session Resume 设计

> 状态：本地 discovery、来源 picker 和只读继续已实现
> 版本：当前主干能力，不绑定支付版本
> 最后更新：2026-07-18

## 结论

Wukong 扩展现有 `/resume`，但保留最简单的默认语义：裸 `/resume` 恢复 Wukong 会话；只有显式指定来源时，才在同一套 picker UI 中查看并继续 Codex、Claude Code 或 Cursor 的本地会话。

主入口保持一个：

```text
/resume
```

可选来源筛选：

```text
/resume codex
/resume claude
/resume cursor
```

`/resume-codex`、`/resume-claude`、`/resume-cursor` 可以作为兼容别名，但不进入主要命令列表。用户不应该先判断会话来自哪个工具，再选择不同入口。

这项能力适合作为免费迁移和激活入口，而不是单独付费点：用户可以把其他 coding agent 中尚未完成的工作带到 Wukong，再使用 `/loop` 完成修改、检查和独立 review。

## 调研依据

Grok Build `0.2.100` 已在统一 session picker 中加入最近 Claude Code、Codex 和 Cursor session，并在欢迎页提供继续入口：

- <https://x.ai/build/changelog>
- <https://docs.x.ai/build/modes-and-commands>
- <https://docs.x.ai/build/cli/reference>

本机 `grok 0.2.101` 也已验证包含 `resume-claude`、`resume-codex`、`resume-cursor` 兼容入口，并默认开启 Claude、Codex、Cursor session compatibility。

这个设计的核心价值不是复制三个命令，而是降低跨工具继续工作的成本。

## 当前实现

Wukong 当前具备：

- TUI `/resume` 是主命令，`/sessions` 仅作为兼容别名，打开现有 session picker。
- CLI 支持 `wukong --session [id]`，并兼容隐藏参数 `--resume [id]`。
- `wukong --continue` 可以继续当前工作目录最近的 Wukong session。
- agent-core 已有 session store、事件 replay、按工作目录索引和 legacy session migration。
- `/resume` 保持原语义，只显示 Wukong session。
- `/resume codex|claude|cursor` 显式打开对应外部来源的 picker。
- `/resume-codex`、`/resume-claude`、`/resume-cursor` 已作为隐藏兼容入口。
- picker 明确显示 `[Codex]`、`[Claude]`、`[Cursor]` 来源标签。
- 外部 session 被选中后，调用对应内置 resume Skill，只读提取对话上下文并在当前 Wukong session 中继续。
- 损坏或无法识别的单个 transcript 会被跳过，不影响 Wukong 原生 session。

当前实现不把整份外部 transcript 复制进 Wukong session store，也不建立增量同步。Wukong session 原生 replay；外部 session 采用一次性、只读上下文导入。

## Resume 的语义边界

“恢复 Wukong session”和“继续外部 session”不是同一种操作，UI 和数据模型必须明确区分。

| 来源 | 行为 | 语义 |
|---|---|---|
| Wukong | 直接打开原 session 并 replay | 原生恢复 |
| Codex | 读取落盘历史，在当前 Wukong session 中继续 | 导入并继续 |
| Claude Code | 读取落盘历史，在当前 Wukong session 中继续 | 导入并继续 |
| Cursor | 读取可识别 transcript，在当前 Wukong session 中继续 | 导入并继续 |

外部 session 可以导入：

- 用户消息和 assistant 消息
- 可安全解析的工具调用与工具结果
- 标题、工作目录、时间、来源 session ID
- 已落盘的摘要、任务和最终状态
- 当前 Git branch / commit（来源中存在时）

外部 session 不能承诺恢复：

- 厂商服务端未落盘状态
- 隐藏 reasoning、KV cache 或 prompt cache
- 正在运行的后台任务和子 agent
- 原工具的临时权限授权
- 仍在运行的 MCP、terminal 或 IDE 进程
- 未落盘的消息、附件或编辑缓冲区

因此外部来源的主要动作应显示为：

```text
Import and continue in Wukong
```

不能把它描述为继续运行原 Codex、Claude Code 或 Cursor 进程。

## 目标交互

各来源 picker 默认把当前仓库、最近活动的 session 排在前面。裸 `/resume`：

```text
SESSIONS

Fix authentication flow                  5m ago
```

显式 `/resume codex`：

```text
SESSIONS

[Codex] Review dashboard layout          18m ago
```

选择 Wukong session：

```text
Resume session
```

选择外部 session：

```text
Import and continue
Import and start /loop
Cancel
```

导入成功后在当前 Wukong session 中显示一次性来源提示：

```text
Imported from Codex · original session abc123 · local only
```

## 数据源与 adapter

实现时使用独立的只读 adapter，不让 TUI 直接解析各厂商文件：

```ts
interface ExternalSessionAdapter {
  source: 'codex' | 'claude' | 'cursor';
  isAvailable(): Promise<boolean>;
  list(query: ExternalSessionQuery): Promise<ExternalSessionSummary[]>;
  read(ref: ExternalSessionRef): Promise<NormalizedExternalSession>;
}
```

当前代码先实现 summary discovery，并由三个内置 resume Skill 承担选中后的 transcript 投影。完整 importer adapter、fingerprint 和增量导入仍属于后续增强，不是当前命令可用性的前置条件。

已知本地来源：

| 来源 | 常见位置 | 备注 |
|---|---|---|
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | JSONL；需要过滤系统/运行时事件，只投影可继续的 conversation |
| Claude Code | `~/.claude/projects/*/*.jsonl`、`sessions-index.json` | JSONL + 可选索引；项目目录编码需要稳定解码 |
| Cursor | `~/.cursor/projects/*/agent-transcripts/` 等 | 格式和版本差异较大，必须 feature-detect，不能依赖单一路径 |

统一投影至少包含：

```ts
interface NormalizedExternalSession {
  source: 'codex' | 'claude' | 'cursor';
  externalSessionId: string;
  title?: string;
  workDir?: string;
  branch?: string;
  startedAt?: string;
  updatedAt?: string;
  messages: NormalizedExternalMessage[];
  sourcePath: string;
  sourceFingerprint: string;
}
```

adapter 只负责 discovery、解析和标准化。当前由内置 Skill 将选中历史投影到本轮上下文；未来若落盘完整导入，再由共享 importer 负责写入、去重和 replay。

## 导入流程

1. `/resume` 打开 picker。
2. 并行读取 Wukong session index 和已启用的外部 adapter 摘要。
3. 当前 Git 仓库和工作目录匹配项优先，其次按最后活动时间排序。
4. 用户显式选择外部 session 后才读取完整 transcript。
5. 标准化消息，限制单条工具输出和总导入体积。
6. 将来源 metadata 作为内置 resume Skill 参数，在当前 Wukong session 中生成一次性上下文。
7. 历史只用于总结，不重新执行旧工具调用。
8. 重新检查 workspace 后继续；用户仍可显式进入 `/loop`。

未来完整落盘导入使用以下键去重：

```text
(source, external_session_id, source_fingerprint)
```

同一个外部 session 有新内容时允许创建增量导入或更新既有 imported session；具体策略实现前通过 E2E 冻结，不能静默重复插入全部消息。

## 安全与隐私边界

- 默认只扫描本地已知 session 根目录，不做网络请求。
- picker 列表阶段只读取 metadata；用户选择后才读取完整 transcript。
- 默认不上传 transcript、代码、diff、附件或来源路径。
- 不复制 API key、OAuth token、环境变量、MCP credential、permission grant。
- 工具调用只作为历史展示，不重新执行。
- 大型输出、二进制附件和未知事件跳过或截断，并向用户显示导入警告。
- 所有路径必须规范化并限制在允许的 session 根目录内，拒绝越界 symlink。
- 解析失败只影响单个外部 session，不阻塞 Wukong 自身 `/resume`。
- 外部格式变化采用 fail-closed adapter，不把损坏或无法识别的记录强行写入 Wukong session。

## 与 Loop 的连接

跨 Agent Resume 的产品价值应落到 Loop，而不是停留在聊天记录浏览：

```text
Codex / Claude / Cursor unfinished session
                ↓
        /resume import
                ↓
       Wukong session
                ↓
      continue or /loop
                ↓
 deterministic checks + fresh review
```

进入 `/loop` 前必须重新读取当前 workspace 和 Git 状态。外部 transcript 中的“测试已通过”“文件已修改”等说法只作为历史上下文，不能替代 Wukong 当前轮的真实检查。

## 非目标

- 不控制或重新启动原厂商进程。
- 不同步厂商云端 session。
- 不承诺转换隐藏 reasoning。
- 不导入或继承外部工具的权限。
- 不把外部 session 数量纳入 Loop quota。
- 不把完整 transcript 持久化、增量同步或自动进入 `/loop` 宣传为已实现。

## 后续增强的验证条件

若增加完整 importer、增量同步或自动进入 `/loop`，至少完成：

1. 用真实 Codex、Claude Code、Cursor session 样本验证格式和版本差异。
2. 为三种来源建立脱敏 fixture，并确认不会包含凭证。
3. 冻结 normalized message contract、截断规则和去重策略。
4. 验证导入历史不会重新执行工具调用。
5. 验证当前仓库优先排序、损坏 JSONL、超大 transcript、移动工作目录和 symlink 边界。
6. 完成“外部 session → Wukong session → `/loop` → 当前 workspace 重新验证”的真实 E2E。

当前 MVP 已满足本地发现、来源筛选、失败隔离和不重放工具调用。以上条件约束的是后续的完整持久化与自动化增强。
