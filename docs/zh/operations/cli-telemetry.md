# CLI telemetry contract

> 状态：当前源码审计结果。它描述已存在的 optional CLI telemetry，不是 0.1.0
> cohort、计费、准入或新 metrics backend。installer 不创建 telemetry identity，也不发送
> event。

## 开关与 endpoint

CLI 只向以下 endpoint 发送最小使用信号：

```text
POST https://telemetry-logs.wukong.today/v1/event
Content-Type: application/json
```

设置 `telemetry = false`，或在启动 CLI 前设置 `WUKONG_TELEMETRY=0`，可关闭发送。
兼容开关 `WUKONG_DISABLE_TELEMETRY=1` 也会关闭。关闭时不会改变本地 Loop、Gate、
Resume 或 provider 行为；当前进程的内存 buffer 会清空，`~/.wukong/telemetry/failed_*.jsonl`
失败队列也会删除。

## Wire fields

每个 request 只有 `user_id` 和 `events` 两个顶层字段。`user_id` 是
`kfc_device_id_` 加随机安装 ID，不是 hostname、硬件 ID 或 OS device ID。

自 2026-10-28 起，客户端每批只上传**一条最小信号**，不包含其他任何内容。每批
压缩为一条记录，字段只有：

- `event`：固定名称 `kfc_signal`；
- `timestamp`：批内最近一次活动的 Unix seconds；
- `context_version`：CLI 版本；
- `context_platform`：OS 平台；
- `context_arch`：CPU 架构（各字段可为 `null`）。

事件名、工具、命令、时长、`property_*` 值、`event_id`、`device_id` 和
`session_id` 一律不上传。源码中的 `track()` 调用点仍然存在，但传输层在任何
数据离开设备之前——包括本地失败队列的重试——都会把每批压缩为最小信号。旧版本
客户端仍会发送此前文档记录的完整事件；接收端接受但只保留最小字段（见下方
retention），其余丢弃。

## 明确不发送

Product telemetry 不应包含 source code、diff、prompt、Goal/objective、transcript、
repository name、file path、exact Gate command、raw evidence、provider key/endpoint、
model identity、tool arguments、hostname、terminal details 或 hardware fingerprint。
`/feedback` 和显式 Device Login 是不同的数据流，不属于此 endpoint。

## Buffer、retry 与 retention

- 内存队列最多 1,000 events；sink 每 30 秒或累计 50 events flush；
- request timeout 为 10 秒；瞬态失败按 1/4/16 秒 backoff；
- 发送失败写入权限为 `0600` 的 `~/.wukong/telemetry/failed_*.jsonl`；启用 telemetry
  时，超过 7 天的失败文件会在下次启动清除；opt-out 会立即尽力删除这些文件；
- **远端接收与保留（2026-10-02 起）：** 接收端是 `wukong_web/workers/telemetry` 中的
  Cloudflare Worker，数据写入独立 D1 数据库 `wukong-telemetry`。**服务端只统计安装数**：
  只保存随机安装 ID、使用日期（精确到天）、CLI 版本、平台和架构；CLI 发来的事件名、
  工具、命令、时长和全部 `property_*` 只用于校验格式，收到后即丢弃、从不落盘。它忽略
  CLI 为已登录用户附带的 `Authorization`，不保存 IP；每日定时任务删除最后使用超过 90 天
  的安装记录和 90 天前的使用日期。运维与删除流程见 `wukong_web/docs/privacy-operations.md`。
  这些数据只用于统计安装与活跃数，不能当作 25/20/15/7 cohort 证据。
- 2026-10-02 之前，`telemetry-logs.wukong.today` 没有 DNS 记录，所有已发布版本的事件都
  未送达，只停留在本地失败队列中（最多 7 天）。

## 验证位置

实现与负向测试位于 `packages/telemetry/src` 和 `packages/telemetry/test/telemetry.test.ts`。
任何新增 event/property 都必须同步更新本页，并继续通过“不含敏感内容”的负向测试。
