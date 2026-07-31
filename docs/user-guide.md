# Wukong Code 用户指南

> 适用范围: 当前 `wukong_cli` 新 Kimi-code base
> 更新时间: 2026-07-31
> 定位: 给 Wukong 一个目标，通过 Goal → Write → Check → Review → Fix 循环直到没有 blocking finding。
> 原则: 本文只写当前开发分支可执行的能力。Loop、冻结验收合同、prior blocker 复审、无进展 strategist、Permission Mode v2、结构化 review findings、项目 review policy、本地 feedback、独立 reviewer model 和高级诊断命令已实现；当前没有付费计划、订阅 entitlement、团队规则或 PR gate 承诺。

## 安装正式版

macOS 和 Linux：

```bash
curl -fsSL https://wukong.today/install.sh | sh
wukong --version
```

安装器从公开 Release 下载对应平台的 native binary，并校验配套 SHA-256。0.0.12 native binary 升级到 0.0.13 时需要执行一次上述安装命令；从 0.0.13 开始，macOS 和 Linux native 安装可直接运行 `wukong upgrade`。

Windows 请从 [下载页](https://wukong.today/download) 获取对应的 x64 或 ARM64 压缩包。

## 从源码运行

```bash
git clone https://github.com/mutnpc/wukong_cli.git
cd wukong_cli
pnpm install
pnpm dev:cli
```

只运行 CLI entrypoint：

```bash
pnpm -C apps/wukong run dev:cli-only --help
```

公开下载仓库是 `mutnpc/wukong-code`。当前没有 Homebrew formula，也不发布旧的 `@wukong.today/wukong-cli` 包名。

## 5 分钟快速开始

### 1. 查看命令面

```bash
pnpm -C apps/wukong run dev:cli-only --help
```

### 2. 启动交互式 TUI

```bash
pnpm dev:cli
```

进入项目后，可以直接输入任务，例如：

```text
帮我看一下这个项目的目录结构，说明主要模块各自负责什么。
```

### 3. 执行一次非交互 prompt

```bash
pnpm -C apps/wukong run dev:cli-only -- -p "summarize this repository"
```

### 4. 管理 provider

```bash
pnpm -C apps/wukong run dev:cli-only -- provider --help
```

TUI 中使用 `/provider` 配置模型服务商和 API Key。`/login` 只连接可选 Wukong 账号，不会提供或配置模型。

Provider 目录默认按以下顺序读取：

1. `https://modelpricehub.com/api.json`
2. `https://models.dev/api.json`
3. 随发行包内置的常用 provider 快照

网络目录都不可用时，`/provider` 和未指定 `--url` 的
`wukong provider catalog` 命令仍可使用内置快照。快照包含 OpenAI、
Anthropic、Google、DeepSeek、OpenRouter，以及 GLM（`zai`、
`zai-coding-plan`）和 Kimi（`moonshotai-cn`、`kimi-for-coding`）。

可通过环境变量替换首选目录：

```bash
WUKONG_CODE_CATALOG_URL=https://catalog.example.com/api.json wukong provider catalog list
```

显式传入 `--url` 时只访问指定地址，不会静默回退，便于验证私有目录：

```bash
wukong provider catalog list --url https://catalog.example.com/api.json
```

### 5. 校验配置

```bash
pnpm -C apps/wukong run dev:cli-only -- doctor
```

### 6. 启动第一个 Loop

```bash
pnpm -C apps/wukong run dev:cli-only -- loop "完成当前改动"
```

### 7. 创建项目 review policy

```bash
pnpm -C apps/wukong run dev:cli-only -- review init
```

### 8. 为 finding 记录本地反馈

```bash
pnpm -C apps/wukong run dev:cli-only -- review feedback <finding-id> accept
```

### 9. 在 TUI 内启动 Loop

交互式 TUI 内当前可用：

```text
/loop <objective>
/loop --review-model <model-alias> -- <objective>
/loop status
/loop pause
/loop resume
/loop stop
```

以 `-` 开头的 objective 需要放在 `--` 后；未知参数会直接报错，不再被当作 objective。

### 10. 启动受验证约束的 Loop

```bash
wukong loop "修复失败测试" --max-iterations 5
wukong loop "完成 API 改动" --model fast --review-model slow
wukong loop "完成 API 改动" --review-model reviewer
wukong loop "完成 API 改动" --dry-run
wukong loop "完成 API 改动" --done-when "兼容性测试通过" --constraint "不删除旧字段"
```

Loop 的最终三态和退出码为 `PASS=0`、`NEEDS_WORK=1`、`ERROR=2`，中断为 `130`。所有用户都可以直接运行本地 BYOK Loop，不要求登录，不设置 Guest 试用或月度次数，也不请求 Wukong quota 服务。默认单次最多 10 轮，可用 `--max-iterations` 调整；reviewer step/time 上限和 `/loop stop` 继续提供失控保护。`verify`、`scan`、`proof` 是内部检查层和高级诊断命令。

0.0.19 的新 Loop 会先进入 Finish Line：确认 Goal、可选 Done when、Must not、必跑 checks 和本 run 上限后才创建合同与 run。`--dry-run` 只生成完整提案、workspace challenge、warning digest 和 Gate approval digest，不创建信任授权、合同或 run。Headless 真正执行 discovered checks 时必须确认 dry-run 返回的精确 digest；`--yes`、Auto 或 YOLO 都不能代替。项目 check 会按当前 OS 权限运行可信 workspace 里的 shell，Wukong 会执行静态风险拦截，但不宣称提供完整 shell sandbox。

0.0.20 会在 Finish Line 的 **Review verification** 中列出本机现有
Verification Skill 的 strict criteria sidecar。`○ suggested` 只表示
versioned path/package 规则命中，不等于已选择；只有用户显式勾选并确认
exact source、full provenance digest 和 flat order 后才会创建 V3 合同。
同名 Skill 不再 first-wins，必须选择完整 identity。Skill Markdown 正文、
commands、scripts、tools、hooks、MCP 和权限声明都不能进入 Gate。

无论是否选择 Skill，新的 reviewer attempt 都先要求独立的本机 broker
read trust，再逐 run 确认允许的输入范围、上限和实际 BYOK provider
endpoint。允许的 changed/untracked/scope-matched 文件与脱敏 Gate evidence
可能发送给该 provider，但不会上传给 Wukong Web/D1；`.env`、credential、
session、trust store、log、binary/generated 和 secret-bearing 内容不会生成
可读 ref。Cancel、缺少 exact consent 或 drift 时不会打开 provider connection。

Headless 先查看同一协议：

```bash
wukong loop "完成 API 改动" --dry-run --output-format stream-json
```

只有 selection 非空时才提交返回的
`--verification-catalog-digest` 与可重复
`--verification-skill "<selection-id>@<provenance-digest>"`；无 selection
继续创建 V2，并且必须省略 catalog CAS。实际启动还需 dry-run 返回的短时
`--trust-review-subject` challenge 与 exact `--ack-review-subject`。`--yes`、
Auto 或 YOLO 不能代替这些决定。

0.0.16 会在 Loop 创建时冻结用户 objective 和显式 completion criterion。Reviewer 每轮必须先处理上一轮 blocker；同一 blocker 连续两轮不变时只启动一次只读 strategist。策略后仍无进展会返回 `NEEDS_WORK/no_progress`，不会继续空转或偷偷增加迭代额度。

### 11. 选择 Permission Mode

- `manual`：需要时询问用户，适合交互式使用。
- `auto`：不提问，但受 workspace、敏感目标、高风险 Bash 和 custom/MCP capability 边界约束；阻断发生在活动 Loop 内时会暂停为 `NEEDS_WORK/permission_required`。
- `yolo`：跳过普通 approval 的危险模式，但仍不能绕过用户 deny、安全 Hook、Plan guard、Role/profile allowlist 或只读分身上限。

Headless `-p` 默认使用受限 Auto。危险 headless 执行必须明确写出：

```bash
wukong -p "完成当前改动" --yolo --yes
```

单独 `--yes` 不再启用 YOLO。旧 `--auto-approve` 在一个兼容版本内仍映射到 YOLO，但会显示弃用和危险警告。

### 12. 继续其他 Agent 的本地会话

TUI 内使用统一入口：

```text
/resume
/resume codex
/resume claude
/resume cursor
```

`/resume` 默认只显示 Wukong 会话。只有显式使用 `codex`、`claude` 或 `cursor` 参数时，才扫描对应 Agent 的本地会话。`/resume-codex`、`/resume-claude`、`/resume-cursor` 是兼容入口，不进入主命令列表。

Wukong session 会原生恢复；外部 session 会通过内置 Skill 读取本地 transcript，提取目标、已完成工作、未完成工作和最后请求，然后在 Wukong 中继续。该过程不会重启原 Agent、继承其权限或重放旧工具调用；继续前必须重新读取当前 workspace 与 Git 状态。

Welcome 最多建议一条当前 workspace、30 天内的外部会话，可在 `~/.wukong/tui.toml` 的 `[resume] foreign_suggestions = false` 中关闭；显式 `/resume <source>` 不受此开关影响。Session picker 支持搜索最近 100 个 Wukong session 的用户 prompt 摘要，每个 session 最多读取 128 KiB，并忽略 system、tool 和 synthetic 内容。

## 当前 top-level commands

| 命令 | 状态 | 用途 |
|---|---|---|
| `wukong` | 已实现 | 启动交互式 TUI |
| `wukong -p <prompt>` | 已实现 | 执行一次 prompt 并输出结果 |
| `wukong provider` | 已实现 | 配置 BYOK LLM provider、API Key 与默认模型 |
| `wukong acp` | 已实现 | 以 Agent Client Protocol server 运行 |
| `wukong server` | 已实现 | 启动本地 REST/WebSocket server |
| `wukong web` | 已实现 | 打开本地 web UI |
| `wukong verify` | 已实现 | 运行确定性检查并生成本地证据报告 |
| `wukong scan` | 已实现 | 只读风险扫描 |
| `wukong guard` | 已实现 | 本地 guard 状态、统计和命令风险阻断 |
| `wukong proof` | 已实现 | 生成 Merge Proof Report（verify + scan 汇总） |
| `wukong judge` | 已实现 | deterministic 合并判定（只审不写） |
| `wukong loop` | 已实现 | headless Loop；支持 `--max-iterations`、`--every`、`--model`、`--review-model`、`--dry-run` |
| `wukong review init` | 已实现 | 创建 `.wukong/review-policy.md` |
| `wukong review feedback` | 已实现 | 将 finding 反馈追加到本地 JSONL，不上传源码或 reason |
| `wukong review stats` | 已实现 | 查看本地反馈原始数量；样本少于 10 时隐藏质量比例 |
| `wukong login` | 已实现 | 连接可选 Wukong 账号；不配置模型 |
| `wukong doctor` | 已实现 | 校验配置文件 |
| `wukong export` | 已实现 | 导出 session ZIP |
| `wukong vis` | 已实现 | 打开 session visualizer |
| `wukong migrate` | 已实现 | 迁移 legacy wukong-cli 数据 |
| `wukong upgrade` / `wukong update` | 已实现 | 升级 Wukong |

## 更新与 TUI 公告

- CLI 启动时会检查更新；默认允许受支持的包管理器在后台自动安装。可在 `/settings` → `Upgrade` 中关闭，或设置 `~/.wukong/tui.toml` 的 `[upgrade].auto_install = false`。
- `wukong upgrade` / `wukong update` 会立即检查并安装最新版本，不再二次询问。native macOS/Linux 会校验 Release SHA-256 后原子替换当前二进制；native Windows 或无法识别的安装来源会回退到下载页。
- 主 TUI 启动后会异步拉取一次公告，3 秒超时。失败不会阻塞 CLI，每次最多展示一条。
- 公告支持客户端版本、时间范围、`once` / `cooldown` / `always` 频控和安全链接白名单。
- `0.0.10` 及更早版本不能读取新公告地址，需要先通过更新通道升级。

完整实现和发布边界见 [CLI 更新与公告契约](operations/updates-and-announcements.md)。

## 商业化命令状态

这些命令是商业化重构目标。当前 P0 已完成本地命令行闭环：

| 命令 | 计划定位 | 技术方案 |
|---|---|---|
| `wukong verify` | 本地验证当前改动并生成证据报告 | 已实现 |
| `wukong scan` | 只读风险扫描 | 已实现 |
| `wukong guard` | 高风险命令确认/拦截 | 已实现，P0 不自动改 shell profile |
| `wukong proof` | Merge Proof Report（verify + scan 汇总） | 已实现 |
| `wukong judge` | deterministic 只审不写判定 | 已实现 |
| `wukong loop` | 本机迭代 loop，直到检查与只读 reviewer 通过 | top-level 和 TUI 均已实现；返回结构化多 findings，只有 blocking finding 阻止 Loop |
| `wukong review` | 项目 review policy 与本地 finding feedback | `init`、`feedback`、`stats` 已实现 |
| `wukong_verify` agent tool | 让 agent 在完成前调用验证 | 已实现，作为 builtin tool 接入 agent-core |
| `/verify`、`/scan`、`/guard`、`/goal`、`/proof`、`/judge`、`/loop` | TUI 内验证、扫描、guard 状态及 goal/loop 驱动 | 已实现 |
| `wukong sync` | 云同步 | 等待新 base API 与本地数据模型对齐 |
| `wukong today` / `/today` | Local Loop Briefing：本地统计 + focus，不依赖网络 | 已实现，见 [today 设计](design/today.md) |

详见 [商业化重构技术实现方案](tech/commercial-refactor-implementation.md)。

## 0.0.12 兼容性

旧 `--until verify-pass`、`scan-clean` 和 `judge-pass` 参数仍被接受，并统一映射到 `proof-pass`。恢复 0.0.11 Goal records 时执行同样迁移；不会重写原始历史文件。完整行为和未来移除窗口见 [Goal 与 Loop 兼容矩阵](design/0.0.12-compatibility.md)。

## 本地数据

当前新 base 使用 `~/.wukong` 作为默认数据目录。配置和凭证的具体格式以代码为准，常见文件包括：

```text
~/.wukong/config.toml
~/.wukong/tui.toml
~/.wukong/credentials/
```

测试或调试时优先使用临时 home，避免污染真实配置：

```bash
WUKONG_HOME=/tmp/wukong-test pnpm -C apps/wukong run dev:cli-only -- doctor
```

## 开发校验

```bash
pnpm --filter @wukong/wukong run typecheck
pnpm -C apps/wukong run dev:cli-only --help
pnpm -C apps/wukong run dev:cli-only -- login --help
```

## 常见误区

- `wukong verify`、`wukong guard`、`wukong scan` 是当前已实现命令。
- `wukong_verify` 是内置 agent tool，不是 top-level shell command。
- `/verify`、`/scan`、`/guard status`、`/proof`、`/judge`、`/goal`、`/loop` 是 TUI slash commands。
- `wukong login --provider google --dev-email ...` 不是当前登录命令参数。
- `wukong sync` 与 Companion `journey` 已从当前产品范围移除，不是待发现的隐藏命令。
- 文档站 `/en/guides/*`、`/zh/guides/*` 页面当前没有对应源文件，不应作为发布入口宣传。
