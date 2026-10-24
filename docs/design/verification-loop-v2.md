# 0.0.12 Loop-first 开发闭环

> Internal engineering record — kept in Chinese. English product docs: the user guide and release notes.

> 状态：0.0.12 已实现
> 目标版本：`0.0.12`
> 最后更新：2026-07-16

## 1. 产品决定

0.0.12 只突出一个核心能力：

> **Wukong Loop：让 Agent 持续开发、检查和修复，直到达到可交付状态。**

`verify`、`scan`、`proof` 不再是三个需要用户理解和分别付费的核心产品。它们降级为 Loop 内部检查层，同时保留独立 CLI 入口供 CI、脚本和高级调试使用。

这一版遵守六个原则：

1. 用户主入口是 `wukong loop "<goal>"` 或 TUI `/loop <goal>`。
2. Loop 自动完成修改、真实工程检查、独立模型审查和继续修复。
3. 用户只看到 `PASS`、`NEEDS_WORK`、`ERROR` 三种最终状态。
4. 真实命令失败不能被模型改成 PASS；模型审查可以把检查通过收紧为 NEEDS_WORK。
5. 默认不生成 Report、不写 Evidence、不上传；只在用户明确要求时保存最终结果。
6. 商业额度只围绕 Loop sessions 和迭代深度，不对本地规则命令分别收费。

## 2. 用户心智模型

默认使用：

```bash
wukong loop "add user authentication"
wukong loop "fix checkout race condition" --model fast
wukong loop "review authorization boundaries" --review-model strict
```

TUI：

```text
/loop add user authentication
/loop status
/loop pause
/loop resume
/loop stop
```

用户不需要先运行 `verify`、`scan` 或 `proof`，也不需要创建报告或选择 artifact mode。

高级入口仍可直接调用：

```bash
wukong verify   # 调试 Loop 发现并运行的工程检查
wukong scan     # 调试快速风险提示
wukong proof    # 调试当前 Loop gate 输入和结论
```

这些命令不占独立产品额度，不作为默认 onboarding 和导航入口。

## 3. Loop 状态机

```text
INSPECT
  识别项目、目标、改动范围和可执行检查
    ↓
WORK
  writer agent 修改代码
    ↓
CHECK
  运行真实 test/lint/typecheck/build/用户 gate
    ↓
REVIEW
  fresh-context reviewer 阅读 goal、diff 和检查结果
    ↓
PASS ───────────────→ 完成
NEEDS_WORK ─────────→ 把结构化 blocker 注入下一轮 WORK
ERROR ──────────────→ 停止并给出恢复动作
```

Loop 只有在 gate 返回 `NEEDS_WORK` 时进入下一轮。`ERROR` 不能继续调用 writer；可恢复的进程错误最多原地重试一次，不增加 iteration。

达到最大轮次时返回 `NEEDS_WORK`，`reasonCode=max_iterations`，不能假装成功。

## 4. 内部检查层

### 4.1 Check runner（原 verify）

职责是发现并运行真实工程命令：

- test
- lint
- typecheck
- build（按项目配置或目标需要）
- `.wukong` 中用户明确定义的 gate

它只提供事实：执行了什么、退出码、耗时和截断输出。它不单独决定产品是否值得付费。

### 4.2 Risk hints（原 scan）

职责是提供快速、可定位的风险线索：

- secret 和敏感文件
- 明显危险配置
- skipped/only test
- placeholder/debug output
- file-aware 规则

规则结果是 reviewer 的输入，不单独制造“安全证明”。没有明确证据的提示不能阻止 Loop 通过。

### 4.3 Delivery gate（原 proof）

Proof 不再是 Report 产品，而是 Loop 的内部停止判定：

```text
goal + snapshot + diff + check results + risk hints
                         ↓
                fresh reviewer model
                         ↓
              PASS / NEEDS_WORK / ERROR
```

Reviewer 必须运行在 fresh context，默认只读；写代码的 agent 不能同时充当最终判定者。

## 5. 没有测试的项目

Loop 不能因为“没有发现测试”直接假装 PASS：

| 场景 | Gate 结果 |
|---|---|
| 没有任何可执行检查，且修改了源码 | `NEEDS_WORK / tests_missing`，下一轮优先补最小测试或项目 gate |
| 有 lint/typecheck，但项目完全无测试且修改了核心逻辑 | reviewer 决定是否 `NEEDS_WORK`，必须给出具体缺口 |
| 只有文档、文案或非运行时配置变化 | 可由 reviewer 判 PASS，但必须说明没有运行测试的原因 |
| 检查发现配置/runtime 缺失，无法判断 | `ERROR / no_verification_plan` |
| 用户明确配置自定义 gate 且通过 | 作为真实检查事实进入 reviewer |

模型可以帮助发现 `pytest`、`go test ./...`、`cargo test`、workspace 子项目或自定义测试入口，但未经项目授权不能直接执行任意新 shell command。

## 6. 统一最终结果

```ts
interface LoopResult {
  readonly schemaVersion: 2;
  readonly status: 'PASS' | 'NEEDS_WORK' | 'ERROR';
  readonly reasonCode: string;
  readonly summary: string;
  readonly iterations: number;
  readonly checks: readonly CheckResult[];
  readonly blockers: readonly LoopBlocker[];
  readonly reviewer?: ReviewerMetadata;
  readonly role?: string;
}
```

| 状态 | Exit code | 含义 |
|---|---:|---|
| `PASS` | `0` | 真实检查和 reviewer 都允许交付 |
| `NEEDS_WORK` | `1` | 有具体 blocker，或达到轮次上限 |
| `ERROR` | `2` | 未完成 gate，例如环境、配置、snapshot 或模型错误 |
| 登录/额度阻止执行 | `3` | 不是 LoopResult |
| 用户中断 | `130` | 不产生新的最终结论 |

默认终端输出只回答：结果、完成了什么、最重要的 blocker、下一步。

## 7. Writer 与 Reviewer 模型

Loop 使用两个职责，不要求两个不同供应商模型：

- writer：理解目标、修改代码、根据反馈继续修复。
- reviewer：fresh context、默认只读，只根据目标、当前 diff 和真实检查判定。

0.0.12 的模型优先级：

```text
writer:   --model > role model > 用户 default model
reviewer: 继承 writer model
```

Reviewer 规则：

- 真实命令失败或未完成不能改成 PASS。
- 可把 deterministic pass 收紧为 NEEDS_WORK。
- blocker 必须包含文件/位置、证据和可执行下一步。
- 没有证据的猜测只能成为 note。
- 发送给 provider 的内容先 redaction，只包含 goal、必要 diff、检查摘要和允许文件。

`--review-model` 和 role 独立 reviewer model 延后到0.0.13；0.0.12先验证独立上下文与可靠停止条件，不增加第二套模型配置。

## 8. Role Profiles

Role Profile 控制 writer 如何工作，也可以指定 reviewer 模型和检查 profile；不创建第二套 agent 系统。

已实现基础能力：

- 内置 `general`、`reviewer`、`planner`、`strategist`、`security`、`tester`
- 用户角色 `~/.wukong/roles/<name>.md`
- 项目角色 `.wukong/roles/<name>.md`，显式使用 `project:<name>`
- `wukong roles list/show/init`
- TUI `/transform`（CLI `roles` 只管理角色目录）

需要角色化 writer 时，在同一个 TUI 会话中先切换角色再启动 Loop：

```text
/transform security
/loop finish auth
```

角色工具 allowlist 只能收窄基础权限，不能扩大权限或内嵌 shell command。0.0.12 不做角色市场、团队同步或自动多角色编排。

Role Profiles 目前仍由实验开关控制：

```toml
[experimental]
role_profiles = true
```

## 9. Loop 额度与付费边界

> 历史决策记录：本节的 Guest/Free 数字仍描述 0.0.12 已发布 contract。2026-07-20 的 PR Gate 单点付费假设现已[归档](historical-pro-pr-gate-billing.md)；2026-07-25 起，0.1.0 是 Free Trusted Local Loop，0.2.0 才是 Reliable Autonomy 商业候选。

0.0.12 只设置一个用户可理解的额度：Loop sessions。

| 身份 | Loop sessions | 每个 session 最大轮次 |
|---|---:|---:|
| 未登录试用 | 1 次总计 | 2 |
| Free | 10 次/月 | 5 |
| Pro Preview | 更高额度或 fair use | 更高上限 |

计数规则：

- 启动一次 Loop 计一个 session；内部 CHECK/REVIEW 不重复计数。
- 本地独立 `verify/scan/proof` 高级命令不使用产品额度。
- 参数、role、model、project trust 在启动前失败不计数。
- Loop start 成功后即计数；取消、失败或崩溃不退款，避免 reservation/lease 复杂度。
- BYOK 模型 token 由用户承担，不新增 AI credits。
- Free 用户从当月第3次开始看到 Pro 提示并记录 upgrade intent，第10次后才硬限制；提示不消耗额外额度。

后续版本决策（2026-07-25 更新）：

- 0.1.0：Free Trusted Local Loop，不设置服务端 Loop allowance 或付费 entitlement。
- 0.2.0 候选：有界并行、显式 Detach、本机 Supervisor 与可选 Verified PR Gate；不对 BYOK token 加价。
- managed reviewer、后台/云端 Loop、Team Role/Policy、组织 gate、审计和 private runner 继续后移。

不把规则扫描、测试命令包装器或 Report 文件本身当作主要付费理由。

## 10. Snapshot、信任与反馈

每轮 gate 使用新的 `WorkspaceSnapshot`：

```ts
interface WorkspaceSnapshot {
  readonly id: string;
  readonly cwd: string;
  readonly headSha?: string;
  readonly inputDigest: string;
  readonly configDigest: string;
  readonly planDigest: string;
}
```

- writer 修改后重新建立 snapshot，不能复用上一轮结果。
- 检查期间 workspace 改变时最多重建一次；再次变化返回 `ERROR/workspace_changed`。
- 自动 Loop 和非交互模式必须信任当前 `repo identity + planDigest`。
- 自定义 command 首次执行必须确认；project config 或 role 变化后重新确认。
- 反馈只包含结构化 blocker、失败命令摘要和 next action，并限制大小。

## 11. Evidence 与 Dashboard

默认 Loop 不生成中间或最终文件，不上传源码或 diff。

| 方式 | 行为 |
|---|---|
| 默认 | 只输出最终 LoopResult |
| `--json` | JSON stdout，不落盘 |
| 旧高级命令显式 report | 继续写本地 Markdown 文件 |

中间 CHECK/REVIEW 不上传。Dashboard 只展示 Loop 用量、重置时间和最近最终状态，不上传 diff 或 evidence。Loop 的完成步骤只依赖当前 workspace 的本地 gate。

## 12. 旧命令兼容与降级

| 旧 surface | 0.0.12 行为 |
|---|---|
| `wukong verify/scan/proof` | 保留为 advanced/CI/debug 命令，不在主 onboarding、TUI 主 palette 或产品额度中突出 |
| TUI `/verify`、`/scan`、`/proof` | 从默认 palette 隐藏；旧输入仍可执行并提示它们是 Loop 内部阶段 |
| `--report` | 兼容旧脚本，仅显式调用才写本地 evidence |
| `verify-pass`、`scan-clean`、`judge-pass` | 旧 Goal records 继续解析；新 Loop 默认统一为 `proof-pass` |

不在0.0.12直接删除公开命令或 flag；真正删除属于单独的 breaking change。

## 13. 0.0.12 实现范围

必须完成：

1. `/loop` 与 `wukong loop` 默认使用 `proof-pass` gate。
2. 每轮自动执行 INSPECT → WORK → CHECK → REVIEW。
3. reviewer 使用 fresh context，只读并输出结构化 blocker。
4. 没有测试/没有检查按第5节处理，不能空 PASS。
5. NEEDS_WORK 自动进入下一轮；ERROR 停止；最大轮次不假成功。
6. Role Profile 接入 writer/reviewer/check profile。
7. 只保留 Loop session 额度，内部 gate 不重复计数。
8. 默认不生成 Report；旧独立命令降级但保持兼容。

明确不做：

- 不做 managed model credits。
- 不做角色市场和团队同步。
- 不做 Stripe 完整生命周期。
- 不做 GitHub PR comment/status check。
- 不做云端后台 Loop；本机 Loop 关机即停。
- 不把 Report management 做成主产品。
- 不做 Loop evidence 上传或 Dashboard evidence 迁移。
- 不做独立 reviewer model；reviewer 在 fresh context 中继承 writer model。

## 14. 发布门槛

1. 新用户只通过一条 Loop 命令完成首次开发闭环。
2. writer 不能自评完成；每轮必须经过真实 CHECK 和 fresh REVIEW。
3. 项目没有测试时不能空 PASS，并能给出补测试或配置 gate 的动作。
4. 真实命令失败不能被 reviewer 改成 PASS。
5. 每轮使用新 snapshot，结构化反馈能驱动下一轮修复。
6. `/transform` 能影响当前 TUI 会话中的 Loop writer；reviewer 固定使用只读 profile。
7. Loop session 计数幂等；内部检查不重复计费。
8. 默认运行不新增 Report 文件、不上传。
9. 旧 verify/scan/proof 脚本仍能运行，但不再占据主产品界面。
10. 达到最大轮次或用户中断时不产生虚假 PASS。
