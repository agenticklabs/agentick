# ADR 27 — Modular built-ins: one pattern for everything on the substrate

**Status:** Active · 2026-05-26
**Builds on:** ADR 26 (Harness as the single shape)
**Touches:** `@agentick/spec-next/protocol/hook-bridges.ts`, every built-in harness package (timeline, knobs, state, gates, data, ...), `@agentick/reconciler-react-next`, the public `agentick` metapackage, the test layout across the workspace.

## TL;DR

**Built-in extensions are not "built in." They are _bundled_.** They follow the identical architectural pattern as optional extensions; the only difference is whether the public metapackage (`agentick`) bundles them. There is no special-case code path for "foundational" vs "optional" — same shape, same wiring, same lifecycle.

This is the lever that unlocks real modularity. Without it, you get a framework that _talks_ modular while _coding_ monolithic, and you hit a wall every time you try to layer something cleanly.

## Amendment — 2026-07-01: the behavioral corollary — harnesses are the behavior; bindings are projections

The package mechanics below (harness packages own their `/react`
subpath; reconciler-react has no harness deps) have a behavioral
principle behind them that this amendment makes explicit doctrine:

**The harness is the single source of behavior. Framework components
are thin, cross-platform projections of the harness protocol — never
the home of policy.** A React `<Timeline>` and an Angular `Timeline`
component wrap the same `TimelineHarnessProtocol` bridge; parity across
frameworks comes from the protocol, not from reimplementation. The
litmus test for any binding component: **it must contain no behavior
that isn't reachable through the protocol without it.** If a component
needs a capability the protocol lacks, the capability goes into the
harness first; the component stays a projection.

Consequences:

1. **One protocol, every origin — commands are RPC over the actor
   substrate.** Because harnesses ride the substrate (`scopeId` =
   address, inbox = mailbox, `handleMessage` = receive, Operation
   envelope = command protocol), the same operation is invocable as a
   **command message — verb + target + serializable payload** — from
   any origin: host code (`session.timeline.compact()`), app-internal
   logic in the rendered tree, another process/node (inbox addressing
   under cluster), or a wire client (via a projecting wire extension,
   ADR 46). Identical envelopes, audit, and idempotency regardless of
   origin; the harness is origin-indifferent.
   **The load-bearing invariant: the wire carries verbs + serializable
   data, never executable configuration.** Strategies, predicates, and
   validators are construction-bound and server-resident. A remote
   command *triggers* the target's configured behavior (no-arg signal
   form — `compact` resolved by the session's `withTimeline({ compact })`
   default) and may carry *advisory data* (e.g. compaction
   `instructions`, which the resident strategy is authoritative to
   honor or ignore); it never supplies the function. Function-arg call
   forms are in-process-only overrides (inner-scope-wins at the call
   site). Same boundary as credentials-never-cross-wire; RCE-safe by
   construction. Corollary: **an op with a required function parameter
   is unaddressable — give it a construction-bound default and a
   signal form, and it joins the addressable set.**
   **Guardrail: addressable ≠ authorized.** The substrate makes every
   op reachable; which verbs project to clients (curated wire
   extensions) and which principal may address which target
   (auth/ADR 48 + the authorization architecture, ADR 51) are separate
   policy layers enforced at the projection boundary — never inside
   the harness.
2. **Host-injected policy vs. tree-owned policy — inner scope wins.**
   A host-level strategy slot (`withTimeline({ compact })`) is a
   *default*; a tree-level component that claims the concern overrides
   it — the same outer-scope-default / inner-scope-override semantics
   as the extension cascade (ADR 50 amendment §2). Controlled vs.
   uncontrolled, with a deterministic rule.
3. **Executable strategy values are portable across altitudes.** A
   configured strategy (`rollingSummary({ ... })`) is one first-class
   value usable in the host slot, as a component prop, or composed
   inside app logic. Policies never fork per mounting point.
4. **The harness seam is the capability-independent floor.** Framework
   bindings vary in richness (React has components/context/lifecycle;
   the ADR 44 functional reconciler has less; a template reconciler
   has none). Any concern that must work across all reconcilers is
   expressed at the harness/strategy seam; binding components are
   per-framework sugar. This is also why the depless-reconciler path
   stays cheap: the power was never in React.

## The mistake this corrects

Through ADR 26 we built `KnobsHarness`, `StateHarness`, `TimelineHarness` as full harnesses in their own packages. We added `SandboxHarness` as an optional extension with its own augmentation pattern (`@agentick/sandbox/v2/augment.ts` adds the `sandbox` slot to `HookBridges`).

But for the foundational ones we left their slots **hardcoded in `@agentick/spec-next/protocol/hook-bridges.ts`**:

```ts
export interface HookBridges {
  readonly timeline: TimelineHarnessProtocol; // hardcoded
  readonly knobs: KnobsHarnessProtocol; // hardcoded
  readonly state: StateHarnessProtocol; // hardcoded
  // sandbox / mcp / subscriptions / ... come in via TS module augmentation
}
```

This asymmetry felt natural — "of course timeline is built in." But it caused real problems:

1. **`@agentick/reconciler-react-next` had to import `TimelineHarness`** (to construct stubs, to do `instanceof` checks on bridges, to use the harness types). That made reconciler-react depend on timeline.
2. **`@agentick/timeline-next` therefore could not have a `/react` subpath** that imports `useBridges` from reconciler-react — workspace cycle.
3. **Tests of "knobs work with the reconciler" lived in `reconciler-react/__tests__/`** because that's where the reconciler lived. These tests used real harnesses, which meant reconciler-react had test-time deps on the harness packages — same cycle.
4. **Each new optional package risked hitting the same wall** if reconciler-react ever needed to know about it.

The "special status" for foundational harnesses meant they couldn't follow the modular pattern the framework was supposed to demonstrate.

## The decision

**Foundational and optional follow the IDENTICAL pattern.** The framework defines one mechanism for putting a thing on the substrate; built-ins are just the things the metapackage happens to bundle.

### The pattern (uniform)

Every harness that lives on the substrate has the same shape:

```
@agentick/<harness>/
  src/
    harness.ts          — the BaseHarness implementation
    protocol.ts         — types (or in @agentick/spec-next — TBD per case)
    augment.ts          — declare module "@agentick/spec-next" to add the slot
    extension.ts        — the withX() SessionExtension factory
    index.ts            — exports + side-effect import of ./augment.js
    conformance.ts      — runXHarnessConformance() suite

    react/              — OPTIONAL framework-specific React surface
      index.ts          — useX, <X>, etc.

    testing/            — OPTIONAL stub factory for tests
      index.ts          — stubXHarness({...})

    __tests__/
      harness.spec.ts                       — tests the harness itself
      integration-with-reconciler.spec.ts   — tests this harness wired
                                              into the reconciler
```

**Each harness owns its full vertical:**

- Its own harness implementation
- Its own augmentation declaration (registers its `HookBridges` slot)
- Its own React surface (if any)
- Its own stub factory for tests
- Its own tests, including the integration with the reconciler

### `@agentick/spec-next` has NO hardcoded harness slots

```ts
// packages/spec/src/protocol/hook-bridges.ts
export interface HookBridges {
  // Empty seed. All slots come from augmentation in their respective
  // harness packages. Spec stays neutral about what's on the substrate.
}
```

Every harness's `augment.ts` adds its slot:

```ts
// packages/timeline/src/augment.ts
import type { TimelineHarnessProtocol } from "@agentick/spec-next";

declare module "@agentick/spec-next" {
  interface HookBridges {
    readonly timeline: TimelineHarnessProtocol;
  }
}
```

Importing the harness package (which the metapackage and any session does) loads the augmentation as a side effect. Consumers see the slot. The augmentation is required for built-ins (no `?:`), optional for optional extensions (`sandbox?:`).

### `@agentick/reconciler-react-next` has NO harness deps

```
Before:
  reconciler-react → knobs, state, timeline (value imports for stubs + types)
  timeline cannot add /react (cycle)

After:
  reconciler-react → spec, runtime, formatters, tool, react. THAT'S IT.
  Any harness package can add /react subpath safely (one-way dep).
```

The reconciler accesses bridges via `Object.entries(bridges)` and feature-detection (`SnapshotCapable` marker interface), not via hardcoded slot names. It doesn't know whether a given `HookBridges` happens to have `timeline` on it; it just iterates whatever's there.

The reconciler still hosts the `InMemoryDataBridge` (the reference `DataBridge` impl) and the `BridgeContext` / `BridgeProvider` / `useBridges` (the React glue). It does NOT host any harness-specific hook or component.

### Tests of "X works with the reconciler" live with X

```
Before:
  packages/reconciler-react/__tests__/knobs.spec.tsx    ← wrong home
  packages/reconciler-react/__tests__/timeline.spec.tsx ← wrong home
  packages/reconciler-react/__tests__/state.spec.tsx    ← wrong home

After:
  packages/knobs/src/__tests__/integration-with-reconciler.spec.tsx
  packages/timeline/src/__tests__/integration-with-reconciler.spec.tsx
  packages/state/src/__tests__/integration-with-reconciler.spec.tsx

  packages/reconciler-react/__tests__/  ← tests ONLY the reconciler.
                                           Uses protocol mocks when
                                           bridges are needed.
```

The asymmetry that drives this: **integration tests should live where the deps are.** A "knobs + reconciler" test naturally depends on both. The package that already depends on both is `@agentick/knobs-next` (it adds `@agentick/reconciler-react-next` as a dep when it needs `useBridges`). Reconciler-react does not — and cannot — depend on knobs.

Cross-harness integration tests (e.g., "snapshot a session with knobs + state + timeline") live in `@agentick/session-next` (which depends on all of them) or in a top-level integration test harness in the public metapackage.

### Shipping model

```
Built-in (private, bundled):
  @agentick/timeline-next   ← private: true
  @agentick/knobs-next      ← private: true
  @agentick/state-next      ← private: true
  @agentick/gates-next      ← private: true
  (etc.)

         ↓ all bundled by ↓

  agentick   ← public metapackage; what adopters install

Optional extension (public, standalone):
  @agentick/sandbox    ← public; adopters install separately
  @agentick/mcp        ← public; adopters install separately
  (etc.)
```

**The pattern is identical between them.** The shipping difference is a packaging concern, not an architectural one. Optional packages don't need to "opt out" of anything; built-in packages don't get special privileges. They just have different release pipelines.

This proves the extension design by applying it uniformly. If a new optional extension needs the same wiring as timeline, it gets it the same way — no special case to learn.

## Why this matters

### Modularity becomes real, not aspirational

The framework's pitch is "everything is a harness on a shared substrate." If timeline is hardcoded in spec while sandbox augments, that pitch is half-true. With this change, it's wholly true.

### Adding a new built-in is the same as adding an optional extension

Want to add a new built-in? Create a private package, give it `harness.ts` / `augment.ts` / `extension.ts` / `index.ts`. Add `/react` and `/testing` if it has them. Add to the metapackage bundle list. Done.

Want to add an optional extension? Same shape, public package, no metapackage bundling. Done.

No two-track architecture to learn.

### Tests prove the modularity

When every harness's "works with the reconciler" test lives in the harness package, the harness IS the testable unit. Pulling timeline out (say, an adopter doesn't want it) doesn't break reconciler-react's tests — because reconciler-react's tests don't depend on timeline. The decoupling is real.

### Future-safe for any extension

The cycle wall we kept hitting was a symptom: any package reconciler-react depended on couldn't add a `/react` subpath. With the cleanup, no package is in that bind. Any future extension — built-in or optional — can have a React surface without architectural surgery.

## Implementation specifics

### `SnapshotCapable<TSnapshot>` interface

A marker interface in `@agentick/spec-next` for harnesses with snapshot capability:

```ts
export interface SnapshotCapable<TSnapshot = unknown> {
  exportSnapshot(): TSnapshot;
  importSnapshot(snapshot: TSnapshot, options?: unknown): void | Promise<void>;
}
```

Harness protocols extend this when they support snapshot/restore:

```ts
export interface KnobsHarnessProtocol extends SnapshotCapable<
  Readonly<Record<string, KnobPrimitive>>
> {
  // ...
}
```

### Typed cross-harness snapshot

`ReconcilerSnapshot` uses a mapped type over `HookBridges`:

```ts
export interface ReconcilerSnapshot {
  // ...
  readonly bridges: {
    readonly [K in keyof HookBridges]?: HookBridges[K] extends SnapshotCapable<infer S> ? S : never;
  };
}
```

Augmentation-friendly: every harness that augments `HookBridges` and extends `SnapshotCapable<T>` automatically gets its snapshot type included. No central registry, no manual updates.

### Generic snapshot iteration

Reconciler-harness snapshot/restore:

```ts
async snapshot(input): Promise<ReconcilerSnapshot> {
  const out: Record<string, unknown> = {};
  for (const [name, bridge] of Object.entries(state.bridges)) {
    if (isSnapshotCapable(bridge)) {
      out[name] = bridge.exportSnapshot();
    }
  }
  return { ..., bridges: out as ReconcilerSnapshot["bridges"] };
}
```

No hardcoded names. Adding a new harness with snapshot support requires zero reconciler changes.

### Per-harness `/testing` subpath

Each built-in exports a stub factory:

```ts
// @agentick/timeline-next/src/testing/index.ts
export function stubTimelineHarness(initial?: readonly TimelineEntry[]): TimelineHarness {
  // constructs the harness against in-memory substrate
}
```

Adopters' tests:

```ts
import { stubTimelineHarness } from "@agentick/timeline-next/testing";
import { stubKnobsHarness } from "@agentick/knobs-next/testing";
// ...
```

Or, for convenience, the metapackage composes them:

```ts
// agentick/testing
export { stubTimelineHarness } from "@agentick/timeline-next/testing";
export { stubKnobsHarness } from "@agentick/knobs-next/testing";
// ...
export function stubBridges(options?: StubBridgesOptions): HookBridges {
  /* composes */
}
```

Adopters who want the convenience use `agentick/testing`; adopters who want minimal imports use per-harness `/testing`.

## What does NOT change

- ADR 26 (harness shape, substrate, Operation lifecycle, journal/bus/inbox, etc.) is untouched.
- The harness IMPLEMENTATIONS themselves don't change.
- The runtime behavior is identical — only type plumbing + test layout move.
- v2 spec primitives (Operation, journal, etc.) stay in spec.

## Considered and rejected

### Decompose `@agentick/reconciler-react-next` into `@agentick/reconciler-next` (core) + `@agentick/reconciler-react-next` (React adapter)

This would mirror the convention that "X-react packages depend on X core packages." It's structurally cleaner — would allow a future Angular or Vue reconciler frontend without disturbing the React one.

**Deferred.** The conflation of "JSX → IR pipeline" and "React-specific hooks/components" inside reconciler-react is a real future debt, but the augmentation refactor delivers the modularity story without resolving it. When a second reconciler frontend ships (Angular, Vue, vanilla), that's when the split happens.

### Move `InMemoryDataBridge` to its own `@agentick/data` package

Considered when we were chasing the cycle through stub-bridges. With the augmentation approach + generic snapshot, reconciler-react doesn't need to import any harness package — so InMemoryDataBridge can stay where it is (reconciler-react) as the reference DataBridge implementation. No extraction needed; the package would be a leaf with a single class and one type, awkwardly narrow.

If a future need (e.g., a durable DataBridge variant) emerges, the extraction is mechanical at that point.

### Put `stubBridges()` in a dedicated `@agentick/in-memory-bridges` package

Considered when we were chasing the cycle. With the augmentation refactor, the central convenience naturally lives in the public metapackage (`agentick/testing`), which already depends on all built-ins. Adopters who want it import from there; adopters who want minimal imports use per-harness `/testing` subpaths directly.

### Keep tests in `@agentick/reconciler-react-next/__tests__/` and rewrite them to use protocol mocks

This is the principled answer for tests that are TRULY reconciler unit tests. We do this where appropriate. But: tests that exist to verify "knobs work with the reconciler" are not reconciler unit tests — they're knobs-integration tests, and they belong in `@agentick/knobs-next`. Rewriting them with mocks just hides the true ownership.

## Where this writes down

This ADR is intended to be **foundational**. Any agent or contributor working on v2 should encounter the principles immediately:

1. **`CLAUDE.md`** at repo root carries the principles in summary (loaded into every conversation context). It links to this ADR.
2. **`STATUS.md`** records this as the active architectural direction.
3. **`docs/proposals/v2/blueprint/00-overview.md`** (the v2 entry point) references this ADR alongside ADR 26.
4. **Per-package `README.md`** files describe each package's role in the modular pattern.

If you're an agent reading this for the first time: the framework's modularity is real. Built-ins are bundled, not privileged. Same pattern, all the way down.
