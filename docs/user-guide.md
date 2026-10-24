# Wukong Code User Guide

> Scope: the current `wukong_cli`; stable binary is `v0.1.2`.
> Updated: 2026-10-24.
> Idea: give Wukong a goal and let it loop through Goal → Write → Check → Review → Fix until no blocking finding remains.
> Version boundary: `0.1.2` keeps the free, local-first, BYOK Trusted Local Loop and publishes the CLI source under MIT. Full multi-layer coverage schema, direct-shell content/PATH attestation, and a price database remain deferred. There is no paid plan, subscription entitlement, team policy, or PR-gate commitment.

See the [0.1.2 release notes](releases/0.1.2.md) for features, the local Web stub,
verification evidence, and the release integrity contract.

For the telemetry wire fields, the single endpoint, the local 7-day failure queue,
and how to opt out, see the [CLI telemetry contract](operations/cli-telemetry.md).
The receiver keeps only a random installation ID, days of use, version, platform,
and architecture, with 90-day cleanup; it is not task-completion or reuse evidence.

## Install the stable release

macOS and Linux:

```bash
curl -fsSL https://wukong.today/install.sh | sh
wukong --version
```

The installer downloads the native binary for your platform from the public
release and verifies the adjacent SHA-256. From 0.0.13 onward, native macOS and
Linux installs can upgrade directly with `wukong upgrade`.

On Windows, download the x64 or ARM64 archive from the
[download page](https://wukong.today/download).

## Run from source

```bash
git clone https://github.com/wukong-code/wukong_cli.git
cd wukong_cli
pnpm install
pnpm dev:cli
```

To run only the CLI entrypoint:

```bash
pnpm -C apps/wukong run dev:cli-only --help
```

The public download repository is `wukong-code/wukong-code`. There is no public
Homebrew formula, and the old `@wukong.today/wukong-cli` package name is not
published. The runtime recognizes a Homebrew install origin, which does not mean
a public formula exists.

## Five-minute quick start

### 1. See the command surface

```bash
pnpm -C apps/wukong run dev:cli-only --help
```

### 2. Start the interactive TUI

```bash
pnpm dev:cli
```

Inside a project you can type a task directly, for example:

```text
Look at this project's directory layout and explain what each main module owns.
```

### 3. Run one non-interactive prompt

```bash
pnpm -C apps/wukong run dev:cli-only -- -p "summarize this repository"
```

`-p` prints a run preflight first, shows the writer iteration and active tool
while running, and ends with `run.summary`. `Outcome COMPLETED` or exit code `0`
only means an ordinary prompt finished normally — it is not a Loop `PASS`. The
summary states whether checks ran, whether durable evidence exists, what changed
in the workspace, and the next action. If you see
`provider_outcome_unknown`, the summary will not offer a resume command; check
the provider logs or billing first and do not blindly resume or retry.

### 4. Manage providers

```bash
pnpm -C apps/wukong run dev:cli-only -- provider --help
```

Use `/provider` in the TUI to configure a model provider and API key. `/login`
only connects the optional Wukong account; it does not provide or configure a model.

The optional account uses the same entrypoints:

```bash
wukong login
wukong logout
```

`wukong logout` (`/logout` in the TUI) first attempts a remote revocation with
the refresh token in the current credential slot, then always deletes the local
token and managed account configuration. HTTP 200 means the remote session was
confirmed revoked; on network failure, timeout, rate limiting, or a server error
the remote state is reported as unknown while the local sign-out still completes,
with a clear warning that the server-side session may remain valid. If it must be
invalidated immediately, follow the contact link printed by the command
(`https://wukong.today/contact`); do not read "signed out locally" as "revoked
remotely". Running logout again without a token sends no revocation request and
does not touch BYOK providers. If local files cannot be cleaned up, the command
fails with an explicit error.

The provider catalog reads, in order:

1. `https://modelpricelab.com/api.json`
2. `https://models.dev/api.json`

Override the preferred catalog with an environment variable:

```bash
WUKONG_CODE_CATALOG_URL=https://catalog.example.com/api.json wukong provider catalog list
```

Passing `--url` explicitly contacts only that address with no silent fallback,
which is useful for private catalogs:

```bash
wukong provider catalog list --url https://catalog.example.com/api.json
```

### 5. Validate configuration

```bash
pnpm -C apps/wukong run dev:cli-only -- doctor
```

### 6. Preview your first headless Loop

```bash
pnpm -C apps/wukong run dev:cli-only -- loop "finish the current change" --dry-run
```

After reviewing the output, add the exact checks, Gate, workspace, and review
authorization flags it lists back onto the same command. A bare headless command
never accepts these decisions on your behalf.

### 7. Create a project review policy

```bash
pnpm -C apps/wukong run dev:cli-only -- review init
```

### 8. Record local feedback for a finding

```bash
pnpm -C apps/wukong run dev:cli-only -- review feedback <finding-id> accept
```

### 9. Start a Loop inside the TUI

```text
/loop <objective>
/loop --review-model <model-alias> -- <objective>
/loop status
/loop pause
/loop resume
/loop stop
```

Objectives that start with `-` must come after `--`; unknown flags fail
immediately instead of being treated as the objective.

### 10. Start a Loop with verification constraints

```bash
wukong loop "fix the failing tests" --max-iterations 5 --dry-run
wukong loop "finish the API change" --model fast --review-model slow --dry-run
wukong loop "finish the API change" --review-model reviewer --dry-run
wukong loop "finish the API change" --done-when "compatibility tests pass" --constraint "do not remove old fields" --dry-run
```

These commands produce a proposal first; to actually start, you must add the
required flags printed by the dry-run back to the same command.

Only the final durable `loop.result` of a real Loop maps `PASS=0`,
`NEEDS_WORK=1`, `ERROR=2` to a Gate verdict; a headless SIGINT is `130` and
means lifecycle interruption, not a verdict. A successful `--dry-run` also exits
`0` while printing `loop.finish_line.dry_run` — never treat it as `PASS`, and do
not apply this table to argument validation, preflight blocks, or other
commands. Everyone can run local BYOK Loops directly: no login, no guest trial,
no monthly cap, and no Wukong quota service. The default limit is 10 iterations,
adjustable with `--max-iterations`; reviewer step/time ceilings and `/loop stop`
remain the runaway protection. `verify`, `scan`, and `proof` are internal check
layers and advanced diagnostics.

#### From input to outcome

An ordinary prompt is one model conversation; a model reply is not evidence that
the project is done. Use `/loop <goal>` or `wukong loop <goal>` when you want
Wukong to change and verify the project:

1. **Input.** State the goal clearly, ideally with Done-when and Must-not rules.
   Never put API keys, tokens, or passwords in a prompt.
2. **Preflight confirmation.** The TUI shows one Preflight with the success
   criteria, Must-not text, itemized checks, review criteria, writer/reviewer,
   sanitized provider origin, pre-existing dirty paths, permissions, outbound
   scope, approval order, result handling, iteration cap, provider-call
   ceilings, and optional token budget. Headless dry-runs list the same facts
   plus required flags. Local read, provider transmission, permissions, and
   project-check execution are approved separately so one confirmation never
   silently widens scope. Edit, inspect, or cancel when something looks risky;
   the dangerous Continue is always last, and "Continue anyway" never relaxes
   the Gate. Only a versioned no-check decision can cover a docs/config task
   with no applicable executable checks; a source change missing required checks
   ends `NEEDS_WORK/checks_missing`, never `PASS`.
3. **During the run.** Watch the writer iteration, elapsed time, current
   tool/activity, calls/tokens/retries/remaining budget, and real blockers.
   TUI and headless share the same runtime phase events: `WRITE` means the
   writer is editing, `CHECK` means frozen Gate checks are running, `REVIEW`
   means the fresh reviewer is reading bounded evidence. Repeated identical
   output or blockers stop; a no-progress condition ends the run early.
4. **Outcome.** The terminal summary comes from the local run record, not from
   the model's closing words. It shows the attainable Gate state, iterations,
   attempts, duration, workspace, checks, evidence, main blocker, and a
   deterministic next action. Pre-existing changes are separated from Wukong
   introduced/modified/deleted and unknown attribution; unprovable token or file
   attribution stays `unavailable`/`unknown`. Wukong does not estimate provider
   cost.
5. **After the outcome.** Wukong never commits, pushes, or publishes on `PASS`.
   Check `git status --short` and `git diff`, review non-blocking findings via
   `/loop status` or review feedback, then decide to commit, continue, adjust
   the Finish Line, or fix provider/permission/external issues.

| Outcome | Meaning | Your next step |
|---|---|---|
| `PASS` | Frozen local checks and the reviewer Gate both passed | Review the diff and non-blocking findings; deliver through your own Git workflow |
| `NEEDS_WORK` | A blocker, permission boundary, iteration cap, or no-progress stop remains | Handle the `Blocker`/`Next`; then `/loop resume`, or start a new Loop with a sharper Finish Line |
| `ERROR` | Provider, checks, state, or runtime could not produce a trustworthy conclusion | Fix the run conditions and retry; for `provider_outcome_unknown`, reconcile request/idempotency IDs with provider logs or billing before any retry |
| `PAUSED` | TUI Ctrl-C or `/loop pause` paused the contract; no verdict | Inspect the workspace; `/loop resume` when safe |
| `STOPPED_BY_USER` | `/loop stop` or a headless interruption stopped the run; no verdict | Inspect kept changes; after `/loop stop` start a new Loop; headless resume only exists when the provider outcome is known |

Cancelling during preflight creates no run and produces none of the outcomes above.

The Loop enters the Finish Line first. The current TUI consolidates the actual
input, run settings, dirty workspace, outbound boundaries, and result handling
into the final Preflight, while distinct security approvals still run
separately. `--dry-run` only generates the full proposal, workspace challenge,
warning digest, and Gate approval digest — no trust grants, contract, or run.
A real headless run must confirm the exact digests returned by the dry-run;
`--yes`, Auto, or YOLO are not substitutes. Project checks run with your current
OS permissions in a trusted workspace shell; Wukong applies static risk blocking
but does not claim a complete shell sandbox.

The Finish Line's **Review verification** step lists strict criteria sidecars
from local Verification Skills. `○ suggested` only means a versioned
path/package rule matched; a V3 contract is created only after you explicitly
select entries with their exact source, provenance digest, and order. Skill
Markdown bodies, commands, scripts, tools, hooks, MCP, and permission claims
never enter the Gate.

With or without a Skill, every reviewer attempt requires an independent local
broker read trust, then per-run confirmation of allowed inputs, ceilings, and
the actual BYOK provider endpoint. Allowed changed/untracked/scope-matched files
and sanitized Gate evidence may go to that provider — never to Wukong Web/D1.
`.env`, credential, session, trust-store, log, and binary/generated paths are
hard-excluded, and a content filter blocks recognizable secrets. Filtering does
not replace reviewing the changes being sent; the provider's own data and
retention policies still apply. Cancel, missing exact consent, or drift keeps
the provider connection closed.

Preview the same protocol headlessly:

```bash
wukong loop "finish the API change" --dry-run --output-format stream-json
```

The text dry-run lists only the **headless start flags** this repository
actually requires: discovered-check selection, Gate approval, warning
acknowledgement or project trust when needed, the short-lived broker challenge,
and provider-send consent for the run. Add those flags to the same
`wukong loop` command; a bare command without authorization fails closed
instead of assuming consent.

Submit `--verification-catalog-digest` and the repeatable
`--verification-skill "<selection-id>@<provenance-digest>"` only when the
selection is non-empty; with no selection a V2 contract is created and the
catalog CAS must be omitted. Starting also requires the dry-run's short-lived
`--trust-review-subject` challenge and the exact `--ack-review-subject`.

The Loop freezes the objective and explicit completion criteria at creation.
Each reviewer round must address the previous blocker; an unchanged blocker for
two consecutive rounds triggers one read-only strategist. If there is still no
progress, the Loop returns `NEEDS_WORK/no_progress` instead of spinning or
quietly raising the iteration ceiling.

### 11. Choose a permission mode

- `manual`: ask when needed; best for interactive use.
- `auto`: no prompts, bounded by workspace, sensitive targets, high-risk Bash,
  and custom/MCP capability rules. If a block happens inside an active Loop, the
  run ends `NEEDS_WORK/permission_required` rather than a resumable `PAUSED`.
- `yolo`: skips ordinary approvals but still cannot bypass user denies, safety
  hooks, the Plan guard, role/profile allowlists, or read-only clone limits.

Headless `-p` uses restricted Auto by default. Dangerous headless execution must
be explicit:

```bash
wukong -p "<task>" --yolo --yes
```

The example shows flag syntax only — do not paste it into a workspace with
uncommitted changes; a YOLO prompt may modify files and run commands.

`--yes` alone does not enable YOLO. The legacy `--auto-approve` still maps to
YOLO for one compatible version with a deprecation and danger warning.

### 12. Continue another agent's local session

```text
/resume
/resume codex
/resume claude
/resume cursor
/resume kimi
/resume grok
```

`/resume` lists Wukong sessions only; the external sources are scanned only when
named explicitly. `/resume-codex`, `/resume-claude`, and `/resume-cursor` remain
compatibility aliases outside the main command list; Kimi and Grok use only the
canonical source argument.

Wukong sessions resume natively. External sessions are read through a built-in
Skill that extracts the goal, finished work, unfinished work, and last request
from the local transcript, then continues in Wukong. The process never restarts
the original agent, inherits its permissions, or replays old tool calls; the
current workspace and Git state are re-read before continuing.

Welcome suggests at most one external session from the current workspace within
30 days; disable it with `[resume] foreign_suggestions = false` in
`~/.wukong/tui.toml`. The session picker searches user-prompt summaries of the
last 100 Wukong sessions, reads at most 128 KiB per session, and ignores
system, tool, and synthetic content.

## Current top-level commands

| Command | Status | Purpose |
|---|---|---|
| `wukong` | implemented | Start the interactive TUI |
| `wukong -p <prompt>` | implemented | Run one prompt and print the result |
| `wukong provider` | implemented | Configure the BYOK LLM provider, API key, and default model |
| `wukong acp` | implemented | Run as an Agent Client Protocol server |
| `wukong server` | implemented | Start the local REST/WebSocket server |
| `wukong web` | implemented | Open the local web UI |
| `wukong verify` | implemented | Run deterministic checks and write a local evidence report |
| `wukong scan` | implemented | Read-only risk scan |
| `wukong guard` | implemented | Local guard status, stats, and command risk blocking |
| `wukong proof` | implemented | Merge Proof Report (verify + scan summary) |
| `wukong judge` | implemented | Deterministic merge verdict (review only, no writes) |
| `wukong loop` | implemented | Headless Loop with `--max-iterations`, `--every`, `--model`, `--review-model`, `--dry-run` |
| `wukong review init` | implemented | Create `.wukong/review-policy.md` |
| `wukong review feedback` | implemented | Append finding feedback to local JSONL; never uploads source or reasons |
| `wukong review stats` | implemented | Show raw local feedback counts; quality ratios hidden below 10 samples |
| `wukong login` | implemented | Connect the optional Wukong account; does not configure models |
| `wukong logout` | implemented | Best-effort remote refresh-token revocation; always clears local account credentials |
| `wukong doctor` | implemented | Validate configuration files |
| `wukong export` | implemented | Export a session ZIP |
| `wukong vis` | implemented | Open the session visualizer |
| `wukong migrate` | implemented | Migrate legacy wukong-cli data |
| `wukong upgrade` / `wukong update` | implemented | Upgrade Wukong |

## Updates and TUI announcements

- The CLI checks for updates at startup; supported package managers may
  auto-install in the background by default. Disable it in `/settings` →
  `Upgrade` or set `[upgrade].auto_install = false` in `~/.wukong/tui.toml`.
- `wukong upgrade` / `wukong update` checks and installs the latest version
  immediately without a second prompt. Native macOS/Linux verifies the release
  SHA-256 and atomically replaces the binary; native Windows or unrecognized
  origins fall back to the download page.
- After the main TUI mounts, one announcement is fetched asynchronously with a
  3-second timeout. Failures never block the CLI; at most one announcement is
  shown per launch.
- Announcements support client versions, time ranges, `once` / `cooldown` /
  `always` frequency control, and a safe-link allowlist.

See the [updates and announcements contract](operations/updates-and-announcements.md)
for the full behavior.

## Verification command status

The local verification loop is complete for P0:

| Command | Planned role | Status |
|---|---|---|
| `wukong verify` | Verify current changes locally with an evidence report | Implemented |
| `wukong scan` | Read-only risk scan | Implemented |
| `wukong guard` | Confirm/block high-risk commands | Implemented; P0 does not edit shell profiles |
| `wukong proof` | Merge Proof Report (verify + scan) | Implemented |
| `wukong judge` | Deterministic review-only verdict | Implemented |
| `wukong loop` | Local loop until checks and the read-only reviewer pass | Implemented for CLI and TUI; structured multi-finding results, only blocking findings stop the Loop |
| `wukong review` | Project review policy and local finding feedback | `init`, `feedback`, `stats` implemented |
| `wukong_verify` agent tool | Let the agent verify before claiming done | Implemented as a builtin agent-core tool |
| `/verify`, `/scan`, `/guard`, `/goal`, `/proof`, `/judge`, `/loop` | TUI equivalents | Implemented |
| `wukong sync` | Cloud sync | Waiting for the new base API and local data model |
| `wukong today` | Local Loop briefing: local stats + focus, no network | Implemented; no visible TUI `/today` command currently |

Details: [commercial refactor implementation plan](tech/commercial-refactor-implementation.md)
(internal engineering record, in Chinese).

## 0.0.12 compatibility

The legacy `--until verify-pass`, `scan-clean`, and `judge-pass` arguments are
still accepted and map to `proof-pass`. Resuming 0.0.11 Goal records applies the
same migration without rewriting history. See the
[compatibility matrix](design/0.0.12-compatibility.md) (internal record, in Chinese).

## Local data

The default data directory is `~/.wukong`. Common files:

```text
~/.wukong/config.toml
~/.wukong/tui.toml
~/.wukong/credentials/
```

Prefer a temporary home for testing so real configuration stays clean:

```bash
WUKONG_CODE_HOME=/tmp/wukong-test pnpm -C apps/wukong run dev:cli-only -- doctor
```

## Development checks

```bash
pnpm --filter @wukong.today/code run typecheck
pnpm -C apps/wukong run dev:cli-only --help
pnpm -C apps/wukong run dev:cli-only -- login --help
```

## Common misconceptions

- `wukong verify`, `wukong guard`, and `wukong scan` are implemented commands.
- `wukong_verify` is a builtin agent tool, not a shell command.
- `/verify`, `/scan`, `/guard status`, `/proof`, `/judge`, `/goal`, `/loop` are TUI slash commands.
- `wukong login --provider google --dev-email ...` is not a current login argument.
- `wukong sync` and the Companion `journey` are out of scope, not hidden commands.
