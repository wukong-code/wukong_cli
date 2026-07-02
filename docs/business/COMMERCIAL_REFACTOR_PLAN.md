# Wukong CLI 商业化与产品重构方案

> 版本: v1.1
> 日期: 2026-07-02
> 当前范围: `wukong_cli` 新 Kimi-code base
> 技术落地: [商业化重构技术实现方案](../tech/commercial-refactor-implementation.md)

## 0. 当前事实

当前 `wukong_cli` 已经整体替换为 Kimi-code base。它有完整的 CLI/TUI/agent/provider/server/ACP 底座，但商业化核心命令还没有落到新 base。

当前 top-level CLI 已有：

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
wukong login
wukong doctor
wukong export
wukong vis
wukong migrate
wukong upgrade
```

当前 top-level CLI 尚未实现：

```text
wukong review
wukong test
wukong ship
wukong retro
wukong sync
wukong today
wukong journey
```

本文是商业与产品蓝图，不是当前功能完成声明。所有实现细节以技术方案和代码为准。

## 1. 产品定位

Wukong 的商业化方向是：

> AI 生成代码的验证与交付证据工具。

用户在 Claude Code、Cursor、Copilot、Codex 或其他 agent 生成代码后，用 Wukong 运行确定性检查、扫描风险、生成证据报告，再决定是否相信、提交或合并。

Wukong 不和代码 agent 比写代码速度，而是补上 agent 最薄弱的一环：

- 验证是否真的跑过。
- 识别 placeholder、mock、skipped test、secret-looking diff、危险命令等风险。
- 产出可被人和团队审计的交付证据。
- 在终端层约束 agent 的高风险操作。

## 2. 悟空能力映射

| 悟空能力 | 产品含义 | CLI 目标 |
|---|---|---|
| 火眼金睛 | 风险识别 | `scan`、risk rules、secret scan |
| 金箍棒 | 标准化验证执行 | `verify`、`test`、`ship`、report |
| 紧箍咒 | 权限约束 | `guard`、policy、command confirmation |
| 分身术 | agent 能力分发 | `wukong_verify` tool / MCP bridge |
| 筋斗云 | 远程/同步能力 | `sync`、cloud reports，P1+ |
| 七十二变 | 专家模式 | future prompt/tool profiles |
| 取经路 | 成长与复盘 | stats、streak、retro，P1+ |

## 3. 目标命令结构

### P0: 本地闭环

| 命令 | 状态 | 目标 |
|---|---|---|
| `wukong verify` | 已实现 | 运行确定性检查并生成本地证据报告 |
| `wukong scan` | 已实现 | 只读风险扫描，不运行项目命令 |
| `wukong guard` | 已实现 | 本地 guard 状态、统计和命令风险阻断 |
| `wukong_verify` tool | 待实现 | 让外部 agent 在完成前调用验证 |

### P1: 工作流扩展

| 命令 | 状态 | 目标 |
|---|---|---|
| `wukong review` | 待实现 | AI 辅助代码审查，消耗 credits 或本地模型 |
| `wukong test` | 待实现 | 项目测试入口和模板化测试策略 |
| `wukong ship` | 待实现 | 发布前验证、报告和 checklist |
| `wukong retro` | 待实现 | 生成迭代复盘和质量趋势 |

### P2: 云端与团队

| 能力 | 状态 | 目标 |
|---|---|---|
| cloud reports | 待实现 | 上传 metadata/redacted report，支持分享 |
| team rules | 待实现 | 团队共享验证规则和 guard policy |
| audit log | 待实现 | 记录验证、拦截和发布证据 |
| sync/today/journey | 待实现 | 基于真实 stats 做上下文和成长体系 |

## 4. 商业模型

商业化不应限制本地 `verify` 的基本使用。更合理的付费边界是云端协作、深度模型审查、报告托管、团队策略和审计。

| 层级 | 建议权益 |
|---|---|
| Free | 本地 verify/scan、本地报告、基础 guard |
| Pro | 深度 review、更多 report history、分享链接、增强 guard rules |
| Team | 共享规则、团队仪表盘、审计日志、组织模板 |
| Enterprise | 私有部署、合规、SSO、SLA、私有 runner |
| Credits | 深度模型审查、批量验证、托管报告额度 |

## 5. 实现优先级

### P0 已完成

1. `packages/verification` 独立核心包。
2. `wukong verify` CLI command。
3. `wukong scan` CLI command。
4. `wukong guard` CLI command，先做 best-effort interactive guard。
5. fixtures、unit tests、CLI smoke tests。

### 下一个 P0/P1 交界

1. `wukong_verify` agent/tool 集成。
2. TUI slash commands。
3. report history / redaction metadata。

### P0 不做

- 不做完整云端商业闭环。
- 不做 Team/Enterprise。
- 不做“不可绕过”的安全承诺。
- 不发布尚未存在的 install script、Homebrew formula 或旧包名。
- 不把 legacy `packages/cli` / `packages/mcp-server` 复制为长期架构。

## 6. Guard 产品口径

P0 `guard` 只能宣传为：

> 交互式终端风险确认层。

它可以通过 shell hook / alias / wrapper 提醒或确认 `rm -rf`、`git reset --hard`、`curl | sh` 等高风险命令，但不能宣传为“不可绕过”。用户仍可通过绝对路径、脚本、`command rm`、非交互 shell 或其他进程绕过。

更强的约束能力应放到 P1/P2：

- PATH shim。
- agent tool-policy 集成。
- sandbox runner。
- team policy。
- audit log。

## 7. 文档与发布原则

1. README 和用户指南只能写当前可执行命令。
2. 规划文档必须标注“待实现”。
3. 旧 companion/pet/mood 文档已删除，不再作为当前实现参考。
4. 发布前必须验证安装链接、包名、docs site 路由。
5. 对外 demo 必须基于真实命令，不用 placeholder script 模拟已发布功能。

## 8. 成功指标

P0 关注工程闭环，而不是收入：

| 指标 | 目标 |
|---|---|
| `wukong verify` 在真实 repo 中可跑通 | 是 |
| report 可被人读懂并定位失败原因 | 是 |
| high-risk diff 可稳定识别 | 是 |
| agent tool 可返回 structured result | 是 |
| CLI smoke test 覆盖主要参数 | 是 |

P1 之后再评估：

- report 分享率。
- Pro 转化。
- 团队规则使用率。
- guard 拦截事件数量。
- deep review credits 消耗。

## 9. 结论

Wukong 的可商业化内核已经有本地 CLI 闭环：deterministic verification、risk scan、best-effort guard。下一步应接 agent tool，再做云端报告、团队规则和计费。
