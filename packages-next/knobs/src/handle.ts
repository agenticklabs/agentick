/**
 * `KnobsHandle` — the user-facing surface of the knobs harness as
 * exposed on `session.knobs`.
 *
 * Subset of {@link KnobsHarnessProtocol}: hides `id`, `ready`, `close`,
 * snapshot import/export, and `register` (driven by JSX `useKnob`,
 * not by user code). Adopters get to read, set, dispatch, and
 * subscribe to knob values.
 *
 * For per-knob access by reference, use `session.knob(name)` which
 * returns a `KnobHandle<T>` typed on the value.
 *
 * Structural subset of the harness protocol — no runtime wrapping.
 *
 * @see ./augment.ts (module augmentation onto `SessionHarnessProtocol`)
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { ContentBlock, Unsubscribe } from "@agentick/spec-next";
import type {
  KnobDescriptor,
  KnobPrimitive,
  KnobsDispatchInput,
  KnobsSetInput,
} from "@agentick/spec-next";

export interface KnobsHandle {
  /** Snapshot of every known descriptor + current value. */
  list(): readonly KnobDescriptor[];
  /** Current value of `id`, or undefined when unset. */
  get(id: string): KnobPrimitive | undefined;
  /** True iff a value exists for `id`. */
  has(id: string): boolean;
  /** Set a knob's value through the harness's Operation envelope. */
  set(input: KnobsSetInput): Promise<void>;
  /**
   * Run the full knob_set validation pipeline against an input. Returns
   * the content blocks the `knob_set` tool would return.
   */
  dispatch(input: KnobsDispatchInput): Promise<readonly ContentBlock[]>;
  /** Notify when the value at `id` changes. */
  subscribe(id: string, listener: () => void): Unsubscribe;
  /** Notify when ANY knob value or descriptor changes. */
  subscribeAll(listener: () => void): Unsubscribe;
}
