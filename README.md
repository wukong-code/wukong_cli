# Wukong Code

[Documentation](docs/README.md) · [Roadmap](ROADMAP.md) · [中文](README.zh-CN.md)

## What Is Wukong Code

> **Give Wukong a goal. It loops until the change is ready.**

Wukong Code is a terminal AI coding agent built around one primary workflow: **Goal → Write → Check → Review → Fix**. Give `/loop` a goal and Wukong keeps working until an independent reviewer has no blocking findings or the iteration limit is reached.

Version `0.0.13` added structured multi-finding reviews, project-specific rules in `.wukong/review-policy.md`, local finding feedback and diagnostics, plus an optional independent reviewer model. The current product remains Free and bring-your-own-key, with no paid plan or entitlement.

Version `0.0.14` adds Cross-Agent Resume, an explicit Resume → Loop handoff, clearer TUI Gate results, and broader real-project check discovery. It remains free and BYOK; see the [0.0.14 design](docs/design/0.0.14-resume-loop-polish.md).

Version `0.0.15` made that Loop reliable across restarts with durable local run
records, active-Loop recovery, preflight, and a shorter first-run surface.
Version `0.0.17` removes the remote Loop allowance and completion outbox while
keeping local recovery. It remains free and BYOK; see the
[0.0.15 design](docs/design/0.0.15-loop-reliability.md).

Version `0.0.16` freezes an acceptance contract for each Loop, carries prior blockers across reviews,
detects repeated no-progress cycles, invokes one read-only strategist when the
same blocker persists, and falls back safely when an explicit reviewer model is
unavailable. It also introduces Permission Mode v2: Auto becomes autonomous but
guarded by workspace, risk, and capability boundaries; YOLO is an explicit
dangerous approval bypass that still cannot expand read-only reviewer or
strategist capabilities. Bounded Resume suggestions, Role contracts, a compact
background-task count, and local session-content search are included without adding
payment or managed model credits. See the
[0.0.16 design](docs/design/0.0.16-loop-convergence.md).

Version `0.0.17` is the next planned patch. It removes misleading role/report aliases,
keeps `/transform list|status|off` discoverable, prevents unknown or disabled slash
commands from reaching the model, and makes permission, Loop, export, Today, and
roles argument handling strict and regression-tested. It also makes `/resume` canonical,
keeps `/login` account-only, moves model-key setup to `/provider`, and migrates local
Loop records to content-free lifecycle v2. It remains free and BYOK;
the public package and download version stay at `0.0.16` until the release gates
pass. See the [0.0.17 design](docs/design/0.0.17-command-surface-reliability.md).

An older `0.1.0` document explored a Pro PR Gate experiment. It is not a current commitment: there is no paid plan, Checkout, or active entitlement work. Any commercial scope requires a new decision after real Free-user validation.

Version `0.0.12` established the Loop-first runtime. `verify`, `scan`, and `proof` remain available as advanced diagnostics, but they are internal Loop layers rather than separate products or quotas. See the [0.0.12 design contract](docs/design/verification-loop-v2.md) and the [0.0.13 review design](docs/design/review-learning-loop.md).

Loop returns one durable result: `PASS` (exit `0`), `NEEDS_WORK` (exit `1`), or `ERROR` (exit `2`). Every user can run BYOK Loops locally without a login, Guest trial, monthly allowance, or Wukong quota-service request. The default local limit is 10 iterations and can be changed with `--max-iterations`; reviewer step/time limits and `/loop stop` remain hard safety controls. Anonymous product metrics continue to respect `WUKONG_TELEMETRY=0` and never decide whether a Loop may run. Legacy `verify-pass`, `scan-clean`, and `judge-pass` Goal records and flags remain readable and migrate to the unified proof gate; see the [compatibility matrix](docs/design/0.0.12-compatibility.md).

The experimental Role Profiles foundation is now implemented. Enable `experimental.role_profiles` in `~/.wukong/config.toml`, use `wukong roles list/show/init` to manage profiles, and inspect or switch the current TUI session with `/transform list|status|off` or `/transform <role>`.

Inside the TUI, `/resume` opens Wukong sessions. Use `/resume codex`, `/resume claude`, or `/resume cursor` to continue a local session from another agent. Foreign history is imported into Wukong as read-only context; old tool calls are never replayed and the current workspace is checked again before work continues.

Anonymous installer and CLI product telemetry is limited to install, first-run,
Device Login outcome, and Loop lifecycle events; it excludes source, prompts, transcripts, repository
names, and file paths. Set `WUKONG_TELEMETRY=0` to opt out without changing local
Loop behavior.

## Current Command Surface

```sh
wukong                         # start the interactive TUI
wukong -p "summarize this repo" # run one non-interactive prompt
wukong provider                # configure BYOK model providers and API keys
wukong acp                     # run as an Agent Client Protocol server
wukong server                  # run the local REST/WebSocket server
wukong web                     # open the local web UI
wukong loop "ship the change"  # iterate until the independent delivery gate passes
wukong loop "fix tests" --model fast --review-model slow
wukong loop "fix tests" --review-model reviewer
wukong loop "fix tests" --max-iterations 5 --every 1m
wukong review init             # create .wukong/review-policy.md
wukong review feedback <finding-id> accept
wukong review stats            # show local feedback counts
wukong guard                   # inspect or run the best-effort command risk guard
wukong judge                   # evaluator-only merge decision
wukong login                   # connect an optional Wukong account; does not configure a model
wukong doctor                  # validate configuration files
wukong export [sessionId]      # export a session ZIP
wukong vis [sessionId]         # open the session visualizer
wukong migrate                 # migrate legacy wukong-cli data
wukong upgrade                 # upgrade Wukong Code
```

Advanced diagnostics remain directly executable for CI and debugging: `wukong verify`, `wukong scan`, and `wukong proof`. Loop runs these layers automatically, so they are intentionally omitted from the primary help surface.

Unimplemented historical candidates, not current commitments: `wukong account`, `wukong pr gate`, `wukong ship`, and `wukong schedule`.

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

## Historical Product Candidates

These documents contain earlier product hypotheses. They do not override the current Free + BYOK boundary:

- [Roadmap](ROADMAP.md)
- [Commercial refactor plan](docs/business/COMMERCIAL_REFACTOR_PLAN.md)
- [Technical implementation plan](docs/tech/commercial-refactor-implementation.md)

Version `0.0.13` ships the first Review Learning Loop: structured findings, project review policy, local feedback, reviewer diagnostics, and a reviewer-model override. Real-repository E2E coverage, release copy, the Web preview announcement, and separated registered/activated Loop metrics are included.

## Acknowledgments

Wukong Code builds on and learns from excellent open-source and industry projects:

- **[Kimi Code](https://github.com/MoonshotAI/kimi-code)** — Moonshot AI’s terminal AI coding agent. Wukong Code’s CLI/TUI, agent runtime, provider/ACP/server stack, and session model are built on the Kimi Code base. Thank you to the Kimi Code team for the foundation and MIT-licensed reference implementation.
- **[Pi](https://github.com/earendil-works/pi)** — Mario Zechner’s AI agent toolkit. Wukong Code’s interactive TUI is powered by [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi/tree/main/packages/tui) (differential rendering, editor, components, terminal I/O). Thank you to the Pi project for the MIT-licensed terminal UI foundation.
- **[Claude Code](https://github.com/anthropics/claude-code)** — Anthropic’s terminal AI coding agent. Wukong Code references Claude Code for TUI chrome layout (input/status chrome), loop engineering patterns, and interoperability (e.g. `/import-from-cc-codex` for instructions, Skills, and MCP settings).

Wukong Code is a separate product focused on **AI Coding Loop control and deterministic verification**; it is not affiliated with Moonshot AI, Anthropic, or the Pi project authors beyond these acknowledged dependencies.

## License

This is proprietary internal software. See [LICENSE](LICENSE).
