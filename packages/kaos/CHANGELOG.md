# @wukong/kaos

## 0.1.8

### Patch Changes

- [`6d38888`](https://github.com/mutnpc/wukong_cli/commit/6d388880e508ed2f2936ad0de9385493c3f2226f) Thanks [@xxg1413](https://github.com/xxg1413)! - Support recursive `**/` glob segments (zero or more directories) in path matching, aligning with Python pathlib behavior.

## 0.1.7

### Patch Changes

- chore: clear all lint warnings and fix test alias resolution

  - Run lint:fix auto-corrections across the monorepo
  - Fix lint errors and disable noisy/low-value rules in .oxlintrc.json
  - Manually fix remaining switch-exhaustiveness, unicorn style, import, and typescript warnings
  - Fix latent bugs uncovered by lint: verification double-resolve, jitter codePointAt, oauth Set type
  - Add `#/*` subpath imports to `@wukong.today/code` package.json so Vitest can resolve `#/cli/*` in tests

## 0.1.6

### Patch Changes

- [#807](https://github.com/mutnpc/wukong/pull/807) [`b45672c`](https://github.com/mutnpc/wukong/commit/b45672cdaac9959024c3ae36bf35b16a423aa1dc) - Close wrapped output streams when buffered readers are destroyed.

## 0.1.5

### Patch Changes

- [#654](https://github.com/mutnpc/wukong/pull/654) [`ff80327`](https://github.com/mutnpc/wukong/commit/ff803273440f3a2ff53d2c529c6fc892fde1d93f) - Propagate configured execution environment overrides across spawned processes.

## 0.1.4

### Patch Changes

- [#529](https://github.com/mutnpc/wukong/pull/529) [`3b62b12`](https://github.com/mutnpc/wukong/commit/3b62b123e68cc4543bfa8fa376c7e8a24fee0afb) - Detect Git Bash installed through Scoop and other Git shims on Windows.

## 0.1.3

### Patch Changes

- [#282](https://github.com/mutnpc/wukong/pull/282) [`a580cd3`](https://github.com/mutnpc/wukong/commit/a580cd3a98664e18642e0e856aeaa9b71ba93516) - Fix glob pattern backslash escaping and include match count in truncation messages.

## 0.1.2

### Patch Changes

- [#84](https://github.com/mutnpc/wukong/pull/84) [`e5717b7`](https://github.com/mutnpc/wukong/commit/e5717b7261599f4b4379aa34eb0b5fdf2dd93898) - Unify path normalization by replacing ad-hoc `toForwardSlashes` helpers with `pathe`. Remove unnecessary `node:path/win32` branching in path-access policies and tools, and inline unused `joinPath` wrappers. Platform-specific path separators are now handled consistently through a single module.
