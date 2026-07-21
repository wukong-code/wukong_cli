# Wukong CLI - TODO

> 定位: 本文件是 `wukong_cli` 的执行层任务清单。方向与验收以 [ROADMAP.md](ROADMAP.md) 为准；当前 0.0.17 以 [Command Surface Reliability](docs/design/0.0.17-command-surface-reliability.md) 为准，共享验证基础以 [技术实现方案](docs/tech/commercial-refactor-implementation.md) 为准，现有测试基线以 [测试计划](docs/test/verification-cli-test-plan.md) 为准；本文件只维护"现在做什么、做到哪了"，不重复定义方案。
> Web 侧任务见 `wukong_web/TODO.md`。
> 更新规则: 每完成一项勾选并注明日期；口径变更时先改 ROADMAP/设计方案，再同步本文件。

## ✅ 0.0.16 — Loop Convergence

> 方案: [docs/design/0.0.16-loop-convergence.md](docs/design/0.0.16-loop-convergence.md)。本版继续免费/BYOK，重点是让 Loop 围绕固定目标收敛；不做支付、PR Gate 写入或默认多 reviewer。

### P0：Acceptance Contract 与持久化

- [x] 定义 `LoopContract`：冻结 objective、可选 completion criterion 和 verification plan；0.0.16 不让模型生成额外 criteria（2026-07-20）
- [x] objective 原文保持权威，不允许 writer/reviewer/strategist 覆盖或静默修改（2026-07-20）
- [x] 增加 `goal.contract.create`、`goal.review.record`、`goal.strategy.record` append-only records 与 restore（2026-07-20）
- [x] restart/resume/compaction 后恢复合同、prior blockers 和 strategy 状态（2026-07-20）
- [x] 旧 Goal 第一次进入 0.0.16 Gate 时生成 fallback contract，不伪造旧 review history；旧 strategy record 自动归一化（2026-07-20）

### P0：Prior Gaps 与 Reviewer Anti-ratchet

- [x] Reviewer 输入增加冻结合同和 prior blockers，逐项返回 resolved/still-open/replaced-by（2026-07-20）
- [x] blocking finding 必须关联有效 `criterionId`，由 harness 生成 stable blocker key（2026-07-20）
- [x] 对排序去重后的 blocking keys 生成 fingerprint，不使用自然语言、绝对路径或 line number（2026-07-20）
- [x] 新 blocking finding 必须关联固定 criterion；风格偏好保持 important/note（2026-07-20）
- [x] deterministic blocker 不可被 reviewer 覆盖，review 后继续校验 workspace freshness（2026-07-20）

### P0：Stall Strategist 与 Model Fallback

- [x] 连续两轮相同 fingerprint 触发一次 read-only strategist；每个 Goal 最多尝试一次（2026-07-20）
- [x] strategist 输出固定 diagnosis/recommendedApproach/risks schema，不能修改 workspace、policy、Role 或合同（2026-07-20）
- [x] strategist fail-open、不增加 quota/maxIterations；仍相同则 `NEEDS_WORK/no_progress`（2026-07-20）
- [x] 显式 reviewer model 不可用时回退当前 writer model 一次；invalid output 同模型重试一次，用户取消不回退（2026-07-20）
- [x] invalid output、model unavailable、fallback failure 和 check infrastructure error 使用稳定独立 reason code（2026-07-20）

### P0：Permission Mode v2 与分身权限上限

- [x] 重排 permission policy，保证 hard deny/profile ceiling/Plan guard/用户 deny 先于 Auto/YOLO 决策（2026-07-20）
- [x] Auto 改为不提问的受限自主模式：workspace 外写入、敏感目标、高风险 Bash 和未分类 MCP/custom tool 阻断并暂停（2026-07-20）
- [x] YOLO 明确为危险 approval bypass，但不能绕过用户 deny、安全 hook、Plan guard、profile allowlist 或只读 capability（2026-07-20）
- [x] Headless `-p` 默认使用受限 Auto；危险执行要求 `--yolo --yes`，单独 `--yes` 不再启用 YOLO（2026-07-20）
- [x] 旧 `--auto-approve` 增加弃用/危险警告，旧 permission records 与 `default_permission_mode` 保持可恢复（2026-07-20）
- [x] 修复 child custom-tool 继承：只注册工具，不绕过 child profile 激活；reviewer/planner/strategist/read-only explore 强制只读（2026-07-20）
- [x] footer 与 `/status` 显示当前 permission mode，`/tasks` 显示实际任务，YOLO 使用持续危险提示（2026-07-20）

### P1：Resume、Role、TUI 与 Session Search

- [x] Welcome suggestion 仅扫描当前 workspace、最近 30 天、每来源最多 50 条，并支持 opt-out（2026-07-20）
- [x] suggestion 只显示一条；选择后仍需只读 import、workspace re-check 和 objective 编辑确认（2026-07-20）
- [x] Role schema 增加可选 inputs/outputs/capabilityMode；与 tools/base profile 取交集，不能扩权（2026-07-20）
- [x] planner/reviewer/strategist 使用明确 Role contract，均固定 read-only（2026-07-20）
- [x] footer 只显示一条紧凑后台任务状态，详细状态与输出统一留在 `/tasks`，不向 transcript 重复写状态说明（2026-07-20）
- [x] session picker 搜索最近 100 个 session 的有界本地 prompt 摘要，支持 debounce/cancel，不增加 native SQLite 依赖（2026-07-20）

### 指标、E2E 与发布

- [x] 增加不含 objective、criterion、blocker、路径、session id 或 transcript 的 convergence metrics（2026-07-20）
- [x] 增加只含 mode、阻断类别和 capability 类别的 permission metrics，不上传命令、参数、路径或自定义工具名（2026-07-20）
- [x] 真实 Node/Python/Rust/Go 项目覆盖 check blocker → fix → PASS（2026-07-20）
- [x] 覆盖 repeated blocker → strategist → unblock/no-progress 两条 contract 路径（2026-07-20）
- [x] 覆盖 invalid/unavailable reviewer model → retry/fallback 和两模型失败（2026-07-20）
- [x] 覆盖 TUI/Headless Manual、Auto、YOLO、`--yes`、`--auto-approve` 和旧 config/record 兼容矩阵（2026-07-20）
- [x] 覆盖 Auto/YOLO 父 Agent 下 reviewer/strategist 仍保持只读，以及 coder 只继承合法工具交集（2026-07-20）
- [x] Codex/Claude Code/Cursor suggestion → resume → edit objective → Loop terminal PASS TUI E2E（2026-07-21）
- [x] 0.0.15 Goal/session/Role compatibility、durable lifecycle、outbox 和 completion API 全量回归（2026-07-20）
- [x] Core/CLI/全仓 test、typecheck、lint、docs/bundle build、macOS arm64 SEA/native smoke 通过（2026-07-21；全仓并发 fs-watch burst 超时已单文件串行 7/7 复验）
- [x] 正式 tag 后六平台 ZIP/SHA assets、0.0.15 → 0.0.16 upgrade 与 fresh install 通过（2026-07-21）
- [x] 内部中英文 README、用户指南、CHANGELOG、release notes 与设计文档同步（2026-07-21）
- [x] 正式发布时同步公告、公开 repo、Web 当前版本/下载/Changelog 文案（2026-07-21）

### 明确不做

- 支付、GitHub PR 写入、Team、managed reviewer、默认多 reviewer、云端 `/schedule`、远程 session、Hosted Report、Agent/Persona 市场和自动 policy 修改均不进入 0.0.16。

## 🚧 0.0.17 — Command Surface Reliability

> 方案: [docs/design/0.0.17-command-surface-reliability.md](docs/design/0.0.17-command-surface-reliability.md)。本版继续免费/BYOK，只收口现有 CLI/TUI 命令契约，不新增 Agent 引擎、托管能力或商业功能。

### P0：命令契约

- [x] 删除全局与 Loop `--role`，删除 TUI `/role`；Role 管理统一为 `wukong roles list|show|init`，会话切换统一为 `/transform`（2026-07-21）
- [x] 删除 TUI `/report` 与 `/yes`，保留 Loop/Gate、高级 `/proof` 和明确 permission 命令（2026-07-21）
- [x] `/transform list|status|off` 可发现；补全包含内置与自定义 Role；实验未启用时提供本地 `/experiments` 指引（2026-07-21）
- [x] 未知、禁用和当前不可用 slash command 在本地拦截并给出建议，不发送给模型；保留 `/dance`（2026-07-21）
- [x] `/auto`、`/yolo` 非法参数不改变 permission mode，`/settings` 只允许 idle 状态打开（2026-07-21）
- [x] Loop 数值严格解析且 dry-run 显示 writer/reviewer model；`/export` 统一 ZIP、Markdown 使用 `/export-md`（2026-07-21）
- [x] Today focus/clear 冲突在写入前拒绝，`wukong roles` 未知子命令返回明确 usage（2026-07-21）

### P0：自动化回归

- [x] 覆盖 registry/resolve/dispatch 的命令可见性、实验开关、idle gate、参数拒绝、建议和不会调用模型（2026-07-21）
- [x] 覆盖 `--role` 删除、Loop 数值、Today 无副作用、roles 子命令和 permission mode 真实边界（2026-07-21）
- [x] 9 个目标测试文件 129 项通过；完整 app 205 个 test files 通过、2 个跳过，2391 项通过、3 项跳过（2026-07-21）
- [x] app typecheck 与 oxlint 通过，0 warning / 0 error（2026-07-21）

### 发布门槛

- [ ] 完成真实 TUI smoke：`/transform list|status|off`、实验指引、未知 slash、本地 permission 错误、ZIP/Markdown export 与真实 `/loop`
- [ ] 完成 bundle/native smoke、六平台 ZIP/SHA assets、0.0.16 → 0.0.17 upgrade 与 0.0.17 fresh install；安装器不恢复 telemetry 提示行
- [ ] 增加 0.0.17 release notes，完成内部 CHANGELOG、README、用户指南和设计文档最终对账
- [ ] 正式发布时才切换 package version、tag、公开 release、Web manifest、下载页、Changelog 与升级公告

### 明确不做

- 支付、GitHub PR 写入、entitlement、Team、managed reviewer、云端 `/schedule`、`/ship`、Hosted Report、同步闭环、默认多 reviewer、`--agent` judge mode、Role/Agent 市场、mascot 与 welcome 动画均不进入 0.0.17。

## ⏳ 0.1.0 — Pro PR Gate + Billing

> 方案: [docs/design/0.1.0-pro-pr-gate.md](docs/design/0.1.0-pro-pr-gate.md)。本版保留完整的本地 BYOK Loop，首个付费权益是把 Gate summary/comment 和 `wukong/gate` status 发布回 GitHub PR。候选 `$9/月` 只用于邀请制实验，不是公开价格承诺。
>
> 2026-07-20 生产基线：8 个注册用户、1 个 activated Loop user、0 个 completed users。支付决策门槛尚未满足；公开 Checkout 默认关闭。

### Phase 0：先证明完成价值

- [ ] 至少 5 个真实 activated Loop users、3 个 completed users
- [ ] terminal completion reporting rate ≥ 90%
- [ ] 至少 2 个用户在 7 天内重复完成 Loop
- [ ] 至少取得 3 条可归因反馈，解释继续使用或放弃原因
- [ ] 0.0.17 正式发布并完成升级、fresh install 与真实 TUI `/loop` smoke

### P0：Entitlement 单点真相源

- [ ] 增加 capability-based `/api/v1/account` contract：Loop limits、`prGatePublish`、billing、usage 和 links
- [ ] Web 实现统一 `resolveEntitlement()` 状态表；unknown fail-closed，Dashboard、quota、Checkout 和 webhook 不再各自解释 tier
- [ ] 清理 `pro = Team Pilot`、Founder 无限权益和假 `teamPolicyPacks/deepReviewCredits` 等当前语义漂移
- [ ] CLI 实现 `wukong account` 与 `--json`；API 故障只保留 Free 本地能力，不离线授予 GitHub 写权限
- [ ] 数据 migration：current subscription projection + append-only billing event ledger；user/customer/subscription/event 分别唯一，event 去重与 projection 更新原子

### P0：Free Preview + Pro PR Publish

- [ ] 实现 `wukong pr gate --dry-run`，Free 可查看 PR、SHA、redaction 后 comment/status，不写 GitHub
- [ ] 实现 Pro `wukong pr gate`、`--pr`、`--yes` 和 `--json`
- [ ] 复用现有 `gh` 登录或显式 token；0.1.0 不引入 GitHub App/org mapping
- [ ] 用 `pending status → neutral marker comment → terminal status → final comment` 两阶段协议幂等发布，并实现 partial-write 补偿/重试
- [ ] stale Gate/SHA、权限不足、rate limit、partial write 返回 ERROR；marker 查找覆盖分页、actor 归属与同 PR 校验
- [ ] credential 只读自 `gh` store/env，不落盘或进日志；fork PR 默认 dry-run，禁止危险 `pull_request_target` 执行
- [ ] redaction 禁止 secret、绝对路径、prompt、transcript、diff 和 model key；首次发布必须预览确认

### P0：Stripe Billing Lifecycle

- [ ] `PRO_PUBLIC_CHECKOUT_ENABLED=false` 默认关闭公开购买；服务端按 public flag 或 invite allowlist 准入
- [ ] 单一月付 Price allowlist、登录用户/Stripe customer 绑定和 Checkout
- [ ] 防止重复 subscription：active/grace 用户转 Portal，Checkout 使用幂等键与每用户唯一约束
- [ ] Customer Portal：付款方式、invoice、周期末取消和恢复
- [ ] webhook signature、event ID 去重、乱序安全和 Stripe object 回读；Checkout completed 本身不得直接授权
- [ ] 处理 subscription create/update/delete、invoice paid/payment failed、refund/dispute reconciliation、7 天 grace 和 recovery
- [ ] success page 轮询真实 entitlement；Dashboard 从数据库读取 billing，不信任旧 JWT tier
- [ ] 邀请制试验前同步退款、取消、数据处理和支持说明，并测试退款/争议后的 entitlement

### E2E 与发布门槛

- [ ] Stripe Test Mode + D1：购买、重复/乱序事件、续费、失败、grace、取消、恢复
- [ ] 真实 GitHub 测试 repo：PASS、NEEDS_WORK、stale SHA、重复发布、权限失败和 partial write
- [ ] 用明确标记的 `0.1.0-rc.N` native assets + 服务端 allowlist 运行邀请制 pilot，不回填到 0.0.15
- [ ] CLI/Web contract、redaction fixture、中英文文案、Pricing/Terms/Privacy/公告一致性通过
- [ ] 清理内部 CHANGELOG 遗留的旧 `0.1.0/0.1.1` 条目，并核验 registry/tag/release/manifest 没有正式版本冲突
- [ ] 至少 20 个用户完成首个 Loop，累计 50 次 completed Loops
- [ ] 至少 5 位目标用户在真实 PR 完成 dry-run，并确认 publish 能减少手工 review 工作
- [ ] 邀请制 `$9/月` 实验取得 3 个非关联真实付款用户，且每人至少发布一次 PR Gate
- [ ] 至少 2 位付费用户在 30 天内对不同 PR 重复发布，并取得 1 个续费或连续 30 天活跃重复发布信号

### 明确不做

- Hosted Report、managed reviewer/credits、GitHub App、inline review、Team rules/audit、SSO/private runner、云端 `/schedule`、年付/终身版/多付费 tier 均不进入 0.1.0。

## ✅ 0.0.15 — Loop Reliability + First Success

> 方案: [docs/design/0.0.15-loop-reliability.md](docs/design/0.0.15-loop-reliability.md)。本版继续免费/BYOK，先解决 Loop 可靠结束、重启恢复和首次成功，不做支付或 GitHub PR。

### P0：Lifecycle Contract 与持久化

- [x] 冻结 `LoopRunStatus`、`LoopOutcome`、状态迁移和旧 `/complete` payload 兼容（2026-07-20）
- [x] 将 TUI `requestId → goalId/sessionId` tracking 从内存迁移到 `~/.wukong/usage/loop-runs`（2026-07-20）
- [x] 本地 record 使用 `0600`、atomic rename，不保存 objective、prompt、transcript 或 diff（2026-07-20）
- [x] headless/TUI 的 PASS、NEEDS_WORK、ERROR、cancel 和启动失败均写入 terminal record（2026-07-20）
- [x] CLI 重启后发现 active Loop，支持 Resume / End as cancelled / View details；terminal SDK Goal 自动对账（2026-07-20）

### P0：Completion Outbox

- [x] completion 网络失败写入 outbox，不改变本地 Gate 结论（2026-07-20）
- [x] CLI/TUI 启动、session resume、today/doctor 和新 Loop 前 fail-open flush（2026-07-20）
- [x] 区分 401、409、5xx、timeout；实现有上限指数退避（2026-07-20）
- [x] start/complete 服务端幂等，跨用户 requestId 隔离，冲突终态返回 409（2026-07-20）
- [x] 旧 started rows reconciliation；metrics 区分 cancelled、abandoned 和 stale started（2026-07-20）

### P0：Preflight 与首次成功

- [x] provider/model、workspace、objective、active Goal 和 checks discovery 在 quota start 前完成（2026-07-20）
- [x] preflight 失败不创建服务端 run、不消耗额度，并只显示 Reason + Next（2026-07-20）
- [x] 初次 TUI 只突出 Continue a task / Start a Loop / Configure model（2026-07-20）
- [x] 无 checks 返回 NEEDS_WORK + 配置指引，不误写为测试失败或 PASS（2026-07-20）
- [x] 最终结果默认只显示 Gate、Iterations、Primary blocker 和 Next；高级诊断保留在 transcript（2026-07-20）

### P1：隐私指标与 Dashboard

- [x] 定义并实现 `install_success`、`first_run`、`resume_selected`、`loop_started`、`loop_first_iteration`、`loop_terminal`、`loop_repeated_7d`（2026-07-20）
- [x] 匿名 telemetry 明示并支持 `WUKONG_TELEMETRY=0`；禁止源码、路径、prompt、transcript、model 和机器指纹（2026-07-20）
- [x] production metrics 区分注册、activated、completed users、terminal reporting rate 和 repeat users（2026-07-20）
- [x] Dashboard 展示 active、stale 和真实 terminal lifecycle，不恢复 Reports 产品面（2026-07-20）

### 测试与发布

- [x] restart/offline/cancel/duplicate-complete/旧 payload contract tests（2026-07-20）
- [x] Node、Python、Rust、Go、无 checks、缺失工具和 Cross-Agent Resume → editable Loop fixture E2E（2026-07-20）
- [x] 全量 test/typecheck/lint/bundle 与本机 darwin-arm64 native smoke（2026-07-20；全量 9214 项通过、10 项资源竞争超时随后按失败文件单 worker 80/80 通过）
- [x] 0.0.14 → 0.0.15 native upgrade pinning contract 与显式 0.0.15 fresh installer E2E（2026-07-20）
- [x] 以真实六平台 assets 验证 0.0.14 → 0.0.15 自动升级与 0.0.15 fresh installer（2026-07-20）
- [x] 三仓 README、用户指南、CHANGELOG、官网、Today 和禁用公告草稿同步（2026-07-20）
- [x] 切换正式 manifest、启用仅面向 0.0.14 的公告并验证 live download / health（2026-07-20）

### 明确不做

- Stripe/Pro 支付、GitHub PR、Team rules、Hosted Report、云端 `/schedule`、新增 Agent 来源、managed credits 和 Role 系统扩张均不进入 0.0.15。

## ✅ 0.0.14 — Cross-Agent Resume + Loop UX

> 方案: [docs/design/0.0.14-resume-loop-polish.md](docs/design/0.0.14-resume-loop-polish.md)。本版继续免费/BYOK，不做支付或 GitHub PR 集成。

### P0：Cross-Agent Resume

- [x] 裸 `/resume` 保持 Wukong-only；删除重复的 `/resume wukong`（2026-07-18，已发布）
- [x] 增加 `/resume codex|claude|cursor` 和隐藏兼容入口（2026-07-18，已发布）
- [x] 实现 Codex、Claude Code、Cursor 本地 session summary discovery（2026-07-18，已发布）
- [x] picker 显示来源标签和原生 ID，并支持当前目录/全部目录和搜索（2026-07-18，已发布）
- [x] 增加 realpath/symlink 边界、损坏 JSONL 隔离和脱敏 fixture（2026-07-18，已发布）
- [x] 增加 `resume-codex`、`resume-claude`、`resume-cursor` 内置只读 Skill（2026-07-18，已发布）
- [x] 增加 `Continue in Wukong` / `Start /loop` 选择面板（2026-07-18，已发布）
- [x] `Start /loop` 预填最后请求并要求用户编辑确认；Loop 进入后重新读取 workspace、Git 和项目检查（2026-07-18，已发布）
- [x] Codex、Claude Code、Cursor 真实本机会话格式 discovery smoke；fixture 覆盖 session → handoff → workspace re-check 指令链（2026-07-18，fixture E2E 已通过；真实模型 turn 未纳入 release gate）
- [x] 增加超大 transcript、Cursor 移动工作目录和格式变化回归（2026-07-18，已发布）

### P0：TUI Gate 与 Footer

- [x] 修正 `Verify ✗ · Proof BLOCKED` 误导语义，收敛为可解释 Gate 状态（2026-07-18，已发布）
- [x] 区分检查未执行、检查失败、无项目检查、高风险复核和 reviewer blocker（2026-07-18，已发布）
- [x] 保持 Footer 窄终端对齐与截断测试（2026-07-18，已发布）
- [ ] 补一次真实 TUI `/loop` 人工 smoke，确认 transcript 仍保留高级诊断细节

### P1：真实项目检查

- [x] Python：只在项目显式配置 pytest、ruff、mypy 时发现对应命令（2026-07-18，已发布）
- [x] Rust：识别 Cargo test 与项目显式 Clippy 配置（2026-07-18，已发布）
- [x] Go：识别 module test 与项目显式 golangci-lint 配置（2026-07-18，已发布）
- [x] 工具缺失、超时和无检查分别返回稳定可解释状态（2026-07-18，已发布）
- [x] Node/Python/Rust/Go 真实临时仓库 E2E（2026-07-18，已发布）

### 兼容与发布

- [x] legacy `verify-pass`、`scan-clean`、`judge-pass` 在 0.0.14 继续兼容，不提前删除
- [x] 建立 0.0.14 设计、ROADMAP、TODO 与 CHANGELOG 口径（2026-07-18）
- [x] 同步中英文 README、用户指南、CLI help 和官网首页/下载/Pricing/Dashboard/Today/Changelog 文案（2026-07-18，公告正式启用与 release assets 同步）
- [x] 完成全量测试、typecheck、lint、bundle build/smoke 与 macOS arm64 native SEA build/smoke（2026-07-18）
- [x] 创建 `v0.0.14` tag、六平台 release assets、公开 CHANGELOG、升级 manifest 和正式公告（2026-07-18）

### 明确不做

- Stripe/Pro 支付、GitHub PR、Team policy、云端 `/schedule`、自动 policy improver 均不进入 0.0.14。

## ✅ 0.0.13 — Review Learning Loop

> 方案: [docs/design/review-learning-loop.md](docs/design/review-learning-loop.md)。本版是 Review Learning Loop 第一阶段：结构化 findings → 人工反馈 → 后续 Loop。自动 policy proposal、固定 eval improver 和支付不在 0.0.13 实现。

### P0：Review Contract

- [x] 统一 reviewer profile 与 runtime 的 JSON 输出格式，移除 `VERDICT` / `VERDICT_JSON` 冲突（2026-07-16）
- [x] 将单 blocker 升级为多 finding `ReviewResult`，包含 severity/category/evidence/nextAction/confidence/validationStatus（2026-07-16）
- [x] 只有 blocking finding 阻止 Loop；important/note 只展示和记录，不制造无限修复（2026-07-16）
- [x] 为旧单 blocker LoopResult 和 0.0.12 Goal record 提供兼容投影（2026-07-16）
- [x] 限制 finding 数量、单项长度和总 payload；invalid output 最多重试一次后返回 ERROR（2026-07-16）

### P0：Project Review Policy

- [x] 加载 `.wukong/review-policy.md`，纳入 config/workspace fingerprint 和 reviewer prompt（2026-07-16）
- [x] policy 缺失时保持 0.0.12 行为；policy 改变时拒绝陈旧 reviewer 结论（2026-07-16）
- [x] Reviewer 保持只读；额外验证只作为 `nextAction` 建议，不动态执行新命令（2026-07-16）

### P0：人工 Feedback

- [x] 实现本地 `~/.wukong/review/feedback.jsonl` schema 和 append-only store（2026-07-16）
- [x] 增加 `wukong review feedback <finding-id> accept|dismiss|fixed|unclear`（2026-07-16）
- [x] TUI 通过 `/review feedback <finding-id> <action>` 提供 accept/false-positive/fixed/unclear 最小入口（2026-07-16）
- [x] 聚合 acceptance、dismiss/false-positive、fixed、review cycles、reviewer errors 和 invalid-output 原始数量（2026-07-16）
- [x] 少于 10 条有反馈 findings 时只显示样本量，不输出质量百分比结论（2026-07-16）
- [x] 默认不上传 finding、diff、policy 或自由文本 feedback reason（2026-07-16）

### P1：模型与统计

- [x] 增加 `--review-model` 和 role 独立 reviewer model，0.0.13 保持 BYOK，不接支付 entitlement（2026-07-16）
- [x] TUI 移除常驻 Today/verify/scan/proof 零值统计，空闲态突出 `/loop`（2026-07-16）
- [x] Web 首页、下载、定价、Dashboard、SEO、邮件和公告统一为 Goal → Write → Check → Review → Fix（2026-07-16；0.0.13 公告发布前保持 disabled）

### 已迁移到 0.1.0

支付、真实 Pro entitlement 和 GitHub PR 发布任务已收敛到本文件顶部的 0.1.0 清单；不再沿用 Free / Pro / Team 同时上线的旧范围。

### 0.0.13 发布门槛

- [x] 真实临时 monorepo E2E + finding → feedback → fix → 后续 review 自动化覆盖（2026-07-16）
- [x] Reviewer 无写权限、policy fingerprint、旧结果兼容测试通过（2026-07-16）
- [x] Free 基础反馈/eval 有真实 runtime 行为；生产统计区分 registered users 与 activated Loop users（2026-07-16；feedback 保持 local-only）
- [x] 中英文 README、user guide、CHANGELOG、公告草稿、0.0.13 preview page、Web Pricing/Dashboard 同步，Pro/Team 保持 `Coming Soon`（2026-07-16；公告待 release assets 就绪后启用）
- [x] 支付、GitHub PR 自动评论、团队 policy 同步和云端 improver 保持未完成口径（2026-07-16）

## ✅ 0.0.12 — Loop-first

> 方案: [docs/design/verification-loop-v2.md](docs/design/verification-loop-v2.md)。本版只向普通用户提供一个主产品：Loop。`verify`、`scan`、`proof` 降级为 Loop 内部检查层和高级调试命令，不再各自形成产品、额度或报告流程。

### Loop contract 与额度

- [x] 冻结 Loop 状态机：INSPECT → WORK → CHECK → REVIEW → PASS / NEEDS_WORK / ERROR（2026-07-16）
- [x] 用户结果只保留 PASS→0、NEEDS_WORK→1、ERROR→2；执行前 auth/quota→3，中断→130（2026-07-16）
- [x] 默认停止条件统一为 `proof-pass`；旧停止条件进入时统一归一化（2026-07-15）
- [x] 只有顶层 Loop session 计额度；内部 verify/scan/proof 不重复计数（2026-07-16）
- [x] Guest：1 个 Loop session、最多2轮；Free：10个 Loop sessions/月、每个最多5轮；第3次开始软提示 Pro，第10次后硬限制（2026-07-16）
- [x] 实现幂等 `/api/v1/loops/start`、`/api/v1/loops/complete` 与 `/api/v1/usages`；不实现 Checks、reservation、lease 或 AI credits（2026-07-16）
- [x] 默认不生成 report/evidence；只有显式本地 `--save`/`--report` 才持久化（2026-07-16）

### Loop 执行与交付 Gate

- [x] 每轮 agent 修改后运行真实项目检查和风险扫描，再交给 fresh-context reviewer 判定（2026-07-15）
- [x] 写代码的 agent 不能自判通过；reviewer 使用独立上下文和只读 profile，且不能覆盖 deterministic blocker（2026-07-15）
- [x] 将失败摘要、具体文件/命令和 next action 注入下一轮，限制 feedback 大小（2026-07-16）
- [x] NEEDS_WORK 才继续修改；ERROR 停止；transient reviewer error 最多原地重试一次（2026-07-16）
- [x] 达到最大轮次返回 NEEDS_WORK/max_iterations，不增加 EXHAUSTED 用户状态（2026-07-16）
- [x] 无测试项目：源代码改动阻断；纯文档改动可进入 reviewer（2026-07-15）
- [x] `wukong loop` 支持 headless 运行及 `--model` writer；reviewer 独立且只读（2026-07-15，`--role` 于 2026-07-21 移除）
- [x] `--every` 继续复用 agent-core scheduler，不新增 timer（2026-07-16，现有实现已满足）

### 内部检查层与兼容

- [x] 统一 workspace/nested project discovery、真实 command 结果和 stable finding schema（2026-07-16）
- [x] `proof-pass` 编排检查、扫描与 reviewer；共享 snapshot，并在输入变化时拒绝陈旧结论（2026-07-16）
- [x] `verify`、`scan`、`proof` 保留为高级/CI/debug 命令（2026-07-15）
- [x] 从 CLI 主帮助、TUI autocomplete/help 隐藏三个高级命令，但旧命令仍可直接执行（2026-07-15）
- [x] 旧 verify-pass/scan-clean/judge-pass 在兼容期映射到 `proof-pass`；CLI 显式旧参数输出弃用提示（2026-07-15）
- [x] 不再把 Reports 或独立 evidence 作为 Loop 默认完成步骤（2026-07-16；Loop 内部 gate 已使用 `writeReport: false`）

### 变身 Role Profiles

- [x] 内置 general/reviewer/planner/strategist/security/tester，通过 TUI `/transform` 切换（实验开关默认关闭；全局 `--role` 于 2026-07-21 移除）
- [x] 用户角色存 `~/.wukong/roles/`；项目角色必须以 `project:<name>` 显式选择，不能覆盖 builtin（2026-07-15）
- [x] role 只定义 prompt、默认 model、允许 tools、verify profile；工具 allowlist 只能收窄基础 profile，未知字段会被拒绝（2026-07-15）
- [x] `wukong roles list/show/init`；0.0.12 不做市场、团队同步或多角色自动编排（2026-07-15）
- [x] 将角色切换收敛到 TUI `/transform`；删除 `loop --role`，内部检查不单独选择角色或模型（2026-07-21）

### 端到端同步与发布门槛

- [x] CLI、TUI、agent tool 使用同一 Loop 三态；Dashboard 只展示 Loop 用量、重置时间和最近最终状态（2026-07-16）
- [x] 旧 Goal record migration 和旧 CLI flags compatibility matrix（2026-07-16）
- [x] 真实 monorepo、无测试项目、snapshot stale、fresh reviewer、角色权限、usage start 幂等、Loop 收敛 E2E（2026-07-16）
- [x] 更新中英文 README、help、公告、CHANGELOG 和 release notes（2026-07-16；公开仓发布时同步生成物）

### 0.0.13+ Backlog

- [x] `--review-model`、role 独立 reviewer model（2026-07-16；保持 BYOK，managed model credits 延后）
- [ ] 全语言自动检查推断、后台/云端 Loop、PR gate 和 Team Role Profiles

## ✅ 0.0.11 — TUI、公告与发布闭环

- [x] TUI welcome/footer/loop/proof 文案与终端宽度对齐，窄终端安全降级（2026-07-13）
- [x] TUI 公告协议、版本/时间/频控过滤、安全链接白名单和非阻塞拉取（2026-07-13）
- [x] 生产验收：公告端点 200 且 5 分钟缓存；0.0.10→0.0.11 更新 manifest（2026-07-13）
- [x] 发布 `0.0.11` 六平台资产并同步 `wukong-code` CHANGELOG、文档和安装 manifest（2026-07-13）

## ✅ Milestone 0.5 — Loop 控制层 + Merge Proof

实施顺序固定：`/proof` → `/judge` → `/goal` verification gate → `/loop`。不引入新引擎：proof/judge 复用 `@wukong/verification`，loop 执行核复用 `/goal`，`--every` 节流复用 agent-core cron scheduler。

### 第 1 步: `/proof` Merge Proof Report（Wow Moment）

- [x] `packages/verification/src/proof.ts`: `buildProofResult` + `renderMergeProofReport`（verify+scan 编排与重排版，不新增检测能力）
- [x] `apps/wukong/src/cli/sub/proof.ts` 并在 `commands.ts` 注册（`--json` / `--strict` / `--report`；PASS→0，BLOCKED→1）
- [x] TUI `/proof` slash command 及 dispatch
- [x] recommendation 由风险类型映射生成（不调用模型）
- [x] 测试: 干净项目 PASS、脏项目 BLOCKED 并定位原因、`--strict` 行为、JSON schema（见测试计划 §6 第 1 步）

### 第 2 步: `/judge` evaluator-only 判定

- [x] `apps/wukong/src/cli/sub/judge.ts` + TUI `/judge`（默认 `--assume-broken`，deterministic 模式，复用 proof 引擎）
- [x] 判定矩阵: verify failed→BLOCK；high-risk→BLOCK；medium→PASS with warnings（`--strict` 则 BLOCK）；clean→PASS
- [x] 文档与 help 如实标注 deterministic 判定，不宣传"第二 agent 审查"
- [x] 测试: 判定矩阵、零写操作、零模型调用断言（见测试计划 §6 第 2 步）
- [ ] （后置，P0.5 末 / P1 初）`--agent` 模式: fresh-context 只读 evaluator agent，复用 fork/side-agent 基础设施，BYOK

### 第 3 步: `/goal` verification gate（`/loop` 硬前置）

- [x] `/goal` 增加可选停止条件 `--until verify-pass | scan-clean | judge-pass`
- [x] agent 宣布 completed 且存在停止条件时，自动运行对应评估；未过则拒绝完成并把失败反馈注入下一回合（受回合/预算上限约束）
- [x] `GoalGateResult` 写入 goal 快照（`/loop` 的 history 直接取自该快照）
- [x] 无停止条件的 `/goal` 保持现状（agent 自评）
- [x] 测试: gate 通过才 completed、gate 打回注入反馈、预算上限防死循环（见测试计划 §6 第 3 步）

### 第 4 步: `/loop` 本机迭代 loop（核心）

- [x] `apps/wukong/src/cli/sub/loop.ts` + TUI `/loop`（含 `status/stop`；`pause/resume` 复用 `/goal`）
- [x] 核心语义 iterate-until-verified: 默认紧循环，每轮注入带停止条件的 goal，gate 未过则反馈注入下一轮
- [x] `--every` 可选轮间节流，复用 agent-core cron scheduler（支持 `<n>s/m/h/d`，最低 1 分钟）
- [x] 失控防护: `--max-iterations`（默认 10）、单轮超时、`--dry-run`、人可随时 stop
- [x] 达到迭代上限返回 `max-iterations` 状态，不假装成功
- [x] 测试: 见测试计划 §6 第 4 步（含"停止判断不由 agent 自评"与"无第二套 timer"断言）

### 文案同步（P0.5 收尾）

- [x] README / 用户指南补充新命令（只写已实现的）
- [x] 官网 hero 切换 loop control plane / proof-layer 叙事（协同 `wukong_web/TODO.md` P0）（2026-07-09）

## 📋 P1: `wukong today` / `/today`（Daily Proof Briefing）

> 方案: [docs/design/today.md](docs/design/today.md) — 今日简报与今日 focus 合并为一条命令；依赖 stats schema，在 proof/loop 稳定后实施。

### 前置：本地 stats 事件流

- [x] 定义 `~/.wukong/stats/events.jsonl` schema（verify / scan / proof / guard / goal / loop 事件）
- [x] 在现有命令出口写入事件（verify、scan、proof、guard、goal 完成、loop 轮次）
- [x] 按自然日聚合与 streak 计算（连续 N 天至少 1 次 clean verify）

### 实现

- [x] `packages/verification` 或独立 `packages/stats`：`buildTodayBriefing()` + `TodayBriefing` 类型
- [x] `~/.wukong/today/focus.json` 读写；`wukong today "..."` 设 focus，`--clear-focus` 清除
- [x] `apps/wukong/src/cli/sub/today.ts` + TUI `/today`（无参=简报，参数=设 focus，`/today clear`）
- [x] 人类可读输出 + `--json`；Next 1–2 条由规则映射（如 BLOCKED proof → 建议 `wukong proof`）
- [x] 测试：离线简报、设/清 focus、JSON schema、不触发 verify 执行

### 不做

- [ ] 不对齐 web legacy `/api/today`（xp/mood/quests）
- [ ] 不把 today 做成任务管理器（执行归 `/goal`）

## 📋 TUI 布局（Loop 驱动）

> 方案: [docs/design/tui-layout-loop-driven.md](docs/design/tui-layout-loop-driven.md) — 底部 chrome 对齐 Claude Code + loop/proof 常驻轨；分 Phase 0→3。

### Phase 0 — 底部 Chrome（Claude Code 骨架）

- [x] `custom-editor.ts`：去 `╭╮╰╯` 边框盒，`❯` prompt + 上下 `─` 分隔线
- [x] 重定义 `paddingX` / `injectPromptSymbol`；bash `! shell mode` 徽标迁至上分隔线 label
- [x] 决策并落实审批/问答/selector 面板样式（建议保留自身边框以示模态）
- [x] `footer.ts`：status 行 2 格缩进；mode 独立最后一行
- [x] 回归：plan/bash 高亮、审批/问答全屏、slash autocomplete

### Phase 1 — 心跳行 + 结论轨（chrome ≤ 7 行硬约束）

- [x] 新建 `loop-phase.ts` 心跳行（`↻ iter/max · phase · 耗时`；blocked `⛔`；`--every` 节流显示）
- [x] 新建 `utils/chrome-state.ts`：goal + verify/proof/gate 聚合；进程内缓存 + 事件驱动刷新（禁止每帧读 stats）
- [x] `footer.ts`：结论轨合并（active：Goal 行 + Verify/Proof 行；idle：Today 摘要行）；`uiMode` idle|active|blocked
- [x] gate 结果每轮落 transcript 一条消息（`✓/✗ iter N gate: …`）
- [x] `wukong-tui.ts`：`updateActivityPane` → `updateLoopPhase`；`activity-pane.ts` 退役
- [x] 测试：chrome-state 单测、footer 三模式快照、心跳行文案、手动 `/goal` `/loop` `/proof` 联调
- [x] review 修复（2026-07-09）：blocked≠verify FAIL；hydrate 取最新；wallClock 去双计；warning→passed；judge 不写 proof stats

### Phase 2 — Today 替换欢迎卡

- [x] idle：today compact 简报；active/blocked：收起大欢迎卡
- [x] `/today` 与启动简报共用渲染器
- [x] MINI_ART 保留为 compact 单行（见 `welcome-art.ts`）

### Phase 3 — Polish

- [ ] `welcomeStyle` 配置：auto | compact | dashboard
- [ ] 像素 mascot 帧按 loop phase 切换（`mascot.ts`）
- [x] Dashboard 模式布局、状态文案、窄终端截断与 footer 列对齐（2026-07-13）

## ⏸ 暂缓（先不做，防止提前开工）

- [ ] `/schedule` 云端例程 — 归 hosted（Milestone 3+）；本机定时巡检用已实现的 cron 工具
- [ ] `/ship` 发布 gate — 依赖 proof 先稳定（P1）
- [ ] `wukong review` / `test` / `retro` — P1，构建在 `@wukong/verification` 上
- [ ] `wukong sync` / `journey` — sync 见 [test-login-sync.md](docs/test/test-login-sync.md)；journey 归 P2
- [ ] guard shell hook 自动注入 / PATH shim / agent 祖先进程识别 — P1，需幂等与备份测试
- [ ] `StopCondition.kind = 'skill'` 自定义验证 skill — 验证 skill 机制落地后接入（P0.5 末或 P1 初）

## ✅ 已完成基线（P0）

- [x] `packages/verification` 独立核心包（verify / scan / risks / policy / report）
- [x] `wukong verify` / `wukong scan` / `wukong guard` top-level 命令
- [x] `wukong_verify` builtin agent tool（structured result）
- [x] TUI `/verify`、`/scan`、`/guard`（`/report` 于 2026-07-21 移除）
- [x] `/goal` 单任务驱动（含队列；完成判定为 agent 自评，gate 见上）
- [x] agent-core cron 工具（CronCreate/List/Delete，会话内 recurring/one-shot，`/loop --every` 的复用基础）
- [x] fixtures、unit tests、CLI/TUI/tool smoke tests
- [x] verification 包测试补全: risks/git/scripts/report/status 单测、staged+unstaged 混合 fixture、Windows 命令解析（含 `policy.ts` basename 修复）、guard override/容错、verify strict/timeout/no-commands —— 7→51 tests（2026-07-08）
- [x] 规划文档口径校准: loop 迭代语义、cron 复用、goal gate、judge 分层（2026-07-08）

---

**最后更新**: 2026-07-21（增加 0.0.17 Command Surface Reliability；0.1.0 商业边界不变）
