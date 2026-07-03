# Verification CLI 自动化测试计划

> 日期: 2026-07-02
> 范围: `@wukong/verification`、`wukong verify`、`wukong scan`、`wukong guard`、TUI slash commands、`wukong_verify`
> 状态: P0 已实现并纳入自动化测试

## 1. 测试目标

P0 测试必须证明：

1. `@wukong/verification` 可以离线运行。
2. `wukong verify` 能运行显式命令和自动识别 Node package scripts。
3. `wukong scan` 能识别 staged diff 中的风险。
4. `wukong guard` 默认阻断高风险命令。
5. 三个 top-level commands 出现在 `wukong --help` 中。
6. CLI smoke 能从真实 entrypoint 启动，而不只是单元测试通过。
7. TUI `/verify`、`/scan`、`/guard`、`/report` 能渲染结果或状态。
8. `wukong_verify` agent tool 能返回 structured summary，并在失败时提醒 agent 不要声明完成。

## 2. 当前自动化测试

| 层级 | 文件 | 覆盖 |
|---|---|---|
| Core unit | `packages/verification/test/verify.test.ts` | explicit commands、package script detection、failed command、report writing |
| Core unit | `packages/verification/test/scan.test.ts` | staged diff placeholder risk、source changed without tests |
| Core unit | `packages/verification/test/policy.test.ts` | command risk classifier、guard status、blocked event stats |
| App unit | `apps/wukong/test/cli/verification-commands.test.ts` | command registration、verify/scan/guard handler output and exit code |
| App unit | `apps/wukong/test/tui/commands/verification.test.ts` | `/verify`、`/scan`、`/guard status`、`/report` handlers |
| Agent unit | `packages/agent-core/test/tools/wukong-verify.test.ts` | `wukong_verify` schema、execution、failed verification guidance |

## 3. 必跑命令

```bash
pnpm --filter @wukong/verification run typecheck
pnpm --filter @wukong/verification test
pnpm --filter @wukong/verification run build
pnpm --filter @wukong/wukong run typecheck
pnpm --filter @wukong/agent-core run typecheck
pnpm --filter @wukong/wukong exec vitest run test/cli/verification-commands.test.ts
pnpm --filter @wukong/wukong exec vitest run test/tui/commands/verification.test.ts
pnpm --filter @wukong/agent-core exec vitest run test/tools/wukong-verify.test.ts
```

## 4. CLI smoke

使用真实 entrypoint 验证命令可启动：

```bash
tsx --tsconfig apps/wukong/tsconfig.dev.json \
  --import build/register-raw-text-loader.mjs \
  apps/wukong/src/main.ts verify \
  --command "node -e 'process.exit(0)'" \
  --no-report

tsx --tsconfig apps/wukong/tsconfig.dev.json \
  --import build/register-raw-text-loader.mjs \
  apps/wukong/src/main.ts scan --json

WUKONG_HOME=/tmp/wukong-test \
tsx --tsconfig apps/wukong/tsconfig.dev.json \
  --import build/register-raw-text-loader.mjs \
  apps/wukong/src/main.ts guard --status
```

高风险命令必须默认阻断：

```bash
WUKONG_HOME=/tmp/wukong-test \
tsx --tsconfig apps/wukong/tsconfig.dev.json \
  --import build/register-raw-text-loader.mjs \
  apps/wukong/src/main.ts guard -- rm -rf /tmp/wukong-target
```

预期 exit code 为 `1`，并输出 `Blocked high-risk command`。

## 5. 后续测试 TODO

1. 增加真实 git repo fixture，覆盖 staged + unstaged diff 混合场景。
2. 增加 Windows shell command parsing 测试。
3. 如果 P1 实现 shell hook 安装，必须增加 profile 幂等写入和 disable 安全测试。
