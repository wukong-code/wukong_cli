# Wukong Code

[Documentation](docs/README.md) · [中文](README.zh-CN.md) · [Download](https://wukong.today/download)

> **Give Wukong a goal. It loops until the change is ready.**

Wukong Code is a terminal AI coding agent built around one workflow:
**Goal → Write → Check → Review → Fix**.

Give `/loop` a goal. Wukong works on the change, runs the repository's real
checks, reviews the result from a fresh read-only context, and fixes blocking
findings against the same goal.

## Current release: v0.0.22

`v0.0.22` is the published binary. This source checkout may also contain
unreleased `0.1.0` stabilization work. The user-flow notes below describe the
development checkout; they do not mean that `0.1.0-rc.1` has been published.

The source package identity is now `0.1.0-rc.1` for candidate verification.
The stable `latest` installer must remain on `v0.0.22` until the immutable
public prerelease, six-platform smoke, and release-channel checks complete. Use the
fixed-version instructions in the RC notes only after its public release URL
is available.

The 0.1.0 target is deliberately narrow: one controllable, recoverable, and
explainable local Loop. The development checkout now implements enforceable
provider-call/token limits, a versioned no-check decision,
pre-existing-versus-Wukong file attribution, terminal usage/next actions, and
automated compatibility/release smoke coverage. This is implementation
evidence, not an RC or release: six-platform candidate CI, public-asset
verification, the opt-in cohort, and the 14-day stability window remain open.
Full multi-layer coverage schemas, direct-shell content/PATH attestation, and a
provider pricing database are deferred rather than release blockers.

Version `0.0.22` keeps provider setup usable when the primary remote catalog is down and
clarifies the CLI's session and permission controls:

- provider discovery falls back from the maintained catalog to models.dev when
  the primary service is unavailable;
- the source includes a final offline snapshot path, but the published 0.0.22
  native archives omitted that snapshot because of a release-profile defect;
- `-r, --resume` is the canonical CLI session-resume option;
- help distinguishes guarded Auto, YOLO, Plan, headless `--yes`, and added
  workspace access.

See the [v0.0.22 release notes](docs/releases/0.0.22.md).

## What Wukong does

- **Loop until ready** — keep one goal and Finish Line fixed across write,
  check, review, and fix iterations.
- **Run real checks** — use the repository's available tests, type checks,
  lint, build, and project review policy.
- **Review complete evidence** — pass bounded, secret-filtered evidence to an
  independent reviewer without losing distinct findings.
- **Reuse verification criteria** — explicitly select ordered qualitative
  criteria discovered from trusted local Skills.
- **Resume unfinished work** — continue local Wukong, Codex, Claude Code,
  Cursor, Kimi Code, or Grok sessions as read-only imported context.
- **Return clear outcomes** — a completed Gate ends as `PASS`, `NEEDS_WORK`,
  or `ERROR`; `/loop stop` and a headless process interruption without a Gate
  verdict are reported separately as `STOPPED_BY_USER`.
- **Use your model provider** — configure the API key and model you want with
  `wukong provider`.

## Install

Public native downloads are distributed from
[`mutnpc/wukong-code`](https://github.com/mutnpc/wukong-code).

```sh
curl -fsSL https://wukong.today/install.sh | sh
wukong --version
```

Upgrade an existing native installation:

```sh
wukong upgrade
```

## Quick start

```sh
wukong provider
wukong
```

Inside the TUI:

```text
/loop add input validation to the signup form
```

For headless use, preview first and add the exact check, Gate, workspace, and
review authorization flags printed by the dry-run. Missing decisions fail
closed instead of silently starting:

```sh
wukong loop "add input validation to the signup form" --dry-run
# Review “Headless start flags”, then rerun the same command with those flags.
```

### From input to disposition

Before a Loop starts, one editable TUI Preflight summary shows the exact Goal,
Done when, Must not rules, selected project checks or versioned no-check
decision, Writer/Reviewer, sanitized Provider origin, pre-existing Git changes,
permission mode, outbound input limits, approval order, result handling,
iteration limit, provider-call ceilings, and optional token budget.
Headless dry-run prints the same runtime facts and the exact flags needed to
start. Security decisions remain separate approvals for local read, provider
transmission, permission, and project-check execution. When there are risks,
the default is to edit, inspect, or cancel; dangerous Continue is last.
Cancellation creates no run and makes no provider call. A versioned no-check
decision may cover eligible documentation/configuration work, but source
changes without required checks fail closed as `NEEDS_WORK/checks_missing`.

During execution, watch the current writer iteration, elapsed time, active tool
or activity, calls/tokens/retries/remaining budget, and any real provider,
permission, or check blocker. TUI
`WRITE`/`CHECK`/`REVIEW` labels are activity hints; headless output currently
reports writer iterations and running tools, and an internal reviewer is not
always exposed as a distinct `REVIEW` phase. Model prose saying “done” is not a
verified result.

At the end, act on the deterministic terminal summary. It separates decisive
evidence, pre-existing changes, files introduced/modified/deleted by the Loop,
unknown attribution, checks, calls/tokens/retries/remaining budget, the primary
blocker, and the safe Next action:

- `PASS`: checks and the read-only reviewer passed. Inspect `git status --short`,
  `git diff`, and `/loop status` or the review feedback for non-blocking
  findings, then commit, push, or deliver through your own workflow.
- `NEEDS_WORK`: read the primary blocker and Next action, then continue the Loop
  or revise its Finish Line.
- `ERROR`: provider, check, or local state did not produce a trustworthy result.
  Repair the run conditions before retrying; this is neither code failure nor
  `PASS`. If `provider_outcome_unknown` is present, first reconcile the request
  ID/idempotency key with provider logs or billing and do not resume or retry
  blindly.
- `PAUSED`: TUI Ctrl-C or `/loop pause` parks the same Loop without a Gate
  verdict. Workspace changes remain and `/loop resume` can continue it.
- `STOPPED_BY_USER`: `/loop stop` or a headless process interruption stopped
  the run without a Gate verdict. Inspect retained changes. `/loop stop`
  discards the contract; a headless summary offers resume only when the
  provider outcome is known.

Cancelling at preflight creates no run. Auto permission denial inside a Loop is
`NEEDS_WORK/permission_required`, not `STOPPED_BY_USER`. For automation, only a
final durable `loop.result` outcome is a Gate verdict; a successful dry-run or
another command exiting `0` is not `PASS`.

Wukong never commits, pushes, or publishes merely because a Loop returns `PASS`.

Resume local work from another coding agent:

```text
/resume codex
/resume claude
/resume cursor
/resume kimi
/resume grok
```

## Primary commands

| Command | Description |
|---|---|
| `wukong` | Launch the interactive TUI |
| `wukong -p <prompt>` | Run one non-interactive prompt; `COMPLETED` is not Loop `PASS` |
| `wukong provider` | Configure model providers and models |
| `wukong loop <goal>` | Run write → check → review → fix against one goal |
| `wukong review init` | Create `.wukong/review-policy.md` |
| `wukong guard` | Inspect the command risk guard |
| `wukong login` | Connect an optional Wukong account |
| `wukong logout` | Revoke the account session and remove local credentials |
| `wukong doctor` | Validate local configuration |
| `wukong upgrade` | Upgrade a native installation |

Run `wukong --help` for the complete command and option list.

`wukong logout` first attempts to revoke the stored refresh token at the
account's configured OAuth host, then always proceeds with local token and
managed-config cleanup. A confirmed response reports that the remote session
was revoked. If the network, rate limit, or server leaves revocation unknown,
the command still clears local credentials and warns that the server session
may remain active, with `https://wukong.today/contact` as the next step for
immediate invalidation. Repeating logout with no token is safe and idempotent.
If local cleanup itself cannot finish, the command reports an error instead of
claiming a successful logout.

## Local data and privacy

Loop contracts, run state, evidence, findings, and imported session context stay
on the local machine. `/feedback` sends only the text fields shown for
confirmation. Model requests use the provider configured by the user.

## Development

Requirements:

- Node.js `>=24.15.0`
- pnpm `10.33.0`

```sh
git clone https://github.com/mutnpc/wukong_cli.git
cd wukong_cli
pnpm install
pnpm dev:cli
```

Useful checks:

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository conventions.

## Acknowledgments

Wukong Code builds on and learns from:

- [Kimi Code](https://github.com/MoonshotAI/kimi-code)
- [Pi](https://github.com/earendil-works/pi)
- [Claude Code](https://github.com/anthropics/claude-code)

Wukong Code is an independent product focused on AI coding Loop control and
deterministic verification.

## License

This is proprietary internal software. See [LICENSE](LICENSE).
