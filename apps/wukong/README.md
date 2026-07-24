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
wukong proof
wukong judge
wukong loop "ship the change"
wukong login
wukong doctor
wukong export [sessionId]
wukong vis [sessionId]
wukong migrate
wukong upgrade
```

The normal interactive path is `/resume` → `/loop` → Gate. In 0.0.19 every
new Loop first confirms an explicit Finish Line and freezes exact project-check
provenance, workspace trust, and Gate approval. `wukong loop --dry-run` previews
the same contract without creating local state. `verify`, `scan`, `proof`,
`judge`, and their TUI equivalents remain advanced local diagnostics; `/goal`
is the hidden compatibility execution engine behind Loop. The package remains
free, local-first, and BYOK. It does not provide hosted inference, payment,
quota, cloud session/evidence sync, PR Gate, or a complete shell sandbox.

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

## Acknowledgments

Wukong Code builds on **[Kimi Code](https://github.com/MoonshotAI/kimi-code)** (CLI/TUI/agent base), **[Pi](https://github.com/earendil-works/pi)** (`@earendil-works/pi-tui` for the interactive TUI), and references **[Claude Code](https://github.com/anthropics/claude-code)** (TUI chrome and loop patterns). See the [root README](../../README.md#acknowledgments) for details.
