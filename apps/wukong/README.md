# @wukong.today/code

> The Wukong Code CLI app: a local-first terminal AI coding agent — the control and verification layer for AI Coding Loops.

## Current Scope

This package owns the `wukong` executable. Current top-level commands include:

```sh
wukong
wukong -p "summarize this repo"
wukong provider
wukong acp
wukong server
wukong web
wukong verify
wukong scan
wukong guard
wukong login
wukong doctor
wukong export [sessionId]
wukong vis [sessionId]
wukong migrate
wukong upgrade
```

`verify`, `scan`, `guard`, matching TUI slash commands (`/verify`, `/scan`, `/guard`, `/report`, `/goal`), and the `wukong_verify` builtin agent tool are implemented as the local P0 commercial refactor loop. The next milestone (P0.5) adds `/loop`, `/proof`, and `/judge`. `sync`, `today`, hosted reports, billing, team rules, and deep review remain planned follow-up work.

## Development

From the monorepo root:

```sh
pnpm install
pnpm -C apps/wukong run dev:cli-only --help
pnpm -C apps/wukong run dev
pnpm --filter @wukong.today/code run typecheck
```

The package runtime engine is `>=22.19.0`; the monorepo development engine is stricter and currently requires Node.js `>=24.15.0`.

## Package Name

The published package name is `@wukong.today/code`.

The internal workspace name remains `@wukong/wukong` for historical reasons; do not use the legacy `@wukong.today/wukong-cli` name.

## Repository

- Root docs: [../../docs/README.md](../../docs/README.md)
- Commercial plan: [../../docs/business/COMMERCIAL_REFACTOR_PLAN.md](../../docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- Technical implementation plan: [../../docs/tech/commercial-refactor-implementation.md](../../docs/tech/commercial-refactor-implementation.md)
