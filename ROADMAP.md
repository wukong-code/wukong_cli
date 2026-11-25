# Wukong Code Roadmap

> Internal engineering record — kept in Chinese. English product docs: the user guide and release notes.

> 最后更新：2026-11-25（按小步 `0.2.x` 递增 + 阶段大更新跳 `0.3.0` 重整规划；`v0.2.1` 启动开发）
> 当前已发布基线：`v0.2.0`（Standalone Gate & Proof Foundation；MIT；Free + local-first + BYOK）
> 范围：`wukong_cli` 开源本地 CLI 与核心引擎、`wukong-code` 公开分发与文档/Action；官网账号与托管 PR Gate 后端由私有 `wukong_web` 仓库维护。
> 授权边界：本文件确定产品方向与版本规划；具体条目进入代码实施前须确认技术设计与变更范围。

## 产品定位与方向

- **英文对外定位**：
  > **Any AI writes the code. Wukong proves it's ready to merge.**
  > *An agent-agnostic verification & delivery gate for Claude Code, Cursor, Codex, and CI.*
- **中文核心定位**：
  > 任何 AI 写代码，Wukong 独立验收并出具合并证明。

Wukong Code 不与 Claude Code、Cursor、Codex 争夺“写代码主入口”，而是把主流 Coding Agent 作为上游，专注做好 **AI Coding 的独立验收与交付门禁层**：

```text
任意 Coding Agent / 本地修改
  → 确定性检查（防作弊 / 防弱化）
  → 跨 Agent 意图对齐（Intent-vs-Diff）
  → Fresh-Context 独立审查
  → Delivery Proof Card / PR Gate（PASS / NEEDS_WORK / ERROR）
```

现有的 `/loop`（验收未过时自动写、查、审、修直到通过）与 `/resume`（Codex / Claude Code / Cursor / Kimi Code / Grok 会话只读导入）作为本地闭环与入口能力继续保留，并与独立验收主线打通。

## 开源与私有边界

| 仓库 | 许可与可见性 | 核心职责 |
|---|---|---|
| `wukong_cli` | MIT 开源 | 本地 CLI/TUI、独立验证引擎（`init` / `check` / `gate` / `summary` / `integrate` / `mcp` / `loop` / `resume` / `provider`）、BYOK 与本机 CLI 适配器；无账号、无网络或无官网后端时仍可完整运行 |
| `wukong-code` | 公开 | 六平台原生发行资产、SHA-256 与 provenance、英文公开文档，以及官方开源 GitHub Action 分发 |
| `wukong_web` | 私有 | 官网、可选账号登录与文本反馈，以及规划中的 Wukong Cloud PR Gate（GitHub App + 团队控制台）；商业定价与经营策略仅在私有仓库维护 |

## 核心不变量

1. **确定性检查先于 AI 审查，且不可被覆盖**：真实项目 checks、防删测试与风险扫描先于模型审查；LLM Reviewer 绝不能把确定性失败、检查脚本篡改或缺失检查改判为 `PASS`。
2. **独立裁判上下文**：Writer 与 Reviewer 保持上下文隔离；未运行检查、证据过期、部分执行或 Reviewer 未成功运行，均不得宣称完整 Gate `PASS`。
3. **如实披露与默认脱敏**：Delivery Proof Card 与 Gate 输出必须明确列出已验证项与未覆盖项；默认不包含源码、diff、prompt、transcript、密钥或绝对 home 路径，缺失信任配置时 fail closed。
4. **本地免费路径独立完整**：开源 CLI 永久免费、BYOK、无账号/配额锁；任何云端或账号后端故障不得阻断本地 `check`、`gate` 或 `loop`。

## 版本规划序列（v0.2.0 起）

### `v0.2.0` — Standalone Gate & Proof Foundation（预计级别：`minor`）

目标：把 Wukong 从“重型 Loop Agent”收敛成“任何项目 30 秒接入的独立验收与 PR 证明工具”。

- **`wukong init`**：自动识别 Node/pnpm/Python/Rust/Go/monorepo 工具链，生成 `.wukong/checks.json` 与 `.wukong/review-policy.md`，并引导配置与测试 provider。
- **`wukong provider test [providerId]`**：显式连通测试，精确区分 `ok` / `auth-failed` / `not-found` / `network` / `timeout` / `offline`，不输出任何密钥或敏感 URL。
- **`wukong check`**：纯确定性快检聚合命令（项目 checks + 风险扫描，明确标出 `reviewer: not_run`，零模型费用、可离线秒跑）。
- **`wukong gate`**：脱离 `/loop` 独立运行的完整验收命令，针对当前工作树 / `git diff` 执行 `deterministic checks + risk scan + fresh-context reviewer`，输出 `PASS / NEEDS_WORK / ERROR`。
- **`wukong summary` / `wukong gate --summary`**：读取已有运行记录，生成已脱敏、可直接贴入 PR 描述的 Markdown **Delivery Proof Card**（目标、commit SHA 与 dirty 状态、checks 明细、blocking findings、明确未覆盖项与下一步）。
- **命令面与自动化收敛**：
  - CLI 引入三级 tier（`wukong --help` 默认聚焦 `init` / `check` / `gate` / `summary` / `loop` / `provider` / `doctor` / `upgrade`，TUI core 13→8；`verify` / `scan` / `proof` / `judge` / `guard` 保留兼容别名，行为不变）。
  - Headless 单一确认 run-plan：`--dry-run --plan-out <file>` + `--plan <file> --approve-plan <digest>` 覆盖原有 8 个挑战/摘要参数（旧参数保持兼容过渡）。
  - 统一 `install.sh`、npm postinstall 与 `wukong doctor` 的下一步引导。

### `v0.2.1` — Local CLI Reviewer Adapter & Native Bundle CI Guard（预计级别：`patch`）

目标：降低 `wukong gate` 的 BYOK 冷启动门槛，并把原生 SEA 打包验证前移到 PR CI。

- **本机 CLI-backed Reviewer Adapter**：在 `@wukong/wukong-sdk` 与 `wukong gate` 中支持调用本机已登录的 `claude` / `codex` / `gemini` CLI 作为独立 Reviewer 后端（`--reviewer auto|provider|claude|codex|gemini`），零 API Key 即可运行 `wukong gate`。
- **`wukong init` 与 `wukong provider test` 同步感知**：`init` 自动探测本机可用 CLI Reviewer 并展示免 Key 可用提示；`wukong provider test [claude|codex|gemini|cli:<backend>]` 支持本机 CLI 探活与状态分级。
- **PR CI 原生打包与资产前检**：新增 `check:native:preflight` 并接入 `.github/workflows/ci.yml` 的 `build` job，对依赖升级导致的 SEA bundle 或原生资产解析问题快速失败。

### `v0.2.2` — Built-in Local MCP Server（预计级别：`patch`）

- **`wukong mcp`**：内置本地 stdio MCP Server，暴露 `wukong_check`、`wukong_gate`、`wukong_summary` 工具供 Cursor / Claude Code / Codex / Windsurf 直接调用。

### `v0.2.3` — Agent Ecosystem Integration（预计级别：`patch`）

- **`wukong integrate`**：支持 `claude`（安装 Stop Hook，在未过 Gate 时将结构化阻塞原因退回自动修复）、`cursor` 与 `codex` 规则/钩子一键接入与清理。

### `v0.2.4` — Intent-vs-Diff Cross-Agent Verification（预计级别：`patch`）

- **Intent-vs-Diff 跨 Agent 意图对齐验收**：`wukong gate --from-session [claude|codex|cursor|kimi|grok]` 与 `--issue` / `--pr`，复用五来源本地会话解析能力提取用户需求与约束，核对真实 `git diff` 与 checks，抓出遗漏需求与伪通过。

### `v0.3.0` — CI Gate, Official GitHub Action & Distribution Slimming（预计级别：`minor` 大版本跳跃）

目标：完成 GitHub PR 原生 CI 闭环、发布面瘦身与全球化开发者文档升级。

- **`wukong gate --ci` 与官方开源 GitHub Action（`wukong-code/gate-action@v1`）**：扩展 PR `base..head` diff 范围与标准退出码，提供 5 行 YAML 接入与幂等 PR Proof Card 评论。
- **分发瘦身（结构变更）**：将已冻结的 `apps/vis` 与 `dist-web` 移出默认 CLI/CI 分发包；精简公开文档站为英文优先的路线 A 集成指南，并配合官网更新生态着陆页。

### `v0.4.0` — Cloud PR Gate & Team Policy Sync（预计级别：`minor`）

目标：配合 `wukong_web` 上线云端 GitHub App 与团队控制台，打通本地规则与 PR 门禁一致性。

- **Workspace 绑定与规则同步**：`wukong login` 绑定团队 Workspace，新增 `wukong policy pull`，使本地 `wukong gate` 与云端 PR Gate 共享版本化的 `.wukong/` 策略与 Verification Skills。
- **确定性检查证明上报（`wukong gate --attest`）**：可选将 CI/本地确定性检查结果摘要签名提交给托管 GitHub App，与云端独立审查合成为完整 Gate 结论。
- 本地 Free BYOK 路径与云端策略同步、账号、权限状态完全解耦。

### `v0.5.0` — Governance, Skills Ecosystem & Scale（预计级别：`minor` 或按移除范围评审 `major`）

目标：扩展多代码托管平台与可分享的验收规则生态，并清理历史兼容性包袱。

- **Verification Skills 包管理**：`wukong skill add <repo>` 支持安全拉取与安装版本化/digest 锁定的社区与团队验收规则包。
- **多平台与私有化执行支持**：GitLab / Bitbucket PR Gate 与 Self-hosted Runner 适配。
- **结构债收尾**：在确认兼容支持窗口结束后移除 `@wukong/migration-legacy`；随业务改动渐进拆分大型模块并缩减 `agent-core` boundary baseline。

## 轻量发布分级

延续完整性底线（immutable assets、SHA-256、provenance、publish-no-rebuild、失败不替换旧安装），遵循“小步增量 / fix 走 `0.2.x` 递增，大更新跳 `0.3.0`”的节奏：

- **默认提交与推送优先、Release 必须手动触发**：小版本（`0.2.x`）默认仅提交与推送代码，不自动触发 Release；所有正式 Release（打 tag、六平台构建分发与官网更新）均由维护者按需手动决定与触发。

| 级别 | 适用范围 | 必跑验收 |
|---|---|---|
| `patch`（`0.2.x`） | 缺陷修复、文案/提示修复、安全/依赖维护，或单个聚焦的独立增量模块（穿插紧急 fix 直接递增补丁号，后续功能顺延） | 全量自动化 + typecheck/lint/sherif + 六平台资产校验与安装/升级 smoke；含增量能力时补齐命令与契约回归 |
| `minor`（`0.3.0` / `0.4.0`） | 阶段性大更新：涉及默认分发包结构调整、跨仓库生态发布（CLI + Action + 英文文档/官网大升级）或新体系成型时跳跃次版本号 | `patch` 全部 + 新命令/契约回归 + 恢复兼容回归 + 中英文发布面同步 |
| `major` | 破坏性参数/别名移除或不可逆 schema 变更（需明确确认） | `minor` 全部 + 迁移路径与回退验收 |

## 明确冻结与不做

- **冻结为 bugfix-only**：`apps/wukong-web`（local Web UI）、`apps/vis`（Visualizer）、`today`、`roles`、`swarm` 仅做必要可靠性修复，不再投入新功能迭代。
- **不做项**：云端托管写代码 Agent、`/schedule` 云端定时例程、模型代理转售、以“纯重构”阻塞业务发布的空转版本、百 Agent 蜂群与复杂桌面多任务看板。

## 已发布基线简表（`v0.0.1` – `v0.2.0`）

| 版本区间 | 主题与核心沉淀 |
|---|---|
| `0.0.1` – `0.0.11` | 交互式 TUI、`-p`、BYOK Provider 管理、`verify` / `scan` / `guard` / `proof` / `judge` / `goal` / `loop`、六平台原生二进制与升级链路 |
| `0.0.12` – `0.0.18` | Loop-first 状态机、结构化多 finding review、`.wukong/review-policy.md`、Codex/Claude/Cursor/Kimi/Grok 跨 Agent Resume、文本 `/feedback` 与无配额本地 Loop |
| `0.0.19` – `0.0.22` | Acceptance Contract 冻结合同、Evidence Broker 与严格 Verification Skills、Evidence Identity 修复、Provider Catalog 韧性 |
| `0.1.0` – `0.1.2` | Trusted Local Loop（可编辑 Preflight、调用/token 上限、no-check、文件归因、跨平台可靠性）、MIT 开源切换与发布 provenance |
| `0.2.0`（当前稳定版） | Standalone Gate & Proof Foundation（2026-11-24）：`init` / `provider test` / `check` / `gate` / `summary`、三级命令面收敛与单确认 run-plan |

> `v0.2.0` 之前的完整历史设计与归档研究保留在 Git 历史及 [设计归档索引](docs/design/design.md) 中。
