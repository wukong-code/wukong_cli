# Wukong Code Roadmap

> 最后更新: 2026-07-13
> 范围: `wukong_cli` 产品内核、`wukong_web` 托管产品、`wukong.today` 公开安装与官网路径。

这份 ROADMAP 是当前商业化方向的执行层文档。更细的商业模型和技术方案仍以这些文档为准：

- [商业化与产品重构方案](docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- [商业化重构技术实现方案](docs/tech/commercial-refactor-implementation.md)
- [TODO.md](TODO.md)：本仓库执行层任务清单，按本 ROADMAP 的 milestone 拆解
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

命令分层对应 loop engineering 的谱系（参考 Claude Code 的 loop 分类）：

| 层 | Wukong 能力 | 触发 | 停止 | 状态 |
|---|---|---|---|---|
| Turn-based | TUI 默认 agentic loop | 用户 prompt | agent 自判完成 | 已实现 |
| Goal-based `/goal` | 单任务驱动 agent 多轮推进 | 实时手动 | agent 自评完成 or 回合/预算上限 or verification gate | 已实现（verification gate 已落地，归 M0.5） |
| Time-based `/loop` | 本机迭代驱动 agent 直到验证通过 | 手动启动，轮次自动衔接（`--every` 复用 cron scheduler 节流） | 停止条件满足 or 迭代上限 or 取消 | 已实现 |
| Cloud routine `/schedule` | 云端例程，机器关了也跑 | 计划 | 任务达标退出，例程持续 | 待实现（归 hosted） |
| 工具层 `/verify` `/scan` `/guard` | deterministic proof | 手动/被 loop 调用 | 单次 | 已实现 |
| 证据层 `/proof` | 把三件套串成 Merge Proof Report | 手动 | 单次 | 已实现 |
| 评估层 `/judge` | evaluator-only，只审不写，默认怀疑 | 手动/被 loop 调用 | 单次 | 已实现 |

- `/loop` 的核心语义是**迭代直到验证通过**（iterate-until-verified）：上一轮验证未过就注入失败反馈立即开始下一轮；`--every` 只是可选的轮间最小间隔（节流），用于等 CI 等外部反馈的场景。**关机即停。**
- 定时巡检型任务（"每小时 check PR"）不属于 `/loop`：本机由已实现的 agent-core cron 工具承载，云端归 `/schedule`（hosted，Milestone 3+）。
- `/loop` 不新写引擎：时间触发复用 agent-core 已有的 cron scheduler，执行核复用 `/goal`。
- 停止判断不由写代码的 agent 自评。注意：当前 `/goal` 的完成判定仍是 agent 自评 + 回合/预算上限，M0.5 必须先给 `/goal` 出口加 deterministic verification gate（agent 宣布完成 → 强制 verify/scan/judge → 未过打回），`/loop` 复用该 gate。
- `/proof` 是第一个 Wow Moment：AI 写完后一键生成合并证据。
- `/judge` 只审不写：M0.5 默认是 deterministic 对抗性判定（复用 proof 引擎，BLOCK 倾向）；fresh-context 第二 agent 审查（`--agent`）落地前，不对外宣传"第二 agent reviewer"。
- 托管报告闭环已经实现；PR gates、team rules、audit log 是下一阶段真正能扩大团队付费意愿的能力。

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
| TUI slash commands | 已实现 | `/verify`、`/scan`、`/guard`、`/report`、`/goal`、`/proof`、`/judge`、`/loop` |
| Agent verification tool | 已实现 | `wukong_verify` builtin tool |
| `/goal` 持续修复 | 已实现 | 让 agent 多轮迭代直到验证条件满足，含队列管理 |
| `/goal` verification gate | 已实现 | agent 宣布完成时运行 deterministic gate，未过打回 |
| `/loop` 本机迭代 loop | 已实现 | iterate-until-verified，复用 `/goal` 执行核；`--every` 节流待完整落地 |
| `/proof` Merge Proof Report | 已实现 | verify+scan 串成可分享报告 |
| `/judge` evaluator-only 判定 | 已实现 | deterministic 判定先行；`--agent` 第二-agent 审查后置 |
| 公开官网 | 已实现 | `wukong.today`、download、docs、pricing、changelog |
| Auth / billing 基础 | 部分实现 | Web auth、Stripe checkout、subscription 表已存在 |

### 未完成

| 模块 | 状态 | 为什么重要 |
|---|---|---|
| `/schedule` 云端例程 | 未实现 | 机器关了也跑的例程，归 hosted（Milestone 3+）；本机定时巡检先用已实现的 cron 工具 |
| `/ship` 发布 gate | 未实现 | proof + 版本/changelog/dry-run，更靠后的发布前 gate |
| Hosted report upload | 已实现 | `verify` / `scan` / `proof` 和本地 Markdown 都可 opt-in 上传；失败不影响本地报告 |
| Report history | 已实现 | Dashboard 使用真实 report API，不再展示 demo 数据 |
| Shareable report page | 已实现 | 私有为默认；显式 `--upload --public` 才返回公开分享链接 |
| Hosted report entitlement | 已实现 | 服务端按 Free / Founder / Pro 校验月度 quota，并在 CLI Today/Dashboard 展示 |
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
9. `/loop`（本机迭代，关机即停）和定时巡检拆开：迭代收敛归 `/loop`，本机巡检用已实现的 cron 工具，云端例程归 `/schedule`（hosted，Milestone 3+）。
10. loop 的停止判断不由写代码的 agent 自评：用 deterministic verification 或独立 evaluator，也可挂载自定义验证 skill（借鉴 Claude Code 的 verify-skill 模式）。前提是先落地 `/goal` verification gate。
11. 不重复造轮子：`/loop` 的时间触发复用 agent-core cron scheduler，执行核复用 `/goal`，proof/judge 复用 verification 引擎。

## 版本发布序列

| 版本 | 目标 | 发布门槛 |
|---|---|---|
| `0.0.11` | 把当前产品做成可理解、可发现、可运维的 Hosted Evidence 闭环 | TUI 文案与对齐完成；Dashboard 证据优先布局上线；公告端点 200；`proof → private history / public share → dashboard` 真实链路通过；文档与实现一致 |
| `0.0.12` | 关闭付费生命周期缺口 | Stripe customer portal、取消/付款失败状态、grace 规则、Billing UI 与 entitlement 状态一致；至少能观察 install→proof→upload 转化 |
| `0.1.0` | 从个人报告工具进入真实 PR 工作流 | GitHub PR comment 与 status check 可用；visibility/redaction E2E 通过；至少 1 个 Team Pilot 在真实 repo 连续使用；0.0.11/0.0.12 无阻断级回归 |

`0.1.0` 的条件式目标是 **2026 年 8 月上旬，最早 8 月 3 日当周**。日期不是发布承诺；上表的 PR Evidence 和真实试点门槛未满足时不升 `0.1.0`。

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

状态：已实现。

目标：在 Loop Engineering 热度的窗口期内，用最低成本打出真正的产品核心——不是一个"更好的 coding agent"，而是一个 **AI Coding Loop 的控制层**。把已实现的工具层（verify/scan/guard/goal）用 `/loop` 编排起来，并以 `/proof` 作为可分享的 Wow Moment。

实施顺序固定为：**`/proof` → `/judge` → `/goal` verification gate → `/loop`**。理由：proof/judge 只是 verify+scan 的编排与重排版，便宜且先产出可分享物；judge-pass 与 goal gate 是 loop 停止判断的前提；loop 最后落地时只做编排，不引入新引擎。

### 交付项

**A. `/proof` Merge Proof Report（第 1 步，Wow Moment）**

- `/proof` TUI slash command + `wukong proof` CLI subcommand：依次运行 `verify` → `scan` → 汇总成一个固定格式的 Merge Proof Report。
- Merge Proof Report 字段：Status（PASS / BLOCKED）、changed files、tests pass/fail、typecheck、secrets scan、risky changes、guard violations、recommendation。
- 报告输出为本地 Markdown + JSON，离线可用。

**B. `/judge` evaluator-only 判定（第 2 步）**

- `/judge` TUI slash command + `wukong judge` CLI subcommand：默认 `--assume-broken`，复用 verification 引擎，只审不写，输出 BLOCK/PASS 结论。
- 默认模式是 deterministic 判定（离线免费）；fresh-context 第二 agent 审查（`--agent`，BYOK）排在 M0.5 末或 P1 初，落地前不对外宣传"第二 agent reviewer"。

**C. `/goal` verification gate（第 3 步，`/loop` 硬前置）**

- 现状：`/goal` 的完成判定是 agent 自评（agent 调用 goal 工具宣布 completed），可选 verify 字段只是自由文本提示，与"停止判断不由 agent 自评"的原则冲突。
- 交付：`/goal` 增加可选停止条件（verify-pass / scan-clean / judge-pass）；agent 宣布完成时自动运行对应评估，未过则拒绝完成并把失败反馈注入下一回合，受回合/预算上限约束。

**D. `/loop` 本机迭代 loop（第 4 步，核心）**

- `/loop` TUI slash command + `wukong loop` CLI subcommand。
- 核心语义 iterate-until-verified：驱动 agent 朝目标推进 → goal gate 评估 → 未过则注入失败反馈立即开始下一轮，直到停止条件满足、达到迭代上限或人取消。**关机即停。**
- `--every` 是可选的轮间最小间隔（节流，用于等 CI 等外部反馈），由 agent-core cron scheduler 驱动，不新写 timer。
- 定时巡检型任务不塞进 `/loop`：本机用 cron 工具，云端归 `/schedule`（hosted，Milestone 3+）。

**E. 文案**

- 文档与官网 hero 文案切换到 loop control plane / proof-layer 叙事。

### 不做

- 不做 `/ship` 发布 gate（更靠后，依赖 proof 先稳定）。
- 不做 `/schedule` 云端例程（归 hosted，Milestone 3+）。
- 不在此 milestone 接 hosted upload。
- 不为 `/loop` 新写定时引擎（复用 cron scheduler）。

验收：

- `wukong proof` / `/proof` 在干净项目产出 PASS 报告。
- 在含 placeholder/secret/失败测试的项目产出 BLOCKED 报告，并定位原因。
- `wukong judge --assume-broken` 在不干净项目直接给 BLOCK。
- 带停止条件的 `/goal`：agent 宣布完成但 verify 失败时，gate 拒绝完成并注入反馈继续，不由 agent 自评过关。
- `wukong loop "<目标>" --until verify-pass` / `/loop` 持续驱动：agent 改代码 → gate 评估 → 未过则继续，直到停止条件满足、达到迭代上限或人取消；关机即停。`--every` 复用 cron scheduler 实现轮间 pacing。
- `/loop` 达到迭代上限时明确返回 max-iterations 状态，不假装成功。
- 报告可被人读懂并定位失败原因。
- 官网 hero 切换为 loop control plane / proof-layer 文案后，不出现任何未实现能力的承诺（尤其不宣称 `/schedule` 云端例程、CI 集成、第二-agent 审查已可用）。

## Milestone 1: Hosted Reports MVP

状态：代码闭环已完成；`0.0.11` 负责生产部署与真实账号验收。

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

状态：部分实现。Hosted report quota 已由服务端控制；customer portal、付款失败/grace 状态和完整 Billing UI 仍未完成。

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
- 使用真实上传 report 作为 docs / pricing 演示素材，不制作 placeholder。
- Dashboard 继续围绕真实 report history、quota 和下一步动作优化。
- changelog 保持和公开 release 同步。

不要做：

- GitHub integration 未完成前，不宣称 PR gate 已可用。
- Deep review job API 未完成前，不宣称 deep review 已可用。
- Redaction、audit、private runner 未完成前，不宣称 security/compliance。

## CLI Roadmap

近期工作：

- 按 `/proof` → `/judge` → `/goal` verification gate → `/loop` 的顺序实现 Milestone 0.5（`/loop` 为本机迭代 loop，复用 cron scheduler 与 goal gate）。
- 保持 `verify` / `scan` / `proof` 登录态上传为 opt-in，默认私有；公开分享必须显式 `--public`。
- 在 Proof 结果后提示 hosted history / public share，在 Today 中显示登录用户的 hosted quota 与 Dashboard 链接。
- 公告与更新通道分离：公告 JSON 由 Web 静态文件维护，失败不阻塞 CLI。
- 本地 report 保持 offline 可用。
- 登录命令保持简单：OAuth first，不展示重复 platform choices。
- 终端 UI 保持紧凑、产品导向。

不要做：

- 在 report upload 闭环完成前，不把本地 agent 强行搬到 hosted web app。
- 付费 evidence 工作流未成立前，不继续堆游戏化功能。
- 不把本地 deterministic verification 放到付费墙后。
- 不把 `/schedule`（云端例程）在本机做；`/loop`（本机迭代，关机即停）与定时巡检（本机 cron 工具 / 云端 `/schedule`）拆开，跨机器持续性归 hosted。
- 不为 `/loop` 新写定时引擎；`--every` 节流必须复用 agent-core cron scheduler。

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
