# Wukong Code

> Your AI coding agent says it's done. Wukong makes it prove it.

Free, local-first, bring-your-own-key CLI for macOS, Linux, and Windows.

## Install

```sh
curl -fsSL https://wukong.today/install.sh | sh
wukong --version
```

## Start

Configure your model provider, then open the TUI:

```sh
wukong provider
wukong
```

Inside the TUI, give Wukong a goal:

```text
/loop add input validation to the signup form
```

Wukong writes the change, runs your repository's checks, reviews the result, and
fixes blocking findings. A Loop ends with a clear `PASS`, `NEEDS_WORK`, or
`ERROR` result.

## Headless mode

Preview the exact checks, limits, and approvals first:

```sh
wukong loop "add input validation to the signup form" --dry-run
```

Review the printed **Headless start flags**, then run the command again with those
flags. Missing decisions fail closed instead of starting silently.

## Useful commands

```text
wukong provider       Configure a model provider
wukong loop <goal>    Run write → check → review → fix
wukong doctor         Validate local configuration
wukong upgrade        Upgrade a native installation
```

Resume unfinished work from another coding agent:

```text
/resume codex
/resume claude
/resume cursor
/resume kimi
/resume grok
```

Run `wukong --help` for the complete command list.

## Privacy

Your workspace data and Loop evidence stay on your machine. Model requests go
to the provider you configure. Wukong does not commit, push, or publish changes
for you.

## Development

Requirements: Node.js `>=24.15.0`, pnpm `10.33.0`.

```sh
git clone https://github.com/wukong-code/wukong_cli.git
cd wukong_cli
pnpm install
pnpm dev:cli
```

Nix users can use the pinned development environment and package:

```sh
nix develop
nix build
nix run
node scripts/check-nix-workspace.mjs
```

The Nix package is a reproducible development/package path for the four
supported Nix systems; it is separate from the six-platform native release
pipeline. Update `flake.lock` deliberately and run the workspace consistency
check when package layout changes.

See [CONTRIBUTING.md](CONTRIBUTING.md), the [CLI use and risk notice](docs/CLI-USE-AND-RISK.md), and the [documentation](docs/README.md).

## Acknowledgments

Wukong Code builds on and learns from many open projects, including:

- [Kimi Code](https://github.com/MoonshotAI/kimi-code)
- [Pi](https://github.com/earendil-works/pi)
- [Claude Code](https://github.com/anthropics/claude-code)
- [Grok Build](https://github.com/xai-org/grok-build)
- [Codex](https://github.com/openai/codex)
- [Cursor](https://cursor.com)
- [Prismor](https://github.com/PrismorSec/prismor)

Wukong Code is an independent product focused on AI coding Loop control and
deterministic verification.

## License

The local CLI and its source are available under the [MIT License](LICENSE).
The website and operations backend are separate private products.
