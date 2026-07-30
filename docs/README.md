# Wukong Code 文档索引

> 最后更新: 2026-07-25
> 当前事实基线: `wukong_cli` 内部实现仓库，产品名称为 **Wukong Code**
> 状态说明: 本目录区分 **已发布/当前实现**、**已批准规划**、**候选方向** 与 **历史探索**；候选文档不代表已经开工或实现。

## 产品定位

> **给 Wukong 一个目标，它会写、检查、审查并修复，直到没有 blocking finding。**
> Wukong Code 是 review 驱动的 AI Coding Loop。

当前产品只有 Free + BYOK。历史商业文档中的 Free / Pro / Team 分层不属于当前 roadmap；当前核心关系是 Loop 为主流程、分身为执行结构、火眼金睛与 Gate 形成可信结论。

命令分层对应 loop engineering：

| 层 | 命令 | 状态 |
|---|---|---|
| Turn-based | TUI 默认 | 已实现 |
| Goal-based | `/goal` | 已实现（verification gate 已实现，归 M0.5） |
| 本机迭代 | `/loop` / `wukong loop` | 已实现（fresh reviewer、结构化 findings、max-iterations、`--every` pacing） |
| Time-based（本机巡检） | cron 工具（CronCreate 等） | 已实现（会话内 recurring/one-shot） |
| Time-based（云端） | `/schedule` | 历史 Hosted 假设；当前未排期，需未来重新批准 |
| Loop 内部检查层 | `/verify` `/scan` `/proof` | 已实现；直接调用仅用于高级诊断 |
| 评估层 | `/judge` | 已实现（deterministic 先行，`--agent` 后置） |

## 当前事实与版本真相源

以下文档分别标明已实现、已批准规划和历史边界；单个设计文件的状态头优先，不能仅因出现在索引中就视为已经实现：

- [用户指南](user-guide.md)
  只描述当前 top-level CLI 能力、源码运行方式和本地数据位置。
- [apps/wukong 开发指南](../apps/wukong/AGENTS.md)
  描述当前 CLI/TUI app 的文件边界和代码约定。
- [根 README](../README.md) / [中文 README](../README.zh-CN.md)
  面向仓库入口的当前能力说明。
- [产品路线图](../ROADMAP.md)
  记录当前 Free + BYOK 的本地验证闭环与 loop 控制层；付费候选不属于当前计划。
- [0.0.12 Trust Loop v2](design/verification-loop-v2.md)
- [0.0.12 Goal 与 flags 兼容矩阵](design/0.0.12-compatibility.md)
- [0.0.12 release notes / What's Changed](releases/0.0.12.md)
  定义当时的 Loop-first 状态机、独立 reviewer、历史 Loop session 额度、Role Profiles，以及 verify/scan/proof 的内部层与兼容边界；其中 Guest/月度额度已在 0.0.17 移除。
- [0.0.13 Review Learning Loop](design/review-learning-loop.md)
  定义多 finding Review Contract、项目 review policy、人工反馈和独立 reviewer model；自动 improver 与支付不在本版本。
- [0.0.14 Cross-Agent Resume 与 Loop UX 收尾](design/0.0.14-resume-loop-polish.md)
  定义跨 Agent 本地会话导入、Resume → Loop、TUI Gate/Footer 简化、真实项目检查发现、兼容边界和发布门槛。
- [0.0.14 Release Notes](releases/0.0.14.md)
- [0.0.15 Release Notes](releases/0.0.15.md)
  正式版本安装、升级、功能与商业边界。
- [0.0.15 Loop Reliability 与 First Success](design/0.0.15-loop-reliability.md)
  定义 durable Loop lifecycle、completion outbox、重启恢复、preflight、首次成功 UX、隐私指标与当时的商业决策门槛；其旧 0.1.0 收费假设已被新版本路线取代。
- [0.0.16 Loop Convergence](design/0.0.16-loop-convergence.md)
  定义固定验收合同、prior blockers、anti-ratchet reviewer、无进展检测、一次性 strategist、reviewer model fallback、Permission Mode v2、只读分身 capability ceiling、Resume 建议、Role contract、统一任务状态与本地 session 内容搜索。
- [0.0.16 Release Notes](releases/0.0.16.md)
  记录正式版能力、兼容边界、验证结果和发布验收标准。
- [0.0.17 Command Surface Reliability](design/0.0.17-command-surface-reliability.md)
  定义 CLI/TUI 命令契约收口：删除误导入口、保留可发现的 `/transform`、未知 slash 本地拦截、严格参数解析与四层自动化回归；已于 2026-07-22 发布。
- [0.0.18 Loop-First Simplification](design/0.0.18-loop-first-simplification.md)
  已发布：默认命令面只突出 Resume → Loop → Gate，其他命令实现隐藏但不删除；`/resume` 增加 Kimi Code/Grok；`/feedback` 改为无需登录的纯文本 Web API；`/login` 由 CLI 发起并在 Wukong 网站确认，当前模型目录允许为空。
- [0.0.19 Explicit Finish Line](design/0.0.19-explicit-finish-line.md)
  已于 2026-07-25 发布：Loop 启动前确认 Goal、Done when、Must not 和真实 checks；冻结 Gate Plan、workspace trust 与 approval；区分 attempt、terminal、continuation 和 Revised Loop。跨平台、真实多语言 E2E 和五用户量化验收仍作为发布后验证债务保留。
- [0.0.19 Release Notes](releases/0.0.19.md)
- [0.0.20 Reusable Verification Criteria](design/0.0.20-reusable-verification-skills.md)
  实现候选：只复用用户本机已有 Skill 的严格 qualitative criteria，并通过受限 evidence broker 与逐 run BYOK provider consent 复审；不执行 Skill command。发布门槛验证中。
- [0.0.20 Release Notes](releases/0.0.20.md)
- [0.0.21 Isolated Loop Worktrees](design/0.0.21-isolated-loop-worktrees.md)
  后续候选：exact snapshot、显式 bootstrap、独占 worktree、safe Promote 与 target Final Gate。
- [0.1.0 Trusted Local Loop](design/0.1.0-trusted-local-loop.md)
  已确认产品范围、未批准实施：第一版可稳定推荐的 Free 本地 Loop；RC 不增加并行、Supervisor、付费或托管能力。
- [0.2.0 Pro Reliable Autonomy](design/0.2.0-pro-reliable-autonomy.md)
  商业与产品候选：有界并行、显式 Detach、本机 Supervisor 与可选 Verified PR Gate；Free 单 Loop、BYOK 和安全 primitive 永久保留。
- [历史候选：Pro PR Gate 与 Billing](design/historical-pro-pr-gate-billing.md)
  归档的 2026-07-20 单点 PR Gate 收费假设；已被新的 0.1.0 / 0.2.0 版本边界取代。
- [跨 Agent Session Resume](design/cross-agent-resume.md)
  当前 `/resume` 恢复 Wukong 会话，`/resume codex|claude|cursor|kimi|grok` 显式发现对应 Agent 的本地会话，并通过内置 Skill 只读导入后在 Wukong 中继续。
- [执行层 TODO](../TODO.md)
  按 ROADMAP milestone 拆解的任务清单，记录 0.0.19 发布后验证债务、下一已批准实施版本 0.0.20 和已完成基线；0.0.21、0.1.0、0.2.0 尚未批准开工，不进入当前 checkbox 队列。

当前可用 top-level commands 以 `wukong --help` 为准，主要包括：

```text
wukong
wukong -p
wukong provider
wukong acp
wukong server
wukong web
wukong verify
wukong scan
wukong guard
wukong proof
wukong judge
wukong loop
wukong review
wukong login
wukong doctor
wukong export
wukong vis
wukong migrate
wukong upgrade
```

其中 `acp`、`server`、`migrate` 当前为 hidden 命令，不出现在 `wukong --help` 默认输出中，此处列出仅为完整性。

## 背景、架构与历史探索

以下文档同时包含当前架构参考和早期产品/商业探索。当前状态只以 ROADMAP、TODO 和带状态头的版本文档为准；历史文档中的 `/schedule`、sync、完整计费、Team、Hosted Terminal 或商业分层都不是当前后续计划，也不能据此认定已经批准实施：

- [商业化与产品重构方案](business/COMMERCIAL_REFACTOR_PLAN.md)
  历史探索：曾定义商业模型、目标命令结构和早期路线图；其中未进入当前版本文档的部分不再代表产品承诺。
- [Wukong 能力体系与商业化原则](business/WUKONG_CAPABILITY_MODEL.md)
  历史探索：记录能力命名、权限不变量和旧商业分层设想；当前产品仍是 Free + BYOK。
- [商业化重构技术实现方案](tech/commercial-refactor-implementation.md)
  历史技术参考：记录 verification/guard/goal/loop 的早期拆分及未实施的 `/schedule` 设想，不是当前实施清单。
- [最新技术架构](tech/architecture.md)
  定义当前新 Kimi-code base 与 P0 verification/guard 架构。
- [产品设计文档](design/design.md)
  定义未来验证型产品的交互、成长体系和命令设计。
- [today 命令设计](design/today.md)
  定义 `wukong today` / `/today`：Local Loop Briefing（本地 Loop 简报 + focus 合并）。
- [TUI 布局改造计划（Loop 驱动）](design/tui-layout-loop-driven.md)
  定义 TUI 对齐 Claude Code 底部 chrome、loop/proof 常驻轨、today 欢迎区与分阶段实施顺序。
- [登录与同步历史验收记录](test/test-login-sync.md)
  记录登录与同步能力进入实现阶段前应满足的验收条件。
- [Verification CLI 自动化测试计划](test/verification-cli-test-plan.md)
  记录 `verify`、`scan`、`guard`、TUI slash commands 和 `wukong_verify` 的核心测试、CLI smoke 和后续测试 TODO。

## 后续版本（已确认范围、未批准实施）

以下文档表达依赖顺序和产品边界，但尚未批准实施，也不代表已经开工或已经实现：

- [0.0.21 Isolated Loop Worktrees](design/0.0.21-isolated-loop-worktrees.md)
  候选：单个写入型 Loop 使用 exact snapshot、显式依赖 bootstrap 和独占 Git worktree；candidate 经 target-global fenced Promote 后必须在真实 workspace 再跑最终 Gate。worktree 是写入碰撞隔离，不是完整 sandbox。
- [0.1.0 Trusted Local Loop](design/0.1.0-trusted-local-loop.md)
  稳定里程碑：把 Finish Line、criteria/evidence、隔离 worktree、Promote 与 target Final Gate 收敛成可稳定推荐的 Free + BYOK 产品。条件目标最早 2026 年 11 月，取决于真实用户和 RC 门槛。
- [0.2.0 Pro Reliable Autonomy](design/0.2.0-pro-reliable-autonomy.md)
  商业候选：一个邀请制 `$12/月` 月付 Pilot，验证有界并行、本机 Supervisor 与可靠交付价值；未满足付款、复用、续费门槛前不开放 public Checkout。
  - [Bounded Parallel Loop 组件](design/0.2.0-bounded-parallel-loop.md)
  - [Local Loop Supervisor 组件](design/0.2.0-local-loop-supervisor.md)

版本只按以下顺序推进：

```text
可信验证
  → 单 Loop 隔离
  → 0.1.0 稳定发布
  → 0.2.0 有界并行 + 本机例外式监督 Pilot
```

每一版都必须在前置版本真实发布验收后重新批准实施；当前实施范围仍只到 0.0.20。0.1.0 继续免费，0.2.0 候选也不能对 Free 单 Loop 或 BYOK token 设置 quota。

## 当前最高优先级 TODO

任务级清单以 [../TODO.md](../TODO.md) 为准，本节只保留方向摘要：

1. 结清 0.0.19 的跨平台、真实多语言 Loop E2E、Kimi/Grok smoke 和五用户量化验证债务。
2. 实施 0.0.20 brokered reviewer、exact BYOK provider consent 和 existing-Skills criteria-only contract；不执行 Skill command。
3. 0.0.21、0.1.0、0.2.0 只维护已确认规格，不在前置版本验收前开工。
4. worktree 不能宣传成完整 sandbox，AgentSwarm 的 128 上限不能宣传成安全并行能力。
5. 0.1.0 是 Free Trusted Local Loop；0.2.0 是未批准的 Pro Reliable Autonomy 候选。旧 PR Gate + Billing 文档只作历史归档。
