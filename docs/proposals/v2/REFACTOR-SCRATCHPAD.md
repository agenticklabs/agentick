# REFACTOR-SCRATCHPAD — augmentation refactor (ADR 27 execution)

**Active:** 2026-05-26 — onwards
**Tracks:** the refactor that lands ADR 27 (modular built-ins).
**Format:** running log. Newest entries appended. Each entry is an
ISO date + short title + body. Surprises, gotchas, judgement calls,
and "I expected X but got Y" go here.

When this refactor lands and STATUS.md captures the milestone, this
scratchpad gets archived (or rolled into the milestone description).

---

## Pre-flight context (2026-05-26)

**Where we're starting from.** Going into this refactor:

- `feat/v2` branch, 88 commits ahead of master.
- ADR 26 (`harness-api-shape.md`) is the foundational pattern. ADR 27
  (`modular-built-ins.md`) refines it by making built-ins follow the
  same modular pattern as optional extensions.
- Recent shipped work: Step 5a (TimelineHarness extraction with two-tier
  log + projection), Step 5a follow-up (pending-messages: queue / drain
  / readPending).
- I'm in the middle of a doomed pre-ADR-27 refactor that tried to
  put the Timeline component in `@agentick/timeline/react`. That work
  created three packages (`@agentick/data`, `@agentick/in-memory-bridges`,
  `@agentick/reconciler-react-tests`) routing around a workspace cycle.
  All three get rolled back as Stage 1 of this refactor — they were
  symptoms, not solutions.

**What ADR 27 actually fixes that ADR 26 didn't:**
ADR 26 made everything a harness but left foundational slots
(`timeline`, `knobs`, `state`) hardcoded in `@agentick/spec`. That
asymmetry between built-in and optional extensions forced
`@agentick/reconciler-react` to depend on harness packages, which
blocked harness packages from adding `/react` subpaths.

ADR 27 makes built-ins follow the same augmentation pattern as
optional extensions — uniformly. Reconciler-react becomes a true leaf,
any harness can have a `/react` subpath, and the modularity story
becomes real.

**Expected pain points (anticipated, not yet hit):**
- Generic snapshot iteration replaces hardcoded `bridges.knobs`,
  `bridges.state` access in `reconciler-harness.ts`. Snapshot shape
  changes from named fields to mapped type.
- Test relocation: ~13 reconciler-react `__tests__/` spec files get
  redistributed per harness. Each move requires import updates.
- Cross-harness tests (snapshot-restore.spec.tsx) need a home. Probably
  @agentick/session.
- TypeScript module augmentation has subtle visibility rules — if a
  consumer doesn't transitively import the harness package, it won't
  see the augmented slot.

---

## Entry log

<!-- 2026-05-26 — refactor begins -->

### 2026-05-26 — Stage 0: docs landed first

Wrote ADR 27 + updated `CLAUDE.md` with the principles + created this
scratchpad. Doing this before any code change so the architectural
direction is captured BEFORE the dust of refactor. Future agents
reading the repo encounter the principles immediately.

**Decision:** ADR 27 sits alongside ADR 26 (not as a replacement).
26 is the harness shape; 27 is how harnesses compose into a modular
framework. They're complementary.

**Decision:** CLAUDE.md gets a "v2 modularity model" subsection — not
just a link to the ADR. The principles are loaded into every agent
conversation; non-negotiable for v2 work.

Committed as `0504d142`.

### 2026-05-26 — Stage 1: rollback of doomed pre-ADR-27 refactor

Reverted the three packages (`@agentick/data`,
`@agentick/in-memory-bridges`, `@agentick/reconciler-react-tests`) +
all working-tree modifications + 13 test file moves. Working tree is
clean. 85/85 workspace typecheck green. Back to the post-Step-5a
baseline (`c9161ab8` + docs commit `0504d142`).

**Decision:** the rollback happened as a discard, not a commit. The
doomed refactor's work was entirely uncommitted (working tree only)
so `git restore .` + `find -delete` was sufficient. No revert commit
in the history clutters the log.

### 2026-05-26 — Stage 2: augmentation refactor

Added `src/augment.ts` to timeline, knobs, state. Each declares its
HookBridges slot via `declare module "@agentick/spec"`. Each package's
`index.ts` does `import "./augment.js"` for side-effect loading.

Stripped `timeline`, `knobs`, `state` from `HookBridges` in spec.
Kept `data`, `loop`, `session`, `tools?` (small interface-only
contracts without their own harness packages — fine to live in spec).

Added `SnapshotCapable<T>` to spec; updated each of the three
foundational harness protocols to `extends SnapshotCapable<TSnapshot>`
where T is a snapshot payload type defined alongside the protocol:
- `KnobsHarnessSnapshot = Readonly<Record<string, KnobPrimitive>>`
- `StateHarnessSnapshot = Readonly<Record<string, unknown>>`
- `TimelineHarnessSnapshot` already existed.

**Surprise:** 85/85 typecheck green + 5358 tests pass without any
changes to reconciler-react's snapshot code yet. The augmentations
are visible to reconciler-react TRANSITIVELY — its package.json deps
on timeline/knobs/state pull in their .d.ts files (via node_modules),
which TypeScript scans for module augmentations. Reconciler-react
typechecks against the augmented `HookBridges` shape without having
to import the augment files itself.

That means Stage 3 (generic snapshot iteration) is decoupled from
Stage 2 — Stage 2 is non-breaking on its own. Stage 5 (dropping
reconciler-react's harness deps) is what would force Stage 3 to land
first, because dropping the deps removes the augmentations from
reconciler-react's view.

**Decision:** SnapshotCapable's `importSnapshot` takes only
`(snapshot: T)` — no options parameter. Protocols that want options
(like `TimelineHarnessProtocol` with its `TimelineImportSnapshotOptions`)
add it as an optional additional parameter when they declare their own
`importSnapshot`. Adding optional parameters is structurally compatible
in TypeScript; this keeps the marker interface minimal.

**Surprise (good):** the 2 pre-existing `executor-ai-sdk/msw` test
failures we'd been carrying since Step 5a no longer appear. Must be
related to the fresh pnpm install. All 282 test files pass.

### 2026-05-26 — Stage 3: generic snapshot iteration

Rewrote `ReconcilerSnapshot` (`@agentick/spec/data/reconciler-snapshot.ts`):
the hardcoded `knobs` and `state` fields collapse into a generic
`bridges` map typed as:

```ts
readonly bridges: Readonly<{
  [K in keyof HookBridges]?: HookBridges[K] extends SnapshotCapable<infer S>
    ? S
    : unknown;
}>;
```

Mapped over `HookBridges` augmented slots. Adding a new harness with
`extends SnapshotCapable<T>` automatically populates the snapshot
type — zero reconciler changes.

`dataCache` retains its own top-level field for now because
`DataBridge` doesn't formally extend `SnapshotCapable` in the spec
(its reference impl `InMemoryDataBridge` happens to provide
`exportSnapshot`, but the protocol stays minimal so adopter
implementations of DataBridge aren't forced to implement snapshot).
Future work could collapse `dataCache` into `bridges.data` if we
formalize DataBridge as SnapshotCapable.

Replaced reconciler-react's `exportKnobs` / `importKnobs` /
hardcoded `bridges.state.exportSnapshot()` with two generic helpers:

- `captureBridgeSnapshots(bridges)` — iterates `Object.entries`,
  feature-tests each slot for `exportSnapshot()`, accumulates into the
  snapshot map. Skips `data` (separate top-level field).
- `applyBridgeSnapshots(bridges, snapshotBridges)` — iterates the
  snapshot map, feature-tests each bridge for `importSnapshot`,
  invokes with the recorded payload. Async-aware (awaits returned
  Promises so restore-before-render ordering holds for harnesses with
  async importSnapshot like TimelineHarness).

Reconciler-react now has NO harness-specific knowledge in its
snapshot code. Adding `useSandbox` or any other harness's snapshot
support requires zero reconciler changes — the harness extends
`SnapshotCapable<T>`, augments `HookBridges`, and is picked up
automatically by both the type and the runtime iteration.

**Cleanup:** 4 test files (snapshot-restore.spec.tsx,
reconciler-harness.spec.tsx) accessed the old `snap.knobs` /
`snap.state` shapes. Updated to `snap.bridges.knobs` /
`snap.bridges.state`. 2 spec-conformance stub fixtures
(loop-executor.ts, session-harness.ts) shipped a `ReconcilerSnapshot`
literal with old field names; updated to the new `bridges: {}` shape.

5547 workspace tests green (5358 + 189 tui).

**Note for future me:** the typecheck PASSES against the augmented
shape even though reconciler-react still imports timeline/knobs/state
as deps. The augmentations from those packages' `augment.ts` are
visible to reconciler-react TRANSITIVELY through node_modules. Stage 5
(dropping the deps) is what would test whether the generic iteration
is truly slot-agnostic — at that point reconciler-react wouldn't see
the augmentations and would have to operate purely on `Object.entries`
runtime iteration. That's the real validation.

**Observation:** the rollback was painless because nothing was
committed. Each prior commit (`c9161ab8`, `94a2d0c1`, `cb183bcb`...)
holds standalone value. Lesson reinforced: prefer many small commits
during exploratory architectural work so partial reverts are cheap.

### 2026-05-26 — Metapackage clarification

User confirmed: `agentick` (the public metapackage at
`packages/agentick/`) is mostly a re-export of `@agentick/core` plus
a couple of others. v2 keeps the same shape — a `@agentick/core`
aggregator bundling the built-ins, with `agentick` as the published
public face.

For this refactor: `stubBridges()` convenience goes in
`agentick/testing` (the metapackage's test subpath). When/if a v2
`@agentick/core` aggregator gets formalized as a distinct workspace
package, `agentick/testing` can re-export from
`@agentick/core/testing`. Same end-shape either way; no need to
formalize the v2 aggregator inside THIS refactor.
