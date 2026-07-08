# @wukong/wukong-web

## 0.1.3

### Patch Changes

- chore: clear all lint warnings and fix test alias resolution

  - Run lint:fix auto-corrections across the monorepo
  - Fix lint errors and disable noisy/low-value rules in .oxlintrc.json
  - Manually fix remaining switch-exhaustiveness, unicorn style, import, and typescript warnings
  - Fix latent bugs uncovered by lint: verification double-resolve, jitter codePointAt, oauth Set type
  - Add `#/*` subpath imports to `@wukong.today/code` package.json so Vitest can resolve `#/cli/*` in tests

## 0.1.2

### Patch Changes

- [#1085](https://github.com/mutnpc/wukong/pull/1085) [`f1fad72`](https://github.com/mutnpc/wukong/commit/f1fad7222ccd3f66c1cae6c5b9c009230227cd2f) - Fix stuttery streaming in the web chat by coalescing rapid token updates into a single render per frame.
