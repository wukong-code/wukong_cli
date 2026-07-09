# Contributing to Wukong Code (Internal)

This is the internal implementation repository for Wukong Code. All contributions must be made by team members with access to this repository.

## Before You Start

Wukong Code has opinions on CLI/TUI behavior, agent workflows, and internal APIs.
If your change shifts that direction, discuss it with the team before investing
significant time.

- You should understand what you submit — what changed, how it behaves at the
  edges, and why it fits this codebase.
- We only merge changes aligned with the roadmap. Drive-by refactors without
  context are unlikely to land.
- Discuss first for new user-visible behavior, refactors larger than ~100 lines,
  public API or compatibility changes, and bug fixes where the cause or fix is
  still unclear.

## Project Layout

This is the Wukong Code pnpm monorepo. The most relevant entry points are:

- `apps/wukong` — CLI / TUI (`@wukong/wukong`)
- `apps/vis` — session replay & debugging visualizer
- `packages/node-sdk` — internal TypeScript SDK
- `packages/agent-core`, `kosong`, `kaos`, `oauth`, `telemetry` — internal engine packages
- `docs/` — internal documentation

For the full project map, see [AGENTS.md](AGENTS.md).

## Development Setup

Prerequisites: Node.js >= 24.15.0, pnpm 10.33.0, Git.

```sh
git clone https://github.com/mutnpc/wukong_cli.git
cd wukong_cli
pnpm install
```

Useful scripts:

- `pnpm dev:cli` — run the CLI in dev mode
- `pnpm test` — run tests (vitest)
- `pnpm typecheck` — TypeScript check (builds packages first)
- `pnpm lint` — oxlint
- `pnpm lint:fix` — oxlint with auto-fix
- `pnpm build` — build all packages

## Commit Convention

All commits and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/).

| Type     | Use for                                     | Example                                   |
|----------|---------------------------------------------|-------------------------------------------|
| feat     | A new feature                               | feat(agent-core): add tool dedup          |
| fix      | A bug fix                                   | fix(tui): correct status bar alignment    |
| docs     | Documentation only                          | docs: clarify install instructions        |
| chore    | Tooling / housekeeping                      | chore: bump dependencies                  |
| refactor | Internal refactor without behavior change   | refactor(kosong): extract retry helper    |
| test     | Adding or improving tests                   | test(agent-core): cover skill resolver    |
| ci       | CI / build pipeline changes                 | ci: cache pnpm store                      |
| build    | Build system / artifact changes             | build(native): add win32-arm64 target     |
| perf     | Performance improvement                     | perf(session): batch event flushes        |
| style    | Formatting only (no logic)                  | style: apply oxlint --fix                 |

Prefer the same conventional-commit style for PR titles.

## Changesets

This repo uses [changesets](https://github.com/changesets/changesets) to manage
internal versioning.

- Every PR that affects release artifacts (code, behavior, public API) should
  include a changeset.
- Docs-only, test-only, or CI-only PRs may skip changesets.
- Generate one with `pnpm changeset` and follow the prompts.
- For repo-specific conventions, see `.changeset/README.md` and the
  `gen-changesets` skill.

## Pull Requests

Use the [PR template](.github/pull_request_template.md) when opening a feature
pull request. PR titles must follow Conventional Commits; CI runs `pnpm lint`,
`pnpm typecheck`, and `pnpm test` on every PR. Update internal docs in `docs/`
when behavior changes.

## Reporting Security Issues

Found a security issue? Please see [SECURITY.md](SECURITY.md). Do not open a
public issue or share sensitive details in an unprotected channel.

## License

This is proprietary internal software. See [LICENSE](LICENSE).
