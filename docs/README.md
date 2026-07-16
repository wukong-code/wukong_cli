# Wukong Code 文档索引

> 最后更新: 2026-07-16
> 当前事实基线: `wukong_cli` 内部实现仓库，产品名称为 **Wukong Code**
> 状态说明: 本目录区分 **当前已实现** 与 **商业化后续待实现**。

## 产品定位

> **AI 负责写代码，Wukong 负责判断能不能合并。**
> Wukong Code 是 AI Coding Loop 的控制层与验证层（proof layer for AI-written code）。

命令分层对应 loop engineering：

| 层 | 命令 | 状态 |
|---|---|---|
| Turn-based | TUI 默认 | 已实现 |
| Goal-based | `/goal` | 已实现（verification gate 已实现，归 M0.5） |
| 本机迭代 | `/loop` / `wukong loop` | 已实现（proof-pass、fresh reviewer、max-iterations、`--every` pacing） |
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
  记录从本地验证闭环到 loop 控制层、hosted reports、Pro Preview、PR gate、Team Pilot 的交付顺序和验收标准。
- [0.0.12 Trust Loop v2](design/verification-loop-v2.md)
- [0.0.12 Goal 与 flags 兼容矩阵](design/0.0.12-compatibility.md)
- [0.0.12 release notes / What's Changed](releases/0.0.12.md)
  定义 Loop-first 状态机、独立 reviewer、Loop session 额度、Role Profiles，以及 verify/scan/proof 的内部层与兼容边界。
- [0.0.13 Review Learning Loop](design/review-learning-loop.md)
  定义多 finding Review Contract、项目 review policy、受控验证、人工反馈、本地 eval，以及只生成提案且必须人工批准的外层 improver。
- [执行层 TODO](../TODO.md)
  按 ROADMAP milestone 拆解的任务清单，记录当前重点（0.0.13 Review Learning Loop）、暂缓项和已完成基线。

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
wukong login
wukong doctor
wukong export
wukong vis
wukong migrate
wukong upgrade
```

其中 `acp`、`server`、`migrate` 当前为 hidden 命令，不出现在 `wukong --help` 默认输出中，此处列出仅为完整性。

## 商业化文档

这些文档记录当前 P0/P0.5 实现和后续计划。`verify`、`scan`、`guard`、`proof`、`judge`、`loop` 已作为 top-level CLI 命令实现；`/verify`、`/scan`、`/guard`、`/report`、`/goal`、`/proof`、`/judge`、`/loop`、`/today` 已作为 TUI slash commands 实现；`wukong_verify` agent tool 已接入 agent-core。Milestone 0.5 已按 `/proof` → `/judge` → `/goal` verification gate → `/loop` 的顺序完整落地，`/loop --every` 复用 agent-core cron scheduler 实现轮间 pacing。Hosted report v1 已支持登录上传、历史和分享；后续工作是 `/schedule`、sync、Hosted Evidence v2、完整计费与团队能力：

- [商业化与产品重构方案](business/COMMERCIAL_REFACTOR_PLAN.md)
  定义产品定位、商业模型、目标命令结构（含 loop/proof/judge/schedule）和路线图。
- [商业化重构技术实现方案](tech/commercial-refactor-implementation.md)
  定义 `@wukong/verification`、`wukong verify`、`wukong scan`、`wukong guard`、agent tool 以及 `/proof`、`/judge`、`/goal` verification gate、`/loop`、`/schedule` 的实现方案。
- [最新技术架构](tech/architecture.md)
  定义当前新 Kimi-code base 与 P0 verification/guard 架构。
- [产品设计文档](design/design.md)
  定义未来验证型产品的交互、成长体系和命令设计。
- [today 命令设计](design/today.md)
  定义 `wukong today` / `/today`：Daily Proof Briefing（今日简报 + focus 合并）。
- [TUI 布局改造计划（Loop 驱动）](design/tui-layout-loop-driven.md)
  定义 TUI 对齐 Claude Code 底部 chrome、loop/proof 常驻轨、today 欢迎区与分阶段实施顺序。
- [登录与同步验收计划](test/test-login-sync.md)
  记录登录与同步能力进入实现阶段前应满足的验收条件。
- [Verification CLI 自动化测试计划](test/verification-cli-test-plan.md)
  记录 `verify`、`scan`、`guard`、TUI slash commands 和 `wukong_verify` 的核心测试、CLI smoke 和后续测试 TODO。

## 当前最高优先级 TODO

任务级清单以 [../TODO.md](../TODO.md) 为准，本节只保留方向摘要：

1. 0.0.12 Loop-first 已发布；继续保持 PASS/NEEDS_WORK/ERROR 和 deterministic checks + fresh reviewer 的内层交付闭环。
2. 0.0.13 增加 Review Learning Loop：结构化 findings、项目 policy、人工 feedback、基础 eval 和安全的 policy proposal。
3. Reviewer 不直接获得任意 Bash；验证请求复用现有 check runner，Improver 不自动修改 active policy 或 skill。
4. 0.0.13 不做支付，Pro/Team 保持 `Coming Soon`；真实价格、Checkout、Billing 生命周期、GitHub PR adapter 和团队 policy 统一延后到 0.1.0+。
