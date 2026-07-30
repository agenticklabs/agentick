/**
 * `gatesHandle` — the client-side gates resource handle, on the unified
 * `ClientHandle` contract (ADR 87). The wire twin of the server
 * `session.gates` (`GatesHandle`): nouns + verbs over one session's gate
 * registry.
 *
 *   - CORE — `subscribe(cb)` (the zero-arg store contract) + `close()`.
 *   - {@link Enumerable} — `list()` returns the current {@link GateInfo}s,
 *     `get(name)` looks one up by name.
 *   - VERBS — `clear(name)` / `defer(name, reason?)` / `override(name, value,
 *     reason)`, each a `gates/*` wire command.
 *
 * **RPC-backed, NOT channel-backed — the deliberate divergence from
 * `knobs`/`tasks`.** There is no `gates-state` delta channel yet (the known gap
 * at `controller.ts` `transition()` — gate reason/hit-counts are not projected;
 * a `gates-state` snapshot+delta channel rides the store fan-out later, not this
 * PR). So the read side is a poll, not a live mirror: the handle keeps a local
 * snapshot seeded by an eager `gates/list` fetch and RE-FETCHES after every
 * mutation (fire-and-refetch — the RPC analog of the channel-backed handles'
 * fire-and-observe CQRS). `list()`/`get()` read that snapshot synchronously (the
 * `Enumerable` contract, so the handle drops into `useSyncExternalStore`);
 * `refresh()` forces a re-poll. `subscribe(cb)` fires whenever the snapshot
 * changes (after the initial fetch and after each mutation's re-fetch).
 *
 * @verifiedBy packages/gates/src/client/__tests__/gates-handle.spec.ts
 * @verifiedBy packages/gates/src/client/__tests__/session-gates.spec.ts
 */

import { polledView, type ClientHandle, type Enumerable } from "@agentick/client-core";
import type { ClientTransport } from "@agentick/spec";

import type { GateInfo } from "../controller.js";
import type { GateValue } from "../descriptor.js";

/** Command client: the `request` surface the gates handle rides (RPC-only). */
export interface GatesCommandClient {
  readonly transport: Pick<ClientTransport, "request">;
}

/**
 * The gates resource handle: the {@link Enumerable} gate view (`list` / `get`)
 * over the local snapshot + the store-contract `subscribe` + the `clear` /
 * `defer` / `override` write commands + `refresh` (force a re-poll). A plain
 * structural shape (floors, not ceilings) — it MAY carry more.
 */
export interface GatesClientHandle extends ClientHandle, Enumerable<GateInfo> {
  /** The current gates as a bounded snapshot (from the last `gates/list` poll). */
  list(): readonly GateInfo[];
  /** Look one gate up by name; `undefined` when absent (or not yet fetched). */
  get(name: string): GateInfo | undefined;
  /** Release a gate by name. Issues `gates/clear`, then re-polls the snapshot. */
  clear(name: string): Promise<void>;
  /** Postpone a latch gate by name. Issues `gates/defer`, then re-polls. */
  defer(name: string, reason?: string): Promise<void>;
  /**
   * Override a verified gate (the audited host/wire escape). Issues
   * `gates/override`, then re-polls. Rejects if the server gate is a latch gate
   * or is absent (the controller's verified-only rule surfaces over the wire).
   */
  override(name: string, value: GateValue, reason: string): Promise<void>;
  /** Force a `gates/list` re-poll; resolves with the fresh snapshot. */
  refresh(): Promise<readonly GateInfo[]>;
  /** Tear down: drop listeners (no channel subscription to close). */
  close(): void;
}

/**
 * A read+write handle over `session`'s gates. The read half polls `gates/list`
 * (eagerly at construction, and after every mutation); the write half issues
 * the `gates/*` commands.
 */
export function gatesHandle(client: GatesCommandClient, sessionId: string): GatesClientHandle {
  const view = polledView<GateInfo>({
    fetch: () =>
      client.transport.request("gates/list", { sessionId }) as Promise<
        readonly GateInfo[] | null | undefined
      >,
    key: (g) => g.name,
  });

  return {
    ...view,
    clear: async (name) => {
      await client.transport.request("gates/clear", { sessionId, name });
      await view.refresh();
    },
    defer: async (name, reason) => {
      await client.transport.request("gates/defer", {
        sessionId,
        name,
        ...(reason !== undefined ? { reason } : {}),
      });
      await view.refresh();
    },
    override: async (name, value, reason) => {
      await client.transport.request("gates/override", { sessionId, name, value, reason });
      await view.refresh();
    },
  };
}
