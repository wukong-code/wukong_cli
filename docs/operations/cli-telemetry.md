# CLI Telemetry Contract

> Status: an audit of the current source. It describes the existing optional
> CLI telemetry — not a 0.1.0 cohort, billing, eligibility, or a new metrics
> backend. The installer creates no telemetry identity and sends no events.

## Opt-out and endpoint

The CLI sends product events to exactly one endpoint:

```text
POST https://telemetry-logs.wukong.today/v1/event
Content-Type: application/json
```

Set `telemetry = false`, or export `WUKONG_TELEMETRY=0` before starting the CLI,
to disable sending. The legacy `WUKONG_DISABLE_TELEMETRY=1` also disables it.
Disabling does not change local Loop, Gate, Resume, or provider behavior; the
in-memory buffer for the current process is cleared and the failure queue at
`~/.wukong/telemetry/failed_*.jsonl` is deleted.

## Wire fields

Every request has two top-level fields: `user_id` and `events`. `user_id` is
`kfc_device_id_` plus a random installation ID — not a hostname, hardware ID, or
OS device ID. Each expanded event contains only:

- `event_id`: a random 128-bit hex ID;
- `device_id`, `session_id`: random local identifiers, possibly `null`;
- `event`: a fixed `kfc_` prefix plus a lifecycle event name;
- `timestamp`: Unix seconds;
- `context_app_name`, `context_version`, `context_runtime`, `context_platform`,
  `context_arch`, `context_ui_mode`;
- `property_*`: boolean, finite number, string, `null`, or `undefined` values
  passed at the call site.

Current property names group by purpose:

- lifecycle/outcome: `actor`, `status`, `outcome`, `reason`, `reason_code`,
  `error_type`, `retryable`, `duration_ms`;
- Loop/Goal: `iterations`, `iteration`, `turns_used`, `tokens_used`,
  `wall_clock_ms`, `criteria_count`, `contract_source`,
  `contract_schema_version`, `blocker_count`, `gate_outcome`,
  `strategist_outcome`, `has_token_budget`, `has_turn_budget`,
  `has_wall_clock_budget`;
- provider/runtime class: `provider`, `provider_type`, `protocol`, `method`,
  `status_code`, `input_tokens`, `limit`;
- command/tool control: `command`, `tool_name`, `policy_name`,
  `permission_mode`, `decision`, `approval_surface`, `result`, `has_feedback`,
  `session_cache_written`, `dup_type`, `repeat_count`, `action`, `at_step`,
  `step_no`, `turn_id`;
- UI/config: `enabled`, `theme`, `direction`, `source`, `mode`, `to_mode`,
  `auto_install`, `changed`, `kind`, `parts`;
- bounded counts/performance: `count`, `server_count`, `failed_count`,
  `total_count`, `allowed_tool_count`, `capability_mode`, `profile_category`,
  `run_in_background`, `recurring`, `coalesced_count`, `stale`, `buffered`, plus
  compaction token/count/threshold numbers;
- media upload: `mime_type`, `size_bytes` (never media bytes or paths).

The transport drops non-primitive properties; the client additionally drops
`model`, `alias`, and `args_hash` centrally so no model identity or correlatable
hash derived from tool arguments is sent. Context contains no model, terminal,
locale, OS version, or Node version.

## Explicitly never sent

Product telemetry must not contain source code, diffs, prompts, goals, transcripts,
repository names, file paths, exact Gate commands, raw evidence, provider
keys/endpoints, model identity, tool arguments, hostnames, terminal details, or
hardware fingerprints. `/feedback` and explicit Device Login are separate data
flows outside this endpoint.

## Buffering, retry, and retention

- The in-memory queue holds at most 1,000 events; the sink flushes every 30
  seconds or every 50 events.
- Request timeout is 10 seconds; transient failures back off at 1/4/16 seconds.
- Failed sends append to `~/.wukong/telemetry/failed_*.jsonl` with mode `0600`;
  while telemetry is enabled, files older than 7 days are cleared on the next
  launch; opting out deletes them immediately on a best-effort basis.
- **Remote receiving and retention (since 2026-10-02):** the receiver is a
  Cloudflare Worker in `wukong_web/workers/telemetry` writing to the separate
  D1 database `wukong-telemetry`. **The server counts installations only**: it
  stores a random installation ID, days of use (day precision), CLI version,
  platform, and architecture. Event names, tools, commands, durations, and all
  `property_*` fields from the CLI are format-checked then discarded — never
  persisted. It ignores the `Authorization` header logged-in clients attach and
  stores no IP; a daily job deletes installations unused for 90 days and
  day-of-use records older than 90 days. Operations and deletion live in
  `wukong_web/docs/privacy-operations.md`. The data counts installations and
  activity only and is not 25/20/15/7 cohort evidence.
- Before 2026-10-02, `telemetry-logs.wukong.today` had no DNS record, so every
  event from released versions went undelivered and sat only in the local
  failure queue (7 days at most).

## Where this is verified

Implementation and negative tests live in `packages/telemetry/src` and
`packages/telemetry/test/telemetry.test.ts`. Any new event or property must be
reflected on this page and must keep passing the "no sensitive content" negative
tests.
