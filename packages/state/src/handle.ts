/**
 * `StateHandle` — the user-facing surface of the state harness as
 * exposed on `session.state`.
 *
 * Subset of {@link StateHarnessProtocol}: hides `id`, `ready`, `close`,
 * snapshot import/export. Adopters get K/V get/set/has/delete + per-key
 * and global subscription.
 *
 * Structural subset of the harness protocol — no runtime wrapping.
 *
 * @see ./augment.ts (module augmentation onto `SessionHarnessProtocol`)
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { Unsubscribe } from "@agentick/spec";
import type { StateDeleteInput, StateSetInput } from "@agentick/spec";

export interface StateHandle {
  /** Current value at `key`, or undefined. */
  get(key: string): unknown;
  /** True iff a value exists at `key`. */
  has(key: string): boolean;
  /** Snapshot of every known key. */
  list(): readonly string[];
  /** Set a value through the harness's Operation envelope. */
  set(input: StateSetInput): Promise<void>;
  /** Delete a key through the harness's Operation envelope. */
  delete(input: StateDeleteInput): Promise<void>;
  /** Notify when the value at `key` changes (including deletes). */
  subscribe(key: string, listener: () => void): Unsubscribe;
  /** Notify when ANY entry changes. */
  subscribeAll(listener: () => void): Unsubscribe;
}
