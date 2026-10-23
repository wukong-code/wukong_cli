# Wukong 能力体系与商业化原则

> 2026-10-23 方向同步：本地 CLI 的完整所需源码计划开源，官网后端私有；当前许可与
> 仓库可见性未变。收入先验证按次接入/验收陪跑，复购后再验证月度服务；当前边界见
> [开源与服务收费路线](open-source-and-service-strategy.md)，不继承本文旧产品层级。
>
> 状态：长期能力研究。版本与商业边界以仓库根 `ROADMAP.md` 为准（2026-10-23：现有本地 Loop 持续 Free + BYOK；0.1.3 交付验收服务试点候选；0.2.0 按交付阻碍精简；0.3.0 由付款、重复使用、续费和交付成本证据门控产品化）；本文中的旧 PR Gate、Managed Gate、价格与 tier 示例不构成当前计划。
>
> 阅读指引（2026-10-02 核对）：§2 品牌能力映射、§3 产品主次与 §5 权限不变量仍然成立，权限不变量已由 0.0.16 Permission Mode v2 实现；§6 商业分层、§7 Managed Gate 与 §8 中的 0.2.0 Reliable Autonomy 指导已过时（该候选已取代）。
>
> 日期：2026-07-20
>
> 适用范围：Wukong Code CLI、TUI、Web、Managed Gate 与后续 Team 产品

## 1. 核心判断

Wukong Code 不能只是给通用 Agent 功能套上《西游记》名称。产品能力、权限边界和商业化层级应来自孙悟空真正具有辨识度的能力：持续战斗、变化、分身、识破伪装、快速抵达、制止风险和承受失败。

统一产品公式：

```text
Loop 是产品主流程
分身是 Loop 的执行结构
火眼金睛与 Gate 是可信结论
Policy 与 Audit 是团队付费价值
```

对普通用户，Wukong 的承诺不是“管理多个 Agent”，而是：

> 给 Wukong 一个目标。它会变、会分、会辨、会战，直到验证通过。

英文对外口径：

> Give Wukong a goal. It transforms, delegates, verifies, and loops until done.

## 2. 品牌能力映射

| 孙悟空能力 | 产品含义 | 用户结果 | 商业角色 |
|---|---|---|---|
| 斗战到底 / 取经路 | 固定目标下持续写、查、审、修 | 任务不会停在“模型说完成”，而是进入明确终态 | Free 核心入口 |
| 七十二变 | 根据任务切换 Role、模型、工具与输出契约 | 同一个 Wukong 能成为不同领域的专家 | 基础 Role 免费；高级自定义 Specialist 属于 Pro 候选 |
| 身外身法 / 毫毛分身 | 独立上下文的 Explorer、Coder、Reviewer、Strategist | 并行探索、实现和独立复核，不污染主上下文 | 内置分身免费；托管并行和高级编排可收费 |
| 火眼金睛 | 独立 Reviewer 识别伪通过、遗漏和隐藏风险 | 降低错误合并，给出可复核结论 | Managed Gate 的首要付费价值 |
| 筋斗云 | 后台、远程、跨设备和云端执行 | 用户离开终端后仍能完成任务，更快得到结果 | Pro 托管能力候选 |
| 定身法 | 阻断危险操作、不合格 Gate 和高风险合并 | 风险被真正停止，而不是只收到一条提示 | Team policy / required Gate |
| 金刚不坏 | Sandbox、worktree 隔离、失败恢复和 durable state | Agent 出错时不破坏主工作区，并能继续执行 | Team / Enterprise 可靠性能力 |
| 如意金箍棒 | 工具、MCP、GitHub、CI 与项目命令的统一执行面 | Wukong 能在不同项目中调用合适工具 | 基础工具免费；组织级治理和集成可收费 |

品牌边界：

- **紧箍咒不是孙悟空自身的神通**，而是外部约束。它可以作为内部理解 Team Policy 的隐喻，但不作为官网主卖点。
- **大闹天宫不是高级权限模型**。Auto/YOLO 不能被包装成付费后获得无限权限；付费能力仍然受 hard deny、Role/Agent capability ceiling 和安全 Hook 约束。
- **取经是使命，不是单项工具**。它对应一条围绕固定目标推进到终态的 Loop，而不是新增 `/journey` 就完成品牌表达。

## 3. 产品主次

### 3.0 后续功能开发决策卡

任何新功能、命令、页面或付费权益进入版本计划前，必须先回答下面七个问题：

1. 它让哪个用户任务更容易进入 `PASS`、更快退出无效循环，或更可靠地恢复？
2. 它属于 Loop 主流程、分身执行结构、火眼金睛/Gate 结论，还是 Policy/Audit 治理？如果四者都不是，为什么仍值得成为 Wukong 核心功能？
3. 用户看到的是更简单的结果，还是被迫理解更多 Agent、命令、报告和配置？
4. 它对应哪项悟空能力，但即使去掉故事名称，是否仍有独立产品价值？
5. 它应属于 Free、Pro 或 Team？收费理由来自 Wukong 承担的模型/计算成本、显著更高的结果置信度，还是组织治理，而不是人为阉割基础 Loop？
6. 它是否扩大上传、网络、模型、工具或系统权限？如果是，默认值、用户确认、最小数据和审计边界是什么？
7. 用哪个真实行为指标证明它有效？不能只用页面上线、命令存在或调用次数作为成功指标。

立项模板：

```text
User job:
Loop failure or friction:
Wukong capability:
Smallest user-facing change:
Free / Pro / Team and why:
Permission and data boundary:
Success metric:
Explicit non-goals:
```

优先级规则：

- 优先修复“不能完成、无法验证、无法恢复”，再增加新的变身或分身。
- 优先让 Loop 自动选择正确 Specialist，再增加要求用户手工编排的 UI。
- 优先交付一个可信 Gate 结论，再增加 Report、Dashboard 或证据包装。
- 一个功能如果主要增加概念、步骤或配置，却不能提高 terminal rate、重复使用或合并置信度，默认不进入当前版本。
- 官网和付费文案只能描述已经可端到端验证的能力；规划中的神通必须明确写为 Preview、Pilot 或 Coming Soon。

### 3.1 Loop 是用户购买前先体验的产品

用户只需要给出目标和必要验收条件。Wukong 负责：

```text
Objective
  -> Plan / Acceptance Contract
  -> Write
  -> Deterministic Checks
  -> Independent Review
  -> Fix or Stop
  -> PASS / NEEDS_WORK / ERROR
```

分身默认由 Loop 自动选择。普通用户不需要先理解 Agent 数量、模型拓扑或角色配置。

### 3.2 分身是可靠完成任务的机制

分身不是为了制造热闹或展示并发，而是解决四个具体问题：

1. 隔离搜索、测试日志和大上下文。
2. 让写代码和审查代码由不同上下文完成。
3. 对停滞 Loop 切换一次解决策略。
4. 让每个角色拥有最小工具和权限。

因此，不按“解锁第几个分身”作为主要收费方式。只有 Wukong 承担模型或云端执行成本、提供并行隔离环境，或者提供团队治理时，分身用量才形成合理收费单位。

### 3.3 安全不是单独的扫描产品

Wukong 不与 SAST、SCA、secret scanner 竞争规则数量。现有测试、Semgrep、CodeQL、Snyk 等都可以成为 Gate 的输入。

Wukong 应销售的结果是：

> Agent Change Gate：让 AI 写出的修改在合并前满足既定验收合同和团队规则，并留下可审计证据。

## 4. Role、Specialist 与 Managed Gate

产品中必须保持以下术语边界：

| 概念 | 定义 | 默认层级 |
|---|---|---|
| Role | 修改主 Agent 的 prompt、表达方式和任务偏好，不创建独立上下文 | Free |
| Built-in Specialist | Wukong 内置的独立 Explorer、Coder、Reviewer、Planner/Strategist | Free |
| Custom Specialist | 用户定义的独立上下文、模型、工具白名单、输入输出和预算 | Pro 候选 |
| Managed Specialist | 由 Wukong 提供模型和执行成本的 Specialist | Pro / Credits 候选 |
| Team Specialist | 由团队创建、审核、签名、版本锁定并统一下发的 Specialist | Team |
| Managed Gate | Wukong 官方高级 Reviewer 对最小证据包进行独立验收并签发结论 | Pro 核心候选 |

基础 Role 不能假装成完整分身；完整分身必须有独立 Agent id、上下文、运行记录和能力边界。

### 4.1 Custom Specialist 最小契约

未来用户定义的 Specialist 至少需要支持：

```yaml
name: security-reviewer
description: Review authentication, permission, and sensitive-data changes.
model: wukong-premium
tools:
  allow:
    - read
    - search
    - git-diff
capability: read-only
inputs:
  - diff
  - test-results
  - policy
outputs:
  - findings
  - gate-decision
max_turns: 8
invoke_when:
  - auth-change
  - permission-change
  - secret-risk
```

契约要求：

- `description` 决定何时建议或自动调用。
- `inputs`、`outputs` 必须可校验；模型自然语言不能替代结构化结果。
- `model` 可以是用户 provider alias，也可以是明确的 Wukong managed capability。
- `tools` 和 `capability` 只能收窄基础权限，不能扩权。
- `max_turns`、token/cost budget、timeout 和取消必须进入运行时。
- 分身的实际模型、权限、输入范围和结果来源必须可展示、可记录。

## 5. 权限不变量

“Pro 高级权限”表示获得更多编排、模型和托管能力，不表示获得更危险的系统权限。

运行时必须满足：

```text
Effective Capability
  = System Safety Ceiling
  intersect Permission Mode
  intersect Base Agent Profile
  intersect Active Role Policy
  intersect Custom Specialist Declaration
```

强制规则：

- Reviewer、Planner、Strategist 和只读 Explorer 永远保持只读。
- 父 Agent 的 Auto/YOLO 不能为只读分身扩权。
- 用户付费不能绕过 explicit deny、Plan guard、安全 Hook、敏感路径或 workspace 边界。
- 未声明 capability metadata 的 custom/MCP tool 对只读分身默认拒绝。
- 用户定义分身可以少用工具，不能凭配置获得系统未授权的工具。

## 6. 商业分层

### 6.1 Free：先让用户看到完整神通闭环

- 完整本地 BYOK Loop。
- 内置 Explorer、Coder、Reviewer、Strategist。
- 基础 Role 与安全 Auto。
- 本地 deterministic checks、独立 review、记录和恢复。
- 不用低分身数量限制破坏第一次成功体验。

Free 的任务是证明用户能完成第一个 Loop 并重复使用，不是制造人为残缺。

### 6.2 Pro：七十二变 + 官方火眼金睛

Pro 候选权益：

- 创建和运行 Custom Specialist。
- 使用 Wukong Managed Specialist / Managed Model。
- Managed Gate：官方高级 Reviewer 独立验收。
- GitHub PR Gate comment/status publish。
- 有成本上限的后台执行、云端并行和跨设备恢复。
- 更长的私有运行历史和可下载证据。

Custom Specialist 是提高 Pro 吸引力和留存的高级权益；Managed Gate 是更清晰的购买理由。

### 6.3 Team：定身法 + 可审计治理

- 团队共享并版本锁定的 Specialist。
- Agent/Role 审批、签名和发布流程。
- 组织级 Policy、required Gate 和 exception approval。
- 模型、MCP、网络、Auto/YOLO 和预算控制。
- Agent provenance、Gate evidence 和 audit log。
- 私有 runner、SSO/SCIM/RBAC 等继续进入 Enterprise。

## 7. Managed Gate

推荐路径：

```text
User/BYOK Writer
  -> Local deterministic checks
  -> Minimal redacted evidence bundle
  -> Wukong Managed read-only Reviewer
  -> Signed Gate decision
  -> Optional GitHub PR publish
```

Managed Gate 的价值不是模型代理转售，而是提供独立、稳定、可追溯的验收：

- 写代码和最终审查由不同上下文或模型完成。
- Wukong 固定 review contract、模型 capability 和输出 schema。
- 结果绑定 commit SHA、workspace fingerprint、policy hash、reviewer/model version 和时间。
- 相同 SHA + policy + evidence 可以幂等更新同一个 PR Gate。

上线前必须满足：

- 用户显式选择上传，默认仍可完全本地运行。
- 默认只上传 diff、测试结果、风险摘要和必要上下文，不上传整个仓库。
- secrets 和敏感内容在客户端预检查、脱敏或阻断。
- Managed Reviewer 不执行仓库代码，不获得写工具。
- 仓库内容按不可信输入处理，防止 prompt injection 改写 Gate policy。
- timeout、provider failure 或 invalid output 返回 `NEEDS_WORK`/`ERROR`，绝不能自动 `PASS`。
- 清楚披露 Wukong 和模型供应商的 retention、region、training 和 deletion policy。
- 套餐包含明确 Gate 次数或 credits；不以“无限高级模型”制造不可控成本。

## 8. 版本指导

### 0.0.16：免费基础必须先可靠

0.0.16 继续免费/BYOK，优先完成：

- Loop acceptance contract 与 convergence。
- prior blockers、anti-ratchet 和 stall strategist。
- Permission Mode v2。
- 分身 capability ceiling 和 custom tool fail-closed。
- Role 的 inputs/outputs/capability contract 基础。
- 统一任务状态与可恢复记录。

本版本不销售 Custom Specialist，不上线 Managed Gate，不用未完成能力更新官网付费承诺。

### 0.1.0：Free Trusted Local Loop

0.1.0 不做付费实验。旧的 isolated worktree、Safe Promote 与 target Final Gate 方案已经取消；当前规格以 [0.1.0 Trusted Local Loop](../design/0.1.0-trusted-local-loop.md) 为准，把既有 Finish Line、reusable criteria 和 durable lifecycle 收敛为一条可控、可恢复、可解释的 Free + BYOK 单 Loop，重点补齐 call/token limits、no-check、文件归因、终态、兼容恢复和真实跨平台证据。完整多层 coverage schema 与 direct-shell content/PATH attestation 后移。单前台 Loop 不登录、不查 entitlement，也不设置 Wukong 商业次数或 token quota；用户主动配置的运行预算属于成本保护，不是付费配额。

### 0.2.0：Reliable Autonomy 邀请制候选（已取代）

> 2026-10-23：该候选及其购买归因、人数阈值全部归档；0.2.0 现为 Codebase Reduction。收入试点以 [0.1.3 候选](../design/0.1.3-delivery-acceptance-pilot.md) 为准，产品化归 0.3.0。以下只保留原版本记录。

0.2.0 候选验证用户是否愿意为 2–5 个有界并行任务、显式 Detach、本机 exception-first Supervisor 与可选 Verified PR Gate 组成的可靠自治 bundle 付费。一个候选月付 SKU `$12/月`；10 人受邀、5 人真实使用、3 人付款、2 人续费前不讨论 public Checkout。

`Custom Specialist`、Managed Gate/credits 与 Team 能力均不自动进入 0.2.0，必须分别验证隐私、成本和真实购买理由。

### 后续 Team

只有个人 Loop 完成、重复使用和 Pro 付费成立后，再实现共享 Specialist、组织 Policy、审批、审计、SSO 和 private runner。

## 9. 商业验证问题

未来访谈和实验需要分别回答：

1. 用户是否因为独立高级 Reviewer 而减少人工 review 时间或避免错误合并？
2. 用户是否愿意让最小代码证据发送给 Wukong Managed Gate？可接受的保留时间是什么？
3. 用户是为“创建自定义分身”付费，还是只在分身由 Wukong 托管、并行或共享时付费？
4. 哪些任务需要固定官方 Specialist，哪些必须由用户定义？
5. Team 购买的核心是更多 Agent，还是不可绕过的 Policy、审计和责任链？

关键指标：

- 首个 Loop terminal rate 和 7 日重复完成率。
- built-in/custom Specialist 的调用率、完成率和被用户采纳率。
- Managed Gate 的每次真实成本、延迟和 fallback 率。
- Gate blocking finding 的接受、修复和 dismiss 率。
- PR dry-run -> publish 的转化率。
- 每位付费用户在不同 PR 上重复使用 Managed Gate 的次数。

## 10. 文案规则

推荐：

- `Loop until verified.`
- `Built-in specialists when needed.`
- `Wukong Managed Gate for an independent final review.`
- `Policy-controlled, evidence-backed merge decisions.`

避免：

- “无限分身”或“Agent 数量越多越可靠”。
- “高级用户可以绕过安全限制”。
- “AI 保证代码安全”或把模型结论当安全认证。
- 把基础安全默认值包装成付费权益。
- 把未实现的云端、支付、Team、Managed Gate 或模型能力写成已上线。

当前商业叙事：

> Free 提供一个可信的本地 Loop；Pro 候选让一个人用有界并行和本机监督可靠推进更多工作。Wukong 不卖用户自己的 API Key。

## 参考

- [0.0.16 Loop Convergence](../design/0.0.16-loop-convergence.md)
- [0.1.0 Trusted Local Loop](../design/0.1.0-trusted-local-loop.md)
- [0.2.0 Pro Reliable Autonomy](../design/0.2.0-pro-reliable-autonomy.md)
- [历史候选：Pro PR Gate 与 Billing](../design/historical-pro-pr-gate-billing.md)
- [商业化与产品重构方案](COMMERCIAL_REFACTOR_PLAN.md)
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)
- [GitHub Copilot Plans](https://github.com/features/copilot/plans)
- [Cursor Pricing](https://cursor.com/pricing)
- [A Catalog of the Monkey King's Powers and Skills](https://journeytothewestresearch.com/wp-content/uploads/2024/08/A-Catalog-of-the-Monkey-Kings-Powers-and-Skills-COMPLETE-Updated-1.pdf)
