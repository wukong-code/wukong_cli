# Wukong Code

[Documentation](docs/README.md) · [Roadmap](ROADMAP.md) · [中文](README.zh-CN.md)

## What Is Wukong Code

> **AI can write the code. Wukong proves whether it should ship.**

Wukong Code is a local-first terminal AI coding agent built as the **control and verification layer for AI Coding Loops**. It does not compete with Cursor / Claude Code / Codex on writing code; it answers the question they leave open: *can this AI-written code be merged?*

The local P0 loop and Hosted Reports MVP are implemented: `verify`, `scan`, and `proof` can upload redacted reports, the Dashboard shows real report history, and public sharing requires explicit `--upload --public`. Interactive `/loop` and headless `wukong loop` are available; the complete billing lifecycle, GitHub PR Evidence, team rules, and deep review remain planned work.

Version `0.0.12` is Loop-first: Wukong writes, runs real project checks, asks a fresh-context reviewer, and iterates until the delivery gate passes. `verify`, `scan`, and `proof` remain available as advanced diagnostics, but they are internal Loop layers rather than separate products or quotas. Optional model aliases and lightweight Role Profiles add task-specific behavior. See the [0.0.12 design contract](docs/design/verification-loop-v2.md).

Loop returns one durable result: `PASS` (exit `0`), `NEEDS_WORK` (exit `1`), or `ERROR` (exit `2`). Guests receive one two-iteration local trial; signed-in Free users receive 10 Loop sessions per month with up to five iterations each. Internal checks never consume additional quota. Temporary quota-service failures warn and continue locally with the five-iteration safety cap. Legacy `verify-pass`, `scan-clean`, and `judge-pass` Goal records and flags remain readable and migrate to the unified proof gate; see the [compatibility matrix](docs/design/0.0.12-compatibility.md).

The experimental Role Profiles foundation is now implemented. Enable `experimental.role_profiles` in `~/.wukong/config.toml`, then run `wukong roles list`, start with `wukong --role security`, or switch the current TUI session with `/transform security` and `/transform off`.

## Current Command Surface

```sh
wukong                         # start the interactive TUI
wukong -p "summarize this repo" # run one non-interactive prompt
wukong provider                # manage LLM providers
wukong acp                     # run as an Agent Client Protocol server
wukong server                  # run the local REST/WebSocket server
wukong web                     # open the local web UI
wukong loop "ship the change"  # iterate until the independent delivery gate passes
wukong loop "fix tests" --model fast --role tester
wukong loop "fix tests" --max-iterations 5 --every 30s
wukong guard                   # inspect or run the best-effort command risk guard
wukong judge                   # evaluator-only merge decision
wukong login                   # authenticate through the device-code flow
wukong doctor                  # validate configuration files
wukong export [sessionId]      # export a session ZIP
wukong vis [sessionId]         # open the session visualizer
wukong migrate                 # migrate legacy wukong-cli data
wukong upgrade                 # upgrade Wukong Code
```

Advanced diagnostics remain directly executable for CI and debugging: `wukong verify`, `wukong scan`, and `wukong proof`. Loop runs these layers automatically, so they are intentionally omitted from the primary help surface.

Planned commands (not yet implemented): `wukong ship`, `wukong review`, `wukong schedule` (cloud routine).

Run `wukong --help` for the complete option list.

## Install From Source

This repository (`mutnpc/wukong_cli`) is the internal implementation. Public downloads use the release repository `mutnpc/wukong-code` and the one-line installer at [wukong.today](https://wukong.today). For development, use the workspace scripts:

```sh
git clone https://github.com/mutnpc/wukong_cli.git
cd wukong_cli
pnpm install
pnpm dev:cli
```

To run only the CLI entrypoint:

```sh
pnpm -C apps/wukong run dev:cli-only --help
```

The published package name is `@wukong.today/code`; do not use the legacy `@wukong.today/wukong-cli` name.

## Development

Requirements for the monorepo:

- Node.js `>=24.15.0`
- pnpm `10.33.0`

Useful commands:

```sh
pnpm dev:cli    # run the CLI in dev mode
pnpm typecheck  # TypeScript check
pnpm test       # run tests
pnpm lint       # oxlint
pnpm build      # build all packages
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the internal contribution guide.
Update checks, automatic installation, TUI announcements, and rollout status are documented in the [CLI updates and announcements contract](docs/operations/updates-and-announcements.md).

## Commercial Refactor

The current product direction is to turn Wukong Code into the **proof layer for AI-written code** — the control and verification layer of an AI Coding Loop. The implementation plan is tracked in:

- [Roadmap](ROADMAP.md)
- [Commercial refactor plan](docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- [Technical implementation plan](docs/tech/commercial-refactor-implementation.md)

The P0 local CLI commands, TUI verification commands, unified `/goal --until proof-pass` delivery gate, interactive `/loop`, headless `wukong loop`, Loop quota accounting, hosted report preview, and `wukong_verify` agent tool are implemented. Follow-up work includes the complete billing lifecycle, team rules, hosted evidence v2, and deep review.

## Acknowledgments

Wukong Code builds on and learns from excellent open-source and industry projects:

- **[Kimi Code](https://github.com/MoonshotAI/kimi-code)** — Moonshot AI’s terminal AI coding agent. Wukong Code’s CLI/TUI, agent runtime, provider/ACP/server stack, and session model are built on the Kimi Code base. Thank you to the Kimi Code team for the foundation and MIT-licensed reference implementation.
- **[Pi](https://github.com/earendil-works/pi)** — Mario Zechner’s AI agent toolkit. Wukong Code’s interactive TUI is powered by [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi/tree/main/packages/tui) (differential rendering, editor, components, terminal I/O). Thank you to the Pi project for the MIT-licensed terminal UI foundation.
- **[Claude Code](https://github.com/anthropics/claude-code)** — Anthropic’s terminal AI coding agent. Wukong Code references Claude Code for TUI chrome layout (input/status chrome), loop engineering patterns, and interoperability (e.g. `/import-from-cc-codex` for instructions, Skills, and MCP settings).

Wukong Code is a separate product focused on **AI Coding Loop control and deterministic verification**; it is not affiliated with Moonshot AI, Anthropic, or the Pi project authors beyond these acknowledged dependencies.

## License

This is proprietary internal software. See [LICENSE](LICENSE).
