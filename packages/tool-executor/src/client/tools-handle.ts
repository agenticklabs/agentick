/**
 * `toolsHandle` — the client-side tools resource handle, on the unified
 * `ClientHandle` contract (ADR 87). The wire twin of the server `session.tools`
 * ({@link ToolsHandle}): nouns + verbs over one session's tool registry.
 *
 *   - CORE — `subscribe(cb)` (the zero-arg store contract) + `close()`.
 *   - {@link Enumerable} — `list()` returns the current {@link ToolInfo}s,
 *     `get(name)` looks one up by name.
 *   - VERB — `dispatch(name, input)` over the `session/dispatch` wire method
 *     (the host door — the tool must declare `exposure: ["dispatch", ...]`).
 *
 * **RPC-backed, NOT channel-backed — the deliberate divergence from
 * `knobs`/`tasks`, matching the `gates` client handle.** There is no
 * `tools-state` delta channel; enumeration rides the dedicated
 * `session/list_tools` wire read (the tool executor's `tool:<sessionId>` inbox
 * address does not fit the dynamic-command lane, so a session-namespace read
 * carries it — three-audiences-plan §F). So the read side is a poll: the handle
 * keeps a local snapshot seeded by an eager `session/list_tools` fetch and
 * RE-FETCHES on `refresh()` (fire-and-refetch). `list()`/`get()` read that
 * snapshot synchronously (the `Enumerable` contract, so the handle drops into
 * `useSyncExternalStore`); `subscribe(cb)` fires whenever the snapshot changes.
 *
 * **Distinct from `session.clientToolCalls`** — that handle is the inbound
 * client-tool-call feed (respond/route/confirm); THIS handle is the tool
 * registry projection (list/get/dispatch). Different slot, different concern.
 *
 * @verifiedBy packages/tool-executor/src/client/__tests__/tools-handle.spec.ts
 * @verifiedBy packages/tool-executor/src/client/__tests__/session-tools.spec.ts
 */

import { polledView, type ClientHandle, type Enumerable } from "@agentick/client-core";
import type { ClientTransport, ContentBlock, ToolExposure, ToolInfo } from "@agentick/spec";

/** Command client: the `request` surface the tools handle rides (RPC-only). */
export interface ToolsCommandClient {
  readonly transport: Pick<ClientTransport, "request">;
}

/**
 * The tools resource handle: the {@link Enumerable} tool view (`list` / `get`)
 * over the local snapshot + the store-contract `subscribe` + the `dispatch`
 * verb + `refresh` (force a re-poll). A plain structural shape (floors, not
 * ceilings) — it MAY carry more.
 */
export interface ToolsClientHandle extends ClientHandle, Enumerable<ToolInfo> {
  /** The current tools as a bounded snapshot (from the last `session/list_tools` poll). */
  list(): readonly ToolInfo[];
  /** Look one tool up by name; `undefined` when absent (or not yet fetched). */
  get(name: string): ToolInfo | undefined;
  /**
   * Invoke a tool by name without the model (host door). Issues
   * `session/dispatch` and resolves with the tool's content blocks. Does NOT
   * re-poll — dispatch does not mutate the registry topology.
   */
  dispatch(name: string, input: unknown): Promise<readonly ContentBlock[]>;
  /**
   * Force a `session/list_tools` re-poll; resolves with the fresh snapshot.
   * Optionally filtered by exposure (mirrors `ToolsHandle.list({ exposure })`).
   */
  refresh(query?: { readonly exposure?: ToolExposure }): Promise<readonly ToolInfo[]>;
  /** Tear down: drop listeners (no channel subscription to close). */
  close(): void;
}

/**
 * A read+dispatch handle over `session`'s tools. The read half polls
 * `session/list_tools` (eagerly at construction, and via `refresh()`); the
 * dispatch verb issues `session/dispatch`.
 */
export function toolsHandle(client: ToolsCommandClient, sessionId: string): ToolsClientHandle {
  const view = polledView<ToolInfo, { readonly exposure?: ToolExposure }>({
    // Only the FIRST page seeds the snapshot — walking cursors is the power-user
    // path (`refresh` re-polls page one), matching the resources handle.
    fetch: async (query) =>
      (
        await client.transport.request("session/list_tools", {
          sessionId,
          ...(query?.exposure !== undefined ? { exposure: query.exposure } : {}),
        })
      )?.tools,
    key: (t) => t.name,
  });

  return {
    ...view,
    dispatch: async (name, input) => {
      const reply = (await client.transport.request("session/dispatch", {
        sessionId,
        tool: name,
        input,
      })) as { content: readonly ContentBlock[] };
      return reply.content;
    },
  };
}
