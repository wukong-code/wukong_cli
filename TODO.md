# Wukong CLI - TODO

> 定位: 本文件是 `wukong_cli` 的执行层任务清单。方向与验收以 [ROADMAP.md](ROADMAP.md) 为准，实现方案以 [技术实现方案](docs/tech/commercial-refactor-implementation.md) 为准，测试项以 [测试计划](docs/test/verification-cli-test-plan.md) 为准；本文件只维护"现在做什么、做到哪了"，不重复定义方案。
> Web 侧任务见 `wukong_web/TODO.md`。
> 更新规则: 每完成一项勾选并注明日期；口径变更时先改 ROADMAP/技术方案，再同步本文件。

## 📋 当前重点: 0.0.11 — Hosted Evidence UX 与发布闭环

- [x] TUI welcome/footer/loop/proof 文案与终端宽度对齐，窄终端安全降级（2026-07-13）
- [x] Proof 完成后提示私有 history 与显式公开分享命令；`--public` 必须与 `--upload` 同用（2026-07-13）
- [x] `wukong today` 登录态显示 hosted report 用量和 Dashboard 链接；网络失败不阻塞本地简报（2026-07-13）
- [x] TUI 公告协议、版本/时间/频控过滤、安全链接白名单和非阻塞拉取（2026-07-13）
- [x] 生产验收：公告端点 200 且 5 分钟缓存；0.0.10→0.0.11 更新 manifest（2026-07-13）
- [ ] 已登录真实账号验收：proof upload/private history/public share/dashboard 全链路（当前开发机无 CLI 登录态，不制造测试用户）
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
- [x] 登录态可选：hosted report 当月计数 + `https://wukong.today/dashboard` 链接（失败不阻塞本地简报）（2026-07-13）
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

## 📋 下一批: Hosted Reports 前置（对应 ROADMAP Milestone 1）

- [x] `verify` / `scan` / `proof` 增加登录态 report upload（opt-in；上传失败不影响本地报告）
- [x] redacted report metadata 上传 schema（默认不上传完整源码 diff）
- [x] 本地 Markdown report 上传命令和 Web report API 字段
- [x] redaction 测试: secret-like string、env 文件、token、private key、超大 diff

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

**最后更新**: 2026-07-13（0.0.11 Hosted Evidence UX 与发布闭环）
