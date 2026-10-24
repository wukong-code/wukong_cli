# 登录与同步历史验收记录

> Internal engineering record — kept in Chinese. English product docs: the user guide and release notes.

> 适用范围: `wukong_cli` 新 Kimi-code base
> 当前状态: `wukong login` 只连接可选账号；模型 Key 由 `/provider` 配置。未闭环的 Web sync 和 Companion 数据面已于 2026-07-22 删除。
> 本文件只保留历史验收背景，不是当前待实现 contract 或可直接运行的测试脚本。

## 当前事实

- `wukong login` 使用 device-code flow，当前 help 中没有 `--provider` 或 `--dev-email` 参数。
- `wukong logout` 是可见的 top-level command；TUI 等价入口为 `/logout`。
- logout 先尝试远端 refresh-token revoke，再执行本地 token 与托管配置清理；远端
  unknown 不能显示成“已确认撤销”。
- 当前 CLI 没有 `wukong sync`、`wukong sync --push`、`wukong sync --pull`。
- 仓库中没有 `tests/login-sync.test.mjs`。
- 新 base 默认数据目录为 `~/.wukong`，配置格式以 `config.toml`、`tui.toml`、`credentials/` 等当前代码为准。

## 可立即验证的登录与退出用例

### TC-01: 登录命令 help

| 步骤 | 动作 | 预期 |
|---|---|---|
| 1 | `pnpm -C apps/wukong run dev:cli-only -- login --help` | 命令退出码为 0 |
| 2 | 检查输出 | 只展示当前真实支持的 login 选项 |

### TC-02: 退出与撤销结果

| 步骤 | 动作 | 预期 |
|---|---|---|
| 1 | 检查 `wukong --help` 和 `wukong logout --help` | `logout` 是可见 top-level command，说明同时覆盖远端 revoke 与本地凭据清理 |
| 2 | 在隔离 home 写入测试 refresh token，mock revoke 返回 200 后执行 logout | 退出码为 0；显示远端会话已撤销；对应 token 与托管配置均删除 |
| 3 | 分别 mock 网络失败、429 和 5xx | 只要本地清理成功，退出码仍为 0；明确显示远端撤销未确认、服务端会话可能仍有效及 contact 下一步；本地 token 与托管配置均删除 |
| 4 | 无 token 时连续执行两次 logout | 不发送 revoke 请求；两次都安全结束并显示本地凭据已清理 |
| 5 | 模拟本地配置或凭据不可写 | 退出码为 1；显示本地清理失败，不声称 logout 成功 |

对应单元测试：`packages/oauth/test/revoke.test.ts`、
`apps/wukong/test/cli/oauth-logout.test.ts`、
`apps/wukong/test/cli/logout-flow.test.ts`、
`apps/wukong/test/cli/sub/logout.test.ts` 与
`apps/wukong/test/tui/commands/auth.test.ts`。

### TC-03: 配置目录隔离

| 步骤 | 动作 | 预期 |
|---|---|---|
| 1 | 设置 `WUKONG_CODE_HOME=/tmp/wukong-test-xxx` | CLI 使用临时数据目录 |
| 2 | 运行 `doctor` 或 `login --help` | 不修改真实 `~/.wukong` |
| 3 | 检查临时目录 | 只包含当前命令实际创建的文件 |

### TC-04: 配置校验

| 步骤 | 动作 | 预期 |
|---|---|---|
| 1 | 运行 `pnpm -C apps/wukong run dev:cli-only -- doctor` | 命令可执行 |
| 2 | 使用损坏的临时配置再次运行 | 输出清晰错误，不崩溃 |

## sync 实现后的验收目标

当 `wukong sync` 进入实现阶段，应补充正式 Vitest 或 e2e 用例，至少覆盖：

| 用例 | 命令 | 预期 |
|---|---|---|
| 首次拉取 | `wukong sync --pull` | 从云端拉取账号配置并写入临时 `WUKONG_CODE_HOME` |
| 本地推送 | `wukong sync --push` | 推送 config、provider metadata、report metadata，不上传未授权代码内容 |
| 双向同步 | `wukong sync` | 使用明确冲突策略合并 |
| 离线降级 | `wukong sync` | 网络失败时不破坏本地配置 |
| Token 过期 | `wukong sync --pull` | 能刷新或提示重新登录 |

## API 契约待定

不要继续沿用旧文档里的 `/sync/push`、`/sync/pull`、`/auth/session` 假设。sync 实现前必须先完成：

1. 定义新 base 的本地数据模型。
2. 定义云端 API 路径和鉴权方式。
3. 明确哪些数据可以上传，哪些只能保存在本地。
4. 明确冲突解决策略。
5. 明确 report metadata、team rules、quota/credits 是否属于同一同步域。

## 后续测试落地 TODO

1. 在 `apps/wukong/test/e2e/` 或合适测试目录增加登录/sync e2e。
2. 使用 `WUKONG_CODE_HOME` 临时目录隔离所有测试。`WUKONG_HOME` 不是受支持
   的隔离变量，不能用于会写配置的测试。
3. 对 fetch/API 调用使用 mock server，不依赖真实线上服务。
4. 覆盖凭证损坏、网络失败、版本迁移、并发冲突。
5. 在 sync 命令正式注册后，把本计划中的待实现用例转成可运行测试。
