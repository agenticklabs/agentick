/**
 * KnobsHarnessProtocol — model-visible reactive state as a harness.
 *
 * Per ADR 26 ("Harness as the single shape"), what v2 previously called
 * a "knob bridge" is a full harness — identity, lifecycle, substrate,
 * inbox addressability, journaled write Operations. The protocol mixes
 * synchronous local accessors (reads, subscriptions) and async
 * Operations (writes, registration).
 *
 *   Sync surface   — high-frequency, latency-sensitive, served from
 *                    local state. No envelope emission.
 *   Async surface  — writes go through `runOperation`. Emit `requested
 *                    → terminal` envelopes through the substrate.
 *                    Addressable from outside the process via the
 *                    inbox at `knobs:{scopeId}`.
 *
 * The Operation envelope IS the change-event audit trail; consumers
 * subscribe to `bus.subscribe({ surface: "knobs", phase: "terminal" })`
 * to see every mutation.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import type { HarnessFx } from "./middleware.js";
import type { Effect } from "effect";
import type { ContentBlock } from "../data/content-blocks.js";
import type { SubstrateError } from "../data/errors.js";
import type { Unsubscribe } from "./inbox.js";
import type { HarnessEdge } from "./promise-view.js";
import type { KnobDescriptor, KnobPrimitive, KnobRegistration } from "./hook-bridges.js";

// ============================================================================
// Operation inputs
// ============================================================================

export interface KnobsSetInput {
  readonly id: string;
  readonly value: KnobPrimitive;
}

export interface KnobsRegisterInput {
  readonly id: string;
  readonly descriptor: KnobRegistration;
}

/**
 * Input to `dispatch` — model-equivalent of the `knob_set` tool call.
 * Either `name` (set one knob) or `group` (batch-set every knob in
 * the group), not both. Validation pipeline matches v1: exactly-one
 * check → exists → type → options → bounds → length/pattern → custom
 * `validate`.
 */
export interface KnobsDispatchInput {
  readonly name?: string;
  readonly group?: string;
  readonly value: KnobPrimitive;
}

// ============================================================================
// Errors
// ============================================================================

/** Migrated to class hierarchy (ADR 41). Re-exports from `../errors/harnesses.js`. */
export {
  GroupEmpty,
  GroupTypeMismatch,
  InvalidDispatchInput,
  KnobsError,
  type KnobsErrorChannel,
  UnknownKnob,
  ValidationFailed,
} from "../errors/harnesses.js";

// ============================================================================
// Async surface — the Effect-canonical twin (`.fx`)
// ============================================================================

/**
 * The knobs harness's **canonical** async surface: the composable Effect
 * twins of its declared write commands (ADR 77, the dual-typed edge).
 * Each method returns the operation Effect un-run, so an in-process
 * caller composes it with `yield*` and stays in one fiber tree —
 * exposed as `knobs.fx`. The plain Promise methods on
 * {@link KnobsHarnessProtocol} are the derived edge facade
 * ({@link PromiseView} of this), `runPromise` applied at the boundary.
 *
 * The `E` channel is `SubstrateError` — knobs' handlers are pure
 * (`Effect.sync`), so the only failure mode is the substrate's own
 * (vetoed / journaled / lifecycle). Validation failures are NOT `E`:
 * `dispatch` reports them as `ContentBlock[]` (the `knob_set` contract),
 * so they ride the success channel.
 */
export interface KnobsFx extends HarnessFx {
  /**
   * Set a knob's value. Goes through `runOperation` — emits
   * `knobs:command:set:requested → :terminal` envelopes; addressable
   * via inbox. Replays the cached terminal when called twice with the
   * same `opId`.
   */
  set(input: KnobsSetInput): Effect.Effect<void, SubstrateError, never>;

  /**
   * Push a descriptor for `id`. The harness preserves any existing
   * value; if no value exists, initializes to `descriptor.defaultValue`.
   * Operation envelope as for {@link set}.
   */
  register(input: KnobsRegisterInput): Effect.Effect<void, SubstrateError, never>;

  /**
   * Validated mutation — the model-equivalent of `knob_set`. Runs the
   * full validation pipeline (exactly-one, exists, type, options,
   * bounds, length/pattern, custom validate) before mutating. Returns
   * the same `ContentBlock[]` the `knob_set` tool would return —
   * either a success message or an error.
   */
  dispatch(
    input: KnobsDispatchInput,
  ): Effect.Effect<readonly ContentBlock[], SubstrateError, never>;
}

// ============================================================================
// Protocol
// ============================================================================

export interface KnobsHarnessProtocol extends HarnessEdge<KnobsFx> {
  /**
   * Harness identifier. Composes into the inbox address as
   * `knobs:{id}` — admin actors send mutations addressed here.
   */
  readonly id: string;

  /**
   * Resolves once the harness has finished its async construction
   * (inbox registration).
   */
  readonly ready: Promise<void>;

  // ─────────── Sync surface (local accessors) ───────────

  /** Read the current value, or `undefined` when unset. */
  get(id: string): KnobPrimitive | undefined;

  /** True iff a value exists for `id` (descriptor-only is still false). */
  has(id: string): boolean;

  /**
   * Snapshot of every known descriptor + current value. Stable reference
   * between mutations; safe for `useSyncExternalStore`.
   */
  list(): readonly KnobDescriptor[];

  /** Notify when the value at `id` changes. */
  subscribe(id: string, listener: () => void): Unsubscribe;

  /** Notify when ANY knob's value or descriptor changes. */
  subscribeAll(listener: () => void): Unsubscribe;

  // ─────────── Async surface (Operations) ───────────
  //
  // BOTH faces come from `HarnessEdge<KnobsFx>`: `set` / `register` /
  // `dispatch` as the Promise facade, and `fx` as the Effect-canonical twin.
  // An in-process caller composes `knobs.fx.set(...)` and stays in the calling
  // fiber; only the adopter edge takes the Promise face. This protocol used to
  // declare the facade ALONE, which is what put every gate transition's knob
  // write outside its tick — see the {@link HarnessEdge} docblock.

  // ─────────── Construction seed ───────────

  /**
   * Install caller-supplied values — the construction seed
   * (`withKnobs({ initial })`, `CreateSessionInput.initialKnobs`). UPSERT, not
   * replace: a knob the seed does not name keeps whatever `hydrate` loaded.
   */
  seed(values: Readonly<Record<string, KnobPrimitive>>): void;

  // ─────────── Lifecycle ───────────

  close(): Promise<void>;
}
