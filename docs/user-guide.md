# Wukong Code 用户指南

> 适用范围: 当前 `wukong_cli` 新 Kimi-code base
> 更新时间: 2026-07-07
> 定位: AI 负责写代码，Wukong 负责判断能不能合并 —— AI Coding Loop 的控制层与验证层。
> 原则: 本文只写当前可执行的能力。`verify`、`scan`、`guard`、TUI 验证 slash commands（`/verify`、`/scan`、`/guard`、`/report`、`/goal`）和 `wukong_verify` agent tool 已实现；`loop`、`proof`、`judge`、`sync`、`today`、hosted reports、计费和团队规则仍未完成。

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

当前没有经过验证的 `https://wukong.today/install.sh`、Homebrew formula 或旧 `@wukong.today/wukong-cli` 安装路径。package metadata 当前发布包名为 `@wukong.today/code`。

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

### 5. 校验配置

```bash
pnpm -C apps/wukong run dev:cli-only -- doctor
```

### 6. 验证当前改动

```bash
pnpm -C apps/wukong run dev:cli-only -- verify --no-report
```

### 7. 扫描风险

```bash
pnpm -C apps/wukong run dev:cli-only -- scan --json
```

### 8. 查看 guard 状态

```bash
pnpm -C apps/wukong run dev:cli-only -- guard --status
```

### 9. 在 TUI 内运行验证

交互式 TUI 内当前可用：

```text
/verify
/scan
/guard status
/report
```

## 当前 top-level commands

| 命令 | 状态 | 用途 |
|---|---|---|
| `wukong` | 已实现 | 启动交互式 TUI |
| `wukong -p <prompt>` | 已实现 | 执行一次 prompt 并输出结果 |
| `wukong provider` | 已实现 | 管理 LLM provider |
| `wukong acp` | 已实现 | 以 Agent Client Protocol server 运行 |
| `wukong server` | 已实现 | 启动本地 REST/WebSocket server |
| `wukong web` | 已实现 | 打开本地 web UI |
| `wukong verify` | 已实现 | 运行确定性检查并生成本地证据报告 |
| `wukong scan` | 已实现 | 只读风险扫描 |
| `wukong guard` | 已实现 | 本地 guard 状态、统计和命令风险阻断 |
| `wukong login` | 已实现 | 通过 device-code flow 登录 |
| `wukong doctor` | 已实现 | 校验配置文件 |
| `wukong export` | 已实现 | 导出 session ZIP |
| `wukong vis` | 已实现 | 打开 session visualizer |
| `wukong migrate` | 已实现 | 迁移 legacy wukong-cli 数据 |
| `wukong upgrade` / `wukong update` | 已实现 | 升级 Wukong |

## 商业化命令状态

这些命令是商业化重构目标。当前 P0 已完成本地命令行闭环：

| 命令 | 计划定位 | 技术方案 |
|---|---|---|
| `wukong verify` | 本地验证当前改动并生成证据报告 | 已实现 |
| `wukong scan` | 只读风险扫描 | 已实现 |
| `wukong guard` | 高风险命令确认/拦截 | 已实现，P0 不自动改 shell profile |
| `wukong_verify` agent tool | 让 agent 在完成前调用验证 | 已实现，作为 builtin tool 接入 agent-core |
| `/verify`、`/scan`、`/guard`、`/report` | TUI 内验证、扫描、guard 状态和查看报告 | 已实现 |
| `wukong sync` | 云同步 | 等待新 base API 与本地数据模型对齐 |
| `wukong today` | 今日上下文 | 等待 verify/guard stats 落地后再实现 |

详见 [商业化重构技术实现方案](tech/commercial-refactor-implementation.md)。

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
- `/verify`、`/scan`、`/guard status`、`/report` 是 TUI slash commands。
- `wukong login --provider google --dev-email ...` 不是当前登录命令参数。
- `wukong sync --push`、`wukong sync --pull` 尚未在当前 CLI 中实现。
- 文档站 `/en/guides/*`、`/zh/guides/*` 页面当前没有对应源文件，不应作为发布入口宣传。
