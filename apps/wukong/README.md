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

The published stable baseline is `v0.1.1` (2026-09-03), a reliability and
trust-boundary patch on top of 0.1.0. Version 0.1.0 is scoped to one controllable, recoverable, explainable
local Loop. Enforceable call/token limits, versioned no-check policy, file
attribution, terminal usage/next actions, compatibility fixtures, and native
release smoke are implemented. 0.1.1 adds reliability fixes and has passed six-platform assets, upgrade, and
public install verification.
Full coverage-schema
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
selection CAS, provider destination, and input exclusions without
creating a run or opening a provider connection. `verify`, `scan`, `proof`, and
`judge` remain advanced diagnostics; `/goal` is the hidden compatibility engine
behind Loop. The package remains free, local-first, and BYOK. It does not
provide hosted inference, payment, quota, cloud session/evidence sync, PR Gate,
Skill authoring, or a complete shell sandbox.

The 0.1.1 scope and release verification are documented in
[`docs/releases/0.1.1.md`](../../docs/releases/0.1.1.md). It explicitly excludes
Cost Visibility and provider charge estimates.

## Provider Catalog Availability

Provider discovery first reads the models.dev-compatible catalog configured by
`WUKONG_CODE_CATALOG_URL` (default:
`https://modelpricelab.com/api.json`). If that source is unavailable, Wukong
tries `https://models.dev/api.json`. The source contains a final snapshot path,
but the official v0.0.22 native archives omitted the snapshot because of a
release-profile defect. Do not promise offline provider discovery for that
published binary. Release workflows since 0.1.0 embed the snapshot and ZIP-smoke
provider discovery; the published 0.1.1 macOS ARM64 binary was confirmed to
contain it on 2026-10-02. This does not repair the already published v0.0.22
asset.

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

The monorepo workspace uses the same `@wukong.today/code` name. Do not use the
historical `@wukong/wukong` or legacy `@wukong.today/wukong-cli` names in new
commands or documentation.

## Repository

- Root docs: [../../docs/README.md](../../docs/README.md)
- Technical implementation plan: [../../docs/tech/commercial-refactor-implementation.md](../../docs/tech/commercial-refactor-implementation.md)

## Acknowledgments

Wukong Code builds on and learns from many open projects — see
[Acknowledgments](../../README.md#acknowledgments) in the root README.
