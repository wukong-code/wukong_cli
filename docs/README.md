# Wukong Code Documentation

> Current stable: `0.2.0` — Standalone Gate & Proof Foundation (`wukong init`, `wukong check`, `wukong gate`, `wukong summary`).
>
> Candidate evidence snapshot: [`0.1.0-rc.1`](https://github.com/wukong-code/wukong-code/releases/tag/v0.1.0-rc.1).

0.2.0 builds on the [controllable, recoverable, explainable Trusted Local Loop](design/0.1.0-trusted-local-loop.md)
with standalone verification & proof commands (`wukong init`, `wukong provider test`,
`wukong check`, `wukong gate`, `wukong summary`), tiered CLI/TUI help, and single-confirm
headless run-plans while keeping the MIT free, local-first, BYOK boundary unchanged. The
website and operations backend remain private.

## Start here

- [User Guide](user-guide.md)
- [CLI Use and Risk Notice](CLI-USE-AND-RISK.md)
- [0.2.0 Release Notes](releases/0.2.0.md)
- [0.1.2 Release Notes](releases/0.1.2.md)
- [Architecture](tech/architecture.md)
- [Automated Test Plan](test/verification-cli-test-plan.md)
- [中文文档](zh/README.md)

## Operations

- [Updates & Announcements Contract](operations/updates-and-announcements.md)
- [CLI Telemetry Contract](operations/cli-telemetry.md)

## Version design records

- [0.1.2 First Success And Surface Simplification](design/0.1.2-first-success-and-surface-simplification.md)
- [0.1.0 Trusted Local Loop](design/0.1.0-trusted-local-loop.md)
- [0.0.21 Loop Evidence Integrity](design/0.0.21-loop-evidence-integrity.md)
- [Cross-Agent Session Resume](design/cross-agent-resume.md)

Older public technical design and research notes are kept in Chinese under
[design/](design/), [tech/](tech/), and [test/](test/), plus the
[Chinese documentation](zh/README.md). Business experiments, production usage
statistics, and private website operations are maintained outside this public repository.

Before adding or publishing root Markdown or documentation source files, review their public suitability,
update [the document list](public-documents.json), and run
`node scripts/check-public-docs.mjs`. The documentation build runs this check;
removing a sidebar entry does not make a document private.

## Planning

- [Roadmap](https://github.com/wukong-code/wukong_cli/blob/main/ROADMAP.md)
- Releases: [wukong-code/wukong-code](https://github.com/wukong-code/wukong-code/releases)
