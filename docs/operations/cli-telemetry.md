# CLI telemetry contract

> 状态：当前源码审计结果。它描述已存在的 optional CLI telemetry，不是 0.1.0
> cohort、计费、准入或新 metrics backend。installer 不创建 telemetry identity，也不发送
> event。

## 开关与 endpoint

CLI 只向以下 endpoint 发送 product event：

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
`kfc_device_id_` 加随机安装 ID，不是 hostname、硬件 ID 或 OS device ID。每个 event
展开后只包含：

- `event_id`：随机 128-bit hex ID；
- `device_id`、`session_id`：随机本地标识，可为 `null`；
- `event`：固定 `kfc_` 前缀加 lifecycle event 名；
- `timestamp`：Unix seconds；
- `context_app_name`、`context_version`、`context_runtime`、`context_platform`、
  `context_arch`、`context_ui_mode`；
- `property_*`：调用点传入的 boolean、finite number、string、`null` 或 `undefined`。

当前源码中的 property 名按用途分为：

- lifecycle/outcome：`actor`、`status`、`outcome`、`reason`、`reason_code`、
  `error_type`、`retryable`、`duration_ms`；
- Loop/Goal：`iterations`、`iteration`、`turns_used`、`tokens_used`、
  `wall_clock_ms`、`criteria_count`、`contract_source`、`contract_schema_version`、
  `blocker_count`、`gate_outcome`、`strategist_outcome`、`has_token_budget`、
  `has_turn_budget`、`has_wall_clock_budget`；
- provider/runtime class：`provider`、`provider_type`、`protocol`、`method`、
  `status_code`、`input_tokens`、`limit`；
- command/tool control：`command`、`tool_name`、`policy_name`、`permission_mode`、
  `decision`、`approval_surface`、`result`、`has_feedback`、`session_cache_written`、
  `dup_type`、`repeat_count`、`action`、`at_step`、`step_no`、`turn_id`；
- UI/config：`enabled`、`theme`、`direction`、`source`、`mode`、`to_mode`、
  `auto_install`、`changed`、`kind`、`parts`；
- bounded counts/performance：`count`、`server_count`、`failed_count`、`total_count`、
  `allowed_tool_count`、`capability_mode`、`profile_category`、`run_in_background`、
  `recurring`、`coalesced_count`、`stale`、`buffered`，以及 compaction 的 token/count/
  threshold 数值；
- media upload：`mime_type`、`size_bytes`（不含 media bytes 或 path）。

传输层会丢弃非 primitive property；客户端还会集中丢弃 `model`、`alias` 和
`args_hash`，避免发送模型身份或由 tool arguments 派生的可关联 hash。context 同样不含
model、terminal、locale、OS version 或 Node version。

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
- **远端 retention 尚未在这个 repository 或公开 backend contract 中定义。** 因此不能
  宣称具体远端删除期限，也不能把 telemetry 当作 0.1.0 的 25/20/15/7 cohort 证据。
  在 operator 给出可验证的 retention/deletion contract 前，这仍是发布隐私审计项。

## 验证位置

实现与负向测试位于 `packages/telemetry/src` 和 `packages/telemetry/test/telemetry.test.ts`。
任何新增 event/property 都必须同步更新本页，并继续通过“不含敏感内容”的负向测试。
