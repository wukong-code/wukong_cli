# Wukong Code

[文档](docs/README.md) · [路线图](ROADMAP.md) · [English](README.md)

## 什么是 Wukong Code

> **给 Wukong 一个目标，它会循环工作直到改动准备好。**

Wukong Code 是以一个主流程为核心的终端 AI coding agent：**Goal → Write → Check → Review → Fix**。给 `/loop` 一个目标，它会持续修改，直到独立 reviewer 不再返回 blocking finding，或达到迭代上限。

`0.0.13` 增加结构化多 findings、`.wukong/review-policy.md` 项目规则、本地 finding feedback 与诊断统计，以及可选的独立 reviewer model。当前产品继续 Free + BYOK，没有付费计划或 entitlement。

`0.0.14` 增加跨 Agent Resume、明确的 Resume → Loop 衔接、更清晰的 TUI Gate 结论和更多真实项目检查发现。本版本继续免费/BYOK，完整范围见 [0.0.14 设计](docs/design/0.0.14-resume-loop-polish.md)。

`0.0.15` 把这条 Loop 做成可恢复闭环：持久化 run record、completion outbox、重启后的 active Loop 恢复、额度预留前 preflight、精简首次入口，以及 Dashboard 真实生命周期状态。本版本继续免费/BYOK，现已作为六平台公开版本发布；完整范围见 [0.0.15 设计](docs/design/0.0.15-loop-reliability.md)。

`0.0.16` 为每个 Loop 冻结用户目标和显式完成标准，在复审中保留上轮 blocker，识别重复无进展循环，相同 blocker 持续时启动一次只读 strategist，并在显式 reviewer model 不可用时安全回退。本版也重构 Permission Mode：Auto 成为不提问但受 workspace/risk/capability 约束的自主模式，YOLO 明确为危险 approval bypass，且不能为 reviewer/strategist 等只读分身扩权。版本同时包含有界 Resume 建议、Role 任务契约、紧凑任务状态和本地 session 内容搜索，不增加支付或 managed model credits。完整范围见 [0.0.16 设计](docs/design/0.0.16-loop-convergence.md)。

`0.0.17` 是下一个计划补丁版：删除误导的 Role/Report 别名，保留可发现的 `/transform list|status|off`，阻止未知或已禁用 slash command 进入模型，并严格校验 permission、Loop、export、Today 与 roles 参数；同时把 `/resume` 设为主命令、`/login` 收敛为可选账号连接、模型 Key 统一交给 `/provider`，并把本地 Loop record 迁移到无 quota/outbox 的 lifecycle v2。版本继续免费/BYOK；发布门槛通过前，公开 package 和下载版本仍保持 `0.0.16`。完整范围见 [0.0.17 设计](docs/design/0.0.17-command-surface-reliability.md)。

旧 `0.1.0` 文档曾探索 Pro PR Gate 商业实验，但它不是当前承诺：目前没有付费计划、Checkout 或 entitlement 实施。任何商业化范围都需要在真实 Free 用户验证后重新决策。

`0.0.12` 建立了 Loop-first runtime。`verify`、`scan`、`proof` 仍保留为高级诊断命令，但只是 Loop 的内部层，不再各自形成产品或额度。完整 contract 见 [0.0.12 Trust Loop v2](docs/design/verification-loop-v2.md) 和 [0.0.13 Review Learning Loop](docs/design/review-learning-loop.md)。

Loop 只返回一个持久化结果：`PASS`（退出码 `0`）、`NEEDS_WORK`（退出码 `1`）或 `ERROR`（退出码 `2`）。所有用户都可以在本地直接运行 BYOK Loop，不要求登录，不设置 Guest 试用或月度次数，也不请求 Wukong quota 服务。默认单次最多 10 轮，可用 `--max-iterations` 调整；reviewer step/time 上限和 `/loop stop` 继续作为失控保护。匿名产品指标仍遵守 `WUKONG_TELEMETRY=0`，且不参与 Loop 准入。旧 `verify-pass`、`scan-clean`、`judge-pass` Goal records 和 flags 仍可读取，并迁移到统一 proof gate；详见 [兼容矩阵](docs/design/0.0.12-compatibility.md)。

Role Profiles 基础能力已经实现并处于实验阶段。在 `~/.wukong/config.toml` 启用 `experimental.role_profiles` 后，可用 `wukong roles list/show/init` 管理角色，并在 TUI 中通过 `/transform list|status|off` 或 `/transform <role>` 查看、切换和恢复。

TUI 内的 `/resume` 用于恢复 Wukong 会话；需要继续其他 Agent 的本地会话时，使用 `/resume codex`、`/resume claude` 或 `/resume cursor`。外部历史只作为只读上下文导入 Wukong，不重放旧工具调用，并在继续前重新检查当前 workspace。

安装器和 CLI 的匿名产品指标只记录安装、首次运行、Device Login 结果和 Loop 生命周期，不包含源码、prompt、transcript、仓库名或文件路径。设置 `WUKONG_TELEMETRY=0` 即可关闭，且不会影响本地 Loop。

## 当前命令面

```sh
wukong                         # 启动交互式 TUI
wukong -p "summarize this repo" # 执行一次非交互 prompt
wukong provider                # 配置 BYOK 模型 provider 与 API Key
wukong acp                     # 以 Agent Client Protocol server 运行
wukong server                  # 启动本地 REST/WebSocket server
wukong web                     # 打开本地 web UI
wukong loop "完成当前改动"      # 迭代直到独立交付 gate 通过
wukong loop "修复测试" --model fast --review-model slow
wukong loop "修复测试" --review-model reviewer
wukong loop "修复测试" --max-iterations 5 --every 1m
wukong review init             # 创建 .wukong/review-policy.md
wukong review feedback <finding-id> accept
wukong review stats            # 查看本地 feedback 数量
wukong guard                   # 查看或运行 best-effort 命令风险 guard
wukong judge                   # 只审不写的合并判定
wukong login                   # 连接可选 Wukong 账号，不配置模型
wukong doctor                  # 校验配置文件
wukong export [sessionId]      # 导出 session ZIP
wukong vis [sessionId]         # 打开 session visualizer
wukong migrate                 # 迁移 legacy wukong-cli 数据
wukong upgrade                 # 升级 Wukong Code
```

高级诊断命令仍可直接用于 CI 和调试：`wukong verify`、`wukong scan`、`wukong proof`。Loop 会自动运行这些内部层，因此它们不再出现在主帮助入口。

历史候选但尚未实现、也不是当前承诺的命令：`wukong account`、`wukong pr gate`、`wukong ship`、`wukong schedule`。

完整参数以 `wukong --help` 为准。

## 从源码运行

这是内部实现仓库（`mutnpc/wukong_cli`）。公开下载与安装请访问 [wukong.today](https://wukong.today)。开发时使用 workspace 脚本：

```sh
git clone https://github.com/mutnpc/wukong_cli.git
cd wukong_cli
pnpm install
pnpm dev:cli
```

只运行 CLI entrypoint：

```sh
pnpm -C apps/wukong run dev:cli-only --help
```

当前发布包名为 `@wukong.today/code`；不要继续使用旧的 `@wukong.today/wukong-cli` 名称。

## 本地开发

monorepo 环境要求：

- Node.js `>=24.15.0`
- pnpm `10.33.0`

常用命令：

```sh
pnpm dev:cli    # 以开发模式运行 CLI
pnpm typecheck  # TypeScript 检查
pnpm test       # 运行测试
pnpm lint       # oxlint
pnpm build      # 构建所有包
```

完整内部贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
更新检查、后台自动安装、TUI 公告和当前上线状态见 [CLI 更新与公告契约](docs/operations/updates-and-announcements.md)。

## 历史产品候选

以下文档记录旧产品假设，不覆盖当前 Free + BYOK 边界：

- [产品路线图](ROADMAP.md)
- [商业化与产品重构方案](docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- [技术实现方案](docs/tech/commercial-refactor-implementation.md)

`0.0.13` 发布第一版 Review Learning Loop：结构化 findings、项目 review policy、本地 feedback、reviewer 诊断统计和 reviewer-model override。真实仓库 E2E、发布文案、Web 预览公告，以及区分注册用户与 activated Loop users 的生产统计已经同步。

## 致谢

Wukong Code 在以下优秀项目的基础上构建，并从中借鉴了设计与工程经验：

- **[Kimi Code](https://github.com/MoonshotAI/kimi-code)** — Moonshot AI 的终端 AI coding agent。Wukong Code 的 CLI/TUI、agent runtime、provider/ACP/server 栈与会话模型基于 Kimi Code base 构建。感谢 Kimi Code 团队提供的基础与 MIT 许可的参考实现。
- **[Pi](https://github.com/earendil-works/pi)** — Mario Zechner 的 AI agent 工具集。Wukong Code 的交互式 TUI 基于 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi/tree/main/packages/tui)（差分渲染、编辑器、组件、终端 I/O）。感谢 Pi 项目提供 MIT 许可的终端 UI 基础。
- **[Claude Code](https://github.com/anthropics/claude-code)** — Anthropic 的终端 AI coding agent。Wukong Code 在 TUI chrome 布局（输入/状态区）、loop engineering 模式以及互操作能力（如 `/import-from-cc-codex` 导入 instructions、Skills 与 MCP 配置）上参考了 Claude Code。

Wukong Code 是独立产品，专注 **AI Coding Loop 控制与确定性验证**；与 Moonshot AI、Anthropic 及 Pi 项目作者无隶属关系，仅承认上述依赖与参考。

## 许可证

本软件为专有内部软件，详见 [LICENSE](LICENSE)。
