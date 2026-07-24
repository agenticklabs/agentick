/**
 * StateHarnessProtocol — session-internal reactive K/V storage.
 *
 * The "adopter stash" — typed key-value bag backing the
 * `useSessionState(key, initial)` hook. NOT model-visible: the
 * executor's `set_knob` tool doesn't reach here, and `list()` returns
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

import type { Unsubscribe } from "./inbox.js";
import type { SnapshotCapable } from "./hook-bridges.js";

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

/** Snapshot payload — a map of state keys to current values. */
export type StateHarnessSnapshot = Readonly<Record<string, unknown>>;

// ============================================================================
// Protocol
// ============================================================================

export interface StateHarnessProtocol extends SnapshotCapable<StateHarnessSnapshot> {
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

  /**
   * Set a value. Goes through `runOperation` — emits
   * `state:command:set:requested → :terminal` envelopes; addressable
   * via inbox. Replays the cached terminal when called twice with the
   * same `opId`.
   */
  set(input: StateSetInput): Promise<void>;

  /** Delete a key. Same Operation contract as {@link set}. */
  delete(input: StateDeleteInput): Promise<void>;

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): Readonly<Record<string, unknown>>;
  importSnapshot(values: Readonly<Record<string, unknown>>): void;

  // ─────────── Lifecycle ───────────

  close(): Promise<void>;
}
