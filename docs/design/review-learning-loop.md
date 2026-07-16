# 0.0.13 Review Learning Loop

> 状态：计划中
> 目标版本：`0.0.13`
> 最后更新：2026-07-16
> 参考：[0.0.12 Loop-first 开发闭环](verification-loop-v2.md)

## 1. 产品决定

0.0.12 已经完成内层交付 Loop：writer 修改代码，真实工程检查提供事实，fresh-context 只读 reviewer 判定是否可交付，`NEEDS_WORK` 再进入下一轮。

0.0.13 在它之外增加一条独立的 **Review Learning Loop**：收集人类对 reviewer finding 的确认、反驳和修正，把重复出现且有证据的反馈整理成项目审查策略提案，经评估和人工批准后用于后续 review。

0.0.13 保持免费/BYOK，不实现 Checkout、订阅、customer portal 或付费 entitlement。支付只有在本版本证明用户真实运行 Loop、产生 review feedback 并认可 improver 价值之后，才在 0.1.0 开放。

两条 Loop 不混在一起：

```text
Delivery Loop（每次开发任务）
  goal → write → checks → review → PASS / NEEDS_WORK / ERROR

Review Learning Loop（跨多次任务）
  findings → human feedback → synthesize → evaluate → approve → review policy
```

Review Learning Loop 的目标不是让模型自动改自己的 prompt，而是让 Wukong 能回答：

1. reviewer 提出的哪些问题真的被用户接受？
2. 哪些是项目特有规则，值得在后续任务中复用？
3. 哪些是反复出现的误报，应当被抑制？
4. policy 调整后，review 质量是否通过固定 eval 得到改善？

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
- 没有 acceptance rate、false-positive rate、review cycles、cost 等 eval；
- 没有外层 improver，也没有安全的 policy proposal/approval 流程。

## 3. Review Result Contract

0.0.13 将单一 verdict 升级为可持久化、可反馈的结构化结果：

```ts
interface ReviewResult {
  readonly schemaVersion: 1;
  readonly status: 'PASS' | 'NEEDS_WORK';
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly validationRequests: readonly ValidationRequest[];
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

interface ValidationRequest {
  readonly command: string;
  readonly reason: string;
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

## 5. 受控验证请求

Reviewer 继续保持只读，不直接获得任意 Bash 权限。需要验证某个假设时，返回 `validationRequests`：

```json
{
  "command": "pnpm test -- auth",
  "reason": "验证 refresh token 并发路径"
}
```

Loop orchestration 负责：

1. 检查命令是否来自 `.wukong/checks.json`、已发现 package script 或用户已授权的 project command；
2. 拒绝未授权、交互式、网络写入或可能改变 workspace 的命令；
3. 用现有 deterministic runner 执行；
4. 将结构化结果返回同一个 fresh reviewer；
5. 每轮 validation request 有次数和时间上限，不能递归请求。

这样保留“reviewer 先验证再建议”的价值，同时不破坏 read-only 和 prompt-injection 边界。

## 6. 人工反馈

0.0.13 提供本地反馈入口：

```bash
wukong review feedback <finding-id> accept
wukong review feedback <finding-id> dismiss --reason "intentional compatibility"
wukong review feedback <finding-id> fixed
wukong review feedback <finding-id> unclear
```

TUI 只显示简短动作：

```text
[accept] [false positive] [fixed] [unclear]
```

反馈事件：

```ts
interface ReviewFeedbackEvent {
  readonly schemaVersion: 1;
  readonly findingId: string;
  readonly reviewId: string;
  readonly action: 'accepted' | 'dismissed' | 'fixed' | 'unclear';
  readonly reason?: string;
  readonly createdAt: string;
  readonly projectIdentity: string;
  readonly policyVersion?: string;
}
```

默认写入本地 `~/.wukong/review/feedback.jsonl`。默认不上传 finding、diff、源码、policy 或自由文本 reason。无登录也能完整使用基础反馈。

## 7. 外层 Improver

实验入口：

```bash
wukong review improve --since 30d
```

状态机：

```text
COLLECT
  读取有人工反馈的 findings 和关联 review metadata
    ↓
CLUSTER
  聚合重复规则、重复误报和验证偏好
    ↓
PROPOSE
  生成 policy patch，每条变化引用来源和置信度
    ↓
EVALUATE
  对固定 eval cases 运行旧 policy / 新 policy 对比
    ↓
APPROVAL_REQUIRED
  用户审查 patch
    ↓
APPLY / REJECT
```

提案写入：

```text
.wukong/proposals/review-policy-<timestamp>.patch
.wukong/proposals/review-policy-<timestamp>.json
```

安全门槛：

- 0.0.13 永远不自动修改 active policy；
- 默认至少 3 条一致、可追溯的人工反馈才形成新规则；
- 每条提案必须列出来源 finding ID、反馈动作、理由和 confidence；
- 安全规则不能仅凭 dismiss 反馈自动删除；
- 新 policy 的固定 eval 不得比旧 policy 更差，否则提案标记 rejected；
- proposal agent 无 GitHub 写权限，不自动建 PR、commit 或 push；
- 用户批准后仍走普通文件 diff 和项目 review。

## 8. Evals 与指标

0.0.13 先做本地、最小、可验证的指标：

- finding acceptance rate；
- false-positive/dismiss rate；
- finding fixed rate；
- 每个 Delivery Loop 的 review 轮次；
- 同类 finding recurrence；
- reviewer invalid-output/error rate；
- reviewer latency 和可获得时的 token/cost；
- policy version 前后的固定 eval 变化。

样本少于 10 条有反馈 findings 时只显示原始数量，不输出质量百分比结论。不能用“模型生成了更多 comments”作为质量提升证据。

## 9. 免费、Pro 与 Team 边界

| 能力 | 0.0.13 Free | 0.1.0 Pro | 0.1.0+ Team |
|---|---|---|---|
| fresh-context 基础 reviewer | 有，随 Loop | 有 | 有 |
| 结构化 findings | 有 | 有 | 有 |
| 本地 project review policy | 有 | 有 | 共享/受控版本 |
| 本地人工 feedback | 有 | 有 | GitHub/TUI/团队 feedback |
| 基础本地 eval | 有 | 有 | 团队趋势与审计 |
| 独立 `--review-model` | 实验，BYOK | 有，BYOK 或未来 managed option | org policy / managed option |
| `review improve` | 本地 proposal/eval | 更长历史和更高额度 | 定时运行 + 审批流 |
| GitHub PR comment/status | 无 | 无 | 0.1.0 Team Pilot |
| 自动学习 PR 讨论串 | 无 | 无 | 0.1.0+，显式授权 |

0.0.13 只发布 Free 列，Pricing、Dashboard 和 CLI 中的 Pro/Team 保持 `Coming Soon`，不展示价格或可用 Checkout。0.1.0 才开放付费。未来收费点是更强 reviewer、更多 Loop、长期学习、团队共享策略、PR 协作和审计，不是把本地 JSON 或规则文件本身收费。

## 10. 0.0.13 实现顺序

### P0：必须完成

1. 统一 reviewer profile 和 runtime 的唯一 JSON 输出 contract。
2. 实现 `ReviewResult`、多 findings、severity/category/evidence 和兼容投影。
3. 加载 `.wukong/review-policy.md`，纳入 fingerprint、redaction 和 reviewer prompt。
4. 实现受控 validation request，复用现有 check runner 和 project trust。
5. 实现本地 feedback event store、CLI/TUI 最小反馈入口。
6. 实现基础 eval 聚合和 JSON 输出。
7. 对无 policy、旧单 blocker、invalid output、stale workspace、validation 拒绝做兼容/E2E。

### P1：实验能力

1. `wukong review improve --since` 只生成 proposal。
2. 固定 eval fixture 与 policy before/after 对比。
3. `--review-model` 和 role 独立 reviewer model，仍为 BYOK。
4. 记录 upgrade intent，但不创建 Checkout、订阅或付费 entitlement。

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
- reviewer 不能直接执行 shell，未授权 validation request 被拒绝；
- feedback 在离线、本地、无登录状态可写入和聚合；
- improver 不能自动应用 policy，所有提案可追溯并经过 eval；
- 至少一组真实仓库 E2E 覆盖：finding → feedback → proposal → eval → 人工 apply → 后续 review；
- 生产统计能区分注册、activated Loop user、review feedback 和 proposal，不能用注册数冒充使用量；
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
