# Wukong Code

> 给 Wukong 一个目标，让它用检查结果证明改动真的完成。

免费、本地优先、BYOK 的终端 CLI，支持 macOS、Linux 和 Windows。

## 安装

```sh
curl -fsSL https://wukong.today/install.sh | sh
wukong --version
```

## 开始使用

在项目中初始化检查与模型连通性，再运行离线快检或独立验收门禁：

```sh
cd your-project
wukong init
wukong check
wukong gate
```

也可以直接配置 provider 后进入交互式 TUI：

```sh
wukong provider
wukong
```

在 TUI 中输入一个目标：

```text
/loop 为注册表单增加输入校验
```

Wukong 会修改代码、运行仓库自己的检查、审查结果，并修复阻塞问题。Gate 或 Loop
最终会给出清晰的 `PASS`、`NEEDS_WORK` 或 `ERROR`，并可通过 `wukong summary`
生成脱敏 PR 交付证明卡（Delivery Proof Card）。

## Headless 模式

先生成包含单一确认摘要的 run-plan 预览：

```sh
wukong loop "为注册表单增加输入校验" --dry-run --plan-out .wukong/run-plan.json
```

核对后用单一 digest 启动运行（旧多项确认 flag 仍兼容）：

```sh
wukong loop --plan .wukong/run-plan.json --approve-plan <planDigest>
```

缺少明确决定时会安全退出，不会静默开始。

## 常用命令

```text
wukong init           探测工具链、生成 .wukong/ 配置并引导 provider 测试
wukong check          离线运行项目检查与风险扫描（reviewer: not_run）
wukong gate           运行确定性检查、风险扫描与独立上下文审查
wukong summary        渲染脱敏 PR 交付证明卡
wukong loop <goal>    运行 write → check → review → fix
wukong provider       配置并测试模型服务商连通性
wukong doctor         检查本地配置
wukong upgrade        升级原生安装
```

接着其他 coding agent 没做完的工作：

```text
/resume codex
/resume claude
/resume cursor
/resume kimi
/resume grok
```

运行 `wukong --help` 查看核心命令，或运行 `wukong help --all` 查看完整命令列表。

## 隐私

工作区数据和 Loop 证据保留在本机。模型请求只发送到你配置的 provider。Wukong 不会替你
commit、push 或发布改动。

## 本地开发

环境要求：Node.js `>=24.15.0`、pnpm `10.33.0`。

```sh
git clone https://github.com/wukong-code/wukong_cli.git
cd wukong_cli
pnpm install
pnpm dev:cli
```

更多内容见 [贡献指南](CONTRIBUTING.md) 和[文档](docs/README.md)。

## 致谢

Wukong Code 在许多开源项目的基础上构建并借鉴工程经验，包括：

- [Kimi Code](https://github.com/MoonshotAI/kimi-code)
- [Pi](https://github.com/earendil-works/pi)
- [Claude Code](https://github.com/anthropics/claude-code)
- [Grok Build](https://github.com/xai-org/grok-build)
- [Codex](https://github.com/openai/codex)
- [Cursor](https://cursor.com)
- [Prismor](https://github.com/PrismorSec/prismor)

Wukong Code 是专注 AI coding Loop 控制与确定性验证的独立产品。

## 许可证

本地 CLI 及其源码按 [MIT License](LICENSE) 开源。官网和运营后端是独立的私有产品。
