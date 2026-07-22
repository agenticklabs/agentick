/**
 * Canonical wire channel for KnobsHarness state-sync.
 *
 * Model-visible knob state reaches observers two ways. The coarse way is
 * the harness snapshot (`exportSnapshot()` → the compiler's SnapshotCapable
 * projection): the WHOLE store, re-sent. This channel is the fine way — an
 * initial `snapshot` frame followed by RFC 6902 JSON-Patch `delta` frames,
 * one op per knob that changed. A subscriber seeds from the snapshot and
 * applies deltas, re-rendering only the branch that moved.
 *
 * This is the native form of AG-UI's `StateSnapshot` / `StateDelta` pair
 * (ADR 73): we adopt the snapshot+delta model on our own bus, and the AG-UI
 * projection falls out as a codec over this channel rather than a bespoke
 * diff. Because knob changes arrive one id at a time (the harness notifies
 * per-id — see `KnobsHarness`), delta GENERATION needs no document diff: a
 * changed id IS a single `add`/`replace` op. Only the far side applies the
 * patch, via `applyJsonPatch`.
 *
 * Frames carry a monotonic `version` so a subscriber can detect a gap (a
 * dropped delta) and re-seed from a fresh snapshot.
 *
 * @see docs/proposals/v2/blueprint/73-ag-ui-projection.md
 * @see packages-next/tasks/src/channel.ts — the sibling task-status channel.
 */

import type { JsonPatchOp } from "@agentick/utils-next";
import type { KnobPrimitive } from "@agentick/spec-next";

/** Channel name as passed to the fan-out helper. */
export const KNOBS_STATE_CHANNEL = "knobs-state" as const;

/** Fully-qualified channel name as it appears on the bus envelope. */
export const KNOBS_STATE_CHANNEL_FQN = "session:channel:knobs-state" as const;

export type KnobsStateChannelName = typeof KNOBS_STATE_CHANNEL;

/**
 * Full-store frame — the seed a fresh subscriber applies before any delta,
 * and the frame emitted when the store is replaced wholesale (snapshot
 * restore). `values` maps knob id → current value.
 */
export interface KnobsStateSnapshotFrame {
  readonly kind: "snapshot";
  readonly version: number;
  readonly values: Readonly<Record<string, KnobPrimitive>>;
}

/**
 * Incremental frame — the JSON-Patch ops describing knob changes since the
 * previous frame. In practice one op per changed id (`/{id}` paths).
 */
export interface KnobsStateDeltaFrame {
  readonly kind: "delta";
  readonly version: number;
  readonly ops: readonly JsonPatchOp[];
}

/** Discriminated union carried on {@link KNOBS_STATE_CHANNEL_FQN}. */
export type KnobsStateFrame = KnobsStateSnapshotFrame | KnobsStateDeltaFrame;

/**
 * Escape a knob id into a single JSON Pointer reference token (RFC 6901):
 * `~` → `~0`, `/` → `~1` (order matters — `~` first). The far side's
 * `applyJsonPatch` unescapes symmetrically.
 */
export function knobPointer(id: string): string {
  return "/" + id.replace(/~/g, "~0").replace(/\//g, "~1");
}
