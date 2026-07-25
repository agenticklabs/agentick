/**
 * `ClientHandle` — the unified contract every client sub-handle converges to
 * (B2, `docs/proposals/v2/client-handles.md`). A handle is nouns + verbs over
 * one server-side resource: a mandatory thin READ core (`subscribe`), declared
 * capability PROFILES ({@link Enumerable} / {@link Respondable}), and per-domain
 * WRITE verbs (each a derived wire command). Thin on purpose — the store.md
 * lesson: only the genuinely handle-agnostic surface lives in the core; the
 * fold/view above it is domain-specific and designed, not templated.
 *
 * This slice ships ONLY the contract types + the conformance suite
 * (`@agentick/client-core/testing`). No existing handle is refactored onto
 * it yet (rollout §8 slices 3+); this file is the standard those refactors
 * converge to.
 *
 * ## The design principles these types encode (verbatim from the B2 review)
 *
 * 1. **operator-vs-app defaults / keys-readable-without-docs / seam-vs-projection
 *    placement** — "The three review principles apply: keys readable without
 *    docs; operator-vs-app defaults; seam-vs-projection placement." (§8b)
 * 2. **interceptors transform the TRUTH; projections transform a VIEW** —
 *    "interceptors transform the TRUTH (one canonical result — model, store, and
 *    client all see it); projections transform a VIEW (one audience's copy at the
 *    egress boundary). Anything audience-specific — client truncation
 *    (`truncateToolResults`), redaction-for-clients, per-client shaping — is a
 *    projection, never an interceptor." (§2)
 * 3. **iterate BOUNDED, observe UNBOUNDED** — "PRINCIPLE: iterate BOUNDED things
 *    (run.events() — a run ends); observe UNBOUNDED things (onChange). Async
 *    iteration survives ONLY on finite streams; no session-lifetime handle is
 *    iterable." (§3) This is why NO handle is `AsyncIterable`: `Streamable` was
 *    REMOVED from the contract — a handle is nouns + verbs, not also a stream you
 *    drink from.
 * 4. **contracts are floors, not ceilings** — "contracts are floors, not
 *    ceilings — we take what we need from what the user gives, they can give
 *    more." (Ryan, principle #5) The interfaces below are PLAIN STRUCTURAL
 *    shapes: no branding, no registration to qualify. Satisfying the shape IS
 *    conforming — and a handle MAY carry anything else it likes (ten extra
 *    methods, extra fields on its items). Nothing here asserts "only these
 *    members." The framework asks for the minimum it needs; the application can
 *    give more, and everything of theirs rides through untouched. The ONLY data
 *    the framework ever strips is its OWN reserved security fields, by name (the
 *    `executedBy` precedent) — never a "no-extra-keys" shape check.
 *
 * @see docs/proposals/v2/client-handles.md
 * @see isSnapshotCapable — the feature-detection precedent this mirrors
 */

import type { Unsubscribe } from "@agentick/spec";

// ============================================================================
// MANDATORY CORE — every handle, no exceptions. Thin on purpose (store.md).
// ============================================================================

/**
 * The mandatory core every client handle implements. Deliberately minimal: a
 * single change-notification `subscribe` plus optional teardown.
 *
 * `subscribe(cb)` is THE store contract (Ryan 2026-07-22): it fires on change,
 * the callback takes NO arguments, and the caller reads the current value via
 * the handle's own read surface ({@link Enumerable.list}, a domain getter, …).
 * This shape makes every framework binding zero-adapter — a handle drops
 * straight into `useSyncExternalStore(h.subscribe, h.list)` with no wrapper.
 *
 * This is a plain structural interface (principle #4 — floors, not ceilings): a
 * value conforms by having a `subscribe` of this shape; it may carry any other
 * members. There is no brand and no registration.
 */
export interface ClientHandle {
  /**
   * Register a change listener. Fires whenever the handle's state/feed changes;
   * `cb` receives NO arguments — read the current state via the handle's read
   * surface. Returns an {@link Unsubscribe} that detaches the listener without
   * tearing down the underlying subscription.
   */
  subscribe(cb: () => void): Unsubscribe;
  /** Tear down the underlying subscription, where the handle owns one. */
  close?(): void;
}

// ============================================================================
// CAPABILITY PROFILES — declared (typed) + feature-detected (conformance).
// ============================================================================

/**
 * The handle exposes its current materialized STATE (not merely an event feed):
 * the full list and a by-id lookup. `list()` always means "current state,
 * including what happened before I connected" — the live-only fix. A client that
 * connects mid-ask still sees the pending ask via `list()`.
 *
 * A profile the way {@link ClientHandle} is a core: plain structural, no brand.
 * Declared on a handle's type for the typed path AND feature-detectable via
 * {@link isEnumerable} (the `isSnapshotCapable` precedent).
 *
 * Note `iterate BOUNDED, observe UNBOUNDED` (principle #3): `list()` is a
 * bounded synchronous snapshot; ongoing change arrives through
 * {@link ClientHandle.subscribe}, never by making the handle `AsyncIterable`.
 */
export interface Enumerable<T, Id = string> {
  /** The current state as a bounded snapshot — includes pre-connection items. */
  list(): readonly T[];
  /** Look one item up by id; `undefined` when absent. */
  get(id: Id): T | undefined;
}

/**
 * The handle answers correlated inbound requests by id (elicitations, client
 * tool calls). `respond(id, input)` routes the reply through the handle's wire
 * command; a per-item convenience (`e.accept(value)`) threads the same id.
 *
 * Plain structural profile — declared for the typed path, feature-detectable via
 * {@link isRespondable}.
 */
export interface Respondable<In> {
  /** Reply to the correlated request addressed by `id`. */
  respond(id: string, input: In): Promise<void>;
}

// ============================================================================
// Feature detection — the runtime twin of the typed declaration.
// ============================================================================
//
// Mirrors `isSnapshotCapable` (`@agentick/spec`): the typed declaration on
// a handle's protocol is the compile-time path; these duck-typers are the
// runtime path the conformance suite and generic tooling use to pick a handle's
// profiles up without hardcoded knowledge. They test ONLY that the required
// members are callable — NEVER that no others exist (principle #4).

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object";
}

/** Duck-type for {@link ClientHandle} — has a callable `subscribe`. */
export function isClientHandle(x: unknown): x is ClientHandle {
  return isObject(x) && typeof x.subscribe === "function";
}

/** Duck-type for {@link Enumerable} — has callable `list` + `get`. */
export function isEnumerable<T = unknown, Id = string>(x: unknown): x is Enumerable<T, Id> {
  return isObject(x) && typeof x.list === "function" && typeof x.get === "function";
}

/** Duck-type for {@link Respondable} — has a callable `respond`. */
export function isRespondable<In = unknown>(x: unknown): x is Respondable<In> {
  return isObject(x) && typeof x.respond === "function";
}
