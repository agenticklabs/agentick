/**
 * `promptsHandle` — the client-side prompts resource handle, on the unified
 * `ClientHandle` contract (ADR 87). The wire twin of the server
 * `session.prompts` (`PromptsHandle`): nouns + verbs over one session's prompt
 * library.
 *
 *   - CORE — `subscribe(cb)` (the zero-arg store contract) + `close()`.
 *   - {@link Enumerable} — `list()` returns the current
 *     {@link PromptDeclarationRecord}s, `get(name)` looks one up by name (over
 *     the local snapshot — the client mirrors from its poll rather than the
 *     server's single-record `prompts/get`, matching the sibling handles).
 *   - READ — `render(input)` / `invoke(input)` ride `prompts/render` /
 *     `prompts/invoke` (fresh; render does NOT queue, invoke queues server-side);
 *     `refresh()` re-polls `prompts/list`.
 *   - VERBS — `register` / `update` / `remove`, each a `prompts/*` wire command
 *     followed by a re-poll.
 *
 * **RPC-backed, NOT channel-backed — the deliberate divergence from
 * `knobs`/`tasks`.** There is no `prompts-state` delta channel (a reactive
 * client mirror rides the client channel-consumer primitive, not this PR). So
 * the read side is a poll, not a live mirror: the handle keeps a local snapshot
 * seeded by an eager `prompts/list` fetch and RE-FETCHES after every mutation
 * (fire-and-refetch — the RPC analog of the channel-backed handles'
 * fire-and-observe CQRS). `list()`/`get()` read that snapshot synchronously (the
 * `Enumerable` contract, so the handle drops into `useSyncExternalStore`);
 * `refresh()` forces a re-poll. `subscribe(cb)` fires whenever the snapshot
 * changes.
 *
 * NO `reload`/`resolve`/`require` — loader / lookup-on-miss server concerns that
 * do not cross the wire.
 *
 * @verifiedBy packages/prompts/src/client/__tests__/prompts-handle.spec.ts
 * @verifiedBy packages/prompts/src/client/__tests__/session-prompts.spec.ts
 */

import type { ClientHandle, Enumerable } from "@agentick/client-core";
import type {
  ClientTransport,
  PromptDeclarationRecord,
  PromptsGetInput,
  PromptsGetResult,
  PromptsInvokeInput,
  PromptsRegisterInput,
  PromptsRemoveInput,
  PromptsUpdateInput,
  Unsubscribe,
} from "@agentick/spec";

/** Command client: the `request` surface the prompts handle rides (RPC-only). */
export interface PromptsCommandClient {
  readonly transport: Pick<ClientTransport, "request">;
}

/**
 * The prompts resource handle: the {@link Enumerable} declaration view (`list` /
 * `get`) over the local snapshot + the store-contract `subscribe` +
 * `render`/`invoke` (fresh reads) + the `register` / `update` / `remove` write
 * commands + `refresh` (force a re-poll). A plain structural shape (floors, not
 * ceilings) — it MAY carry more.
 */
export interface PromptsClientHandle extends ClientHandle, Enumerable<PromptDeclarationRecord> {
  /** The current declarations as a bounded snapshot (from the last `prompts/list` poll). */
  list(): readonly PromptDeclarationRecord[];
  /** Look one declaration up by name; `undefined` when absent (or not yet fetched). */
  get(name: string): PromptDeclarationRecord | undefined;
  /** Render a prompt to messages WITHOUT queueing. Rides `prompts/render`. */
  render(input: PromptsGetInput): Promise<PromptsGetResult>;
  /** Invoke a prompt (renders AND queues server-side). Rides `prompts/invoke`. */
  invoke(input: PromptsInvokeInput): Promise<PromptsGetResult>;
  /** Register a prompt. Issues `prompts/register`, then re-polls the snapshot. */
  register(input: PromptsRegisterInput): Promise<void>;
  /** Update a prompt. Issues `prompts/update`, then re-polls. */
  update(input: PromptsUpdateInput): Promise<void>;
  /** Remove a prompt by name. Issues `prompts/remove`, then re-polls. */
  remove(input: PromptsRemoveInput): Promise<void>;
  /** Force a `prompts/list` re-poll; resolves with the fresh snapshot. */
  refresh(): Promise<readonly PromptDeclarationRecord[]>;
  /** Tear down: drop listeners (no channel subscription to close). */
  close(): void;
}

/**
 * A read+write handle over `session`'s prompts. The read half polls
 * `prompts/list` (eagerly at construction, and after every mutation); the write
 * half issues the `prompts/*` commands.
 */
export function promptsHandle(
  client: PromptsCommandClient,
  sessionId: string,
): PromptsClientHandle {
  let snapshot: readonly PromptDeclarationRecord[] = [];
  let byName = new Map<string, PromptDeclarationRecord>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const cb of listeners) cb();
  };

  const refresh = async (): Promise<readonly PromptDeclarationRecord[]> => {
    const rows = (await client.transport.request("prompts/list", { sessionId })) as
      | readonly PromptDeclarationRecord[]
      | null
      | undefined;
    snapshot = rows ?? [];
    byName = new Map(snapshot.map((p) => [p.name, p]));
    notify();
    return snapshot;
  };

  // Eager seed: the Enumerable contract is "current state, including what
  // happened before I connected" — populate up front so `list()` reflects
  // pre-connection declarations once the fetch lands. Fire-and-forget; a poll
  // that fails before the session is reachable recovers on the next mutation's
  // re-fetch or an explicit `refresh()`.
  void refresh().catch(() => undefined);

  return {
    list: () => snapshot,
    get: (name) => byName.get(name),
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
    render: async (input) =>
      (await client.transport.request("prompts/render", {
        sessionId,
        ...input,
      })) as PromptsGetResult,
    invoke: async (input) =>
      (await client.transport.request("prompts/invoke", {
        sessionId,
        ...input,
      })) as PromptsGetResult,
    register: async (input) => {
      await client.transport.request("prompts/register", { sessionId, ...input });
      await refresh();
    },
    update: async (input) => {
      await client.transport.request("prompts/update", { sessionId, ...input });
      await refresh();
    },
    remove: async (input) => {
      await client.transport.request("prompts/remove", { sessionId, ...input });
      await refresh();
    },
  };
}
