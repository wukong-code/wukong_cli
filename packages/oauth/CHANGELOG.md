# @wukong/wukong-oauth

## 0.2.3

### Patch Changes

- chore: clear all lint warnings and fix test alias resolution

  - Run lint:fix auto-corrections across the monorepo
  - Fix lint errors and disable noisy/low-value rules in .oxlintrc.json
  - Manually fix remaining switch-exhaustiveness, unicorn style, import, and typescript warnings
  - Fix latent bugs uncovered by lint: verification double-resolve, jitter codePointAt, oauth Set type
  - Add `#/*` subpath imports to `@wukong.today/code` package.json so Vitest can resolve `#/cli/*` in tests

## 0.2.2

### Patch Changes

- [#399](https://github.com/wukong-code/wukong_cli/pull/399) [`232ed87`](https://github.com/wukong-code/wukong_cli/commit/232ed874d41de777e6ff9c539ac22d830d0b5c3a) - Keep managed OAuth credentials scoped to their configured authentication and API endpoints.

## 0.2.1

### Patch Changes

- [#335](https://github.com/wukong-code/wukong_cli/pull/335) [`7284f30`](https://github.com/wukong-code/wukong_cli/commit/7284f30479142fd66b1e8a731fd00198b1e8684f) - Fix custom registry provider handling during re-import. Prevent loss of multi-provider entries and remove stale providers along with their model aliases and default model references.

## 0.2.0

### Minor Changes

- [#264](https://github.com/wukong-code/wukong_cli/pull/264) [`42bb914`](https://github.com/wukong-code/wukong_cli/commit/42bb9141d8ee7023639f943dd4c6a0f6c8fa8945) - Add `/provider` command for managing AI providers, support custom registry imports, and introduce a tabbed model selector.

### Patch Changes

- [#274](https://github.com/wukong-code/wukong_cli/pull/274) [`a1dfbfe`](https://github.com/wukong-code/wukong_cli/commit/a1dfbfeb16bcad0c2c8faa232d6d1ce4a2681d57) - Clarify Wukong Platform API key login labels and prompt details.

## 0.1.2

### Patch Changes

- [#52](https://github.com/wukong-code/wukong_cli/pull/52) [`064343a`](https://github.com/wukong-code/wukong_cli/commit/064343a6e565a525fbf38b3a1f70f7ff0235a5ed) - Correct the `X-Wukong-Platform` header value to `wukong_cli`.

- [#11](https://github.com/wukong-code/wukong_cli/pull/11) [`15b018f`](https://github.com/wukong-code/wukong_cli/commit/15b018fc84a36a9ebde598970e5b44bebe5d68c6) - Surface API-provided error messages during feedback, usage, login, and model setup failures.
