# Wukong Code

> **Your AI coding agent says it's done. Wukong makes it prove it.**

**Free · MIT · Bring your own API key · macOS / Linux / Windows**

Current release: **[v0.1.2](https://github.com/wukong-code/wukong-code/releases/tag/v0.1.2)** — the open-source edition.

```sh
curl -fsSL https://wukong.today/install.sh | sh
wukong provider   # add your own model API key
wukong            # then type: /loop add input validation to the signup form
```

Give Wukong a goal. It writes the change, runs your project's own tests, type
checks, lint, and build, reviews the result from a fresh read-only context, and
fixes what fails. Within the limits you approve, it loops until the checks pass
— or stops and tells you exactly what is blocking. A model saying "done" is
never enough: only fresh check results plus an independent review produce
`PASS`.

## Why Wukong

- **"Done" means the checks passed.** A Loop ends in `PASS` only when your
  repo's checks ran fresh and a separate review found nothing blocking.
  Otherwise you get `NEEDS_WORK` with the reason, or `ERROR`. Never a silent
  "looks good".
- **You set the limits first.** Before the first edit, one editable Preflight
  shows the goal, the checks, the Writer/Reviewer, and the call/token budget.
  If progress stalls, Wukong stops and explains instead of burning your key.
- **Pick up where another agent stopped.** Codex, Claude Code, Cursor, Kimi
  Code, or Grok ran out mid-task? `/resume codex` (or `claude`, `cursor`,
  `kimi`, `grok`) imports that session as read-only context and continues
  against your repo as it is now.
- **Your key, your provider.** Code, run state, and evidence stay on your
  machine. Model requests go only to the provider you configure — no Wukong
  hosted model, no account required.
- **Wukong never ships on its own.** Even after `PASS`, Wukong never commits,
  pushes, or publishes. You inspect the diff and deliver through your own
  workflow.

## Quick start

```sh
wukong provider   # configure a model provider and API key
wukong            # start the TUI
```

Inside the TUI:

```text
/loop add input validation to the signup form
```

Wukong shows a Preflight summary — the Goal, Done-when and Must-not rules, the
exact checks, permission mode, pre-existing Git changes, and the iteration,
provider-call, and token ceilings. Everything is editable before anything runs;
cancelling creates no run and makes no provider call.

For headless use, preview first and add the exact authorization flags printed
by the dry-run. Missing decisions fail closed instead of silently starting:

```sh
wukong loop "add input validation to the signup form" --dry-run
# Review “Headless start flags”, then rerun the same command with those flags.
```

## The Loop

Every Loop works one user-owned goal:

```
Goal → Write → Check → Review → Fix → (repeat) → Gate
```

1. **Write** the change.
2. **Check** with the repository's own tests, type checks, lint, build, and
   project review policy.
3. **Review** from a fresh read-only context, with bounded, secret-filtered
   evidence.
4. **Fix** blocking findings against the same goal.
5. **Gate** — a deterministic terminal verdict:

| Outcome | Meaning | Exit code |
|---|---|---|
| `PASS` | Fresh checks and the independent reviewer both passed | `0` |
| `NEEDS_WORK` | A named blocker remains; read the Next action and continue | `1` |
| `ERROR` | Provider, check, or local state cannot produce a trustworthy result | `2` |
| `PAUSED` | TUI Ctrl-C or `/loop pause`; resumable, no Gate verdict | — |
| `STOPPED_BY_USER` | `/loop stop` or a headless interruption; no Gate verdict | — |

Only a final durable `loop.result` maps to a Gate verdict. A successful
dry-run, a plain `wukong -p` prompt, or another command exiting `0` is **not**
`PASS`. Source changes without the required checks fail closed as
`NEEDS_WORK/checks_missing`; an eligible versioned no-check decision for
documentation/configuration work stays explicit and auditable.

Resume unfinished work — yours or another agent's:

```text
/resume          # local Wukong sessions
/resume codex    # also: claude, cursor, kimi, grok
```

Imported history is read-only context; Wukong re-checks the current workspace
before continuing.

## Primary commands

| Command | Description |
|---|---|
| `wukong` | Launch the interactive TUI |
| `wukong -p <prompt>` | Run one non-interactive prompt; ordinary success is not a Loop `PASS` |
| `wukong provider` | Configure model providers and models |
| `wukong loop <goal>` | Run write → check → review → fix against one goal |
| `wukong review init` | Create `.wukong/review-policy.md` |
| `wukong guard` | Inspect the command risk guard |
| `wukong web` | Open the local Web UI (loopback-only daemon) |
| `wukong login` / `wukong logout` | Optional Wukong account session |
| `wukong doctor` | Validate local configuration |
| `wukong upgrade` | Upgrade a native installation |

Run `wukong --help` for the complete command and option list.

## Local data and privacy

Loop contracts, run state, evidence, findings, and imported session context
stay on the local machine. `/feedback` sends only the text fields shown for
confirmation. Model requests use the provider configured by the user.

## Repository layout

This monorepo holds the complete local CLI product:

| Path | Contents |
|---|---|
| `apps/wukong` | The `wukong` CLI/TUI (`@wukong.today/code`) |
| `apps/wukong-web` | Local Web UI served by the on-machine daemon |
| `apps/vis` | Visualization tooling |
| `packages/agent-core` | Loop engine, Gate evidence rules, tools, review |
| `packages/kosong` | Provider/model chat layer |
| `packages/protocol` | Wire protocol shared by CLI, server, and Web |
| `packages/server` | Local daemon behind `wukong web` |
| `packages/oauth`, `telemetry`, `node-sdk`, `acp-adapter`, … | Auth opt-in, opt-in telemetry, SDK, Agent Client Protocol, and support packages |
| `docs/` | Release notes, design docs, and the user guide |

## Development

Requirements: Node.js `>=24.15.0`, pnpm `10.33.0`.

```sh
git clone https://github.com/wukong-code/wukong_cli.git
cd wukong_cli
pnpm install
pnpm dev:cli
```

```sh
pnpm typecheck   # build packages + typecheck everything
pnpm test        # vitest across the workspace
pnpm lint        # oxlint + boundary checks
pnpm build       # build all packages and apps
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository conventions,
[ROADMAP.md](ROADMAP.md) for direction, and [docs/](docs/) for design notes
and release history.

## Documentation

- Website: [wukong.today](https://wukong.today)
- Docs: [docs.wukong.today](https://docs.wukong.today) — getting started,
  command reference, configuration
- Downloads: [wukong.today/download](https://wukong.today/download)
- Releases: [wukong-code/wukong-code](https://github.com/wukong-code/wukong-code/releases)

## Acknowledgments

Wukong Code builds on and learns from:

- [Kimi Code](https://github.com/MoonshotAI/kimi-code)
- [Pi](https://github.com/earendil-works/pi)
- [Claude Code](https://github.com/anthropics/claude-code)

Wukong Code is an independent product focused on AI coding Loop control and
deterministic verification.

## License

[MIT](LICENSE) — open source as of v0.1.2. The website and operations backend
are private and not part of this repository.
