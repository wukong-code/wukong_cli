# CLI Telemetry Contract

> Status: an audit of the current source. It describes the existing optional
> CLI telemetry — not a 0.1.0 cohort, billing, eligibility, or a new metrics
> backend. The installer creates no telemetry identity and sends no events.

## Opt-out and endpoint

The CLI sends a minimal usage signal to exactly one endpoint:

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
OS device ID.

Since 2026-10-28 the client uploads **one minimal signal per batch** and nothing
else. Each batch collapses to a single record with exactly:

- `event`: the fixed name `kfc_signal`;
- `timestamp`: Unix seconds of the most recent activity in the batch;
- `context_version`: the CLI version;
- `context_platform`: the OS platform;
- `context_arch`: the CPU architecture (each possibly `null`).

Event names, tools, commands, durations, `property_*` values, `event_id`,
`device_id`, and `session_id` are never uploaded. Internal `track()` call sites
still exist in the source, but the transport minimizes every outbound batch —
including retries of the local failure queue — before anything leaves the
device. Older released clients still send their previously documented full
event payloads; the receiver accepts them and discards everything beyond the
minimal fields (see retention below).

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
