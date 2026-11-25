# Wukong CLI - TODO

> Internal engineering record — kept in Chinese. English product docs: the user guide and release notes.

> 最后更新：2026-11-25
> 当前已发布基线：`v0.2.0`（Standalone Gate & Proof Foundation，MIT 开源版）
> 方向真相源：[ROADMAP.md](ROADMAP.md)（PLG 全球化 + 路线 A：跨 Agent 独立验收与交付门禁层；小步功能与 fix 走 `0.2.x` 递增，跨仓库生态/结构大更新跳 `0.3.0`）。
> Web 侧任务见 `wukong_web/TODO.md`。本文件记录各版本待办，实施前按既定技术设计核对边界。

## `v0.2.1` — Local CLI Reviewer Adapter & Native Bundle CI Guard（Merged to main, pending manual release）

- [x] **本机 CLI-backed Reviewer Adapter**：在 `@wukong/wukong-sdk` 与 `wukong gate` 中支持调用本机已登录的 `claude` / `codex` / `gemini` CLI 作为独立 Reviewer 后端（`--reviewer auto|provider|claude|codex|gemini`），零 API Key 即可跑 `wukong gate`
- [x] **`wukong init` 与 `wukong provider test` 同步感知**：`init` 自动探测本机可用 CLI Reviewer 并展示免 Key 可用提示；`wukong provider test [claude|codex|gemini|cli:<backend>]` 支持本机 CLI 探活与状态分级
- [x] **PR CI 原生打包与资产前检**：新增 `check:native:preflight` 并接入 `.github/workflows/ci.yml` 的 `build` job，对依赖变更引起的 SEA bundle（`check-bundle.mjs`）或原生资产解析（`assets.mjs`）问题快速失败
- [ ] **按需手动触发 Release**：小版本默认仅提交与推送，不自动发布；是否打 tag 并执行六平台发布由维护者手动决定

## `v0.2.2` — Built-in Local MCP Server（Now）

- [x] **内置本地 MCP Server `wukong mcp`**：复用 `@modelcontextprotocol/sdk` 实现 stdio MCP Server，暴露 `wukong_check`、`wukong_gate`、`wukong_summary` 工具供 Cursor / Claude Code / Codex / Windsurf 直接调用
- [ ] **按需手动触发 Release**：小版本默认仅提交与推送，不自动发布；是否打 tag 并执行六平台发布由维护者手动决定

## `v0.2.3` — Agent Ecosystem Integration（Next）

- [ ] **主流 Agent 原生集成 `wukong integrate`**：支持 `claude`（Stop Hook 未过 Gate 自动退回结构化阻塞原因修复）、`cursor`（MCP + Rules）与 `codex`（规则/钩子）的一键配置、状态校验与清理

## `v0.2.4` — Intent-vs-Diff Cross-Agent Verification（Next）

- [ ] **Intent-vs-Diff 跨 Agent 意图对齐验收**：支持 `wukong gate --from-session [claude|codex|cursor|kimi|grok]` 与 `--issue` / `--pr`，对照真实 `git diff` 与 checks 抓出遗漏需求与伪通过

## `v0.3.0` — CI Gate, Official GitHub Action & Distribution Slimming（Major Milestone）

- [ ] **CI Diff 范围与结构化模式 `wukong gate --ci`**：扩展 `inspectGit` 与 `gate` 支持 `--base` / `--head` diff 范围与标准 CI 退出码
- [ ] **分发瘦身（结构变更）**：将已冻结的 `apps/vis` 与 `dist-web` 移出默认 CLI/SEA/npm 分发包，显著降低二进制体积与构建耗时
- [ ] **官方开源 GitHub Action（`wukong-code/gate-action@v1`）**：5 行 YAML 接入 PR，维护幂等 Proof Card 评论与 Check 状态
- [ ] **公开文档与冷启动发布面收口**：清理公开文档站为英文优先集成指南（Hook / MCP / Intent-vs-Diff / GitHub Action），并配合 `wukong_web` 上线生态着陆页与 `post-build.mjs` `@vercel/og` 路径规范化

## `v0.4.0` — Cloud PR Gate & Team Policy Sync（Later）

- [ ] **Workspace 绑定与规则拉取 `wukong policy pull`**：关联 `wukong login` 团队 Workspace，使本地 Gate 与云端 PR Gate 共用版本化 `.wukong/` 规则与 Verification Skills
- [ ] **确定性检查证明上报 `wukong gate --attest`**：可选将 CI/本地检查摘要签名提交给托管 GitHub App 合成最终 PR 结论
- [ ] **离线解耦保证**：确保无登录、账号失效或云端不可用时，本地 Free BYOK 流程零影响

## `v0.5.0` — Governance, Skills Ecosystem & Scale（Backlog）

- [ ] **Verification Skills 包分享 `wukong skill add <repo>`**：支持社区与团队验收规则包的 digest 校验与版本锁定安装
- [ ] **多托管平台与私有 Runner**：支持 GitLab / Bitbucket PR Gate 与 Self-hosted Runner 协议适配
- [ ] **历史架构债收尾**：在支持窗口与升级样本确认后移除 `@wukong/migration-legacy`；随功能演进渐进拆分 `goal/index.ts`、`wukong-tui.ts` 并清零 `agent-core` boundary baseline

## 已发布基线：`v0.2.0` — Standalone Gate & Proof Foundation（Released 2026-11-24）

- [x] **仓库初始化向导 `wukong init`**：自动探测 Node/pnpm/Python/Rust/Go/monorepo 工具链，生成 `.wukong/checks.json` 与 `.wukong/review-policy.md`，并引导配置与校验 provider
- [x] **Provider 连通测试 `wukong provider test [providerId]`**：显式发起最小探测，区分 `ok` / `auth-failed` / `not-found` / `network` / `timeout` / `offline`；绝不打印密钥、query 凭据或响应体
- [x] **确定性快检入口 `wukong check`**：聚合运行项目检查与风险扫描，明确输出 `reviewer: not_run`，检查通过不冒充完整 Gate PASS
- [x] **独立验收入口 `wukong gate`**：支持脱离 `/loop` 直接对工作树 / `git diff` 执行 `checks + risk scan + fresh-context reviewer`，输出明确 `PASS` / `NEEDS_WORK` / `ERROR`
- [x] **脱敏交付证明卡 `wukong summary` / `wukong gate --summary`**：读取已有运行记录并预览/显式保存 PR-ready Markdown 摘要，如实标注未覆盖项，默认不含源码、diff、transcript、密钥与绝对 home 路径
- [x] **命令面三级 tier 收敛**：CLI `--help` 默认聚焦核心命令（`init` / `check` / `gate` / `summary` / `loop` / `provider` / `doctor` / `upgrade`）并指向 `wukong help --all`；TUI core 从 13 个收敛至 8 个；保留 `verify`/`scan`/`proof`/`judge`/`guard` 兼容别名及行为契约回归
- [x] **Headless 单一确认 run-plan**：`--dry-run --plan-out <file>` 与 `--plan <file> --approve-plan <digest>` 替代 8 个摘要/挑战参数（旧参数兼容保留），补齐无 secret 负向测试
- [x] **统一新手指引**：对齐 `install.sh`、npm postinstall 与 `wukong doctor` 的 `wukong init → wukong check → wukong gate` 下一步提示与回归测试
- [x] **`v0.2.0` 发布验收**：六平台原生二进制、不可变正式发布、文档站与官网生产表面均已发布并通过 `verify-stable-surfaces` 验收

## 已冻结 / 已归档旧项说明

以下历史条目已移出活跃计划（完整记录保留在 Git 历史中）：
- **不再作为发布前置的旧人工债务**：0.0.14–0.1.0 遗留的“固定 5 人用户理解脚本 / 人工 TUI smoke / 人工五来源重跑”已由自动化测试与 CI 矩阵取代。
- **冻结为 bugfix-only**：`apps/wukong-web`（local Web UI）、`apps/vis`（Visualizer）、`today`、`welcomeStyle`、mascot 帧动画、`/ship`、guard PATH shim、`roles` 与 `swarm` 新功能。
- **延后或移除的旧路线**：Preflight 草稿持久化（`v0.2.0` 起以 `.wukong/checks.json` 为主入口）、人工陪跑试点口径（不绑定开源版本发布）、旧 Parallel/Supervisor 方案。
