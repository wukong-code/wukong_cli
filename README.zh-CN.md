# Wukong CLI

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[文档](docs/README.md) · [Issues](https://github.com/mutnpc/wukong/issues) · [English](README.md)

## 什么是 Wukong CLI

Wukong CLI 是基于当前 Kimi-code base 的本地优先终端 AI agent。当前仓库已经具备交互式 TUI、单次 prompt 模式、provider 管理、ACP 集成、本地 server/web UI、session 导出、迁移、doctor 诊断和可视化能力。

商业化方向会把 Wukong 重构为 AI 生成代码的验证与交付证据工具。当前 P0 本地命令行闭环已经包含 `wukong verify`、`wukong scan`、`wukong guard`；云同步、托管报告、深度 review 和 agent tool 集成仍是后续工作。

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
wukong login                   # 通过 device-code flow 登录
wukong doctor                  # 校验配置文件
wukong export [sessionId]      # 导出 session ZIP
wukong vis [sessionId]         # 打开 session visualizer
wukong migrate                 # 迁移 legacy wukong-cli 数据
wukong upgrade                 # 升级 Wukong
```

完整参数以 `wukong --help` 为准。

## 从源码运行

当前仓库没有经过验证的 `install.sh`、Homebrew formula 或正式发布安装文档。开发时使用 workspace 脚本：

```sh
git clone https://github.com/mutnpc/wukong.git
cd wukong
pnpm install
pnpm dev:cli
```

只运行 CLI entrypoint：

```sh
pnpm -C apps/wukong run dev:cli-only --help
```

当前 package metadata 使用 `@wukong/wukong`；不要继续使用旧的 `@wukong.today/wukong-cli` 名称，除非未来 release 明确恢复。

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

完整贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 商业化重构

当前产品方向是把 Wukong 做成 AI 生成代码的验证与交付证据工具。实现计划见：

- [商业化与产品重构方案](docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- [技术实现方案](docs/tech/commercial-refactor-implementation.md)

P0 本地 CLI 命令已经实现。剩余文档继续追踪 `wukong_verify`、云端报告、团队规则和深度 review 等后续工作。

## 许可证

基于 [MIT](LICENSE) 协议发布。
