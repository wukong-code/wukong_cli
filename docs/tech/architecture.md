# Wukong Code 最新技术架构

> 版本: v2.1
> 日期: 2026-07-07
> 适用范围: `wukong_cli` 新 Kimi-code base
> 状态: 描述 2026-07-07 的架构基线（P0 本地验证闭环 + 0.0.12 Loop-first gate，均已实现）；0.0.13–0.1.1 的后续变化见 `docs/releases/`，代码为准。Billing、PR/Team 未排期，只在 0.3.0 付费证据满足后研究（见仓库根 `ROADMAP.md`）
> 产品定位: AI Coding Loop 的控制层与验证层（proof layer for AI-written code）

## 1. 当前事实

`wukong_cli` 当前已经切换到新 Kimi-code base。仓库里真实存在的底座包括：

- `apps/wukong`: top-level CLI、TUI、local server/web UI、ACP entrypoint。
- `packages/node-sdk`: app 和 TUI 访问 agent/runtime 的 SDK facade。
- `packages/agent-core`: agent runtime、tools、skills、permission、config 等核心能力。
- `packages/server`: 本地 REST/WebSocket server。
- `packages/acp-adapter`: Agent Client Protocol server adapter。
- `packages/oauth`: managed Wukong OAuth/provider 支持。
- `packages/migration-legacy`: legacy 数据迁移。

当前 top-level CLI 已有：

```text
wukong
wukong -p
wukong provider
wukong acp
wukong server
wukong web
wukong login
wukong doctor
wukong export
wukong vis
wukong migrate
wukong upgrade
```

商业化重构已经补齐的 P0/P0.5 本地闭环与执行核是：

```text
wukong verify
wukong scan
wukong guard
wukong proof
wukong judge
wukong loop
/verify
/scan
/guard
/goal          # 单任务驱动 agent 多轮推进；带 stop condition 时由 proof + 只读 reviewer gate 判定
wukong_verify
```

P0.5 已按 proof → judge → goal gate → loop 的顺序完成，把验证工具编排成 AI Coding Loop 的控制层：

```text
wukong proof   # Merge Proof Report（Wow Moment，第 1 步）
wukong judge   # evaluator-only 判定（第 2 步，deterministic 先行）
goal gate      # /goal verification gate（第 3 步，/loop 硬前置）
wukong loop    # 本机迭代 loop（第 4 步，核心，关机即停；--every 是 Goal-owned 可取消等待）
```

## 2. 架构原则

1. **验证核心独立成包**
   `verify`、`scan`、agent tool、未来 CI/server 都复用同一个 `@wukong/verification`。`proof`、`judge` 也复用同一核心，不引入新检测引擎。

2. **CLI 只做输入输出编排**
   `apps/wukong/src/cli/sub/*` 只解析参数、调用核心包、格式化输出和设置 exit code。
   `apps/wukong/src/tui/commands/verification.ts` 和 `packages/agent-core/src/tools/builtin/verification/wukong-verify.ts` 也复用同一核心包。

3. **确定性验证先于 AI review**
   `verify`、`scan`、`proof` 和 deterministic `judge` 不依赖模型并可离线运行；Loop gate 在这些检查通过后，再用用户配置的模型启动 fresh-context 只读 reviewer。模型不可用时返回 `inconclusive`，不会伪装成通过。

4. **loop 停止判断不由写代码的 agent 自评**
   `/loop` 的统一 `proof-pass` gate 先运行 deterministic proof，再由 fresh-context 只读 reviewer 判定；任一步未通过都不会完成。`--every` 由 Goal driver 等待，PASS、stop、cancel 都不会遗留未来 prompt。

5. **guard 是 best-effort 防护**
   P0 guard 是交互式 shell 风险确认层，不宣传不可绕过。更强隔离以后再接 sandbox/tool-policy。

6. **不复活旧 `packages/cli` / `packages/mcp-server`**
   legacy 文档和旧 MCP server 架构不再作为实现依据。

## 3. 目标模块图

```mermaid
flowchart TD
  CLI["apps/wukong CLI"] --> VerifyCmd["verify / scan / guard commands"]
  VerifyCmd --> Verification["@wukong/verification"]
  TUI["apps/wukong TUI slash commands"] --> Verification
  AgentCore["packages/agent-core wukong_verify tool"] --> Verification
  Server["packages/server"] -. future local API .-> Verification

  Verification --> GitInspector["GitInspector"]
  Verification --> ScriptDetector["ScriptDetector"]
  Verification --> CommandRunner["CommandRunner"]
  Verification --> RiskScanner["RiskScanner"]
  Verification --> PolicyEngine["PolicyEngine"]
  Verification --> ReportWriter["ReportWriter"]

  GuardCmd["wukong guard"] --> PolicyEngine
  GuardCmd --> GuardState["~/.wukong/guard"]
  ReportWriter --> ReportState["./wukong-verification-report.md"]
```

## 4. `@wukong/verification` 包

新增包：

```text
packages/verification/
  package.json
  tsconfig.json
  tsdown.config.ts
  src/
    index.ts
    types.ts
    git.ts
    scripts.ts
    runner.ts
    risks.ts
    policy.ts
    report.ts
    verify.ts
    scan.ts
    guard.ts
  test/
    verify.test.ts
    scan.test.ts
    policy.test.ts
```

职责：

- 检测 git 状态和 diff。
- 自动识别 Node 项目的 `lint`、`typecheck`、`test`、可选 `build`。
- 执行显式或自动选择的命令。
- 扫描 diff 和文件名风险。
- 生成 Markdown report 和 JSON result。
- 提供 guard command risk classifier。

不负责：

- Commander 参数解析。
- TUI 交互。
- 云端上传。
- 计费。
- 完整 sandbox。

## 5. CLI 命令层

新增文件：

```text
apps/wukong/src/cli/sub/verify.ts
apps/wukong/src/cli/sub/scan.ts
apps/wukong/src/cli/sub/guard.ts
```

并在 `apps/wukong/src/cli/commands.ts` 注册：

```ts
registerVerifyCommand(program);
registerScanCommand(program);
registerGuardCommand(program);
```

### `wukong verify`

契约：

```bash
wukong verify
wukong verify --build
wukong verify --command "pnpm test"
wukong verify --report ./reports/evidence.md
wukong verify --timeout 180
wukong verify --json
wukong verify --no-report
```

退出码：

| 情况 | exit code |
|---|---:|
| 命令通过且没有 high risk | 0 |
| 命令通过但有 low/medium risk | 0 |
| 命令失败或有 high risk | 1 |
| 参数/环境错误 | 2 |

### `wukong scan`

契约：

```bash
wukong scan
wukong scan --diff
wukong scan --secrets
wukong scan --json
wukong scan --report ./reports/risk.md
```

`scan` 不运行项目命令，只做只读风险扫描。

### `wukong guard`

契约：

```bash
wukong guard --status
wukong guard --stats
wukong guard --enable
wukong guard --disable
wukong guard -- rm -rf ./tmp
```

P0 行为：

- `--status`: 显示 guard 是否启用。
- `--stats`: 显示本地 guard event 统计。
- `--enable`: 写入本地配置，P0 不自动改用户 shell profile。
- `--disable`: 关闭本地配置。
- `-- <command>`: 对命令做风险分类，高风险默认返回非零并提示用户。

## 6. 数据与文件

P0 本地文件：

```text
./wukong-verification-report.md
~/.wukong/guard/config.json
~/.wukong/guard/events.jsonl
```

上传/同步不是 P0 的必需能力。未来如果接云端，默认只上传 metadata 和 redacted report。

## 7. 风险规则

### Diff 风险

| 规则 | 等级 |
|---|---|
| `TODO/FIXME/placeholder/not implemented/coming soon` | high |
| `mock/fake/dummy/hardcoded/sample data` | high |
| `describe.only/it.only/test.only` | medium |
| `describe.skip/it.skip/test.skip` | medium |
| `console.log/debugger` | medium |
| `.env/secret/credential/private-key` 文件变化 | high |
| 源码变更但无测试变更 | medium |
| 未发现验证命令 | high |

### Command 风险

| 命令 | 条件 | 等级 |
|---|---|---|
| `rm` | 包含 `-r` 或 `-f` | high |
| `git` | `reset --hard` | high |
| `git` | `clean -f/-df/-xdf` | high |
| `curl/wget` | pipe 到 shell 或上传数据 | high |
| `bash/sh/zsh` | 参数中包含 `curl` 或 `wget` | high |

## 8. 自动化测试

最低测试层级：

1. `packages/verification/test/*`: core unit tests。
2. `apps/wukong/test/cli/verification-commands.test.ts`: CLI command registration / smoke tests。
3. `apps/wukong/test/tui/commands/verification.test.ts`: TUI verification slash command handlers。
4. `packages/agent-core/test/tools/wukong-verify.test.ts`: agent tool execution and structured summary。
5. `pnpm --filter @wukong/verification test`。
6. `pnpm --filter @wukong/wukong run typecheck`。
7. `pnpm --filter @wukong/agent-core run typecheck`。
8. `pnpm -C apps/wukong run dev:cli-only -- verify --no-report`。
9. `pnpm -C apps/wukong run dev:cli-only -- scan --json`。
10. `pnpm -C apps/wukong run dev:cli-only -- guard --status`。

## 9. 后续扩展

P1:

- Loop outcome history。
- `review --deep`。

P2:

- team rules。
- audit log。
- hosted Loop execution。
- sandbox runner。
