# Wukong CLI - TODO

> Internal engineering record — kept in Chinese. English product docs: the user guide and release notes.

> 定位: 本文件是待讨论任务暂存池与历史进度参考，不是可自动执行的任务列表。方向以 [ROADMAP.md](ROADMAP.md) 为准；只有用户讨论确认、明确纳入具体版本文档的任务才可实施，checkbox、优先级与版本标题不授权开工。不得自行将本文件条目移入版本。`0.1.2`（2026-10-24 发布）是当前 stable 的开源发布版（组织迁移 + MIT 许可，无功能面变化），原 First Success 功能面顺延与 0.1.3 候选一起评审；新增 0.1.3 团队验收试点候选与 0.2.0/0.3.0 都需各自设计与范围批准。现有自动化基线参考 [测试计划](docs/test/verification-cli-test-plan.md)。旧 commercial/PR Gate 文档只作历史研究。
> Web 侧任务见 `wukong_web/TODO.md`。
> 更新规则: 每完成一项勾选并注明日期；口径变更时先改 ROADMAP/设计方案，再同步本文件。

## 本地 CLI 开源方向

本地 CLI 及必要依赖、测试和文档开源（v0.1.2 已按 MIT 发布），官网后端保持私有。
服务与商业化决策在私有运营仓库维护，不在本文件范围；不新增自动执行 checkbox，
也不扩张 0.1.2 已批准范围。

## ✅ 0.1.1 — Reliability And Trust Boundary（已发布）

> 说明：[0.1.1 发布说明](docs/releases/0.1.1.md)。补丁版本继续
> Free、local-first、BYOK；不新增命令、不改变 Loop/Gate 语义，不包含 Cost
> Visibility。`0.1.1` 已通过不可变资产、升级、恢复和 production version
> surfaces 的 exact-SHA 验收。

- [x] 恢复旧 Plan session 时保留真实 plan mode 状态（2026-08-18）
- [x] 支持递归 `**/` glob，并统一本地与 SSH workspace 行为（2026-08-18）
- [x] agent-core boundary guard 对新增和 stale baseline fail closed（2026-08-18）
- [x] 修复 `/loop revise` 被活动 Goal 预检阻断，并保留 Done when、Must not、Verification Criteria 与未显式覆盖的运行上限（2026-08-31）
- [x] 禁止 `/goal --until` 创建旧合同；headless Loop 完整传递 provider-call/token 上限；恢复会话只报告本次 token 增量（2026-08-31）
- [x] Provider catalog/custom registry 改为校验后的单次完整配置替换，避免批量导入半写入、旧 alias 复活或默认模型丢失（2026-08-31）
- [x] 跨 workspace 的外部 Resume 只提供切换目录提示，不把外部 transcript 交给错误项目；修正 Kimi/Grok 来源标签（2026-08-31）
- [x] Web 修正 Auto/YOLO 语义并统一 YOLO 确认；补弹层 Escape、移动端键盘、Workspace 持久化、side-chat 并发和安全失败保留（2026-08-31）
- [x] `dev:stub` 补齐 bearer 鉴权、HTTP 200 envelope、Workspace rename 与可直接打开的 token URL（2026-08-31）
- [x] 相关测试与 typecheck 通过；真实浏览器已验证 token onboarding、YOLO 取消与 stub 首条消息（2026-08-31）
- [x] 修复 vis-web 历史 plan id 的 optional/required 类型不一致，并把 vis-web、vis-server 和 local Web 纳入根测试门禁（2026-09-03）
- [x] 自动更新改为通知与显式 upgrade；默认和配置错误均禁止后台安装（2026-09-03）
- [x] 插件安装增加 HTTPS/final URL、下载与解压上限、digest、初装 disabled 和失败原子回滚（2026-09-03）
- [x] checks discovery 只读取真实 workspace 成员，同时保留 root 与成员检查的选择依据（2026-09-03）
- [x] 删除空 `packages/wukong-migration-legacy` workspace，并同步 `flake.nix`、pnpm lock 与 Nix workspace 检查（2026-09-03）
- [x] Web 请求路径移除 schema DDL；冻结旧 SaaS 表，停止应用层新增宠物/memory/achievement/invite/usage 数据（2026-09-03）
- [x] 重写 Web `CLAUDE.md`，修正公开 Loop 终态文案，并为官网与 local Web 固化浏览器 Golden Journey（2026-09-03；见 `docs/test/0.1.1-browser-golden-journeys.md`）
- [x] 六平台 0.1.1 assets、0.1.0 → 0.1.1 升级与公开安装验收（2026-09-03；publish `33719487397`、promotion `33720931233`、production surfaces `33720991004`）

## 📋 0.1.2 — First Success And Surface Simplification（工程维护进行中；功能未开工）

> 方案、发布级别（`minor`）、兼容策略与完成定义见
> [0.1.2 First Success And Surface Simplification](docs/design/0.1.2-first-success-and-surface-simplification.md)。
> 本节只记录执行进度，不重复定义方案。现状实测见该文档第 1 节（2026-09-09）。

### P0：首次成功路径

- [ ] `install.sh`、npm postinstall、`wukong doctor` 由同一份常量输出 `cd project → wukong → /provider → /loop`，并有三处一致性回归（`install.sh` 已达标，另两处未对齐）
- [ ] 新增 `wukong provider test [providerId]` 与 TUI `/provider` 等价动作，区分 `ok`/`auth-failed`/`not-found`/`network`/`timeout`/offline，不打印 key、endpoint query 或响应体
- [ ] Preflight 用户编辑落盘为 workspace 级草稿，进程重启或修复配置后可继续；草稿不含 secret/evidence，启动成功或显式丢弃即删除，损坏草稿 fail closed
- [ ] `--dry-run --plan-out <file>` 写出无 secret 的可审核 run-plan；`--plan <file> --approve-plan <digest>` 单次确认启动，覆盖现有 8 个 digest/challenge flag 的全集并与其并存一个 minor
- [ ] run-plan 负向测试：不含 provider key、endpoint credential、transcript、raw evidence、home 绝对路径

### P0：命令面收敛（只改默认可见性）

- [ ] TUI core 从 13 个收敛到 8 个：把 `/permission`、`/model`、`/transform`、`/login`、`/logout` 降为 `advanced`
- [ ] CLI 引入与 TUI 对齐的三级 tier；`wukong --help` 只列 `wukong`、`-p`、`provider`、`loop`、`doctor`、`upgrade`、`check`、`web`，并指向 `wukong help --all`
- [ ] `export`、`review`、`roles`、`today`、`guard`、`judge`、`login`、`logout` 降为 advanced（保持可执行、可发现，不加 `hidden: true`）
- [ ] 新增确定性聚合入口 `wukong check`，明确 `reviewer: not_run`，检查通过不输出完整 Gate PASS；`verify`/`scan`/`proof`/`judge`/`guard` 只降级为兼容别名，行为不变
- [ ] 命令契约回归：core 集合精确匹配、advanced/hidden 仍可执行、兼容别名退出码与输出同 0.1.1

### P0：账号与 Web 面（跨仓，见 `wukong_web/TODO.md`）

- [ ] Dashboard 只保留真实 Connected CLI sessions/last used/单设备 revoke；数据未就绪时从主导航隐藏 Dashboard/Plan（隐藏而非删路由）
- [ ] 三个授权脱敏真实案例就绪后再替换动画式 PASS，且至少一个案例展示非 PASS 终态

### P0：工程维护

- [x] 按实际 lockfile 重记网站 `npm audit` 基线（2026-10-25 复验：**23 项 = 2 critical / 14 high / 7 moderate**，替代 2026-10-02 的 15 项与 2026-09-09 的 13 项历史快照；四类处置与 owner/期限已记录于 `wukong_web/TODO.md`，生产项 `next`/`@opennextjs/cloudflare`/`zod` 升级待部署窗口）
- [ ] CI 工程维护完整验收：2026-10-23 本地已将 8 处 checkout 统一到 SHA-pinned v6，使用锁定 TypeScript，加入 PR 并发取消、main 保留和 CI/CD 时限，并统一仓库开发/审查提示词；工作流检查、20 条发布契约测试及类型检查通过。远端 CI、六平台发布与生产面仍待验收，不勾选整项（2026-10-28 更新：远端 CI 已随 PR #20–#30 多次全绿；六平台发布与生产面验收待下一次版本发布时执行）

- [x] 核验已实现的 optional telemetry 接收端生产部署、独立 D1 migration 和每日 90 天清理回执（2026-10-28 生产只读核验：D1 `wukong-telemetry` 仅 `telemetry_installs`/`telemetry_active_days` 两表，只含安装 ID/日期/版本/平台/架构，无事件内容列；2 installs/9 active days、无 >90 天残留、每日 cron 已配置，每日清理回执由 cron 配置与零残留推证）
- [x] CLI 统计只发最小使用信号（2026-10-28：`packages/telemetry` 传输层把每批压缩为单条 `kfc_signal`——安装 ID/版本/平台/架构，事件名、工具、命令、时长、属性、session id 一律不出站；en/zh telemetry 契约文档同步；包内 61 项测试通过）

### 发布门槛（`minor`）

- [ ] 三个授权脱敏真实案例覆盖 install→provider test→Preflight→Loop→Gate，其中一个经 `/resume` 导入、一个以 NEEDS_WORK 或 STOPPED_BY_USER 结束
- [ ] 全量自动化 + typecheck/lint/build/sherif/publint/attw；0.1.1 records 与 session 恢复兼容回归
- [ ] 六平台资产 + checksum + provenance + fresh install + 0.1.1 → 0.1.2 upgrade smoke
- [ ] 中英文发布面同步：CHANGELOG、官网版本面、README、user-guide、docs 侧边栏（2026-10-02 核对：docs nav/sidebar 已含 0.1.1 与 0.1.2 Plan，0.1.2 发布时再加 0.1.2 条目）

## 0.1.3 — Delivery Acceptance Pilot（候选索引，未开工）

具体候选与分阶段范围见
[0.1.3 Delivery Acceptance Pilot](docs/design/0.1.3-delivery-acceptance-pilot.md)。
本节只链接已讨论的路线方向，不新增执行 checkbox；目标版本与技术设计确认后才可开工。

## 📋 0.2.0 — Codebase Reduction（需设计批准）

以下保留为候选；按交付需要分批评审。

- [ ] 分批拆 GoalMode、WukongTUI、useWukongWebClient 和 TUI goal command 的领域职责
- [ ] 每批减少 agent-core boundary baseline，禁止新增或一次性重写 225 个既有豁免
- [ ] Visualizer 退出默认 CLI bundle；Today 与 Web/server、ACP、Plugins/MCP、Swarm、Cron、roles 建立可选扩展边界
- [ ] local Web 若继续维护，从 canonical protocol schema 生成 wire types；否则进入 bugfix-only
- [ ] 支持窗口和真实 upgrade 证据满足后，再移除 `@wukong/migration-legacy`

## 🔒 0.3.0 — Evidence-gated Collaboration Product（未批准）

- [ ] 0.1.3 验收流程稳定后，才另行评审共享 policy、审批/摘要审计与团队权限/预算；最小 PR Gate 是 0.1.3 候选
- [ ] 保持 Free local BYOK Loop 与账号、entitlement 和 Web 故障完全解耦
- [ ] 不优先做 hosted model、云端 Agent、`/schedule`、managed credits、更多 Dashboard 或公开 Checkout

## ✅ 0.0.21 — Loop Evidence Integrity（已发布）

- [x] 同一种 builtin risk 出现在不同文件、行或 evidence 位置时，为每个不同 occurrence 生成稳定 evidence identity；完全相同的重复输入继续去重（2026-07-30）
- [x] reviewer broker 保留全部不同风险 occurrence，并增加回归测试（2026-07-30）
- [x] 删除隔离 worktree / Safe Promote 实现、测试、发布门槛和对外承诺；六平台保持同一功能面（2026-07-30）
- [x] 六平台 native RC、公开 Release、官网 manifest/installer、fresh install 与 0.0.20 → 0.0.21 native upgrade 验收通过（2026-07-30）

## ✅ 0.0.22 — Provider Catalog Resilience（已发布）

- [x] provider catalog 依次尝试维护源和 models.dev；源码包含最终 embedded
  snapshot 路径，但公开 0.0.22 native archive 未嵌入该资产，双远端不可用时
  仍会失败（2026-07-31）
- [x] 澄清 resume/session、workspace permission、Auto/YOLO/Plan、headless 与
  judge 帮助；保留兼容参数（2026-07-31）
- [x] 六平台 Release 的 12 个 ZIP/SHA 资产、官网 manifest/installer 与公开
  版本 surface 同步；macOS ARM64 checksum/binary smoke 通过（2026-07-31）

## ✅ 0.1.0 — Trusted Local Loop（已发布）

> 方案：[docs/design/0.1.0-trusted-local-loop.md](docs/design/0.1.0-trusted-local-loop.md)。
> 本版只交付可控、可恢复、可解释的 Free local-first BYOK 单 Loop。完整多层
> coverage schema、direct-shell content attestation 和价格数据库不再阻塞 0.1.0。

### RC admission P0：用户输入、Preflight 与成本控制

- [x] 将 consolidated Preflight 完成到可编辑状态：Goal、Done when、Must not、checks/no-check、dirty paths、exact provider/model、outbound input、permission、iterations、provider-call ceiling 和可选 token budget；高级字段折叠，危险 Continue 固定最后（2026-08-06）
- [x] 保持 local-read、provider-send、permission、project-check execution distinct approvals；Cancel 不创建 contract/trust/run，也不调用 provider（2026-08-06）
- [x] 把现有 Goal token/turn budget 接入 Loop Preflight、runtime 和 terminal；新增 writer/reviewer provider-call ceiling，真实阻断超限并显示 calls/tokens/retries/remaining（2026-08-06）
- [x] `budget_exhausted` 返回 `NEEDS_WORK` 且允许 same-contract Continue；0.1.1 不展示成本估算，也不建设价格数据库（2026-08-06）

### RC admission P0：no-check 与 Gate 完整性

- [x] 通用 Finish Line warning 不再代替 no-check：只有 versioned discovery/policy 证明无适用 executable checks 时，才能显式确认并写入 Acceptance Contract（2026-08-06）
- [x] source change 缺本应存在 checks 为 `NEEDS_WORK/checks_missing`；tool/permission/runtime 不可用为 `ERROR`；check 已运行失败为 `NEEDS_WORK`；弱化 frozen check 必须 Revised Loop（2026-08-06）
- [x] 在现有 attempt/aggregate/snapshot/terminal 上实现最小 completeness/freshness：绑定 expected/observed checks/no-check、risk scan、fresh reviewer 和 workspace before/after，输出 `complete|partial|inconclusive`（2026-08-06）
- [x] 只有同 attempt `complete` 且 fresh 才能 PASS；partial/inconclusive/stale、budget exhausted、stop、interrupt、corruption、跨 attempt 或 conflicting duplicate 永不 PASS；exact replay 幂等且 terminal 后拒绝 late write（2026-08-06）
- [x] 保持 deterministic failure 不可覆盖、distinct risk occurrence 不丢失、完全相同输入才去重；seeded blocker false PASS 为 0（2026-08-06）

### RC admission P0：结果、文件归因与恢复

- [x] 冻结 `PASS|NEEDS_WORK|ERROR` 与 `PAUSED|STOPPED_BY_USER` 的 reason/continuation/next-action 映射，并让 TUI、headless JSON、Goal panel、footer、`/loop status` 读取同一 durable result（2026-08-06）
- [x] 终态显示 decisive evidence、pre-existing dirty、Wukong touched/added/deleted、checks、calls/tokens/retries/remaining、blocker 和 next；Cancel/Stop 不回滚并明确 Review/Keep/Revert（2026-08-06）
- [x] 写入前记录 workspace/repo baseline；首次触碰路径记录 pre-edit state/digest；外部进程同路径写入时停写并要求重新确认（2026-08-06）
- [x] workspace cleanup 只处理可证明由当前 run 拥有的临时状态；不自动 stash、commit、reset、checkout、push、删除或回滚用户文件（2026-08-06）
- [x] 建立 0.0.22 → 0.1.0 直接升级与 0.0.21 records 兼容矩阵，覆盖 config、provider、session、Goal、contract、criteria、attempt/terminal 和 active run（2026-08-06）
- [x] 历史 terminal PASS 只读保留；无法满足当前不变量的 legacy active attempt 明确结束为非 PASS，再由用户选择 Revised Loop；不静默改写 Goal/check/provider 或扩权（2026-08-06）
- [x] 覆盖 crash/restart、append fault、corrupt/cross-run record、duplicate terminal、concurrent Continue、late write、stop/pause/resume 和 restore-or-revise（2026-08-06）
- [x] provider outcome unknown guard 已有主要实现；补齐 durable replay/恢复矩阵，保持 request ID/idempotency key、可能重复计费警告和无盲目 Resume/Retry（2026-08-06）

### RC admission P0：隐私、Resume、跨平台与发布

- [x] reviewer 继续只读 bounded/redacted attempt-scoped input；源码、raw local evidence、session、日志和 secret 不进入 Wukong Web/D1；`/feedback` 只发送用户预览确认文本（2026-08-06，既有合同全量回归通过）
- [x] `/login` 空模型目录成功且不改变 BYOK default；Codex/Claude/Cursor/Kimi/Grok 导入只生成 editable Goal，不授予 checks/criteria/trust/permission/consent（2026-08-06，既有合同全量回归通过）
- [x] 五来源覆盖隐藏敏感字段、损坏格式、symlink escape、workspace mismatch、外部路径和空结果 fixture（2026-08-06）
- [x] exact Gate command 绑定 cwd/workspace、resolved direct shell 和 approval；0.1.0 不实现完整 shell binary content/PATH/descendant attestation（2026-08-06）
- [x] 统一 Gate runner/Bash timeout、cancel 和 process-tree cleanup，并为 Windows quoting、空格、Unicode、timeout、cancel 和 contract restore 建立 workflow/自动化合同（2026-08-06）
- [x] 用当前候选实际跑完 Windows 和其余五个平台的 CI，不以 workflow 静态测试代替实机结果（2026-08-08；candidate run `31241717713`、public smoke run `31244648831`）
- [x] 六平台 native bundle 的 version、provider、Resume、基本 Loop、stop/recovery、checksum 与 0.0.22 → 0.1.0 状态恢复已进入 workflow/ZIP smoke；本地 macOS ARM64 release-profile ZIP 已通过（2026-08-06）
- [x] 用当前候选实际完成六平台 fresh install、0.0.22 → 0.1.0 upgrade 与旧状态恢复（2026-08-08；公开 RC 六平台 smoke run `31244648831`）
- [x] release workflow 全部 checkout 使用 `persist-credentials: false` 和最小权限；保持 full-SHA Actions、staging ZIP smoke、明确记录 macOS 未做 Developer ID 签名或 Apple 公证、draft byte verification 和 publish-no-rebuild（2026-08-08；按发布决策不要求 GitHub artifact attestation）
- [x] 沿用 `release-provenance.json` 证明 source tag/full SHA、workflow run、六个平台和 asset SHA；从公开 URL 回读 name/size/SHA 并完成 fresh install/upgrade，失败不改变旧安装（2026-08-08；RC 回读 run `31244905074`；stable draft/public 验收 runs `31254055758`、`31254431362`）
- [x] installer、manifest、tag、6 ZIP + 6 SHA + provenance（13 个 assets）、README、docs、Web、Today、Changelog 和 What's Changed 使用同一 release identity；失败路径不替换旧 binary，生产版本面绑定 exact SHAs（2026-08-08；surface run `31254698259`）

### RC 期间验证：真实项目、Provider 与用户理解

- [x] Node、Python、Rust、Go 和 monorepo 的真实工具链 fixture 覆盖 blocker → fix → full rerun → PASS，以及 docs/config no-check、dirty workspace 和 tool missing（2026-08-06）
- [ ] 至少一个 Windows 实际 repo 完成同一 blocker → fix → full rerun → PASS 用户流程（流程见 [manual-verification-runbook](docs/test/manual-verification-runbook.md) A 节；2026-10-28 前提核验：本机为 macOS，无 Windows 实机/VM，待具备后执行）
- [x] provider 覆盖 valid、invalid key、model not found、rate limit、timeout 和 outcome unknown；首次成功可归因 install/provider/Preflight/Loop/Gate/stop（2026-08-06）
- [x] API compatibility、migration/log-security、frontend/design、monorepo package criteria 完成 deterministic trigger/non-trigger、adversarial path、package-root 与重复稳定 eval；本地 Gate/criteria 矩阵连续 3 次 43/43，CI 在 macOS/Linux/Windows 重复同一矩阵（2026-08-07）
- [ ] Codex、Claude Code、Cursor、Kimi Code、Grok 各完成 picker → editable Goal → Preflight → Loop → terminal/recovery smoke（流程见 [manual-verification-runbook](docs/test/manual-verification-runbook.md) B 节；2026-10-28 前提核验：本机有 codex/claude/grok 真实会话，无 cursor 与 kimi-code 会话目录，且 picker 流程需交互式 TUI，待补齐来源与人工执行）
- [ ] 首次用户不读内部文档也能理解 Finish Line、workspace 权限、provider-visible input、Gate verdict、STOPPED_BY_USER、文件归因、budget 和 next action
- [x] targeted/full test、typecheck、lint、build、sherif、package lint 与本地 native installer/ZIP validator 通过（2026-08-06）
- [x] 当前候选在 clean checkout 连续三次保持 check order、terminal 和 reason code，并完成 docs/installer 全量候选验收（2026-08-08；exact-source CI runs `31241684998`、`31245877736`、`31245881849`；公开资产/installer 回读 `31244905074`）

### 发布后真实用户与产品验证（不阻塞 0.1.0 binary）

- [ ] 25 名 opt-in 全部进入分母；20 名无实时指导完成 install/upgrade + provider smoke + executable Preflight；15 名首次真实 PASS；7 名主动完成第二个不同 Goal PASS（2026-08-08 决策：发布后继续收集，不设固定 14 天等待门槛）
- [x] 私有 cohort ledger 只记录最小时间、exit stage/reason、理解、repeat、cost/latency 接受度和反馈引用；不记录源码、路径、Goal、prompt、transcript、evidence 或 credential；仓库外 fail-closed ledger、聚合 gate audit 与 purge 工具已在 `wukong_web` 实现并通过自动化，并已为 `v0.1.0-rc.1` 初始化空 ledger（2026-08-08；没有伪造用户或 Gate 证据）
- [ ] stable 发布满 90 天后实际删除 participant-level cohort 记录，并用 purge audit 验证只保留不含个人数据的发布级汇总
- [ ] 已有 API Key 时 fresh install 到 executable Preflight 中位数 ≤5 分钟、P90 ≤15 分钟；到达 terminal 的用户至少 80% 能解释结果、evidence、保留改动和 next action
- [ ] 发布后持续监测 false PASS、pre-existing state loss、workspace 外写入、静默重复 provider request、privacy/consent violation 和不可恢复状态；严重事件单独发补丁，不重算固定等待窗口
- [ ] 3 个脱敏授权案例只作为正式宣传/launch gate，不阻塞 binary correctness

### 正式 0.1.0 技术发布门槛

- [x] 当前已知 P0 与 release-blocking P1 为 0；RC 六平台构建、公开资产、固定安装、0.0.22 升级、恢复、checksum 与 provenance 已通过（2026-08-08）
- [x] 公开版本、6 ZIP + 6 SHA + provenance（13 个 assets）、installer、manifest、release notes 和 Web 从公开 URL 验收一致（2026-08-08；publish `31254055758`、promotion `31254431362`、production surfaces `31254698259`）

### P1：值得做但不阻塞 rc.1

- [x] 把当前 tool/streaming 推导的 activity hints 升级为 TUI/headless 共用的稳定 WRITE/CHECK/REVIEW phase event（2026-08-07）
- [x] 收口 Goal panel、footer、Preflight 和终态信息密度：目标/Finish Line、phase、checks/review、usage、workspace attribution、blocker 与 Next 分层显示，不做大规模 TUI 重设计（2026-08-07）
- [x] 扩展 Node/Python/Rust/Go/monorepo fixture、五来源 Resume/adversarial/大 transcript 边界和 onboarding 用户流程文案（2026-08-07；真实 Windows repo 与外部用户理解仍按上方 RC 验证项验收）
- [x] 审计并公开现有 optional CLI telemetry 的 fields、endpoint、本地 retention 和 opt-out；补充 model/alias/tool-argument hash 负向过滤与 opt-out queue cleanup；远端 retention 未定义已明确作为 operator policy gap，不用 telemetry 推断 cohort（2026-08-07）
- [ ] 有真实 threat evidence 后再评审完整 direct-shell content/PATH attestation、多层 coverage schema 或公开 evidence interchange

### 明确后移或不做

- 0.1.0 不要求同时新增 `GateCoverageRecordV1`、`FinalFreshnessRecordedV1`、`ProofAggregateRecordedV3`、`LoopEvidenceSnapshotCreatedV3`、`GateAttemptCompletedV2` 的整套替换；只实现最小 completeness/freshness 不变量；
- 不实现完整 `DirectShellBindingV1` content/PATH/descendant attestation，也不新增 provider 价格数据库；
- 不做 isolated worktree、Candidate Gate、Safe Promote、lease/fencing、target Final Gate、Windows FFI；
- 不做并行 Loop、Detach、Supervisor、PR Gate、`/ship`、完整 runtime sandbox；
- 不做 Hosted execution、managed model/credits、payment、quota、entitlement、Team、新 telemetry backend；
- 不做 canonical JSON/SARIF 外部 evidence 导入、Codex Security Workbench、Skill command/marketplace、dynamic workflow graph 或新的默认顶层命令。

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
- [x] macOS/Linux/Windows 覆盖 quoting、Unicode、timeout、cancel、process-tree kill、contract restore（2026-10-28：新增 `packages/agent-core/test/tools/bash-real-process.test.ts`，POSIX 六项在 macOS 本地以真实 LocalKaos 进程全过——含空格/引号/Unicode cwd 往返、Unicode 参数与文件、超时击杀、abort 取消、进程组 tree-kill 心跳停止、超时+取消后合同恢复正常；Windows 断言块随 `test-windows` CI 矩阵执行）
- [x] 同一 fresh fixture 连续至少 3 次保持 check 顺序、终态和 reason code 稳定（2026-10-28：stable 0.1.2 binary + GLM-5.2，npm-test seeded-bug fixture 三轮全新副本，check 顺序均为 [npm run test]、1/1 通过、终态均 NEEDS_WORK、reason 均为 bounded review input insufficient、修复均真实生效；附带发现：checks 全过但未提供独立 Done when 时 reviewer 判定输入不足，fail-closed 行为三轮一致）
- [ ] Kimi Code、Grok 各完成真实本机 picker → handoff → editable contract → Loop → workspace re-check smoke（2026-10-28 前提核验：本机有 `~/.grok/sessions` 但无 `~/.kimi-code`，且需交互式 TUI；待装 Kimi Code 并产生真实会话后执行）
- [x] CLI 与 Web `/api/v1/feedback` 使用共享 versioned contract fixture（2026-10-28：`feedback-contract.v1.json` 双仓同字节；CLI `packages/oauth/test/feedback-contract.test.ts` 与 Web `test/api/feedback-contract.test.ts` 各 5 项契约测试通过）
- [x] 共享隐私负向 fixture 拒绝日志、源码、prompt、路径、session 和附件字段（2026-10-28：33 个禁止字段经 Web zod strict 全部 400 拒绝并断言不落库；CLI 侧断言出站键 ⊆ 契约字段且不含任何禁止字段）

### 发布验收记录与发布后验证债务

- [x] identity/lineage、warning ack、trust、exact approval、inline-secret、provenance、anti-weakening、attempt join、continuation targeted tests 通过（2026-07-25）
- [x] 全仓 test、typecheck、lint、docs build、bundle/native SEA smoke 通过（2026-07-25；9303 tests passed，8 files/48 tests skipped，2 todo）
- [ ] Node/Python/Rust/Go blocker → fix → full rerun → PASS 与 monorepo 检查发现回归通过（2026-10-28 检查发现回归已验：Node `npm run test`、Rust `cargo test`、Python `python3 -m pytest`（pyproject 含 pytest 配置时；无配置时 fail-closed 需显式确认）、pnpm monorepo 根 + `packages/api`/`packages/app` 成员均正确发现且命令前缀正确；损坏 manifest 以 `project_check_discovery_failed` 清晰 fail-closed。Go 本机无工具链待补；各语言完整 blocker → fix → PASS 真实 Loop 仍待执行）
- [ ] script 同名弱化、future `exit 0`、未授权命令零 spawn、evidence join corruption、NEEDS_WORK → continuation → PASS 真实 E2E 通过（2026-10-28 部分完成：goal-gate 新增两项引擎级 E2E——审批快照 CAS 篡改在 createGoal 即拒绝（零执行）、冻结 package-script 检查弱化为 `exit 0` 后同合同 continuation 被 `GOAL_NOT_RESUMABLE` 拒绝且零新增 gate 执行；同名弱化的校验层另由 finish-line 既有测试覆盖，evidence join 由 0.0.21 测试覆盖，NEEDS_WORK → continuation 链由既有 same-contract 测试覆盖；真实 LLM 全链路 E2E 仍待）
- [ ] trust once → expiry、remember → revoke、Headless signed challenge + approval CAS、warning ack edit 后失效、review-policy drift → restore-or-revise 真实 E2E 通过（2026-10-28 核验：trust once/remember/revoke、签名 challenge 绑定、warning-set 绑定、review-policy drift 均已有自动化覆盖（workspace-trust/finish-line 测试），approval CAS 由本轮新增 E2E 覆盖；仅"真实 E2E"（真实模型/进程串联）口径仍待）
- [ ] 固定 5 名目标用户各完成一次脚本且看过后不排除/重试；4/5 正确解释 Finish Line/attempt/terminal，5/5 理解 workspace shell 未被完整 sandbox
- [x] 六平台 assets/SHA、0.0.18 → 0.0.19 upgrade 和 0.0.19 fresh install 通过（2026-07-25）
- [x] 三仓 README/ROADMAP/TODO/CHANGELOG/release notes/installer/manifest 与线上版本一致（2026-07-25）
- [x] Web health、D1/cache、manifest、首页、Changelog、Today 与公开下载页 production 验收通过（2026-07-25；Feedback/Device Login/空 catalog 沿用 0.0.18 已验收实现）

### 明确不做

- Verification Skill 执行/chaining、托管模型/推理、支付、credits/quota、Hosted Terminal/Report、云同步、telemetry 指标后端、`/schedule`、`/ship`、PR Gate、Team、新顶层合同命令、新 workflow DSL、自动 policy/Role/Skill/contract 修改和 feedback 附件均不进入 0.0.19。

## ⏳ 0.0.20 — Reusable Verification Criteria

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

- [x] 每个 reference recipe 至少 5 个 should-trigger、10 个 should-not-trigger；3 个 fresh process 的 deterministic suggestion/order/digest 完全一致（2026-10-28：既有 5/10 触发覆盖之上，新增 3 个独立 tsx 子进程计算 digest/suggestion 顺序完全一致且与进程内计算一致）
- [ ] with/without 配对中 seeded blocker false PASS 为 0，blocking finding provenance/evidence/next-action 完整率 100%，任务完成率不下降（2026-10-28 部分完成：deterministic 零 false-PASS 与 finding 完整性已由 `packages/verification/test/criteria-adversarial.test.ts` 12 项覆盖——未解决 blocker 的 PASS、无证据 resolution、无证据/无 next-action/陈旧 provenance 的 blocking finding、伪造 subjectRef、跨 input 重放全部拒绝；with/without 真实 reviewer 配对与任务完成率对比仍需真实模型/用户，保留开放）
- [x] adversarial input 覆盖恶意 SKILL.md、criterion、workspace source、stdout/stderr 和 Gate evidence；不能提权、读 secret 或覆盖 blocker（2026-10-28：`criteria-adversarial.test.ts` 覆盖夹带执行字段、ANSI/NUL 注入 criterion 文本、sidecar 路径逃逸、符号链接与超大 SKILL.md；伪造 evidence 指向与跨 digest 重放被拒——reviewer stdout 声明不是证据，只有 broker 签发的 subject ref 可作为 evidence；workspace source 越界另由既有 symlink/writable 校验测试覆盖）
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

## 🧭 已取代：原 0.2.0 Reliable Autonomy 候选（历史记录）

> 2026-10-23：0.2.0 是按交付阻碍分批评审的 Codebase Reduction；0.1.3 是服务与
> 最小 PR Gate 试点候选，0.3.0 是试点证据后的产品化评审。本节只保留原候选记录：隔离
> worktree / Safe Promote 实验已经取消；依赖 Promote/lease/fencing 的旧 0.2.0
> 文档只作历史研究，不能直接进入 checkbox 队列或对外承诺。

### 原 0.2.0 — Reliable Autonomy 候选（已取代）

- 当前没有已批准技术方案、收费 SKU、价格或公开 Checkout 计划。
- 旧 Bounded Parallel Loop、Local Loop Supervisor 和 Pro 文档依赖已取消的 Promote/lease/fencing 架构，等待 0.1.0 后重新研究。
- 只有真实用户出现重复多任务监督需求，才评审并行、Supervisor、PR Gate 或商业化。
- Free 合同继续包括单前台 Loop、BYOK、Resume、Finish Line 和现有 Gate；不对用户自己的 API Key、Loop 次数或 token 设置 Wukong quota。

### 已取消的历史实验

- [0.0.21 Isolated Loop Worktrees](docs/design/0.0.21-isolated-loop-worktrees.md)
  只作研究记录，不属于 0.0.21、0.1.0 或 0.2.0 的实现承诺。

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
- [x] `/logout` 先尽力撤销远端 refresh token，再清理本地 Wukong token/provider/default alias；远端 unknown 必须明确提示，且不删除其他 BYOK provider（2026-08-06）
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

历史方案曾假设把 PR Gate 作为唯一收费点；其用户门槛、工程阶段与价格只保留在归档文档中。这里不保留未完成 checkbox，避免自动任务扫描把它们当成当前 P0。

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
- [ ] 补一次真实 TUI `/loop` 人工 smoke，确认 transcript 仍保留高级诊断细节（流程见 [manual-verification-runbook](docs/test/manual-verification-runbook.md) C 节；2026-10-28：需交互式 TUI 人工执行——同日三轮真实 headless Loop 已验证终态/检查/证据面，transcript 细节保留检查仍待人工）

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

支付、真实 Pro entitlement 和 GitHub PR 发布任务当时曾迁移到旧 0.1.0 历史候选。2026-07-25 的新决策将 0.1.0 定义为 Free Trusted Local Loop，相关商业化假设不再构成版本承诺。

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

**最后更新**: 2026-10-24（路线收敛为技术路线，商业化决策移至私有运营仓库；明确 check 与完整 Gate 的区别，刷新历史基线与候选索引；TODO 不构成执行授权，stable 仍为 `0.1.1`，0.1.2 原已批准范围保留）。此前：2026-10-23、2026-10-02、2026-08-08；stable `0.1.0` 已发布，真实 Windows repo、五来源真实 Resume、首次用户与 cohort 继续作为发布后验证，不设固定 14 天发布门槛。
