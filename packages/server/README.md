# @wukong/server

Local REST + WebSocket server that exposes the Wukong SDK over a stable wire
protocol. It hosts `agent-core` sessions and serves them under a single
`/api/v1` prefix. This package is **private** — it is not published on its own;
it ships inside the `wukong` CLI (`apps/wukong`) and is launched via
`wukong server run`.

## What it does

- Hosts `agent-core` sessions, prompts, tools, approvals, questions, and
  workspaces in process.
- Exposes them over **REST** (Fastify) and **WebSocket** (`ws`) under `/api/v1`.
- Serves the built-in web UI (`apps/wukong-web`) as static assets when a
  `webAssetsDir` is provided.
- Publishes machine-readable contract docs: `/openapi.json`, `/asyncapi.json`.

## Running it

```bash
# From the repo root — dev server with auto-restart
pnpm dev:server
pnpm dev:server:restart

# Checks
pnpm --filter @wukong/server typecheck   # tsc --noEmit
pnpm --filter @wukong/server test        # vitest run
pnpm --filter @wukong/server build       # tsdown
```

The public entry point is `startServer(opts)` in `src/start.ts`, which returns a
`RunningServer`. In production the CLI command `wukong server run`
(`apps/wukong/src/cli/sub/server/run.ts`) imports and calls it. This package
has no `dev` script of its own — always start it from the repo root or via the
CLI.

By default the server listens on `127.0.0.1:58627`; e2e clients target it with
`WUKONG_SERVER_URL` (default `http://127.0.0.1:58627`).

## Architecture

```
apps/wukong (CLI)            apps/wukong-web (browser)
        │                              │
        └──────────┬───────────────────┘
                   │  REST + WebSocket, /api/v1
        ┌──────────▼───────────┐
        │  @wukong/server │
        │  Fastify REST        │
        │  ws gateway          │
        │  DI container        │  ← @wukong/agent-core
        │  agent-core sessions │  ← @wukong/agent-core
        └──────────────────────┘
```

- **REST** (`src/routes/`): domain modules aggregated by
  `registerApiV1Routes.ts`. Routes are declared with `middleware/defineRoute.ts`,
  which bundles Zod validators with the OpenAPI response schema.
- **WebSocket** (`src/ws/`, `src/services/gateway/`): per-session `seq`,
  `server_hello` / `ack` / `event` / `resync_required` frames, replay and
  fan-out.
- **DI** (`src/services/serviceCollection.ts`): seeds the container from
  `@wukong/agent-core` (`getSingletonServiceDescriptors()`) and layers in
  server-owned gateways plus `IApprovalService` / `IQuestionService`
  implementations.
- **OS service managers** (`src/svc/`): launchd / systemd / schtasks backends
  for `wukong server install/start`.

## Wire protocol notes

- **Envelope:** every REST response is `{ code, msg, data, request_id }` and the
  HTTP status is effectively always 200 — check `code` (0 = ok), not the status.
- **`:action` endpoints:** some routes use an `:id:action` suffix (e.g.
  `/sessions/{id}:undo`); the suffix is parsed by `routes/action-suffix.ts`.
- **Single-instance lock:** a running server acquires a lock; a second start on
  the same home throws `ServerLockedError`. Tests pass a unique `lockPath` /
  `port`.

## Related packages

- `@wukong/agent-core` — the agent engine the server hosts, including the
  in-process DI service layer it wires together.
- `@wukong/protocol` — wire types and the AsyncAPI document.
- `@wukong/node-sdk` — typed in-process facade for user code
  (`WukongHarness`, `Session`); prefer it over hand-rolling REST/WS calls.
- `@wukong/server-e2e` — wire-level e2e client and scenarios against a
  running server.

## Development

For conventions, gotchas, and the boot wiring order, see
[`packages/server/AGENTS.md`](./AGENTS.md). For the service naming and
registration rules, see
[`packages/services/AGENTS.md`](../services/AGENTS.md).
