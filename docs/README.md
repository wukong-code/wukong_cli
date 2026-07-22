# Wukong Code 文档索引

> 最后更新: 2026-07-22
> 当前事实基线: `wukong_cli` 内部实现仓库，产品名称为 **Wukong Code**
> 状态说明: 本目录区分 **当前已实现** 与 **商业化后续待实现**。

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
| Time-based（云端） | `/schedule` | 待实现（归 hosted） |
| Loop 内部检查层 | `/verify` `/scan` `/proof` | 已实现；直接调用仅用于高级诊断 |
| 评估层 | `/judge` | 已实现（deterministic 先行，`--agent` 后置） |

## 当前已实现

这些文档可以作为当前 Wukong Code 的事实来源：

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
  定义 durable Loop lifecycle、completion outbox、重启恢复、preflight、首次成功 UX、隐私指标与 0.1.0 商业决策门槛。
- [0.0.16 Loop Convergence](design/0.0.16-loop-convergence.md)
  定义固定验收合同、prior blockers、anti-ratchet reviewer、无进展检测、一次性 strategist、reviewer model fallback、Permission Mode v2、只读分身 capability ceiling、Resume 建议、Role contract、统一任务状态与本地 session 内容搜索。
- [0.0.16 Release Notes](releases/0.0.16.md)
  记录正式版能力、兼容边界、验证结果和发布验收标准。
- [0.0.17 Command Surface Reliability](design/0.0.17-command-surface-reliability.md)
  定义 CLI/TUI 命令契约收口：删除误导入口、保留可发现的 `/transform`、未知 slash 本地拦截、严格参数解析与四层自动化回归；已于 2026-07-22 发布。
- [0.0.18 Loop-First Simplification](design/0.0.18-loop-first-simplification.md)
  当前已批准规划：默认命令面只突出 Resume → Loop → Gate，其他命令实现隐藏但不删除；`/resume` 增加 Kimi Code/Grok；`/feedback` 改为无需登录的纯文本 Web API；`/login` 由 CLI 发起并在 Wukong 网站确认，当前模型目录允许为空，托管模型与推理后续再上线。
- [0.1.0 Pro PR Gate 与 Billing](design/0.1.0-pro-pr-gate.md)
  历史商业化候选，定义过 Free 本地 BYOK 边界与 PR Gate/Billing 验证门槛；当前没有付费计划、Checkout 或 entitlement 实施，不能把该文档当作版本承诺。
- [跨 Agent Session Resume](design/cross-agent-resume.md)
  当前 `/resume` 恢复 Wukong 会话，`/resume codex|claude|cursor|kimi|grok` 显式发现对应 Agent 的本地会话，并通过内置 Skill 只读导入后在 Wukong 中继续。
- [执行层 TODO](../TODO.md)
  按 ROADMAP milestone 拆解的任务清单，记录当前开发版本（0.0.18 Loop-First Simplification）、后续商业实验、暂缓项和已完成基线。

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

## 商业化文档

这些文档记录当前 P0/P0.5 实现和后续计划。`verify`、`scan`、`guard`、`proof`、`judge`、`loop` 已作为 top-level CLI 命令实现；`/verify`、`/scan`、`/guard`、`/goal`、`/proof`、`/judge`、`/loop`、`/today` 已作为 TUI slash commands 实现；`wukong_verify` agent tool 已接入 agent-core。Milestone 0.5 已按 `/proof` → `/judge` → `/goal` verification gate → `/loop` 的顺序完整落地，`/loop --every` 由 Goal driver 执行可取消的轮间等待，不创建脱离 Goal 生命周期的 cron task。后续工作是 `/schedule`、sync、完整计费与团队能力：

- [商业化与产品重构方案](business/COMMERCIAL_REFACTOR_PLAN.md)
  定义产品定位、商业模型、目标命令结构（含 loop/proof/judge/schedule）和路线图。
- [Wukong 能力体系与商业化原则](business/WUKONG_CAPABILITY_MODEL.md)
  定义斗战、七十二变、身外身、火眼金睛、筋斗云、定身、金刚不坏和金箍棒对应的产品能力，并约束 Role / Specialist / Managed Gate、权限不变量和未来商业分层。
- [商业化重构技术实现方案](tech/commercial-refactor-implementation.md)
  定义 `@wukong/verification`、`wukong verify`、`wukong scan`、`wukong guard`、agent tool 以及 `/proof`、`/judge`、`/goal` verification gate、`/loop`、`/schedule` 的实现方案。
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

## 已确认但未排期的方向

以下文档只记录已经确认的产品方向和实现边界，不属于任何已排版本，也不代表当前已经实现：

## 当前最高优先级 TODO

任务级清单以 [../TODO.md](../TODO.md) 为准，本节只保留方向摘要：

1. 0.0.12 Loop-first 已发布；继续保持 PASS/NEEDS_WORK/ERROR 和 deterministic checks + fresh reviewer 的内层交付闭环。
2. 0.0.13 第一批实现结构化 findings、项目 policy、人工 feedback 和独立 reviewer model。
3. Reviewer 不直接获得任意 Bash；额外检查只作为 next action 建议，不动态执行。
4. 0.1.0 尚未定义；旧 Pro PR Gate + Billing 文档只作历史候选，当前不实施付费、Checkout、entitlement 或 PR publish。
