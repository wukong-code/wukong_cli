.PHONY: prepare build typecheck lint lint-fix lint-pkg sherif test test-watch test-related test-changed test-coverage test-coverage-gate test-coverage-cli test-coverage-cli-gate clean changeset version publish release dev vis

## Setup

prepare:
	pnpm install

## Build

build:
	pnpm run build

## Quality

typecheck:
	pnpm run typecheck

lint:
	pnpm run lint

lint-fix:
	pnpm run lint:fix

sherif:
	pnpm run sherif

lint-pkg:
	pnpm run lint:pkg

## Test

test:
	pnpm run test

test-watch:
	pnpm run test:watch

test-related:
	pnpm run test:related

test-changed:
	pnpm run test:changed

test-coverage:
	pnpm run test:coverage

test-coverage-gate:
	pnpm run test:coverage:gate

test-coverage-cli:
	pnpm run test:coverage:cli

test-coverage-cli-gate:
	pnpm run test:coverage:cli:gate

## Clean

clean:
	pnpm run clean

## Release

changeset:
	pnpm run changeset

version:
	pnpm run version

publish:
	pnpm run publish

release: version publish

## Development

dev:
	pnpm run dev:cli

## vis

vis:
	pnpm run vis
