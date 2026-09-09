# Wukong Code Roadmap

> 最后更新: 2026-09-03
> 范围: `wukong_cli` 产品内核、`wukong_web` 托管产品、`wukong.today` 公开安装与官网路径。

`0.1.1` Reliability And Trust Boundary 延续 Trusted Local Loop，只修复 Loop
revision、Resume、Provider、Web、更新、插件供应链和 workspace checks 可靠性；
不新增命令、不改变 Gate 语义，也不包含 Cost Visibility。
产品继续 Free + BYOK；隔离 worktree / Safe Promote 实验已经取消，当前没有付费
计划、Checkout 或 entitlement。

当前版本真相源：

- [0.1.1 Reliability And Trust Boundary](docs/releases/0.1.1.md)
- [0.1.2 First Success And Surface Simplification](docs/design/0.1.2-first-success-and-surface-simplification.md)
- [0.0.18 Loop-First Simplification](docs/design/0.0.18-loop-first-simplification.md)
- [0.0.19 Explicit Finish Line](docs/design/0.0.19-explicit-finish-line.md)
- [0.0.20 Reusable Verification Criteria](docs/design/0.0.20-reusable-verification-skills.md)
- [0.0.21 Loop Evidence Integrity](docs/design/0.0.21-loop-evidence-integrity.md)
- [0.0.21 Release Notes](docs/releases/0.0.21.md)
- [0.0.22 Release Notes](docs/releases/0.0.22.md)
- [0.1.0 Trusted Local Loop（已发布）](docs/design/0.1.0-trusted-local-loop.md)
- [TODO.md](TODO.md)：本仓库执行层任务清单，按本 ROADMAP 的版本拆解
- `wukong_web/TODO.md`：官网与托管产品 TODO，位于 sibling web 仓库中

更后版本候选：

- [0.2.0 Pro Reliable Autonomy](docs/design/0.2.0-pro-reliable-autonomy.md)
  - [Bounded Parallel Loop 组件](docs/design/0.2.0-bounded-parallel-loop.md)
  - [Local Loop Supervisor 组件](docs/design/0.2.0-local-loop-supervisor.md)

下列商业化或旧版本设计只作历史探索/追溯，不是当前执行真相源：

- [已取消：0.0.21 Isolated Loop Worktrees](docs/design/0.0.21-isolated-loop-worktrees.md)
- [商业化与产品重构方案](docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- [Wukong 能力体系与商业化原则](docs/business/WUKONG_CAPABILITY_MODEL.md)
- [商业化重构技术实现方案](docs/tech/commercial-refactor-implementation.md)
- [0.0.12 Trust Loop v2](docs/design/verification-loop-v2.md)
- [0.0.16 Loop Convergence](docs/design/0.0.16-loop-convergence.md)
- [0.0.17 Command Surface Reliability](docs/design/0.0.17-command-surface-reliability.md)
- [历史候选：Pro PR Gate 与 Billing](docs/design/historical-pro-pr-gate-billing.md)

## 产品判断

Wukong Code 不要求用户放弃 Cursor / Claude Code / Codex。0.0.14 的入口是恢复这些工具里未完成的任务，再用 Loop 把它推进到清晰的 Gate 结论。

定位是：

> **Resume the task. Loop until the Gate passes.**
> 从其他 Agent 接着做，在 Wukong 里持续修改、检查和审查，直到 Gate 通过。

当前楔子是：

```text
Cross-Agent Resume + 本地 AI coding Loop + 清晰 Gate
```

差异化叙事不再以"又一个 coding agent"为主，而是围绕 Loop Engineering：Wukong 是 AI Coding Loop 的控制层与验证层。

当前产品层级只有 Free + BYOK。0.1.0 继续免费；0.2.0 只记录“有界并行 + 显式 Detach + 本机 Supervisor + 可选 PR Gate”的邀请制 Pro Pilot 候选。Custom Specialist、Managed Gate、托管并行、团队治理和 managed credits 不在该候选范围，不能从历史文档推断版本承诺。

命令分层参考 loop engineering 的谱系，但 Wukong 不照搬 Claude Code 的命令命名：

| 层 | Wukong 能力 | 触发 | 停止 | 状态 |
|---|---|---|---|---|
| Turn-based | TUI 默认 agentic loop | 用户 prompt | agent 自判完成 | 已实现 |
| Internal goal engine `/goal` | Loop 内部单任务执行核；默认隐藏但保留直接调用 | 实时手动 | agent 自评完成 or 回合/预算上限 or verification gate | 已实现 |
| Wukong delivery `/loop` | goal-driven、iterate-until-verified 的本机交付循环 | 用户启动，轮次自动衔接 | Gate PASS or 迭代/预算上限 or 取消 | 已实现 |
| Local recurring | agent-core cron 工具承载本机定时巡检 | 时间/计划 | 取消 or 任务规则结束 | 已实现；不占用 `/loop` 语义 |
| Cloud routine `/schedule` | 云端例程，机器关了也跑 | 计划 | 任务达标退出，例程持续 | 历史 Hosted 假设；当前未排期，需未来重新批准 |
| Loop 内部检查层 | 项目命令、风险规则、交付判定 | 默认由 loop 调用；高级用户可直接调试 | 单次 | v1 命令已实现；0.0.12 从主入口降级 |
| 评估层 | deterministic Proof + fresh-context read-only reviewer；`/judge` 保留为高级诊断 | 被 Loop 调用 | 单次 | 当前基础已实现；frozen checks 归 0.0.19，可复用 Skill criteria 归 0.0.20 |

- `/loop` 的核心语义是**迭代直到验证通过**（iterate-until-verified）：上一轮验证未过就注入失败反馈立即开始下一轮；`--every` 只是可选的轮间最小间隔（节流），用于等 CI 等外部反馈的场景。**关机即停。**
- Claude Code 把 `/loop` 用于时间间隔循环；Wukong 的公开文档、TUI 和 SEO 必须明确自身 `/loop` 是 goal-driven delivery loop，不能让用户误解成 scheduler。
- 定时巡检型任务（"每小时 check PR"）不属于 `/loop`：本机由已实现的 agent-core cron 工具承载；云端 `/schedule` 只是历史 Hosted 假设，当前未排期。
- `/loop` 不新写执行核：迭代复用 `/goal`，`--every` 由 Goal driver 持有可取消等待；独立定时巡检才使用 cron scheduler。
- 停止判断不由写代码的 agent 自评。v1 `/goal` verification gate 已实现；0.0.12 将它收敛到统一 Proof gate 和 PASS/NEEDS_WORK/ERROR。
- 0.0.12 之后的 Wow Moment 是 Loop 自己收敛并给出可信 Gate 结论；独立 verify/scan/proof 只是高级本地诊断能力。
- 0.0.20 Verification Skill 只能提供 strict qualitative criteria；它不执行 Skill command、不能获得 PASS 决策权，也不能覆盖 frozen deterministic blocker。
- Hosted Report 与报告上传已经退出产品；Verified PR Gate 只可能作为 0.2.0 Pro bundle 的可选增强，team rules 和 audit log 均未排期。

Wukong 当前只提供完整的本地 BYOK Loop。0.1.0 的目标是把它做成可稳定推荐的 Trusted Local Loop；付费只能在 0.1.0 发布并验证重复使用后，以 0.2.0 邀请制 Pilot 另行批准。

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
| TUI slash commands | 已实现 | 普通入口以 `/resume`、`/loop` 为主；verify/scan/proof 保留为高级诊断 |
| Agent verification tool | 已实现 | `wukong_verify` builtin tool |
| `/goal` 持续修复 | 已实现 | 让 agent 多轮迭代直到验证条件满足，含队列管理 |
| `/goal` verification gate | 已实现 | agent 宣布完成时运行 deterministic gate，未过打回 |
| `/loop` 本机迭代 loop | v1 已实现 | 0.0.12 改为统一 `proof-pass` gate、结构化反馈和受限轮次 |
| `/proof` 本地高级诊断 | v1 已实现 | 共享 snapshot、三态结论；默认不写报告，仅支持显式本地保存 |
| `/judge` evaluator-only 判定 | 已实现 | deterministic 判定先行；`--agent` 第二-agent 审查后置 |
| 公开官网 | 已实现 | `wukong.today`、download、docs、pricing、changelog |
| 可选账号 Auth | 已实现 | Web/device auth 只连接账号，不配置模型或生成付费 entitlement；历史 subscription 表不再写入 |

### 未完成

| 模块 | 状态 | 为什么重要 |
|---|---|---|
| `/schedule` 云端例程 | 未排期 | 历史 Hosted 假设，需未来重新批准；本机定时巡检先用已实现的 cron 工具 |
| `/ship` 发布 gate | 未实现 | proof + 版本/changelog/dry-run，更靠后的发布前 gate |
| GitHub PR comment / gate | 0.2.0 可选候选 | 只能作为 Reliable Autonomy bundle 的附属能力，不能从历史 PR Gate 文档推断已批准 |
| Team rules / Audit log | 未排期 | 没有已批准的团队或付费产品范围 |
| Model-assisted review | BYOK 已实现 | 独立 reviewer model 已可用；managed credits 后移 |
| Private runner / self-hosted path | 未实现 | 企业级承诺前必须具备的边界 |

## 路线图原则

1. 本地 BYOK `loop` 不受账号或月度额度限制；`verify`、`scan`、`proof` 是内部层和高级诊断命令。
2. 不用人为额度制造升级压力；0.0.18 不新增 Web/D1 telemetry 产品指标后端。用户主动 `/feedback` 是显式产品反馈，不是 telemetry。
3. 用户自带 API Key；0.1.0 不定义付费权益。0.2.0 候选只为可靠自治编排收费，不对 BYOK token 加价或限制 Free 单 Loop。
4. 只写恢复与 Gate 必需的本地 durable state，不默认生成报告或云端副本；不上传给 Wukong。模型所需内容只按 run-scoped consent 发送给 exact BYOK provider，本地导出仍由用户显式触发。
5. 在 guard、redaction、audit、private runner 真正完成前，不宣传安全合规能力。
6. 每个 milestone 必须有可见用户路径和验收方式，不能只完成路由或表结构。
7. 优先做 Loop 自动收敛这一 Wow Moment；独立 `/proof`、`/judge` 不再占据普通用户心智。
8. 不把 Loop Engineering 第三层（GitHub/CI/Sentry 外部反馈集成）写成已具备能力，集成未完成前只作为叙事。
9. `/loop`（本机迭代，关机即停）和定时巡检拆开：迭代收敛归 `/loop`，本机巡检用已实现的 cron 工具；云端例程未排期，不能从旧 `/schedule` 设想推断版本承诺。
10. loop 的停止判断不由写代码的 agent 自评：最终 PASS 由 frozen deterministic verification 与 fresh-context reviewer 共同决定；0.0.20 Verification Skill 只提供受控 qualitative criteria，不能执行命令或单独决定 PASS。
11. 不重复造轮子：`/loop` 执行核复用 `/goal`，`--every` 使用 Goal-owned 可取消等待，proof/judge 复用 verification 引擎；独立定时巡检继续使用 cron scheduler。
12. Reviewer 的长期改进必须来自可追溯的人工反馈和固定 eval；外层 improver 只生成 policy proposal，不能自动修改 active policy 或 reviewer skill。

## 版本发布序列

### 发布分级（0.1.1 起生效）

每个版本开工前先定级，验收矩阵按级别取，不再每个版本重新争论清单。
完整性底线（immutable assets、SHA-256、provenance、publish-no-rebuild、失败不
替换旧 binary）是所有级别的公开承诺，**任何级别都不降**；分级只调验收广度。

| 级别 | 适用 | 必跑验收 | 可豁免 |
|---|---|---|---|
| `patch` | 缺陷修复、显示/文案层增强、发布工程加固；不新增命令、不改 Gate/record 语义 | 全量自动化 + typecheck/lint；六平台构建 + checksum + provenance；fresh install 与上一版本 upgrade smoke；CHANGELOG/官网版本面同步 | cohort 对齐、adversarial 矩阵、五来源真实 Resume 重跑、docs 全量候选审计 |
| `minor` | 新用户可见能力、新命令、record/snapshot schema 演进 | patch 全部 + 相关真实 fixture/E2E 矩阵 + 恢复兼容回归 + 中英文发布面同步 | cohort 与集中宣传门槛（仍属发布后学习） |
| `major` | 破坏性变更（需用户显式确认后单独评审） | minor 全部 + 迁移路径与回退方案验收 | 无 |

豁免项是"本次不重跑"，不是删除；对应债务仍挂在 TODO，由下一个
minor/major 或专项任务关闭。发布级别写在版本设计文档头部。

| 版本 | 目标 | 发布门槛 |
|---|---|---|
| `0.0.11` | 改善 TUI 可理解性、公告与升级链路 | TUI 文案与对齐完成；公告端点 200；文档与实现一致 |
| `0.0.12` | Loop-first v2 | Loop 状态机；fresh-context reviewer；仅 Loop session 额度；BYOK model alias；轻量 Role Profiles；高级命令兼容；真实 E2E 通过 |
| `0.0.13` | Smarter Review Loop | 结构化多 findings、项目 review policy、独立 reviewer model、本地反馈、Loop-first TUI 与 Web 文案；保持免费/BYOK，不上线支付 |
| `0.0.14` | Cross-Agent Resume + Loop UX | `/resume codex|claude|cursor`、安全只读上下文导入、Resume → Loop 确认、Gate/Footer 清晰结论、更多真实项目检查发现；保持免费/BYOK |
| `0.0.15` | Loop Reliability + First Success | durable run lifecycle、completion outbox、重启恢复、preflight、简洁终态和隐私受限激活指标；保持免费/BYOK |
| `0.0.16` | Loop Convergence | 固定 acceptance contract、prior blockers、anti-ratchet reviewer、stall strategist、reviewer model fallback、Resume 建议、Role contract、统一任务状态与有界 session 搜索；保持免费/BYOK |
| `0.0.17` | Command Surface Reliability | 删除误导的 `--role`、`/role`、`/report`、`/yes`；保留可发现的 `/transform`；未知 slash 本地拦截；严格参数解析；CLI/TUI 命令契约与自动化回归一致；保持免费/BYOK |
| `0.0.18` | Loop-First Simplification | 默认命令面只突出 Resume → Loop → Gate；其他实现隐藏但不删除；`/resume` 增加 Kimi Code/Grok；纯文本 `/feedback` 接入 Web API；CLI 发起登录并在网站确认，模型目录可为空；本地 Loop 保持免费/BYOK |
| `0.0.19` | Explicit Finish Line | Loop 启动前确认 Goal、可选 Done when、Must not 和必跑 checks；无损冻结 Acceptance Contract 与 check provenance；区分 Gate attempt/run terminal；NEEDS_WORK 通过幂等 continuation 继续；保持免费/BYOK |
| `0.0.20` | Reusable Verification Criteria | 所有新 reviewer attempt 迁移到 bounded broker + exact BYOK provider consent；可选发现用户本机已有 Verification Skills 的 strict criteria sidecar，支持显式 standalone/有序多选且不执行 Skill command；保持免费/BYOK |
| `0.0.21` | Loop Evidence Integrity（已于 2026-07-30 发布） | 修复相同 risk kind 在不同文件、行或 evidence 位置时的 evidence identity 冲突；broker 保留全部不同 occurrence，完全相同的重复输入继续去重；不新增命令、配置或平台专用能力；保持免费/BYOK |
| `0.0.22` | Provider Catalog Resilience（已于 2026-07-31 发布） | provider catalog 依次尝试维护源和 models.dev；源码有最终 embedded snapshot 路径，但公开 0.0.22 native archive 未嵌入该资产，双远端不可用时会失败；澄清 resume、session、permission、YOLO、Plan、headless 与 judge 帮助；保持兼容、免费/BYOK，不改变 0.1.0 功能范围 |

### 下一版本与后续候选

0.1.0 与 0.1.1 已发布；当前 checkout 开始维护 0.1.2 计划。旧设计中依赖 isolated
worktree、Safe Promote 或 target Final Gate 的内容已经失效，不能继续
作为实现依据或对外承诺：

| 版本 | 状态与目标 | 发布门槛 |
|---|---|---|
| `0.1.0` | **已发布。** 可控、可恢复、可解释的 Trusted Local Loop：可编辑 Preflight、可信 no-check、调用/token 上限、三态 Gate verdict 与 STOPPED_BY_USER、文件归因、恢复兼容、最小 completeness/freshness、五来源 Resume、六平台安装升级和 public truth；完整多层 coverage schema、direct-shell content/PATH attestation 与价格数据库后移 | immutable stable 资产通过 stage-verify-publish-exact、六平台 draft smoke、公开 URL provenance、固定安装、0.0.22 upgrade、恢复与生产版本面验收。25/20/15/7 cohort、首次用户理解和真实来源流程发布后继续收集，不设置固定 14 天等待；三个授权案例只阻断集中宣传 |
| `0.1.1` | **当前 stable。** Reliability And Trust Boundary 补丁：保留 Plan/Loop/Resume/Provider/Web 修复，并关闭 Vis typecheck、更新与插件供应链、workspace checks 发现、根测试编排和空 workspace 问题；不新增顶层命令、不改变 Gate 语义 | 新增缺陷有负向回归；根 test/typecheck/lint/build 覆盖 local Web、vis-web、vis-server；更新不再静默安装；插件安装 fail closed；发布链路验证六平台 assets、0.1.0 upgrade、fresh install、恢复和公开版本面 |
| `0.1.2` | [First Success And Surface Simplification](docs/design/0.1.2-first-success-and-surface-simplification.md)（`minor`）：首次 Provider 连通测试、可恢复 Preflight、可审核 run-plan、安装后真实下一步、命令默认面收敛、账号设备管理或导航隐藏、Web 旧 SaaS 应用层归档，以及 Web 依赖与 CI runtime 维护 | 不删除兼容别名；真实安装→Provider→Preflight→Loop Golden Journey；三个授权脱敏案例；所有隐藏入口仍可显式发现和调用；生产旧表只冻结不 DROP；生产依赖无未处置 high，Actions 不再触发 Node.js 20 弃用告警 |
| `0.2.0` | Codebase Reduction：拆分 GoalMode/TUI/Web 超大协调器，持续清零 boundary baseline，把 Vis、Web/server、ACP、Plugins/MCP、Swarm、Cron、roles 与 Today 收敛为明确的核心或可选扩展边界 | 先批准迁移设计和兼容策略；每次拆分保持 records、Gate、恢复和 SDK contract；旧命令别名至少经过一个 minor deprecation；真实迁移包只有在支持窗口结束后移除 |
| `0.3.0` | Evidence-gated Collaboration Pilot：GitHub PR Check、共享 versioned policy、摘要审计、团队权限/预算和完整 Billing lifecycle 只作为付费证据满足后的候选 | 先取得真实重复使用、非关联付款和续费证据；Free local BYOK Loop 不受账号或 entitlement 故障影响；未达门槛不建设公开 Checkout |

当前顺序是：0.0.22 → 0.1.0-rc.1 → 0.1.0 → 0.1.1 → 0.1.2 → 0.2.0；
0.3.0 仍由付费证据门控，不因前序版本完成而自动开工。
0.0.22 是已发布的维护版本，不扩张 0.1.0 范围；若再出现生产 P0，只能另行
决定紧急补丁。0.1.1 只收维护与可靠性修复，不包含 Cost Visibility；真实用户验证债务（Windows 真实 repo、五来源真实 Resume、cohort）
继续作为发布后产品证据收集。旧的 2026 年 9–11 月排期
随隔离 Promote 方案取消，不再有效。

### 已确认代码问题的版本分配

#### 0.1.1：先恢复可信基线

- 修复 Visualizer 对历史可选 plan id 的错误必填假设，并让 vis-web typecheck 进入根门禁。
- 自动更新改为通知加用户显式 `wukong upgrade`；配置缺失或损坏必须 fail closed。
- 插件下载与解压设置响应体、文件数、单文件、总展开量、跳转和 digest 边界；新装插件默认 disabled，更新失败不替换既有可用版本。
- checks discovery 读取真实 pnpm/npm/yarn/bun workspace 声明；根脚本不能无解释地遮蔽成员检查，Preflight 保留每条命令的 source locator/definition。
- 根测试编排覆盖 `apps/wukong-web`、`apps/vis/web` 和 `apps/vis/server`；删除空的 `wukong-migration-legacy` workspace 并同步 Nix/lockfile。
- Web 请求路径不再执行 schema DDL；旧 SaaS 表和列只冻结，应用层停止新增宠物、memory、achievement、invite、usage 等数据。
- 重写会误导后续开发的 Web `CLAUDE.md`，公开文案明确 Loop 可能以 PASS、NEEDS_WORK、ERROR、PAUSED 或 STOPPED_BY_USER 结束。

#### 0.1.2：首次成功与公开表面收敛

详细范围、发布级别、兼容策略与完成定义见 [0.1.2 First Success And Surface Simplification](docs/design/0.1.2-first-success-and-surface-simplification.md)。

- installer 给出 `cd project → wukong → /provider → /loop` 的真实下一步。
- Provider 增加显式连通测试；Preflight 可在取消、重启和修复配置后恢复。
- headless dry-run 可写出不含 secret 的可审核 run-plan，再由用户显式确认执行。
- 默认 CLI 只突出 `wukong`、`-p`、`provider`、`loop`、`doctor`、`upgrade`；TUI 只突出 `/loop`、`/resume`、`/provider`、`/settings`、`/new`、`/help`、`/feedback`、`/exit`。
- 增加高级 `wukong check` 聚合入口；verify/scan/proof/judge/guard 在本版本只降级为兼容别名，不删除。
- 普通 Dashboard 只保留有证据的已连接设备、最后使用时间和单设备 revoke；若这些数据未就绪，则从主导航隐藏 Dashboard/Plan。
- local Web 在没有使用证据时进入 bugfix-only；若保留，先确定 canonical protocol schema 和生成式 wire types，再继续扩展。
- 复核 Web 锁定依赖的 `npm audit` 告警并区分 runtime/dev-only；2026-09-09 实测基线为 13 项（1 critical / 7 high / 5 moderate），旧的“1 moderate / 3 high”已过期。兼容升级或移除依赖，不盲目使用 `--force`，生产 high 必须归零或有 owner、期限和缓解措施。
- 将 GitHub Actions 升级到 Node 24-compatible runtime，保持 action 完整 SHA 固定和最小权限，并回归 Web test/build、六平台发布与生产面验证。

#### 0.2.0：需要迁移设计的结构精简

- GoalMode 按 contract/version migration、纯 reducer、Gate audit、budget/usage、workspace attribution 拆分。
- TUI 与 local Web 按 session、approval、workspace、notice controller 拆分；不制造无领域价值的微型 utility。
- 逐批删除 225 个 grandfathered 跨模块深层 import，每批都缩小 baseline，禁止一次性重写。
- Visualizer 不再嵌入每个 CLI build；Today、Web/server、ACP、Plugins/MCP、Swarm、Cron 和 roles 明确为核心依赖或默认关闭的独立扩展。
- `@wukong/migration-legacy` 只在兼容支持窗口结束、fresh upgrade 样本证明不再需要后移除。

#### 0.3.0：只在商业证据成立后研究

- GitHub PR Check/Status、共享且版本化的 verification policy、只上传摘要的审计记录、团队权限/预算，以及 Checkout→renewal→failure→grace→cancel→recovery。
- 不优先做 hosted model、云端 Agent、`/schedule`、managed credits、更多 Dashboard 或公开 Checkout。

`0.0.18` 继续收口现有产品层：命令只做默认可见性分层，不删除底层能力；Kimi Code/Grok Resume 只读本地会话；Feedback API 只接收用户确认的文本；`/login` 由 CLI 发起 device flow，用户在 Wukong 网站用 Google/GitHub 确认，CLI 获取 token 后读取 `200` 模型目录。当前没有 Wukong 模型，目录应诚实返回空数组，登录仍成功且不改变 BYOK 默认模型。最新托管模型与推理 endpoint 留给后续独立决策，在真实 backend、隐私和 E2E 就绪前不能发布 placeholder。0.1.0 不预建 invite-only 付费、Checkout 或 entitlement。

`0.0.19` 不扩张命令面和托管产品，只提高一次 Loop 的完成可信度：Acceptance Contract 冻结用户确认的 objective、可选 completion criterion、constraints 和 Gate Plan，模型、权限、轮次等运行设置与合同分离；必跑 checks 冻结命令、来源定位和定义摘要；中间 Gate attempt 与 terminal run 分开持久化；终态 Continue 创建幂等 continuation。详细合同与发布门槛见 [0.0.19 Explicit Finish Line](docs/design/0.0.19-explicit-finish-line.md)。

`0.0.20` 已发布。它把有/无 Skill 的所有新 reviewer attempt 统一迁移到去密、bounded、attempt-scoped evidence broker；workspace read trust 与发送给 exact BYOK provider 的 run-scoped consent 分离，raw/secret-bearing Gate evidence 不出站。其上复用 Agent Skills 文件布局，只读取用户本机已存在、用户确认、digest-pinned 的 strict qualitative-criteria sidecar，并提供四个可选的只读 reference recipes；真实 test/lint/typecheck/build 继续由 0.0.19 frozen project checks 执行。首版只支持 standalone 与有序扁平多选；deterministic suggestions 与 model advisory hints 分离。任何 Skill verdict 都不能覆盖 deterministic failure。命令型 recipe、sandbox、authoring、embedded/chained 后置。自动化、六平台资产与公开安装门槛已经通过；真实仓库配对和固定五用户验证继续作为发布后产品证据收集，详见 [0.0.20 Reusable Verification Criteria](docs/design/0.0.20-reusable-verification-skills.md)。

`0.0.21` 只修复 Loop evidence integrity；不改变 Loop 的写入、执行或发布
模型。`0.0.22` 只增加 provider catalog resilience 与 CLI clarity，作为
0.1.0 的当前直接升级基线，不改变 Trusted Local Loop 范围。`0.1.0` 已收敛为
现有单 Loop 的用户合同稳定版，详细 RC admission P0、最小 Gate completeness/
freshness、兼容、隐私、技术发布门槛与发布后产品验证见
[0.1.0 Trusted Local Loop](docs/design/0.1.0-trusted-local-loop.md)。
`0.2.0` 仍只是更后的可靠自治候选，不能复用已取消的 Promote 架构。当前均
不新增默认 `/agents`、`/parallel`、`/worktree` 或 `/supervisor` 命令；
完整 process sandbox、dynamic workflow graph、云端 Routine、Remote
Control、Hosted Terminal、Team 和 managed credits 都不在范围；0.1.0 不新增
telemetry event 或 Web/D1 metrics backend，现有 optional CLI telemetry 也
不作为 release cohort 证据。

## Milestone 0: Public Install And Local Proof

状态：基本完成。

目标：开发者 5 分钟内能安装 Wukong Code，跑一次本地验证，并理解它为什么存在。

交付项：

- `wukong.today/download` 的稳定安装路径。
- 公开 package name、binary distribution 和文档一致。
- CLI welcome、login selector、终端文案统一为 `WuKong Code`。
- `wukong verify`、`wukong scan`、`wukong guard` 作为历史交付的实现基础和高级本地诊断保留，不进入当前主命令面。
- 官网首页和下载页只描述当前真实能力。

验收：

- macOS 和 Linux fresh install 能跑通。
- `wukong --help` 展示预期命令面。
- `wukong verify --no-report`、`wukong scan --json`、`wukong guard --status` 可本地运行。
- 官网 download command 和真实 installer 一致。
- 页面不把 PR gates、team rules 写成已完成能力。

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
- `--every` 是可选的轮间最小间隔（节流，用于等 CI 等外部反馈），由 Goal driver 持有可取消等待，不创建 cron task。
- 定时巡检型任务不塞进 `/loop`：本机用 cron 工具；云端 `/schedule` 只保留为历史 Hosted 假设，当前未排期。

**E. 文案**

- 文档与官网 hero 文案切换到 loop control plane / proof-layer 叙事。

### 不做

- 不做 `/ship` 发布 gate（更靠后，依赖 proof 先稳定）。
- 不做 `/schedule` 云端例程；该历史 Hosted 假设当前未排期，未来需要重新批准。
- 不为 `/loop` 创建独立定时任务；`--every` 只在 Goal 生命周期内等待。

验收：

- `wukong proof` / `/proof` 在干净项目产出 PASS 报告。
- 在含 placeholder/secret/失败测试的项目产出 BLOCKED 报告，并定位原因。
- `wukong judge --assume-broken` 在不干净项目直接给 BLOCK。
- 带停止条件的 `/goal`：agent 宣布完成但 verify 失败时，gate 拒绝完成并注入反馈继续，不由 agent 自评过关。
- `wukong loop "<目标>" --until verify-pass` / `/loop` 持续驱动：agent 改代码 → gate 评估 → 未过则继续，直到停止条件满足、达到迭代上限或人取消；关机即停。`--every` 由 Goal driver 实现可取消的轮间 pacing。
- `/loop` 达到迭代上限时明确返回 max-iterations 状态，不假装成功。
- 报告可被人读懂并定位失败原因。
- 官网 hero 切换为 loop control plane / proof-layer 文案后，不出现任何未实现能力的承诺（尤其不宣称 `/schedule` 云端例程、CI 集成、第二-agent 审查已可用）。

## Milestone 0.6: 0.0.12 Free Trust Loop v2

状态：已实现并于 2026-07-16 发布。

目标：只把 Loop 作为普通用户主产品。`verify`、`scan`、`proof` 降级为 Loop 内部层和高级诊断命令；用户只理解目标、迭代和最终 PASS / NEEDS_WORK / ERROR。完整 contract 见 [0.0.12 Trust Loop v2](docs/design/verification-loop-v2.md)。

交付顺序：

1. 冻结 Loop 状态机和精简 snapshot；用户只看到 PASS / NEEDS_WORK / ERROR。
2. 每轮由 writer 修改、真实项目检查和风险规则执行，再由 fresh-context reviewer 独立判断。
3. 只有 NEEDS_WORK 进入下一轮；ERROR 停止；最大轮次映射为 NEEDS_WORK/max_iterations。
4. 实现幂等 `loop-runs/start`、`complete` 和 session usage；不引入 Checks、reservation、lease 或 AI credits。
5. verify/scan/proof 保留直接调用兼容，但从主 help、TUI autocomplete 和 onboarding 中隐藏。
6. 默认不写报告；保存、上传和分享都是显式次级动作。
7. 增加轻量 Role Profiles：TUI `/transform`、内置与本地自定义角色，复用现有 agent；CLI `roles list/show/init` 只负责角色目录管理。

免费初始额度：

> 历史说明：以下是 0.0.12 发布时的额度设计。0.0.17 已删除 Guest、登录和月度 Loop 准入限制；当前只保留用户可控的本地单次运行安全上限。

- 未登录：1 个 Loop session、最多 2 轮。
- Free 账号：10 个 Loop sessions/月且每个最多 5 轮；第3次开始提示 Pro，第10次后硬限制。
- 内部检查和直接运行高级诊断命令都不消耗额外额度。
- BYOK 模型不增加另一套 AI credits；用户承担 provider token。
- 参数校验失败和无法建立执行计划不扣额度。

验收重点：

- 空根 package + `app`/`api` 子项目能被正确发现。
- 没有检查、证据不足或 runtime 缺失是 ERROR，不是假 NEEDS_WORK。
- 内部 scan scope 有真实行为，staged 与 workspace 可验证地不同。
- Loop gate 共享一次 snapshot 并校验 stale；0.0.12 默认不写文件，也不新增 Loop evidence 上传。
- loop 每轮使用新的 Proof；NEEDS_WORK 才继续，达到上限返回 NEEDS_WORK/max_iterations。
- deterministic 失败不能被模型改为 PASS；AI finding 必须标注来源、模型和置信度。
- built-in/user/project role 与权限收缩、project trust 有自动化覆盖。
- Loop session quota、幂等 start、月度重置、超限和内部不重复计数有自动化覆盖。

## Milestone 2: 0.0.13 Review Learning Loop

状态：已发布。Review Contract、项目 policy、本地 feedback、独立 reviewer model、Loop-first TUI/Web 文案、真实临时 monorepo E2E、受保护的生产统计接口和预览公告均已实现。设计 contract 见 [0.0.13 Review Learning Loop](docs/design/review-learning-loop.md)。本版本只验证 Reviewer 学习价值，保持免费/BYOK；支付与完整 Billing 当时曾后置到历史 0.1.0 假设，当前仍未排期。

目标：在不扩大 reviewer 权限的前提下，让本地 Reviewer 输出可操作的多 findings，并收集真实反馈验证 reviewer 是否有价值。

交付项：

- 统一 reviewer profile/runtime JSON contract，消除 `VERDICT` / `VERDICT_JSON` 冲突。
- 多 finding Review Result：severity、category、evidence、next action、confidence 和 validation status。
- `.wukong/review-policy.md` 项目审查策略，进入 fingerprint 和 reviewer input。
- Reviewer 保持只读，额外验证只作为 `nextAction` 建议。
- 本地 finding feedback：accept、false-positive、fixed、unclear。
- 实验性独立 `--review-model` 保持 BYOK，不绑定支付 entitlement。
- TUI 和 Web 全部迁移到 Goal → Write → Check → Review → Fix。
- Pricing、Dashboard 和 CLI 继续显示 Pro/Team `Coming Soon`，不创建付费 Checkout 用户路径。

验收：

- Review Result 可返回多个 findings，只有 blocking finding 阻止 Delivery Loop。
- Reviewer 不能直接写文件或执行任意 shell。
- 本地完整走通 finding → feedback → fix → 后续 review。
- 无 `.wukong/review-policy.md` 的仓库保持 0.0.12 reviewer 行为和旧结果兼容。
- 用户可离线使用基础 feedback/eval，独立 reviewer model 仍由用户 BYOK。
- 生产统计能区分注册和 activated Loop users；review feedback 保持 local-only 时明确标记服务端不可见，不用注册数或 Loop 数冒充 feedback。
- Pricing 页面不显示价格，不把 Pro、Team、支付或 GitHub PR 能力写成 live。

不做：

- 不自动修改 reviewer skill 或 active policy。
- 不从单条 PR comment、源码注释或模型输出学习永久规则。
- 不做支付、Stripe portal、付费 entitlement、GitHub PR 自动评论、团队 policy 同步或云端定时 improver；这些均未排期，旧 `0.1.0+` 说法不构成版本承诺。

## Milestone 2.5: 0.0.14 Cross-Agent Resume + Loop UX

状态：已于 2026-07-18 发布。完整 contract 见 [0.0.14 Cross-Agent Resume 与 Loop UX 收尾](docs/design/0.0.14-resume-loop-polish.md)。

目标：让用户把 Codex、Claude Code 或 Cursor 中未完成的任务安全带进 Wukong，并用清晰的 Gate 结论和 `/loop` 完成收尾。

交付项：

- 裸 `/resume` 保持 Wukong-only；`/resume codex|claude|cursor` 显式发现外部本地 session。
- 外部 transcript 只读导入，不重放旧工具、不继承权限、不上传历史。
- picker 支持来源标签、原生 ID 搜索、当前目录/全部目录和失败隔离。
- 外部上下文导入后提供 `Continue in Wukong` 与确认后的 `Start /loop`。
- TUI Footer 收敛为一个 Gate 结论，区分未检查、检查失败、风险复核、review blocker 和 runtime error。
- 补充 Python、Rust、Go 的基础项目检查发现，并保留现有 Node/monorepo 行为。
- legacy stop flags 和旧 Goal records 在本版本继续兼容。

验收：

- 三种外部工具使用真实本地 session 完成 discovery → import → workspace re-check E2E。
- symlink 越界、损坏/超大 JSONL、未知格式和移动工作目录不会导致 TUI 崩溃。
- 外部 transcript 的历史声明不能替代当前 Git、测试和 review evidence。
- 用户选择外部 session 后不会自动发生写操作；启动 `/loop` 前有明确确认。
- Gate/Footer 文案不再用 `Verify ✗` 表示未执行或无检查，也不把风险规则命中直接描述为代码失败。
- 全量测试、typecheck、lint、native smoke 和中英文发布面同步通过。

不做：

- 不做支付、GitHub PR 自动评论、Team policy、云端 `/schedule` 或自动 policy improver；这些都未排期，不能从旧 `0.1.0+` 假设推断版本承诺。

## Milestone 2.75: 0.0.15 Loop Reliability + First Success

状态：已于 2026-07-20 发布；六平台 assets、真实升级、fresh installer、manifest、公告、官网和 D1 lifecycle migration 均已验证。完整 contract 见 [0.0.15 Loop Reliability 与 First Success](docs/design/0.0.15-loop-reliability.md)。

目标：让每个真正开始的 Loop 都能可靠进入终态；CLI 崩溃、断网、重启和用户取消不再让服务端 run 永久停在 `started`。同时把首次入口、preflight 和最终结果收敛到普通用户可理解的最短路径。

交付项：

- 将 `requestId → goalId/sessionId` tracking 从进程内状态改为本地 durable record。
- completion 失败进入本地 outbox，并在启动、resume、today/doctor 和下一次 Loop 前安全重试。
- lifecycle 与 Gate outcome 分离：started/completed/cancelled/abandoned 对应 PASS/NEEDS_WORK/ERROR 或无代码结论。
- provider、model、workspace、objective 和 checks preflight 在 quota start 之前完成。
- 重启后允许恢复 active Loop，恢复时重新读取 workspace/Git/checks/policy。
- 默认 TUI 只突出 Continue task、Start Loop、Configure model；终态只显示 Gate、主要 blocker 和下一步。
- 建立不含源码、prompt、transcript、路径和机器指纹的 install → first run → Loop terminal → repeat 漏斗。
- Dashboard 和受保护 metrics 区分 terminal、cancelled、abandoned 与 stale started。

验收：

- crash/restart/offline/cancel/duplicate complete 都有自动化和真实 E2E。
- preflight 失败不消耗服务端额度。
- 所有 pending completion 要么成功同步，要么保留在可解释、可重试的 outbox。
- Node、Python、Rust、Go、无 checks 和缺失工具项目均返回正确状态和下一步。
- 0.0.14 → 0.0.15 upgrade、fresh installer、六平台 assets、manifest、公告和官网同步通过。

不做：

- 不做支付、GitHub PR、Team rules、Hosted Report、云端 `/schedule`、新增 Agent 来源、managed credits 或 Role 系统扩张。
- 不把 reviewer-only 结果默认包装成 PASS。
- 不用 started、注册数或 GitHub 下载量冒充完成和重复使用。

## Milestone 2.8: 0.0.16 Loop Convergence

状态：已于 2026-07-21 正式发布；六平台 ZIP/SHA assets、0.0.15 → 0.0.16 自动升级、0.0.16 fresh install、公开 release、Web manifest、公告与 live health 均已验证。完整 contract 见 [0.0.16 Loop Convergence](docs/design/0.0.16-loop-convergence.md)。

目标：让 Loop 围绕固定的用户目标与验收合同持续收敛，并在自动化和分身增加后仍保持可解释的权限边界。Reviewer 必须先复核上轮 blocker，不能在每一轮提高标准；相同 blocker 重复时，Loop 能识别无进展、切换一次策略，并在仍无法推进时给出清晰终态。

交付项：

- 为每个 Goal 创建一次不可由 writer/reviewer/strategist 修改的 acceptance contract，并通过 agent records 在 restart/resume/compaction 后恢复。
- 将 prior blockers、stable blocker key 和 blocking-set fingerprint 注入下一轮 reviewer。
- 建立 reviewer anti-ratchet：旧 blocker 优先复核，新的风格偏好或未约定扩展不能阻断。
- 连续两次相同 fingerprint 时启动一次 read-only strategist；仍无进展时返回 `NEEDS_WORK/no_progress`，不增加第四种 Gate 状态。
- 显式 reviewer model 不可用时回退当前 writer model 一次；取消、invalid output 和 infrastructure error 使用不同语义。
- 重构 Permission Mode v2：`manual` 负责交互确认，`auto` 成为不提问但受 workspace/risk/capability 约束的自主模式，`yolo` 成为显式危险 approval bypass；Auto 不得比 YOLO 更宽松。
- Headless `-p` 默认使用受限 Auto；危险 headless 执行要求显式 `--yolo --yes`，`--yes` 不再作为 YOLO 隐藏别名，旧 `--auto-approve` 进入警告兼容期。
- reviewer、planner、strategist 和只读 explore 的 capability ceiling 不继承父 Agent 的 Auto/YOLO 扩权；custom/MCP tools 只有被 child profile 明确允许时才能激活。
- Welcome 提供有界、可关闭的近期 Cross-Agent Resume suggestion，不自动写入或启动 Loop。
- Role Profile 增加可选 inputs/outputs/capabilityMode，且只能收窄基础权限。
- footer 用一条紧凑计数汇总后台命令和 subagent，详细状态保留在 `/tasks`；session picker 支持有界本地内容搜索。
- 增加不含 objective、finding、路径、session id 或 transcript 的 convergence metrics。

验收：

- 至少三个真实仓库完成 prior blocker → fix → PASS，并证明 reviewer 不会逐轮抬高门槛。
- 相同 blocker doom loop 在最大轮次前触发 strategist 或 `no_progress`，且不超 quota/maxIterations。
- reviewer model fallback、两模型失败、取消和 invalid output 均有独立 contract tests。
- Auto 对 workspace 外写入、敏感目标、高风险命令和未知 mutating tool fail-closed；YOLO 仍服从 hard deny、Plan guard 和 read-only profile。
- Manual/Auto/YOLO、Headless、旧 flags/config/records 以及 Auto/YOLO 父 Agent → 只读分身均有真实 E2E。
- 0.0.15 durable lifecycle、completion outbox、旧 Goal/Role/session records 全部回归通过。
- Codex、Claude Code、Cursor suggestion → resume → edit objective → Loop terminal E2E 通过。
- 中英文 README、ROADMAP、TODO、用户指南、CHANGELOG、release notes、公告和 Web 文案在发布前同步。

不做：

- 不做支付、PR Gate 写入、Team、managed reviewer、默认多 reviewer、云端 `/schedule`、远程 session、Hosted Report、Agent/Persona 市场或自动 policy 修改。
- 不改变 `/loop` 的 iterate-until-verified 语义，也不把 verify/scan/proof 恢复为普通用户产品。

## Milestone 2.9: 0.0.17 Command Surface Reliability

状态：已于 2026-07-22 正式发布；真实 TUI smoke、全量质量检查、六平台 ZIP/SHA assets、0.0.16 → 0.0.17 自动升级、0.0.17 fresh install、三仓发布面与 Cloudflare production 均已验收。完整 contract 见 [0.0.17 Command Surface Reliability](docs/design/0.0.17-command-surface-reliability.md)。

目标：把 CLI/TUI 的现有命令面收敛为可发现、可预测、可自动回归的稳定契约；删除会制造错误预期的入口，不新增 Agent 引擎、托管能力或商业功能。后续版本范围依据真实 Free 用户验证重新决策。

交付项：

- 删除全局与 Loop `--role`、TUI `/role`、`/report` 和 `/yes`；Role 管理使用 `wukong roles`，会话切换使用 `/transform`。
- `/transform list|status|off` 可发现，并在 Role Profiles 未启用时提供本地 `/experiments` 指引。
- 未知、已禁用和当前不可用的 slash command 只返回本地错误与建议，不进入模型。
- permission、Loop 数值、Today focus、roles 子命令和 export 参数严格解析，错误时不产生副作用。
- registry、resolve、dispatch 与真实 CLI boundary 均有正向和负向自动化测试。
- 删除 Guest trial、Free 月度 Loop quota 和 start/complete 网络依赖；Loop 不登录也能按本地 `--max-iterations` 运行，durable record 只用于本机恢复。
- 发布前完成真实 TUI smoke、native build、六平台 assets、upgrade/fresh install 和三仓文档同步。

不做：

- 不做支付、PR Gate、Team、managed reviewer、云端 `/schedule`、Hosted Report、同步闭环或新的 Role/Agent 市场。
- 不加入 mascot、welcome 动画或与命令可靠性无关的视觉功能。

## 历史探索：Pro PR Gate + Billing（已被取代）

> 本节保留 2026-07-20 的旧研究内容用于追溯，不代表已排期、已批准或正在实现。它已被 [0.1.0 Trusted Local Loop](docs/design/0.1.0-trusted-local-loop.md) 与 [0.2.0 Pro Reliable Autonomy](docs/design/0.2.0-pro-reliable-autonomy.md) 取代。

归档 contract 见 [历史候选：Pro PR Gate 与 Billing](docs/design/historical-pro-pr-gate-billing.md)。

目标：保留完整的本地 BYOK Loop，并用一个可验证的付费能力——把 Gate 结论安全、幂等地发布回 GitHub PR——测试个人开发者付费意愿。

交付项：

- capability-based entitlement API；CLI、Dashboard、PR Gate 和 Billing 共用同一 resolver，不再根据 tier 名称猜权限；本地 BYOK Loop 不进入 entitlement。
- `wukong account`：显示 plan、billing 状态、PR Gate publish 权限和管理入口，不显示本地 Loop 月度用量。
- `wukong pr gate --dry-run`：Free 可预览待发布 comment/status，不写 GitHub。
- Pro `wukong pr gate`：使用现有 `gh` 登录或 token，更新一条稳定 marker comment，并写入 `wukong/gate` commit status。
- 本地 redaction、stale snapshot/SHA 拒绝、首次确认和 CI `--yes`。
- 单一月付 Checkout、Customer Portal、完整 subscription lifecycle、event 去重与乱序安全 webhook。
- success page 轮询真实 entitlement；Dashboard 不使用长生命周期 JWT tier 作为 Billing 真相源。
- `PRO_CHECKOUT_ENABLED=false` 默认关闭；候选 `$9/月` 只在邀请制实验中验证，不提前写入公开 Pricing。

验收：

- Free 用户能完成完整本地 Loop 和 PR dry-run；未付费只阻止 GitHub 写入。
- 真实测试 PR 能收到一次幂等更新的 summary comment 和正确 commit status。
- GitHub comment 不含 secrets、绝对路径、prompt、transcript 或未预览内容。
- stale Gate、GitHub API/权限/partial write 失败返回 ERROR，绝不能发布错误 PASS。
- Stripe Test Mode + D1 跑通 checkout → entitlement → portal → renewal/failure/grace/cancel/recovery。
- 邀请制实验至少取得 3 个非关联真实付款用户和 1 个续费或连续 30 天活跃付费信号。

不做：

- GitHub App、org/workspace 映射、inline review comment、自动 merge 和完整 Team CI 产品。
- Hosted Report、managed reviewer/credits、Team rules、audit log、SSO、private runner 或云端 `/schedule`。
- 年付、终身版、多个付费 tier、seat billing 或复杂 overage。

## 历史探索：Milestone 4 Team Rules And Audit Log（未批准）

> 以下 Milestone 4–6 只保留早期产品假设，不属于 0.0.19、0.0.20 或任何已批准后续版本。

目标：从个人开发者工具变成团队交付流程。

交付项：

- Team workspace model。
- Repo/path-level rules。
- Required checks 和 risk thresholds。
- Override flow，必须填写 reason。
- Team audit log：记录 Loop、PR gate、policy change、override。
- Shared templates：团队统一 verification commands。

验收：

- Team admin 可以为 repo 定义 required checks。
- PR gate 使用 team rules，不使用硬编码默认规则。
- Override 必须记录 actor、reason、timestamp 和 linked run。
- Audit log 可以回答：谁验证、什么失败、谁 override、最后交付了什么。

## 历史探索：Milestone 5 Deep Review And Managed Credits（未批准）

目标：增加模型/API 支持的付费能力，但不把 Wukong 做成原样模型 proxy。

交付项：

- Deep review job API。
- BYOK review mode。
- Managed credit review mode。
- Job queue 和结果持久化。
- Deep review output 附着在对应 PR check 或 audit event 上。
- Managed credits usage metering。

验收：

- BYOK 用户为 workflow 付费，不为自己的 token 额外加价。
- Managed model 用户消耗 Wukong review credits。
- Deep review 结果可以回写到对应 PR check。
- 模型调用失败可见，且计费状态正确。
- 产品文案不把第三方 API 转售包装成核心价值。

## 历史探索：Milestone 6 Enterprise Readiness（未批准）

目标：为严肃 team pilot 和企业沟通准备真实边界。

交付项：

- Private runner design。
- Self-hosted 或 customer-cloud runner path。
- SSO plan。
- Data retention controls。
- Export/delete workflows。
- Security review 和 threat model。

验收：

- 团队可以把源码和 secrets 保留在自己的环境内。
- Hosted Wukong 只接收被允许的运行状态和审计 metadata。
- Admin 可以配置 retention 并导出 audit events。
- Security docs 与实际实现一致。

## Website Roadmap

官网必须和真实产品状态保持一致。

近期工作：

- 首页继续聚焦 Resume → Loop → Gate 和 CLI 下载，不把 BYOK 写成本地模型。
- `/download` 保持短、准、可安装。
- `/pricing` 只陈述当前 Free + BYOK、无月度 Loop 次数限制和无付费计划；没有新批准与真实 entitlement 前不展示候选价格、Checkout 或 Pro/Team 承诺。
- 使用真实本地 Loop 输出作为 docs 演示素材，不制作付费能力 placeholder。
- Dashboard 只围绕真实账号连接状态和已上线能力优化，不恢复 quota、billing 或 Hosted Terminal。
- changelog 保持和公开 release 同步。

不要做：

- GitHub integration 未完成前，不宣称 PR gate 已可用。
- Deep review job API 未完成前，不宣称 deep review 已可用。
- Redaction、audit、private runner 未完成前，不宣称 security/compliance。

## CLI Roadmap

近期工作：

- 0.0.19 先完成 Explicit Finish Line、frozen Gate checks、approval CAS、durable attempt/terminal 与 continuation。
- 0.0.20 先把有/无 Skill 的所有新 reviewer attempt 统一到 broker trust + run-scoped BYOK provider consent，再可选接入已有 Verification Skill 的 strict qualitative criteria；不执行 Skill command，也不新增顶层命令。
- 0.0.21 只做 repeated-risk evidence identity 修复与六平台一致发布；不增加新的执行架构。
- 0.0.22 只做 provider catalog resilience 与 CLI clarity 维护发布；不增加新的执行架构。
- 0.1.0 规格已收敛：只稳定可控、可恢复、可解释的单 Loop；可编辑 Preflight、可信 no-check、provider-call/token 上限、文件归因、provider outcome、最小 Gate completeness/freshness、兼容恢复、五来源 Resume 与发布 workflow 已完成自动化，RC 六平台公开验收已通过。stable 只保留 exact-source、P0/release-blocking P1 清零、六平台资产/安装/升级/恢复与生产版本面门槛；opt-in cohort 发布后继续，不设固定 14 天等待。完整多层 coverage schema、direct-shell content/PATH attestation 与价格数据库后移。
- 0.1.1 只做已存在体验的维护与可靠性修复；不包含 Cost Visibility、实时 pricing 查询、价格数据库或 reviewer 成本聚合。
- 0.2.0 是未批准且待重新评审的 Reliable Autonomy 候选；不能继承已取消的 Promote/lease/fencing 设计，在 0.1.0 真实验证前不开工、不公开 Checkout。
- 公告与更新通道分离：公告 JSON 由 Web 静态文件维护，失败不阻塞 CLI。
- `/report` 和 Hosted Report/上传路径保持删除；本地 Gate 结果只在已有显式保存能力下留档。
- 登录命令保持简单：OAuth first，不展示重复 platform choices。
- 终端 UI 保持紧凑、产品导向。

不要做：

- 付费 evidence 工作流未成立前，不继续堆游戏化功能。
- 不把本地 deterministic verification 放到付费墙后。
- 不把 `/schedule`（历史云端例程设想）塞进本机 `/loop`；当前只承诺关机即停的本机 Loop 和本机 cron，跨机器持续性未排期且需未来重新批准。
- 不为 `/loop` 创建脱离 Goal 生命周期的定时任务；`--every` 节流必须由 Goal driver 持有并可取消。
- 不把 worktree 写入隔离宣传成完整 sandbox，也不把内部 AgentSwarm 的 128 上限宣传成并行产品能力。
- 0.1.0 不做 detached 多 Loop；0.2.0 候选也只允许用户显式 Detach 的本机进程，机器关闭后不会继续。

## 0.2.0 Candidate Commercial Readiness Gates

> 以下收费门槛属于 [0.2.0 Pro Reliable Autonomy](docs/design/0.2.0-pro-reliable-autonomy.md) 候选，不构成当前任务、公开价格或发布日期承诺。0.1.0 仍是 Free 稳定版。

开始 0.2.0 invite-only Pilot 前：

- 0.1.0 正式发布并稳定观察至少 30 天。
- 至少 15 位外部用户完成 0.1.0 Loop，7 位在 14 天内重复完成。
- 至少 5 位目标用户出现重复的多任务监督需求。
- Parallel、Detach、Supervisor、capacity、cancel/restart 和 Billing Test Mode E2E 通过。
- Free 单前台 Loop 在 account/entitlement 服务故障时仍完整可用；Pro capability unknown fail closed。

Pilot 的最低商业证据：

- 邀请 10 位目标用户。
- 至少 5 位实际使用 Pro 能力完成真实任务。
- 至少 3 位非关联用户真实付款。
- 至少 2 位进入第二账期并续费。
- 购买原因可归因到有界并行、本机监督和可靠交付，不是 BYOK token、模型 credits 或单纯支持项目。

公开 Checkout 前还必须有 10 个真实 Pro users、5 个 30 天重复使用者、3 个续费者，并保持 Billing/entitlement、privacy、false PASS、workspace damage 与失控后台执行的 P0/P1 为 0。未达到时继续 invite-only，不用代码完成替代付款、复用和续费证据。

Team 只在 shared policy、budget、audit、SSO 和组织权限出现独立需求后另立版本，不自动跟随 0.2.0。

## 历史探索：Commercial Metrics（未启用）

以下是商业决策时可从 opt-in cohort、明确反馈与 Billing ledger 计算的候选指标。0.0.19–0.1.0 不建设 telemetry 指标后端，0.2.0 也不恢复匿名行为采集。

- Install completion rate。
- 24 小时内首次 completed Loop。
- 每个活跃开发者每周 completed Loop 数。
- Parallel/Supervisor 完成、重复使用和人工 attention 次数。
- Pilot invite → Pro use → payment → renewal。
- 可选 PR Gate 的预览、发布与失败恢复。
- Team pilot 两周留存。

## Explicit Non-Goals

- 不做通用 chatbot website。
- 不把第三方模型 API 转售作为主产品。
- 不对基础本地 verification 收费。
- 不把 mascot 工作变成主路线图。
- 不在实现前宣传 enterprise security。
