# Wukong Code 文档索引

> 最后更新: 2026-07-08
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
| Time-based（本机迭代） | `/loop` | 已实现（核心 gate、max-iterations、`--every` cron scheduler pacing） |
| Time-based（本机巡检） | cron 工具（CronCreate 等） | 已实现（会话内 recurring/one-shot） |
| Time-based（云端） | `/schedule` | 待实现（归 hosted） |
| 工具层 | `/verify` `/scan` `/guard` | 已实现 |
| 证据层 | `/proof` | 已实现（Wow Moment） |
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
- [执行层 TODO](../TODO.md)
  按 ROADMAP milestone 拆解的任务清单，记录当前重点（Milestone 0.5）、暂缓项和已完成基线。

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

这些文档记录当前 P0 实现和后续计划。`verify`、`scan`、`guard` 已作为 top-level CLI 命令实现；`/verify`、`/scan`、`/guard`、`/report`、`/goal`、`/proof`、`/judge`、`/loop` 已作为 TUI slash commands 实现；`wukong_verify` agent tool 已接入 agent-core。Milestone 0.5 已按 `/proof` → `/judge` → `/goal` verification gate → `/loop` 的顺序完整落地，`/loop --every` 复用 agent-core cron scheduler 实现轮间 pacing。`/schedule`（云端例程）归 hosted。sync/today、云端报告、计费和团队能力仍是后续工作：

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

1. Milestone 0.5 已按 `/proof` → `/judge` → `/goal` verification gate → `/loop` 的顺序完整落地（`/loop` 为本机迭代 loop，复用 `/goal` 执行核与 agent-core cron scheduler 实现 `--every` 轮间 pacing，不新写定时引擎）。
2. 实现 report history / redaction metadata，避免未来云端报告上传源码 diff 或敏感片段。
3. 统一发布渠道、package version、安装文档和收费边界。
4. 实现 `wukong today`（P1）：先定 stats 事件 schema，再实现简报 + focus，见 [today 设计](design/today.md)；`sync` / `journey` 仍待本地数据模型与 redaction 边界。
5. 在文档站重新发布前，补齐实际页面或保持当前单层文档结构，不再链接不存在的 `/en/guides/*`、`/zh/guides/*`。
