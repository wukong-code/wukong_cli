# Wukong CLI - TODO

> 定位: 本文件是 `wukong_cli` 的执行层任务清单。方向与验收以 [ROADMAP.md](ROADMAP.md) 为准；0.0.14 以 [Cross-Agent Resume 与 Loop UX 收尾](docs/design/0.0.14-resume-loop-polish.md) 为准，共享验证基础以 [技术实现方案](docs/tech/commercial-refactor-implementation.md) 为准，现有测试基线以 [测试计划](docs/test/verification-cli-test-plan.md) 为准；本文件只维护"现在做什么、做到哪了"，不重复定义方案。
> Web 侧任务见 `wukong_web/TODO.md`。
> 更新规则: 每完成一项勾选并注明日期；口径变更时先改 ROADMAP/设计方案，再同步本文件。

## 📋 当前重点: 0.0.14 — Cross-Agent Resume + Loop UX

> 方案: [docs/design/0.0.14-resume-loop-polish.md](docs/design/0.0.14-resume-loop-polish.md)。本版继续免费/BYOK，不做支付或 GitHub PR 集成。

### P0：Cross-Agent Resume

- [x] 裸 `/resume` 保持 Wukong-only；删除重复的 `/resume wukong`（2026-07-18，待提交）
- [x] 增加 `/resume codex|claude|cursor` 和隐藏兼容入口（2026-07-18，待提交）
- [x] 实现 Codex、Claude Code、Cursor 本地 session summary discovery（2026-07-18，待提交）
- [x] picker 显示来源标签和原生 ID，并支持当前目录/全部目录和搜索（2026-07-18，待提交）
- [x] 增加 realpath/symlink 边界、损坏 JSONL 隔离和脱敏 fixture（2026-07-18，待提交）
- [x] 增加 `resume-codex`、`resume-claude`、`resume-cursor` 内置只读 Skill（2026-07-18，待提交）
- [x] 增加 `Continue in Wukong` / `Start /loop` 选择面板（2026-07-18，待提交）
- [x] `Start /loop` 预填最后请求并要求用户编辑确认；Loop 进入后重新读取 workspace、Git 和项目检查（2026-07-18，待提交）
- [x] Codex、Claude Code、Cursor 真实本机会话格式 discovery smoke；fixture 覆盖 session → handoff → workspace re-check 指令链（2026-07-18，真实模型 turn 待发布前 smoke）
- [x] 增加超大 transcript、Cursor 移动工作目录和格式变化回归（2026-07-18，待提交）

### P0：TUI Gate 与 Footer

- [x] 修正 `Verify ✗ · Proof BLOCKED` 误导语义，收敛为可解释 Gate 状态（2026-07-18，待提交）
- [x] 区分检查未执行、检查失败、无项目检查、高风险复核和 reviewer blocker（2026-07-18，待提交）
- [x] 保持 Footer 窄终端对齐与截断测试（2026-07-18，待提交）
- [ ] 补一次真实 TUI `/loop` 人工 smoke，确认 transcript 仍保留高级诊断细节

### P1：真实项目检查

- [x] Python：只在项目显式配置 pytest、ruff、mypy 时发现对应命令（2026-07-18，待提交）
- [x] Rust：识别 Cargo test 与项目显式 Clippy 配置（2026-07-18，待提交）
- [x] Go：识别 module test 与项目显式 golangci-lint 配置（2026-07-18，待提交）
- [x] 工具缺失、超时和无检查分别返回稳定可解释状态（2026-07-18，待提交）
- [x] Node/Python/Rust/Go 真实临时仓库 E2E（2026-07-18，待提交）

### 兼容与发布

- [x] legacy `verify-pass`、`scan-clean`、`judge-pass` 在 0.0.14 继续兼容，不提前删除
- [x] 建立 0.0.14 设计、ROADMAP、TODO 与 CHANGELOG 口径（2026-07-18）
- [x] 同步中英文 README、用户指南、CLI help 和官网首页/下载/Pricing/Dashboard/Today/Changelog 文案（2026-07-18，公告正式启用与 release assets 同步）
- [x] 完成全量测试、typecheck、lint、bundle build/smoke 与 macOS arm64 native SEA build/smoke（2026-07-18）
- [ ] 创建 `0.0.14` tag、六平台 release assets、公开 CHANGELOG 和升级 manifest

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

### 明确延后到 0.1.0：支付与真实 Pro

- [ ] Stripe Checkout、customer portal、subscription cancel/payment failure、grace 状态和 webhook E2E
- [ ] Free / Pro / Team entitlement 与 reviewer/Loop/hosted/PR 权益统一
- [ ] Billing UI 展示 plan、usage、quota、renewal、failed payment 和 portal 入口
- [ ] Pricing、Dashboard、CLI upgrade 提示与真实价格、entitlement 对齐
- [ ] 验证 quota warning → checkout → entitlement → cancel/failure/grace 全链路
- [ ] 达到 3 个非关联真实个人付费用户，或 1 个持续使用真实 repo 的付费 Team Pilot

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
- [x] 实现幂等 trust-runs start/complete + trust-usage；不实现 Checks、reservation、lease 或 AI credits（2026-07-16）
- [x] 默认不生成 report/evidence；只有显式本地 `--save`/`--report` 才持久化（2026-07-16）

### Loop 执行与交付 Gate

- [x] 每轮 agent 修改后运行真实项目检查和风险扫描，再交给 fresh-context reviewer 判定（2026-07-15）
- [x] 写代码的 agent 不能自判通过；reviewer 使用独立上下文和只读 profile，且不能覆盖 deterministic blocker（2026-07-15）
- [x] 将失败摘要、具体文件/命令和 next action 注入下一轮，限制 feedback 大小（2026-07-16）
- [x] NEEDS_WORK 才继续修改；ERROR 停止；transient reviewer error 最多原地重试一次（2026-07-16）
- [x] 达到最大轮次返回 NEEDS_WORK/max_iterations，不增加 EXHAUSTED 用户状态（2026-07-16）
- [x] 无测试项目：源代码改动阻断；纯文档改动可进入 reviewer（2026-07-15）
- [x] `wukong loop` 支持 headless 运行及 `--model/--role` writer；reviewer 独立且只读（2026-07-15）
- [x] `--every` 继续复用 agent-core scheduler，不新增 timer（2026-07-16，现有实现已满足）

### 内部检查层与兼容

- [x] 统一 workspace/nested project discovery、真实 command 结果和 stable finding schema（2026-07-16）
- [x] `proof-pass` 编排检查、扫描与 reviewer；共享 snapshot，并在输入变化时拒绝陈旧结论（2026-07-16）
- [x] `verify`、`scan`、`proof` 保留为高级/CI/debug 命令（2026-07-15）
- [x] 从 CLI 主帮助、TUI autocomplete/help 隐藏三个高级命令，但旧命令仍可直接执行（2026-07-15）
- [x] 旧 verify-pass/scan-clean/judge-pass 在兼容期映射到 `proof-pass`；CLI 显式旧参数输出弃用提示（2026-07-15）
- [x] 不再把 Reports 或独立 evidence 作为 Loop 默认完成步骤（2026-07-16；Loop 内部 gate 已使用 `writeReport: false`）

### 变身 Role Profiles

- [x] 内置 general/reviewer/security/tester，支持全局 `--role` 和 TUI `/transform`（实验开关默认关闭，2026-07-15）
- [x] 用户角色存 `~/.wukong/roles/`；项目角色必须以 `project:<name>` 显式选择，不能覆盖 builtin（2026-07-15）
- [x] role 只定义 prompt、默认 model、允许 tools、verify profile；工具 allowlist 只能收窄基础 profile，未知字段会被拒绝（2026-07-15）
- [x] `wukong roles list/show/init`；0.0.12 不做市场、团队同步或多角色自动编排（2026-07-15）
- [x] 将 `loop --role` 接到 Session role resolver；内部检查不单独选择角色或模型（2026-07-15）

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
- [x] TUI `/verify`、`/scan`、`/guard`、`/report`
- [x] `/goal` 单任务驱动（含队列；完成判定为 agent 自评，gate 见上）
- [x] agent-core cron 工具（CronCreate/List/Delete，会话内 recurring/one-shot，`/loop --every` 的复用基础）
- [x] fixtures、unit tests、CLI/TUI/tool smoke tests
- [x] verification 包测试补全: risks/git/scripts/report/status 单测、staged+unstaged 混合 fixture、Windows 命令解析（含 `policy.ts` basename 修复）、guard override/容错、verify strict/timeout/no-commands —— 7→51 tests（2026-07-08）
- [x] 规划文档口径校准: loop 迭代语义、cron 复用、goal gate、judge 分层（2026-07-08）

---

**最后更新**: 2026-07-18（0.0.14 Cross-Agent Resume + Loop UX；支付仍延后到 0.1.0）
