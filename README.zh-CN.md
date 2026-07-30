# Wukong Code

[文档](docs/README.md) · [English](README.md) · [下载](https://wukong.today/download)

> **给 Wukong 一个目标，它会循环工作直到改动准备好。**

Wukong Code 是围绕一个主流程构建的终端 AI coding agent：
**Goal → Write → Check → Review → Fix**。

给 `/loop` 一个目标，Wukong 会持续修改代码、运行仓库真实检查、从新的只读
上下文审查结果，并针对同一个目标修复 blocking findings。

## 当前版本：v0.0.21

`0.0.21` 提升了 Loop evidence 的完整性：

- 同一种内置风险出现在不同文件、行或 evidence 位置时，会保留每一个不同
  occurrence；
- 每个 occurrence 都根据完整 finding 生成稳定 identity；
- 字段完全相同的重复输入仍可确定性去重；
- deterministic Gate failure 继续优先于 reviewer 输出。

完整说明见 [v0.0.21 发布说明](docs/releases/0.0.21.md)。

## Wukong 能做什么

- **循环直到可交付**：在 write、check、review、fix 过程中固定同一个 Goal
  和 Finish Line。
- **运行真实检查**：使用仓库现有的测试、类型检查、lint、build 和项目
  review policy。
- **审查完整证据**：向独立 reviewer 提供有界、去密的 evidence，不丢失
  不同 finding。
- **复用验证标准**：从受信任的本地 Skills 中发现 qualitative criteria，
  由用户显式选择并确定顺序。
- **恢复未完成工作**：把 Wukong、Codex、Claude Code、Cursor、Kimi Code
  或 Grok 的本地会话作为只读上下文继续。
- **返回清晰结论**：每个 Loop 都以 `PASS`、`NEEDS_WORK` 或 `ERROR` 结束；
  未完成时显示 blocker 和下一步。
- **使用自己的模型服务**：通过 `wukong provider` 配置 API Key 和模型。

## 安装

公开原生安装包由
[`mutnpc/wukong-code`](https://github.com/mutnpc/wukong-code) 分发。

```sh
curl -fsSL https://wukong.today/install.sh | sh
wukong --version
```

升级现有原生安装：

```sh
wukong upgrade
```

## 快速开始

```sh
wukong provider
wukong
```

在 TUI 中：

```text
/loop 为注册表单增加输入校验
```

或直接运行：

```sh
wukong loop "为注册表单增加输入校验"
wukong loop "为注册表单增加输入校验" --dry-run
```

恢复其他 coding agent 的本地工作：

```text
/resume codex
/resume claude
/resume cursor
/resume kimi
/resume grok
```

## 主要命令

| 命令 | 说明 |
|---|---|
| `wukong` | 启动交互式 TUI |
| `wukong -p <prompt>` | 执行一次非交互 prompt |
| `wukong provider` | 配置模型 provider 与模型 |
| `wukong loop <goal>` | 围绕一个目标运行 write → check → review → fix |
| `wukong review init` | 创建 `.wukong/review-policy.md` |
| `wukong guard` | 查看命令风险 guard |
| `wukong login` | 连接可选 Wukong 账号 |
| `wukong doctor` | 校验本地配置 |
| `wukong upgrade` | 升级原生安装 |

完整参数以 `wukong --help` 为准。

## 本地数据与隐私

Loop contract、run state、evidence、findings 和导入的 session context 都保留在
本机。`/feedback` 只发送提交前明确展示的文本字段。模型请求发送到用户配置的
provider。

## 本地开发

环境要求：

- Node.js `>=24.15.0`
- pnpm `10.33.0`

```sh
git clone https://github.com/mutnpc/wukong_cli.git
cd wukong_cli
pnpm install
pnpm dev:cli
```

常用检查：

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

仓库约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 致谢

Wukong Code 在以下项目的基础上构建并借鉴工程经验：

- [Kimi Code](https://github.com/MoonshotAI/kimi-code)
- [Pi](https://github.com/earendil-works/pi)
- [Claude Code](https://github.com/anthropics/claude-code)

Wukong Code 是专注 AI coding Loop 控制与确定性验证的独立产品。

## 许可证

本软件为专有内部软件，详见 [LICENSE](LICENSE)。
