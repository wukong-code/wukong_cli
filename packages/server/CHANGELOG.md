# @wukong/server

## 0.2.3

### Patch Changes

- chore: clear all lint warnings and fix test alias resolution

  - Run lint:fix auto-corrections across the monorepo
  - Fix lint errors and disable noisy/low-value rules in .oxlintrc.json
  - Manually fix remaining switch-exhaustiveness, unicorn style, import, and typescript warnings
  - Fix latent bugs uncovered by lint: verification double-resolve, jitter codePointAt, oauth Set type
  - Add `#/*` subpath imports to `@wukong.today/code` package.json so Vitest can resolve `#/cli/*` in tests

- Updated dependencies []:
  - @wukong/agent-core@0.14.3
  - @wukong/protocol@0.3.1

## 0.2.2

### Patch Changes

- [#1135](https://github.com/wukong-code/wukong_cli/pull/1135) [`bf51fb7`](https://github.com/wukong-code/wukong_cli/commit/bf51fb7a105b2f34a59ed4e83d2588e790cfb086) - Fix the local server failing to start on Windows after the first run because the persistent token file's synthesized mode was rejected as too permissive.

- [#1128](https://github.com/wukong-code/wukong_cli/pull/1128) [`0886bff`](https://github.com/wukong-code/wukong_cli/commit/0886bff2bcd3aed954990c948201d84787c0f3f3) - Add a --allowed-host flag to wukong server run that lets extra Host header values pass the DNS-rebinding check, and include allow guidance in the 403 error message. Pass --allowed-host <host> to allow an extra host.

- Updated dependencies [[`76c643b`](https://github.com/wukong-code/wukong_cli/commit/76c643bcb6da447c8c47728b4f58512a7a11cfa6)]:
  - @wukong/agent-core@0.14.1

## 0.2.1

### Patch Changes

- [#1085](https://github.com/wukong-code/wukong_cli/pull/1085) [`f1fad72`](https://github.com/wukong-code/wukong_cli/commit/f1fad7222ccd3f66c1cae6c5b9c009230227cd2f) - Reduce streaming latency by disabling Nagle's algorithm on WebSocket connections.

- [#1081](https://github.com/wukong-code/wukong_cli/pull/1081) [`8fc6aa5`](https://github.com/wukong-code/wukong_cli/commit/8fc6aa5f6842aa78acf8f23912342b721efcf7a9) - Sync session title changes across all connected clients in server mode.

## 0.2.0

### Minor Changes

- [#975](https://github.com/wukong-code/wukong_cli/pull/975) [`c5c1834`](https://github.com/wukong-code/wukong_cli/commit/c5c18347251221fab74e4f452ac4910116c4224d) - Speed up session snapshot loading with a direct disk reader and a request timeout safeguard, keeping the previous path as a legacy fallback.

### Patch Changes

- Updated dependencies [[`c0eeca2`](https://github.com/wukong-code/wukong_cli/commit/c0eeca24692edd736eecd3c2541d7566bac9f80f), [`2730079`](https://github.com/wukong-code/wukong_cli/commit/27300797f2149900219b05dda49dce65e71fa85a)]:
  - @wukong/agent-core@0.14.0
