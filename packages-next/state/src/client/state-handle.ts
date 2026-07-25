/**
 * `stateHandle` — the client-side state resource handle, on the unified
 * `ClientHandle` contract (ADR 87). The wire twin of the server
 * `session.state` (`StateHandle`): nouns + verbs over one session's adopter
 * K/V stash.
 *
 *   - CORE — `subscribe(cb)` (the zero-arg store contract) + `close()`.
 *   - {@link Enumerable} — `list()` returns the current {@link StateListEntry}s
 *     (`{ key, value }`, the family projection depth), `get(key)` looks one up
 *     by key (the ROW, not the bare value — consistent with the sibling
 *     handles).
 *   - VERBS — `set(key, value)` / `delete(key)`, each a `state/*` wire command.
 *
 * **RPC-backed, NOT channel-backed — the deliberate divergence from
 * `knobs`/`tasks`.** There is no `state-state` delta channel (state is the
 * adopter stash, not model-visible; a reactive client mirror rides the client
 * channel-consumer primitive, not this PR). So the read side is a poll, not a
 * live mirror: the handle keeps a local snapshot seeded by an eager
 * `state/list` fetch and RE-FETCHES after every mutation (fire-and-refetch —
 * the RPC analog of the channel-backed handles' fire-and-observe CQRS).
 * `list()`/`get()` read that snapshot synchronously (the `Enumerable` contract,
 * so the handle drops into `useSyncExternalStore`); `refresh()` forces a
 * re-poll. `subscribe(cb)` fires whenever the snapshot changes (after the
 * initial fetch and after each mutation's re-fetch).
 *
 * @verifiedBy packages-next/state/src/client/__tests__/state-handle.spec.ts
 * @verifiedBy packages-next/state/src/client/__tests__/session-state.spec.ts
 */

import type { ClientHandle, Enumerable } from "@agentick/client-core-next";
import type { ClientTransport, StateListEntry, Unsubscribe } from "@agentick/spec-next";

/** Command client: the `request` surface the state handle rides (RPC-only). */
export interface StateCommandClient {
  readonly transport: Pick<ClientTransport, "request">;
}

/**
 * The state resource handle: the {@link Enumerable} entry view (`list` / `get`)
 * over the local snapshot + the store-contract `subscribe` + the `set` /
 * `delete` write commands + `refresh` (force a re-poll). A plain structural
 * shape (floors, not ceilings) — it MAY carry more.
 */
export interface StateClientHandle extends ClientHandle, Enumerable<StateListEntry> {
  /** The current entries as a bounded snapshot (from the last `state/list` poll). */
  list(): readonly StateListEntry[];
  /**
   * Look one entry up by key; `undefined` when absent (or not yet fetched).
   * Returns the ROW (`{ key, value }`), not the bare value — the sibling
   * `Enumerable` projection depth.
   */
  get(key: string): StateListEntry | undefined;
  /** Set a value by key. Issues `state/set`, then re-polls the snapshot. */
  set(key: string, value: unknown): Promise<void>;
  /** Delete a key. Issues `state/delete`, then re-polls the snapshot. */
  delete(key: string): Promise<void>;
  /** Force a `state/list` re-poll; resolves with the fresh snapshot. */
  refresh(): Promise<readonly StateListEntry[]>;
  /** Tear down: drop listeners (no channel subscription to close). */
  close(): void;
}

/**
 * A read+write handle over `session`'s state. The read half polls `state/list`
 * (eagerly at construction, and after every mutation); the write half issues
 * the `state/*` commands.
 */
export function stateHandle(client: StateCommandClient, sessionId: string): StateClientHandle {
  let snapshot: readonly StateListEntry[] = [];
  let byKey = new Map<string, StateListEntry>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const cb of listeners) cb();
  };

  const refresh = async (): Promise<readonly StateListEntry[]> => {
    const rows = (await client.transport.request("state/list", { sessionId })) as
      | readonly StateListEntry[]
      | null
      | undefined;
    snapshot = rows ?? [];
    byKey = new Map(snapshot.map((e) => [e.key, e]));
    notify();
    return snapshot;
  };

  // Eager seed: the Enumerable contract is "current state, including what
  // happened before I connected" — populate up front so `list()` reflects
  // pre-connection entries once the fetch lands. Fire-and-forget; a poll that
  // fails before the session is reachable recovers on the next mutation's
  // re-fetch or an explicit `refresh()`.
  void refresh().catch(() => undefined);

  return {
    list: () => snapshot,
    get: (key) => byKey.get(key),
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
    set: async (key, value) => {
      await client.transport.request("state/set", { sessionId, key, value });
      await refresh();
    },
    delete: async (key) => {
      await client.transport.request("state/delete", { sessionId, key });
      await refresh();
    },
  };
}
