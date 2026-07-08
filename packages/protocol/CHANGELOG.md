# @wukong/protocol

## 0.3.1

### Patch Changes

- chore: clear all lint warnings and fix test alias resolution

  - Run lint:fix auto-corrections across the monorepo
  - Fix lint errors and disable noisy/low-value rules in .oxlintrc.json
  - Manually fix remaining switch-exhaustiveness, unicorn style, import, and typescript warnings
  - Fix latent bugs uncovered by lint: verification double-resolve, jitter codePointAt, oauth Set type
  - Add `#/*` subpath imports to `@wukong.today/code` package.json so Vitest can resolve `#/cli/*` in tests

## 0.3.0

### Minor Changes

- [#744](https://github.com/mutnpc/wukong/pull/744) [`18f299f`](https://github.com/mutnpc/wukong/commit/18f299fd0b266545a1f7cebae9f58b83b9d9776e) - Add support for legacy SSE MCP servers alongside stdio and streamable HTTP transports.

## 0.2.0

### Minor Changes

- [#612](https://github.com/mutnpc/wukong/pull/612) [`4603d8a`](https://github.com/mutnpc/wukong/commit/4603d8ad6e92a303f396f3d79d4e4d212d1c4b14) - Prevent forking sessions during active turns and consolidate wire protocol definitions into a shared internal package.
