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
  已发布：只复用用户本机已有 Skill 的严格 qualitative criteria，并通过受限 evidence broker 与逐 run BYOK provider consent 复审；不执行 Skill command。
- [0.0.20 Release Notes](releases/0.0.20.md)
- [0.0.21 Loop Evidence Integrity](design/0.0.21-loop-evidence-integrity.md)
  发布候选：修复相同 risk kind 在不同文件、行或 evidence 位置时的 evidence identity 冲突；不新增命令、配置或平台专用能力。
- [0.0.21 Release Notes](releases/0.0.21.md)
- [已取消：0.0.21 Isolated Loop Worktrees](design/0.0.21-isolated-loop-worktrees.md)
  历史实验记录：不属于 0.0.21 或任何已承诺的后续版本。
- [0.1.0 Trusted Local Loop](design/0.1.0-trusted-local-loop.md)
  旧规格等待重新规划；当前只保留“稳定现有 Free 本地 Loop”的方向。
- [0.2.0 Pro Reliable Autonomy](design/0.2.0-pro-reliable-autonomy.md)
  旧规格等待重新规划；当前没有已批准技术方案、收费 SKU 或 Checkout。
- [历史候选：Pro PR Gate 与 Billing](design/historical-pro-pr-gate-billing.md)
  归档的 2026-07-20 单点 PR Gate 收费假设；已被新的 0.1.0 / 0.2.0 版本边界取代。
- [跨 Agent Session Resume](design/cross-agent-resume.md)
  当前 `/resume` 恢复 Wukong 会话，`/resume codex|claude|cursor|kimi|grok` 显式发现对应 Agent 的本地会话，并通过内置 Skill 只读导入后在 Wukong 中继续。
- [执行层 TODO](../TODO.md)
  按 ROADMAP milestone 拆解的任务清单，记录已完成基线、0.0.21 跨平台修复版与后续版本边界。

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

## 后续版本（等待重新规划）

隔离 worktree / Safe Promote 实验已经取消。依赖它的旧 0.1.0、0.2.0
文档只作历史研究，不代表已批准范围。当前只保留下列决策顺序：

```text
0.0.21 evidence-integrity 发布验收
  → 收集现有 Loop 的真实使用证据
  → 重新规划 0.1.0
  → 0.1.0 稳定后再决定是否需要 0.2.0
```

0.1.0 当前只保留稳定 Finish Line、criteria/evidence、durable lifecycle、
安装升级、恢复、跨平台与 public truth 的方向；不继承 Candidate Gate、Safe
Promote、lease/fencing 或 target Final Gate。0.2.0 没有已批准的技术方案、
收费 SKU 或 Checkout。Free 本地 Loop 与用户自己的 BYOK token 不设置
Wukong quota。

## 当前最高优先级 TODO

任务级清单以 [../TODO.md](../TODO.md) 为准，本节只保留方向摘要：

1. 完成 0.0.21 六平台 RC、公开 Release、fresh install 和 0.0.20 → 0.0.21 升级验收。
2. 结清 0.0.19/0.0.20 保留的真实项目与外部用户验证债务。
3. 在真实使用证据形成前，不实现或宣传 0.1.0、0.2.0 新执行架构。
4. 已取消的 worktree/Promote、旧 PR Gate/Billing 和并行/Supervisor 文档只作历史研究。
