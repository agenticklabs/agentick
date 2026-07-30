/**
 * `resourcesHandle` — the client-side resources resource handle, on the unified
 * `ClientHandle` contract (ADR 87). The wire twin of the server
 * `session.resources`: nouns + verbs over one session's resource registry.
 *
 *   - CORE — `subscribe(cb)` (the zero-arg store contract) + `close()`.
 *   - {@link Enumerable} — `list()` returns the current fixed-resource
 *     {@link ResourceDescriptor}s, `get(uri)` looks one up by uri.
 *   - VERBS — `listTemplates()` / `read(uri)`, each a `resources/*` wire
 *     command; `refresh()` forces a `resources/list` re-poll.
 *
 * **RPC-backed, NOT channel-backed** (the same divergence `gates` takes). There
 * is no `resources-state` delta channel yet (the reactive mirror rides the
 * client channel-consumer primitive later). So the read side is a poll: the
 * handle keeps a local snapshot seeded by an eager `resources/list` fetch and
 * RE-FETCHES on `refresh()` (fire-and-refetch). `list()`/`get()` read that
 * snapshot synchronously (the `Enumerable` contract, so the handle drops into
 * `useSyncExternalStore`). `listTemplates()` / `read(uri)` are PURE RPC — no
 * follow-up poll (reads have no registry-mutating effect).
 *
 * `list()` unwraps the paginated `ResourcesListResult.resources`; the Enumerable
 * id key is `uri`. Only the FIRST page seeds the snapshot — cursored pagination
 * over the wire is the power-user path (`refresh` re-polls page one). Templates
 * are async-only (they are not part of the `Enumerable` `list()` snapshot).
 *
 * @verifiedBy packages/resources/src/client/__tests__/resources-handle.spec.ts
 * @verifiedBy packages/resources/src/client/__tests__/session-resources.spec.ts
 */

import { polledView, type ClientHandle, type Enumerable } from "@agentick/client-core";
import type {
  ClientTransport,
  ResourceContents,
  ResourceDescriptor,
  ResourceTemplateDescriptor,
  ResourcesListResult,
  ResourcesListTemplatesResult,
} from "@agentick/spec";

/** Command client: the `request` surface the resources handle rides (RPC-only). */
export interface ResourcesCommandClient {
  readonly transport: Pick<ClientTransport, "request">;
}

/**
 * The resources resource handle: the {@link Enumerable} descriptor view (`list`
 * / `get`) over the local snapshot + the store-contract `subscribe` +
 * `listTemplates` / `read` reads + `refresh` (force a re-poll). A plain
 * structural shape (floors, not ceilings) — it MAY carry more.
 */
export interface ResourcesClientHandle extends ClientHandle, Enumerable<ResourceDescriptor> {
  /** The current fixed resources as a bounded snapshot (from the last `resources/list` poll). */
  list(): readonly ResourceDescriptor[];
  /** Look one fixed resource up by uri; `undefined` when absent (or not yet fetched). */
  get(uri: string): ResourceDescriptor | undefined;
  /** Enumerate resource TEMPLATE descriptors (pure RPC over `resources/listTemplates`). */
  listTemplates(): Promise<readonly ResourceTemplateDescriptor[]>;
  /** Read a resource's contents by uri (pure RPC over `resources/read`). */
  read(uri: string): Promise<readonly ResourceContents[]>;
  /** Force a `resources/list` re-poll; resolves with the fresh descriptor snapshot. */
  refresh(): Promise<readonly ResourceDescriptor[]>;
  /** Tear down: drop listeners (no channel subscription to close). */
  close(): void;
}

/**
 * A read handle over `session`'s resources. The descriptor half polls
 * `resources/list` (eagerly at construction, and on `refresh()`); `read` /
 * `listTemplates` are per-call RPC.
 */
export function resourcesHandle(
  client: ResourcesCommandClient,
  sessionId: string,
): ResourcesClientHandle {
  const view = polledView<ResourceDescriptor>({
    fetch: async () => {
      const result = (await client.transport.request("resources/list", { sessionId })) as
        | ResourcesListResult
        | null
        | undefined;
      return result?.resources;
    },
    key: (r) => r.uri,
  });

  return {
    ...view,
    listTemplates: async () => {
      const result = (await client.transport.request("resources/listTemplates", { sessionId })) as
        | ResourcesListTemplatesResult
        | null
        | undefined;
      return result?.templates ?? [];
    },
    read: async (uri) => {
      const contents = (await client.transport.request("resources/read", { sessionId, uri })) as
        | readonly ResourceContents[]
        | null
        | undefined;
      return contents ?? [];
    },
  };
}
