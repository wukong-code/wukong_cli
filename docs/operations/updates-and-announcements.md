# CLI Updates and Announcements Contract

> Updated: 2026-07-16.
> Scope: update checks, automatic installation, and TUI announcements in `wukong_cli`; the announcement source is maintained by `wukong_web`.

Updates and announcements are two independent channels. The update channel
delivers new versions; the announcement channel shows version, migration,
incident, or preview messages inside the TUI. Announcements never replace
update checks.

## Behavior overview

| Channel | URL | When | Failure behavior | Local state |
|---|---|---|---|---|
| Updates | `https://wukong.today/latest.json`, falling back to `/latest` | CLI startup preflight; explicit `wukong upgrade` | Silently keep the current version; explicit upgrades return an error | Cached latest version, staged-rollout decision, background install result |
| Announcements | `https://wukong.today/cli/announcements.json` | One async fetch after the main TUI mounts | 3-second timeout; network, HTTP, and parse failures are skipped silently | Only `once` / `cooldown` display times; announcement bodies are never cached |

### Update channel

- `wukong upgrade` and `wukong update` are equivalent: they always fetch the
  latest version immediately, ignore staged rollout, and install without asking
  again.
- Interactive startup reads the local update cache first, then refreshes the
  remote manifest in the background.
- `npm`, `pnpm`, `yarn`, and `bun` global installs support background
  auto-install; the default is `auto_install = true`.
- Homebrew and native binaries never background-install during the startup
  preflight; native macOS/Linux users are directed to `wukong upgrade`.
- When you run `wukong upgrade` explicitly, supported package managers and
  native macOS/Linux complete the upgrade directly; the native installer pins
  the target version, verifies the release SHA-256, and atomically replaces the
  binary. The code recognizes a Homebrew origin, but there is no public formula,
  so Homebrew is not a public upgrade path for existing users. Native Windows
  and unrecognized origins fall back to the download page.
- After a successful background install, the next interactive startup shows a
  success notice with a changelog link.
- Toggle background installation in the TUI via `/settings` → `Upgrade`, or edit
  `~/.wukong/tui.toml`:

```toml
[upgrade]
auto_install = true
```

- `WUKONG_CODE_NO_AUTO_UPDATE=1` disables the entire startup preflight —
  checks, notices, and background installation. The legacy
  `WUKONG_CLI_NO_AUTO_UPDATE` variable still works.

### Announcement channel

- Array order is priority; each launch shows at most the first eligible
  announcement that is not rate-limited.
- The client checks `enabled`, minimum/maximum client version, start/end times,
  level, and display policy.
- `once` shows each announcement `id` once per device; `cooldown` rate-limits by
  hours; `always` shows on every launch.
- `info`, `warning`, and `critical` use different TUI emphasis colors; action
  links render as visible HTTPS URLs.
- Remote text is stripped of terminal control characters and length-limited.
  Action links allow only `wukong.today` and its subdomains, or
  `github.com/wukong-code/wukong-code`.
- Requests carry no Wukong login token, project content, or personalization
  parameters. The server still sees the network metadata inherent to any HTTPS
  request, such as IP and User-Agent.
- `auto_install` and `WUKONG_CODE_NO_AUTO_UPDATE` control only the update
  channel; there is currently no separate announcement switch.

## Version bootstrapping boundary

Versions `0.0.10` and earlier hard-code the old announcement URL and cannot read
the new JSON. They must first upgrade through the independent `latest.json`
update channel to a version that ships the new URL. The new channel can only
reach those clients; it cannot announce its own launch to older ones.

## Announcement ownership

There is no admin UI and no database. The single source of truth lives in
`wukong_web`:

```text
public/cli/announcements.json
public/cli/announcements.schema.json
public/cli/announcements.example.json
docs/cli-announcements.md
scripts/validate-cli-announcements.mjs
```

Publishing, retraction, field definitions, and production acceptance are
governed by `wukong_web/docs/cli-announcements.md`. The CLI only fetches,
validates, and renders.

## Current rollout status

- [x] Static JSON, schema, example, and pre-publish validator prepared
- [x] CLI implements the protocol with version/time filtering, rate control, levels, links, and safety filtering
- [ ] Deploy `wukong_web` so `/cli/announcements.json` no longer 404s
- [ ] Ship the next CLI version containing the new announcement URL
- [ ] Enable the first production announcement only after both steps above

Do not ship a CLI that depends on the URL before the web files are deployed, and
do not treat announcements as the only upgrade notice while old clients cannot
read the new address.
