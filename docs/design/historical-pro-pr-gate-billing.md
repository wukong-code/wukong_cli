# 历史候选：Pro PR Gate 与 Billing

> 状态：HISTORICAL CANDIDATE / SUPERSEDED；本文件只保留 2026-07-20 的旧商业实验假设，不再占用 `0.1.0` 版本号。
> 规划日期：2026-07-20
> 一句话目标：保留完整的本地 BYOK Loop，用一个可验证的付费能力——把 Gate 结论安全地发布回 GitHub Pull Request——验证 Wukong 是否值得付费。
> 取代方案：[0.1.0 Trusted Local Loop](0.1.0-trusted-local-loop.md) / [0.2.0 Pro Reliable Autonomy](0.2.0-pro-reliable-autonomy.md)
> 长期能力方向：[Wukong 能力体系与商业化原则](../business/WUKONG_CAPABILITY_MODEL.md)

> 阅读边界：以下全部产品边界、Phase、发布门槛、价格和命令均是 2026-07-20 的条件性历史方案。即使正文保留设计语态，也不代表当前批准、排期或计划实施；当前真相源是 ROADMAP 与 TODO。

## 1. 决策摘要

历史方案曾设想 `0.1.0` 只做一条商业闭环：

```text
本地 Loop 得到 Gate 结论
  → 用户预览将要发布的内容
  → Pro entitlement 允许发布
  → 更新同一条 PR summary comment
  → 写入 wukong/gate commit status
  → Web 可查看和管理订阅
```

当时方案明确不把本地 Loop 次数作为 entitlement 或购买理由。用户已经自带模型 API Key，本地检查和本地 reviewer 的推理成本由用户承担；给这条本地路径设置账号额度墙，价值弱、容易绕过，也会伤害产品采用。

历史方案的首个付费假设是：个人开发者愿意为**减少 PR 手工整理、让 Gate 结论进入既有 GitHub review 流程**付费。候选试验价格曾设为 **$9/月**，只设一个月付方案；这不是公开价格承诺。文中 `0.1.0-rc.N`、邀请制试验和正式发布门槛都没有获得当前批准。

## 2. 当前生产基线

2026-07-20 的生产匿名聚合数据：

| 指标 | 当前值 |
|---|---:|
| 注册用户 | 8 |
| subscription rows | 4（全部 Free） |
| 启动过 Loop 的用户 | 1 |
| Loop runs | 9 |
| terminal runs | 5（全部 abandoned） |
| 完成过 Loop 的用户 | 0 |
| 7 日重复完成用户 | 0 |

结论：当前数据不能证明用户完成价值或付费意愿。可以实现 entitlement、PR adapter 和 Stripe Test Mode，但**不得因为代码完成就直接公开 Checkout**。

## 3. 产品边界

### 3.1 Free：完整的本地价值

Free 继续包含：

- 本地 BYOK coding agent、`/resume` 和 `/loop`。
- 本地项目检查、风险扫描、fresh-context reviewer 与 Gate。
- `verify`、`scan`、`proof` 高级诊断。
- 本地 Role Profiles、review policy、feedback 和本地记录。
- GitHub PR 发布前的本地预览 / dry-run。
- 不登录、不调用 Wukong quota 服务、没有 Guest 或月度次数限制的完整本地 BYOK Loop。
- 默认单次 10 轮并允许用户显式调整；reviewer step/time、permission mode 和 `/loop stop` 只作为本地安全边界。

### 3.2 Pro：一个真实权益

Pro 在 invite-only 阶段只承诺：

- 将当前 Gate summary 和 blockers 发布或更新到 GitHub PR。
- 为当前 commit 发布 `wukong/gate` status：`success`、`failure` 或 `error`。
- Dashboard 中管理月付订阅、付款方式、取消和账单状态。

Pro 不包含 managed model credits；writer 和 reviewer 仍然 BYOK。

长期能力模型把 Custom Specialist 和 Wukong Managed Gate 记录为 Pro 候选，但不自动改变本版本 contract。若真实用户证明“官方高级 Reviewer + PR publish”比单独 publish 有更强购买理由，必须先补充最小证据包、上传同意、数据保留、模型成本、失败语义和 entitlement 设计，再显式修改本文件、ROADMAP 与 TODO；不能只通过官网文案扩张 0.1.0 权益。

### 3.3 Founder 与 Team

- `founder` 是历史兼容 grant，不再作为公开商品；`source=legacy_grant` 映射到与 Pro 相同的 PR capability，但不伪造 Stripe billing、renewal 或 Portal，不形成第三套公开权益文案。
- Team 保持人工 design pilot，不进入 0.1.0 自助购买，也不复用 `pro` tier 表示。
- Team rules、共享 policy、组织映射、audit log、SSO、GitHub App 和 private runner 后移。

## 4. 为什么选择 PR Gate

PR Gate 比“更多 Loop”更接近用户已经付费的工作流：它减少复制结果、整理 review 信息和手工设置合并状态的时间，并让 Wukong 的结论出现在团队真正做决策的位置。

本版本暂不选择 managed reviewer：

- 它需要代码上下文上传同意、数据处理条款、成本控制和托管队列。
- 当前没有完成 Loop 的生产样本，尚不能证明更强 reviewer 是主要痛点。
- BYOK reviewer 已经免费提供，不能把已发布能力重新包装为新收费点。

本版本也不选择完整 Team 产品：组织权限、规则、审计和 GitHub App 会同时扩大身份、权限、数据和支持范围，无法作为 0.1.0 的最小商业实验。

## 5. 用户路径

### 5.1 免费本地路径

```sh
wukong loop "finish this change"
wukong pr gate --dry-run
```

第二条命令只读联网获取当前 repo/PR metadata，并读取最近一次本地 Gate；它输出将要发布的 comment/status，不调用 GitHub 写 API，不要求 Pro，但不是纯离线命令。

### 5.2 Pro 发布路径

```sh
wukong login
wukong account
wukong pr gate
```

流程：

1. 检查登录、entitlement、当前 GitHub repo/branch/PR 和 Gate freshness。
2. 在终端显示 PR、commit SHA、visibility 和待发布摘要。
3. 首次交互发布必须确认；CI 使用 `--yes` 显式跳过确认。
4. 使用 GitHub CLI/token 按第 8 节的两阶段协议更新同一条 marker comment 和 `wukong/gate` status。
5. 任一 partial write 都返回 `ERROR/partial_publish` 和恢复命令；不得把半完成发布显示为完整成功。

### 5.3 购买与管理路径

```text
CLI upgrade intent
  → 浏览器打开登录后的 Web checkout
  → Stripe Checkout
  → webhook 更新 subscription + entitlement
  → success page 轮询服务端真实状态
  → CLI account/entitlement 可见
  → Customer Portal 管理付款方式或取消
```

CLI 不收集卡号，不接受 Stripe secret，也不凭 success URL 自行授予权益。

## 6. Capability-based Entitlement Contract

CLI 不再根据 `free` / `founder` / `pro` 字符串猜测能力。Web 提供稳定、可版本化的 contract：

```json
{
  "version": 1,
  "plan": "free",
  "billing": {
    "status": "none",
    "currentPeriodEnd": null,
    "cancelAtPeriodEnd": false,
    "graceEndsAt": null,
    "observedAt": "2026-07-20T00:00:00Z"
  },
  "entitlements": {
    "prGatePublish": false
  },
  "links": {
    "checkout": null,
    "portal": null
  }
}
```

约束：

- plan 是展示标签，capability 才是授权真相源。
- billing status 统一为 `none | incomplete | incomplete_expired | trialing | active | grace | past_due | canceled | unpaid | paused | unknown`。
- 本地 BYOK Loop 不属于 entitlement；account API 故障不得阻断它，也不得收窄用户显式设置的本地迭代上限。
- entitlement API 不可用时，仅保留 Free 本地能力；绝不离线授予 GitHub 写权限。
- `graceEndsAt` 和 `observedAt` 由服务端返回；CLI 不自行根据本地时间或 Stripe 字符串推测权益。
- Dashboard、Pricing、CLI `wukong account` 与 PR adapter 共用同一个 resolver。

resolver 的最小映射：

| Provider / effective state | Pro capability | 规则 |
|---|---|---|
| `trialing` / `active` | 有 | product/price、customer、subscription 和 user 映射全部验证后授权 |
| cancel-at-period-end 且尚未到 `currentPeriodEnd` | 有 | UI 显示将取消；到期后重新同步并降级 |
| 首次 `past_due` 且当前时间早于 `graceEndsAt` | 有 | effective status 对外显示 `grace`；初始建议最多 7 天 |
| `past_due` 且 grace 已过 | 无 | 降为 Free，保留 Portal 恢复入口 |
| `none` / `incomplete` / `incomplete_expired` / `canceled` / `unpaid` / `paused` | 无 | Free capability |
| 未知、映射冲突、过期或无法回读 Stripe | 无 | fail closed，并告警人工检查 |

`checkout.session.completed` 只表示 Checkout 流程结束，不能直接授权。服务端必须回读并验证 Stripe subscription，再通过同一 resolver 生成 capability。

## 7. CLI 设计

### 7.1 `wukong account`

默认输出保持短：

```text
Plan       Free
Loop       2 / 10 · resets Aug 1
PR publish Coming soon
Manage     https://wukong.today/dashboard
```

支持 `--json`，供测试和自动化读取。未登录时显示登录命令；不得把本地模型 provider 状态误写成订阅状态。

### 7.2 `wukong pr gate`

首发参数：

- `--dry-run`：只预览，不写 GitHub，Free 可用。
- `--yes`：跳过交互确认，供 CI 使用。
- `--json`：输出结构化结果；不得隐式改变是否发布。
- `--pr <number>`：显式覆盖自动发现的当前 PR。

不做 inline review comments，不自动修改代码，不创建 PR，不负责 merge。

退出码：

| 结果 | exit code |
|---|---:|
| Gate PASS 且 comment/status 发布成功 | 0 |
| Gate NEEDS_WORK 且 failure status 发布成功 | 1 |
| stale Gate、runtime 或 GitHub/Stripe 写入错误 | 2 |
| 未登录、entitlement denied 或 invite-only Checkout 不可用 | 3 |
| 用户取消 | 130 |

### 7.3 数据最小化

默认不向 Wukong Web 上传源码、diff、prompt、transcript、文件绝对路径或 model key。PR comment 只包含：

- Gate outcome、检查名称与状态。
- 经本地 redaction 后的 blocker 摘要和 repo-relative path。
- commit SHA、Wukong 版本和本地执行时间。

用户发布前必须能看到完整预览。任何疑似 secret 都替换为 `[REDACTED]`；超长内容截断并提示在本地查看。

## 8. GitHub Adapter

0.1.0 使用现有 `gh` 登录或显式 GitHub token，不引入 GitHub App：

- `gh pr view --json` 发现 PR 和 head SHA。
- REST/GraphQL 写入一条稳定 marker comment；再次运行更新原 comment。
- commit status context 固定为 `wukong/gate`。
- 文档只要求最小权限：读取 repo/PR metadata、写 PR comment 和 commit status；不要求代码写入或 merge 权限。
- comment 和 status 必须绑定同一个 Gate snapshot / commit SHA。
- Gate 过期、workspace 变化或 SHA 不一致时拒绝发布，要求重新运行 Loop/Gate。
- token scope 不足、rate limit、网络失败和 partial write 都返回可执行的恢复提示。

GitHub 没有跨 comment/status 的事务，0.1.0 使用可恢复的两阶段发布：

1. 先为目标 SHA 写 `wukong/gate=pending`；失败时不创建 comment。
2. 幂等创建或更新 marker comment 为 `PUBLISHING`，不包含 PASS/NEEDS_WORK 结论。
3. 写入真实 terminal status：Gate PASS → `success`，NEEDS_WORK → `failure`；本地 Gate ERROR 不允许发布为 success。
4. 最后把 marker comment 更新为完整、已预览的 Gate 内容。

partial write 规则：

- 第 2 步失败：best-effort 将 status 改为 `error`，返回 `ERROR/partial_publish`。
- 第 3 步失败：comment 保持或更新为 `INCOMPLETE`，不得含 PASS；返回 ERROR。
- 第 4 步失败：terminal status 是真实 Gate 结果，comment 保持 `PUBLISHING/INCOMPLETE`；返回 ERROR，重试时继续更新同一 comment。
- 重试总是先读取 marker comment 和同 SHA status，再补齐缺失阶段；永远不创建第二条 Wukong comment。
- marker 查找必须分页、校验当前 GitHub actor/固定 marker 和目标 PR；不能更新其他 bot 或用户的相似 comment。

这保证 partial failure 不会制造错误 PASS，同时不假装 GitHub 两个 API 具备原子事务。

GitHub credential 只允许来自 `gh` credential store 或环境变量；不得写入 Wukong config/record、命令参数、telemetry 或日志。CI 只授予 PR metadata/comment 与 commit-status 最小权限；fork PR 默认只做 dry-run，禁止通过 `pull_request_target` 对不可信 fork 代码执行 Wukong Loop 或项目命令。

## 9. Web、Stripe 与数据模型

### 9.1 公开开关

- `PRO_PUBLIC_CHECKOUT_ENABLED=false` 默认关闭公开购买；服务端准入条件是 `publicEnabled || pilotAllowlist.has(userId)`。
- invite-only 阶段使用服务端 allowlist，不依赖客户端隐藏按钮；非准入用户的 account contract 返回 `checkout: null`。
- Pricing 在开关关闭时继续显示 `Coming soon`；不得提前展示 `$9`。

### 9.2 数据迁移

`subscriptions` 是每个用户的**当前 entitlement projection**，不是账单历史 ledger。至少补充：

- `user_id` 唯一；非空 `stripe_customer_id` 和 `stripe_subscription_id` 分别唯一。
- Stripe product/price、完整 lifecycle status、current period、cancel-at-period-end、grace end、last provider event time。
- source（legacy grant / Stripe / manual pilot）和 projection version。

另建 append-only `billing_events` ledger：

- `provider_event_id` 唯一，记录 event type、provider created time、object ID、处理状态和错误；默认不复制完整 Stripe payload。
- event 去重写入与 subscription projection 更新必须在同一 D1 atomic batch/transaction boundary 内完成。
- 乱序、重购或并发 webhook 先回读 Stripe 当前对象，再更新 projection；不能让旧 event 覆盖新状态。
- 已有 active/grace subscription 时拒绝创建第二条；旧 subscription 失效后的重购才替换 current projection，历史留在 ledger。

`founder` 历史记录通过 migration 映射 capability，不自动创建 Stripe subscription。

### 9.3 Checkout 与 Portal

- 只允许服务端配置的一个月付 Price ID，拒绝客户端任意 price。
- Checkout 必须绑定已登录用户和 Stripe customer。
- 每个用户最多一个可收费 subscription；已有 active/grace subscription 时转到 Portal，Checkout 使用幂等键避免重复订阅。
- Customer Portal 提供付款方式更新、invoice、取消和恢复订阅。
- 取消默认在当前计费周期末生效；期间 entitlement 继续有效。
- success page 必须轮询服务端 subscription/entitlement，不能根据 query string 显示成功。
- 邀请制试验前发布明确的退款、取消、数据处理和支持说明；退款/争议事件必须有可测试的 entitlement 处理，不靠人工改 tier。

### 9.4 Webhook

- 验证原始 body 和 Stripe signature。
- event ID 幂等去重，不假设事件按顺序到达。
- 处理 checkout complete、subscription create/update/delete、invoice paid/payment failed，以及 refund/dispute 后的 subscription reconciliation。
- 必要时从 Stripe 重新读取 subscription，避免仅信任 metadata 或过期事件。
- 只接受配置的 product/price；user/customer/subscription 映射不一致时拒绝升级并告警。
- payment failure 进入短 grace（初始建议 7 天），成功重试后恢复；最终失效后降级。
- Dashboard 每次从数据库读取当前 billing/entitlement，不依赖最长 30 天的旧 JWT tier。

## 10. 历史条件性实施阶段（未批准）

### Phase 0：激活修复，Checkout 关闭

- 修复 completed lifecycle 的真实上报，取得至少 5 个 activated、3 个 completed users。
- 取得 2 个 7 日内重复完成用户和 3 条可归因用户反馈。
- 完成一次真实 TUI `/loop` 人工 smoke。

### Phase 1：统一 contract

- 数据迁移和 `resolveEntitlement()`。
- `/api/v1/account` contract。
- CLI `wukong account`。
- Dashboard 与 quota 改用 resolver，清除 `pro = Team Pilot` 等 tier 漂移。

### Phase 2：Stripe Test Mode

- allowlisted Checkout、Portal、完整 webhook、success polling。
- 覆盖购买、重复事件、乱序事件、续费、失败、grace、取消和恢复。

### Phase 3：PR Gate

- Free dry-run、Pro publish、redaction、幂等 comment/status。
- GitHub 权限不足、partial write、stale SHA 和 CI 模式测试。

### Phase 4：邀请制付费实验

- 邀请 5 至 10 位有真实 PR 流程的活跃用户。
- 通过明确标记的 `0.1.0-rc.N` native assets 和服务端 allowlist 提供试点；不要把未正式发布的功能塞回 `0.0.15`。
- 先让至少 5 位目标用户在真实 PR 上完成 dry-run 并确认价值，再向其中符合条件的用户开放付费 Checkout。
- 测试 `$9/月`，不提供年付、终身版、优惠券矩阵或 overage。
- 收集实际发布次数、节省时间、取消原因和支持成本。

### Phase 5：公开 0.1.0

只有发布门槛全部满足，才打开公开 Checkout、更新 Pricing 并发布正式版本。

## 11. 历史条件性发布门槛（未批准）

### 产品使用门槛

- 至少 5 个真实 activated Loop users。
- 至少 3 个不同用户完成 Loop。
- terminal completion reporting rate ≥ 90%。
- 至少 2 个用户在 7 天内重复完成 Loop。
- 至少 3 条可归因反馈能解释继续使用或放弃原因。
- 至少 5 位目标用户在真实 PR 上完成 dry-run，并明确表示发布结果能减少手工 review 工作。

### 付费实验门槛

- 至少 20 个用户完成首个 Loop，累计至少 50 次 completed Loops。
- 至少 3 个非关联真实付款用户，且每人至少成功发布一次 PR Gate。
- 至少 2 位付费用户在 30 天内对不同 PR 重复发布。
- 至少 1 个续费信号；首次公开前允许用连续 30 天活跃付费且重复发布替代等待完整第二账期，但不能宣称留存已验证。
- 本地 Loop 使用只作为激活与留存信号，不能替代 PR publish 的付费证据，也不能重新变成账号额度墙。
- 若未来加入 managed cost，变动成本不得超过对应收入的 30%；0.1.0 BYOK + GitHub publish 理论上不产生模型成本。

### 工程门槛

- Stripe Test Mode + D1 真实 E2E 覆盖完整 lifecycle。
- PR comment/status 在真实测试 repo 验证，且重复运行不刷屏。
- redaction fixture 和人工敏感信息检查通过。
- GitHub/Stripe 失败永远不会错误授予 entitlement 或发布 PASS。
- CLI、Dashboard、Pricing、Terms、Privacy、公告和中英文文档完全一致。
- 清理 `apps/wukong/CHANGELOG.md` 中历史、未作为当前公开序列发布的 `0.1.0/0.1.1` 条目；确认 package registry、Git tag、GitHub Release、升级 manifest 和公开 changelog 没有版本占用或降序冲突。

## 12. 成功指标

主指标：

- `completed_loop_users` 和 7 日重复完成率。
- `pr_gate_previewed → pr_gate_published` 转化率。
- 每位付费用户每月发布 PR Gate 的次数。
- 试用 / invite → paid、30 天活跃和首次续费。

诊断指标：

- stale Gate、GitHub 权限和 partial write 失败率。
- Checkout → entitlement 生效延迟。
- payment failure → recovery / cancel 比例。
- 每位付费用户的支持时间。

最小事件只记录 `pr_gate_previewed`、`pr_gate_publish_attempted`、`pr_gate_published`、outcome/error reason 和版本；禁止记录 repo 名、PR number、commit SHA、路径、comment 内容、源码或 GitHub token。Billing lifecycle 使用服务端 Stripe/D1 记录，不复制到匿名 telemetry。

不得用注册数、默认 Free subscription rows、started runs 或 Pricing 点击代替成功。

## 13. 明确不做

- Hosted Report、报告上传或公开分享链接。
- Wukong 托管模型、managed credits 或 token 转售。
- GitHub App、组织安装、inline review comment 或自动 merge。
- Team rules、共享 Role/Policy、audit log、SSO 或 private runner。
- 云端 `/schedule`、后台 Loop 或源码存储。
- 年付、终身版、多个付费 tier、seat billing 或复杂 overage。

这些项目只有在 Pro PR Gate 的使用和付费证据成立后再排版本。

## 14. 外部基准与实现依据

产品边界参考同类工具的公开定价：本地/open-source 使用通常免费，付费集中在云端 agent 容量、PR review、集成和团队治理；Wukong 因此保留完整本地 BYOK 价值，把第一笔付费对准 PR workflow，而不是再次收取模型使用费。

Stripe 生命周期实现遵循其官方 webhook、Customer Portal、取消和失败恢复文档：异步订阅状态由 webhook 驱动，事件必须幂等且不能依赖顺序，用户通过 Portal 管理账单，周期末取消和失败重试必须有明确 entitlement 语义。

官方参考：

- [OpenHands Pricing](https://www.openhands.dev/pricing)
- [GitHub Copilot Plans](https://github.com/features/copilot/plans)
- [Cursor Pricing](https://cursor.com/pricing)
- [Claude Pricing](https://claude.com/pricing)
- [CodeRabbit Pricing](https://www.coderabbit.ai/pricing)
- [Greptile Pricing](https://www.greptile.com/pricing)
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe webhook best practices](https://docs.stripe.com/webhooks?lang=node)
- [Stripe Customer Portal](https://docs.stripe.com/customer-management/configure-portal)
- [Stripe subscription cancellation](https://docs.stripe.com/billing/subscriptions/cancel)
- [Stripe Smart Retries](https://docs.stripe.com/billing/revenue-recovery/smart-retries?locale=en-GB)
