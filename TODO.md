# Wukong CLI - TODO

> 定位: 本文件是 `wukong_cli` 的执行层任务清单。方向与验收以 [ROADMAP.md](ROADMAP.md) 为准；0.0.19 与 0.0.20 已发布，未完成真实产品证据继续作为发布后验证债务保留。当前批准实施版本为 [0.0.21 Isolated Loop Worktrees](docs/design/0.0.21-isolated-loop-worktrees.md)，先执行只读 Source Snapshot dry-run；0.1.0、0.1.1 与 0.2.0 仍未批准开工。现有自动化基线参考 [测试计划](docs/test/verification-cli-test-plan.md)。旧 commercial/PR Gate 文档只作历史研究，不是当前实现依据。本文件只维护"现在做什么、做到哪了"，不重复定义方案。
> Web 侧任务见 `wukong_web/TODO.md`。
> 更新规则: 每完成一项勾选并注明日期；口径变更时先改 ROADMAP/设计方案，再同步本文件。

## ✅ 0.0.19 — Explicit Finish Line（已发布；验证债务保留）

> 方案: [docs/design/0.0.19-explicit-finish-line.md](docs/design/0.0.19-explicit-finish-line.md)。本版已于 2026-07-25 发布，继续免费、本地优先和 BYOK；不增加顶层命令。重点是明确 Loop 完成线、冻结必跑 checks，并让终态后的继续执行保持可追溯。下方未勾选项目是非阻塞发布后验证债务，不代表 tag 或核心合同尚未发布。

### P0：Acceptance Contract 与 Preflight

- [x] 定义 v1/v2 discriminated union；V2 无损保留 `acceptanceCriteria`、`verificationPlan`、`source` 和 criterion IDs（2026-07-25）
- [x] 旧 V1 首次恢复 append 幂等 identity assignment；Revised Loop 使用新 `goalId`/`contractId` 和 supersedes lineage，不改写旧合同（2026-07-25）
- [x] V2 增加用户确认的 constraints、versioned Finish Line warnings/ack digest、workspace trust binding、frozen/advisory review policy 与 Gate Plan（2026-07-25）
- [x] 将用户可选 `completionCriterion` 接入 TUI `/loop` 创建路径，显示为 `Done when`（2026-07-25）
- [x] TUI 默认只展示 Goal、Done when、Must not、检查数量和本 run limit；模型、权限和内部 Gate 放到 Advanced（2026-07-25）
- [x] 未提供 `Done when` 时明确显示“未单独指定”，禁止 planner/model 自动写入隐藏标准（2026-07-25）
- [x] Headless 增加 `--done-when`、可重复 `--constraint`/`--check`、discovered-check 决策、workspace challenge、完整 Gate approval-set digest 与 warning digest（2026-07-25）
- [x] 输入长度、check 数量、控制字符和合同总大小超限在任何持久化/执行前失败（2026-07-25）
- [x] `--dry-run` 输出完整合同、trust challenge/Gate approval digest 且零副作用；机器输出只用现有 `--output-format text|stream-json`（2026-07-25）

### P0：Gate Plan 与 anti-weakening

- [x] verification selection 全程保留 `VerificationCommand[]` 来源信息，并合并 explicit + confirmed discovered checks（2026-07-25）
- [x] resolved check 冻结 execution/display command、command digest、workspace-relative source locator、定义摘要和 stable plan digest（2026-07-25）
- [x] Gate Plan 同时冻结 builtin risk-scan policy version；policy drift 与 check definition drift 一样必须 restore-or-revise，不能热升级/降级（2026-07-25）
- [x] future check 只能冻结为 `expected-unresolved` placeholder；新定义出现后零 spawn 要求 Revised Loop，不能接受新 `exit 0`（2026-07-25）
- [x] package script 同名改写、`.wukong/checks.json` 删除/改写、workspace script drift 必须在 spawn 前 BLOCK（2026-07-25）
- [x] blocking review policy 冻结 locator/digest；未冻结 live policy 只能 advisory，不能阻止或授予 PASS（2026-07-25）
- [x] Preflight 是唯一 discovery/compile 阶段；Gate executor 每个 check 只执行一次，Proof aggregate 不再 discovery/spawn/重复 scan/reviewer（2026-07-25）
- [x] builtin risk scan 每个 attempt 恰好持久化一次，并以 policy/workspace/result digest 加入 aggregate、evidence snapshot 和 PASS durable join（2026-07-25）
- [x] Proof aggregate 只有 checks 全 pass、scan clean、reviewer 精确 PASS、carried blockers 有效解决且全部 evidence fresh 时才能 PASS（2026-07-25）
- [x] 每次 Gate 后重查 workspace/provenance；代码、测试、配置变化后旧 PASS stale，并重新运行完整 required plan（2026-07-25）
- [x] 同一 snapshot 上矛盾 PASS/FAIL 返回 `check_unstable`，不取多数或最后一次结果（2026-07-25）
- [x] Agent 不能通过改写 checks 配置消除 prior blocker；deterministic blocker 继续不可被 reviewer 覆盖（2026-07-25）
- [x] 新发现 checks 只作为 suggestion；active contract 不动态扩展，用户需要时启动 Revised Loop（2026-07-25）
- [x] 无 resolved checks 的 Preflight 给出 versioned warning；不得伪造 source-code 验证 PASS（2026-07-25）

### P0：Workspace trust、权限与隐私

- [x] 定义 canonical realpath/filesystem/Git identity、session/remembered grant、TUI trust once/remember/revoke 和 Headless 最多 10 分钟短时签名 challenge（2026-07-25）
- [x] workspace trust、check selection、Gate approval-set CAS 三者独立；缺少任一项时 Headless/Auto/Yolo/`--yes` 都零 spawn（2026-07-25）
- [x] permission/recognizable-risk guard 前移到 spawn 前；UI 明确可信仓库 shell 按当前 OS 权限运行，0.0.19 不宣传完整 sandbox（2026-07-25）
- [x] 已知 inline credential/token 在 trust、持久化和 spawn 前拒绝；durable contract 才能保存 secret-free execution command，所有展示/outbound 只用 display command（2026-07-25）
- [x] realpath/locator escape、identity drift、grant revoke、guard 可识别 destructive/network、secret sentinel 和 redaction P0 负向测试通过（2026-07-25）
- [x] Cancel、dry-run、permission denial 不留下 trust grant、contract、run、HTTP 请求或 secret payload（2026-07-25）

### P0：终态 continuation 与恢复

- [x] 新增 append-only attempt/check/scan/reviewer/aggregate/evidence/terminal records，以随机 `attemptId` 和 digest durable join；损坏/孤儿/跨 attempt 引用 fail closed（2026-07-25）
- [x] PASS terminal 强制引用同 run/contract/plan 的完整 PASS attempt；ordered checks、唯一 clean scan、reviewer、aggregate、snapshot 缺失/重复或状态/digest 不一致均不得恢复为 PASS（2026-07-25）
- [x] check/scan/reviewer/aggregate/snapshot/completion 各自定义 domain-separated canonical digest，并覆盖 self-field exclusion/replay（2026-07-25）
- [x] 中间 `NEEDS_WORK` 不显示 Continue、不新建 run；只有 terminal record 可进入 continuation（2026-07-25）
- [x] terminal `NEEDS_WORK` Continue 幂等创建新 `runId`，记录 `continuedFromRunId`、合同引用和 carried blockers（2026-07-25）
- [x] continuation 双击与并发只创建一个新 active run（2026-07-25）
- [x] terminal 持久化唯一 `continuationPolicy`（same-contract/restore-or-revise/revised-loop/blocked）；所有入口禁止自行组合 status/retryable 布尔值（2026-07-25）
- [x] 改 objective/criterion/constraint/required check 时创建新 Goal/contract/root run 与 lineage，不做 active contract revision（2026-07-25）
- [x] 新 run 恢复冻结合同、未解决 blockers 和当前 workspace freshness，并显示独立 budget 与 chain 累计 usage（2026-07-25）
- [x] 所有 continuation 都由用户手动触发；permission/security denial、取消、corruption 和未知 ERROR 持久化 blocked（2026-07-25）
- [x] 旧 v1 合同、0.0.18 session、未终态 run restart 和 append-only records 保持兼容（2026-07-25）

### P1：跨平台与真实发布后验证债务

- [x] Codex/Claude Code/Cursor/Kimi Code/Grok Resume 只生成可编辑 objective 草稿，不自动冻结 completion criterion（2026-07-25）
- [x] imported transcript 中的 `/loop`、`--check`、shell 或成功描述不能获得执行权/验收权（2026-07-25）
- [ ] macOS/Linux/Windows 覆盖 quoting、Unicode、timeout、cancel、process-tree kill、contract restore
- [ ] 同一 fresh fixture 连续至少 3 次保持 check 顺序、终态和 reason code 稳定
- [ ] Kimi Code、Grok 各完成真实本机 picker → handoff → editable contract → Loop → workspace re-check smoke
- [ ] CLI 与 Web `/api/v1/feedback` 使用共享 versioned contract fixture
- [ ] 共享隐私负向 fixture 拒绝日志、源码、prompt、路径、session 和附件字段

### 发布验收记录与发布后验证债务

- [x] identity/lineage、warning ack、trust、exact approval、inline-secret、provenance、anti-weakening、attempt join、continuation targeted tests 通过（2026-07-25）
- [x] 全仓 test、typecheck、lint、docs build、bundle/native SEA smoke 通过（2026-07-25；9303 tests passed，8 files/48 tests skipped，2 todo）
- [ ] Node/Python/Rust/Go blocker → fix → full rerun → PASS 与 monorepo 检查发现回归通过
- [ ] script 同名弱化、future `exit 0`、未授权命令零 spawn、evidence join corruption、NEEDS_WORK → continuation → PASS 真实 E2E 通过
- [ ] trust once → expiry、remember → revoke、Headless signed challenge + approval CAS、warning ack edit 后失效、review-policy drift → restore-or-revise 真实 E2E 通过
- [ ] 固定 5 名目标用户各完成一次脚本且看过后不排除/重试；4/5 正确解释 Finish Line/attempt/terminal，5/5 理解 workspace shell 未被完整 sandbox
- [x] 六平台 assets/SHA、0.0.18 → 0.0.19 upgrade 和 0.0.19 fresh install 通过（2026-07-25）
- [x] 三仓 README/ROADMAP/TODO/CHANGELOG/release notes/installer/manifest 与线上版本一致（2026-07-25）
- [x] Web health、D1/cache、manifest、首页、Changelog、Today 与公开下载页 production 验收通过（2026-07-25；Feedback/Device Login/空 catalog 沿用 0.0.18 已验收实现）

### 明确不做

- Verification Skill 执行/chaining、托管模型/推理、支付、credits/quota、Hosted Terminal/Report、云同步、telemetry 指标后端、`/schedule`、`/ship`、PR Gate、Team、新顶层合同命令、新 workflow DSL、自动 policy/Role/Skill/contract 修改和 feedback 附件均不进入 0.0.19。

## ✅ 0.0.20 — Reusable Verification Criteria（已发布；验证债务保留）

> 方案: [docs/design/0.0.20-reusable-verification-skills.md](docs/design/0.0.20-reusable-verification-skills.md)。实施依赖 0.0.19 已发布的 frozen Gate、approval CAS、durable PASS 和 continuation 核心合同，不把其非阻塞 post-release validation debt 自动升级为 0.0.20 功能范围。继续免费、本地优先和 BYOK；本版只复用已有 Skill criteria，不执行 Skill command。

### P0：Criteria schema、catalog 与 provenance

- [x] 复用 Agent Skills 目录，使用 namespaced metadata 指向 strict `wukong.verification-criteria` JSON sidecar（2026-07-25）
- [x] sidecar 只接受 scope + blocking qualitative criteria；拒绝 commands/steps/scripts/tools/permissions/hooks/MCP、unknown fields 和 path escape（2026-07-25）
- [x] 支持 personal/project/package/extra/builtin scope、稳定 precedence 和同名多来源 exact selection（2026-07-25）
- [x] source trust 绑定 workspace identity、personal ownership/permission、extra exact grant 或 builtin release asset；TUI 显示 trust 并支持 exact extra-grant revoke（2026-07-25）
- [x] source/sourceTrust 使用 paired discriminated union；跨 kind 组合、extra sourceId mismatch 和 builtin version mismatch 在 strict schema 层拒绝（2026-07-25）
- [x] 使用 RFC 8785 + domain-separated full SHA-256 冻结 SKILL.md、sidecar、catalog 和 selection；每种 digest 有 golden fixture（2026-07-25）
- [x] deterministic suggested 只来自 versioned path/package rules；model recommendation 单列为 `advisoryHint`，不进入 digest/selection/合同（2026-07-25；当前不主动生成 model hint）

### P0：V3、兼容与 selection CAS

- [x] 新建 additive V3/GatePlanV2；V2 → V3 只能 Revised Loop，新 goal/contract lineage，不热附加（2026-07-25）
- [x] V3 使用 additive workspace trust scope；旧 `loop-project-checks` grant 不能静默扩成 `brokered-review-subject`（2026-07-25）
- [x] 每个 0.0.20 run/restart/continuation（含无 selected Skill 的 V2 contract）单独冻结 broker trust 与 review-subject consent，绑定 workspace、输入 policy/limits、BYOK provider 与 endpoint；Headless 使用 exact challenge/ack，provider/policy 变化必须重新确认（2026-07-25）
- [x] canonical provider origin/digest 与实际 connection 逐次校验；reviewer 使用逐请求 exact-origin transport lock，禁用 redirect；direct origin drift 在调用 fetch 前拒绝，307 跨 origin 不会重发 body，不支持安全锁定的 transport 在 Gate attempt/provider connection 前 fail closed（2026-07-25）
- [x] review-settings assignment 使用 proposal-based 稳定幂等键；同一 Headless/TUI 重试复用首次 acknowledgement/digests，并发不同 proposal 只有一个 CAS 胜出（2026-07-25）
- [x] V3 workspace trust 使用 broker-only / project-checks+broker 判别联合，并与 legacy approval `hasExecutableChecks` 完全一致；无 resolved check 不授予 shell scope（2026-07-25）
- [x] broker trust proposal/grant 创建幂等；reviewer 前后及 PASS 前 revalidate，mid-attempt revoke 立即停止后续读取并使 evidence stale（2026-07-25）
- [x] 完整保存 V2 finish line、trust、Gate approval、review policy 和 legacy Gate Plan；raw shell 仍只由 0.0.19 runner 执行（2026-07-25）
- [x] expected-unresolved 在 V3 中继续 unresolved/零 spawn，不能编译成 command（2026-07-25）
- [x] recipe criteria 投影为带 provenance 的稳定 V3 criterion IDs；Skill 不能删除 V2 criteria（2026-07-25）
- [x] suggested 使用未选状态；只有用户显式选择的 standalone criteria 才进入 flat ordered selection（2026-07-25）
- [x] Headless 用 `--verification-catalog-digest` 与带 expected provenance digest 的可重复 `--verification-skill` compare-and-set（2026-07-25）
- [x] full catalog digest 只做 dry-run → 合同创建 CAS；active run/restart/continuation 只校验 selected refs、selection 和 plan，未选 Skill drift 不阻断（2026-07-25）
- [x] `--dry-run --output-format stream-json` 输出 catalog/deterministic-suggested/selection/criteria/subject-policy/provider-consent/cost；零模型调用，合同创建 CAS 或 selected-ref 漂移时零执行（2026-07-25）
- [x] TUI/Headless 明确二分支：无 selection 创建 V2 并跳过 catalog CAS，有 selection 必须 exact catalog digest 并创建 V3；dry-run 输出 `contractSchemaVersion`/`selectionState`（2026-07-25）

### P0：Review Subject broker 与 fresh reviewer

- [x] reviewer 不获得任意 Read/Glob/Grep/Bash/Skill/MCP/Web，只能读取 attempt-scoped subject/evidence refs（2026-07-25）
- [x] 0.0.20 V2/V3 新 attempt 都走同一 broker；遗留 active V2 缺 consent 时零 reviewer/provider 调用，V1 必须用户确认 Revised V2 后才能创建 attempt（2026-07-25）
- [x] subject manifest 只含 bounded workspace-relative regular text/JSON；hard exclude `.env`、credential/key/cert、auth/session/log/trust、home、binary/generated（2026-07-25）
- [x] manifest policy/consent digest、allowed origins 和逐项/总量 limits 与 run settings exact match；不一致在 provider connection 前 fail closed（2026-07-25）
- [x] path exclusion 后执行 secret-content scan；hard-excluded secret sentinel 不生成 ref，broker read/出站为 0（2026-07-25）
- [x] raw Gate stdout/stderr/evidence 只留本机；brokered copy 使用 versioned redaction + secret scan、128 KiB/项和 1 MiB/attempt 上限，secret/oversize evidence 不产生 readable ref（2026-07-25）
- [x] provider-visible exclusion 只有 attempt-keyed HMAC ID/reason，不含 raw identity/digest；前后重算稳定、跨 attempt 不可关联，ephemeral key/mapping 在 attempt completion 后销毁（2026-07-25）
- [x] subject manifest 在 reviewer 前后重算；超限、excluded dependency 或 workspace drift 不得 PASS（2026-07-25）
- [x] 唯一 fresh reviewer 每个完整 attempt 恰好一次；criteria 与 carried blockers dispositions exact coverage（2026-07-25）
- [x] evidence 使用 `review-subject | gate-evidence` tagged identity；跨 attempt、raw/excluded/未知 ref 或 invalid/incomplete verdict 进入 INCONCLUSIVE（2026-07-25）
- [x] satisfied/resolved/replaced disposition 必须有有效 evidence；PASS 只接受 prior blocker `resolved`，`replaced-by` 必须 NEEDS_WORK；independent/advisory-live finding 不能 blocking，frozen-policy blocker 必须精确匹配 locator/digest（2026-07-25）
- [x] legacy checks 仍每项执行一次，Proof aggregate 只聚合一次；run consent/subject/verdict/aggregate/snapshot/completion/terminal 统一用 `attemptId` 与 exact consent digest durable join（2026-07-25）

### P1：Eval 与真实流程

- [ ] 每个 reference recipe 至少 5 个 should-trigger、10 个 should-not-trigger；3 个 fresh process 的 deterministic suggestion/order/digest 完全一致
- [ ] with/without 配对中 seeded blocker false PASS 为 0，blocking finding provenance/evidence/next-action 完整率 100%，任务完成率不下降
- [ ] adversarial input 覆盖恶意 SKILL.md、criterion、workspace source、stdout/stderr 和 Gate evidence；不能提权、读 secret 或覆盖 blocker
- [ ] 至少 3 个真实仓库、5 组重复工作流、每组 3 fresh sessions；重复验证说明/人工 correction 中位次数下降至少 50%

### 发布门槛

- [x] schema/catalog/digest/CAS/source-trust/provider-consent/origin-lock/broker/redaction/secret-exclusion/prompt-injection/durable-join tests 通过（2026-07-25；全仓 9343 tests passed）
- [x] standalone/flat order/restart/continuation/V1-V2-V3 compatibility 和 fault-injection 通过（2026-07-25；本机自动化）
- [x] macOS/Linux/Windows catalog/path/digest/broker CI 通过（2026-07-25）
- [x] 六平台 SEA/native smoke 通过（2026-07-25；RC run `30150571870`）
- [x] installer 使用公开 `wukong-code` release、Windows exact `win32-*` asset 名，并兼容 `sha256sum`/`shasum`；本地 Bats 9/9 通过（2026-07-25）
- [ ] 至少完成 API compatibility、migration/log-security、frontend/design、monorepo package 四类真实 criteria
- [ ] 无 Skill 新建 V2 的 TUI/Headless brokered reviewer E2E；遗留 V1 未确认时零 attempt、确认后 Revised V2；遗留 active V2 接受 consent 后 additive 恢复，以及拒绝后零 provider/出站/状态漂移 E2E
- [ ] Skill/selected-ref/subject drift、contract-creation catalog CAS、provider consent、workspace/Gate-evidence secret exclusion、subject/evidence limit、irrelevant task、model hint isolation 和 reviewer capability 负向 E2E 通过
- [ ] 固定 5 名新用户各一次且看过后不排除/重试；4/5 区分 suggested/selected/model hint/order，5/5 找到 source/digest/input exclusions/cost、指出 actual BYOK provider/endpoint、理解允许内容会出站但不上传给 Wukong，并能 Cancel 后保持零 run/connection/出站
- [x] README/ROADMAP/TODO/CHANGELOG/release notes 同步 existing-Skills/criteria-only/provider-consent 边界（2026-07-25）
- [x] fresh install、0.0.19 → 0.0.20 upgrade、六平台 assets/SHA、installer、manifest、GitHub Release 和 `wukong --version` 完全一致（2026-07-25；production deployment `7914837c-b547-45f2-982a-2a459b2c9677`）

### 明确不做

- command/argv recipe、sandbox/private scratch/artifact、Skill authoring/scaffold/draft/promotion、embedded binding、recipe dependency graph、动态 chained execution、Marketplace/远程 registry/自动更新/云同步、MCP/公网/secret Gate steps、PR Gate、Team policy、托管 grader、新默认命令、支付/quota 均不进入 0.0.20。

## 🚧 0.0.21 — Isolated Loop Worktrees（开发中）

> 方案：[docs/design/0.0.21-isolated-loop-worktrees.md](docs/design/0.0.21-isolated-loop-worktrees.md)。默认关闭的 Agent RPC/Node SDK/TUI/Headless/stream-json Candidate → exact Promote challenge → Apply → target Final Gate 产品链已形成未发布实现候选。macOS 本地真实临时 dirty Git 仓库 harness 已覆盖 Node/Python/Rust/Go 无依赖 4/4；四生态 fixed-lock dependencyful harness 也已接入，Node/Python/Rust 3/3 本地通过，Go 因本机直连官方 proxy 超时保留给远端门槛。这些 fixture 证据不能替代授权真实项目、远端 CI 或跨平台证据。Target Promotion 与 Worktree/Bootstrap dead-owner recovery 已有本地覆盖；POSIX Target Apply 现使用 descriptor-rooted no-replace/exchange、checked inode 后验与两阶段事务 receipt，只有绑定 preimage/stage inode 的 committed receipt 才能在 outcome 前认领 postimage，普通编辑器并发 atomic-save 不会被 Promote 静默覆盖；POSIX component-level hard-signal matrix 38/38 通过。Windows Candidate/Target 的 NtCreateFile handle-relative、reparse 拒绝、严格私有 ACL、Candidate atomic replace 与 Target no-clobber quarantine transaction 已形成本地实现候选；原生 integration 与 Windows 强制终止恢复用例已接入手动门槛，但尚未在真实 Windows runner 执行。最新分层全仓回归 10122 passed，typecheck/lint/sherif/build/CLI bundle smoke 通过；三 OS/六平台、fixed-SHA CI、授权真实项目和固定五用户验收仍未完成，不能视为可发布。

### Phase 1：Source Snapshot dry-run

- [x] 增加默认关闭的 `isolated_loop_worktrees` experimental flag 和隐藏 Headless untracked selection（2026-07-28）
- [x] 实现 policy/limits、repository identity、repository-relative cwd 与 snapshot digest 绑定（2026-07-28）
- [x] 冻结最低 Git `2.29.0` 要求并在任何 repository 读取前返回稳定 `isolated_loop_git_unsupported` blocker；兼容 Apple/Windows vendor version suffix（2026-07-29）
- [x] 实现 clean、staged、unstaged 和 selected-untracked source projection（2026-07-28）
- [x] 对 secret/generated/oversize/symlink/gitlink/path escape/case collision/index flags/Git environment 与已识别外部 helper fail closed（2026-07-28）
- [x] 接入 `/loop --dry-run` 输出；隔离失败与显式 selection exclusion 均返回稳定 blocker，不静默回退或丢弃（2026-07-28）
- [x] 补齐 snapshot contract、负向策略、preflight 与 CLI targeted tests（2026-07-28）
- [x] 冻结 stream-json Candidate Gate、promotion challenge、target Final Gate 与 resume hint 的完整 JSONL golden；Candidate/Promotion 固定为 `candidateOnly: true`、`terminalPass: false`、`completionSealCommitted: false`、target 未改变且仍需 Final Gate。Final 事件只有完成真实 target Final Gate、completion seal 与 terminal join 后才输出；PASS 或 non-PASS seal 都明确 `completionSealCommitted: true`，仅完整 PASS lineage 允许 `terminalPass: true`。TUI 与 Headless text 使用同一语义，不再显示歧义的泛化 `Gate: PASS`（2026-07-30；CLI/TUI 定向 132/132 通过）
- [x] 完成 TUI Source Snapshot 只读确认 UX：显式多选 eligible untracked 后重新冻结 snapshot；在创建 Goal/candidate 前展示 branch、base、tracked/untracked/exclusion 口径与 exact digest，Cancel 保持零 Goal/run/worktree/source write（2026-07-29）
- [x] 完成分层全仓 test/typecheck/lint/sherif/build/CLI bundle smoke 验证（2026-07-30；root projects 9855 passed，root 外 Wukong Web/Vis 267 passed，合计 10122 passed）

### Phase 2：Blob 与确定物化

- [x] 实现 `WKSMAT01` 不可压缩容器、双 index/worktree postimage、Git index object ID 与 source/policy digest 绑定（2026-07-29）
- [x] 实现私有短生命周期 `SnapshotBlobLeaseV1` 的 stage/seal/confirm/consume/destroy、跨进程锁、CAS/fencing、journal、expiry 与安全 tombstone（2026-07-29）
- [x] 补齐容器截断/尾随/篡改、source mismatch、权限、symlink/hardlink、stale binding、并发 consume、callback failure 与 journal 漂移负向测试（2026-07-29）
- [x] 实现从 source workspace 读取 exact index/worktree bytes 的 sealer，在读取前后复核 snapshot drift，并将 rename 展开为 delete + add（2026-07-29）
- [x] 将 effective snapshot limits 固化进 durable snapshot，sealer 与 candidate 复核不再依赖调用方重建 defaults（2026-07-29）
- [x] 创建 detached `--no-checkout` candidate，确定写入 base/source-index/worktree postimage，复核 materialized source digest 后销毁 blob；仍不接 Agent writer（2026-07-29）
- [x] 阻断 implicit Git conversion、LFS pointer、base symlink/gitlink、candidate root overlap、portable collision 与 concurrent duplicate claim（2026-07-29）
- [x] 实现 Worktree Lease 的跨进程锁、CAS/fencing、hash-chained journal、单步 journal-ahead 修复和 exact-owner resume（2026-07-29）
- [x] 实现 materialization intent/record 到 Worktree Lease 的绑定，以及 record 已落盘、lease 未提交时的幂等恢复（2026-07-29）
- [x] 实现 active-only candidate-root capability、使用前后 identity/fencing 重验，以及当前 holder 的 crash-safe explicit handoff（2026-07-29）
- [x] 冻结并接入 POSIX process liveness proof：PID + OS start marker digest，只有明确不存在或 PID 已复用才判 dead；探测失败、超时、跨平台均 unknown/fail closed，并以 crash-safe pending/event/capability 原子轮换 Target Promotion Lease owner/fencing（2026-07-29）
- [x] 完成 Target Promotion 的 dead-owner runtime recovery：`acquired` 可直接接管；`applying` 先接管 lease 再单调重绑 Apply journal，并逐 change 以 preimage/postimage 决定 apply/reconcile/conflict；`final_verifying` 保留 durable evidence/result/seal 的原 token provenance，通过 attempt lineage 恢复并幂等完成 terminal join（2026-07-29；live/unknown owner、并发接管、PID 复用和 durable boundary 测试通过）
- [x] 完成 Worktree `creating`/`materializing`/`bootstrapping` 的无当前 holder runtime liveness adoption：PID + OS start marker 明确判 dead 后才轮换 process identity/fencing；live/unknown fail closed；materialization record 仅沿同状态 authenticated ownership ancestry 恢复，bootstrap journal 仅在 `ready` 且无 reserved/running step 时重绑，未知 step 保留 attention，重复恢复幂等（2026-07-29）
- [x] 冻结 excluded tracked 与 candidate materialization policy/digest：0.0.21 不实现 overlay，任一 exclusion 均 fail closed，禁止静默丢弃；只有显式批准的 selected-untracked 可物化，决策与 limits 一并进入 policy digest（2026-07-29）
- [x] 冻结 canonical `CandidateBootstrapPlanV1`/step schema、digest、generated scope、deny/explicit-once network 与 lifecycle-scripts-deny 不变量（2026-07-29）
- [x] 冻结 bootstrap budget/reservation/event CAS 合同，unknown usage 保留完整预留，只有 verified actual usage 才释放额度（2026-07-29）
- [x] 冻结 bootstrap execution journal、step 顺序、generated-scope reconciliation 与 no-inflight ownership adoption 不变量（2026-07-29）
- [x] 实现 Bootstrap exact argv/env 私有引用、跨进程锁、回调内使用、先 tombstone 后 exact unlink 的崩溃可恢复销毁（2026-07-29）
- [x] 实现原子 Bootstrap state store，在同一 fsync 边界提交 budget/reservation/journal/event/lease fencing，支持幂等 retry、竞争 prepare 与 retained-unknown recovery（2026-07-29）
- [x] 实现并接入 confirmed `/loop` 产品路径的 POSIX executor：durable prepared/started 后 exact spawn，冻结 env、bounded output/time/generated usage、source projection before/after 与 process-group termination（2026-07-29）
- [x] 补齐 executor exact env、source 越界写、output 超限、timeout、完成后 retry 不重跑、prepared crash recovery 与 Worktree bootstrapping capability targeted tests（2026-07-29）
- [x] 冻结 Node/Python/Rust/Go lockfile/bootstrap 支持矩阵，unsupported/ambiguous/unlocked/runtime-missing 环境稳定阻断；Node 仅接受 package-lock + npm ignore-scripts，Python 仅接受 exact pin + sha256 hash + binary-only requirements，Rust 拒绝 git source，Go 拒绝 replace（2026-07-29）
- [x] 实现 trusted native executable identity/version，拒绝 repo/candidate/generated scope、symlink/hardlink、PATH 间接解析与 inspect/spawn drift；常见 npm script shim 以 native Node + frozen npm package bundle 形成复合 identity；rustup proxy 在 source toolchain 作用域解析并冻结真实 Cargo + rustc 复合 identity，避免把 rustup 当 Cargo 执行；Go module/build cache 通过受限 candidate-relative env binding 固定在 `.wukong-bootstrap`，Node/Python 也禁用全局 cache 与 ambient registry config（2026-07-29）

### 后续阶段

- [x] 增加不可由绝对路径或调用方 policy override 降级的 `workspace-only` 文件工具路径模式，并由 candidate-root view 生成 strict workspace config（2026-07-29）
- [x] 将不可序列化 candidate workspace capability 接入 Read/Write/Edit/Glob/Grep/ReadMediaFile，I/O 前后重验 root/ancestor identity，拒绝 symlink/hardlink 与 Git/Wukong control path；缺 capability fail closed（2026-07-29）
- [x] 为 macOS/Linux candidate 文件工具实现 descriptor-rooted backend：root/逐级目录 fd、`openat(O_NOFOLLOW)`、`mkdirat/renameat/unlinkat`、同目录临时文件 + fsync，以及 bounded descriptor walker；Read/Write/Edit/ReadMediaFile/Glob/Grep 不再依赖路径式 candidate I/O。该边界阻止 path escape，但不宣称对同 UID 恶意进程提供完整 sandbox 或 leaf compare-and-swap（2026-07-29）
- [x] 冻结 Windows 私有 durable root ACL/preflight 合同：原生符号探测零路径写入；proof 必须绑定 normalized root digest，并要求 handle-relative、final path exact、directory/non-reparse、current-user owner、present/non-null/protected DACL、仅 CURRENT_USER + LOCAL_SYSTEM 且对子项继承；Candidate/Target capability 分别区分 ACL 与 handle backend unavailable，任一失败均在 Agent access/durable write 前阻断，定向 24/24 通过（2026-07-30）。该合同证据早于原生实现，不能单独证明 Windows 可用
- [x] 实现 Windows Candidate/Target 本地 backend 候选：NtCreateFile handle-relative open/create、逐级 non-reparse、严格 owner/System DACL、Candidate replace、Target create/delete/rename 与 update quarantine no-clobber transaction、inode-bound receipt/recovery；补 Unicode UTF-16 layout、junction 拒绝、外部 destination 保留与中间 quarantine 恢复（2026-07-30；仅跨平台编译和纯测试，尚无真实 Windows 运行证据）
- [ ] 在真实 Windows runner 验证 handle-relative Candidate/Target、reparse-point/ACL/atomic replace/no-clobber recovery；当前 8 个原生 integration 与 19 个强制终止恢复用例已接入手动 implementation gate，但未运行
- [x] 把 exact guarded workspace 接入受限 Candidate Agent Writer 生命周期；API 强制在 Agent 创建前初始化 exact post-bootstrap baseline，工具面固定为 Read/Write/Edit/ReadMediaFile/Glob/Grep，拒绝 Bash/MCP/Skill/Web/子 Agent/自定义工具/额外目录，并在每次 tool call 前后重验 exact lease digest、fencing、状态、过期时间与 worktree identity；回调结束后泄露工具 fail closed（2026-07-29）
- [x] 实现 Node/Python/Rust/Go deterministic bootstrap preflight/recipe registry，把 executor/state/private-input 基础设施接入 exact confirmation 产品路径；四生态只读 preflight、immutable recipe、exact runtime/argv/env/budget plan、CLI/TUI/Headless review、plan digest confirmation、RPC/runtime 独立重建比对，以及 `materialized → bootstrapping → private input + budget/journal + executor → active` 已接通；常见 npm script shim 使用 native Node + frozen npm package bundle 复合 identity，并在 spawn 前后重验（2026-07-29）
- [x] 实现 canonical Candidate projection/change manifest/delta；bootstrap 后基线与 Agent create/update/delete/rename/mode 分离，generated scopes 排除，原始 dirty snapshot 不重复进入 Agent delta（2026-07-29）
- [x] 实现 capability-bound durable CandidateDelta store；baseline 与 revision-scoped immutable seal 使用私有权限、跨进程锁、原子 fsync，支持失败 Gate 修复后追加新 seal，并对 post-seal mutation、tamper、hardlink、portable collision 与 recovery fail closed（2026-07-29）
- [x] 实现 capability-bound deterministic Candidate Gate：以 shared Git common-dir identity + exact Worktree Lease gate-plan/candidateDelta seal 把 source-approved Gate 重绑到 detached worktree，执行前后复核冻结定义、candidate delta 与 checks/scan；PASS/阻断、失败后修复、check 改写与 definition drift 测试通过（2026-07-29）
- [x] 冻结 canonical `CandidateGateResultV1`：只允许 exact candidate/delta/attempt 与 `PASS|NEEDS_WORK|ERROR`，digest tamper/unknown outcome/stale identity 均拒绝；deterministic 段不得单独生成完整 PASS（2026-07-29）
- [x] 将 exact CandidateDelta 投影为 bounded broker review plan：只发送 Agent 实际 postimage paths，delete/rename/mode 与 pre/post digests 作为 brokered evidence，未变的原始 dirty snapshot 不进入 reviewer subject，并交给后续 origin-locked fresh reviewer（2026-07-29）
- [x] 将 review plan 接入现有 attempt-scoped Review Subject Broker 生命周期：exact verifying lease/source trust/consent/delta seal 前后重验，broker 逃逸、trust revoke、subject drift 与 reviewer 期间 candidate mutation fail closed；broker 只向本轮 origin-locked fresh reviewer开放（2026-07-29）
- [x] 新增 durable Candidate Gate attempt/store：exact lease/delta/Gate/review binding、CAS、event-first journal、单步 crash recovery；invalid reviewer output 只保存 payload digest 并映射 ERROR（2026-07-29）
- [x] 接入 origin-locked brokered fresh reviewer 与 Candidate Gate join：provider consent/redirect lock、broker-only tools、reviewing-before-provider、完整 CandidateGateResult 重读后才进入 awaiting_promotion；NEEDS_WORK 回 active，ERROR 记录 exact recovery transition 后回 active，后续显式 rerun 使用新 verifying revision/attempt（2026-07-29）
- [x] 增加 durable run → candidate binding、Goal record/replay/public summary 与验证 revision 派生的稳定 Gate attempt UUID；候选创建在任何物化写入前先提交 binding，重启可从私有 capability 载体恢复 exact Blob/Worktree owner 与 active/verifying/awaiting_promotion candidate root（2026-07-29）
- [x] 增加 candidate preparer 与单轮内部 orchestration：exact sealer → Blob stage/confirm → Worktree reserve/bind/materialize → optional exact bootstrap → active → 受限 Writer → verifying Candidate Gate；NEEDS_WORK 回 active，PASS 只停在 awaiting_promotion（2026-07-29）
- [x] 增加默认关闭的 Agent RPC/Node SDK/TUI/Headless/stream-json 调用面：实验开启后确认 Finish Line 才启动 Candidate Writer；candidate PASS 只返回 exact promotion challenge，TUI 必须选择 `Promote`，Headless 必须恢复同一 session 并提交 `--promote-candidate <proposalDigest>`（2026-07-29）
- [x] 冻结 Promote 安全前置合同：canonical target fingerprint/registry key、exact candidate/Gate/source/permission consent，以及只保存 fencing-token digest 的单调 Target Promotion Lease；stale consent/token、非法回退和 digest tamper fail closed（2026-07-29）
- [x] 实现用户级 target-global promotion registry/store：每个 canonical target key 使用跨进程锁、隐藏 raw fencing token、CAS revision、event-first journal、单步 journal-ahead recovery、exact-owner resume；并发 owner、旧 binding、篡改 event/capability fail closed（2026-07-29）
- [x] 实现完整 target fingerprint builder、durable Apply journal 与逐 change Apply：锁内重验 exact consent/source/fingerprint，prepared-before-write，create/update/delete/rename/mode 的 pre/postimage 验证，crash 后 postimage reconciliation，外部 drift/conflict fail closed；Apply 后重建完整 target fingerprint 才进入 final_verifying（2026-07-29）
- [x] 冻结 `TargetGateCompletionSealV1` 纯合同：三类 private artifact 必须恰好各一个且顺序固定，长度/hash/lineage/coverage/fencing 全部进入独立 digest；完整 NEEDS_WORK/ERROR 可留证，但只有 PASS seal 可作为 terminal PASS 候选（2026-07-29）
- [x] 实现 target Final Gate durable attempt/store/orchestrator，并把现有 Goal Gate ordered checks/risk/criteria/fresh reviewer/proof audit 重新绑定到 exact post-Apply fingerprint、journal head 和 fencing token（2026-07-29）
- [x] 实现 private completion artifact store、seal 后 exact-byte 重读校验、一次性 terminal authorization、Goal completion-seal record 与幂等 terminal join；覆盖 terminal 已提交但 target lease release 失败后的 exact retry 和 record replay（2026-07-29）
- [x] 接入默认关闭的 Candidate Writer → Gate → exact consent → Promote Apply → target Final Gate → completion seal → terminal join 产品 orchestration；Candidate/Goal workspace digest 使用各自 canonical namespace，不能误作相同 digest，只有 completion seal 后才可显示根 PASS；Target Promotion 从 pre-Apply 到 historical seal/terminal release 的 dead-owner recovery，以及 Worktree/Bootstrap 无 holder adoption 已接 runtime（2026-07-29；发布门槛仍待完成）
- [x] 增加真实临时 Git 仓库完整 E2E：确认前 source 零写入、stale digest 零写入、exact Promote 后 Apply、target Final Gate PASS、completion seal 与 terminal join；并修复首次 Candidate 私有状态根未创建、target Final Gate 未持久化 exact Goal audit 两个产品接线缺陷（2026-07-29）
- [x] Promote 在 terminal 前失败时，Headless/TUI 都重新暂停 Goal 并保留 exact candidate/challenge，避免恢复后遗留 active Loop（2026-07-29）
- [x] 补 Target Final Gate 两个 durable boundary：evidence 前 cancel 只保留 prepared/non-terminal 且可精确恢复；evidence 已落盘后重启不重复调用 producer，直接完成同一 attempt（2026-07-29）
- [x] 完成 promotion Apply cooperative cancel boundary：已取消 signal 在首个 write 前零写入；每个 change 的 durable `applied`/`reconciled` event 后再次检查 signal，取消时保持 `applying` 和 journal 可恢复，retry 不重复已提交 change；Target Final Gate evidence 前取消保持 prepared/non-terminal（2026-07-29）
- [x] 完成 durable error pre-redaction 审计：Worktree/Bootstrap/Apply/Final Gate journal 只持久化固定 reason/status/digest；fresh reviewer exception 的任意 message/reasonCode 在写 Candidate Gate attempt 前映射为固定 allowlist，provider secret sentinel 不进入 durable attempt（2026-07-29）
- [x] 完成 late-write fencing 与 Apply operation fault matrix：Candidate Writer 泄露工具在 callback 后失效；Target Apply 独占 OS lock 覆盖整个 callback，escaped authority 失效；create/update/delete/rename/mode 全路径通过。五类 operation 只有在私有 identity + committed receipt 能证明 Wukong 已完成原子 syscall 时，才会在 outcome 未提交的恢复中追加单个 `reconciled`；prepared 后由外部写出的同内容 postimage 没有 receipt 会 fail closed（2026-07-30）
- [x] 完成 POSIX Target Apply final-leaf no-clobber：Linux `renameat2` / macOS `renameatx_np` 的 no-replace/exchange、held-FD `(dev, ino)` 后验、deterministic owner/identity/committed markers、rename parent fsync 与 nested delete recovery 已接入；receipt 会在 syscall 前持久化 preimage/stage `(dev, ino)`，先 durable `applied/reconciled`，再以 identity-bound cleanup manifest 把整个事务目录原子隔离到 cleanup namespace 后幂等删除。cleanup manifest 准备、目录隔离、部分 artifact 删除或 manifest 删除后的中断均可恢复，篡改则 fail closed；create/update/delete/rename/mode 在 final check 前后的同 bytes/mode atomic-save 都保持外部 inode，无 receipt postimage 均阻断。最新 Target/Promotion 相关回归 86/86、cleanup 中断/篡改 5/5 通过（2026-07-30）。该边界不宣称隔离专门伪造内部 artifact 的同 UID 恶意进程；完整 process sandbox 明确不进入 0.0.21
- [x] 完成 POSIX OS hard SIGINT/SIGTERM 进程级故障注入：Source Snapshot sealer 四边界 8/8 保持 source HEAD/index/staged/unstaged/untracked 逻辑状态不变；materializer 在 candidate record 已同步后的 2/2 按 exact ancestry 回收 stranded source Blob；Bootstrap `step_running` 2/2；Candidate Writer temporary fsync、final-leaf check 与 atomic replace 两侧 6/6 只暴露完整旧/新 leaf；Target Apply、Final Gate 与 completion seal production-path 10 个 signal case、synthetic target durable/terminal boundaries 10 个 case 已通过，含 outcome durable、receipt 尚未清理的恢复（2026-07-30）
- [ ] 在真实 Windows runner 执行已接入的 19 个 forced-termination 等价用例：Source sealer 4、materializer 1、Bootstrap 1、Candidate Writer 3、Target Apply/Final Gate/completion 10；POSIX 38/38 与本地 skipped/编译结果不能外推为 Windows 通过
- [x] 增加 macOS 本地 Node/Python/Rust/Go 四生态 dirty-workspace Candidate → Gate → Promote → target Final PASS harness，4/4 通过；fixture 主要无外部依赖，不计作依赖完整真实项目或跨平台证据（2026-07-29）
- [x] 增加 Node/Python/Rust/Go 四生态 fixed-lock dependencyful bootstrap 完整 Loop：分别绑定 npm lock integrity、Python exact hash/binary-only wheel、Cargo.lock checksum 与 Go sum/vendor，依赖代码必须在 Candidate Gate 和 target Final Gate 被真实执行。Node/Python/Rust 3/3 本地通过；Go 的官方 `proxy.golang.org` 在本机只能经 ambient proxy 访问，而 bootstrap 按设计不继承未批准 proxy，因此本地直连超时且不计为通过（2026-07-30）
- [x] 增加仅手动触发、不发布 artifact 的 isolated-loop implementation-gates workflow；只接受精确 40 位 lowercase commit SHA，每个 job checkout 后复核 exact HEAD 且不持久化凭据，包含分层全仓门槛、三 OS dirty-loop、POSIX hard-signal、Windows 原生 backend/termination 和四生态 dependencyful job；移除 dirty-loop harness 对 Windows 的主动 skip，并按平台选择 `python`/`python3`；network job 严格要求四个 fixed-lock Loop 4/4，不接受 skip（2026-07-30；全部 workflow 通过 actionlint v1.7.7；macOS 按 workflow 原命令生成的 Vitest JSON 为 8 total / 4 passed / 4 intentionally skipped / 0 failed，四个 dependency-free ecosystem 标题和四个 dependencyful skip 标题均精确匹配；dependencyful 3/4 本地复核，尚未提交或远端运行）
- [x] 将日常 CI 测试分为 affected + 208 个 mandatory safety anchors；完整 suite、CLI coverage、root Vitest 未覆盖的 wukong-web/vis suite，以及 macOS/Windows criteria 移到 nightly。Nightly 以 coverage 结果替代重复的普通 CLI 全量执行，少执行约 2400 项；release workflow 继续保留完整自动化、hard-signal、真实生态与跨平台门槛（2026-07-30；208/208 本地通过，workflow 尚未提交或远端运行）
- [x] 完成稳定的分层全仓 test/typecheck/lint/sherif/build 回归（2026-07-30）：`test:full:bounded` 将 verification、agent-core、CLI 与其余 root projects 隔离执行，root 合计 753 files / 9855 tests passed、11 files / 71 tests skipped、2 todo；root Vitest 未覆盖的 Wukong Web 173/173、Vis Server 93/93、Vis Web 1/1 通过，总计 781 files / 10122 tests passed。typecheck、lint（0 warning/error）、sherif、build、CLI bundle smoke、CLI coverage gate（statements 76.72%、branches 67.57%、functions 79.40%、lines 78.87%）、publint/attw 与 `git diff --check` 通过；Node 26 `shell: true + args` 弃用/安全警告已改为位置参数探测与无 args shell spawn，并由 Verification 295/295、Server 666/666 的 `--trace-deprecation` 回归证明无 `DEP0190`；该本地证据不替代 fixed-SHA CI 或真实 Windows runner
- [x] 完成本地 recovery/cleanup 与 Windows backend 实现候选：Worktree/Bootstrap/Promotion/Final Gate/completion/terminal dead-owner 或 hard-signal 恢复、Target quarantine 中间态重入及安全清理均有定向测试；本地无遗留测试进程或生成物漂移（2026-07-30；真实 Windows 结果仍由独立门槛约束）
- [x] 接入仅手动触发、无发布权限的 full release-candidate workflow：单一 exact lowercase 40 位 source SHA 先调用完整 implementation gates，全部通过后才允许六平台 native matrix 启动，避免不同 SHA 的证据错配并在功能门槛失败时节省六平台额度；native 阶段另强制 package version `0.0.21`，每个平台从本矩阵 ZIP/SHA 运行 `install.sh` fresh install，再从公开 `0.0.20` 升级到同一本地 artifact 并执行 `wukong --version`。安装器新增严格 `WUKONG_VERSION`、测试专用 artifact base 与 target override，13/13 Bats 通过（2026-07-30；临时完整工作区执行真实 `changeset version` 已确认只修改 CLI package/changelog、消费该 changeset 并得到 `0.0.21`，lockfile 与其他 package 不漂移；changeset 已正式应用，当前 CLI package 为 0.0.21；本机 darwin-arm64 已从当前源码构建 ZIP/SHA，并通过本地 0.0.21 fresh install 与公开 0.0.20 → 本地 0.0.21 upgrade，两个阶段实际执行安装后的 `wukong --version` 均匹配；尚未形成或运行 fixed-SHA 六平台 RC）
- [ ] 在固定 SHA 的真实 runners 完成三 OS worktree E2E、六平台 fresh install 与 0.0.20 → 0.0.21 upgrade；workflow 存在、本机旧版本控制路径或 artifact 上传都不能替代六个平台的实际结果
- [ ] 按 [0.0.21 用户验收协议](docs/test/0.0.21-user-acceptance.md) 完成预先冻结的 5 名目标用户单次验收：5/5 区分 Candidate PASS 与 Final PASS、5/5 理解非完整 sandbox、4/5 独立 Promote 或处理 source drift；协议已冻结但尚无真人结果，不能用内部测试者、重试或自动化替代
- [ ] 四类发布门槛全部取得固定 SHA 的真实 evidence；本地 harness 文件、skip 或未运行 workflow 不能替代

### 明确不做

- 多 Agent 并行、完整 sandbox、自动 stash/commit/reset/push、云端 runner、付费/quota/telemetry 或新默认顶层命令不进入 0.0.21。

## 🧭 已确认后续版本（未批准开工）

> 本节只保证候选方向可发现，不是当前执行任务。只有 0.0.21 完成发布门槛并经过新的产品决策后，才把对应规格展开成可勾选 TODO。

### 0.1.0 — Trusted Local Loop

- 规格：[docs/design/0.1.0-trusted-local-loop.md](docs/design/0.1.0-trusted-local-loop.md)
- 候选价值：把 0.0.19 Finish Line、0.0.20 criteria/broker/consent 与 0.0.21 worktree/Promote/Final Gate 收敛为第一版可稳定推荐的 Free 本地 Loop。
- 可靠性收口：冻结 repository-stable `findingId` / per-attempt `occurrenceId`、coverage-aware `new/persisting/reopened/resolved/unknown`、immutable observation + mutable feedback；只有验证并 seal 的完整 evidence 才能提交 terminal。
- 发行收口：GitHub Actions full-SHA pin、`persist-credentials: false`、tag/version/main/release identity 校验、build-once/publish-exact verified artifact 与 OIDC provenance。
- 进入实施前：0.0.20 与 0.0.21 四类门槛完成；RC 只修稳定、兼容、安装升级、恢复和 public truth，不再加大功能。
- 公开门槛：25 名 opt-in 外部测试者、15 名首次 target Final Gate `PASS`、7 名在 14 天内对第二个不同 Goal 再次 `PASS`、3 个授权案例；P0/P1、false PASS、workspace damage 和隐私误解未解决项为 0；RC 连续稳定 14 天。
- 条件性窗口：0.1.0 RC 目标 2026 年 10 月，公开版最早 2026 年 11 月；门槛未过就顺延。
- 不提前做：并行、Detach/Supervisor、PR Gate、Billing、managed model、云端执行、Team 或 telemetry 后端。

### 0.1.1 — Security Evidence Adapters

- 规格：[docs/design/0.1.1-security-evidence-adapters.md](docs/design/0.1.1-security-evidence-adapters.md)
- 候选价值：Free、local-first、默认关闭的 provider-neutral evidence contract；首批支持 Codex Security canonical JSON 与 generic SARIF，后续 scanner 只能实现同一 adapter。
- 两种路径：显式导入已存在 artifact；或用户确认 exact adapter/package、resolved child executable、target/scope/budget/credential 边界后调用本机 producer。两者都先验证 schema、target、coverage、hash/seal，再进入 Wukong Gate。
- 复用边界：可选 adapter 精确锁定 `@openai/codex-security@0.1.1`；public SDK 直接使用，小型 `trusted-executable` 原语可带 attribution vendor/adapt；不把 Python/SQLite Workbench、Codex Skills/MCP 整体引入 core。
- Gate 边界：external evidence 只能增加 blocker 或满足 frozen required producer，不能覆盖 deterministic failure、Promote/Final Gate 或单独产生 root PASS；partial/cancel/error/corrupt evidence 一律 unknown/inconclusive。
- 进入实施前：0.1.0 stable；finding/coverage/seal contract 固定；许可证/attribution 已审计；corrupt-resume、cancel/late-write、pre-persist redaction、budget exhaustion 与 Windows path 负向测试通过。
- 不提前做：bulk/deep multi-agent scan、Detach/Supervisor、Git hook、自动 patch/push/PR write、云端 runner、Billing 或 Team policy。

### 0.2.0 — Pro Reliable Autonomy

- 主规格：[docs/design/0.2.0-pro-reliable-autonomy.md](docs/design/0.2.0-pro-reliable-autonomy.md)
- 组件：[Bounded Parallel Loop](docs/design/0.2.0-bounded-parallel-loop.md) / [Local Loop Supervisor](docs/design/0.2.0-local-loop-supervisor.md)
- 候选价值：一个 `/loop` 在 2–5 个独立 worktree 中有界并行；用户显式 Detach 后由本机 Supervisor 只提升 approval、问题、冲突、预算和终态；可选 external evidence job 是 bounded leaf，Verified PR Gate 只作 exact evidence-bound bundle 增益。
- Free 永久保留：单前台 Loop、BYOK、Resume、Finish Line、criteria、isolated worktree、safe Promote、target Final Gate 与 0.1.1 单 producer import/execute；不对 Loop/token 或基础安全检查设 quota。
- 编排边界：planner/child/retry/reviewer/security evidence/integration/Final Gate 共用 aggregate hard budget；partial coverage、corrupt artifact、cancel 或 late completion 不能被其他 child PASS 抵消。
- Supervisor/PR Gate：resume 重新验证 producer/version/coverage/seal 与 fencing；Cancel durable terminal 拒绝 late write；PR write 绑定 exact commit SHA、Final Gate digest 和 evidence bundle digest。
- 进入实施前：0.1.0 发布并稳定观察至少 30 天，0.1.1 adapter contract/负向测试稳定，15 位外部完成、7 位重复，且 5 位目标用户出现重复多任务监督需求。
- Pilot 门槛：一个邀请制月付 SKU，候选 `$12/月`；10 人受邀、5 人真实使用、3 人付款、2 人续费。达到后仍保持 invite-only；只有另行达到 10 个付费用户、5 人 30 天重复、3 人续费且 P0/P1 为 0，才允许评审 public Checkout。
- 不提前做：无界 Agent Tree、云端/跨设备执行、自动审批/加预算、开机自启、Team/SSO/audit、managed credits 或 telemetry 后端。

## ✅ 0.0.18 — Loop-First Simplification

> 方案: [docs/design/0.0.18-loop-first-simplification.md](docs/design/0.0.18-loop-first-simplification.md)。已于 2026-07-22 发布。本版继续免费/BYOK。命令精简只改变默认可见性，不删除底层实现；唯一需要真正删除的是 `/feedback` 中会上传日志、session 或代码库的附件路径。两项发布后遗留已移入 0.0.19。

### P0：默认命令面与 Loop

- [x] 为 slash command 增加 core / advanced / hidden 分层；默认 help、autocomplete、welcome 只突出 Resume → Loop → Gate（2026-07-22）
- [x] `/goal`、`/auto`、`/yolo` 等默认隐藏但仍可直接调用；`/login`、`/logout` 保持可发现，并增加自动化防止 handler/dispatch 被误删（2026-07-22）
- [x] 默认 UI 的 Goal lifecycle 文案统一成 `/loop status|pause|resume|stop`；Goal engine、queue、gate 和旧记录兼容保持不变（2026-07-22）
- [x] 将 `/permission` 作为 TUI 默认 permission 入口；全局 `--auto`、`--yolo` 继续支持 headless（2026-07-22）
- [x] `/help advanced` 可发现内部检查、本地 reviewer、workspace/session/UI 工具；`/transform` 继续在实验未启用时可发现（2026-07-22）
- [x] 恢复 CLI device flow → 网站确认 → token/refresh → `/api/v1/models` 空目录 → usage/logout 链路；有效 token 的 404 不得作为 expected skip（2026-07-22）

### P0：Managed Wukong 与 Login

- [x] `/login`/`wukong login` 申请 device code，打开或显示 Wukong 网站确认页，用户用 Google/GitHub 批准后完成 token exchange/refresh；CLI 不接收账号密码且每个失败阶段可辨认（2026-07-22）
- [x] Web catalog 验证 access token；当前返回 `200 {data: []}`，不恢复 `wukong-for-coding` 或任何 placeholder（2026-07-22）
- [x] 空 catalog 仍判定登录成功并保留 token；不创建 managed model alias、不覆盖 BYOK provider/default，显示“已连接账号，当前无 Wukong 模型”（2026-07-22）
- [x] catalog 404/5xx 保留未来的 last-known-good 且明确报错；`200 data: []` 是正常空状态，只有 token 缺失时安静跳过 refresh（2026-07-22）
- [x] `/usage`、`/status` 在登录且 BYOK 模型仍为默认时也显示真实 managed usage；当前为 null/empty，不虚构 Guest/Free 限制（2026-07-22）
- [x] `/logout` 只清理 Wukong token/provider/default alias，不删除其他 BYOK provider（2026-07-22）
- [x] Privacy 明确 0.0.18 没有 Wukong 托管推理或 prompt 上传；production 已验证 device authorization → 网站确认页、有效 token → 空 catalog/空 usage，BYOK 保持测试与 logout/re-login 自动化通过（2026-07-22）

### P0：Cross-Agent Resume

- [x] `SessionSource`、补全、picker、welcome、handoff 增加 `kimi` 和 `grok`（2026-07-22）
- [x] Kimi Code 读取 `.kimi-code/session_index.jsonl`、session `state.json` 与有界 user history；新格式存在时不重复扫描 `.kimi` legacy（2026-07-22）
- [x] Grok 只读发现受支持的 session summary/chat history JSON 格式；禁止读取 auth、system prompt、terminal logs、memtrace 和隐藏状态（2026-07-22）
- [x] 增加 `resume-kimi`、`resume-grok` 内置只读 import skill；不新增公开 `/resume-kimi`、`/resume-grok` 命令（2026-07-22）
- [x] 覆盖 realpath/root containment、symlink escape、损坏记录、格式版本和 workspace 过滤 fixture（2026-07-22）

### P1：文本 Feedback

- [x] `/feedback` 无需登录或 managed provider，提交前预览精确字段并显式确认（2026-07-22）
- [x] 只发送 message/category/version/platform/arch/可选 Loop outcome、reason code、contact（2026-07-22）
- [x] 删除 logs、codebase、session archive、presigned upload、upload complete 和 feedback telemetry event（2026-07-22）
- [x] 覆盖 Cancel、Submit、429/503、GitHub fallback 和不读取文件/日志的隐私负向测试（2026-07-22）

### 发布门槛

- [x] 命令分层、Resume、Feedback、网站确认 OAuth/空 catalog 的 targeted tests 和完整 test、typecheck、lint 通过（2026-07-22）
- [x] docs build、bundle/native SEA smoke 与真实 TUI smoke 通过（2026-07-22）
- [x] 六平台 assets/SHA、0.0.17 → 0.0.18 upgrade 和 0.0.18 fresh install 通过（2026-07-22）
- [x] 三仓 README/ROADMAP/TODO/release notes/Changelog/installer/manifest 一致（2026-07-22）
- [x] Web Feedback API、D1 retention/purge、Privacy/Terms 和 production E2E 通过；测试反馈已精确清理（2026-07-22）

### 明确不做

- 支付、本地 Loop quota、托管模型/推理、付费 managed credits/套餐、Hosted Terminal/Report、云同步、telemetry 指标后端、PR/Team、`/schedule` 和 feedback 附件均不进入 0.0.18；本版本只完成网站确认登录与可为空的模型目录基础。

## ✅ 0.0.16 — Loop Convergence

> 方案: [docs/design/0.0.16-loop-convergence.md](docs/design/0.0.16-loop-convergence.md)。本版继续免费/BYOK，重点是让 Loop 围绕固定目标收敛；不做支付、PR Gate 写入或默认多 reviewer。

### P0：Acceptance Contract 与持久化

- [x] 定义 `LoopContract`：冻结 objective、可选 completion criterion 和 verification plan；0.0.16 不让模型生成额外 criteria（2026-07-20）
- [x] objective 原文保持权威，不允许 writer/reviewer/strategist 覆盖或静默修改（2026-07-20）
- [x] 增加 `goal.contract.create`、`goal.review.record`、`goal.strategy.record` append-only records 与 restore（2026-07-20）
- [x] restart/resume/compaction 后恢复合同、prior blockers 和 strategy 状态（2026-07-20）
- [x] 旧 Goal 第一次进入 0.0.16 Gate 时生成 fallback contract，不伪造旧 review history；旧 strategy record 自动归一化（2026-07-20）

### P0：Prior Gaps 与 Reviewer Anti-ratchet

- [x] Reviewer 输入增加冻结合同和 prior blockers，逐项返回 resolved/still-open/replaced-by（2026-07-20）
- [x] blocking finding 必须关联有效 `criterionId`，由 harness 生成 stable blocker key（2026-07-20）
- [x] 对排序去重后的 blocking keys 生成 fingerprint，不使用自然语言、绝对路径或 line number（2026-07-20）
- [x] 新 blocking finding 必须关联固定 criterion；风格偏好保持 important/note（2026-07-20）
- [x] deterministic blocker 不可被 reviewer 覆盖，review 后继续校验 workspace freshness（2026-07-20）

### P0：Stall Strategist 与 Model Fallback

- [x] 连续两轮相同 fingerprint 触发一次 read-only strategist；每个 Goal 最多尝试一次（2026-07-20）
- [x] strategist 输出固定 diagnosis/recommendedApproach/risks schema，不能修改 workspace、policy、Role 或合同（2026-07-20）
- [x] strategist fail-open、不增加 quota/maxIterations；仍相同则 `NEEDS_WORK/no_progress`（2026-07-20）
- [x] 显式 reviewer model 不可用时回退当前 writer model 一次；invalid output 同模型重试一次，用户取消不回退（2026-07-20）
- [x] invalid output、model unavailable、fallback failure 和 check infrastructure error 使用稳定独立 reason code（2026-07-20）

### P0：Permission Mode v2 与分身权限上限

- [x] 重排 permission policy，保证 hard deny/profile ceiling/Plan guard/用户 deny 先于 Auto/YOLO 决策（2026-07-20）
- [x] Auto 改为不提问的受限自主模式：workspace 外写入、敏感目标、高风险 Bash 和未分类 MCP/custom tool 阻断并暂停（2026-07-20）
- [x] YOLO 明确为危险 approval bypass，但不能绕过用户 deny、安全 hook、Plan guard、profile allowlist 或只读 capability（2026-07-20）
- [x] Headless `-p` 默认使用受限 Auto；危险执行要求 `--yolo --yes`，单独 `--yes` 不再启用 YOLO（2026-07-20）
- [x] 旧 `--auto-approve` 增加弃用/危险警告，旧 permission records 与 `default_permission_mode` 保持可恢复（2026-07-20）
- [x] 修复 child custom-tool 继承：只注册工具，不绕过 child profile 激活；reviewer/planner/strategist/read-only explore 强制只读（2026-07-20）
- [x] footer 与 `/status` 显示当前 permission mode，`/tasks` 显示实际任务，YOLO 使用持续危险提示（2026-07-20）

### P1：Resume、Role、TUI 与 Session Search

- [x] Welcome suggestion 仅扫描当前 workspace、最近 30 天、每来源最多 50 条，并支持 opt-out（2026-07-20）
- [x] suggestion 只显示一条；选择后仍需只读 import、workspace re-check 和 objective 编辑确认（2026-07-20）
- [x] Role schema 增加可选 inputs/outputs/capabilityMode；与 tools/base profile 取交集，不能扩权（2026-07-20）
- [x] planner/reviewer/strategist 使用明确 Role contract，均固定 read-only（2026-07-20）
- [x] footer 只显示一条紧凑后台任务状态，详细状态与输出统一留在 `/tasks`，不向 transcript 重复写状态说明（2026-07-20）
- [x] session picker 搜索最近 100 个 session 的有界本地 prompt 摘要，支持 debounce/cancel，不增加 native SQLite 依赖（2026-07-20）

### 指标、E2E 与发布

- [x] 增加不含 objective、criterion、blocker、路径、session id 或 transcript 的 convergence metrics（2026-07-20）
- [x] 增加只含 mode、阻断类别和 capability 类别的 permission metrics，不上传命令、参数、路径或自定义工具名（2026-07-20）
- [x] 真实 Node/Python/Rust/Go 项目覆盖 check blocker → fix → PASS（2026-07-20）
- [x] 覆盖 repeated blocker → strategist → unblock/no-progress 两条 contract 路径（2026-07-20）
- [x] 覆盖 invalid/unavailable reviewer model → retry/fallback 和两模型失败（2026-07-20）
- [x] 覆盖 TUI/Headless Manual、Auto、YOLO、`--yes`、`--auto-approve` 和旧 config/record 兼容矩阵（2026-07-20）
- [x] 覆盖 Auto/YOLO 父 Agent 下 reviewer/strategist 仍保持只读，以及 coder 只继承合法工具交集（2026-07-20）
- [x] Codex/Claude Code/Cursor suggestion → resume → edit objective → Loop terminal PASS TUI E2E（2026-07-21）
- [x] 0.0.15 Goal/session/Role compatibility、durable lifecycle、outbox 和 completion API 全量回归（2026-07-20）
- [x] Core/CLI/全仓 test、typecheck、lint、docs/bundle build、macOS arm64 SEA/native smoke 通过（2026-07-21；全仓并发 fs-watch burst 超时已单文件串行 7/7 复验）
- [x] 正式 tag 后六平台 ZIP/SHA assets、0.0.15 → 0.0.16 upgrade 与 fresh install 通过（2026-07-21）
- [x] 内部中英文 README、用户指南、CHANGELOG、release notes 与设计文档同步（2026-07-21）
- [x] 正式发布时同步公告、公开 repo、Web 当前版本/下载/Changelog 文案（2026-07-21）

### 明确不做

- 支付、GitHub PR 写入、Team、managed reviewer、默认多 reviewer、云端 `/schedule`、远程 session、Hosted Report、Agent/Persona 市场和自动 policy 修改均不进入 0.0.16。

## ✅ 0.0.17 — Command Surface Reliability

> 方案: [docs/design/0.0.17-command-surface-reliability.md](docs/design/0.0.17-command-surface-reliability.md)。本版继续免费/BYOK，只收口现有 CLI/TUI 命令契约，不新增 Agent 引擎、托管能力或商业功能。

### P0：命令契约

- [x] 删除全局与 Loop `--role`，删除 TUI `/role`；Role 管理统一为 `wukong roles list|show|init`，会话切换统一为 `/transform`（2026-07-21）
- [x] 删除 TUI `/report` 与 `/yes`，保留 Loop/Gate、高级 `/proof` 和明确 permission 命令（2026-07-21）
- [x] `/transform list|status|off` 可发现；补全包含内置与自定义 Role；实验未启用时提供本地 `/experiments` 指引（2026-07-21）
- [x] 未知、禁用和当前不可用 slash command 在本地拦截并给出建议，不发送给模型；保留 `/dance`（2026-07-21）
- [x] `/auto`、`/yolo` 非法参数不改变 permission mode，`/settings` 只允许 idle 状态打开（2026-07-21）
- [x] Loop 数值严格解析且 dry-run 显示 writer/reviewer model；`/export` 统一 ZIP、Markdown 使用 `/export-md`（2026-07-21）
- [x] Today focus/clear 冲突在写入前拒绝，`wukong roles` 未知子命令返回明确 usage（2026-07-21）
- [x] Fresh reviewer prompt 与 Read/Glob/Grep 只读工具集一致，并增加 8-step / 2-minute 硬上限；超限返回独立 ERROR，不让 Loop 永久停在 CHECK（2026-07-22）
- [x] 删除 Guest trial、Free 月度 Loop quota、远程 start/complete 准入和 unavailable 警告；保留默认 10 轮、`--max-iterations`、reviewer 硬上限、`/loop stop` 与纯本地恢复记录（2026-07-22）

### P0：自动化回归

- [x] 覆盖 registry/resolve/dispatch 的命令可见性、实验开关、idle gate、参数拒绝、建议和不会调用模型（2026-07-21）
- [x] 覆盖 `--role` 删除、Loop 数值、Today 无副作用、roles 子命令和 permission mode 真实边界（2026-07-21）
- [x] 命令回归覆盖新增的 roles help 与 transform list/status；完整 app 205 个 test files 通过、2 个跳过，2408 项通过、3 项跳过（2026-07-22）
- [x] 覆盖 reviewer step/time 上限、结构化错误传播和取消语义；全仓 685 个 test files 通过、8 个跳过，9308 项通过、48 项跳过、2 项 todo（2026-07-22）
- [x] app typecheck 与 oxlint 通过，0 warning / 0 error（2026-07-21）

### 发布门槛

- [x] 真实 TUI `/loop` smoke PASS：writer 一轮完成，deterministic check 通过，fresh reviewer 仅使用 3 次 Read 返回结构化 PASS，终态释放且 `/loop status` 显示无 active Loop（2026-07-22）
- [x] 完成剩余真实 TUI smoke：`/transform list|status|off`、实验指引、删除/未知 slash、本地 permission 错误与 ZIP/Markdown export；额外修复 `/role` 被误建议为 `/yolo`（2026-07-22）
- [x] macOS arm64 bundle/native SEA smoke 与 ZIP SHA 生成通过（2026-07-22）
- [x] 六平台 ZIP/SHA assets、0.0.16 → 0.0.17 upgrade、0.0.17 fresh install 与线上 `curl | sh` 均通过；安装器未恢复 telemetry 提示行（2026-07-22）
- [x] 增加 0.0.17 release notes，完成内部 CHANGELOG、README、用户指南和设计文档最终对账（2026-07-22）
- [x] package version、`v0.0.17` tag、公开 release、Web manifest、下载页、Changelog 与仅面向 0.0.16 的升级公告已同步；Cloudflare production 与正式域名验收通过（2026-07-22）

### 明确不做

- 支付、GitHub PR 写入、entitlement、Team、managed reviewer、云端 `/schedule`、`/ship`、Hosted Report、同步闭环、默认多 reviewer、`--agent` judge mode、Role/Agent 市场、mascot 与 welcome 动画均不进入 0.0.17。

## 历史候选：Pro PR Gate + Billing（已被取代）

> 归档方案: [docs/design/historical-pro-pr-gate-billing.md](docs/design/historical-pro-pr-gate-billing.md)。这是历史研究清单，不是当前 TODO；它已被 0.1.0 Free Trusted Local Loop 与 0.2.0 Pro Reliable Autonomy 候选取代。
>
> 2026-07-20 生产基线：8 个注册用户、1 个 activated Loop user、0 个 completed users。支付决策门槛尚未满足；公开 Checkout 默认关闭。

历史方案曾假设把 PR Gate 作为唯一收费点；其用户门槛、工程阶段与 `$9/月` 价格只保留在归档文档中。这里不保留未完成 checkbox，避免自动任务扫描把它们当成当前 P0。

## ✅ 0.0.15 — Loop Reliability + First Success

> 方案: [docs/design/0.0.15-loop-reliability.md](docs/design/0.0.15-loop-reliability.md)。本版继续免费/BYOK，先解决 Loop 可靠结束、重启恢复和首次成功，不做支付或 GitHub PR。

### P0：Lifecycle Contract 与持久化

- [x] 冻结 `LoopRunStatus`、`LoopOutcome`、状态迁移和旧 `/complete` payload 兼容（2026-07-20）
- [x] 将 TUI `requestId → goalId/sessionId` tracking 从内存迁移到 `~/.wukong/usage/loop-runs`（2026-07-20）
- [x] 本地 record 使用 `0600`、atomic rename，不保存 objective、prompt、transcript 或 diff（2026-07-20）
- [x] headless/TUI 的 PASS、NEEDS_WORK、ERROR、cancel 和启动失败均写入 terminal record（2026-07-20）
- [x] CLI 重启后发现 active Loop，支持 Resume / End as cancelled / View details；terminal SDK Goal 自动对账（2026-07-20）

### P0：Completion Outbox（0.0.17 已由纯本地 lifecycle 取代；以下为 0.0.15 历史实现）

- [x] completion 网络失败写入 outbox，不改变本地 Gate 结论（2026-07-20）
- [x] CLI/TUI 启动、session resume、today/doctor 和新 Loop 前 fail-open flush（2026-07-20）
- [x] 区分 401、409、5xx、timeout；实现有上限指数退避（2026-07-20）
- [x] start/complete 服务端幂等，跨用户 requestId 隔离，冲突终态返回 409（2026-07-20）
- [x] 旧 started rows reconciliation；metrics 区分 cancelled、abandoned 和 stale started（2026-07-20）

### P0：Preflight 与首次成功

- [x] provider/model、workspace、objective、active Goal 和 checks discovery 在本地 lifecycle record 前完成（2026-07-20；2026-07-22 移除 quota start）
- [x] preflight 失败不创建本地 lifecycle record，并只显示 Reason + Next（2026-07-20；2026-07-22 移除服务端准入）
- [x] 初次 TUI 只突出 Continue a task / Start a Loop / Configure model（2026-07-20）
- [x] 无 checks 返回 NEEDS_WORK + 配置指引，不误写为测试失败或 PASS（2026-07-20）
- [x] 最终结果默认只显示 Gate、Iterations、Primary blocker 和 Next；高级诊断保留在 transcript（2026-07-20）

### P1：隐私指标与 Dashboard

- [x] 定义并实现 `install_success`、`first_run`、`resume_selected`、`loop_started`、`loop_first_iteration`、`loop_terminal`、`loop_repeated_7d`（2026-07-20）
- [x] 匿名 telemetry 明示并支持 `WUKONG_TELEMETRY=0`；禁止源码、路径、prompt、transcript、model 和机器指纹（2026-07-20）
- [x] production metrics 区分注册、activated、completed users、terminal reporting rate 和 repeat users（2026-07-20）
- [x] Dashboard 展示 active、stale 和真实 terminal lifecycle，不恢复 Reports 产品面（2026-07-20）

### 测试与发布

- [x] restart/offline/cancel/duplicate-complete/旧 payload contract tests（2026-07-20）
- [x] Node、Python、Rust、Go、无 checks、缺失工具和 Cross-Agent Resume → editable Loop fixture E2E（2026-07-20）
- [x] 全量 test/typecheck/lint/bundle 与本机 darwin-arm64 native smoke（2026-07-20；全量 9214 项通过、10 项资源竞争超时随后按失败文件单 worker 80/80 通过）
- [x] 0.0.14 → 0.0.15 native upgrade pinning contract 与显式 0.0.15 fresh installer E2E（2026-07-20）
- [x] 以真实六平台 assets 验证 0.0.14 → 0.0.15 自动升级与 0.0.15 fresh installer（2026-07-20）
- [x] 三仓 README、用户指南、CHANGELOG、官网、Today 和禁用公告草稿同步（2026-07-20）
- [x] 切换正式 manifest、启用仅面向 0.0.14 的公告并验证 live download / health（2026-07-20）

### 明确不做

- Stripe/Pro 支付、GitHub PR、Team rules、Hosted Report、云端 `/schedule`、新增 Agent 来源、managed credits 和 Role 系统扩张均不进入 0.0.15。

## ✅ 0.0.14 — Cross-Agent Resume + Loop UX

> 方案: [docs/design/0.0.14-resume-loop-polish.md](docs/design/0.0.14-resume-loop-polish.md)。本版继续免费/BYOK，不做支付或 GitHub PR 集成。

### P0：Cross-Agent Resume

- [x] 裸 `/resume` 保持 Wukong-only；删除重复的 `/resume wukong`（2026-07-18，已发布）
- [x] 增加 `/resume codex|claude|cursor` 和隐藏兼容入口（2026-07-18，已发布）
- [x] 实现 Codex、Claude Code、Cursor 本地 session summary discovery（2026-07-18，已发布）
- [x] picker 显示来源标签和原生 ID，并支持当前目录/全部目录和搜索（2026-07-18，已发布）
- [x] 增加 realpath/symlink 边界、损坏 JSONL 隔离和脱敏 fixture（2026-07-18，已发布）
- [x] 增加 `resume-codex`、`resume-claude`、`resume-cursor` 内置只读 Skill（2026-07-18，已发布）
- [x] 增加 `Continue in Wukong` / `Start /loop` 选择面板（2026-07-18，已发布）
- [x] `Start /loop` 预填最后请求并要求用户编辑确认；Loop 进入后重新读取 workspace、Git 和项目检查（2026-07-18，已发布）
- [x] Codex、Claude Code、Cursor 真实本机会话格式 discovery smoke；fixture 覆盖 session → handoff → workspace re-check 指令链（2026-07-18，fixture E2E 已通过；真实模型 turn 未纳入 release gate）
- [x] 增加超大 transcript、Cursor 移动工作目录和格式变化回归（2026-07-18，已发布）

### P0：TUI Gate 与 Footer

- [x] 修正 `Verify ✗ · Proof BLOCKED` 误导语义，收敛为可解释 Gate 状态（2026-07-18，已发布）
- [x] 区分检查未执行、检查失败、无项目检查、高风险复核和 reviewer blocker（2026-07-18，已发布）
- [x] 保持 Footer 窄终端对齐与截断测试（2026-07-18，已发布）
- [ ] 补一次真实 TUI `/loop` 人工 smoke，确认 transcript 仍保留高级诊断细节

### P1：真实项目检查

- [x] Python：只在项目显式配置 pytest、ruff、mypy 时发现对应命令（2026-07-18，已发布）
- [x] Rust：识别 Cargo test 与项目显式 Clippy 配置（2026-07-18，已发布）
- [x] Go：识别 module test 与项目显式 golangci-lint 配置（2026-07-18，已发布）
- [x] 工具缺失、超时和无检查分别返回稳定可解释状态（2026-07-18，已发布）
- [x] Node/Python/Rust/Go 真实临时仓库 E2E（2026-07-18，已发布）

### 兼容与发布

- [x] legacy `verify-pass`、`scan-clean`、`judge-pass` 在 0.0.14 继续兼容，不提前删除
- [x] 建立 0.0.14 设计、ROADMAP、TODO 与 CHANGELOG 口径（2026-07-18）
- [x] 同步中英文 README、用户指南、CLI help 和官网首页/下载/Pricing/Dashboard/Today/Changelog 文案（2026-07-18，公告正式启用与 release assets 同步）
- [x] 完成全量测试、typecheck、lint、bundle build/smoke 与 macOS arm64 native SEA build/smoke（2026-07-18）
- [x] 创建 `v0.0.14` tag、六平台 release assets、公开 CHANGELOG、升级 manifest 和正式公告（2026-07-18）

### 明确不做

- Stripe/Pro 支付、GitHub PR、Team policy、云端 `/schedule`、自动 policy improver 均不进入 0.0.14。

## ✅ 0.0.13 — Review Learning Loop

> 方案: [docs/design/review-learning-loop.md](docs/design/review-learning-loop.md)。本版是 Review Learning Loop 第一阶段：结构化 findings → 人工反馈 → 后续 Loop。自动 policy proposal、固定 eval improver 和支付不在 0.0.13 实现。

### P0：Review Contract

- [x] 统一 reviewer profile 与 runtime 的 JSON 输出格式，移除 `VERDICT` / `VERDICT_JSON` 冲突（2026-07-16）
- [x] 将单 blocker 升级为多 finding `ReviewResult`，包含 severity/category/evidence/nextAction/confidence/validationStatus（2026-07-16）
- [x] 只有 blocking finding 阻止 Loop；important/note 只展示和记录，不制造无限修复（2026-07-16）
- [x] 为旧单 blocker LoopResult 和 0.0.12 Goal record 提供兼容投影（2026-07-16）
- [x] 限制 finding 数量、单项长度和总 payload；invalid output 最多重试一次后返回 ERROR（2026-07-16）

### P0：Project Review Policy

- [x] 加载 `.wukong/review-policy.md`，纳入 config/workspace fingerprint 和 reviewer prompt（2026-07-16）
- [x] policy 缺失时保持 0.0.12 行为；policy 改变时拒绝陈旧 reviewer 结论（2026-07-16）
- [x] Reviewer 保持只读；额外验证只作为 `nextAction` 建议，不动态执行新命令（2026-07-16）

### P0：人工 Feedback

- [x] 实现本地 `~/.wukong/review/feedback.jsonl` schema 和 append-only store（2026-07-16）
- [x] 增加 `wukong review feedback <finding-id> accept|dismiss|fixed|unclear`（2026-07-16）
- [x] TUI 通过 `/review feedback <finding-id> <action>` 提供 accept/false-positive/fixed/unclear 最小入口（2026-07-16）
- [x] 聚合 acceptance、dismiss/false-positive、fixed、review cycles、reviewer errors 和 invalid-output 原始数量（2026-07-16）
- [x] 少于 10 条有反馈 findings 时只显示样本量，不输出质量百分比结论（2026-07-16）
- [x] 默认不上传 finding、diff、policy 或自由文本 feedback reason（2026-07-16）

### P1：模型与统计

- [x] 增加 `--review-model` 和 role 独立 reviewer model，0.0.13 保持 BYOK，不接支付 entitlement（2026-07-16）
- [x] TUI 移除常驻 Today/verify/scan/proof 零值统计，空闲态突出 `/loop`（2026-07-16）
- [x] Web 首页、下载、定价、Dashboard、SEO、邮件和公告统一为 Goal → Write → Check → Review → Fix（2026-07-16；0.0.13 公告发布前保持 disabled）

### 历史商业化迁移说明

支付、真实 Pro entitlement 和 GitHub PR 发布任务当时曾迁移到旧 0.1.0 历史候选。2026-07-25 的新决策将 0.1.0 定义为 Free Trusted Local Loop；付费只可能在 0.2.0 Reliable Autonomy 邀请制 Pilot 中重新批准，PR Gate 也不再是唯一购买理由。

### 0.0.13 发布门槛

- [x] 真实临时 monorepo E2E + finding → feedback → fix → 后续 review 自动化覆盖（2026-07-16）
- [x] Reviewer 无写权限、policy fingerprint、旧结果兼容测试通过（2026-07-16）
- [x] Free 基础反馈/eval 有真实 runtime 行为；生产统计区分 registered users 与 activated Loop users（2026-07-16；feedback 保持 local-only）
- [x] 中英文 README、user guide、CHANGELOG、公告草稿、0.0.13 preview page、Web Pricing/Dashboard 同步，Pro/Team 保持 `Coming Soon`（2026-07-16；公告待 release assets 就绪后启用）
- [x] 支付、GitHub PR 自动评论、团队 policy 同步和云端 improver 保持未完成口径（2026-07-16）

## ✅ 0.0.12 — Loop-first

> 方案: [docs/design/verification-loop-v2.md](docs/design/verification-loop-v2.md)。本版只向普通用户提供一个主产品：Loop。`verify`、`scan`、`proof` 降级为 Loop 内部检查层和高级调试命令，不再各自形成产品、额度或报告流程。

### Loop contract 与额度（Guest/Free quota 为 0.0.12 历史，已在 0.0.17 移除）

- [x] 冻结 Loop 状态机：INSPECT → WORK → CHECK → REVIEW → PASS / NEEDS_WORK / ERROR（2026-07-16）
- [x] 用户结果只保留 PASS→0、NEEDS_WORK→1、ERROR→2；中断→130。历史 auth/quota→3 已随 0.0.17 的远程 Loop 准入移除（2026-07-16；2026-07-22 更新）
- [x] 默认停止条件统一为 `proof-pass`；旧停止条件进入时统一归一化（2026-07-15）
- [x] 只有顶层 Loop session 计额度；内部 verify/scan/proof 不重复计数（2026-07-16）
- [x] Guest：1 个 Loop session、最多2轮；Free：10个 Loop sessions/月、每个最多5轮；第3次开始软提示 Pro，第10次后硬限制（2026-07-16）
- [x] 实现幂等 `/api/v1/loops/start`、`/api/v1/loops/complete` 与 `/api/v1/usages`；不实现 Checks、reservation、lease 或 AI credits（2026-07-16）
- [x] 默认不生成 report/evidence；只有显式本地 `--save`/`--report` 才持久化（2026-07-16）

### Loop 执行与交付 Gate

- [x] 每轮 agent 修改后运行真实项目检查和风险扫描，再交给 fresh-context reviewer 判定（2026-07-15）
- [x] 写代码的 agent 不能自判通过；reviewer 使用独立上下文和只读 profile，且不能覆盖 deterministic blocker（2026-07-15）
- [x] 将失败摘要、具体文件/命令和 next action 注入下一轮，限制 feedback 大小（2026-07-16）
- [x] NEEDS_WORK 才继续修改；ERROR 停止；transient reviewer error 最多原地重试一次（2026-07-16）
- [x] 达到最大轮次返回 NEEDS_WORK/max_iterations，不增加 EXHAUSTED 用户状态（2026-07-16）
- [x] 无测试项目：源代码改动阻断；纯文档改动可进入 reviewer（2026-07-15）
- [x] `wukong loop` 支持 headless 运行及 `--model` writer；reviewer 独立且只读（2026-07-15，`--role` 于 2026-07-21 移除）
- [x] `--every` 继续复用 agent-core scheduler，不新增 timer（2026-07-16，现有实现已满足）

### 内部检查层与兼容

- [x] 统一 workspace/nested project discovery、真实 command 结果和 stable finding schema（2026-07-16）
- [x] `proof-pass` 编排检查、扫描与 reviewer；共享 snapshot，并在输入变化时拒绝陈旧结论（2026-07-16）
- [x] `verify`、`scan`、`proof` 保留为高级/CI/debug 命令（2026-07-15）
- [x] 从 CLI 主帮助、TUI autocomplete/help 隐藏三个高级命令，但旧命令仍可直接执行（2026-07-15）
- [x] 旧 verify-pass/scan-clean/judge-pass 在兼容期映射到 `proof-pass`；CLI 显式旧参数输出弃用提示（2026-07-15）
- [x] 不再把 Reports 或独立 evidence 作为 Loop 默认完成步骤（2026-07-16；Loop 内部 gate 已使用 `writeReport: false`）

### 变身 Role Profiles

- [x] 内置 general/reviewer/planner/strategist/security/tester，通过 TUI `/transform` 切换（实验开关默认关闭；全局 `--role` 于 2026-07-21 移除）
- [x] 用户角色存 `~/.wukong/roles/`；项目角色必须以 `project:<name>` 显式选择，不能覆盖 builtin（2026-07-15）
- [x] role 只定义 prompt、默认 model、允许 tools、verify profile；工具 allowlist 只能收窄基础 profile，未知字段会被拒绝（2026-07-15）
- [x] `wukong roles list/show/init`；0.0.12 不做市场、团队同步或多角色自动编排（2026-07-15）
- [x] 将角色切换收敛到 TUI `/transform`；删除 `loop --role`，内部检查不单独选择角色或模型（2026-07-21）

### 端到端同步与发布门槛

- [x] CLI、TUI、agent tool 使用同一 Loop 三态；Dashboard 只展示 Loop 用量、重置时间和最近最终状态（2026-07-16）
- [x] 旧 Goal record migration 和旧 CLI flags compatibility matrix（2026-07-16）
- [x] 真实 monorepo、无测试项目、snapshot stale、fresh reviewer、角色权限、usage start 幂等、Loop 收敛 E2E（2026-07-16）
- [x] 更新中英文 README、help、公告、CHANGELOG 和 release notes（2026-07-16；公开仓发布时同步生成物）

### 0.0.13+ Backlog

- [x] `--review-model`、role 独立 reviewer model（2026-07-16；保持 BYOK，managed model credits 延后）
- [ ] 全语言自动检查推断、后台/云端 Loop、PR gate 和 Team Role Profiles

## ✅ 0.0.11 — TUI、公告与发布闭环

- [x] TUI welcome/footer/loop/proof 文案与终端宽度对齐，窄终端安全降级（2026-07-13）
- [x] TUI 公告协议、版本/时间/频控过滤、安全链接白名单和非阻塞拉取（2026-07-13）
- [x] 生产验收：公告端点 200 且 5 分钟缓存；0.0.10→0.0.11 更新 manifest（2026-07-13）
- [x] 发布 `0.0.11` 六平台资产并同步 `wukong-code` CHANGELOG、文档和安装 manifest（2026-07-13）

## ✅ Milestone 0.5 — Loop 控制层 + Merge Proof

实施顺序固定：`/proof` → `/judge` → `/goal` verification gate → `/loop`。不引入新执行核：proof/judge 复用 `@wukong/verification`，loop 执行核复用 `/goal`，`--every` 节流由 Goal driver 持有可取消等待。

### 第 1 步: `/proof` Merge Proof Report（Wow Moment）

- [x] `packages/verification/src/proof.ts`: `buildProofResult` + `renderMergeProofReport`（verify+scan 编排与重排版，不新增检测能力）
- [x] `apps/wukong/src/cli/sub/proof.ts` 并在 `commands.ts` 注册（`--json` / `--strict` / `--report`；PASS→0，BLOCKED→1）
- [x] TUI `/proof` slash command 及 dispatch
- [x] recommendation 由风险类型映射生成（不调用模型）
- [x] 测试: 干净项目 PASS、脏项目 BLOCKED 并定位原因、`--strict` 行为、JSON schema（见测试计划 §6 第 1 步）

### 第 2 步: `/judge` evaluator-only 判定

- [x] `apps/wukong/src/cli/sub/judge.ts` + TUI `/judge`（默认 `--assume-broken`，deterministic 模式，复用 proof 引擎）
- [x] 判定矩阵: verify failed→BLOCK；high-risk→BLOCK；medium→PASS with warnings（`--strict` 则 BLOCK）；clean→PASS
- [x] 文档与 help 如实标注 deterministic 判定，不宣传"第二 agent 审查"
- [x] 测试: 判定矩阵、零写操作、零模型调用断言（见测试计划 §6 第 2 步）
- [ ] （后置，P0.5 末 / P1 初）`--agent` 模式: fresh-context 只读 evaluator agent，复用 fork/side-agent 基础设施，BYOK

### 第 3 步: `/goal` verification gate（`/loop` 硬前置）

- [x] `/goal` 增加可选停止条件 `--until verify-pass | scan-clean | judge-pass`
- [x] agent 宣布 completed 且存在停止条件时，自动运行对应评估；未过则拒绝完成并把失败反馈注入下一回合（受回合/预算上限约束）
- [x] `GoalGateResult` 写入 goal 快照（`/loop` 的 history 直接取自该快照）
- [x] 无停止条件的 `/goal` 保持现状（agent 自评）
- [x] 测试: gate 通过才 completed、gate 打回注入反馈、预算上限防死循环（见测试计划 §6 第 3 步）

### 第 4 步: `/loop` 本机迭代 loop（核心）

- [x] `apps/wukong/src/cli/sub/loop.ts` + TUI `/loop`（含 `status/stop`；`pause/resume` 复用 `/goal`）
- [x] 核心语义 iterate-until-verified: 默认紧循环，每轮注入带停止条件的 goal，gate 未过则反馈注入下一轮
- [x] `--every` 可选轮间节流，由 Goal driver 持有可取消等待，不创建或遗留 cron task（支持 `<n>s/m/h/d`，最低 1 分钟）
- [x] 失控防护: `--max-iterations`（默认 10）、单轮超时、`--dry-run`、人可随时 stop
- [x] 达到迭代上限返回 `max-iterations` 状态，不假装成功
- [x] 测试: 见测试计划 §6 第 4 步（含"停止判断不由 agent 自评"与"无第二套 timer"断言）

### 文案同步（P0.5 收尾）

- [x] README / 用户指南补充新命令（只写已实现的）
- [x] 官网 hero 切换 loop control plane / proof-layer 叙事（协同 `wukong_web/TODO.md` P0）（2026-07-09）

## 📋 P1: `wukong today` / `/today`（Local Loop Briefing）

> 方案: [docs/design/today.md](docs/design/today.md) — 今日简报与今日 focus 合并为一条命令；依赖 stats schema，在 proof/loop 稳定后实施。

### 前置：本地 stats 事件流

- [x] 定义 `~/.wukong/stats/events.jsonl` schema（verify / scan / proof / guard / goal / loop 事件）
- [x] 在现有命令出口写入事件（verify、scan、proof、guard、goal 完成、loop 轮次）
- [x] 按自然日聚合与 streak 计算（连续 N 天至少 1 次 clean verify）

### 实现

- [x] `packages/verification` 或独立 `packages/stats`：`buildTodayBriefing()` + `TodayBriefing` 类型
- [x] `~/.wukong/today/focus.json` 读写；`wukong today "..."` 设 focus，`--clear-focus` 清除
- [x] `apps/wukong/src/cli/sub/today.ts` + TUI `/today`（无参=简报，参数=设 focus，`/today clear`）
- [x] 人类可读输出 + `--json`；Next 1–2 条由规则映射（如 BLOCKED proof → 建议 `wukong proof`）
- [x] 测试：离线简报、设/清 focus、JSON schema、不触发 verify 执行

### 不做

- [ ] 不对齐 web legacy `/api/today`（xp/mood/quests）
- [ ] 不把 today 做成任务管理器（执行归 `/goal`）

## 📋 TUI 布局（Loop 驱动）

> 方案: [docs/design/tui-layout-loop-driven.md](docs/design/tui-layout-loop-driven.md) — 底部 chrome 对齐 Claude Code + loop/proof 常驻轨；分 Phase 0→3。

### Phase 0 — 底部 Chrome（Claude Code 骨架）

- [x] `custom-editor.ts`：去 `╭╮╰╯` 边框盒，`❯` prompt + 上下 `─` 分隔线
- [x] 重定义 `paddingX` / `injectPromptSymbol`；bash `! shell mode` 徽标迁至上分隔线 label
- [x] 决策并落实审批/问答/selector 面板样式（建议保留自身边框以示模态）
- [x] `footer.ts`：status 行 2 格缩进；mode 独立最后一行
- [x] 回归：plan/bash 高亮、审批/问答全屏、slash autocomplete

### Phase 1 — 心跳行 + 结论轨（chrome ≤ 7 行硬约束）

- [x] 新建 `loop-phase.ts` 心跳行（`↻ iter/max · phase · 耗时`；blocked `⛔`；`--every` 节流显示）
- [x] 新建 `utils/chrome-state.ts`：goal + verify/proof/gate 聚合；进程内缓存 + 事件驱动刷新（禁止每帧读 stats）
- [x] `footer.ts`：结论轨合并（active：Goal 行 + Verify/Proof 行；idle：Today 摘要行）；`uiMode` idle|active|blocked
- [x] gate 结果每轮落 transcript 一条消息（`✓/✗ iter N gate: …`）
- [x] `wukong-tui.ts`：`updateActivityPane` → `updateLoopPhase`；`activity-pane.ts` 退役
- [x] 测试：chrome-state 单测、footer 三模式快照、心跳行文案、手动 `/goal` `/loop` `/proof` 联调
- [x] review 修复（2026-07-09）：blocked≠verify FAIL；hydrate 取最新；wallClock 去双计；warning→passed；judge 不写 proof stats

### Phase 2 — Today 替换欢迎卡

- [x] idle：today compact 简报；active/blocked：收起大欢迎卡
- [x] `/today` 与启动简报共用渲染器
- [x] MINI_ART 保留为 compact 单行（见 `welcome-art.ts`）

### Phase 3 — Polish

- [ ] `welcomeStyle` 配置：auto | compact | dashboard
- [ ] 像素 mascot 帧按 loop phase 切换（`mascot.ts`）
- [x] Dashboard 模式布局、状态文案、窄终端截断与 footer 列对齐（2026-07-13）

## ⏸ 暂缓（先不做，防止提前开工）

- `/schedule` 云端例程 — 历史 Hosted 假设，当前未排期且不进入 checkbox 队列；本机定时巡检使用已实现的 cron 工具
- [ ] `/ship` 发布 gate — 依赖 proof 先稳定（P1）
- [ ] `wukong review` / `test` / `retro` — P1，构建在 `@wukong/verification` 上
- [x] `wukong sync` / `journey` 不进入当前产品；Web 端未闭环的 sync 与 Companion journey 已删除（2026-07-22）
- [ ] guard shell hook 自动注入 / PATH shim / agent 祖先进程识别 — P1，需幂等与备份测试
- [ ] Verification Skill 不新增 `StopCondition.kind = 'skill'`；按 0.0.20 strict criteria → 0.0.19 deterministic Gate → single fresh reviewer 合同实施

## ✅ 已完成基线（P0）

- [x] `packages/verification` 独立核心包（verify / scan / risks / policy / report）
- [x] `wukong verify` / `wukong scan` / `wukong guard` top-level 命令
- [x] `wukong_verify` builtin agent tool（structured result）
- [x] TUI `/verify`、`/scan`、`/guard`（`/report` 于 2026-07-21 移除）
- [x] `/goal` 单任务驱动（含队列；完成判定为 agent 自评，gate 见上）
- [x] agent-core cron 工具（CronCreate/List/Delete，会话内 recurring/one-shot，`/loop --every` 的复用基础）
- [x] fixtures、unit tests、CLI/TUI/tool smoke tests
- [x] verification 包测试补全: risks/git/scripts/report/status 单测、staged+unstaged 混合 fixture、Windows 命令解析（含 `policy.ts` basename 修复）、guard override/容错、verify strict/timeout/no-commands —— 7→51 tests（2026-07-08）
- [x] 规划文档口径校准: loop 迭代语义、cron 复用、goal gate、judge 分层（2026-07-08）

---

**最后更新**: 2026-07-30（0.0.21 Candidate → Promote → target Final Gate 本地主链已形成未发布实现候选；POSIX Target Apply no-clobber、macOS 四生态无依赖 dirty-loop 4/4、fixed-lock dependencyful Node/Python/Rust 3/3、POSIX component-level hard-signal 38/38 与 dead-owner recovery 已有本地证据；dependencyful Go 因本机不允许把 ambient proxy 注入 bootstrap 而直连官方 proxy 超时，远端门槛仍强制四生态 4/4。Windows Candidate/Target handle-relative backend 与 19 个 forced-termination 等价用例已形成本地候选，三 OS dirty-loop 已移除 Windows skip；单一 exact-SHA full RC 已把 implementation gates 设为六平台 native fresh/upgrade 的硬前置，但真实 runners 尚未运行。CLI package 已应用 changeset 成为 0.0.21，本机 darwin-arm64 0.0.21 fresh install 与公开 0.0.20 → 本地 0.0.21 upgrade 已通过，尚未提交、推送或发布。最新分层全仓回归 10122 passed，typecheck/lint/sherif/build/smoke 通过；fixed-SHA CI、三 OS/六平台、授权真实项目和固定五用户发布门槛尚未完成）
