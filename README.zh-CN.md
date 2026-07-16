# Wukong Code

[文档](docs/README.md) · [路线图](ROADMAP.md) · [English](README.md)

## 什么是 Wukong Code

> **给 Wukong 一个目标，它会循环工作直到改动准备好。**

Wukong Code 是以一个主流程为核心的终端 AI coding agent：**Goal → Write → Check → Review → Fix**。给 `/loop` 一个目标，它会持续修改，直到独立 reviewer 不再返回 blocking finding，或达到迭代上限。

`0.0.13` 正在开发。第一阶段增加结构化多 findings、`.wukong/review-policy.md` 项目规则、本地 finding feedback，以及可选的独立 reviewer model。本版本继续免费并由用户提供模型 API，不做支付；真实 Pro 权益延后到 `0.1.0`。

`0.0.12` 建立了 Loop-first runtime。`verify`、`scan`、`proof` 仍保留为高级诊断命令，但只是 Loop 的内部层，不再各自形成产品或额度。完整 contract 见 [0.0.12 Trust Loop v2](docs/design/verification-loop-v2.md) 和 [0.0.13 Review Learning Loop](docs/design/review-learning-loop.md)。

Loop 只返回一个持久化结果：`PASS`（退出码 `0`）、`NEEDS_WORK`（退出码 `1`）或 `ERROR`（退出码 `2`）。未登录用户有 1 次、最多 2 轮的本地试用；登录后的 Free 用户每月 10 个 Loop session，每次最多 5 轮，内部检查不重复计数。额度服务暂时不可用时，CLI 会警告并按本地 5 轮安全上限继续。旧 `verify-pass`、`scan-clean`、`judge-pass` Goal records 和 flags 仍可读取，并迁移到统一 proof gate；详见 [兼容矩阵](docs/design/0.0.12-compatibility.md)。

Role Profiles 基础能力已经实现并处于实验阶段。在 `~/.wukong/config.toml` 启用 `experimental.role_profiles` 后，可运行 `wukong roles list`，用 `wukong --role security` 启动，或在 TUI 中通过 `/transform security` 与 `/transform off` 切换和恢复。

## 当前命令面

```sh
wukong                         # 启动交互式 TUI
wukong -p "summarize this repo" # 执行一次非交互 prompt
wukong provider                # 管理 LLM provider
wukong acp                     # 以 Agent Client Protocol server 运行
wukong server                  # 启动本地 REST/WebSocket server
wukong web                     # 打开本地 web UI
wukong loop "完成当前改动"      # 迭代直到独立交付 gate 通过
wukong loop "修复测试" --model fast --role tester
wukong loop "修复测试" --review-model reviewer
wukong loop "修复测试" --max-iterations 5 --every 30s
wukong review init             # 创建 .wukong/review-policy.md
wukong review feedback <finding-id> accept
wukong review stats            # 查看本地 feedback 数量
wukong guard                   # 查看或运行 best-effort 命令风险 guard
wukong judge                   # 只审不写的合并判定
wukong login                   # 通过 device-code flow 登录
wukong doctor                  # 校验配置文件
wukong export [sessionId]      # 导出 session ZIP
wukong vis [sessionId]         # 打开 session visualizer
wukong migrate                 # 迁移 legacy wukong-cli 数据
wukong upgrade                 # 升级 Wukong Code
```

高级诊断命令仍可直接用于 CI 和调试：`wukong verify`、`wukong scan`、`wukong proof`。Loop 会自动运行这些内部层，因此它们不再出现在主帮助入口。

待实现命令：`wukong ship`、`wukong schedule`（云端例程）。

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

## 商业化重构

当前产品方向是把 Wukong Code 做成 **AI 写代码时代的 review 驱动控制循环**。实现计划见：

- [产品路线图](ROADMAP.md)
- [商业化与产品重构方案](docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- [技术实现方案](docs/tech/commercial-refactor-implementation.md)

第一批 `0.0.13` 已实现 Loop runtime、独立 reviewer、结构化 findings、项目 review policy、本地 feedback store 和 reviewer-model override。发布前还需要真实仓库 E2E、最终公告与 CHANGELOG 同步，以及生产 activated Loop / feedback 统计验收。

## 致谢

Wukong Code 在以下优秀项目的基础上构建，并从中借鉴了设计与工程经验：

- **[Kimi Code](https://github.com/MoonshotAI/kimi-code)** — Moonshot AI 的终端 AI coding agent。Wukong Code 的 CLI/TUI、agent runtime、provider/ACP/server 栈与会话模型基于 Kimi Code base 构建。感谢 Kimi Code 团队提供的基础与 MIT 许可的参考实现。
- **[Pi](https://github.com/earendil-works/pi)** — Mario Zechner 的 AI agent 工具集。Wukong Code 的交互式 TUI 基于 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi/tree/main/packages/tui)（差分渲染、编辑器、组件、终端 I/O）。感谢 Pi 项目提供 MIT 许可的终端 UI 基础。
- **[Claude Code](https://github.com/anthropics/claude-code)** — Anthropic 的终端 AI coding agent。Wukong Code 在 TUI chrome 布局（输入/状态区）、loop engineering 模式以及互操作能力（如 `/import-from-cc-codex` 导入 instructions、Skills 与 MCP 配置）上参考了 Claude Code。

Wukong Code 是独立产品，专注 **AI Coding Loop 控制与确定性验证**；与 Moonshot AI、Anthropic 及 Pi 项目作者无隶属关系，仅承认上述依赖与参考。

## 许可证

本软件为专有内部软件，详见 [LICENSE](LICENSE)。
