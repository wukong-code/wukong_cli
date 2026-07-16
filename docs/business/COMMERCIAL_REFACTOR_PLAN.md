# Wukong Code 商业化与产品重构方案

> 版本: v1.3
> 日期: 2026-07-14
> 当前范围: `wukong_cli` 新 Kimi-code base
> 技术落地: [商业化重构技术实现方案](../tech/commercial-refactor-implementation.md)

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

已实现的 TUI slash commands 包括 `/verify`、`/scan`、`/guard`、`/report`、`/goal`（含 verification gate 和队列）、`/proof`、`/judge`、`/loop`、`/today`。agent-core 另已实现会话内 cron 调度工具（CronCreate/CronList/CronDelete，支持 recurring/one-shot、持久化与 resume 恢复），是 `/loop` 时间触发的复用基础。Hosted Report 的登录上传、配额、历史和分享预览也已实现。

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

`/loop` 的核心语义是**迭代直到验证通过**（关机即停）：轮次自动衔接，`--every` 只是可选的轮间节流；时间触发复用 agent-core 已有 cron scheduler，不新写定时引擎。定时巡检型任务本机由 cron 工具承载，云端归 `/schedule`（hosted，Milestone 3+）。0.0.12 的 `/goal` 出口已经统一为 `proof-pass`：先运行 deterministic checks，再由 fresh-context 只读 reviewer 判定，写代码的 agent 不能自判通过。

用户在 Claude Code、Cursor、Copilot、Codex 或其他 agent 生成代码后，用 Wukong 运行确定性检查、扫描风险、生成证据报告，再决定是否相信、提交或合并。Wukong 补上 agent 最薄弱的一环：

- 验证是否真的跑过。
- 识别 placeholder、mock、skipped test、secret-looking diff、危险命令等风险。
- 产出可被人和团队审计的交付证据（Merge Proof）。
- 在终端层约束 agent 的高风险操作。
- 用 `/loop`（本机）和 `/schedule`（云端）把"写 → 验 → 修"串成自动循环，把人从持续 prompt agent 的位置移出来。

## 2. 悟空能力映射

| 悟空能力 | 产品含义 | CLI 目标 |
|---|---|---|
| 火眼金睛 | 风险识别 + 只审不写 | `scan`、risk rules、secret scan、`judge` |
| 金箍棒 | 标准化验证执行 | `verify`、`proof`、`test`、`ship`、report |
| 紧箍咒 | 权限约束 | `guard`、policy、command confirmation |
| 分身术 | agent 能力分发 | `wukong_verify` tool / MCP bridge |
| 筋斗云 | 持续驱动与远程能力 | `loop`（本机迭代）、cron 工具（本机巡检，已实现）、`schedule`（云端例程）、`sync`、cloud reports |
| 七十二变 | 专家模式 | 实验性 Role Profiles：可选择 agent 角色、prompt 与工具约束 |
| 取经路 | 成长与复盘 | `today`（日简报+focus）、`retro`（周）、`journey`（长期），P1+ |

## 3. 目标命令结构

### P0: 本地闭环（已完成）

| 命令 | 状态 | 目标 |
|---|---|---|
| `wukong verify` | 已实现 | 运行确定性检查并生成本地证据报告 |
| `wukong scan` | 已实现 | 只读风险扫描，不运行项目命令 |
| `wukong guard` | 已实现 | 本地 guard 状态、统计和命令风险阻断 |
| `wukong_verify` tool | 已实现 | 让外部 agent 在完成前调用验证 |
| `/verify`、`/scan`、`/guard`、`/report` | 已实现 | TUI 会话内运行验证、扫描、guard 状态和查看报告 |
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
| `/today` | TUI 已实现 | **Daily Proof Briefing**：今日 verify/scan/proof/guard 统计 + 工作区快照 + streak + 基于状态的 Next；top-level `wukong today` 尚未提供。详见 [today 设计](../design/today.md) |
| `wukong review` | 待实现 | AI 辅助代码审查，消耗 credits 或本地模型 |
| `wukong test` | 待实现 | 项目测试入口和模板化测试策略 |
| `wukong ship` | 待实现 | proof + 版本/changelog/dry-run 发布前 gate |
| `wukong retro` | 待实现 | 生成迭代复盘和质量趋势（周维度，依赖 stats） |

### P2: 云端与团队

| 能力 | 状态 | 目标 |
|---|---|---|
| hosted reports v1 | 已实现 | 登录上传、配额、历史和分享预览；Evidence v2/redaction contract 后续完善 |
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
| 第二层：Developer Feedback Loop | 人看报告、决定接受、更新规则 | `/proof`、`/judge`、`/report`、`/today`、`/sessions`、`/undo`、`/rules`(待实现) | 本地证据与 TUI briefing 已实现；共享 rules 待实现 |
| 第三层：External Feedback Loop | 用户 bug、CI 失败、issue、PR review 回到 loop | GitHub Issues、CI、Sentry、Linear、Slack 集成 | 未实现，归 hosted/CI |

## 3.2 Loop 代码质量保障原则

借鉴 Claude Code 的 loop 设计经验，loop 输出质量取决于围绕它的系统。设计 loop（`/goal`、`/loop`、`/schedule`）时遵循：

1. **保持代码库整洁**：agent 遵循 codebase 已有的模式和约定。
2. **给 agent 自验证能力**：用 deterministic verification（`verify`/`scan`）和自定义验证 skill 编码"什么叫好"；检查越定量越有效。
3. **文档可达**：框架/库文档保持最新最佳实践。
4. **用第二 agent 做审查**：Loop 的 `proof-pass` gate 已在 deterministic proof 通过后启动 fresh-context 只读 reviewer，降低写代码 agent 的自评偏见；standalone `/judge` 仍保持 deterministic evaluator，不混淆两者。

## 4. 商业模型

0.0.12 只用受额度限制的免费 Loop 验证重复使用和升级意愿。`verify`、`scan`、`proof` 是 Loop 内部能力和高级诊断入口，不分别售卖、不单独计费；未来付费边界包括更多 Loop sessions、更长迭代、深度模型审查、团队策略、PR gate、审计和 Wukong 自有 API 服务。

核心收费原则：

```text
用户自带 API Key = 模型成本归用户
Wukong 收费 = 更多 Loop sessions、更强 reviewer、团队角色、PR 协作、策略和审计
Wukong 托管模型调用 = 作为可选 credits / add-on 收费
```

| 层级 | 建议权益 |
|---|---|
| Free | BYOK、10 Loop sessions/月、每次最多 5 轮、基础 roles/guard；第 3 次起提示 Pro |
| Pro | BYOK、更多/更长 Loop、deep reviewer、更多角色、可选 evidence history/share |
| Team | org-level BYOK、共享 Role Profiles、GitHub PR gate、团队规则和审计日志 |
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
- 10 Loop sessions/month, max 5 iterations/session; show a Pro prompt from session 3
- Advanced verify/scan/proof diagnostics remain available without a separate quota
- Fresh-context reviewer with a configured alias
- Evidence is saved/uploaded only when requested

Pro $8-12/user/month
- BYOK
- More and longer Loop sessions
- Deep reviewer workflows
- More custom roles
- Optional evidence history and share links

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
| 基础 `wukong guard` / `guard --status` | 暂不限制 | P0 guard 是 best-effort，不能作为强安全付费承诺 |
| provider/login/doctor/export | 暂不限制 | 属于基础 CLI 使用、诊断和迁移能力 |

未登录用户可运行 1 个最多 2 轮的 Loop。免费额度必须足以产生第一次真实结果，但不能长期替代 Pro。参数校验和 plan 建立在 usage start 前完成；start 成功后即计数，取消或崩溃不回退。默认不生成报告，只有显式 `--save`/`--upload` 才产生 evidence。

### 4.3 适合收费的功能

付费点建立在“更高 Trust Loop 用量、团队协作、云端证据、模型能力和审计责任”上。四个命令不分别售卖，Pro 解锁整条 Trust Loop。

| 收费功能 | 推荐层级 | 价值 | 当前状态 |
|---|---|---|---|
| Hosted Reports / 分享链接 | Pro / Team | 上传 redacted report，生成可分享链接，保留历史记录 | 已实现基础闭环；0.0.12 补 v2 schema |
| 更多 Loop + Deep Reviewer | Pro | 更长迭代、fresh-context 深度审查和更具体的修复反馈 | 0.0.12 先做 BYOK 基础版；Pro 价值待验证 |
| Wukong Product APIs | Pro / Team | report upload/share、PR comment/gate、rules evaluate、redaction、audit events | 部分实现：report upload/share 已有，其余待实现 |
| Managed Model Add-on | Pro / Team / Credits | Wukong 提供托管模型调用，解决用户不想配置 key 的场景 | 待实现 |
| Team Rules | Team | 团队统一验证命令、风险阈值、路径策略和 guard policy | 待实现 |
| GitHub PR Gate / CI Gate | Team | PR 自动跑 verify/scan，发布检查状态和 report link | 待实现 |
| Audit Log | Team / Enterprise | 记录谁验证、谁 override、失败原因和最终交付证据 | 待实现 |
| Agent Enforcement | Team | 要求 agent 完成前必须调用 `wukong_verify`，否则标记未完成 | 部分实现：tool 已有，策略层待实现 |
| Enhanced Guard Policy | Pro / Team | shell hook、PATH shim、集中规则、危险命令审计 | 待实现 |
| Saved/Shared Evidence | Pro / Team | 用户明确需要协作或审计时保存、分享 | 已实现基础闭环；不是默认工作流 |
| Quality Trend | Pro / Team | 失败率、风险类型、skipped test、mock/placeholder 趋势 | 待实现 |
| Private Runner / 私有部署 | Enterprise | 私有网络内运行验证、保留源码不出域 | 待实现 |
| SSO / 合规 / SLA | Enterprise | 企业采购和合规要求 | 待实现 |

### 4.4 收费优先级

建议按以下顺序推进：

1. 更多/更长 Loop + deep reviewer：最接近日常重复价值。
2. Team Role Profiles + Team Rules + PR Gate：把个人 Trust Loop 变成团队流程。
3. Wukong Product APIs：提供 PR gate、rules、audit 和显式 evidence sharing 的服务边界。
4. Managed Model Add-on：Wukong 承担模型成本时再引入独立 credits。
5. Saved/Shared Evidence 与 Audit Log：只服务明确的协作和审计需求，不作为所有用户的前置流程。

当前阶段先完成 0.0.12 免费 Trust Loop 的真实使用验证，再在 0.0.13 做 **真实付费 Preview / design partner**。Hosted report 与安装路径已有基础闭环；公开自助收费前还需要完成 billing 生命周期、稳定的 v2 entitlement、明确的个人/团队权益和真实付款验收。

### 4.5 商业验证门槛

0.0.12 只判断“用户是否反复使用、免费额度是否形成压力”，不宣称已验证付费意愿。初始方向性门槛：

- 至少 20 个完成首个 Proof 的 activated users，且累计至少 50 次完成的顶层 Trust Run；样本不足只记录现象，不做商业结论。
- activated users 的 7 日重复使用率达到 25% 以上。
- 至少 15% activated users 触达 80% 用量或 quota warning。
- 触达 warning 的用户中，至少 10% 点击升级或主动请求更多额度；这仍只是升级意向。

0.0.13 才验证真实付费：使用真实价格和 Checkout，观察付款完成、退款/取消与次月续费。进入公开 Pro 前至少需要 3 个非关联真实付款用户或 1 个付费 Team Pilot，并出现至少 1 个续费/持续付费信号；未满足时继续 design-partner 试点，不用虚假 Free 订阅记录替代付费证据。

## 5. 实现优先级

### P0 已完成

1. `packages/verification` 独立核心包。
2. `wukong verify` CLI command。
3. `wukong scan` CLI command。
4. `wukong guard` CLI command，先做 best-effort interactive guard。
5. `wukong_verify` builtin agent tool。
6. TUI slash commands: `/verify`、`/scan`、`/guard`、`/report`。
7. `/goal` 持续修复（单任务跑到验证条件满足，含队列）。
8. fixtures、unit tests、CLI/TUI/tool smoke tests。

### P0.5 已完成：Loop 控制层 + Merge Proof v1

1. `/proof` Merge Proof Report：verify+scan+report 固定格式汇总（Wow Moment，第 1 步）。
2. `/judge` evaluator-only 判定：默认 `--assume-broken`，deterministic 模式复用 verification 引擎（第 2 步）。
3. `/goal` verification gate：agent 宣布完成 → 强制 deterministic 评估 → 未过打回（第 3 步，`/loop` 硬前置）。
4. `/loop` 本机迭代 loop：驱动 agent + 验证 + 修复直到停止条件满足，复用 cron scheduler 与 goal gate，关机即停（第 4 步，产品核心）。
5. 文档与官网 hero 切换到 loop control plane / proof-layer 叙事。

### Hosted Evidence 基线已完成

1. report history / redaction metadata。
2. cloud report metadata upload 与显式公开分享。
3. hosted report quota 基础边界。

### 当前重点：0.0.12 Free Trust Loop v2

1. 重写 Loop 的 snapshot、状态与错误 contract；verify/scan/proof 变成内部检查层。
2. 只实现 Loop session 额度，以及幂等 start/complete/usage；不引入 Checks、reservation/lease。
3. Loop 支持用户指定 writer model/role，并使用 fresh-context reviewer；reviewer 不能覆盖真实失败。
4. 增加轻量 Role Profiles（内置、本地自定义、`--role`、`/transform`），不建立第二套 agent。
5. 旧 verify/scan/proof 命令兼容但从主入口隐藏；evidence history 保持次级。

### P0 不做

- 不做完整云端商业闭环。
- 不做 Team/Enterprise。
- 不做“不可绕过”的安全承诺。
- 不发布尚未存在的 install script、Homebrew formula 或旧包名。
- 不把 legacy `packages/cli` / `packages/mcp-server` 复制为长期架构。
- 不把 `/schedule`（云端例程）在本机做；`/loop`（本机迭代，关机即停）与定时巡检（本机 cron 工具 / 云端 `/schedule`）拆开，跨机器持续性归 hosted。
- 不为 `/loop` 新写定时引擎；时间触发复用 agent-core cron scheduler。

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

Wukong 的 0.0.12 内核已经形成本地 CLI/TUI/agent 闭环：deterministic verification、risk scan、best-effort guard、Merge Proof、fresh-context reviewer、Role Profiles、配额与三态 Loop。P0.5 的 proof → judge → goal gate → loop 已完成。下一阶段重点是 Hosted Evidence v2、redaction/report history、团队规则、跨会话 loop（hosted/CI）和完整计费边界，把本地 Loop 价值转成可收费的协作与审计能力。

一句话：**AI 负责写代码，Wukong 负责判断能不能合并，并用 loop 持续驱动这件事直到成立。**
