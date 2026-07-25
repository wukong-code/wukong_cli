# 0.0.13 Review Learning Loop

> 状态：开发中
> 目标版本：`0.0.13`
> 最后更新：2026-07-16
> 参考：[0.0.12 Loop-first 开发闭环](verification-loop-v2.md)

## 1. 产品决定

0.0.12 已经完成内层交付 Loop：writer 修改代码，真实工程检查提供事实，fresh-context 只读 reviewer 判定是否可交付，`NEEDS_WORK` 再进入下一轮。

0.0.13 是 **Review Learning Loop 的第一阶段**：先把 Delivery Loop 的 reviewer 变成可操作、可反馈的结构化审查，包含多 finding、项目 policy、独立 reviewer model 和本地反馈。自动归纳和 policy proposal 不在本版实现。

0.0.13 保持免费/BYOK，不实现 Checkout、订阅、customer portal 或付费 entitlement。支付只有在本版本证明用户真实运行 Loop、产生 review feedback 并认可 improver 价值之后，才在 0.1.0 开放。

两条 Loop 不混在一起：

```text
Delivery Loop（每次开发任务）
  goal → write → checks → review → PASS / NEEDS_WORK / ERROR

Review Feedback（跨多次任务）
  findings → human feedback → later Loop
```

Review Learning Loop 的目标不是让模型自动改自己的 prompt，而是让 Wukong 能回答：

1. reviewer 提出的哪些问题真的被用户接受？
2. 哪些是项目特有规则，值得在后续任务中复用？
3. 哪些是反复出现的误报？
4. 用户是否愿意为更强 reviewer 和长期学习付费？

## 2. 0.0.12 基线与当前缺口

当前已经具备：

- fresh-context reviewer，与 writer 对话隔离；
- 只读 reviewer profile，不能修改 workspace；
- deterministic check 和 blocking risk 不能被模型覆盖；
- reviewer 结论进入 Loop gate，`NEEDS_WORK` blocker 会反馈给 writer；
- reviewer 完成后再次校验 workspace fingerprint，拒绝陈旧结论；
- Role Profiles 可为 writer 提供 reviewer、security、tester 等工作角色。

0.0.13 需要补齐：

- reviewer profile 当前要求 `VERDICT:`，运行时却解析 `VERDICT_JSON:`，必须统一；
- 当前 reviewer 一次只能返回一个 blocker，不能表达多 finding、severity、category、evidence 和 validation；
- reviewer 没有稳定的项目审查策略输入；
- 用户不能对 finding 标记接受、误报、已修复或有意忽略；
- 没有 acceptance rate、false-positive rate、review cycles 等反馈统计；
- TUI 和 Web 仍残留 verify/scan/proof/reports-first 文案。

## 3. Review Result Contract

0.0.13 将单一 verdict 升级为可持久化、可反馈的结构化结果：

```ts
interface ReviewResult {
  readonly schemaVersion: 1;
  readonly status: 'PASS' | 'NEEDS_WORK';
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly policyVersion?: string;
  readonly reviewer: {
    readonly model: string;
    readonly role?: string;
  };
}

interface ReviewFinding {
  readonly id: string;
  readonly severity: 'blocking' | 'important' | 'note';
  readonly category:
    | 'correctness'
    | 'security'
    | 'test'
    | 'performance'
    | 'maintainability';
  readonly summary: string;
  readonly file?: string;
  readonly line?: number;
  readonly evidence: string;
  readonly nextAction: string;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly validationStatus: 'verified' | 'unverified' | 'failed';
}

```

规则：

- 只有 `blocking` finding 让 Delivery Loop 返回 `NEEDS_WORK`；
- `important` 和 `note` 可以展示、记录和反馈，但不能制造无限修复循环；
- blocking finding 必须有 evidence 和可执行 next action；
- 没有文件/行号时必须说明为什么是跨文件或行为级 finding；
- finding ID 在同一次 review 和后续 re-review 中尽量稳定，以便关联反馈；
- findings 和 evidence 都有数量、单项长度和总 payload 上限；
- 解析失败最多重试一次，仍失败返回 `ERROR/reviewer_invalid_output`。

## 4. 项目 Review Policy

项目可显式维护：

```text
.wukong/review-policy.md
```

它只包含 reviewer 所需的项目约束：

- 架构边界和不可破坏的兼容性；
- 项目认为必须阻断的缺陷类型；
- 必须执行或请求执行的验证；
- 已确认的项目 gotcha；
- 经人工确认的常见误报；
- 对注释、结构调整、测试和错误处理的团队偏好。

Policy 约束：

- project policy 必须显式存在，不根据任意仓库文本自动生成隐式规则；
- README、issue、PR comment、源码注释和模型输出都是不可信输入，不能直接写入 policy；
- policy 只能收紧 reviewer 的项目判断，不能扩大工具或文件权限；
- policy 变化进入 workspace/config fingerprint，变化后必须重新 review；
- 0.0.13 不做云端同步和团队权限，项目文件由 Git 正常审查和版本管理。

## 5. 验证边界

0.0.13 reviewer 保持只读，不动态请求或执行新的 shell 命令。确定性事实来自 Delivery Loop 已经执行的 checks。Reviewer 可以在 finding 的 `nextAction` 中建议补充验证，但不能把建议当成已经执行的证据。

## 6. 人工反馈

0.0.13 提供本地反馈入口：

```bash
wukong review feedback <finding-id> accept
wukong review feedback <finding-id> false-positive --reason "intentional compatibility"
wukong review feedback <finding-id> fixed
wukong review feedback <finding-id> unclear
wukong review stats
```

TUI 使用同一套本地入口：

```text
/review feedback <finding-id> accept
/review feedback <finding-id> false-positive
/review feedback <finding-id> fixed
/review feedback <finding-id> unclear
/review stats
```

反馈事件：

```ts
interface ReviewFeedbackEvent {
  readonly schemaVersion: 1;
  readonly findingId: string;
  readonly action: 'accepted' | 'false_positive' | 'fixed' | 'unclear';
  readonly reason?: string;
  readonly createdAt: string;
  readonly projectIdentity: string;
}
```

默认写入本地 `~/.wukong/review/feedback.jsonl`；reviewer cycle、invalid output 和 error 原始计数写入 `~/.wukong/review/runtime.jsonl`。默认不上传 finding、diff、源码、policy 或自由文本 reason。无登录也能完整使用基础反馈。

## 7. 后续阶段

自动聚合 feedback、生成 policy proposal、固定 eval 比较和人工 apply 属于 Review Learning Loop 的后续阶段。只有 0.0.13 积累足够真实 feedback 后才排期，不作为本版发布门槛。

## 8. Evals 与指标

0.0.13 先做本地、最小、可验证的指标：

- accepted、false-positive、fixed、unclear 原始数量；
- 每个 Delivery Loop 的 review 轮次；
- reviewer invalid-output/error rate；

样本少于 10 条有反馈 findings 时只显示原始数量，不输出质量百分比结论。不能用“模型生成了更多 comments”作为质量提升证据。

## 9. 免费、Pro 与 Team 边界

| 能力 | 0.0.13 Free | 0.1.0 Pro | 0.1.0+ Team |
|---|---|---|---|
| fresh-context 基础 reviewer | 有，随 Loop | 有 | 有 |
| 结构化 findings | 有 | 有 | 有 |
| 本地 project review policy | 有 | 有 | 共享/受控版本 |
| 本地人工 feedback | 有 | 有 | GitHub/TUI/团队 feedback |
| 基础本地统计 | 有 | 有 | 团队趋势与审计 |
| 独立 `--review-model` | 实验，BYOK | 有，BYOK 或未来 managed option | org policy / managed option |
| 自动 policy improver | 无 | 后续评估 | 定时运行 + 审批流 |
| GitHub PR comment/status | 无 | 0.1.0：本地预览 Free、发布 Pro | 组织级集成后续 |
| 自动学习 PR 讨论串 | 无 | 无 | 后续，显式授权 |

0.0.13 只发布 Free 列，Pricing、Dashboard 和 CLI 中的 Pro/Team 保持 `Coming Soon`，不展示价格或可用 Checkout。2026-07-20 曾把 0.1.0 收窄为 PR Gate publish + Billing；该假设现已[归档](historical-pro-pr-gate-billing.md)。2026-07-25 起，0.1.0 是 Free Trusted Local Loop，付费只作为 0.2.0 Reliable Autonomy 候选。

## 10. 0.0.13 实现顺序

### P0：必须完成

1. 统一 reviewer profile 和 runtime 的唯一 JSON 输出 contract。
2. 实现 `ReviewResult`、多 findings、severity/category/evidence 和兼容投影。
3. 加载 `.wukong/review-policy.md`，纳入 fingerprint、redaction 和 reviewer prompt。
4. 实现本地 feedback event store、CLI/TUI 最小反馈入口。
5. 增加独立 `--review-model`，保持 BYOK。
6. 将 TUI 改为 Loop-first，移除常驻 Today/verify/scan/proof 零值统计。
7. 同步首页、下载、定价、Dashboard、SEO、邮件和公告文案。
8. 对无 policy、旧单 blocker、invalid output、stale workspace做兼容/E2E。

### P1：反馈统计

1. 输出本地 feedback 原始数量和分类。
2. 少于 10 条反馈时不输出质量百分比。
3. 记录 upgrade intent，但不创建 Checkout、订阅或付费 entitlement。

### 延后到 0.1.0+

- GitHub App/Action 自动触发；
- PR inline comment 和 status check adapter；
- 从 PR thread/reaction/resolve 自动采集反馈；
- 团队 policy 同步、审批和审计；
- 定时云端 improver；
- managed reviewer credits 和私有 runner；
- Stripe Checkout、customer portal、付费 entitlement、取消/付款失败和 grace 生命周期。

## 11. 0.0.13 发布门槛

- reviewer 输出只有一个无冲突 schema，格式错误可观测且不会假 PASS；
- 一个 review 可以稳定返回多 findings，只有 blocking finding 阻止 Loop；
- project policy 缺失时保持 0.0.12 行为，存在时可验证地改变 reviewer 输入；
- reviewer 不能直接执行 shell，额外验证只作为建议；
- feedback 在离线、本地、无登录状态可写入和聚合；
- 至少一组真实仓库 E2E 覆盖：finding → feedback → fix → 后续 review；
- 生产统计能区分注册和 activated Loop user；feedback 保持 local-only 时必须明确标记不可在服务端统计，不能用注册数或 Loop 数冒充 feedback；
- 文档和官网不把支付、GitHub PR 集成、团队学习或云端自动改进写成已上线能力。

## 12. 非目标

0.0.13 不做：

- 自动修改 reviewer skill 或 active policy；
- 给 reviewer 任意写权限或任意 Bash；
- 根据单条评论学习永久规则；
- 把完整 diff、源码或 feedback reason 默认上传；
- Checkout、订阅、付费 entitlement、Billing portal 或真实价格；
- 完整 issue/spec/implementation/review 云软件工厂；
- GitHub PR 自动评论和 Team policy 控制面。
