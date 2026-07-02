# Wukong CLI

[Documentation](docs/README.md) · [中文](README.zh-CN.md)

## What Is Wukong CLI

Wukong CLI is a local-first terminal AI agent based on the current Kimi-code base. It provides an interactive TUI, prompt mode, provider management, ACP integration, a local web/server mode, session export, migration, diagnostics, and visualization.

The commercial verification direction now has a local P0 command-line loop: `wukong verify`, `wukong scan`, and `wukong guard`. Cloud sync, hosted reports, deep review, and agent-tool integration remain planned work.

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
wukong login                   # authenticate through the device-code flow
wukong doctor                  # validate configuration files
wukong export [sessionId]      # export a session ZIP
wukong vis [sessionId]         # open the session visualizer
wukong migrate                 # migrate legacy wukong-cli data
wukong upgrade                 # upgrade Wukong
```

Run `wukong --help` for the complete option list.

## Install From Source

This repository does not currently ship a verified `install.sh`, Homebrew formula, or published package documentation. Use the workspace scripts while developing:

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

Package metadata currently uses `@wukong/wukong`; do not use the legacy `@wukong.today/wukong-cli` name unless a future release explicitly reintroduces it.

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

The current product direction is to turn Wukong into a verification and delivery-evidence tool for AI-generated code. The implementation plan is tracked in:

- [Commercial refactor plan](docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- [Technical implementation plan](docs/tech/commercial-refactor-implementation.md)

The P0 local CLI commands are implemented. The remaining docs track follow-up work such as `wukong_verify`, cloud reports, team rules, and deep review.

## License

This is proprietary internal software. See [LICENSE](LICENSE).
