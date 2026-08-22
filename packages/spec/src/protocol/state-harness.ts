/**
 * StateHarnessProtocol — session-internal reactive K/V storage.
 *
 * The "adopter stash" — typed key-value bag backing the
 * `useSessionState(key, initial)` hook. NOT model-visible: the
 * executor's `knob_set` tool doesn't reach here, and `list()` returns
 * `{ key, value }` entries for framework / debug use only.
 *
 * Per ADR 26, this is a full harness — identity, lifecycle, substrate,
 * inbox addressability, journaled write Operations. Sync reads + async
 * writes; envelopes flow through the bus + journal.
 *
 * Sibling of {@link KnobsHarnessProtocol}, but without descriptor
 * metadata, model-visibility, or validation pipeline. Just storage.
 * KnobsHarness composes a StateHarness internally for its value cells;
 * adopters use this directly for everything else they want to stash.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D1
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import type { Effect } from "effect";

import type { Unsubscribe } from "./inbox.js";
import type { HarnessFx } from "./middleware.js";
import type { HarnessEdge } from "./promise-view.js";
import type { SubstrateError } from "../data/errors.js";

// ============================================================================
// Operation inputs
// ============================================================================

export interface StateSetInput {
  readonly key: string;
  readonly value: unknown;
}

export interface StateDeleteInput {
  readonly key: string;
}

/**
 * One row of {@link StateHarnessProtocol.list} — a `{ key, value }` entry, the
 * same projection depth as the sibling collection handles (knobs descriptors,
 * skills records). `list()` returns entries, not bare keys, so a caller (and the
 * wire `state:list` projection) sees values without a follow-up `get` per key.
 */
export interface StateListEntry {
  readonly key: string;
  readonly value: unknown;
}

// ============================================================================
// Async surface — the Effect-canonical twin (`.fx`)
// ============================================================================

/**
 * The state harness's **canonical** async surface (ADR 77): the composable
 * Effect twins of its declared WRITE commands. Each returns the operation
 * Effect un-run, so an in-process caller composes it with `yield*` and stays
 * in one fiber tree — which is what keeps the ambient `tickId` / `parentOpId`
 * on the resulting op. The Promise methods on
 * {@link StateHarnessProtocol} are the derived edge facade.
 *
 * `state:get` / `state:list` are declared commands too (they are reachable
 * over the wire) but are deliberately ABSENT here: the protocol serves those
 * reads from local state as SYNC accessors, and a Promise-returning `get`
 * derived from an Fx member would collide with the sync one. The Fx twin
 * covers what MUTATES.
 *
 * `E` is `SubstrateError` — the handlers are pure (`Effect.sync`), so the only
 * failure mode is the substrate's own (vetoed / journaled / lifecycle).
 */
export interface StateFx extends HarnessFx {
  /**
   * Set a value. Goes through `runOperation` — emits
   * `state:command:set:requested → :terminal` envelopes; addressable
   * via inbox. Replays the cached terminal when called twice with the
   * same `opId`.
   */
  set(input: StateSetInput): Effect.Effect<void, SubstrateError, never>;

  /** Delete a key. Same Operation contract as {@link set}. */
  delete(input: StateDeleteInput): Effect.Effect<void, SubstrateError, never>;
}

// ============================================================================
// Protocol
// ============================================================================

export interface StateHarnessProtocol extends HarnessEdge<StateFx> {
  /**
   * Harness identifier. Composes into the inbox address as
   * `state:{id}` — admin actors send mutations addressed here.
   */
  readonly id: string;

  /**
   * Resolves once the harness has finished its async construction
   * (inbox registration).
   */
  readonly ready: Promise<void>;

  // ─────────── Sync surface (local accessors) ───────────

  get(key: string): unknown;
  has(key: string): boolean;
  /** Every entry as `{ key, value }` (family projection depth, not bare keys). */
  list(): readonly StateListEntry[];

  /** Notify when the value at `key` changes. */
  subscribe(key: string, listener: () => void): Unsubscribe;

  /** Notify when ANY entry's value changes (including deletes). */
  subscribeAll(listener: () => void): Unsubscribe;

  // ─────────── Async surface (Operations) ───────────
  //
  // BOTH faces come from `HarnessEdge<StateFx>`: `set` / `delete` as the
  // Promise facade, and `fx` as the Effect-canonical twin. An in-process
  // caller composes `state.fx.set(...)` and stays in the calling fiber, so the
  // op carries the ambient tick; only the adopter edge takes the Promise face.

  // ─────────── Construction seed ───────────

  /**
   * Install caller-supplied entries — the construction seed
   * (`withState({ initial })`, `CreateSessionInput.initialState`). UPSERT, not
   * replace: a key the seed does not name keeps whatever `hydrate` loaded.
   */
  seed(values: Readonly<Record<string, unknown>>): void;

  // ─────────── Lifecycle ───────────

  close(): Promise<void>;
}
