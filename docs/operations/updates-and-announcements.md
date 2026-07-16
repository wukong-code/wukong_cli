# CLI 更新与公告契约

> 更新时间：2026-07-16
> 范围：`wukong_cli` 的更新检查、自动安装和 TUI 公告；公告发布源由 `wukong_web` 管理。

更新与公告是两条独立通道。更新通道负责让用户获得新版本；公告通道负责在 TUI 内展示版本、迁移、故障或预览信息。公告不能替代更新检查。

## 行为总览

| 通道 | 地址 | 调用时机 | 失败行为 | 本地状态 |
|---|---|---|---|---|
| 更新 | `https://wukong.today/latest.json`，失败时回退 `/latest` | CLI 启动 preflight；`wukong upgrade` 主动检查 | 静默继续使用当前版本；主动升级会返回错误 | 缓存最新版本、分批发布决策和后台安装结果 |
| 公告 | `https://wukong.today/cli/announcements.json` | 主 TUI 挂载后异步拉取一次 | 3 秒超时；网络、HTTP 或解析失败均静默跳过 | 只记录 `once` / `cooldown` 的展示时间，不缓存公告正文 |

### 更新通道

- `wukong upgrade` 与 `wukong update` 等价，始终主动获取最新版本，不受被动分批发布限制；检测到可升级版本后直接安装，不再二次询问。
- 交互式启动会先读取本地更新缓存，再在后台刷新远端 manifest。
- `npm`、`pnpm`、`yarn`、`bun` 全局安装支持后台自动安装；默认 `auto_install = true`。
- Homebrew 和 native binary 不会在启动 preflight 中执行后台安装；native macOS/Linux 用户会被引导运行 `wukong upgrade`。
- 主动运行 `wukong upgrade` 时，受支持的包管理器、Homebrew 和 native macOS/Linux 会直接完成升级；native 安装器锁定目标版本、校验 Release SHA-256，并以原子替换更新当前二进制。native Windows 和无法识别的安装来源回退到下载页。
- 后台安装成功后，下次交互式启动显示成功通知和 changelog 链接。
- 在 TUI 输入 `/settings`，选择 `Upgrade` 可以开关后台自动安装；也可以编辑 `~/.wukong/tui.toml`：

```toml
[upgrade]
auto_install = true
```

- `WUKONG_CODE_NO_AUTO_UPDATE=1` 完全关闭启动 preflight，包括检查、提示和后台安装。旧变量 `WUKONG_CLI_NO_AUTO_UPDATE` 仍兼容。

### 公告通道

- 数组顺序就是优先级；每次启动最多展示第一条符合条件且未被频控的公告。
- 客户端检查 `enabled`、客户端最小/最大版本、开始/结束时间、级别和展示策略。
- `once` 每个公告 `id` 每台设备展示一次；`cooldown` 按小时频控；`always` 每次启动展示。
- `info`、`warning`、`critical` 使用不同的 TUI 强调色；操作链接作为可见 HTTPS URL 展示。
- 远端文案会删除终端控制字符并限制长度。操作链接只允许 `wukong.today` 及其子域名，或 `github.com/mutnpc/wukong-code`。
- 请求不附带 Wukong 登录 token、项目内容或个性化参数。服务端仍会看到普通 HTTPS 请求固有的 IP、User-Agent 等网络元数据。
- `auto_install` 和 `WUKONG_CODE_NO_AUTO_UPDATE` 只控制更新通道，不关闭公告通道。当前没有单独的公告开关。

## 版本启动边界

`0.0.10` 及更早版本仍写死旧公告地址，不能读取新 JSON。它们必须先通过独立的 `latest.json` 更新通道升级到包含新地址的版本。新公告通道只能用于触达该版本及之后的客户端，不能用来宣布公告通道自身首次上线。

## 公告发布所有权

当前不做管理员 UI，也不使用数据库。唯一源文件位于 `wukong_web`：

```text
public/cli/announcements.json
public/cli/announcements.schema.json
public/cli/announcements.example.json
docs/cli-announcements.md
scripts/validate-cli-announcements.mjs
```

发布、撤回、字段定义和线上验收以 `wukong_web/docs/cli-announcements.md` 为准。CLI 只负责拉取、验证和展示。

## 当前上线状态

- [x] 静态 JSON、Schema、示例和发布前校验器已准备
- [x] CLI 已接入新版协议、版本/时间过滤、频控、级别、链接和安全过滤
- [ ] 部署 `wukong_web`，使线上 `/cli/announcements.json` 不再返回 404
- [ ] 发布包含新公告地址的下一个 CLI 版本
- [ ] 完成上述两步后再启用第一条正式公告

不要在部署 Web 文件之前发布依赖该地址的 CLI，也不要在旧客户端无法读取新地址时把公告当成升级通知的唯一渠道。
