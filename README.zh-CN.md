# Wukong Code

[文档](docs/README.md) · [路线图](ROADMAP.md) · [English](README.md)

## 什么是 Wukong Code

> **AI 负责写代码，Wukong 负责判断能不能合并。**

Wukong Code 是本地优先的终端 AI coding agent，定位是 **AI Coding Loop 的控制层与验证层**。它不和 Cursor / Claude Code / Codex 拼写代码，而是补上它们留下的问题：*这段 AI 写的代码能不能合并？*

当前 P0 本地闭环和 Hosted Reports MVP 已实现：`verify`、`scan`、`proof` 可上传脱敏报告，Dashboard 展示真实 history，公开分享需要显式 `--upload --public`。完整订阅生命周期、GitHub PR Evidence、团队规则和 deep review 仍是后续工作。

## 当前命令面

```sh
wukong                         # 启动交互式 TUI
wukong -p "summarize this repo" # 执行一次非交互 prompt
wukong provider                # 管理 LLM provider
wukong acp                     # 以 Agent Client Protocol server 运行
wukong server                  # 启动本地 REST/WebSocket server
wukong web                     # 打开本地 web UI
wukong verify                  # 运行确定性检查并生成证据报告
wukong scan                    # 扫描 git 改动中的交付风险
wukong guard                   # 查看或运行 best-effort 命令风险 guard
wukong proof                   # 生成 Merge Proof Report（verify + scan）
wukong judge                   # 只审不写的合并判定
wukong loop                    # 启动带验证 gate 的本机迭代 loop
wukong login                   # 通过 device-code flow 登录
wukong doctor                  # 校验配置文件
wukong export [sessionId]      # 导出 session ZIP
wukong vis [sessionId]         # 打开 session visualizer
wukong migrate                 # 迁移 legacy wukong-cli 数据
wukong upgrade                 # 升级 Wukong Code
```

待实现命令：`wukong ship`、`wukong review`、`wukong schedule`（云端例程）。

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

当前产品方向是把 Wukong Code 做成 **AI 写代码时代的合并前验证层** —— AI Coding Loop 的控制层与验证层。实现计划见：

- [产品路线图](ROADMAP.md)
- [商业化与产品重构方案](docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- [技术实现方案](docs/tech/commercial-refactor-implementation.md)

P0 本地 CLI 命令、TUI 验证命令、`/proof`、`/judge`、`/goal --until` verification gate、`/loop`（含 `--every` cron scheduler pacing）和 `wukong_verify` agent tool 已经实现。剩余文档继续追踪云端报告、计费、团队规则和深度 review 等后续工作。

## 致谢

Wukong Code 在以下优秀项目的基础上构建，并从中借鉴了设计与工程经验：

- **[Kimi Code](https://github.com/MoonshotAI/kimi-code)** — Moonshot AI 的终端 AI coding agent。Wukong Code 的 CLI/TUI、agent runtime、provider/ACP/server 栈与会话模型基于 Kimi Code base 构建。感谢 Kimi Code 团队提供的基础与 MIT 许可的参考实现。
- **[Pi](https://github.com/earendil-works/pi)** — Mario Zechner 的 AI agent 工具集。Wukong Code 的交互式 TUI 基于 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi/tree/main/packages/tui)（差分渲染、编辑器、组件、终端 I/O）。感谢 Pi 项目提供 MIT 许可的终端 UI 基础。
- **[Claude Code](https://github.com/anthropics/claude-code)** — Anthropic 的终端 AI coding agent。Wukong Code 在 TUI chrome 布局（输入/状态区）、loop engineering 模式以及互操作能力（如 `/import-from-cc-codex` 导入 instructions、Skills 与 MCP 配置）上参考了 Claude Code。

Wukong Code 是独立产品，专注 **AI Coding Loop 控制与确定性验证**；与 Moonshot AI、Anthropic 及 Pi 项目作者无隶属关系，仅承认上述依赖与参考。

## 许可证

本软件为专有内部软件，详见 [LICENSE](LICENSE)。
