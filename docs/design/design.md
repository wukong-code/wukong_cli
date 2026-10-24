# Wukong Code 产品设计文档

> Internal engineering record — kept in Chinese. English product docs: the user guide and release notes.

> 版本: v1.3
> 日期: 2026-07-16
> 状态: 目标设计文档，不代表所有命令已实现。

## 1. 设计基线

当前 `wukong_cli` 新 base 已经提供交互式终端 AI agent 能力。商业化设计的目标是在这个底座上加入验证、风险扫描、命令防护、交付证据，并用 `/loop`（本机）和 `/schedule`（云端）把它们编排成 AI Coding Loop 的控制层。

当前已实现的 top-level command 以 `wukong --help` 为准。`verify`、`scan`、`guard`、`proof`、`judge`、`loop` 已实现；TUI 也已实现 `/goal`、`/proof`、`/judge`、`/loop`、`/today`。`journey`、云端 `/schedule` 与团队能力仍是目标体验。

## 2. 产品定位

> **AI 负责写代码，Wukong 负责判断能不能合并。**
> Wukong 是 AI Coding Loop 的控制层与验证层（proof layer for AI-written code）。

设计重点不是虚拟宠物、情绪陪伴或泛聊天，而是：

- 让用户知道 AI 生成的代码是否真的通过检查。
- 让风险在提交前被看见。
- 让团队能复用规则和报告。
- 让终端中的高风险操作多一道确认。
- 用 `/loop`（本机迭代，关机即停）把"写 → 验 → 修"串成自动循环直到验证通过；定时巡检本机用 cron 工具，云端用 `/schedule`（例程，机器关了也跑）。把人从持续手动 prompt agent 的位置移出来。
- 用 `/proof` 产出可截图、可分享的 Merge Proof Report 作为 Wow Moment。
- 用 `/judge` 做只审不写的 evaluator，默认怀疑 AI 写的代码（deterministic 判定先行，`--agent` 第二-agent 审查后置）。

## 3. 信息架构

### 当前层

| 区域 | 已有能力 |
|---|---|
| TUI | 交互式 agent 会话、slash commands、审批、任务上下文；布局改造计划见 [tui-layout-loop-driven.md](tui-layout-loop-driven.md) |
| CLI | prompt mode、provider、login、doctor、server/web、ACP、export、vis、migrate |
| 配置 | `~/.wukong`、`config.toml`、provider 配置、credentials |

### 商业化目标层

| 区域 | 目标能力 |
|---|---|
| Verification | `verify`、report、命令检测、风险扫描 |
| Guard | shell hook、policy、确认/拦截、事件日志 |
| Agent Tool | `wukong_verify` structured result |
| Stats | verification streak、guard events、Loop outcomes |
| Team | shared rules、audit log、dashboard，P2 |

## 4. 命令体验

### P0 已实现命令

```bash
wukong verify
wukong verify --build
wukong verify --command "pnpm test"
wukong verify --report ./reports/evidence.md
wukong verify --json

wukong scan
wukong scan --diff
wukong scan --secrets
wukong scan --json

wukong guard --enable
wukong guard --disable
wukong guard --status
wukong guard --stats
wukong guard -- rm -rf ./tmp
```

TUI 内已实现 `/verify`、`/scan`、`/guard`、`/goal`（含队列管理）。

### P0.5 已实现命令（proof → judge → goal gate → loop）

```bash
# Merge Proof Report（Wow Moment，第 1 步）
wukong proof
/proof

# evaluator-only 判定（默认怀疑，第 2 步）
wukong judge --assume-broken
/judge

# goal verification gate（第 3 步，/loop 硬前置）
/goal "<目标>" --until verify-pass

# 本机迭代 loop（核心，第 4 步，关机即停）
wukong loop "fix all failing tests" --until verify-pass
wukong loop "<目标>" --until verify-pass --every 10m   # 可选节流：等 CI 等外部反馈
/loop "fix failing tests" until verify-pass

# 定时巡检不归 /loop：本机用 cron 工具（已实现），云端例程归 hosted
wukong schedule every hour "check feedback channel"    # Milestone 3+
```

### 设计原则

1. 默认离线可用。
2. 输出先给结论，再给证据。
3. 失败时说明具体命令、退出码和风险。
4. JSON 输出适合 agent/CI，Markdown report 适合人读。
5. Guard 必须明确 best-effort，不做不可绕过承诺。
6. `/loop` 的完成由统一 `proof-pass` gate 判断：deterministic proof 通过后，必须再经 fresh-context 只读 reviewer；写代码的 agent 不能自评通过。旧 `verify-pass`、`scan-clean`、`judge-pass` flag 和 Goal record 会兼容归一化。云端 `/schedule` 复用同一原则。
7. `/loop` 有 max-iterations 硬上限和单轮超时，人可随时 stop；核心语义是迭代直到验证通过，`--every` 是 Goal-owned、可取消的轮间节流；定时巡检本机归 cron 工具，跨机器持续性归 `/schedule`（hosted）。

## 5. 输出格式

### `verify` 摘要

```text
Wukong verification

Status: failed
Changed files: 8
Commands:
  passed  pnpm typecheck
  failed  pnpm test
Risks:
  high    placeholder text added in src/foo.ts
  medium  source changed without test changes
Report: ./wukong-verification-report.md
```

### `scan` 摘要

```text
Wukong risk scan

Status: warning
Changed files: 5
Risks:
  high    secret-looking value in .env.example
  medium  skipped test added in user.test.ts
```

### `guard` 确认

```text
Wukong guard

Risk: git reset --hard can discard local changes.
Source: interactive shell
Action: confirm

Continue? [y/N]
```

## 6. Wukong 能力体系

品牌能力、产品术语、权限不变量和商业分层统一以 Wukong 能力体系与商业化原则（已移至私有运营仓库） 为准。本文不再维护第二份能力映射。

设计摘要：

- 斗战到底 / 取经路对应围绕固定目标推进到终态的 Loop。
- 七十二变对应 Role 与 Custom Specialist；基础 Role 和完整分身必须区分。
- 身外身法对应拥有独立上下文、运行记录和能力边界的 Agent。
- 火眼金睛对应独立 Reviewer 与 Managed Gate，不等同于规则数量更多的扫描器。
- 筋斗云对应 Wukong 承担执行成本的后台、远程与云端能力。
- 定身法和金刚不坏对应 Gate enforcement、隔离、恢复与团队治理。
- 如意金箍棒对应工具与集成执行面。

“紧箍咒”是施加在悟空身上的外部约束，不作为悟空自身能力或官网主卖点；Auto/YOLO 也不代表付费后获得无限权限。

## 7. 成长体系与 `today`

成长体系依赖真实 verification 事件。`/today` 已作为 TUI 的**日维度入口**落地；top-level `wukong today` 尚未提供，详见 [today 设计](today.md)。

当前与后续可基于这些事件在 `today` 中展示：

- verification count（今日 / streak）。
- guard confirmed/blocked events。
- proof pass/blocked 与 last proof 摘要。
- goal / loop 进行中与完成数。

`today` focus 与 `/goal` 分工：focus 是今天的大方向；goal 是可执行任务 + 停止条件。

后续 `retro`（周）和 `journey`（长期趋势）是 `today` 在时间维度上的延伸。

不再使用 companion 时代指标，例如喂养次数、饥饿值、情绪日记、XP quests。

## 8. TUI 关系

商业化能力不必一开始做成复杂 TUI。P0 应先保证 top-level CLI 可用；TUI 可以随后增加：

- `/verify`: 调用当前 workspace verification。
- `/scan`: 展示风险摘要。
- `/guard status`: 展示 guard 安装状态。
- report pane: 打开最近报告。

## 9. 文案规范

可以使用悟空品牌语气，但技术结论必须清楚：

- 可以说“火眼金睛发现 3 个风险”。
- 必须同时列出规则、文件、严重度。
- 不说“绝对安全”。
- 不说“不可绕过”。
- 不把待实现命令写成 quickstart。

## 10. 设计 TODO

1. ~~在 agent tool 实现后补 structured result 样例。~~ 已完成。
2. `today` 命令契约与验收已写入 [today.md](today.md)；实现前需先定 stats 事件 schema。
3. 在云端方案确定后再设计 Pro/Team dashboard 与 focus sync。
4. 如果未来实现 shell profile 自动安装，再补 zsh/bash enable/disable 体验。
5. `journey` / badge 在 stats 与 `today` 稳定后再设计（P2）。
