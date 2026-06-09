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

import type { ContentBlock } from "../data/content-blocks.js";
import type { Unsubscribe } from "./inbox.js";
import type {
  KnobDescriptor,
  KnobPrimitive,
  KnobRegistration,
  SnapshotCapable,
} from "./hook-bridges.js";

/**
 * Snapshot payload for {@link KnobsHarnessProtocol.exportSnapshot}.
 * Map of knob id → current value. Descriptor metadata is NOT included —
 * descriptors come from re-rendering the JSX tree, not from the snapshot.
 */
export type KnobsHarnessSnapshot = Readonly<Record<string, KnobPrimitive>>;

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
 * Input to `dispatch` — model-equivalent of the `set_knob` tool call.
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

export type KnobsError =
  | { readonly _tag: "UnknownKnob"; readonly id: string }
  | { readonly _tag: "ValidationFailed"; readonly id: string; readonly reason: string }
  | { readonly _tag: "GroupEmpty"; readonly group: string }
  | { readonly _tag: "GroupTypeMismatch"; readonly group: string; readonly reason: string }
  | { readonly _tag: "InvalidDispatchInput"; readonly reason: string };

// ============================================================================
// Protocol
// ============================================================================

export interface KnobsHarnessProtocol extends SnapshotCapable<KnobsHarnessSnapshot> {
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

  /**
   * Set a knob's value. Goes through `runOperation` — emits
   * `knobs:command:set:requested → :terminal` envelopes; addressable
   * via inbox. Replays the cached terminal when called twice with the
   * same `opId`.
   */
  set(input: KnobsSetInput): Promise<void>;

  /**
   * Push a descriptor for `id`. The harness preserves any existing
   * value; if no value exists, initializes to `descriptor.defaultValue`.
   * Operation envelope as for {@link set}.
   */
  register(input: KnobsRegisterInput): Promise<void>;

  /**
   * Validated mutation — the model-equivalent of `set_knob`. Runs the
   * full validation pipeline (exactly-one, exists, type, options,
   * bounds, length/pattern, custom validate) before mutating. Returns
   * the same `ContentBlock[]` the `set_knob` tool would return —
   * either a success message or an error.
   */
  dispatch(input: KnobsDispatchInput): Promise<readonly ContentBlock[]>;

  // ─────────── Lifecycle ───────────

  close(): Promise<void>;
}
