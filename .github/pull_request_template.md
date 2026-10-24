## Related Task / Issue

<!-- Link the task/issue and the approved version scope. TODO entries alone do not authorize work. -->

## Problem

<!-- What need or limitation does this address? -->

## What changed

<!-- Explain the trigger and before/after behavior, affected paths, compatibility and failure behavior. -->

## Validation

<!-- Record the reviewed revision/local changes, checks run, failures and material checks not run.
For a bug fix, identify the regression test. Distinguish local checks from live/platform/release verification. -->

## Checklist

- [ ] I have read the internal [CONTRIBUTING](https://github.com/wukong-code/wukong_cli/blob/main/CONTRIBUTING.md) document.
- [ ] I have linked a related internal task, or explained the problem above.
- [ ] This change adds or updates a dependency; if so, I reviewed its license and updated the third-party notice/SBOM path.
- [ ] This change affects release assets, provenance, SBOM, NOTICE, installer, or update behavior; if so, I recorded the release impact.
- [ ] This change affects permissions, network access, plugins, MCP, credentials, or the trust boundary; if so, I updated the relevant docs/tests.
- [ ] This change affects Nix metadata or workspace layout; if so, I ran `node scripts/check-nix-workspace.mjs`.
- [ ] Ran `gen-changesets` skill, or this PR needs no changeset.
- [ ] Ran `gen-docs` skill, or this PR needs no doc update.
