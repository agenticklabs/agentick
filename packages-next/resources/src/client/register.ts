/**
 * ADR 87 — contribute `session.resources` to the client `SessionHandle`.
 *
 * Importing `@agentick/resources-next/client` both TYPES the slot
 * (`declare module`) and REGISTERS the runtime factory, so
 * `client.session(id).resources` self-assembles — the client twin of the
 * server's `session.resources`. It's `resourcesHandle`: the
 * {@link ResourceDescriptor} snapshot view (`list`/`get`) plus the
 * `listTemplates`/`read` reads over `resources/*`, RPC-backed (no
 * `resources-state` channel yet — see {@link resourcesHandle}).
 */

import { registerSessionHandleExtension } from "@agentick/client-core-next";
import { resourcesHandle, type ResourcesClientHandle } from "./resources-handle.js";

declare module "@agentick/spec-next" {
  interface SessionHandleExtensions {
    /**
     * The resources resource handle — the `ClientHandle` contract for this
     * session: `list()`/`get(uri)` over the fixed-resource snapshot
     * (Enumerable), the zero-arg `subscribe(cb)` store contract, and
     * `listTemplates()`/`read(uri)` over the `resources/*` wire commands
     * (`== resourcesHandle(client, id)`).
     */
    readonly resources: ResourcesClientHandle;
  }
}

registerSessionHandleExtension("resources", (client, sessionId) =>
  resourcesHandle(client, sessionId),
);
