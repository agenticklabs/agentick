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
  put the Timeline component in `@agentick/timeline-next/react`. That work
  created three packages (`@agentick/data`, `@agentick/in-memory-bridges`,
  `@agentick/reconciler-react-tests`) routing around a workspace cycle.
  All three get rolled back as Stage 1 of this refactor — they were
  symptoms, not solutions.

**What ADR 27 actually fixes that ADR 26 didn't:**
ADR 26 made everything a harness but left foundational slots
(`timeline`, `knobs`, `state`) hardcoded in `@agentick/spec-next`. That
asymmetry between built-in and optional extensions forced
`@agentick/compiler-react-next` to depend on harness packages, which
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
HookBridges slot via `declare module "@agentick/spec-next"`. Each package's
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

Rewrote `ReconcilerSnapshot` (`@agentick/spec-next/data/reconciler-snapshot.ts`):
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

### 2026-05-26 — Stages 4–7: the big move

Done together because they were coupled — moving hooks/components
out of reconciler-react required dropping the harness package deps,
which required relocating integration tests, which required
per-harness `/testing` subpaths.

**What landed:**

1. **Per-harness `/testing` subpaths** (`@agentick/timeline-next/testing`,
   `@agentick/knobs-next/testing`, `@agentick/state-next/testing`) — each owns
   its `stubXHarness` factory that constructs the real harness on an
   in-memory substrate.

2. **Per-harness `/react` subpaths**:
   - `@agentick/knobs-next/react` — `useKnob`, `<Knobs>`, `useKnobsContext`
   - `@agentick/state-next/react` — `useSessionState`
   - `@agentick/timeline-next/react` — `useTimeline`, `<Timeline>`,
     `token-budget`, `compactEntries`
     Each /react subpath depends on `@agentick/compiler-react-next` for
     `useBridges` + `BridgeContext`. Each `index.ts` does
     `import "../augment.js"` for side-effect loading of the slot.

3. **Mock-based stubs in reconciler-react** — `mockTimelineHarness`,
   `mockKnobsHarness`, `mockStateHarness`. They satisfy the protocols
   without importing harness packages. Used by reconciler-react's own
   tests. **Adopters do not import these** — they use real stubs from
   per-harness `/testing` subpaths via `agentick/testing` (eventual)
   or directly.

4. **Reconciler-react's harness deps dropped.** No more
   `@agentick/timeline-next`, `@agentick/knobs-next`, `@agentick/state-next` in its
   `dependencies`. It's now a true leaf in the workspace harness
   graph (deps: spec, runtime, formatters, tool only). **Real cycle
   break achieved** — turbo no longer detects a cycle.

5. **Integration tests relocated:**
   - `reconciler-react/__tests__/knobs.spec.tsx` →
     `@agentick/knobs-next/__tests__/integration-with-reconciler.spec.tsx`
   - `reconciler-react/__tests__/timeline.spec.tsx` →
     `@agentick/timeline-next/__tests__/integration-with-reconciler.spec.tsx`
   - `reconciler-react/__tests__/use-session-state.spec.tsx` →
     `@agentick/state-next/__tests__/integration-with-reconciler.spec.tsx`
   - `reconciler-react/__tests__/snapshot-restore.spec.tsx` →
     `@agentick/session-next/__tests__/snapshot-restore.spec.tsx`
   - `hooks.spec.tsx`'s `useKnob` block — deleted (coverage moves
     with the hook to knobs's integration test).

6. **Conformance suites move with harnesses.** Reconciler-react's
   `conformance.spec.tsx` drops the `runKnobsHarnessConformance` and
   `runTimelineHarnessConformance` invocations — these already run
   against the real harness in `@agentick/knobs-next/src/__tests__/harness.spec.ts`
   and `@agentick/timeline-next/__tests__/harness.spec.ts`.

**Surprises:**

- **mockKnobsHarness needed list() snapshot caching** — without it,
  `useSyncExternalStore` saw a fresh array on every `list()` call and
  the `<Knobs>` component infinite-looped. The real KnobsHarness has
  `listCache: KnobDescriptor[] | null = null` for the same reason
  (recurring v2 gotcha worth a spec note: `useSyncExternalStore` snapshot
  references MUST be stable between mutations). Added `listCache` to
  the mock.

- **`stubBridges()` in reconciler-react needs `as unknown as HookBridges`
  cast.** Reconciler-react doesn't see the augmented `timeline`/`knobs`/
  `state` slots in its own typecheck (no harness package dep), so
  TypeScript treats the field initializers as excess properties on
  the empty-seed HookBridges. The runtime values are correct; the cast
  acknowledges the type-vs-runtime gap. Adopter test code (which DOES
  import harness packages) sees the augmented HookBridges normally.

- **`gates` needed a regular dep on `@agentick/knobs-next`** to import
  `useKnob` from `@agentick/knobs-next/react`. Was previously fine via
  reconciler-react re-export. Updated.

- **External callers fixed:** `@agentick/app-next/__tests__/knobs-integration.spec.tsx`
  now imports `useKnob` from `@agentick/knobs-next/react` (was reconciler-react).

5501 workspace tests green (5312 + 189 tui; was 5358 — we LOST 1 test
from the useKnob removal in hooks.spec.tsx, GAINED few from the test
relocations not netting back to 5358).

`agentick/testing` composed `stubBridges()` convenience deferred —
adopters can use per-harness `/testing` imports for now; the metapackage
composition lands when we formalize a v2 `@agentick/core` aggregator.

**The architecture is real.** Reconciler-react is a true leaf. Any
harness package — built-in or optional — can have a `/react` subpath
without workspace cycle risk. Tests live where the deps are. Built-in
and optional follow the identical pattern.

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

### 2026-05-23 — End-to-end real-model example landed (example/v2-real)

Built `example/v2-real/` to validate ergonomics with a real OpenAI
model via the AI SDK adapter. The example is the forcing function for
API surface — every awkward seam shows up here first.

**Ergonomic gaps surfaced + filled:**

- **`app.send(string)` shortcut** — `app.runOnce({ send: { messages:
[{ role: "user", content: "..." }] } })` is too verbose for the
  90% path. Added an overload: `app.send(input: string | SendInput<P>):
Promise<SendResult>` that unwraps `runOnce` and lets the user pass
  a plain prompt string. Lives on `AppHarness` (see `harness.ts:637`).
  Returns `SendResult` directly (no `{ result, sessionId }` wrapper).

- **`app.close()` alias** — adopters reach for `app.close()` by reflex
  (mirrors `session.close()` / `harness.close()`). Added as a thin
  alias for `closeApp()` at `harness.ts:615`. Both names available.

- **Semantic role components** — `<Message role="system">...</Message>`
  is awful for the system prompt; users want `<System>...</System>`.
  Added `<System>`, `<User>`, `<Assistant>` as pass-through wrappers
  over `<Message>`, plus block-level `<Paragraph>`, `<H1>`, `<H2>`,
  `<H3>` over the `paragraph` / `heading` intrinsics. Lives in
  `reconciler-react/src/react/components/semantic.tsx`. Trivial
  wrappers — no behavior, just prop shape.

**Ergonomic gaps NOT YET filled — punt list:**

- The example currently imports `React` solely for
  `React.createElement(Agent)` in the `createApp(...)` call. v1
  accepted JSX directly. The reason this is awkward is that `createApp`
  takes `rootElement: unknown` — TypeScript can't infer JSX without
  a tsx file, and `index.ts` is plain ts. Mitigation: write
  `index.tsx` instead, or accept that `React.createElement` is fine
  for the single call site. Left as-is for now — adopters using `.tsx`
  for their entry get `createApp(<Agent />, { ... })` naturally.

- `result.usage.totalTokens` — currently shipped under
  `result.usage.{inputTokens, outputTokens, totalTokens}`. Reads
  naturally. No change.

- `result.stopReason` — union type with provider-native + framework
  ("max_ticks", "aborted", etc.) values. Acceptable.

- `<Knobs />` auto-emits a `set_knob` tool. Adopters who don't want
  knobs simply don't render `<Knobs />`. Good zero-config story.

**Verified:** `pnpm typecheck` green across all 86 workspace packages
including `example-v2-real`. Example not yet run end-to-end (requires
adopter's `OPENAI_API_KEY`).

**Lesson:** writing the example BEFORE freezing the user surface
surfaced 3 missing ergonomic affordances (semantic components,
`app.send` shortcut, `app.close` alias) that pure-test-driven design
would have shipped without. The example is the unit test for
ergonomics. Keep it as a first-class artifact, run it before every
release.

### 2026-05-27 — Model-catalog / ModelAdapter architecture (design note, deferred)

User flagged a real architectural concern: `@agentick/executor-openai-next`
is named like an executor but is actually a provider impl. The
conceptual hierarchy is wrong — providers should be ADAPTERS that
the executor (a higher-level abstraction) consumes. AI SDK is a
library and `executor-ai-sdk` correctly names that relationship.

**The resolution: a shared model catalog + two executor paths.**

```
@agentick/model-catalog (new package, no runtime deps)
  Static Map<(provider, modelId), ModelCapabilities>
  Capabilities: contextWindow, maxOutputTokens, supportsTools,
                supportsImages, supportsAudio, supportsReasoning,
                pricePerInputToken, pricePerOutputToken, ...

@agentick/model-executor-next (the native executor, framework-level)
  Consumes a ModelAdapter (protocol — new, in spec)
  Native adapters: @agentick/openai, @agentick/anthropic,
                   @agentick/google, @agentick/vertex
  Each adapter ships capabilities inline, OR delegates to the catalog
  via (provider, modelId) lookup.

@agentick/executor-ai-sdk-next (parallel executor)
  Wraps ai-sdk's LanguageModel
  Looks up capabilities from the catalog via
    (model.provider, model.modelId) — both fields exposed by ai-sdk's
    LanguageModel.
  Unknown model → default to "no enhanced features," call API.

Both paths feed the same `target.capabilities` to the framework.
Compaction triggers, multimodal validation, cost routing, etc.
work uniformly regardless of which executor backs the session.
```

**Why this matters (the framework value-add):**

1. **Auto-compaction.** Executor tracks `usage.inputTokens /
capabilities.contextWindow`. At threshold (e.g., 80%), trigger
   `session.timeline.compact(strategy)` before next tick. Adopter
   writes zero glue.
2. **Multimodal rejection at the boundary.** Tree has `<Image>` block,
   model has `supportsImages: false`. Throw at project step before
   the API call. No mystery 400s.
3. **Tool-support validation.** Model declares no tool support, tree
   has `<Tool>`. Refuse mount or warn loudly.
4. **Cost-aware routing.** Adopters write knobs that route trivial
   follow-ups to cheaper models; framework exposes per-tick cost from
   adapter pricing metadata.
5. **Reasoning passthrough.** Adapters report `supportsReasoning:
true`; framework collects reasoning tokens, preserves Anthropic
   extended-thinking turns.

**Renames implied:**

- `@agentick/executor-openai-next` → `@agentick/openai` (adapter, not executor)
- (future) `@agentick/anthropic`, `@agentick/google`, `@agentick/vertex`
- `@agentick/model-executor-next` (currently scaffold + mock + defineExecutor) →
  also bundles the native executor impl that consumes `ModelAdapter`
- `@agentick/executor-ai-sdk-next` — stays, name fits

**Counter-argument considered:** adds indirection; each provider
impl is just an HTTP wrapper. Rebuttal: the layer IS the value.
Without it, every adopter rebuilds capability tracking, compaction
triggers, multimodal validation. v1 lacked a coherent compaction
harness — v2 has `session.timeline.compact()`, so capability-aware
policy now has somewhere to land.

**MVP scope when we pick this up:**

1. `@agentick/spec-next`: `ModelAdapter` interface + `ModelCapabilities`
2. `@agentick/model-catalog`: static table seeded with major models
3. `@agentick/model-executor-next`: native executor consuming `ModelAdapter`
4. ONE concrete adapter (likely `@agentick/anthropic` first — Claude
   is the assistant building the framework, dogfoods nicely)
5. `@agentick/executor-ai-sdk-next`: capability lookup via catalog
6. Rename: `executor-openai` → `openai` adapter
7. Update example/v2-real to use native + openai adapter

**Out of scope for MVP:** auto-compaction triggers, multimodal
validation, cost routing. Ship the metadata flow; the policy is
follow-up.

**Why deferred from FAÇADE.6:** the executor harness PROTOCOL
doesn't change to support either path. FAÇADE.6 (define\_\_\_ APIs)
is independent and unblocks immediately. Model-catalog/adapter is
its own pass; capture as a design note here, revisit after FAÇADE.6.

Tracked. Pick up after FAÇADE.6 lands.

### 2026-05-27 — Reconciler/reconciler-react split completed

After the initial extraction of `@agentick/compiler-next` (which only
moved `defineReconciler`), audit revealed ~3000 LOC of
reconciler-agnostic code still trapped in `@agentick/compiler-react-next`.
Smoking gun: `@agentick/session-next/src/session-bridges.ts` was importing
`InMemoryDataBridge` from `@agentick/compiler-react-next` — a
reconciler-agnostic Session reaching into a React-named package for a
generic ref impl.

**This pass: moved the reconciler-agnostic code into its proper home.**

Moved from `@agentick/compiler-react-next` → `@agentick/compiler-next`:

- `collect/` (~1800 LOC: walker + 18 contributors)
- `host/host-instance.ts` (163 LOC)
- `host/host-context.ts` (123 LOC)
- `host/container.ts` (48 LOC)
- `bridges/in-memory-data-bridge.ts` (226 LOC)
- `bridges/stub-bridges.ts` (375 LOC)
- `harness/lifecycle-store.ts` → `lifecycle-store.ts` (240 LOC)

Stayed in `@agentick/compiler-react-next` (truly React-coupled):

- `host/host-config.ts` (the react-reconciler HostConfig)
- `harness/reconciler-harness.ts` (the React reference impl)
- `react/` directory (hooks, components, JSX bindings)

Updated consumers in `@agentick/session-next`, `@agentick/gates-next`,
`@agentick/state-next`, `@agentick/subscriptions-next`, `@agentick/knobs-next`,
`@agentick/timeline-next`, `@agentick/sandbox`, `example/v2`. All now
import generic bridges/host/contributors from `@agentick/compiler-next`,
React-specific things from `@agentick/compiler-react-next`.

`@agentick/session-next/package.json` reconciler-react dep moved from
production `dependencies` to `devDependencies` (used only by tests).
The production code is now reconciler-agnostic at the package level —
matches its actual intent.

Cruft removed:

- `packages/reconciler-react/src/snapshot/` empty directory deleted
  (cruft since May 15)
- `packages/reconciler-react/src/index.ts` JSDoc updated; outdated
  "Phase 3 progresses" marker removed; index ~80 LOC smaller after
  moved exports dropped
- Empty `host/`, `harness/`, `bridges/`, `collect/` directories in
  reconciler-react cleaned up (those that became empty after moves)

Per CLAUDE.md "no backwards compat" — moved symbols are NOT
re-exported from `@agentick/compiler-react-next`. Consumers retargeted
to the canonical package.

**Verification:** workspace typecheck clean across 87 packages.
5314/5314 effective tests pass; 2 pre-existing executor-ai-sdk msw
failures unchanged.

**Reflected dependency graph (production-code only, excluding tests):**

```
@agentick/spec-next
  ↑
@agentick/runtime-next          (substrate primitives)
  ↑
@agentick/compiler-next       (IR collection + bridges + lifecycle)
  ↑
@agentick/compiler-react-next (React-specific binding)
  ↑
@agentick/session-next, gates, knobs, state, timeline, sandbox, subscriptions
  ↑
@agentick/app-next
```

Sessions no longer reach through React to get bridges. Future Angular
or Vue reconcilers depend on `@agentick/compiler-next`, not the
React-named package. The dependency graph reflects the architecture.

### 2026-06-02 — Streaming adapter benchmarks

Baseline measurements **before** any streaming-aggregation refactor.
Three new bench files drive each provider adapter end-to-end against
its stub client across deterministic canned response sequences. The
bench wraps `executor.run({ compiled, target })` with `stream: true`
so every iteration exercises the full hot path: chunk iteration →
`mapChunk` → `emitDeltaLazy` (Effect.runPromise per delta) → stream
accumulator + in-loop block-state map → `normalize()`.

Files:

- `packages/executor-openai/src/__bench__/streaming.bench.ts`
- `packages/executor-anthropic/src/__bench__/streaming.bench.ts`
- `packages/executor-google/src/__bench__/streaming.bench.ts`

Bench commands:

```
pnpm vitest bench --run packages/executor-openai/src/__bench__/streaming.bench.ts
pnpm vitest bench --run packages/executor-anthropic/src/__bench__/streaming.bench.ts
pnpm vitest bench --run packages/executor-google/src/__bench__/streaming.bench.ts
```

Vitest 4.0.18, Node default workspace. Each row reports per-`run()`
mean ± relative-margin-of-error (rme) for that scenario, sample
count, and the derived per-delta cost (mean ÷ delta count, μs).
Per-`run()` numbers include a small fixed setup cost (~0.25 ms:
fresh `MemoryJournal` / `LocalEventBus` / `LocalInbox`,
`new Executor(...)`, `await ready`); to back out per-delta cost we
take `(mean@1000 − mean@100) / 900` for the no-subscriber path.

#### Per-`run()` end-to-end (ms, mean ± rme)

| Scenario                            | OpenAI        | Anthropic     | Google         |
| ----------------------------------- | ------------- | ------------- | -------------- |
| 1000 text deltas, no subscriber     | 2.271 ± 4.89% | 1.899 ± 5.83% | 1.881 ± 4.05%  |
| 100 text + 1 tool_call, no sub      | 0.355 ± 4.52% | 0.349 ± 3.96% | 0.284 ± 3.35%  |
| 100 text deltas, no subscriber      | 0.291 ± 3.52% | 0.351 ± 3.50% | 0.270 ± 2.67%  |
| 100 text deltas, 1 drain subscriber | 2.261 ± 3.93% | 2.515 ± 4.38% | 2.660 ± 19.36% |

Sample counts: 199–1853 depending on iteration speed (vitest
auto-paces to a ~600 ms wall budget per bench).

#### Derived per-delta cost (μs)

Computed as `(mean@1000 − mean@100) / 900` for the no-subscriber
text-only path (cancels fixed setup):

| Adapter   | Per-delta cost, no subscriber |
| --------- | ----------------------------- |
| OpenAI    | ~2.20 μs                      |
| Anthropic | ~1.72 μs                      |
| Google    | ~1.79 μs                      |

Subscriber overhead at the same 100-delta workload (`mean@1sub −
mean@nosub`, divided by 100 deltas) — this is the cost of the lazy
build closure actually running + `LocalEventBus` fan-out + an
`Effect.runPromise` round-trip per delta into the subscriber fiber's
queue:

| Adapter   | Subscriber overhead per delta |
| --------- | ----------------------------- |
| OpenAI    | ~19.7 μs                      |
| Anthropic | ~21.6 μs                      |
| Google    | ~23.9 μs                      |

The subscriber path adds roughly an order of magnitude on top of the
no-subscriber base. Whatever cost emitDeltaLazy currently pays at
the `bus.publishLazy` _no-listener_ short-circuit is small (≈1.7 μs
to 2.2 μs per delta covers chunk-mapping, accumulator updates, AND
the lazy emit); the moment a subscriber is attached, the bulk of the
hot-path time moves into the bus fan-out + Effect-fiber scheduling.

#### Observations

1. **The three adapters are within ~30 % of each other at the
   no-subscriber baseline** despite materially different parser
   shapes. The dual-walk pattern (per-block `Map<number, BlockState>`
   in the streaming loop **plus** `StreamAccumulator` **plus** a
   third pass in `normalize()`) that OpenAI and Anthropic carry is
   measurable but small — Google's single-pass `StreamAccumulator`
   path saves ~0.4 μs per delta over OpenAI and ~0.1 μs over
   Anthropic in this workload. That is real but it is not where the
   wall-clock time lives.

2. **Anthropic is slightly faster than OpenAI per delta** even
   though it does the dual-walk too. Likely explanation: Anthropic's
   per-event payload from the SDK is leaner (one delta = one
   `text_delta` event with a known `index`), whereas OpenAI's
   per-chunk shape requires walking
   `choices[0].delta.{content,tool_calls,…}` discriminated unions
   and reassembling tool-call streaming across `index` + partial
   `arguments` slices.

3. **Per-delta `Effect.runPromise` cost dominates only when there
   is a subscriber.** With no subscriber the lazy short-circuit
   inside `bus.publishLazy` skips the envelope-build closure and
   the publish loop entirely, so the only Effect cost is the
   one-call entrance from the executor's main loop into the
   substrate. That accounts for the surprisingly low ~1.7-2.2 μs
   per delta. Attach a subscriber and the cost jumps ~10×, almost
   entirely fan-out / fiber-queue / subscriber-side runtime work —
   not the executor's accumulator design.

4. **Tool-call streams cost almost the same as text-only at 100
   deltas.** Google is fastest here (0.284 ms) because its
   `functionCall` arrives as a single chunk with structured `args`
   already parsed — no `input_json_delta` accumulation, no
   `JSON.parse` on block-stop. Anthropic (0.349 ms) and OpenAI
   (0.355 ms) pay for streamed-argument reassembly + a `JSON.parse`
   at finalization, but at ~5 events of overhead this is invisible
   against the 100 text deltas.

5. **The Google "1 subscriber" rme is wide** (±19.36 %), driven by
   a single outlier sample at 46.45 ms. p75 is 2.37 ms (in line
   with the no-outlier expectation). Likely GC pause; rerunning
   should converge. Not a real regression vs the other two
   adapters.

Headline number to take into any refactor decision: the
no-subscriber per-delta cost is **~2 μs** across all three adapters.
A refactor that eliminates one of the two aggregation walks in
OpenAI/Anthropic should target a fraction of that 2 μs — best case,
moves OpenAI/Anthropic to Google's ~1.7 μs. The big lever is _not_
the dual-walk, it is the subscriber fan-out path (currently ~20 μs
per delta). If we want streaming throughput to go up by more than
~15 %, that is the path to attack.
