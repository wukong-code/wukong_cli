---
name: evolve-durable-state
description: Use when adding or changing a field on goal/loop durable state — GoalState, GoalSnapshot, goal.update records, or the restore path in packages/agent-core. Provides the fixed checklist, compatibility rules, and test pattern so every evolution follows the same fail-closed contract.
---

# Evolve Durable State

Reference implementation of every step: commit `5c87f4b` (0.1.1 `usageByModel`).

## Hard rules

- **Additive optional fields only.** Never rename, retype, or remove a persisted field. Old records must restore without the new field.
- **Absent means unknown, never zero.** When an old record lacks the field, downstream consumers must fall back to an honest "unavailable" state, not a fabricated default that looks like data.
- **Snapshot state stays authoritative for budgets.** Display-only fields (cost, splits) must not feed budget, gate, or terminal decisions.
- **Append copies, not live references.** Anything written into a durable record must be a snapshot copy (`{ ...map }`); records are append-only and later mutation of a live object retroactively corrupts earlier entries.

## Checklist (in order)

1. **Record type** — `packages/agent-core/src/agent/records/types.ts`: add `field?: T` to the relevant record payload (e.g. `'goal.update'`).
2. **State** — `GoalState` (or equivalent) in `packages/agent-core/src/agent/goal/index.ts`: add the field and initialize it in **both** constructors (create path and restore-create path — grep for the sibling field, e.g. `tokensUsed: 0`, to find all sites).
3. **Restore** — `restoreUpdate`: apply only when present (`if (record.field !== undefined) state.field = ...`), with a defensive copy for containers.
4. **Mutation path** — update the writer method (e.g. `recordTokenUsage`) to maintain the field and append it in the record update.
5. **Snapshot** — add `readonly field?: T` to `GoalSnapshot` and expose it from `toSnapshot` (copy containers).
6. **Exports** — if the app layer needs the type/helper, thread it through `packages/node-sdk` exports. The app must not import `@wukong/agent-core` directly.
7. **Surfaces** — every consumer of the snapshot/record: pass the field through with `undefined` (no conditional spread) and define the unavailable fallback.

## Test pattern (extend the existing test file of the touched module)

- Accumulation: two writes produce the merged state; the scalar total (if any) is unchanged.
- Record round-trip: update → record contents → `restoreUpdate` → state matches.
- Legacy compatibility: a record **without** the field restores cleanly and downstream shows the unavailable fallback.
- Copy semantics: mutating state after the append must not change already-appended records.

## Verify

`pnpm run build:packages`, then `pnpm test:related -- <changed source files>` plus the goal/turn suites, then typecheck the touched packages. Do not run the full suite locally.
