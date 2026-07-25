/**
 * ADR 87 — contribute `session.clientToolCalls` to the client `SessionHandle`.
 *
 * Importing `@agentick/tool-executor/client` both TYPES the slot
 * (`declare module`) and REGISTERS the runtime factory, so
 * `client.session(id).clientToolCalls` self-assembles — the client twin of the
 * server's `session.toolExecutor` seam behind `session/set_client_tools` /
 * `session/respond_to_tool_call`.
 *
 * B2 slice 3 (Ryan's Q1a): the once-loose session functions —
 * `setClientTools` / `routeClientTools` / `confirmClientTools` /
 * `respondToToolCall` — are FOLDED onto this one handle as verbs
 * (`.set` / `.route` / `.confirm` / `.respond`). There is no longer a separate
 * top-level slot for each (pre-1.0, deleted without deprecation).
 *
 * Depends on `@agentick/client-core` + spec types (+ the
 * `@agentick/elicitation/client` handle, reused by `.confirm`) — NOT on the
 * tool-executor harness runtime — so it stays out of a browser bundle, matching
 * the elicitation/tasks/knobs `/client` convention.
 */

import { registerSessionHandleExtension } from "@agentick/client-core";

import { clientToolCallsHandle, type ClientToolCallsHandle } from "./client-tool-calls.js";

declare module "@agentick/spec" {
  interface SessionHandleExtensions {
    /**
     * The client-tool-call resource handle on the `ClientHandle` contract:
     * `list()`/`get(id)` over the PENDING calls (Enumerable — a client connecting
     * mid-call sees the outstanding call), the zero-arg `subscribe(cb)` store
     * contract, `respond(correlationId, result)` (Respondable by-id), and the
     * folded verbs `set(declarations)` / `route(handlers, opts?)` /
     * `confirm(policy)`. `list()` yields item handles, each with a typed
     * `.respond(result)` (a no-op for fire-and-forget relays).
     */
    readonly clientToolCalls: ClientToolCallsHandle;
  }
}

registerSessionHandleExtension("clientToolCalls", (client, sessionId) =>
  clientToolCallsHandle(client, sessionId),
);
