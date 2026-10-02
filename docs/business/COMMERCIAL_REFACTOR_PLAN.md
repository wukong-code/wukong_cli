# Wukong Code 商业化与产品重构方案

> 状态：**SUPERSEDED HISTORICAL PLAN**。本文保留 2026-07-20 的旧额度与 PR Gate 收费假设，不是当前 roadmap、TODO 或实现依据。
> 当前版本边界（2026-10-02 核对）：0.1.x 继续 Free（stable 0.1.1）；0.2.0 是 Codebase Reduction；收费与协作候选只在 0.3.0 Evidence-gated Collaboration Pilot 取得付费证据后研究，见仓库根 `ROADMAP.md`。文中引用的 [0.2.0 Pro Reliable Autonomy](../design/0.2.0-pro-reliable-autonomy.md) 本身也已取代。
>
> 阅读指引：§3 的 P0 本地闭环与 P0.5 Loop 控制层、§3.1 三层叙事、§5 的“已完成”项和 §6 Guard 口径描述的是已实现能力，仍然成立；§4 的 Loop 额度与 PR Gate 收费、§5 的“当前重点：0.0.12”属于 2026-07-20 时点，Loop 额度已于 0.0.17 删除。
>
> 版本: v1.5
> 日期: 2026-07-20
> 当前范围: `wukong_cli` 新 Kimi-code base
> 技术落地: [商业化重构技术实现方案](../tech/commercial-refactor-implementation.md)
> 长期产品原则: [Wukong 能力体系与商业化原则](WUKONG_CAPABILITY_MODEL.md)

## 0. 当前事实

当前 `wukong_cli` 已经整体替换为 Kimi-code base。它有完整的 CLI/TUI/agent/provider/server/ACP 底座，并已经落地 P0 本地验证闭环与 `/goal` 持续修复。

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

其中 `acp`、`server`、`migrate` 当前为 hidden 命令，不出现在 `wukong --help` 默认输出中；对外命令面以 `wukong --help` 为准。

已实现的 TUI slash commands 包括 `/verify`、`/scan`、`/guard`、`/goal`（含 verification gate 和队列）、`/proof`、`/judge`、`/loop`、`/today`。agent-core 另有独立的会话内 cron 调度工具（CronCreate/CronList/CronDelete，支持 recurring/one-shot、持久化与 resume 恢复）；Loop 的 `--every` 属于 Goal 生命周期，不使用 cron task。

当前仍未实现的 top-level CLI 扩展是：

```text
wukong schedule  # 云端例程（归 hosted，Milestone 3+）
wukong ship      # 发布 gate（更靠后）
wukong review    # AI 辅助代码审查（P1）
wukong test      # 项目测试入口（P1）
wukong retro     # 迭代复盘（P1）
wukong sync
wukong journey
```

本文是商业与产品蓝图，不是当前功能完成声明。所有实现细节以技术方案和代码为准。

## 1. 产品定位

Wukong 的商业化方向是：

> **The proof layer for AI-written code — AI Coding Loop 的控制层与验证层。**

Wukong 不和 Claude Code / Cursor / Codex 拼写代码速度，而是补上 AI 写完代码后最薄弱的一环：**这段代码能不能合并**。一句话定位：

> AI can write the code. Wukong proves whether it should ship.

产品围绕 Loop Engineering 组织。参考 Claude Code 的 loop 分类（按"怎么触发 / 怎么停止"两个维度），Wukong 覆盖同样的 loop 谱系：

| Loop 类型 | 触发 | 停止 | Wukong 命令 | 状态 |
|---|---|---|---|---|
| Turn-based | 用户 prompt | agent 自判完成 | TUI 默认 agentic loop | 已实现 |
| Goal-based | 实时手动 | verification gate + 回合/预算上限 | `/goal` | 已实现 |
| Time-based（本机） | 手动启动，轮次自动衔接（`--every` 可选节流） | proof/reviewer gate 通过 or 迭代上限 or 取消 | `wukong loop` / TUI `/loop` | 已实现 |
| Time-based（云端） | 计划 | 任务达标退出，例程持续 | `/schedule` | 待实现（归 hosted） |
| 工具层 | 手动/被 loop 调用 | 单次 | `/verify` `/scan` `/guard` | 已实现 |
| 证据层 | 手动 | 单次 | `/proof` | 已实现 |
| 评估层 | 手动/被 loop 调用 | 单次 | `/judge` | deterministic 模式已实现 |

`/loop` 的核心语义是**迭代直到验证通过**（关机即停）：轮次自动衔接，`--every` 是 Goal-owned、可取消的轮间节流。定时巡检型任务本机由 cron 工具承载，云端归 `/schedule`（hosted，Milestone 3+）。0.0.12 的 `/goal` 出口已经统一为 `proof-pass`：先运行 deterministic checks，再由 fresh-context 只读 reviewer 判定，写代码的 agent 不能自判通过。

用户在 Claude Code、Cursor、Copilot、Codex 或其他 agent 生成代码后，用 Wukong 运行确定性检查、扫描风险、生成证据报告，再决定是否相信、提交或合并。Wukong 补上 agent 最薄弱的一环：

- 验证是否真的跑过。
- 识别 placeholder、mock、skipped test、secret-looking diff、危险命令等风险。
- 产出可被人和团队审计的交付证据（Merge Proof）。
- 在终端层约束 agent 的高风险操作。
- 用 `/loop`（本机）和 `/schedule`（云端）把"写 → 验 → 修"串成自动循环，把人从持续 prompt agent 的位置移出来。

## 2. Wukong 能力体系

长期能力、权限和商业化边界以 [Wukong 能力体系与商业化原则](WUKONG_CAPABILITY_MODEL.md) 为单点真相源。本方案只保留执行摘要：

```text
Loop 是产品主流程
分身是 Loop 的执行结构
火眼金睛与 Gate 是可信结论
Policy 与 Audit 是团队付费价值
```

| 悟空能力 | 产品含义 | 当前商业判断 |
|---|---|---|
| 斗战到底 / 取经路 | 围绕固定目标持续写、查、审、修到明确终态 | 完整本地 Loop 是 Free 核心入口 |
| 七十二变 | Role、模型、工具与输出契约的任务化切换 | 基础 Role 免费；完整 Custom Specialist 是 Pro 候选 |
| 身外身法 / 毫毛分身 | 独立上下文的 Explorer、Coder、Reviewer、Strategist | 内置分身免费；托管并行和高级编排可收费 |
| 火眼金睛 | 独立 Reviewer 识别伪通过、遗漏和隐藏风险 | Managed Gate 的首要付费候选 |
| 筋斗云 | 后台、远程、跨设备和云端执行 | Wukong 承担执行成本时可作为 Pro 能力 |
| 定身法 | 阻断危险操作、不合格 Gate 和高风险合并 | Team policy / required Gate |
| 金刚不坏 | Sandbox、worktree 隔离、失败恢复和 durable state | Team / Enterprise 可靠性能力 |
| 如意金箍棒 | 工具、MCP、GitHub、CI 与项目命令执行面 | 基础工具免费；组织级治理和集成可收费 |

“紧箍咒”不是孙悟空自身神通，只能作为内部理解外部约束的隐喻；Auto/YOLO 也不能被包装为付费后获得无限权限。高级 entitlement 解锁的是模型、编排、托管执行和团队治理，不是绕过系统安全上限。

## 3. 目标命令结构

### P0: 本地闭环（已完成）

| 命令 | 状态 | 目标 |
|---|---|---|
| `wukong verify` | 已实现 | 运行确定性检查并生成本地证据报告 |
| `wukong scan` | 已实现 | 只读风险扫描，不运行项目命令 |
| `wukong guard` | 已实现 | 本地 guard 状态、统计和命令风险阻断 |
| `wukong_verify` tool | 已实现 | 让外部 agent 在完成前调用验证 |
| `/verify`、`/scan`、`/guard` | 已实现 | TUI 会话内运行验证、扫描和查看 guard 状态 |
| `/goal` | 已实现 | 单任务跑到验证条件满足，含队列管理 |

### P0.5: Loop 控制层 + Merge Proof（已完成）

实施顺序固定为 proof → judge → goal gate → loop：

| 命令 | 状态 | 目标 |
|---|---|---|
| `wukong proof` / `/proof` | 已实现 | 把 verify+scan+report 串成 Merge Proof Report；Loop 内作为统一 gate 的 deterministic 前置 |
| `wukong judge` / `/judge` | 已实现 | evaluator-only deterministic 判定；Loop gate 另接 fresh-context 只读 reviewer |
| `/goal` verification gate | 已实现 | proof checks + fresh-context 只读 reviewer；写代码的 agent 不能自判通过 |
| `wukong loop` / `/loop` | 已实现（核心） | 本机迭代 loop：驱动 agent + 验证 + 修复直到 gate 通过；复用 scheduler，关机即停 |

### P1: 工作流扩展

| 命令 | 状态 | 目标 |
|---|---|---|
| `wukong today` | top-level CLI 已实现；TUI `/today` 未注册 | **Local Loop Briefing**：今日 verify/scan/proof/guard 统计 + focus + 基于状态的 Next。详见 [today 设计](../design/today.md) |
| `wukong review` | 待实现 | AI 辅助代码审查，消耗 credits 或本地模型 |
| `wukong test` | 待实现 | 项目测试入口和模板化测试策略 |
| `wukong ship` | 待实现 | proof + 版本/changelog/dry-run 发布前 gate |
| `wukong retro` | 待实现 | 生成迭代复盘和质量趋势（周维度，依赖 stats） |

### P2: 云端与团队

| 能力 | 状态 | 目标 |
|---|---|---|
| team rules | 待实现 | 团队共享验证规则和 guard policy |
| audit log | 待实现 | 记录验证、拦截和发布证据 |
| `/schedule` 云端例程 | 待实现 | 机器关了也跑的 time-based loop，归 hosted（Milestone 3+） |
| `sync` | 待实现 | 与 wukong.today 同步 config / report metadata（不上传源码 diff） |
| `journey` | 待实现 | 长期 verification 趋势与 streak 可视化（月维度，P2） |

## 3.1 Loop Engineering 三层叙事（如实标注状态）

参考 Andrew Ng 的三层 loop 框架，Wukong 的对应关系与真实状态如下。对外叙事可用，但未实现的层不得宣称已可用：

| 层 | 含义 | Wukong 对应 | 状态 |
|---|---|---|---|
| 第一层：Agentic Coding Loop | agent 写代码 → 跑测试 → 修错 → 再跑 | `wukong loop` / `/loop`（本机）+ `/goal` + 内部 checks | 本机 top-level/TUI 均已实现；云端 `/schedule` 待实现 |
| 第二层：Developer Feedback Loop | 人看报告、决定接受、更新规则 | `/proof`、`/judge`、`/resume`、`/undo`、`/rules`(待实现)；briefing 使用 `wukong today` | 本地证据与 top-level briefing 已实现；共享 rules 待实现 |
| 第三层：External Feedback Loop | 用户 bug、CI 失败、issue、PR review 回到 loop | GitHub Issues、CI、Sentry、Linear、Slack 集成 | 未实现，归 hosted/CI |

## 3.2 Loop 代码质量保障原则

借鉴 Claude Code 的 loop 设计经验，loop 输出质量取决于围绕它的系统。设计 loop（`/goal`、`/loop`、`/schedule`）时遵循：

1. **保持代码库整洁**：agent 遵循 codebase 已有的模式和约定。
2. **给 agent 自验证能力**：用 deterministic verification（`verify`/`scan`）和自定义验证 skill 编码"什么叫好"；检查越定量越有效。
3. **文档可达**：框架/库文档保持最新最佳实践。
4. **用第二 agent 做审查**：Loop 的 `proof-pass` gate 已在 deterministic proof 通过后启动 fresh-context 只读 reviewer，降低写代码 agent 的自评偏见；standalone `/judge` 仍保持 deterministic evaluator，不混淆两者。

## 4. 商业模型

Free 用受额度跟踪的完整本地 BYOK Loop 验证完成和重复使用。`verify`、`scan`、`proof` 是 Loop 内部能力和高级诊断入口，不分别售卖、不单独计费。0.1.0 的第一个收费假设是 PR Gate publish；更高 Loop allowance 只是次要 capability，团队策略、审计和 managed model 继续后移。

核心收费原则：

```text
用户自带 API Key = 模型成本归用户
0.1.0 Wukong 收费 = PR Gate comment/status publish
以后才验证 = 团队角色、共享策略、审计和 managed model
```

| 层级 | 建议权益 |
|---|---|
| Free | BYOK、10 Loop sessions/月、每次最多 5 轮、基础 roles/guard；第 3 次起提示 Pro |
| Pro | BYOK、PR Gate publish；更高 Loop allowance 为次要权益 |
| Team（后续） | org-level BYOK、共享 Role Profiles、组织 PR gate、团队规则和审计日志 |
| Enterprise | 私有部署、合规、SSO、SLA、私有 runner |
| Credits / Add-on（后续候选） | Wukong 托管模型调用、深度 review、批量验证 |

### 4.1 API Key 与 API 服务收费边界

Wukong 支持用户自带 API Key，但 BYOK 不代表所有功能都应免费。需要把模型调用成本和 Wukong 产品服务拆开。

| 模式 | 谁承担模型成本 | Wukong 可以收什么钱 | 推荐收费方式 |
|---|---|---|---|
| BYOK：用户自带 OpenAI/Anthropic/Gemini/DeepSeek 等 key | 用户 | 编排、review policy、PR comment/gate、team rules、audit log | Free 入口 + Pro/Team subscription |
| Wukong Managed Model：Wukong 提供托管模型调用 | Wukong | 深度 review、风险解释、修复建议、批量审查 | credits / usage add-on |
| Wukong Product APIs：Wukong 自有 API 服务 | Wukong | Loop quota、rules evaluate、PR gate、audit events、Slack/GitHub integration | subscription + quota + overage |

推荐的 API 服务边界：

| API 服务 | 是否适合收费 | 收费理由 |
|---|---|---|
| `/api/pr/comment` | 是 | GitHub App 集成、PR 协作和自动评论 |
| `/api/pr/gate` | 是 | 合并前策略判断和状态检查 |
| `/api/rules/evaluate` | 是 | 团队规则、路径策略和风险阈值 |
| `/api/audit/events` | 是 | 团队审计、override 留痕和责任链 |
| 纯模型 proxy / 原样转发第三方 API | 不建议 | 容易变成低价值 API 转售，合规和信任风险高 |

收费示例：

```text
Free
- BYOK
- 10 Loop sessions/month, max 5 iterations/session; show a Pro prompt from session 3
- Advanced verify/scan/proof diagnostics remain available without a separate quota
- Fresh-context reviewer with a configured alias
- Evidence is saved locally only when requested

Pro $8-12/user/month
- BYOK
- 0.1.0 candidate: $9/month invite-only experiment
- Publish/update redacted Gate summary and commit status on GitHub PR
- Higher server-configured Loop allowance is secondary, not the purchase reason
- No managed reviewer credits in 0.1.0

Team $99-299/team/month or $15-29/user/month
- Org-level BYOK
- 500 PR checks/month
- GitHub App, PR comments, PR gates
- Shared Role Profiles, team rules, audit log
- Overage: $0.10-$0.30/check or managed review unit

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

### 4.2 免费基础层与用量限制

Loop 必须提供真实免费体验，但额度只作用于顶层 session，不能让用户理解多套计数规则。完整计数规则见 [0.0.12 Trust Loop v2](../design/verification-loop-v2.md)。

| 能力 | Free 初始额度 | 计数边界 |
|---|---|---|
| Loop sessions | 10 sessions/月，每个最多 5 轮；第 3 次起软提示 Pro | 一次 session 计一次；所有内部检查与 reviewer 不重复计数 |
| 高级 verify/scan/proof | 不限制 | 兼容 CI/debug，不作为默认产品入口或付费点 |
| BYOK reviewer | 包含在 Loop 中 | 不增加另一套 AI credits；provider token 由用户承担 |
| 本地 review policy / feedback / 基础 eval | 不限制 | 免费层必须能积累真实反馈并验证 reviewer 价值；默认只保存在本地 |
| 基础 `wukong guard` / `guard --status` | 暂不限制 | P0 guard 是 best-effort，不能作为强安全付费承诺 |
| provider/login/doctor/export | 暂不限制 | 属于基础 CLI 使用、诊断和迁移能力 |

未登录用户可运行 1 个最多 2 轮的 Loop。免费额度必须足以产生第一次真实结果，但不能长期替代 Pro。参数校验和 plan 建立在 usage start 前完成；start 成功后即计数，取消或崩溃不回退。默认不生成报告，只有显式 `--save`/`--report` 才在本地保存 evidence。

### 4.3 适合收费的功能

付费点建立在本地 Loop 之外的工作流结果上。基础 BYOK Loop、reviewer 和高级诊断保持 Free；0.1.0 不把已发布的本地能力重新包装成付费功能。

| 收费功能 | 推荐层级 | 价值 | 当前状态 |
|---|---|---|---|
| GitHub PR Gate publish | Pro | 将本地 Gate summary/comment 和 commit status 写回现有 PR，减少手工整理和同步 | 0.1.0 计划，首个付费假设 |
| 更多 Loop iterations | Pro 次要权益 | 给重度用户更高的服务端 tracked allowance；不是主要购买理由 | 0.1.0 可配置 entitlement |
| Review Improver + 长期 Evals | 后续 | 从人工反馈中生成可追溯 policy proposal，对比调整前后质量；不自动应用 | 设计完成，未排入 0.1.0 |
| Shared Review Policy + Feedback Learning | Team | 团队共享审查偏好、误报处理、审批和质量趋势 | 0.2.0+ 候选，待验证 |
| Wukong Product APIs | Pro / Team | capability、PR comment/gate、rules evaluate、audit events | Loop quota 已实现；0.1.0 只做 capability + PR gate |
| Managed Model Add-on | Pro / Team / Credits | Wukong 提供托管模型调用，解决用户不想配置 key 的场景 | 待实现 |
| Team Rules | Team | 团队统一验证命令、风险阈值、路径策略和 guard policy | 待实现 |
| GitHub PR Gate / CI Gate | Pro 起步、Team 后续 | 0.1.0 先发布本地 Gate；团队规则与组织 CI 后移 | 待实现 |
| Audit Log | Team / Enterprise | 记录谁验证、谁 override、失败原因和最终交付证据 | 待实现 |
| Agent Enforcement | Team | 要求 agent 完成前必须调用 `wukong_verify`，否则标记未完成 | 部分实现：tool 已有，策略层待实现 |
| Enhanced Guard Policy | Pro / Team | shell hook、PATH shim、集中规则、危险命令审计 | 待实现 |
| Saved/Shared Evidence | 不再规划 | Hosted Report 和公开分享已退出产品；本地显式保存只作为 Free 诊断 | 已移除线上产品面 |
| Quality Trend | Pro / Team | 失败率、风险类型、skipped test、mock/placeholder 趋势 | 待实现 |
| Private Runner / 私有部署 | Enterprise | 私有网络内运行验证、保留源码不出域 | 待实现 |
| SSO / 合规 / SLA | Enterprise | 企业采购和合规要求 | 待实现 |

### 4.4 收费优先级

建议按以下顺序推进：

1. Free 本地 Loop 先形成可靠完成与重复使用。
2. 0.1.0 用 PR Gate publish + 单一 Billing lifecycle 验证个人付费，不同时上线 Team。
3. Team Role Profiles、Shared Policy、org CI 和 Audit 只有在个人 PR 工作流成立后再验证。
4. Managed Model Add-on 只有在用户明确不愿 BYOK 且数据/成本边界成立后再引入。

旧 0.1.0 商业 contract 已归档为 [历史候选：Pro PR Gate 与 Billing](../design/historical-pro-pr-gate-billing.md)。其中 `$9/月` 与 PR Gate 单点收费只用于历史追溯，不代表当前候选价格或权益。

### 4.5 商业验证门槛

0.0.12 只判断“用户是否反复使用、免费额度是否形成压力”，不宣称已验证付费意愿。初始方向性门槛：

- 至少 20 个完成首个 Proof 的 activated users，且累计至少 50 次完成的顶层 Trust Run；样本不足只记录现象，不做商业结论。
- activated users 的 7 日重复使用率达到 25% 以上。
- 至少 15% activated users 触达 80% 用量或 quota warning。
- 触达 warning 的用户中，至少 10% 点击升级或主动请求更多额度；这仍只是升级意向。

0.0.13 只验证 review 质量和使用意愿：

- 至少累计 30 条有人类反馈的 findings，样本不足时只展示原始数量；
- blocking finding acceptance/fixed rate、dismiss rate 和每个 Loop 的 review cycles 可真实计算；
- 至少一个项目完成 finding → feedback → proposal → eval → 人工 apply → 后续 review；
- policy 调整必须在固定 eval 上不退化，不能用“生成更多评论”替代质量证据；
- 至少 20 个 activated Loop users、累计 50 次 Loop runs，并出现明确的 quota warning 或升级意愿；
- Pricing 和 Dashboard 继续显示 `Coming Soon`，不展示价格或创建 Checkout 路径。

0.1.0 才验证真实付费：

- 使用真实价格和 Checkout，观察付款完成、退款/取消与次月续费；
- checkout → capability entitlement → PR publish → portal → cancel/payment failure → grace 全链路通过；
- 至少 3 个非关联真实付款用户，并出现至少 1 个续费/持续 30 天付费使用信号。

2026-07-20 生产基线是 8 个注册用户、1 个 activated Loop user、0 个 completed users；尚未满足门槛。继续免费验证，不用默认 Free subscription rows、started/abandoned runs、注册数或模型自评替代真实完成和付费证据。

## 5. 实现优先级

### P0 已完成

1. `packages/verification` 独立核心包。
2. `wukong verify` CLI command。
3. `wukong scan` CLI command。
4. `wukong guard` CLI command，先做 best-effort interactive guard。
5. `wukong_verify` builtin agent tool。
6. TUI slash commands: `/verify`、`/scan`、`/guard`。
7. `/goal` 持续修复（单任务跑到验证条件满足，含队列）。
8. fixtures、unit tests、CLI/TUI/tool smoke tests。

### P0.5 已完成：Loop 控制层 + Merge Proof v1

1. `/proof` Merge Proof Report：verify+scan+report 固定格式汇总（Wow Moment，第 1 步）。
2. `/judge` evaluator-only 判定：默认 `--assume-broken`，deterministic 模式复用 verification 引擎（第 2 步）。
3. `/goal` verification gate：agent 宣布完成 → 强制 deterministic 评估 → 未过打回（第 3 步，`/loop` 硬前置）。
4. `/loop` 本机迭代 loop：驱动 agent + 验证 + 修复直到停止条件满足；轮间等待归 Goal driver，关机即停（第 4 步，产品核心）。
5. 文档与官网 hero 切换到 loop control plane / proof-layer 叙事。

### 当前重点：0.0.12 Free Trust Loop v2

1. 重写 Loop 的 snapshot、状态与错误 contract；verify/scan/proof 变成内部检查层。
2. 只实现 Loop session 额度，以及幂等 start/complete/usage；不引入 Checks、reservation/lease。
3. Loop 支持用户指定 writer model，并使用 fresh-context reviewer；reviewer 不能覆盖真实失败。
4. 增加轻量 Role Profiles（内置、本地自定义、TUI `/transform`），不建立第二套 agent；CLI `roles` 只管理角色目录。
5. 旧 verify/scan/proof 命令兼容但从主入口隐藏；本地 evidence 仅在显式请求时写入。

### P0 不做

- 不做完整云端商业闭环。
- 不做 Team/Enterprise。
- 不做“不可绕过”的安全承诺。
- 不发布尚未存在的 install script、Homebrew formula 或旧包名。
- 不把 legacy `packages/cli` / `packages/mcp-server` 复制为长期架构。
- 不把 `/schedule`（云端例程）在本机做；`/loop`（本机迭代，关机即停）与定时巡检（本机 cron 工具 / 云端 `/schedule`）拆开，跨机器持续性归 hosted。
- `/loop --every` 只做 Goal-owned 可取消等待；长期时间触发仍使用 agent-core cron scheduler。

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

Wukong 的 0.0.12 内核已经形成本地 CLI/TUI/agent 闭环：deterministic verification、risk scan、best-effort guard、Merge Proof、fresh-context reviewer、Role Profiles、配额与三态 Loop。P0.5 的 proof → judge → goal gate → loop 已完成。下一阶段重点是团队规则、跨会话 loop（hosted/CI）和完整计费边界，把本地 Loop 价值转成可收费的协作与审计能力。

一句话：**AI 负责写代码，Wukong 负责判断能不能合并，并用 loop 持续驱动这件事直到成立。**
