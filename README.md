# Wukong Code

[Documentation](docs/README.md) · [Roadmap](ROADMAP.md) · [中文](README.zh-CN.md)

## What Is Wukong Code

> **AI can write the code. Wukong proves whether it should ship.**

Wukong Code is a local-first terminal AI coding agent built as the **control and verification layer for AI Coding Loops**. It does not compete with Cursor / Claude Code / Codex on writing code; it answers the question they leave open: *can this AI-written code be merged?*

The local P0 loop is implemented: `wukong verify`, `wukong scan`, `wukong guard`, matching TUI slash commands (`/verify`, `/scan`, `/guard`, `/report`, `/goal`), and the `wukong_verify` builtin agent tool. Milestone 0.5 adds `/proof` (Merge Proof Report), `/judge` (evaluator-only review), `/goal --until` verification gates, and the interactive TUI `/loop`. The non-interactive `wukong loop` driver remains planned; `--dry-run` only validates its arguments. `/schedule` (cloud routine), cloud sync, billing, team rules, and deep review remain planned work. Hosted report upload is available as an early paid preview.

## Current Command Surface

```sh
wukong                         # start the interactive TUI
wukong -p "summarize this repo" # run one non-interactive prompt
wukong provider                # manage LLM providers
wukong acp                     # run as an Agent Client Protocol server
wukong server                  # run the local REST/WebSocket server
wukong web                     # open the local web UI
wukong verify                  # run deterministic checks and write an evidence report
wukong scan                    # scan git changes for delivery risks
wukong guard                   # inspect or run the best-effort command risk guard
wukong proof                   # generate a Merge Proof Report (verify + scan)
wukong judge                   # evaluator-only merge decision
wukong loop --dry-run          # validate a loop plan; execute /loop interactively in the TUI
wukong login                   # authenticate through the device-code flow
wukong doctor                  # validate configuration files
wukong export [sessionId]      # export a session ZIP
wukong vis [sessionId]         # open the session visualizer
wukong migrate                 # migrate legacy wukong-cli data
wukong upgrade                 # upgrade Wukong Code
```

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

## Commercial Refactor

The current product direction is to turn Wukong Code into the **proof layer for AI-written code** — the control and verification layer of an AI Coding Loop. The implementation plan is tracked in:

- [Roadmap](ROADMAP.md)
- [Commercial refactor plan](docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- [Technical implementation plan](docs/tech/commercial-refactor-implementation.md)

The P0 local CLI commands, TUI verification commands, `/proof`, `/judge`, `/goal --until` verification gates, interactive `/loop`, hosted report preview, and `wukong_verify` agent tool are implemented. The non-interactive `wukong loop` driver and follow-up work such as complete billing lifecycle, team rules, and deep review remain planned.

## Acknowledgments

Wukong Code builds on and learns from excellent open-source and industry projects:

- **[Kimi Code](https://github.com/MoonshotAI/kimi-code)** — Moonshot AI’s terminal AI coding agent. Wukong Code’s CLI/TUI, agent runtime, provider/ACP/server stack, and session model are built on the Kimi Code base. Thank you to the Kimi Code team for the foundation and MIT-licensed reference implementation.
- **[Pi](https://github.com/earendil-works/pi)** — Mario Zechner’s AI agent toolkit. Wukong Code’s interactive TUI is powered by [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi/tree/main/packages/tui) (differential rendering, editor, components, terminal I/O). Thank you to the Pi project for the MIT-licensed terminal UI foundation.
- **[Claude Code](https://github.com/anthropics/claude-code)** — Anthropic’s terminal AI coding agent. Wukong Code references Claude Code for TUI chrome layout (input/status chrome), loop engineering patterns, and interoperability (e.g. `/import-from-cc-codex` for instructions, Skills, and MCP settings).

Wukong Code is a separate product focused on **AI Coding Loop control and deterministic verification**; it is not affiliated with Moonshot AI, Anthropic, or the Pi project authors beyond these acknowledged dependencies.

## License

This is proprietary internal software. See [LICENSE](LICENSE).
