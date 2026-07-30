# 0.1.0 之后候选：Loop-aware Runtime Security

> 状态：**DEFERRED / REQUIREMENTS ONLY**
> 记录日期：2026-07-21
> 最早重新评估时间：0.1.0 正式发布并完成验证之后
> 当前决定：0.1.0 之前不实现、不做实验、不接入 Prismor，也不对外承诺该能力

## 1. 决策摘要

本文只记录未来需求和设计边界，不是当前 roadmap、发布承诺或开工授权。

| 版本阶段 | 决策 |
| --- | --- |
| `< 0.1.0` | 禁止实现、POC、feature flag、依赖接入和公开宣传 |
| `0.1.0` | 明确不在范围内；0.1.0 只聚焦 Free Trusted Local Loop 稳定化 |
| `> 0.1.0` | 只有满足本文的重新进入条件后，才允许重新评估和排期；不自动进入 0.2.0 |

因此，在重新激活本需求前：

- 不新增 `SecurityEvaluator`、安全策略配置或安全相关命令；
- 不把 Prismor 加入依赖、安装脚本、运行时或发布产物；
- 不修改网站、README、定价页和 entitlement 文案；
- 不把该能力写入活跃 TODO 或 0.1.0 的验收范围；
- 不以“先埋接口”“先做一个隐藏开关”为由提前实现。

0.1.0 的当前范围以 [0.1.0 Trusted Local Loop](./0.1.0-trusted-local-loop.md) 为准。0.2.0 的有界并行与本机 Supervisor 也不等于完整 runtime sandbox。

## 2. 候选能力定义

暂定名称：**Loop-aware Runtime Security**。

它在工具实际执行之前，对工具名、参数、当前目标和 Loop 上下文进行确定性评估，并将安全决策作为 Loop 的约束和证据之一。

它需要回答两个不同的问题：

- Runtime Security：**这个工具调用现在是否允许执行？**
- Wukong Loop：**在当前执行过程和证据下，这个任务是否仍能可信地结束为 PASS？**

Wukong Code 的定位仍是交付型 coding agent，而不是通用 EDR、安全扫描平台或独立策略控制台。该能力只有在能增强 Loop 的执行可靠性时才值得进入产品。

## 3. 为什么推迟到 0.1.0 之后

这不是单一命令拦截功能。完整实现会同时影响：

- 工具调用热路径和执行延迟；
- Auto、YOLO、交互审批及 headless 模式的权限语义；
- MCP 工具的细粒度授权；
- secret 的存储、展开、日志和模型上下文边界；
- package install、lockfile 和供应链检查；
- Loop 终态、Proof、事件记录和恢复流程；
- macOS、Linux、Windows 的一致性；
- 误报率、绕过风险和故障时的 fail-open / fail-closed 决策。

在 0.1.0 之前引入这条能力线，会稀释 Trusted Local Loop 的安装、恢复、现有 Gate 和跨平台稳定性重点，也容易在安全边界尚未成立时产生过度承诺。已取消的隔离 worktree、Safe Promote 和 target Final Gate 不属于该前置基线。

## 4. 当前基础与缺口

Wukong Code 已经具备部分可复用基础，但它们不等于完整的运行时安全层：

- `PreToolUse` hook 在 YOLO 判断之前运行，具备执行前拦截位置；
- prepare pipeline 支持返回 `updatedArgs`，并能重新校验修改后的参数；
- 当前通用 hook 主要支持 allow / block，超时或启动失败可能继续执行；
- Auto 当前对 MCP 采用整体阻断，缺少按 server、tool、参数和目标授权；
- 当前 command risk guard 只覆盖有限的高风险命令模式；
- 普通工具授权失败通常会变成工具错误结果，尚未形成完整的 Loop 安全终态语义；
- 当前安全能力属于应用层 policy / guard，不是 OS sandbox，也不构成不可绕过的隔离边界。

未来应优先复用 prepare pipeline，而不是把每次安全判断简单实现为冷启动外部进程的通用 hook。

## 5. 未来目标

重新进入后，候选方案至少应覆盖以下目标：

1. **统一执行前决策**：支持 `allow`、`warn`、`ask`、`block` 和受控 `modify`。
2. **Goal / Loop Capability Envelope**：限定某个固定目标可使用的工具、路径、网络域名和依赖变更范围。
3. **原生审批衔接**：`ask` 使用 Wukong 现有交互审批和恢复机制，不建立第二套审批系统。
4. **细粒度 MCP 策略**：从“Auto 禁止全部 MCP”演进到按 server、tool、参数和目标授权。
5. **上下文安全的 secrets**：模型只看到占位符；执行前展开；工具输出进入日志或模型上下文前再次清理。
6. **供应链 Gate**：识别 package install、未知 registry、可疑包名和 lockfile 变化，并留下可验证记录。
7. **Loop-aware evidence**：将决策、审批、降级和未解决 finding 纳入 Loop 终态判断。

## 6. 明确非目标

- 0.1.0 之前不做任何形式的实现或试验；
- 不 fork、vendor 或硬依赖 Prismor；
- 不建立独立于 Wukong 的 dashboard、账号体系或远程控制面；
- 不默认使用 LLM 作为安全决策器；确定性规则必须可离线执行和测试；
- 不宣称“完全隔离”“绝对安全”“不可绕过”或把结果包装成 security proof；
- 不自动修改用户策略文件来消除冲突；
- 不因为可能成为 Team 付费能力就提前实现；商业分层必须晚于真实用户证据；
- 不替代 OS sandbox、容器隔离、代码签名、依赖审计或组织现有安全产品。

## 7. 候选核心契约

以下仅用于固定未来设计讨论的最小语义，不代表当前代码接口：

```ts
type SecurityAction = "allow" | "warn" | "ask" | "block" | "modify";

interface SecurityDecision {
  schemaVersion: 1;
  action: SecurityAction;
  ruleId: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  reason: string;
  remediation?: string;
  updatedArgs?: unknown;
  evidenceRef?: string;
  engine: string;
  latencyMs: number;
}

interface SecurityEvaluatorContext {
  sessionId: string;
  goalId?: string;
  loopId?: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  workspace: string;
  permissionMode: string;
  capabilityEnvelope?: CapabilityEnvelope;
}

interface SecurityEvaluator {
  evaluate(context: SecurityEvaluatorContext): Promise<SecurityDecision[]>;
}
```

契约需要满足：

- evaluator 必须在工具执行前运行；
- `modify` 后的参数必须重新做 schema validation 和安全评估；
- 单次工具调用最多允许一次自动修改，避免循环改写；
- 多条规则冲突时，强制阻断优先，不能由低优先级 allow 覆盖；
- YOLO 不能绕过 enforce 模式的安全阻断；
- `ask` 必须走 Wukong 原生审批，并能在恢复后关联原始 decision；
- observe 与 enforce 的故障语义必须显式区分，不能静默切换；
- decision、事件和 evidence 不得包含原始 secret、完整 prompt 或不必要的工具输出。

## 8. 模式与故障语义

候选模式：

| 模式 | 行为 |
| --- | --- |
| `off` | 不加载 evaluator，不生成安全 finding |
| `observe` | 执行评估并记录 finding，但不阻断工具调用；用于误报校准 |
| `enforce` | 执行并落实 `ask`、`block`、`modify` 等决策 |

在 `enforce` 下 evaluator 不可用时，不能悄悄退化成 `off`：

- 交互模式：暂停并要求用户决定重试、降级或终止；
- Auto / headless：结束为 `NEEDS_WORK`，原因记为 `security_evaluator_unavailable`；
- 只有用户预先明确配置了降级策略，才允许继续，并必须在最终结果中记录 degraded 状态。

策略文件无效、版本不兼容和 evaluator 超时也必须采用同样明确、可恢复的语义。

## 9. 与 Loop 终态的关系

安全 finding 是 Loop 证据的一部分，不是独立的“通过证明”。

- 某次危险尝试被阻断后，如果 agent 找到安全替代方案并完成验证，Loop 仍可继续；
- `enforce` 模式存在未解决的 block、待审批操作或 evaluator 降级时，Loop 不得结束为 PASS；
- `observe` finding 不直接阻断 PASS，但必须与运行模式一起记录，避免被误读为已执行保护；
- security decision 不能替代 tests、review、diff evidence 和现有 Gate。

候选稳定原因码：

- `security_blocked`
- `security_approval_required`
- `security_evaluator_unavailable`
- `security_policy_invalid`
- `security_modified_args_invalid`

## 10. Provider 架构候选

Wukong 应拥有稳定的 `SecurityEvaluator` 抽象，具体实现可以替换：

- **Native provider**：TypeScript 实现的最小确定性规则集，适合默认本地能力；
- **Prismor provider**：可选的本地 sidecar / adapter，用于更完整的策略能力；
- **Future provider**：组织自有 evaluator，但仍需遵守同一决策和 evidence 契约。

对 Prismor 的候选接入必须满足：

- 不在每次工具调用时冷启动 Python CLI；
- 使用有健康检查、版本协商和生命周期管理的常驻本地 sidecar；
- 默认只监听 loopback，不由 Wukong 托管远程控制面凭证；
- provider 缺失时不影响未启用该能力的普通 Wukong 安装；
- 优先通过上游稳定 adapter 集成，避免维护长期 fork；
- Prismor 的结果仍由 Wukong 转换为统一 decision，并纳入 Loop 语义。

## 11. 重新激活后的候选阶段

阶段不是当前排期，只定义未来合理的最小推进顺序。

### Phase A：契约与 Observe

- 完成 threat model、数据边界和 provider 契约；
- 只实现 deterministic observe mode；
- 增加 `status` / `doctor` 可诊断信息；
- 建立误报、漏报、延迟和敏感信息泄漏测试集；
- 不对用户默认开启，不形成阻断。

### Phase B：Enforce 与 MCP

- 接入 `ask`、`block`、`modify`；
- 固定规则优先级、超时和 provider 故障语义；
- 支持 MCP server / tool / args 级策略；
- 接入原生审批、恢复和 Loop reason code；
- 验证 YOLO、Auto 和 headless 下的不可静默绕过行为。

### Phase C：Secrets 与供应链

- secret placeholder、执行前展开和输出清理；
- package install、registry、包名相似度和 lockfile evidence；
- 建立跨平台 adversarial test corpus；
- 明确本地 secret store 和导入/撤销 UX。

### Phase D：审计与组织能力

- 在有真实 Team 需求后，再评估签名组织策略、集中审批和豁免流程；
- audit trail 至少包含 policy hash、decision hash 和离线校验方式；
- 组织功能不能改变本地 Free 用户已有的基本安全边界；
- 定价和 entitlement 必须另立商业需求，不在本文预设。

## 12. 未来验收要求

重新激活后，任何可发布实现至少应达到：

### 正确性

- 相同输入、策略和版本产生稳定、可解释的 decision；
- 参数修改后会重新校验，不能通过 `modify` 绕过 schema 或策略；
- policy 冲突、超时、崩溃和版本不兼容都有自动化测试；
- enforce 下未解决的安全状态不会得到 Loop PASS；
- 用户能看懂被阻断原因、规则来源和可执行的修复路径。

### 性能

- 不允许每个工具调用冷启动外部 runtime；
- native deterministic evaluator 的目标为本地基准 p95 不高于 20 ms；
- warm local sidecar 的目标为受支持基准 p95 不高于 150 ms；
- 超出预算必须可观测，并有明确超时和恢复策略。

这些数值是未来设计预算，正式实现前需要用固定机器、固定 corpus 重新基准测试。

### 数据安全

- 原始 secret 不进入模型上下文、普通日志、decision reason 或 telemetry；
- debug 模式也必须采用显式脱敏，不能靠调用方自律；
- 审计事件遵循数据最小化，默认只本地保存；
- provider 能读取的字段必须有清晰的数据流文档。

### 兼容性

- 明确 macOS、Linux、Windows 的支持矩阵和差异；
- provider 未安装或功能关闭时，现有 Wukong 行为保持兼容；
- 策略 schema 有版本号、迁移规则和向后兼容测试；
- 外部 provider 升级不能无提示改变 enforce 结果。

## 13. 重新进入条件

只有以下条件全部成立，才允许把本需求从 `DEFERRED` 改为候选排期：

1. 0.1.0 已正式发布，Trusted Local Loop 的稳定性、真实重复使用和继续/停止复盘已经完成；
2. 当前 Loop 的激活、完成率和恢复可靠性不存在优先级更高的发布阻塞；
3. 至少收集到 3 个目标用户的具体运行时安全问题，而不是抽象的“更安全”诉求；
4. 至少有 1 个可复现的危险工具调用案例，现有 permission / hook 无法合理覆盖；
5. threat model、数据边界、默认模式和故障策略已经评审；
6. 完成 native、Prismor provider 和不实现三种方案的成本比较；
7. 有明确 owner、测试 corpus、性能基准环境和回滚方案。

重新进入仍不等于承诺发布。Phase A 的 observe 数据需要再次支持是否继续推进。

## 14. Prismor 调研快照

Prismor 是本需求的重要参考实现，但不是既定依赖。以下结论仅代表 2026-07-21 的调研快照，后续重新评估时必须按当时版本复核。

参考资料：

- [Prismor 仓库](https://github.com/PrismorSec/prismor)
- [Prismor Releases](https://github.com/PrismorSec/prismor/releases)
- [Issue #27：脚本内容检查边界](https://github.com/PrismorSec/prismor/issues/27)
- [Issue #152：Codex secret redaction](https://github.com/PrismorSec/prismor/issues/152)
- [Issue #184：误报与默认拦截取舍](https://github.com/PrismorSec/prismor/issues/184)

本次调研看到的可借鉴点：

- 工具执行前的 allow / warn / block / step-up / modify 策略；
- MCP guardrail、secret cloak、供应链检查和 audit trail；
- 可测试的确定性规则和适配不同 agent 的 hook 机制。

同时存在需要保留的边界：

- 外层命令安全不代表解释器将执行的脚本内容安全；
- secret redaction 需要同时覆盖输入、执行参数、输出和模型上下文；
- 高误报规则会直接伤害 coding agent 的可用性；
- headless step-up、平台适配和 provider 故障语义必须实际验证；
- 调研基准中，逐调用启动 Prismor CLI 约为 400 ms/次，warm local sidecar 约为 100 ms/次，因此正式集成不能采用逐调用冷启动方案。

这些观察只用于约束未来架构选择，不构成采用 Prismor 的决定。

## 15. 待重新评估的问题

- 默认能力应由 native provider 提供，还是只提供 provider 接口？
- capability envelope 应由用户声明、Loop 推导，还是二者交集？
- policy 文件使用现有配置格式还是独立 schema？
- `warn` 是否只记录，还是在交互模式显示一次性提示？
- secret placeholder 如何与 shell、MCP 和第三方工具参数兼容？
- Windows 上能否达到与 macOS / Linux 相同的执行和 secret 边界？
- 哪些安全能力属于所有用户的本地基础能力，哪些组织治理能力才适合 Team？
- 外部 provider 的版本漂移和规则更新由谁批准、如何回滚？

## 16. 决策记录

- **2026-07-21**：记录 Loop-aware Runtime Security 作为 0.1.0 之后的候选需求。
- **2026-07-21**：明确 0.1.0 之前不实现、不试验、不接入 Prismor、不修改公开承诺。
- **2026-07-25**：0.1.0 改为 Free Trusted Local Loop；本候选仍后置，且不自动进入 0.2.0 Pro Reliable Autonomy。
- 下一次状态变化必须发生在 0.1.0 正式发布之后，并经过第 13 节的重新进入评审。
