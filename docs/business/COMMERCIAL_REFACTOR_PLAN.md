# Wukong CLI 商业化与产品重构方案

> 版本: v1.2
> 日期: 2026-07-03
> 当前范围: `wukong_cli` 新 Kimi-code base
> 技术落地: [商业化重构技术实现方案](../tech/commercial-refactor-implementation.md)

## 0. 当前事实

当前 `wukong_cli` 已经整体替换为 Kimi-code base。它有完整的 CLI/TUI/agent/provider/server/ACP 底座，并已经落地 P0 本地验证闭环。

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
| `wukong_verify` tool | 已实现 | 让外部 agent 在完成前调用验证 |
| `/verify`、`/scan`、`/guard`、`/report` | 已实现 | 让 TUI 会话内可运行验证、扫描、guard 状态和查看报告 |

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

商业化不应限制本地 `verify` 的基本使用。更合理的付费边界是云端协作、深度模型审查、报告托管、团队策略、审计和 Wukong 自有 API 服务。

核心收费原则：

```text
用户自带 API Key = 模型成本归用户
Wukong 收费 = 验证流程、报告托管、PR 协作、团队治理和审计证据
Wukong 托管模型调用 = 作为可选 credits / add-on 收费
```

| 层级 | 建议权益 |
|---|---|
| Free | BYOK、本地 verify/scan、本地报告、基础 guard |
| Pro | BYOK、hosted reports、report history、分享链接、增强 guard rules、可选 managed review credits |
| Team | org-level BYOK、GitHub PR comment/gate、共享规则、团队审计日志、组织模板 |
| Enterprise | 私有部署、合规、SSO、SLA、私有 runner |
| Credits / Add-on | Wukong 托管模型调用、深度 review、批量验证、托管报告额度 |

### 4.1 API Key 与 API 服务收费边界

Wukong 支持用户自带 API Key，但 BYOK 不代表所有功能都应免费。需要把模型调用成本和 Wukong 产品服务拆开。

| 模式 | 谁承担模型成本 | Wukong 可以收什么钱 | 推荐收费方式 |
|---|---|---|---|
| BYOK：用户自带 OpenAI/Anthropic/Gemini/DeepSeek 等 key | 用户 | 编排、redaction、hosted report、report history、PR comment/gate、team rules、audit log | Free 入口 + Pro/Team subscription |
| Wukong Managed Model：Wukong 提供托管模型调用 | Wukong | 深度 review、风险解释、修复建议、批量审查 | credits / usage add-on |
| Wukong Product APIs：Wukong 自有 API 服务 | Wukong | report upload/share、rules evaluate、PR gate、audit events、redaction、Slack/GitHub integration | subscription + quota + overage |

推荐的 API 服务边界：

| API 服务 | 是否适合收费 | 收费理由 |
|---|---|---|
| `/api/report/upload` | 是 | 托管 redacted report、存储、权限和分享链接 |
| `/api/report/share` | 是 | 对外展示、访问控制和长期留存 |
| `/api/pr/comment` | 是 | GitHub App 集成、PR 协作和自动评论 |
| `/api/pr/gate` | 是 | 合并前策略判断和状态检查 |
| `/api/rules/evaluate` | 是 | 团队规则、路径策略和风险阈值 |
| `/api/redact` | 是 | 上传前脱敏、敏感片段过滤和安全边界 |
| `/api/audit/events` | 是 | 团队审计、override 留痕和责任链 |
| 纯模型 proxy / 原样转发第三方 API | 不建议 | 容易变成低价值 API 转售，合规和信任风险高 |

收费示例：

```text
Free
- BYOK
- Local scan / verify / markdown report
- No hosted report history

Pro $8-12/user/month
- BYOK
- 100 hosted reports/month
- Report history and share links
- Optional managed review credits

Team $99-299/team/month or $15-29/user/month
- Org-level BYOK
- 500 PR checks/month
- GitHub App, PR comments, PR gates
- Team rules, audit log, shared reports
- Overage: $0.10-$0.30/check or report

Managed AI Add-on
- Wukong provides model calls
- Credit-based billing
- Example: $10 / 500 review credits
```

合规和信任边界：

1. 不把 Wukong 定位成第三方模型 API 的低价转售代理。
2. 如果 Wukong 代付模型成本，必须明确标注 managed model / credits / usage。
3. 如果用户 BYOK，Wukong 不应对用户自己的 token 用量再按 token 加价。
4. 默认只上传 metadata / redacted report，不上传完整源码 diff。
5. 用户 key、org-level key 和 Wukong managed key 必须隔离存储、隔离审计。
6. Team/Enterprise 应提供私有 runner 或 self-hosted 方案，降低源码和密钥出域顾虑。

### 4.2 不建议收费的基础能力

这些能力应作为免费入口，负责证明产品价值和扩大使用面：

| 能力 | 原因 |
|---|---|
| 基础 `wukong verify` | 本地确定性验证是核心入口，收费会降低试用率 |
| 基础 `wukong scan` | 只读风险扫描适合作为日常默认动作 |
| 基础 `wukong guard` / `guard --status` | P0 guard 是 best-effort，不能作为强安全付费承诺 |
| 本地 Markdown report | 本地证据报告应作为免费闭环的一部分 |
| provider/login/doctor/export | 属于基础 CLI 使用、诊断和迁移能力 |

### 4.3 适合收费的功能

付费点应建立在“团队协作、云端证据、模型成本、审计责任”上，而不是限制本地基础命令。

| 收费功能 | 推荐层级 | 价值 | 当前状态 |
|---|---|---|---|
| Hosted Reports / 分享链接 | Pro / Team | 上传 redacted report，生成可分享链接，保留历史记录 | 待实现 |
| Deep Review Credits | Pro / Credits | 用模型做深度代码审查、风险解释和修复建议 | 待实现 |
| Wukong Product APIs | Pro / Team | report upload/share、PR comment/gate、rules evaluate、redaction、audit events | 待实现 |
| Managed Model Add-on | Pro / Team / Credits | Wukong 提供托管模型调用，解决用户不想配置 key 的场景 | 待实现 |
| Team Rules | Team | 团队统一验证命令、风险阈值、路径策略和 guard policy | 待实现 |
| GitHub PR Gate / CI Gate | Team | PR 自动跑 verify/scan，发布检查状态和 report link | 待实现 |
| Audit Log | Team / Enterprise | 记录谁验证、谁 override、失败原因和最终交付证据 | 待实现 |
| Agent Enforcement | Team | 要求 agent 完成前必须调用 `wukong_verify`，否则标记未完成 | 部分实现：tool 已有，策略层待实现 |
| Enhanced Guard Policy | Pro / Team | shell hook、PATH shim、集中规则、危险命令审计 | 待实现 |
| Report History / Quality Trend | Pro / Team | 项目质量趋势、失败率、placeholder/mock/skipped test 趋势 | 待实现 |
| Private Runner / 私有部署 | Enterprise | 私有网络内运行验证、保留源码不出域 | 待实现 |
| SSO / 合规 / SLA | Enterprise | 企业采购和合规要求 | 待实现 |

### 4.4 收费优先级

建议按以下顺序推进：

1. Hosted Reports：最接近当前本地 report，付费价值直接。
2. Wukong Product APIs：把 hosted report、PR comment/gate、rules、audit 变成可计费服务边界。
3. Team Rules + PR Gate：把个人工具变成团队流程。
4. Deep Review Credits / Managed Model Add-on：把模型成本和增值能力对应起来，但不要早于报告和 PR 工作流。
5. Audit Log：服务团队负责人和企业合规场景。

当前阶段适合做 **付费试点 / design partner**，不适合直接做公开自助订阅。公开收费前至少需要完成 hosted report、billing entitlement、发布安装路径和团队/个人套餐边界。

## 5. 实现优先级

### P0 已完成

1. `packages/verification` 独立核心包。
2. `wukong verify` CLI command。
3. `wukong scan` CLI command。
4. `wukong guard` CLI command，先做 best-effort interactive guard。
5. `wukong_verify` builtin agent tool。
6. TUI slash commands: `/verify`、`/scan`、`/guard`、`/report`。
7. fixtures、unit tests、CLI/TUI/tool smoke tests。

### 下一个 P0/P1 交界

1. report history / redaction metadata。
2. cloud report metadata upload。
3. hosted report quota / billing boundary。

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
| TUI 会话内可运行验证/扫描并查看报告 | 是 |
| CLI smoke test 覆盖主要参数 | 是 |

P1 之后再评估：

- report 分享率。
- Pro 转化。
- 团队规则使用率。
- guard 拦截事件数量。
- deep review credits 消耗。

## 9. 结论

Wukong 的可商业化内核已经有本地 CLI/TUI/agent 闭环：deterministic verification、risk scan、best-effort guard、report 和 `wukong_verify`。下一步应做 hosted reports、redaction/report history、团队规则和计费边界，把本地验证价值转成可收费的协作与审计能力。
