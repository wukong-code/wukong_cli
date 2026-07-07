# Wukong Code Roadmap

> 最后更新: 2026-07-07
> 范围: `wukong_cli` 产品内核、`wukong_web` 托管产品、`wukong.today` 公开安装与官网路径。

这份 ROADMAP 是当前商业化方向的执行层文档。更细的商业模型和技术方案仍以这些文档为准：

- [商业化与产品重构方案](docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- [商业化重构技术实现方案](docs/tech/commercial-refactor-implementation.md)
- `wukong_web/TODO.md`：官网与托管产品 TODO，位于 sibling web 仓库中

## 产品判断

Wukong Code 不和 Cursor / Claude Code / Codex 拼写代码，而是补上 AI 写完代码后最薄弱的一环：**这段代码能不能合并**。

定位是：

> **The proof layer for AI-written code.**
> AI 写代码，Wukong 负责判断能不能合并。

当前楔子是：

```text
本地 AI coding agent + 确定性验证 + 可合并证据（Merge Proof）
```

差异化叙事不再以"又一个 coding agent"为主，而是围绕 Loop Engineering：Wukong 是 AI Coding Loop 的控制层与验证层。

命令分层对应 loop engineering 的三层：

| 层 | Wukong 能力 | 状态 |
|---|---|---|
| 编排层 `/loop` | 持续驱动 agent + 验证 + 修复，无需人手动 prompt | 待实现（最核心） |
| 执行核 `/goal` | 单任务跑到验证条件满足 | 已实现 |
| 工具层 `/verify` `/scan` `/guard` | deterministic proof | 已实现 |
| 证据层 `/proof` | 把三件套串成 Merge Proof Report | 待实现（Wow Moment） |
| 评估层 `/judge` | evaluator-only，只审不写，默认怀疑 | 待实现 |

- `/loop` 是整个产品的组织核心：没有它，loop engineering 叙事是空的。第一版做会话级 loop（当前 TUI 会话内持续驱动），后续进化为 hosted daemon / CI 集成。
- `/proof` 是第一个 Wow Moment：AI 写完后一键生成合并证据。
- `/judge` 是差异化记忆点：火眼金睛，只审不写。
- `/goal` 已实现，是 loop 的执行核。
- 托管报告、PR gates、team rules、audit log 是真正能收费的团队能力，但仍未实现。

免费版负责让开发者愿意安装、使用、截图和分享；付费版负责解决团队真实痛点：报告历史、PR 证据、共享策略、权限、计费和审计。

## 当前基线

### 已实现

| 模块 | 状态 | 说明 |
|---|---|---|
| 本地 TUI agent | 已实现 | `wukong` 交互式终端工作流 |
| Provider 管理 | 已实现 | BYOK-first，自带模型 key |
| 本地 server / web mode | 已实现 | `wukong server`、`wukong web` |
| 本地验证 | 已实现 | `wukong verify` |
| 本地风险扫描 | 已实现 | `wukong scan` |
| 命令 guard | 已实现 | `wukong guard`，best-effort 本地命令风险控制 |
| TUI slash commands | 已实现 | `/verify`、`/scan`、`/guard`、`/report`、`/goal` |
| Agent verification tool | 已实现 | `wukong_verify` builtin tool |
| `/goal` 持续修复 | 已实现 | 让 agent 多轮迭代直到验证条件满足，含队列管理 |
| 公开官网 | 已实现 | `wukong.today`、download、docs、pricing、changelog |
| Auth / billing 基础 | 部分实现 | Web auth、Stripe checkout、subscription 表已存在 |

### 未完成

| 模块 | 状态 | 为什么重要 |
|---|---|---|
| `/loop` 持续驱动编排层 | 未实现 | 产品的组织核心：持续驱动 agent + 验证 + 修复，无需人手动 prompt |
| `/proof` Merge Proof Report | 未实现 | 第一个 Wow Moment：把 verify+scan+report 串成可读的合并证据 |
| `/judge` evaluator-only 审查 | 未实现 | 差异化记忆点：只审不写，默认怀疑 AI 代码 |
| `/ship` 发布 gate | 未实现 | proof + 版本/changelog/dry-run，更靠后的发布前 gate |
| Hosted report upload | 未实现 | 把本地 verify 变成可收费 Web 能力 |
| Report history | 未实现 | Pro Preview 的核心留存能力 |
| Shareable report page | 未实现 | 核心传播和 reviewer 协作物料 |
| Entitlement enforcement | 未完成 | 付费层级必须由服务端真实控制 |
| Stripe portal + 完整 webhook 状态 | 未完成 | 用户需要管理订阅、取消和失败付款 |
| GitHub PR comment / gate | 未实现 | 把个人工具变成团队工作流 |
| Team rules | 未实现 | 团队愿意付费的核心原因之一 |
| Audit log | 未实现 | 管理者、安全团队和企业采购需要 |
| Deep review credits | 未实现 | 可选的模型/API 增值能力 |
| Private runner / self-hosted path | 未实现 | 企业级承诺前必须具备的边界 |

## 路线图原则

1. 本地 `verify`、`scan`、`guard`、本地 Markdown report、provider 设置和基础 CLI 使用保持免费。
2. 收费点放在 hosted reports、report history、PR 协作、team rules、audit logs、managed review credits 和 Wukong 自有产品 API。
3. 用户自带 API Key 时，模型成本归用户；Wukong 收 workflow、storage、evidence、policy 和 collaboration 的钱。
4. 默认不上传完整源码 diff，只上传 redacted metadata 和 report artifacts。
5. 在 guard、redaction、audit、private runner 真正完成前，不宣传安全合规能力。
6. 每个 milestone 必须有可见用户路径和验收方式，不能只完成路由或表结构。
7. 优先做 Wow Moment（`/proof`）和差异化记忆点（`/judge`），不在 hot 窗口期堆大而全功能。
8. 不把 Loop Engineering 第三层（GitHub/CI/Sentry 外部反馈集成）写成已具备能力，集成未完成前只作为叙事。
9. `/loop` 第一版做会话级 loop（当前 TUI 会话内持续驱动）；不做 CLI cron/daemon 重形态，持续性能力归 hosted/CI。

## Milestone 0: Public Install And Local Proof

状态：基本完成。

目标：开发者 5 分钟内能安装 Wukong Code，跑一次本地验证，并理解它为什么存在。

交付项：

- `wukong.today/download` 的稳定安装路径。
- 公开 package name、binary distribution 和文档一致。
- CLI welcome、login selector、终端文案统一为 `WuKong Code`。
- `wukong verify`、`wukong scan`、`wukong guard` 被明确写成核心本地闭环。
- 官网首页和下载页只描述当前真实能力。

验收：

- macOS 和 Linux fresh install 能跑通。
- `wukong --help` 展示预期命令面。
- `wukong verify --no-report`、`wukong scan --json`、`wukong guard --status` 可本地运行。
- 官网 download command 和真实 installer 一致。
- 页面不把 hosted report history、PR gates、team rules 写成已完成能力。

## Milestone 0.5: Loop Control Plane + Merge Proof

状态：未实现。

目标：在 Loop Engineering 热度的窗口期内，用最低成本打出真正的产品核心——不是一个"更好的 coding agent"，而是一个 **AI Coding Loop 的控制层**。把已实现的工具层（verify/scan/guard/goal）用 `/loop` 编排起来，并以 `/proof` 作为可分享的 Wow Moment。

### 交付项

**A. `/loop` 会话级 loop（核心）**

- `/loop` TUI slash command + `wukong loop` CLI subcommand。
- 会话级形态：在当前 TUI 会话内持续驱动 agent——给定目标与验证条件，自动 prompt agent → 运行 → verify → 判断 → 继续或停止，直到满足停止条件或人介入。
- 停止条件由可验证断言表达（如 `tests pass and no high-risk findings`），停止判断不由写代码的 agent 自己做。
- 与已实现的 `/goal` 关系：`/goal` 是单任务执行核，`/loop` 是持续驱动的编排层，可串联多个 goal 并在每轮注入验证。
- 显式不做 CLI cron/daemon 重形态；跨会话持续性归 hosted/CI（Milestone 3+）。

**B. `/proof` Merge Proof Report（Wow Moment）**

- `/proof` TUI slash command + `wukong proof` CLI subcommand：依次运行 `verify` → `scan` → 汇总成一个固定格式的 Merge Proof Report。
- Merge Proof Report 字段：Status（PASS / BLOCKED）、changed files、tests pass/fail、typecheck、secrets scan、risky changes、guard violations、recommendation。
- 报告输出为本地 Markdown + JSON，离线可用。

**C. `/judge` evaluator-only 审查（差异化记忆点）**

- `/judge` TUI slash command + `wukong judge` CLI subcommand：默认 `--assume-broken`，复用 verification 引擎，只审不写，输出 BLOCK/PASS 结论。

**D. 文案**

- 文档与官网 hero 文案切换到 loop control plane / proof-layer 叙事。

### 不做

- 不做 `/ship` 发布 gate（更靠后，依赖 proof 先稳定）。
- 不做跨会话 cron/daemon（归 hosted/CI）。
- 不在此 milestone 接 hosted upload。

验收：

- `wukong loop` / `/loop` 在会话内对一个目标持续驱动：agent 改代码 → verify → 不通过则继续，直到停止条件满足或人介入停止。
- 停止条件可验证，且停止判断不由写代码的 agent 自己做。
- `wukong proof` / `/proof` 在干净项目产出 PASS 报告。
- 在含 placeholder/secret/失败测试的项目产出 BLOCKED 报告，并定位原因。
- `wukong judge --assume-broken` 在不干净项目直接给 BLOCK。
- 报告可被人读懂并定位失败原因。
- 官网 hero 切换为 loop control plane / proof-layer 文案后，不出现任何未实现能力的承诺（尤其不宣称跨会话 daemon、CI 集成已可用）。

## Milestone 1: Hosted Reports MVP

目标：把本地 verification report 变成第一个真实付费 Web 工作流。

交付项：

- `verify` / `scan` 的 report upload command 或 flag。
- redacted report metadata 的上传 schema。
- 服务端 report ingestion API。
- D1 schema：reports、artifacts、visibility、retention、owner。
- Dashboard report history 使用真实数据，不再是 placeholder。
- Shareable report route，例如 `/r/[id]`。
- 上传失败不能影响本地 report 生成。

验收：

- 未登录用户仍可完整使用本地 report。
- 登录用户可以上传 redacted report 并得到 share URL。
- Dashboard 显示真实上传的 report。
- reviewer 打开 share page 时看不到 secrets 或完整源码 diff。
- redaction 测试覆盖 secret-like string、env 文件、token、private key 和超大 diff。

## Milestone 2: Pro Preview Billing

目标：让 Pro Preview 至少包含一个真实付费能力，而不是 early access 文案。

交付项：

- Free / Pro Preview / Team Pilot 的 entitlement model。
- hosted report quota 和 retention 的服务端校验。
- Stripe webhook 覆盖 subscription create/update/cancel/payment failure。
- Dashboard 的 customer portal 入口。
- Billing UI 展示当前 plan、usage、quota、renewal、failed payment 状态。
- Pricing 页面文案与真实 entitlement 对齐。

验收：

- Free 用户可以用本地 CLI，但不能超过 hosted report quota。
- Pro 用户可以按套餐上传并保留 reports。
- 取消或付款失败后，按 grace 规则失去付费 hosted 能力。
- Dashboard plan state 与数据库 entitlement state 一致。
- Pricing 页面不把未完成的 Team 或 deep review 功能写成 live。

## Milestone 3: GitHub PR Evidence

目标：让 Wukong 进入 code review 流程，而不是只停在本地命令。

交付项：

- GitHub App 或 token-based integration。
- PR comment：写入 report summary 和 share link。
- PR status check：基于 `verify` / `scan` 结果。
- GitHub Actions / CI 模式上传 reports。
- GitHub org/repo 和 Wukong team/workspace 的映射。

验收：

- 测试 PR 能收到 Wukong report comment。
- scan 通过和失败会产生不同的 GitHub status check。
- Report link 使用正确的 visibility rule。
- GitHub comment 中不出现 secrets。
- 上传失败不能把 verification 标记为 passed。

## Milestone 4: Team Rules And Audit Log

目标：从个人开发者工具变成团队交付流程。

交付项：

- Team workspace model。
- Repo/path-level rules。
- Required checks 和 risk thresholds。
- Override flow，必须填写 reason。
- Team audit log：记录 upload、PR gate、policy change、override。
- Shared templates：团队统一 verification commands。

验收：

- Team admin 可以为 repo 定义 required checks。
- PR gate 使用 team rules，不使用硬编码默认规则。
- Override 必须记录 actor、reason、timestamp 和 linked report。
- Audit log 可以回答：谁验证、什么失败、谁 override、最后交付了什么。

## Milestone 5: Deep Review And Managed Credits

目标：增加模型/API 支持的付费能力，但不把 Wukong 做成原样模型 proxy。

交付项：

- Deep review job API。
- BYOK review mode。
- Managed credit review mode。
- Job queue 和结果持久化。
- Deep review output 附着在 report 上。
- Managed credits usage metering。

验收：

- BYOK 用户为 workflow/reporting 付费，不为自己的 token 额外加价。
- Managed model 用户消耗 Wukong review credits。
- Deep review 结果可以挂到 report 并分享。
- 模型调用失败可见，且计费状态正确。
- 产品文案不把第三方 API 转售包装成核心价值。

## Milestone 6: Enterprise Readiness

目标：为严肃 team pilot 和企业沟通准备真实边界。

交付项：

- Private runner design。
- Self-hosted 或 customer-cloud report processing path。
- SSO plan。
- Data retention controls。
- Export/delete workflows。
- Security review 和 threat model。

验收：

- 团队可以把源码和 secrets 保留在自己的环境内。
- Hosted Wukong 只接收被允许的 redacted metadata。
- Admin 可以配置 retention 并导出 reports。
- Security docs 与实际实现一致。

## Website Roadmap

官网必须和真实产品状态保持一致。

近期工作：

- 首页继续聚焦 local AI coding + verification evidence。
- `/download` 保持短、准、可安装。
- `/pricing` 必须绑定真实 entitlement。
- hosted report demo 必须等真实 sample report 出现后再上线。
- Dashboard placeholder 改成真实 report history。
- changelog 保持和公开 release 同步。

不要做：

- GitHub integration 未完成前，不宣称 PR gate 已可用。
- Deep review job API 未完成前，不宣称 deep review 已可用。
- Redaction、audit、private runner 未完成前，不宣称 security/compliance。

## CLI Roadmap

近期工作：

- 实现 `/loop`（会话级 loop 编排，Milestone 0.5 核心）、`/proof`（Merge Proof Report）、`/judge`（evaluator-only 审查）。
- 给 `verify` 和 `scan` 增加登录态 report upload。
- 上传前提供 opt-in 和清晰 redaction preview。
- JSON output 增加 Web report API 需要的字段。
- 本地 report 保持 offline 可用。
- 登录命令保持简单：OAuth first，不展示重复 platform choices。
- 终端 UI 保持紧凑、产品导向。

不要做：

- 在 report upload 闭环完成前，不把本地 agent 强行搬到 hosted web app。
- 付费 evidence 工作流未成立前，不继续堆游戏化功能。
- 不把本地 deterministic verification 放到付费墙后。
- 不把 `/loop` 做成 CLI cron/daemon 重形态；跨会话持续性归 hosted/CI。

## Commercial Readiness Gates

Pro Preview 可以公开收费的最低条件：

- 用户可以上传真实 redacted verification report。
- Dashboard 可以看到 report history。
- Report 可以安全分享。
- Stripe entitlement 至少控制一个 hosted feature。
- Pricing copy 和真实 entitlement logic 一致。
- 新用户可以完成 install -> verify -> upload -> share，无需人工介入。

Team Pilot 可以开始试点的最低条件：

- GitHub PR comment 或 status check 可用。
- Team rules 会影响 PR gate 行为。
- Audit log 捕获 report、gate 和 override events。
- 至少一个 design partner 能在真实 repo 上跑完整流程。

## Metrics

先追踪这些指标，再优化增长：

- Install completion rate。
- 24 小时内首次成功 `wukong verify`。
- 每个活跃开发者每周生成 report 数。
- Hosted report upload conversion。
- Share link open rate。
- PR gate pass/fail rate。
- Hosted report 使用后的付费转化。
- Team pilot 两周留存。

## Explicit Non-Goals

- 不做通用 chatbot website。
- 不把第三方模型 API 转售作为主产品。
- 不对基础本地 verification 收费。
- 不把 mascot 工作变成主路线图。
- 不在实现前宣传 enterprise security。
- 不在 report upload 闭环成立前做泛 SaaS dashboard。

