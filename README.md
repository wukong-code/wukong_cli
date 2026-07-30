# Wukong Code

[Documentation](docs/README.md) · [中文](README.zh-CN.md) · [Download](https://wukong.today/download)

> **Give Wukong a goal. It loops until the change is ready.**

Wukong Code is a terminal AI coding agent built around one workflow:
**Goal → Write → Check → Review → Fix**.

Give `/loop` a goal. Wukong works on the change, runs the repository's real
checks, reviews the result from a fresh read-only context, and fixes blocking
findings against the same goal.

## Current release: v0.0.21

Version `0.0.21` improves Loop evidence integrity:

- distinct occurrences of the same built-in risk are preserved across files,
  lines, and evidence locations;
- each occurrence has a stable identity derived from its complete finding;
- exact duplicate input remains deterministic and can still be deduplicated;
- deterministic Gate failures keep priority over reviewer output.

See the [v0.0.21 release notes](docs/releases/0.0.21.md).

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
- **Return clear outcomes** — every Loop ends as `PASS`, `NEEDS_WORK`, or
  `ERROR`, with a blocker and next action when work remains.
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

Or run a Loop directly:

```sh
wukong loop "add input validation to the signup form"
wukong loop "add input validation to the signup form" --dry-run
```

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
| `wukong -p <prompt>` | Run one non-interactive prompt |
| `wukong provider` | Configure model providers and models |
| `wukong loop <goal>` | Run write → check → review → fix against one goal |
| `wukong review init` | Create `.wukong/review-policy.md` |
| `wukong guard` | Inspect the command risk guard |
| `wukong login` | Connect an optional Wukong account |
| `wukong doctor` | Validate local configuration |
| `wukong upgrade` | Upgrade a native installation |

Run `wukong --help` for the complete command and option list.

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
