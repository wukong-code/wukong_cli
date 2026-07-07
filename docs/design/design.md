# Wukong Code 产品设计文档

> 版本: v1.2
> 日期: 2026-07-07
> 状态: 目标设计文档，不代表所有命令已实现。

## 1. 设计基线

当前 `wukong_cli` 新 base 已经提供交互式终端 AI agent 能力。商业化设计的目标是在这个底座上加入验证、风险扫描、命令防护、交付证据，并把它们用 `/loop` 编排成 AI Coding Loop 的控制层。

当前已实现的 top-level command 以 `wukong --help` 为准。`verify`、`scan`、`guard`、`/goal` 已实现；`loop`、`proof`、`judge`、`journey`、`today`、云端报告仍是目标体验。

## 2. 产品定位

> **AI 负责写代码，Wukong 负责判断能不能合并。**
> Wukong 是 AI Coding Loop 的控制层与验证层（proof layer for AI-written code）。

设计重点不是虚拟宠物、情绪陪伴或泛聊天，而是：

- 让用户知道 AI 生成的代码是否真的通过检查。
- 让风险在提交前被看见。
- 让团队能复用规则和报告。
- 让终端中的高风险操作多一道确认。
- 用 `/loop` 把"写 → 验 → 修"串成自动循环，把人从持续手动 prompt agent 的位置移出来。
- 用 `/proof` 产出可截图、可分享的 Merge Proof Report 作为 Wow Moment。
- 用 `/judge` 做只审不写的 evaluator，默认怀疑 AI 写的代码。

## 3. 信息架构

### 当前层

| 区域 | 已有能力 |
|---|---|
| TUI | 交互式 agent 会话、slash commands、审批、任务上下文 |
| CLI | prompt mode、provider、login、doctor、server/web、ACP、export、vis、migrate |
| 配置 | `~/.wukong`、`config.toml`、provider 配置、credentials |

### 商业化目标层

| 区域 | 目标能力 |
|---|---|
| Verification | `verify`、report、命令检测、风险扫描 |
| Guard | shell hook、policy、确认/拦截、事件日志 |
| Agent Tool | `wukong_verify` structured result |
| Stats | verification streak、guard events、report history |
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

TUI 内已实现 `/verify`、`/scan`、`/guard`、`/report`、`/goal`（含队列管理）。

### P0.5 目标命令（待实现）

```bash
# 会话级 loop 编排（核心）
wukong loop "fix all failing tests" --until "verify-pass"
/loop "fix failing tests" until "tests pass and no high-risk findings"

# Merge Proof Report（Wow Moment）
wukong proof
/proof

# evaluator-only 审查（默认怀疑）
wukong judge --assume-broken
/judge
```

### 设计原则

1. 默认离线可用。
2. 输出先给结论，再给证据。
3. 失败时说明具体命令、退出码和风险。
4. JSON 输出适合 agent/CI，Markdown report 适合人读。
5. Guard 必须明确 best-effort，不做不可绕过承诺。
6. `/loop` 停止判断必须由 deterministic verification 决定，不能由写代码的 agent 自评。
7. `/loop` 有 max-iterations 上限和单轮超时，人可随时 stop；不做 cron/daemon 重形态。

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

## 6. 悟空能力映射

| 能力 | 产品表现 |
|---|---|
| 火眼金睛 | 风险扫描、diff 检查、secret-looking 检查 |
| 金箍棒 | 标准化验证执行和证据报告 |
| 紧箍咒 | 危险命令确认和策略约束 |
| 分身术 | agent/tool 调用 Wukong 验证 |
| 筋斗云 | 未来 cloud reports 和跨设备状态 |
| 七十二变 | 未来专家工作模式 |
| 取经路 | 未来 verification stats 和复盘 |

## 7. 成长体系

成长体系依赖真实事件，不应先于 verify/guard 落地。

P1 之后可基于这些事件计算：

- verification count。
- verification streak。
- guard confirmed/blocked events。
- zero-risk ship。
- report shared count。
- team rule adoption。

不再使用 companion 时代指标，例如喂养次数、饥饿值、情绪日记。

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

1. 在 agent tool 实现后补 structured result 样例。
2. 在 stats 语义稳定后再设计 `today`、`journey`、badge。
3. 在云端方案确定后再设计 Pro/Team dashboard。
4. 如果未来实现 shell profile 自动安装，再补 zsh/bash enable/disable 体验。
