# Verification CLI 自动化测试计划

> 日期: 2026-07-30
> 范围: verification 兼容回归、Loop-first 状态机、隔离 candidate/Target Apply、fresh reviewer、本地 lifecycle 和角色集成
> 状态: v1 与 0.0.12 v2 主流程已实现；0.0.12 的 Guest/Free quota contract 已在 0.0.17 移除，0.0.21 正在补隔离 Loop 与 Target Apply 发布门槛

## 0. 0.0.21 测试执行分层

自动化测试按风险分层执行，目标是减少 PR 上重复、无关的测试，不降低 Loop、验证和 Target Apply 的安全覆盖。

### Pull request / main push

- 普通源码改动运行 Vitest `--changed=<base SHA>`，只选择受依赖图影响的测试。
- 无论 affected 结果如何，额外运行 19 个 mandatory safety anchor 文件，当前共 208 个测试，覆盖 verification、redaction、review subject、candidate workspace、Target Apply、goal gate 和 Loop CLI。
- `package.json`、lockfile、workspace、TypeScript/Vitest 配置、构建脚本或 workflow 变化会退回完整 root Vitest suite，避免测试基础设施改动被 affected 分析漏掉。
- Linux safety anchor 在主 test job 中运行；macOS 和 Windows 的小型 cross-platform criteria matrix 移到 nightly，普通 PR/push 不重复消耗两个托管 runner。
- PR 不再重复运行完整 CLI coverage；coverage gate 由 nightly 和 release 门槛承担。
- affected 不是固定的小测试集：修改 agent-core、Loop 或 verification 等中心模块时，依赖图可能仍然选择较多测试，这是预期的风险覆盖。

### Nightly

- 每天 02:00（Asia/Shanghai）或手动运行完整 root Vitest suite，限制 `maxWorkers=2`。
- 补跑 root Vitest project 未覆盖的 wukong-web、vis-server 和 vis-web suite。
- 运行完整 CLI coverage gate，并保留 7 天 coverage artifact。

### Release

- 发布门槛继续要求完整 test、typecheck、lint、sherif、build、hard-signal、真实生态和跨平台验收。
- affected 或 nightly 结果不能替代 fixed-SHA release evidence。
- 0.0.21 尚未取得远端 fixed-SHA workflow 和 Windows handle-relative backend 证据，因此当前工作树不能据此声明可发布。

### 当前本地证据

- mandatory safety anchors：208/208 通过。
- 最新一次 `test:full:bounded` 按 verification、agent-core、CLI 和其余 root projects 隔离执行，root 为 753 files / 9855 tests passed、11 files / 71 tests skipped、2 todo；root 配置未覆盖的 Wukong Web 173/173、Vis Server 93/93、Vis Web 1/1 通过，合计 781 files / 10122 tests passed。
- cleanup、native installer、dependencyful network harness 与 Node 26 子进程调用加固均已纳入上述最终源码回归；Verification 295/295、Server 666/666 另以 `--trace-deprecation` 通过，未再出现 `DEP0190`。
- Snapshot materializer/Blob recovery、Candidate Writer atomic leaf 与 guard 相关定向回归为 49/49；真实子进程 SIGINT/SIGTERM matrix 为 materializer 2/2、Writer 6/6。
- Source Snapshot sealer 单元与 hard-signal 回归为 17/17；其中四个 read-only 边界 × SIGINT/SIGTERM 为 8/8，终止后 source 逻辑状态摘要不变。
- POSIX Target Apply final-leaf/cleanup 定向 27/27、Target/Promotion 相关回归 86/86、Target hard-signal 20/20：preimage/stage inode 进入 identity receipt，committed receipt 在 durable outcome 前形成并以可恢复 cleanup namespace 清理；无 receipt postimage、同内容新 inode、cleanup manifest 篡改及中断均 fail closed。完整 POSIX component-level hard-signal workflow 为 38/38。
- Windows ACL/layout/capability 纯测试为 53/53；真实 handle-relative integration 和 forced-termination 仍必须在 Windows runner 运行，纯测试不能外推为 Windows 通过。
- macOS 无依赖 Node/Python/Rust/Go dirty Loop 为 4/4；fixed-lock dependencyful Node/Python/Rust 为 3/3。Go harness 已接入但本机直连官方 proxy 超时且不能注入未批准 ambient proxy，因此只保留远端 4/4 门槛，不能计作本地通过。
- installer Bats 13/13、native update command contract 42/42、本机 darwin-arm64 local-artifact fresh install 和 0.0.19 → 本地 0.0.20 控制路径通过；0.0.20 → 0.0.21 六平台证据仍待 fixed-SHA RC。
- typecheck、lint（0 warnings/errors）、sherif、build、actionlint 和 `git diff --check` 通过。

## 1. 0.0.12 v2 发布测试门槛

当前自动化落点：

- Goal record/legacy flags：`packages/agent-core/test/agent/goal.test.ts`、`apps/wukong/test/cli/loop.test.ts`
- shared snapshot、无测试项目、stale workspace：`packages/verification/test/proof.test.ts`
- 真实 nested npm monorepo：`packages/verification/test/monorepo-e2e.test.ts`
- fresh reviewer、结构化反馈、max iterations：`packages/agent-core/test/tools/goal-gate.test.ts`
- Role Profile 权限和 session：`packages/agent-core/test/role/*`、`packages/agent-core/test/harness/role-session.test.ts`
- 本地 lifecycle、终态和恢复：`apps/wukong/test/cli/loop-lifecycle.test.ts`

### Loop v2

- 默认 gate 是 proof-pass，不由 agent 自评完成。
- 每轮 agent 修改后建立新 snapshot，旧 Proof 不得复用。
- 内部真实命令、风险规则和 reviewer 的输入都来自同一 snapshot。
- 真实命令失败或 blocking finding 不能被 reviewer 改成 PASS。
- reviewer 使用 fresh context、只读工具，且不得继承 writer 对话。
- 无测试的源代码改动返回 NEEDS_WORK/tests_missing；纯文档改动可由 reviewer 给出明确理由后通过。
- NEEDS_WORK 的结构化反馈进入下一轮且有大小上限。
- 只有 NEEDS_WORK 进入下一模型轮；ERROR 立即结束并给恢复动作。
- transient ERROR 最多原地重试一次，不增加 iteration、不再次调用模型。
- writer model 优先级为 `--model` > role model > 用户 default；无效 alias 在 usage start 前拒绝。
- 达到最大轮次返回 NEEDS_WORK/max_iterations；用户停止 exit 130，不产生假 verdict。
- `--every` 继续复用 agent-core scheduler，断言无第二套 timer。
- 默认不生成中间或最终文件；显式保存/上传只生成最终 `type=loop` evidence。

### 本地 Loop lifecycle

- Loop 不要求登录，不读取 Guest trial，不调用远程 start/complete，也不受月度 quota 限制。
- 默认单次最多 10 轮；用户显式 `--max-iterations` 不被账号 tier 收窄。
- 参数、plan 或 model preflight 失败不创建本地 run record。
- start 后的完成、取消、失败与崩溃恢复都写入 `0600` 本地 lifecycle record，不上传 objective、prompt、transcript、diff 或 provider key。
- 可关闭的匿名 telemetry 只接收受控 lifecycle event；`WUKONG_TELEMETRY=0` 不改变本地 Loop 行为。

### 高级命令兼容

- `verify`、`scan`、`proof` 不出现在 CLI 主帮助和 TUI autocomplete，但旧输入仍可直接执行。
- TUI 直接执行时提示其为 Loop 内部高级诊断；CLI 保持脚本/CI 输出兼容。
- 旧 `verify-pass`、`scan-clean`、`judge-pass` 映射到 `proof-pass`，并输出一次弃用提示。

### Role Profiles

- 内置 general/reviewer/security/tester 可 list/show/use。
- 角色只在 TUI 通过 `/transform` 切换；`/transform off` 恢复默认。CLI `roles` 只管理角色目录。
- 用户 role 从 `~/.wukong/roles/` 读取；project role 只有显式 `project:<name>` + 当前 plan trust 才加载，不能 shadow builtin。
- role tool allowlist 只能收窄权限，不能扩大权限或执行内嵌 shell command。
- role model/profile/prompt 生效，且运行仍只计对应 Check 或 Loop session。
- 角色切换不写入 replay；`/transform off` 恢复切换前的 model、默认 prompt 与工具集合。
- 未知 frontmatter 字段和超出基础 profile 的工具被拒绝。

### 兼容

- v1 `verify-pass`、`scan-clean`、`judge-pass` 的持久化 Goal 能迁移并恢复。
- v1 公开 flags 全部保留或输出明确 warning，不能静默忽略。

## 2. 测试目标

P0 测试必须证明：

1. `@wukong/verification` 可以离线运行。
2. `wukong verify` 能运行显式命令和自动识别 Node package scripts。
3. `wukong scan` 能识别 staged diff 中的风险。
4. `wukong guard` 默认阻断高风险命令。
5. 三个 top-level commands 出现在 `wukong --help` 中。
6. CLI smoke 能从真实 entrypoint 启动，而不只是单元测试通过。
7. TUI `/verify`、`/scan`、`/guard` 能渲染结果或状态。
8. `wukong_verify` agent tool 能返回 structured summary，并在失败时提醒 agent 不要声明完成。

## 3. 当前自动化测试

| 层级 | 文件 | 覆盖 |
|---|---|---|
| Core unit | `packages/verification/test/verify.test.ts` | explicit commands、package script detection、failed command、no-commands high risk、timeout（timed_out）、strict 升级、default/自定义 report path |
| Core unit | `packages/verification/test/scan.test.ts` | staged diff placeholder risk、staged+unstaged 混合扫描、secret 文件、clean pass、可选 report 写入 |
| Core unit | `packages/verification/test/risks.test.ts` | 全部 added-line 规则（placeholder/mock/only/skip/debug）、file+line 定位、dedupe、secret path、coverage、not-git-repo、commands.none_detected 开关 |
| Core unit | `packages/verification/test/git.test.ts` | 真实 git repo fixture：非 repo 目录、staged+unstaged 混合 diff、rename 解析 |
| Core unit | `packages/verification/test/scripts.test.ts` | explicit 优先、脚本选择顺序、build 门控、pnpm/yarn/bun/npm lockfile 检测 |
| Core unit | `packages/verification/test/report.test.ts` | verification/scan report 渲染、空态渲染、嵌套目录写入 |
| Core unit | `packages/verification/test/status.test.ts` | statusFrom 全矩阵（含 strict）、highestSeverity |
| Core unit | `packages/verification/test/policy.test.ts` | command risk classifier（含绝对路径、Windows 路径与 .exe/.cmd/.bat）、guard status、blocked/allowed 事件、`--yes` override、空命令、损坏 events 容错 |
| App unit | `apps/wukong/test/cli/verification-commands.test.ts` | command registration、verify/scan/guard handler output and exit code |
| App unit | `apps/wukong/test/tui/commands/verification.test.ts` | `/verify`、`/scan`、`/guard status` handlers |
| Agent unit | `packages/agent-core/test/tools/wukong-verify.test.ts` | `wukong_verify` schema、execution、failed verification guidance |

## 4. 必跑命令

```bash
pnpm --filter @wukong/verification run typecheck
pnpm --filter @wukong/verification test
pnpm --filter @wukong/verification run build
pnpm --filter @wukong/wukong run typecheck
pnpm --filter @wukong/agent-core run typecheck
pnpm --filter @wukong/wukong exec vitest run test/cli/verification-commands.test.ts
pnpm --filter @wukong/wukong exec vitest run test/tui/commands/verification.test.ts
pnpm --filter @wukong/agent-core exec vitest run test/tools/wukong-verify.test.ts
```

### 4.1 自动化执行分层（0.0.21）

测试文件继续保留，GitHub Actions 按风险降低执行频率：

- PR 与 `main` push：运行相对 base SHA 的 affected tests，再固定运行 208 个 source snapshot、privacy、Candidate/Target Gate、Promote no-clobber/cleanup 与 Loop CLI safety anchors。Wukong Web/Vis 只在对应目录变化时补跑自身小套件；installer Bats 只在安装器或测试基础设施变化时运行。只有 lockfile、测试配置、公共构建配置或 workflow 变化才升级为 bounded full suite。
- Nightly：运行 verification、agent-core 与其余 root projects；CLI 全量只通过 coverage gate 执行一次，不再先普通全量、后 coverage 重跑；同时补 root Vitest 未覆盖的 Wukong Web/Vis，以及 macOS/Windows criteria。
- 0.0.21 implementation gate：作为可复用 workflow，只接受精确 40 位 commit SHA，执行完整自动化、三 OS dirty Loop、POSIX hard-signal、Windows 原生 backend/termination 和真实网络 bootstrap。
- Full release candidate：只有同一 SHA 的 implementation gate 全绿才启动六平台 native artifact、fresh install 和上一版升级；implementation/native 不能用两个不同 SHA 的独立结果拼接。Nightly 或 affected green 不能替代该单次 RC evidence。

不得删除或降级 Snapshot/Blob/Worktree Lease、symlink/hardlink/目录替换攻击、redaction、Candidate Gate 与 target Final Gate 分离、completion seal、Promote no-clobber/crash recovery、SIGINT/SIGTERM、真实生态和 installer 测试；这些只允许进入更低频、证据更强的门槛。

用户可见状态也属于发布合同：CLI/TUI golden 必须证明 Candidate 与
Promotion 始终是 `candidateOnly`、`terminalPass: false`、
`completionSealCommitted: false`、target 未改变且仍需 Target Final Gate；
Final 事件必须证明 completion seal 和 terminal join 已完成，PASS 或 non-PASS
seal 均为 `completionSealCommitted: true`，只有完整 PASS lineage 才能声明
`terminalPass: true`。任何重新出现泛化 `Gate: PASS` 或把 Candidate PASS
渲染为完成的改动都必须阻断发布。

## 5. CLI smoke

使用真实 entrypoint 验证命令可启动：

```bash
tsx --tsconfig apps/wukong/tsconfig.dev.json \
  --import build/register-raw-text-loader.mjs \
  apps/wukong/src/main.ts verify \
  --command "node -e 'process.exit(0)'" \
  --no-report

tsx --tsconfig apps/wukong/tsconfig.dev.json \
  --import build/register-raw-text-loader.mjs \
  apps/wukong/src/main.ts scan --json

WUKONG_HOME=/tmp/wukong-test \
tsx --tsconfig apps/wukong/tsconfig.dev.json \
  --import build/register-raw-text-loader.mjs \
  apps/wukong/src/main.ts guard --status
```

高风险命令必须默认阻断：

```bash
WUKONG_HOME=/tmp/wukong-test \
tsx --tsconfig apps/wukong/tsconfig.dev.json \
  --import build/register-raw-text-loader.mjs \
  apps/wukong/src/main.ts guard -- rm -rf /tmp/wukong-target
```

预期 exit code 为 `1`，并输出 `Blocked high-risk command`。

## 6. 后续测试 TODO

1. ~~增加真实 git repo fixture，覆盖 staged + unstaged diff 混合场景。~~ 已完成（2026-07-08，`git.test.ts` + `scan.test.ts` 混合场景）。
2. ~~增加 Windows shell command parsing 测试。~~ 已完成（2026-07-08，`policy.test.ts`；同时修复 `policy.ts` 的 basename 支持 `\` 分隔符与 `.exe/.cmd/.bat` 后缀）。
3. 如果 P1 实现 shell hook 安装，必须增加 profile 幂等写入和 disable 安全测试。
4. runner 层 stdout/stderr 截断（`MAX_CAPTURE_CHARS`）行为测试。

## 7. v1 P0.5 回归清单（按实施顺序：`/proof` → `/judge` → goal gate → `/loop`）

这些能力已经在 v1 实现。以下测试在 v2 重写期间仍需保留或迁移，不能因为实现替换而丢失原有 gate/loop 回归覆盖：

### 第 1 步：`/proof` Merge Proof Report

- `wukong proof` 在干净项目产出 `PASS` 报告，含 changed files / tests / typecheck / secrets scan / recommendation。
- 在含 placeholder / secret / 失败测试的项目产出 `BLOCKED` 并定位原因。
- `wukong proof --strict` 在仅有 warning 时也判 `BLOCKED`。
- `wukong proof --json` 输出符合 `ProofResult` schema。
- `/proof` TUI slash command 渲染 Merge Proof Report。

### 第 2 步：`/judge` evaluator-only 判定

- `wukong judge`（默认 `--assume-broken`）在 verify failed 或有 high-risk 时判 `BLOCK`。
- 在 verify passed 且 clean 时判 `PASS`。
- `--strict` 在 medium risk 时判 `BLOCK`。
- `/judge` 不触发任何写操作（不写代码、不改文件）。
- deterministic 默认模式不发起任何模型调用（必须有测试断言这点）；`--agent` 模式落地后单独补只读工具约束测试。

### 第 3 步：`/goal` verification gate（`/loop` 硬前置）

- 带停止条件的 goal：agent 宣布 completed 且 verify 通过时，goal 才进入 completed。
- agent 宣布 completed 但 verify 失败时，gate 拒绝完成，失败反馈注入下一回合 prompt，goal 继续推进。
- gate 评估结果（`GoalGateResult.verification`）写入 goal 快照。
- 无停止条件的 goal 保持现状行为（agent 自评），不受 gate 影响。
- 回合/预算上限在 gate 打回场景下仍然生效，不会无限循环。

### 第 4 步：`/loop` 本机迭代 loop

- `wukong loop "<goal>" --until verify-pass` 在会话内持续驱动直到 verify 通过。
- 停止条件由 goal verification gate 判断，**不**由写代码的 agent 自评（必须有测试断言这点）。
- 默认紧循环：上一轮 gate 未过后立即开始下一轮，无隐式等待。
- `--every` 设置时，Goal driver 在上一轮 Gate 失败后做可取消等待；断言不会立即续轮，也不会创建或遗留 cron task。
- `--max-iterations` 达到上限时返回 `max-iterations` 状态，不假装成功。
- `--dry-run` 不实际驱动 agent，只校验参数与停止条件。
- `loop` 可被人随时 stop，停止后返回 `stopped` 状态与最后一轮 verification 快照。
- `LoopResult.history` 与每轮 gate 的 `VerificationResult` 快照一致。
