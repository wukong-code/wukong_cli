# @wukong/wukong

> The Wukong CLI app: a local-first terminal AI agent built on the current Kimi-code base.

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

`verify`, `scan`, and `guard` are implemented as the local P0 commercial refactor commands. `sync`, `today`, hosted reports, deep review, and agent-tool integration remain planned follow-up work.

## Development

From the monorepo root:

```sh
pnpm install
pnpm -C apps/wukong run dev:cli-only --help
pnpm -C apps/wukong run dev
pnpm --filter @wukong/wukong run typecheck
```

The package runtime engine is `>=22.19.0`; the monorepo development engine is stricter and currently requires Node.js `>=24.15.0`.

## Package Name

The current package name is `@wukong/wukong`.

Do not document `@wukong.today/wukong-cli` or the `wukong.today/install.*` scripts unless the release pipeline is updated and verified.

## Repository

- Root docs: [../../docs/README.md](../../docs/README.md)
- Commercial plan: [../../docs/business/COMMERCIAL_REFACTOR_PLAN.md](../../docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- Technical implementation plan: [../../docs/tech/commercial-refactor-implementation.md](../../docs/tech/commercial-refactor-implementation.md)
