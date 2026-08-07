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
wukong loop "ship the change" --dry-run
wukong login
wukong logout
wukong doctor
wukong export [sessionId]
wukong vis [sessionId]
wukong migrate
wukong upgrade
```

`wukong logout` attempts remote refresh-token revocation before removing the
local credential slot and managed account config. Local cleanup still runs
when revocation is unconfirmed; the command warns that the server session may
remain active instead of reporting a false remote success.

The published binary baseline is `v0.0.22`; this package checkout may contain
unreleased `0.1.0` stabilization and is not evidence that `0.1.0-rc.1` has
shipped. Version 0.1.0 is scoped to one controllable, recoverable, explainable
local Loop. Enforceable call/token limits, versioned no-check policy, file
attribution, terminal usage/next actions, compatibility fixtures, and native
release smoke are implemented and covered locally. RC still requires a current
six-platform candidate run and zero release-blocking defects; final release
also requires public-asset and opt-in cohort evidence. Full coverage-schema
replacement and direct-shell content/PATH attestation are deferred. The normal interactive path starts from an editable Goal or an
optional `/resume`, then enters `/loop` and Gate. Version 0.0.21 preserves every
distinct built-in risk occurrence under a stable evidence identity when the
same risk kind appears at different files, lines, or evidence locations. Exact
duplicate input remains deduplicated. In 0.0.20 every new
reviewer attempt reads only a bounded local broker and requires separate local
read trust plus per-run consent for the exact BYOK provider endpoint. Existing
Verification Skills may contribute strict qualitative criteria, but suggestions
are never selected automatically and Skill commands are never executed.
`wukong loop --dry-run --output-format stream-json` previews the exact catalog,
selection CAS, provider destination, input exclusions, and cost without
creating a run or opening a provider connection. `verify`, `scan`, `proof`, and
`judge` remain advanced diagnostics; `/goal` is the hidden compatibility engine
behind Loop. The package remains free, local-first, and BYOK. It does not
provide hosted inference, payment, quota, cloud session/evidence sync, PR Gate,
Skill authoring, or a complete shell sandbox.

## Provider Catalog Availability

Provider discovery first reads the models.dev-compatible catalog configured by
`WUKONG_CODE_CATALOG_URL` (default:
`https://modelpricelab.com/api.json`). If that source is unavailable, Wukong
tries `https://models.dev/api.json`. The source contains a final snapshot path,
but the official v0.0.22 native archives omitted the snapshot because of a
release-profile defect. Do not promise offline provider discovery for that
published binary. The unreleased 0.1.0 release workflow now embeds the snapshot
and ZIP-smokes provider discovery; the current macOS ARM64 release-profile ZIP
passed that deterministic smoke locally. This still requires six-platform
candidate CI before RC and does not repair the already published v0.0.22 asset.

Passing `--url` to `wukong provider catalog list` or
`wukong provider catalog add` disables fallback so custom catalogs fail
explicitly.

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
