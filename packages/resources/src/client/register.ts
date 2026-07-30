/**
 * ADR 87 — contribute `session.resources` to the client `SessionHandle`.
 *
 * Importing `@agentick/resources/client` both TYPES the slot
 * (`declare module`) and REGISTERS the runtime factory, so
 * `client.session(id).resources` self-assembles — the client twin of the
 * server's `session.resources`. It's `resourcesHandle`: the
 * {@link ResourceDescriptor} snapshot view (`list`/`get`) plus the
 * `listTemplates`/`read` reads over `resources/*`, RPC-backed (no
 * `resources-state` channel yet — see {@link resourcesHandle}).
 */

import { registerSessionHandleExtension } from "@agentick/client-core";
import type { WireNamespaceMethods } from "@agentick/spec";
import { resourcesHandle, type ResourcesClientHandle } from "./resources-handle.js";

declare module "@agentick/spec" {
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

// The namespace's wire rows, so the ones this handle does NOT implement stay
// reachable (`session.resources.commands(…)`). Rows the handle DOES implement stay
// shadowed by it — precedence lives in `wireFallthrough`, not in this list.
registerSessionHandleExtension(
  "resources",
  (client, sessionId) => resourcesHandle(client, sessionId),
  {
    wireMethods: [
      "commands",
      "list",
      "listTemplates",
      "read",
    ] satisfies readonly (keyof WireNamespaceMethods<"resources">)[],
  },
);
