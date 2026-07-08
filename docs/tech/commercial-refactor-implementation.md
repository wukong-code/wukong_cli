# Wukong 商业化重构技术实现方案

> 版本: v1.2
> 日期: 2026-07-07
> 对应商业方案: `docs/business/COMMERCIAL_REFACTOR_PLAN.md`
> 适用范围: `wukong_cli` 新 Kimi-code base；legacy 代码只作为迁移参考；web/计费不在本轮修改范围内。

---

## 1. 目标与事实基线

### 1.1 技术目标

本方案的目标是把 Wukong 从 "Kimi-code base + 旧版 companion 残留" 重构为 **AI Coding Loop 的控制层与验证层（proof layer for AI-written code）**。

P0 必须交付的真实能力是:

1. `wukong verify`: 本地验证当前代码改动,生成可追溯证据报告。
2. `wukong scan`: 只读风险扫描,不执行项目命令。
3. `wukong guard`: 拦截或确认高风险终端命令。
4. `wukong_verify`: 让外部 AI agent 通过 MCP / tool 方式调用验证。
5. 报告和本地统计为后续云端、团队与商业化能力提供数据基础。

P0.5 必须交付的核心能力是（见 §8.5,按实施顺序）:

6. `wukong proof` / `/proof`: Merge Proof Report,把 verify+scan+report 串成可分享的合并证据（Wow Moment）。
7. `wukong judge` / `/judge`: evaluator-only 判定,复用 verification 引擎,只审不写,deterministic 模式先行。
8. `/goal` verification gate: 把 `/goal` 的完成判定从 agent 自评升级为 deterministic gate,是 `/loop` 的硬前置。
9. `wukong loop` / `/loop`: 本机迭代 loop,把"写 → 验 → 修"串成自动循环直到停止条件满足,关机即停,是产品组织核心。

### 1.2 当前事实

当前代码不是从零开始,但也不是商业方案里描述的 "新 base 已经完整实现 verify/guard"。

实际状态如下:

| 模块 | 当前状态 | 处理方式 |
|---|---|---|
| `wukong_cli` | 新 Kimi-code base,已有 CLI/TUI/Server/Agent/MCP/ACP/Provider/Skill 底座 | 作为当前主仓库和运行内核 |
| `wukong_cli_legacy` | 有旧 `verify`、`guard`、`wukong_verify` 实现 | 作为迁移种子,不能作为长期依赖 |

必须修正的口径:

- 商业文档中提到的 `packages/cli/src/commands/verify.ts`、`guard.ts` 是 legacy 路径,不是新 base 路径。
- 新 base 当前 CLI 命令注册点是 `apps/wukong/src/cli/commands.ts`。
- 新 base 当前 CLI 子命令目录是 `apps/wukong/src/cli/sub/`。
- 新 base 当前适合承载共享能力的位置是 `packages/*`,其中 `agent-core` 适合 agent tool,但验证核心建议单独抽包。

---

## 2. 设计原则

### 2.1 核心原则

1. **验证核心独立于 CLI**
   - `verify` 不能只写在 `apps/wukong` 里。
   - CLI、TUI slash command、agent tool、CI 都应复用同一套验证核心。

2. **deterministic verification 与 AI review 分层**
   - `verify` 默认不依赖模型,必须可离线运行。
   - `review --deep` 才调用模型和消耗 credits。

3. **guard 与 scan 共用风险规则**
   - `scan` 发现代码风险。
   - `guard` 拦截命令风险。
   - 两者底层都应复用 `PolicyEngine` / `RiskRule`。

4. **先本地闭环,再外部商业化**
   - P0 先做本地可用。
   - P1 再定义 report metadata、分享链接、quota 接口。
   - P2 再做 team rules、audit log、组织 dashboard。

5. **不复活旧 mcp-server 架构**
   - legacy 的 MCP tool 定义可以迁移。
   - 但新实现应接入新 base 的 `agent-core` / MCP / plugin 架构。

6. **loop 停止判断不由 agent 自评**
   - `/goal`、`/loop`、`/schedule` 的停止判断必须由 deterministic verification（`verify`/`scan`）、独立 evaluator（`/judge`），或自定义验证 skill 决定。
   - 禁止写代码的 agent 自己判断"我完成了"。
   - 事实核对：当前已实现的 `/goal` 完成判定仍是 agent 自评（agent 调用 goal 工具宣布 completed），可选 verify 字段只是自由文本提示。因此 §8.5.4 的 verification gate 是 P0.5 硬前置，落地前 `/loop` 不得复用 `/goal` 执行核。

7. **loop 质量靠系统而非靠运气**（借鉴 Claude Code）
   - 保持 codebase 整洁：agent 遵循已有模式和约定。
   - 给 agent 自验证能力：用 verification + verify-skill 编码"什么叫好"，检查越定量越有效。
   - 文档可达：框架/库文档保持最新最佳实践。
   - 第二 agent 审查：`/judge --agent` 提供 fresh-context 对抗性审查（P0.5 末 / P1 初），loop 出口可挂载。

8. **时间触发不重复造引擎**
   - `packages/agent-core/src/tools/cron/` 已有完整的会话内调度引擎（CronScheduler：recurring/one-shot、jitter、coalescing、会话持久化与 resume 恢复）。
   - `/loop` 的可选 `--every` 轮间节流必须复用该引擎，不新写 timer orchestrator。
   - 定时巡检型任务（如"每小时 check PR"）不属于 `/loop`：本机由 cron 工具承载，云端归 `/schedule`。

---

## 3. 目标架构

```mermaid
flowchart TD
  CLI["apps/wukong CLI"] --> Verification["@wukong/verification"]
  TUI["apps/wukong TUI slash commands"] --> Verification
  AgentTool["agent-core builtin tool / MCP bridge"] --> Verification
  Server["packages/server / future API"] -.-> Verification

  Verification --> GitInspector["GitInspector"]
  Verification --> ScriptDetector["ScriptDetector"]
  Verification --> CommandRunner["CommandRunner"]
  Verification --> RiskScanner["RiskScanner"]
  Verification --> ReportWriter["EvidenceReportWriter"]

  CLI --> Guard["Guard CLI"]
  Guard --> GuardInstaller["ShellHookInstaller"]
  Guard --> GuardRuntime["GuardRuntime"]
  GuardRuntime --> PolicyEngine["PolicyEngine"]
  RiskScanner --> PolicyEngine

  Server -. future .-> CloudData["Reports / Quota / Billing"]
  Verification --> LocalStore["~/.wukong/reports + stats"]
```

### 3.1 新增包

新增 workspace package:

```text
packages/verification/
  package.json
  tsconfig.json
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
    storage.ts
  test/
    verify.test.ts
    scan.test.ts
    policy.test.ts
    report.test.ts
```

包名建议:

```json
{
  "name": "@wukong/verification",
  "private": true,
  "type": "module"
}
```

先保持 `private: true`,等 API 稳定后再决定是否公开。

### 3.2 CLI 新增文件

```text
apps/wukong/src/cli/sub/verify.ts
apps/wukong/src/cli/sub/scan.ts
apps/wukong/src/cli/sub/guard.ts
apps/wukong/src/cli/sub/loop.ts        # P0.5（本机迭代 loop，最后落地）
apps/wukong/src/cli/sub/proof.ts       # P0.5
apps/wukong/src/cli/sub/judge.ts       # P0.5
apps/wukong/src/cli/sub/schedule.ts    # P2（云端例程，归 hosted）
apps/wukong/src/cli/sub/review.ts      # P1
apps/wukong/src/cli/sub/ship.ts        # P1
apps/wukong/src/cli/sub/retro.ts       # P1
```

并在 `apps/wukong/src/cli/commands.ts` 注册:

```ts
registerVerifyCommand(program);
registerScanCommand(program);
registerGuardCommand(program);
registerLoopCommand(program);   // P0.5
registerProofCommand(program);  // P0.5
registerJudgeCommand(program);  // P0.5
```

### 3.3 Agent / MCP 工具新增位置

优先接入新 base 工具体系:

```text
packages/agent-core/src/tools/builtin/verification/wukong-verify.ts
packages/agent-core/src/tools/builtin/verification/wukong-verify.md
```

工具名保持:

```text
wukong_verify
```

工具行为:

- 默认使用当前 workspace。
- 可传 `cwd`、`commands`、`includeBuild`、`writeReport`、`reportPath`、`timeoutSeconds`。
- 返回 structured result,不要只返回 Markdown 文本。

---

## 4. P0: `wukong verify`

### 4.1 命令契约

```bash
wukong verify
wukong verify --build
wukong verify --command "pnpm test"
wukong verify --command "pnpm lint" --command "pnpm typecheck"
wukong verify --report ./reports/evidence.md
wukong verify --timeout 180
wukong verify --json
wukong verify --no-report
```

退出码:

| 状态 | 条件 | 退出码 |
|---|---|---|
| passed | 命令全部通过,无 high risk | 0 |
| warning | 命令通过,存在 low/medium risk | 0,除非 `--strict` |
| failed | 任一命令失败,或存在 high risk | 1 |
| invalid | 参数错误、cwd 不存在、报告写入失败 | 2 |

### 4.2 核心类型

```ts
export type VerificationStatus = 'passed' | 'warning' | 'failed';

export interface VerificationOptions {
  cwd?: string;
  commands?: string[];
  includeBuild?: boolean;
  writeReport?: boolean;
  reportPath?: string;
  timeoutMs?: number;
  strict?: boolean;
}

export interface VerificationResult {
  status: VerificationStatus;
  cwd: string;
  generatedAt: string;
  changedFiles: ChangedFile[];
  gitStatus: string;
  diffStat: string;
  selectedCommands: string[];
  commandResults: VerificationCommandResult[];
  risks: VerificationRisk[];
  reportPath?: string;
  report?: string;
}
```

### 4.3 实现流程

```mermaid
sequenceDiagram
  participant CLI as wukong verify
  participant Verify as runVerification
  participant Git as GitInspector
  participant Scripts as ScriptDetector
  participant Runner as CommandRunner
  participant Risks as RiskScanner
  participant Report as ReportWriter

  CLI->>Verify: options
  Verify->>Git: inspect status/diff/stat
  Verify->>Scripts: detect lint/typecheck/test/build
  Verify->>Runner: run selected commands
  Verify->>Risks: scan diff + files + command context
  Verify->>Report: write Markdown evidence
  Verify-->>CLI: structured result
  CLI-->>CLI: print summary and set exitCode
```

### 4.4 命令自动检测

优先级:

1. 用户显式传入 `--command`。
2. `package.json` scripts:
   - `lint`
   - `typecheck`
   - `type-check`
   - `test`
   - `build`,仅 `--build` 时加入
3. 未来扩展:
   - Python: `pytest`, `ruff`, `mypy`
   - Go: `go test ./...`
   - Rust: `cargo test`

P0 只需要稳定支持 Node 项目,其他语言通过显式 `--command` 支持。

### 4.5 风险信号

P0 风险规则:

| 规则 | 严重度 | 检测对象 |
|---|---|---|
| `TODO/FIXME/placeholder/not implemented/coming soon` | high | 新增代码行 |
| `mock/fake/dummy/hardcoded/sample data` | high | 新增代码行 |
| `describe.only/it.only/test.only` | medium | 新增代码行 |
| `describe.skip/it.skip/test.skip` | medium | 新增代码行 |
| `console.log/debug/trace` | medium | 新增代码行 |
| `.env/secret/credential/private-key` 文件变化 | high | changed files |
| 源码变更但无测试变更 | medium | changed files |
| 未发现验证命令 | high | selected commands |
| 非 git repo | medium | workspace |

P1 风险规则:

- 依赖新增和 lockfile diff。
- 删除测试文件。
- 大面积删除。
- 权限敏感文件变化。
- Dockerfile / CI / deploy config 变化。
- secret regex 增强。

---

## 5. P0: `wukong scan`

### 5.1 定位

`scan` 是 `verify` 的只读子集:

- 不运行 `lint/test/build`。
- 不改文件,默认不写报告。
- 适合 pre-commit、CI quick check、AI agent 自查。

### 5.2 命令契约

```bash
wukong scan
wukong scan --diff
wukong scan --secrets
wukong scan --deps
wukong scan --json
wukong scan --report ./reports/risk.md
```

P0 只实现:

- `scan`
- `scan --diff`
- `scan --secrets`
- `scan --json`
- `scan --report`

`--deps` 可以先保留为 planned,不要在 help 中承诺完整 SCA。

### 5.3 复用关系

```text
runVerification()
  -> inspectGit()
  -> detectCommands()
  -> runCommands()
  -> scanRisks()
  -> writeReport()

runScan()
  -> inspectGit()
  -> scanRisks()
  -> optionally writeReport()
```

---

## 6. P0: `wukong guard`

### 6.1 定位

`guard` 是终端命令风险控制层。P0 已实现范围不是完整沙盒或 shell profile 自动注入,而是:

- 本地 guard enable/disable/status/stats。
- 对 `wukong guard -- <command>` 做高风险命令分类。
- 默认阻断高风险命令。
- 用户显式传 `--yes` 时允许执行。
- 记录本地统计。

### 6.2 命令契约

```bash
wukong guard --enable
wukong guard --disable
wukong guard --status
wukong guard --stats
wukong guard -- <command>
```

### 6.3 P0 行为

| 能力 | P0 状态 |
|---|---|
| `guard --status` | 已实现 |
| `guard --stats` | 已实现 |
| `guard --enable` / `--disable` | 已实现,只写本地 config |
| `guard -- <command>` | 已实现,高风险默认阻断 |
| shell profile 自动注入 | P1 |
| agent 祖先进程识别 | P1 |
| sandbox runner | P2 |

### 6.4 后续 shell hook 安装方式

P1 如果要把 guard 自动接到 zsh/bash,不要只写死 `~/.zshrc`。应抽象为:

```ts
interface ShellProfile {
  shell: 'zsh' | 'bash' | 'fish' | 'powershell';
  profilePath: string;
  startMark: string;
  endMark: string;
  renderHook(commands: string[]): string;
}
```

P1 可注入命令:

```bash
alias rm="wukong guard -- rm"
alias git="wukong guard -- git"
alias curl="wukong guard -- curl"
alias wget="wukong guard -- wget"
alias bash="wukong guard -- bash"
alias sh="wukong guard -- sh"
```

这类 alias/hook 只能提供交互式 best-effort 防护,不能作为不可绕过的安全边界。用户仍可通过绝对路径、`command rm`、非交互脚本或其他进程绕过。文档和 CLI 输出必须如实说明这一点。

注意:

- 注入必须幂等。
- disable 必须只删除 Wukong 自己的 block。
- 写入前保留备份,例如 `~/.zshrc.wukong.bak.<timestamp>`。
- `--status` 必须能显示是否已安装、安装在哪个 profile、当前 hook 版本。

### 6.5 风险规则

P0 命令风险:

| 命令 | 条件 | 默认动作 |
|---|---|---|
| `rm` | 包含 `-r` 或 `-f` | block, `--yes` allow |
| `git` | `reset --hard` | block, `--yes` allow |
| `git` | `clean -f`, `clean -df`, `clean -xdf` | block, `--yes` allow |
| `curl/wget` | 上传数据、`-d`、`--data`、`-F`、pipe to shell | block, `--yes` allow |
| `sh/bash/zsh` | 命令包含 `curl` 或 `wget` | block, `--yes` allow |

P1 增强:

- `chmod -R 777`
- `sudo rm`
- `docker system prune`
- `kubectl delete`
- `terraform destroy`
- `DROP TABLE`
- `git push --force`

### 6.6 Agent 触发判断

legacy 用进程祖先链判断 `claude/cursor/copilot/agent/gpt/assistant`。新 base 暂未实现该能力。P1 如果实现,必须明确它是启发式:

```ts
interface AgentDetectionResult {
  triggeredByAgent: boolean;
  ancestors: string[];
  matchedKeyword?: string;
  confidence: 'high' | 'medium' | 'low';
}
```

未来默认策略:

- agent 触发 + high risk: 拦截并确认。
- 人工触发 + high risk: 默认只提醒或按配置确认。
- 用户可配置 `guard.mode = agent-only | always | off`。

### 6.7 本地状态

本地存储:

```text
~/.wukong/guard/config.json
~/.wukong/guard/events.jsonl
~/.wukong/guard/stats.json
```

事件结构:

```ts
interface GuardEvent {
  id: string;
  timestamp: string;
  cwd: string;
  command: string[];
  riskId: string;
  severity: 'high' | 'medium' | 'low';
  action: 'blocked' | 'allowed' | 'confirmed' | 'warned';
  triggeredByAgent: boolean;
  ancestors: string[];
}
```

---

## 7. P0: MCP / Agent Tool `wukong_verify`

### 7.1 目标

让 Claude Code、Cursor、Codex 或其他 agent 在声明完成前调用 Wukong:

```text
wukong_verify({ cwd, includeBuild, timeoutSeconds })
```

### 7.2 工具输入

```ts
const inputSchema = z.object({
  cwd: z.string().optional(),
  commands: z.array(z.string()).optional(),
  includeBuild: z.boolean().optional(),
  writeReport: z.boolean().optional(),
  reportPath: z.string().optional(),
  timeoutSeconds: z.number().positive().optional(),
});
```

### 7.3 工具输出

```ts
interface WukongVerifyToolOutput {
  status: VerificationStatus;
  cwd: string;
  reportPath?: string;
  changedFiles: string[];
  commands: Array<{
    command: string;
    status: 'passed' | 'failed';
    exitCode: number;
    durationMs: number;
  }>;
  risks: VerificationRisk[];
  summary: {
    changedFiles: number;
    commandsRun: number;
    failedCommands: number;
    risksFound: number;
  };
}
```

### 7.4 Agent 行为约束

工具描述中要明确:

- 代码改动后必须调用。
- 不能把文件存在、路由存在当成功能完成。
- 如果 `status = failed`,agent 不能声称任务完成。
- 如果 `status = warning`,agent 必须解释 warning 是否可接受。

---

## 8. P1: `review` / `test` / `ship` / `retro`

这些命令不应在 P0 和 `verify` 抢实现资源。它们应该构建在 `@wukong/verification` 上。

### 8.1 `wukong review`

定位: AI 增强审查。

流程:

1. 先跑 `scan`。
2. 收集 git diff、risk summary、项目元信息。
3. 调用模型生成 review findings。
4. 输出 Markdown review report。
5. `--deep` 消耗 credits。

### 8.2 `wukong test`

定位: `verify --command` 的便利封装。

P1 可实现:

```bash
wukong test
wukong test --watch
wukong test --coverage
```

内部优先选择 package scripts:

- `test`
- `test:unit`
- `test:coverage`
- `test:watch`

### 8.3 `wukong ship`

定位: 发布前 gate。

流程:

1. 检查 git worktree。
2. 跑 `verify --build --strict`。
3. 检查版本、CHANGELOG、未提交文件。
4. 生成 ship report。
5. P1 只做 dry-run,P2 再做 push/PR。

### 8.4 `wukong retro`

定位: 基于 git + verification events 的复盘。

输入:

- git commits
- verification reports
- guard events
- failed command history

输出:

- 本周验证次数
- 失败率
- 常见风险
- 被拦截命令
- 建议改进

---

## 8.5 P0.5: `proof` / `judge` / goal gate / `loop`

这一组是下一个重点（对应 ROADMAP Milestone 0.5）。`loop` 是产品组织核心，`proof` 是 Wow Moment，`judge` 是 loop 的独立判定出口。全部构建在 `@wukong/verification`、已实现的 `/goal` 和 agent-core cron scheduler 之上，不引入新核心引擎。

实施顺序固定为：**`/proof`（§8.5.2）→ `/judge`（§8.5.3）→ `/goal` verification gate（§8.5.4）→ `/loop`（§8.5.1）**。理由：proof/judge 只是 verify+scan 的编排与重排版，便宜且先产出可分享物；judge-pass 与 goal gate 是 loop 停止判断的前提；loop 最后落地时只做编排。

两个复用决策（本节其余部分以此为前提）：

- **执行核复用 `/goal`**：但当前 `/goal` 的完成判定是 agent 自评，必须先落地 §8.5.4 的 verification gate，`/loop` 才能复用（见 §2.1 原则 6）。
- **时间触发复用 cron**：`/loop` 的可选 `--every` 节流由 agent-core cron scheduler 驱动，不新写 timer（见 §2.1 原则 8）。

### 8.5.1 `wukong loop` / `/loop` — 本机迭代 loop（核心，最后落地）

#### 定位

`/loop` 是 AI Coding Loop 的**编排层**，核心语义是 **iterate-until-verified**：驱动 agent 朝目标推进 → goal verification gate 评估 → 未过则把失败反馈注入下一轮，直到停止条件满足、达到迭代上限或人取消。**关机即停。**

两类用例明确拆开，`/loop` 只做第一类：

- **迭代收敛型**（"fix all failing tests until verify-pass"）：归 `/loop`。默认紧循环——上一轮 gate 未过立即开始下一轮；`--every` 是可选的轮间最小间隔（节流），用于等外部反馈（如 CI 跑完）的场景，由 cron scheduler 驱动。
- **定时巡检型**（"每小时 check PR / feedback channel"）：不归 `/loop`。本机现在就能用已实现的 cron 工具（自然语言让 agent 创建 recurring 任务）；跨机器持续性归 `/schedule`（hosted，Milestone 3+），不在 P0.5。

与其它命令的关系：

- `/goal` 是**单任务执行核**：`/loop` 每轮注入一个带 stopCondition 的 goal。
- `/judge` 是 loop 的独立判定出口之一（`judge-pass`）。

关键原则（来自 loop engineering）：**停止判断不能由写代码的同一个 agent 自己做**——由 goal verification gate（§8.5.4）统一承载 deterministic verification、独立 evaluator 或自定义验证 skill。

#### 命令契约

```bash
# TUI — 迭代直到验证通过（默认紧循环，轮次自动衔接）
/loop "<目标>" until verify-pass
/loop "fix all failing tests" until verify-pass
/loop "<目标>" until scan-clean every 10m   # 可选节流：轮间最小间隔
/loop status
/loop pause
/loop resume
/loop stop

# CLI（本机：在当前进程内迭代，关机即停）
wukong loop "fix all failing tests" --until verify-pass
wukong loop "<目标>" --until scan-clean --max-iterations 5
wukong loop "<目标>" --until verify-pass --every 10m   # 等 CI 等外部反馈时的轮间节流
wukong loop "<目标>" --until verify-pass --dry-run

# 定时巡检（不归 /loop）
# 本机：cron 工具（已实现，会话内 recurring 任务，自然语言创建）
# 云端：wukong schedule every hour "check feedback channel"   # Milestone 3+
```

#### 核心类型

```ts
export interface LoopOptions {
  goal: string;                      // 自然语言目标
  stopCondition: StopCondition;      // 可验证停止条件（必填，loop 的核心）
  everyMs?: number;                  // 可选：轮间最小间隔（节流），由 cron scheduler 驱动
  maxIterations?: number;            // 默认 10，防失控
  iterationTimeoutMs?: number;       // 单轮超时
  cwd?: string;
}

export interface StopCondition {
  kind: 'verify-pass'                // verify status === passed
      | 'scan-clean'                 // 无 high-risk findings
      | 'judge-pass'                 // /judge 判 PASS（对抗性审查出口）
      | 'skill';                     // 挂载自定义验证 skill
  skillName?: string;                // kind === 'skill' 时指定验证 skill
}

export interface LoopResult {
  status: 'completed' | 'stopped' | 'max-iterations' | 'error';
  iterations: number;
  finalVerification?: VerificationResult;   // 最后一轮的验证结果
  history: VerificationResult[];            // 每轮 verify 快照
  startedAt: string;
  endedAt: string;
}
```

`StopCondition.kind` 从原来的三选一扩展到四选一，新增 `skill`：借鉴 Claude Code 把人工验证步骤写成 verify-skill 的模式（如 `verify-frontend-change`：启 dev server → 浏览器交互 → 截图 → 查 console → 跑 Lighthouse）。这让 loop 的停止条件能覆盖 deterministic verify 检测不到的端到端/语义验证。

#### 实现流程

```mermaid
sequenceDiagram
  participant U as User
  participant L as Loop Orchestrator
  participant C as Cron Scheduler（仅设 everyMs 时参与）
  participant G as Goal（执行核 + verification gate）
  participant A as Agent (写代码)

  U->>L: goal + stopCondition (+ everyMs)
  loop 直到 stopCondition 满足 / maxIterations / 人取消
    L->>G: 注入带 stopCondition 的 goal
    G->>A: 驱动 agent 改代码朝目标推进
    A-->>G: agent 宣布完成
    G->>G: verification gate 评估（verify/scan/judge/skill）
    alt gate 通过
      G-->>L: passed + finalVerification
      L-->>U: completed
    else gate 未过
      G-->>L: failed + 失败反馈
      L->>C: 若设 everyMs，等待下一轮窗口（cron scheduler 驱动）
      L->>G: 失败反馈注入下一轮 goal prompt
    end
  end
  note over L: 进程退出即停；定时巡检用 cron 工具，云端持续性是 /schedule
```

#### 与 `/goal` 和 cron 的集成

`/loop` 自身只做编排，能力全部来自复用：

- 单轮执行复用 `/goal` 执行核，停止判断复用 goal verification gate（§8.5.4，硬前置）。
- `--every` 节流复用 agent-core cron scheduler（session-scoped、关机即停，与 cron 现有语义一致），不新写 timer。
- `/loop` 额外提供的只有：多轮编排、失败反馈注入下一轮 prompt、迭代历史快照（`LoopResult.history` 取自每轮 gate 的 `VerificationResult`）。

#### P0.5 边界

- 只做**本机** `/loop`：在当前 TUI 会话 / 当前 CLI 进程内迭代。**关机即停。**
- 不做 `/schedule` 云端例程（归 hosted，Milestone 3+）；定时巡检型任务指向 cron 工具，不塞进 `/loop`。
- 停止条件 P0.5 支持 `verify-pass`、`scan-clean`、`judge-pass`；`skill` 在验证 skill 机制落地后接入（P0.5 末或 P1 初）。
- token 失控防护：`maxIterations` 默认上限、单轮超时、人可随时 stop、`--dry-run`。

---

### 8.5.2 `wukong proof` / `/proof` — Merge Proof Report（Wow Moment）

#### 定位

把 `verify` → `scan` → `report` 串成一个固定格式的 **Merge Proof Report**，回答"AI 写的这段代码能不能合并"。这是产品第一个 Wow Moment：用户第一次明确知道 AI 写的代码到底能不能 ship。

#### 命令契约

```bash
# TUI
/proof
/proof --strict        # 有 warning 也算 BLOCKED

# CLI
wukong proof
wukong proof --json
wukong proof --report ./reports/merge-proof.md
wukong proof --strict
```

退出码：`passed` → 0，`blocked`（failed 或 strict 下 warning）→ 1。

#### Merge Proof Report 格式

```text
MERGE PROOF REPORT

Status: PASS / BLOCKED
Generated: 2026-07-07T12:00:00Z

Changed files: 8
Tests:          142 passed, 0 failed
Typecheck:      passed
Lint:           passed
Secrets scan:   clean
Risky changes:  2 warnings
Guard violations: none

Recommendation:
  Safe to open PR, but review auth/session changes manually.

Full detail: ./wukong-verification-report.md
```

#### 核心类型

```ts
export interface ProofResult {
  status: 'pass' | 'blocked';
  recommendation: string;            // 基于风险生成的自然语言建议
  summary: {
    changedFiles: number;
    commandsRun: number;
    failedCommands: number;
    risksFound: number;
    highRisks: number;
    guardViolations: number;
  };
  verification: VerificationResult;  // 内嵌完整 verify 结果
  scan: ScanResult;                  // 内嵌完整 scan 结果
  generatedAt: string;
  reportPath?: string;
}
```

#### 实现要点

- `proof` 是 verify + scan 的**编排 + 重排版**，不新增检测能力。
- 复用 `runVerification`（已含 risk scan）+ `renderVerificationReport`。
- 新增 `renderMergeProofReport(proof: ProofResult): string` 渲染器，放在 `packages/verification/src/proof.ts`。
- `recommendation` 由风险类型映射生成（如 `diff.secret_like_changed` → "review secret file changes manually"），P0.5 不用模型。

---

### 8.5.3 `wukong judge` / `/judge` — evaluator-only 判定

#### 定位

`/judge` 是 generator/evaluator 分离里的 **evaluator**：不写代码，只判定，默认怀疑（`--assume-broken`）。它是 `/loop` 的独立判定出口（`judge-pass`）。

如实分层，避免叙事超前于实现：

- **P0.5 默认模式（deterministic）**：复用 `runVerification` + `runScan`，不调用模型，离线免费。此模式本质是 proof 引擎的对抗性判定档（BLOCK 倾向更强），文档与 help 必须如实描述为"deterministic 判定"，不得宣传为"第二 agent 审查"。
- **`--agent` 模式（fresh-context 第二 agent，P0.5 末 / P1 初）**：用 fresh context 的只读 evaluator agent（复用现有 fork/side-agent 基础设施）读取 diff + ProofResult，输出 BLOCK/PASS + 理由。BYOK，模型成本归用户。"火眼金睛第二-agent reviewer"的差异化叙事在此模式落地后才对外使用。

#### 命令契约

```bash
# TUI
/judge
/judge --assume-broken      # 默认即如此，显式声明
/judge --strict             # warning 也判 BLOCK
/judge --agent              # fresh-context 第二 agent 审查（P0.5 末 / P1 初，BYOK）

# CLI
wukong judge
wukong judge --json
wukong judge --strict
wukong judge --agent
```

退出码：`pass` → 0，`block` → 1。

#### 行为

| 输入 | `--assume-broken`（默认）行为 |
|---|---|
| verify failed | BLOCK |
| verify passed，有 high-risk | BLOCK |
| verify passed，有 medium risk | PASS with warnings（`--strict` 则 BLOCK） |
| verify passed，clean | PASS |

#### 实现要点

- deterministic 默认模式复用 `runVerification` + `runScan`，与 `/proof` 共用 `ProofResult`，区别在判定的激进程度和输出语气（judge 默认 BLOCK 倾向）。
- `--agent` 模式是只读 evaluator：不给写文件 / 执行修改类工具，输出必须落回结构化 BLOCK/PASS + reasons；作为 `judge-pass` 停止条件时以结构化结论为准。
- `/loop` 的 `judge-pass` 停止条件默认用 deterministic 模式，`--agent` 可选叠加。
- 未来 `/review --deep` 才做完整语义审查并消耗 managed credits；`/judge` deterministic 模式保持免费，`--agent` 模式走用户 BYOK。

---

### 8.5.4 `/goal` verification gate — `/loop` 的硬前置

#### 现状与问题

当前 `/goal` 的完成判定是 agent 自评：agent 通过 goal 工具（`agent-core/src/tools/builtin/goal/`）宣布 completed/blocked，`create-goal` 的 verify 字段只是自由文本提示，没有强制评估。这与 §2.1 原则 6 直接冲突——如果 `/loop` 不加处理直接复用 `/goal`，loop 的停止判断实际上还是 agent 自评。

#### 设计

- `/goal` 增加可选停止条件参数（`--until verify-pass | scan-clean | judge-pass`）；由 `/loop` 注入的 goal 一律必填。
- agent 宣布 completed 时，若存在 stopCondition：自动运行对应评估（`runVerification` / `runScan` / judge）。
  - gate 通过 → goal 真正进入 completed，评估结果写入 goal 快照。
  - gate 未过 → 拒绝完成，把失败命令 / 风险摘要注入下一回合 prompt，继续推进，受既有回合 / 预算上限约束。
- 无 stopCondition 的 `/goal` 保持现状（agent 自评），但文档不得再描述为"跑到可验证条件满足"。

#### 核心类型

```ts
export interface GoalGateResult {
  passed: boolean;
  stopCondition: StopCondition;
  verification?: VerificationResult;   // gate 运行的评估快照
  evaluatedAt: string;
}
```

`/loop` 的 `LoopResult.history` 直接取自每轮 gate 的 `verification` 快照，不另做一套记录。

---

## 9. 后续云端与商业化接入

本节只定义 `wukong_cli` 需要预留的数据边界。具体 web/API/计费实现不在本轮 `wukong_cli` 修改范围内。

### 9.1 本地数据

P0 本地:

```text
~/.wukong/reports/*.md
~/.wukong/reports/index.json
~/.wukong/guard/events.jsonl
```

P1 之后可以由外部服务接入:

```mermaid
sequenceDiagram
  participant CLI as CLI
  participant API as Report API
  participant DB as Report Database
  participant Storage as Report Storage

  CLI->>API: upload report metadata + auth token
  API->>DB: insert verification_reports
  API->>Storage: store redacted markdown/html report
  API-->>CLI: share URL
```

### 9.2 建议外部数据实体

```sql
verification_reports(
  id text primary key,
  user_id text not null,
  org_id text,
  workspace_hash text not null,
  repo_remote_hash text,
  branch text,
  commit_sha text,
  status text not null,
  changed_files_count integer not null,
  commands_run integer not null,
  failed_commands integer not null,
  risks_found integer not null,
  high_risks integer not null,
  report_object_key text,
  created_at text not null
);

guard_events(
  id text primary key,
  user_id text,
  org_id text,
  workspace_hash text,
  command_hash text not null,
  command_preview text not null,
  risk_id text not null,
  severity text not null,
  action text not null,
  triggered_by_agent integer not null,
  created_at text not null
);

team_rules(
  id text primary key,
  org_id text not null,
  rule_type text not null,
  pattern text not null,
  action text not null,
  enabled integer not null,
  created_at text not null,
  updated_at text not null
);
```

### 9.3 配额映射

| Feature | Free | Pro | Team |
|---|---|---|---|
| local verify | unlimited | unlimited | unlimited |
| hosted reports | 3/month | unlimited or high cap | org cap |
| local guard | unlimited | unlimited | team policy 可加强 |
| deep review | credits | credits included | pooled credits |
| team rules | no | no | yes |

不要限制本地 `verify` 和本地 guard 的使用次数（对安全提醒功能限量会直接伤害信任）。商业化应限制云端托管、深度模型审查、团队规则和审计能力。`wukong_cli` 侧只需要保证 report metadata、guard event 和 redaction 边界清楚。

---

## 10. 实施里程碑

### Milestone 0: 文档和口径校准

- 新增本技术方案。
- 在商业方案中标注 legacy 资产与新 base 当前状态。
- 修正 README / docs 中对 `verify/guard` 的完成度描述。
- 明确当前发布包名为 `@wukong.today/code`，旧 `@wukong.today/wukong-cli` 不再作为当前文档入口。

验收:

- 文档不再把 legacy 文件当作新 base 文件。
- 安装命令、包名、CLI 名称一致。

### Milestone 1: `@wukong/verification` - 已完成

- 新建 `packages/verification`。
- 从 legacy `Verifier.ts` 迁移核心逻辑。
- 添加 unit tests。
- 支持 `runVerification` 与 `runScan`。

验收:

```bash
pnpm --filter @wukong/verification test
pnpm --filter @wukong/verification typecheck
```

### Milestone 2: CLI `verify` / `scan` - 已完成

- 新增 `apps/wukong/src/cli/sub/verify.ts`。
- 新增 `apps/wukong/src/cli/sub/scan.ts`。
- 注册到 `commands.ts`。
- 添加 CLI tests 或 smoke tests。

验收:

```bash
pnpm -C apps/wukong run dev:cli-only -- verify --no-report
pnpm -C apps/wukong run dev:cli-only -- scan --json
```

### Milestone 3: CLI `guard` - 已完成

- 新增 guard runtime、policy engine。
- 支持 enable/disable/status/stats。
- 写入本地 events/stats。
- 添加安全测试,确认高风险命令默认阻断。

验收:

```bash
pnpm -C apps/wukong run dev:cli-only -- guard --enable
pnpm -C apps/wukong run dev:cli-only -- guard --status
pnpm -C apps/wukong run dev:cli-only -- guard -- rm -rf /tmp/wukong-test
pnpm -C apps/wukong run dev:cli-only -- guard --disable
```

### Milestone 4: `wukong_verify` tool - 已完成

- 在 `agent-core` 新增 builtin verification tool。
- 复用 `@wukong/verification`。
- 返回 structured summary。
- 添加 agent tool 单元测试。

验收:

- 外部 agent 能调用 `wukong_verify`。
- tool 返回 structured result。
- failed 时 agent 能看到失败命令和风险。

### Milestone 4.5: TUI verification slash commands - 已完成

- 新增 `/verify`、`/scan`、`/guard`、`/report`。
- TUI handler 复用 `@wukong/verification`。
- `/report` 读取 workspace 内最新 verification/scan report。
- 添加 TUI handler 单元测试。

验收:

```bash
pnpm --filter @wukong/wukong exec vitest run test/tui/commands/verification.test.ts
```

### Milestone 4.75: Loop 控制层 + Merge Proof（P0.5）

对应 §8.5。这是 P0 完成后、云端商业化之前的下一个重点。实施顺序：proof → judge → goal gate → loop。

交付:

- `packages/verification/src/proof.ts`: `renderMergeProofReport`、`buildProofResult`。
- `apps/wukong/src/cli/sub/proof.ts`、`judge.ts`、`loop.ts` 及 `commands.ts` 注册。
- TUI slash commands `/proof`、`/judge`、`/loop` 及 dispatch。
- `/goal` verification gate（§8.5.4）：goal 完成判定接入 deterministic 评估，未过打回并注入反馈。
- `/loop` 编排层：复用 goal gate 做停止判断，`--every` 节流复用 agent-core cron scheduler，不新写 timer。

验收:

```bash
pnpm -C apps/wukong run dev:cli-only -- proof --json
pnpm -C apps/wukong run dev:cli-only -- judge --json
pnpm -C apps/wukong run dev:cli-only -- loop "fix failing tests" --until verify-pass --max-iterations 3
```

- 干净项目 `proof` 产出 PASS；含 placeholder/secret/失败测试产出 BLOCKED 并定位原因。
- `judge --assume-broken` 在不干净项目直接 BLOCK。
- 带 stopCondition 的 goal：agent 宣布完成但 verify 失败时，gate 拒绝完成并注入反馈继续。
- `loop` 对一个目标持续驱动，停止条件由 gate 判断，不由写代码的 agent 自评。
- `loop` 达到 max-iterations 时明确返回 `max-iterations` 状态，不假装成功。
- `loop --every` 的轮间等待由 cron scheduler 驱动，代码中无第二套 timer 实现。

### Milestone 5: 云端报告与商业化接口

- CLI 登录状态下可选择上传 report metadata。
- CLI 默认不上传源码 diff 或敏感片段。
- 支持外部服务返回 report share link。
- 预留 hosted report quota 和 guard usage quota 字段。

验收:

- 未登录时本地 verify 完整可用。
- 登录上传失败不影响本地报告生成。
- 上传 payload 通过 redaction 测试。

---

## 11. 测试策略

### 11.1 Unit tests

覆盖:

- package manager 检测。
- script 选择。
- diff parser。
- risk scanner。
- report writer。
- merge proof report 渲染。
- policy engine。
- shell hook render/parse/remove。
- goal verification gate（agent 宣布完成 → gate 评估 → 未过打回并注入反馈的完整路径）。
- loop orchestrator（停止条件判断、max-iterations、反馈注入、`--every` 走 cron scheduler）。

### 11.2 Fixture tests

建立 fixtures:

```text
packages/verification/test/fixtures/
  clean-node-project/
  failing-test-project/
  placeholder-diff/
  secret-file-change/
  skipped-test-diff/
```

### 11.3 CLI smoke tests

覆盖:

- `wukong verify --json`
- `wukong verify --command`
- `wukong verify --no-report`
- `wukong scan --json`
- `wukong guard --status`
- `wukong proof --json`
- `wukong judge --json`
- `wukong loop ... --max-iterations 1 --dry-run`

### 11.4 Safety tests

特别测试:

- `guard --disable` 不删除用户原有 shell 配置。
- hook 重复安装不会重复注入。
- wrapper 执行命令时不用 `shell: true`。
- report 不默认上传源码 diff。
- secret-looking diff 不写入云端明文。

---

## 12. 风险与处理

| 风险 | 影响 | 处理 |
|---|---|---|
| 文档先行导致功能被误认为已完成 | 用户安装后发现命令不存在 | Milestone 0 先校准完成度 |
| guard alias 破坏用户 shell | 高 | 幂等 block、备份、status、disable 测试 |
| agent detection 不可靠 | 中 | 明确是 heuristic,支持 `always/agent-only/off` |
| verify 自动检测命令误跑重任务 | 中 | 默认只跑常见短命令,build 需要显式 `--build` |
| report 泄露敏感信息 | 高 | 本地报告默认完整,外部上传默认 metadata + redacted report |
| cloud/sandbox 过早承诺 | 高 | P0 不做完整云终端和隔离沙盒 |
| 包名和安装名不一致 | 高 | 发布前统一 package name、docs、install script |
| `/loop` 失控（agent 持续烧 token） | 高 | max-iterations 默认上限、单轮超时、dry-run、人可随时 stop |
| `/loop` 停止条件由 agent 自评 | 高 | 先落地 `/goal` verification gate（§8.5.4）再实现 `/loop`，禁止 agent 自评 |
| `/loop` 被误当成 cron/daemon | 中 | 文档与 help 明确迭代收敛语义（关机即停）；定时巡检指向 cron 工具与 `/schedule` |
| loop 与 cron 形成两套定时引擎 | 中 | `--every` 强制复用 agent-core cron scheduler，不新写 timer |
| judge 叙事超前（宣传第二 agent 但实现是 deterministic） | 中 | 默认模式如实标注 deterministic；`--agent` 落地前不外宣"第二-agent reviewer" |

---

## 13. 推荐优先级

最终推荐执行顺序:

1. `@wukong/verification`（已完成）
2. `wukong verify`（已完成）
3. `wukong scan`（已完成）
4. `wukong guard`（已完成）
5. `wukong_verify` tool（已完成）
6. `/goal` 持续修复（已完成）
7. `wukong proof`（Merge Proof Report，P0.5 第 1 步）
8. `wukong judge`（evaluator-only 判定，P0.5 第 2 步）
9. `/goal` verification gate（`/loop` 硬前置，P0.5 第 3 步）
10. `wukong loop`（本机迭代 loop，P0.5 第 4 步，核心）
11. report history / share link
12. `review --deep` 与 `judge --agent`
13. team rules / audit log interface
14. 跨会话 loop（hosted/CI daemon）
15. sandbox / external cloud execution

前六项已完成，Wukong 的验证内核真实成立。第 7-10 项（proof/judge/gate/loop）把内核升级成 **AI Coding Loop 的控制层**，是下一个重点:
**AI agent 写完代码后，Wukong 持续驱动验证、产出合并证据，并判断能不能合并。**
