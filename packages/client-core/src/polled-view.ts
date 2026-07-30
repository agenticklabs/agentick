/**
 * `polledView` — the read core every RPC-backed client handle is built on.
 *
 * Six handles (`gates`, `state`, `skills`, `prompts`, `resources`, `tools`) share
 * one shape: a local snapshot seeded by an eager wire fetch, a by-id index,
 * a listener set, and a `refresh()` the handle's write verbs call after each
 * mutation (fire-and-refetch — the RPC analog of the channel-backed handles'
 * fire-and-observe CQRS). They differ only in WHICH wire read they issue, how the
 * reply unwraps, and what keys the index — the three things a caller passes here.
 *
 * It sits in the `*View` family next to {@link channelView} (folds a channel) and
 * {@link filteredView} (projects another view): same read surface, different
 * source. This one's source is a poll, which is why it — alone in the family —
 * carries `refresh`.
 *
 * A handle composes rather than inherits: it spreads this view's members and adds
 * its own verbs, so the handle's public surface and doc-block stay its own.
 *
 * @verifiedBy packages/client-core/src/__tests__/polled-view.spec.ts
 */

import type { Unsubscribe } from "@agentick/spec";

import type { ClientHandle, Enumerable } from "./handle-contract.js";

/** Wire read + indexing rules a {@link polledView} needs. `Q` is the refresh query, `void` when there is none. */
export interface PolledViewConfig<T, Q = void> {
  /**
   * Issue the wire read and unwrap it to rows. `null` / `undefined` — the shape a
   * transport double or an absent harness returns — reads as the empty snapshot,
   * so a failed fetch leaves the view empty, never half-filled.
   */
  fetch(query?: Q): Promise<readonly T[] | null | undefined>;
  /** The id `get(id)` looks rows up by (`name`, `uri`, `key`, …). */
  key(item: T): string;
}

/**
 * The read core: the {@link Enumerable} snapshot pair, the store-contract
 * `subscribe`, `close`, and the `refresh` that re-polls.
 */
export interface PolledView<T, Q = void> extends ClientHandle, Enumerable<T> {
  /** The current rows as a bounded snapshot (from the last poll). */
  list(): readonly T[];
  /** Look one row up by id; `undefined` when absent (or not yet fetched). */
  get(id: string): T | undefined;
  /** Re-poll; resolves with the fresh snapshot. */
  refresh(query?: Q): Promise<readonly T[]>;
  /** Drop listeners. No channel subscription to close. */
  close(): void;
}

/**
 * Mint a poll-backed view. Fetches ONCE eagerly at construction, then only when
 * `refresh()` is called.
 *
 * The eager seed is what makes the {@link Enumerable} contract — "current state,
 * including what happened before I connected" — hold without the caller awaiting
 * anything: the snapshot fills itself and NOTIFIES when it lands, so binding
 * `list()` + `subscribe()` is the whole integration. Errors are swallowed (a poll
 * may fail before the session is reachable); the next mutation's re-fetch or an
 * explicit `refresh()` recovers.
 */
export function polledView<T, Q = void>(config: PolledViewConfig<T, Q>): PolledView<T, Q> {
  let snapshot: readonly T[] = [];
  let index = new Map<string, T>();
  const listeners = new Set<() => void>();

  const refresh = async (query?: Q): Promise<readonly T[]> => {
    const rows = await config.fetch(query);
    snapshot = rows ?? [];
    index = new Map(snapshot.map((row) => [config.key(row), row]));
    for (const cb of listeners) cb();
    return snapshot;
  };

  void refresh().catch(() => undefined);

  return {
    list: () => snapshot,
    get: (id) => index.get(id),
    subscribe: (cb: () => void): Unsubscribe => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    close: () => {
      listeners.clear();
    },
    refresh,
  };
}
