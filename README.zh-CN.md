# Wukong Code

[文档](docs/README.md) · [English](README.md) · [下载](https://wukong.today/download)

> **给 Wukong 一个目标，它会循环工作直到改动准备好。**

Wukong Code 是围绕一个主流程构建的终端 AI coding agent：
**Goal → Write → Check → Review → Fix**。

给 `/loop` 一个目标，Wukong 会持续修改代码、运行仓库真实检查、从新的只读
上下文审查结果，并针对同一个目标修复 blocking findings。

## 当前版本：v0.1.0

`v0.1.0` 是默认 installer 选择的 stable binary。immutable
[`v0.1.0-rc.1`](https://github.com/mutnpc/wukong-code/releases/tag/v0.1.0-rc.1)
继续保留为候选证据快照。

0.1.0 已收敛为一条可控、可恢复、可解释的本地单 Loop。当前候选已实现可执行的
provider-call/token 上限、versioned no-check decision、既有改动与 Wukong 改动归因、
完整终态 usage/next action，以及兼容/发布自动化 smoke。六平台候选构建、
公开资产、固定版本安装、`0.0.22` 升级、状态恢复、checksum 和 provenance
已经通过。stable 发布仍必须通过同一 exact-source、六平台、公开安装、升级、恢复与
公开版本面验收。真实来源流程和 opt-in cohort 改为发布后的产品学习证据，不再设置
固定 14 天等待门槛。成本估算由发布内嵌 catalog snapshot 的 pricing 离线计算；
完整多层 coverage schema、direct-shell content/PATH attestation 和自建 provider
价格数据库继续后移，不再阻塞版本。

`0.0.22` 在 primary remote catalog 不可用时仍可回退到 models.dev，并澄清 CLI 的
session 与权限控制：

- primary catalog 不可用时，provider discovery 会回退到 models.dev；
- 源码包含最终离线 snapshot 路径，但已发布的 0.0.22 native archive 因 release
  profile 缺陷未嵌入该 snapshot；
- `-r, --resume` 是 CLI 恢复 session 的规范参数；
- help 区分 guarded Auto、YOLO、Plan、headless `--yes` 与额外 workspace
  访问。

完整说明见 [v0.1.0 发布说明](docs/releases/0.1.0.md)。

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
- **返回清晰结论**：完成的 Gate 以 `PASS`、`NEEDS_WORK` 或 `ERROR` 结束；
  `/loop stop` 或 headless 进程在尚无 Gate verdict 时被中断，单独显示为
  `STOPPED_BY_USER`。
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

Headless 先预览，再把输出中列出的当前 checks、Gate、workspace 和 review 授权
flags 加回同一条命令。缺少这些显式决定时会安全退出，不会静默开始：

```sh
wukong loop "为注册表单增加输入校验" --dry-run
# 审查 dry-run 后，按输出的 “Headless start flags” 重跑同一命令
```

### 从输入到处理结果

启动前，TUI 会先用一份可编辑 Preflight 汇总展示 Goal、Done when、Must not 原文、
已选 checks/criteria 或 versioned no-check decision、Writer/Reviewer、脱敏 Provider
origin、既有 Git 改动、权限、出站输入上限、审批顺序、结果处理、轮次上限、
provider-call ceiling 和可选 token budget。Headless dry-run 会输出同类运行事实和
真正启动所需的精确 flags。安全授权仍
分别确认本地读取、Provider 传输、权限和项目 check 执行；有风险时优先编辑、检查或
取消，危险 Continue 固定在最后；取消不会创建 run 或调用 provider。versioned
no-check decision 可覆盖符合 policy 的文档/配置任务，但 source change 缺少必需
checks 时会 fail closed 为 `NEEDS_WORK/checks_missing`。

运行中值得关注的是 writer iteration、耗时、当前 tool/activity、
calls/tokens/retries/remaining budget，以及真正阻断继续的 provider、权限或检查问题。
TUI 的 `WRITE` / `CHECK` / `REVIEW` 是活动提示；headless
当前只明确输出 writer iteration 和正在运行的 tool，内部 reviewer 不一定单独显示为
`REVIEW`。模型回复“完成”不代表项目已经通过。

结束时查看确定性的终态摘要，而不是从模型文案猜结果。摘要会分别显示决定性
evidence、既有改动、Loop introduced/modified/deleted、unknown attribution、checks、
calls/tokens/retries/remaining budget、所用模型在发布内嵌 catalog 中有 pricing 时的
估算成本（否则保持 `Cost unavailable`）、主要 blocker 与安全的 Next：

- `PASS`：检查与只读 reviewer 均通过；先查看 `git status --short`、`git diff`，
  再通过 `/loop status` 或 review feedback 检查 non-blocking findings，最后按自己的
  流程 commit、push 或交付。
- `NEEDS_WORK`：查看主要 blocker 与 Next；处理后继续 Loop，或修正 Finish Line
  重新开始。
- `ERROR`：provider、check 或本地 state 没有形成可信结论；修复运行条件后重试，
  不能当作代码失败或 `PASS`。若出现 `provider_outcome_unknown`，先用 request ID /
  idempotency key 核对 provider logs 或 billing，禁止盲目 resume 或 retry。
- `PAUSED`：TUI Ctrl-C 或 `/loop pause` 只暂停同一个 Loop，不产生 Gate verdict；
  workspace 改动保留，可用 `/loop resume` 继续。
- `STOPPED_BY_USER`：`/loop stop` 或 headless 进程中断在没有 Gate verdict 时停止运行。
  检查保留的改动；`/loop stop` 会丢弃 contract，headless 仅在 provider outcome
  已知时提供 resume。

在 preflight 取消不会创建 run。Loop 内 Auto 权限拒绝是
`NEEDS_WORK/permission_required`，不是 `STOPPED_BY_USER`。自动化只能把最终 durable
`loop.result` 的 outcome 当作 Gate verdict；dry-run 或其他命令退出 `0` 不代表 `PASS`。

Wukong 不会因为 `PASS` 自动 commit、push 或发布。

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
| `wukong -p <prompt>` | 执行一次非交互 prompt；`COMPLETED` 不等于 Loop `PASS` |
| `wukong provider` | 配置模型 provider 与模型 |
| `wukong loop <goal>` | 围绕一个目标运行 write → check → review → fix |
| `wukong review init` | 创建 `.wukong/review-policy.md` |
| `wukong guard` | 查看命令风险 guard |
| `wukong login` | 连接可选 Wukong 账号 |
| `wukong logout` | 撤销账号会话并清除本地凭据 |
| `wukong doctor` | 校验本地配置 |
| `wukong upgrade` | 升级原生安装 |

完整参数以 `wukong --help` 为准。

`wukong logout` 会先向账号实际配置的 OAuth host 尝试撤销本地保存的 refresh
token，随后无论远端结果如何都会继续清理本地 token 和托管配置。远端确认成功时会
明确显示会话已撤销；网络、限流或服务端错误导致撤销结果为 unknown 时，本地凭据仍
会删除，同时明确警告服务端会话可能仍有效，并把
`https://wukong.today/contact` 作为需要立即失效时的下一步。没有 token 时重复执行
是安全且幂等的；如果本地清理本身失败，命令会报错，不会声称已经成功退出。

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
