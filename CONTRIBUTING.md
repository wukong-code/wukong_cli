# Contributing to Wukong Code

Wukong Code is an open-source local CLI under the MIT License. Contributions to the
CLI, its local server/Web UI, packages, tests, and documentation are welcome.
The website and operations backend live in a separate private repository and are
outside this contribution guide.

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
- Follow [AGENTS.md](AGENTS.md) and the nearest directory guide for coding and
  testing rules. `CLAUDE.md` imports the same instructions.

## Project Layout

This is the Wukong Code pnpm monorepo. The most relevant entry points are:

- `apps/wukong` — CLI / TUI (`@wukong.today/code`)
- `apps/vis` — session replay & debugging visualizer
- `packages/node-sdk` — TypeScript SDK
- `packages/agent-core`, `kosong`, `kaos`, `oauth`, `telemetry` — engine packages
- `docs/` — project documentation

For the full project map, see [AGENTS.md](AGENTS.md).

## Development Setup

Prerequisites: Node.js >= 24.15.0, pnpm 10.33.0, Git.

```sh
git clone https://github.com/wukong-code/wukong_cli.git
cd wukong_cli
pnpm install
```

Useful scripts:

- `pnpm dev:cli` — run the CLI in dev mode
- `pnpm test:related -- <source-path>` — scoped tests for day-to-day changes
- `pnpm test` — full Vitest suite for CI or changes that justify a full local run
- `pnpm typecheck` — TypeScript check (builds packages first)
- `pnpm lint` — oxlint plus the agent-core module boundary guard
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
release versioning.

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

Describe the before/after behavior and relevant error paths. Record checks run,
failures and material checks not run against the reviewed revision; distinguish
local verification from live-provider, platform and release evidence.
For release workflow changes, preserve exact-source, six-platform, immutable-asset
and no-rebuild contracts, and keep publishing credentials away from untrusted PR code.

## Reporting Security Issues

Found a security issue? Please see [SECURITY.md](SECURITY.md). Do not open a
public issue or share sensitive details in an unprotected channel.

## License

This project is open source under the [MIT License](LICENSE). By contributing
you agree that your contributions will be licensed under the MIT License.
