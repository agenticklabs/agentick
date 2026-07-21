/**
 * ADR 87 — contribute the client-tool surface to the client `SessionHandle`.
 *
 * Importing `@agentick/tool-executor-next/client` both TYPES the slots
 * (`declare module`) and REGISTERS the runtime factories, so
 * `client.session(id).setClientTools(...)` / `.respondToToolCall(...)` (stage 2
 * WRITE verbs) and `.clientToolCalls` / `.routeClientTools(...)` /
 * `.confirmClientTools(...)` (stage 3 CONSUMER + confirmation policy)
 * self-assemble — the client twin of the server's `session.toolExecutor` seam
 * behind `session/set_client_tools` / `session/respond_to_tool_call`.
 *
 * Depends on `@agentick/client-core-next` + spec types (+ the
 * `@agentick/elicitation-next/client` stream, reused by the confirmation policy)
 * — NOT on the tool-executor harness runtime — so it stays out of a browser
 * bundle, matching the elicitation/tasks/knobs `/client` convention.
 */

import { registerSessionHandleExtension } from "@agentick/client-core-next";
import type {
  ClientProtocol,
  ClientToolDeclaration,
  SessionSetClientToolsResult,
  ToolResultInput,
  Unsubscribe,
} from "@agentick/spec-next";

import {
  clientToolCallStream,
  respondToToolCall,
  routeClientTools,
  type ClientToolCallsHandle,
  type ClientToolHandler,
  type RouteClientToolsOptions,
} from "./client-tool-calls.js";
import { confirmClientTools, type ConfirmPolicy } from "./confirm.js";

declare module "@agentick/spec-next" {
  interface SessionHandleExtensions {
    /**
     * DECLARE this client's full CLIENT-HANDLED tool set into the session over
     * `session/set_client_tools`. A client is a declarative tool SOURCE that
     * owns a slice: pass the ENTIRE set and the server REPLACES the client
     * slice wholesale — the wire twin of the reconciler's
     * `replaceReconcilerTools`. One verb subsumes register (a tool present in
     * the set), unregister (a tool absent from it), and idempotency (the set IS
     * the truth — a replace, not an accumulate). Reconnect = re-declare;
     * drift-free by construction.
     *
     * Each `declarations` element is the serializable {@link ClientToolDeclaration}
     * slice (raw JSON-Schema `inputSchema`, no handler). Registered tools enter
     * the model's tool list; a model call is relayed back to the client —
     * answered via {@link respondToToolCall}. Resolves to
     * `{ count }` (the number of tools now installed).
     *
     * Multi-client: the slice is keyed by `sessionId` (not connection), so
     * concurrent callers are last-write-wins over the whole set — coordinating
     * ownership is the app's concern.
     */
    readonly setClientTools: (
      declarations: readonly ClientToolDeclaration[],
    ) => Promise<SessionSetClientToolsResult>;
    /**
     * Relay this client's result for a suspended client-handled tool call over
     * `session/respond_to_tool_call`, keyed by the `correlationId` carried on
     * the inbound tool-call request.
     */
    readonly respondToToolCall: (correlationId: string, result: ToolResultInput) => Promise<void>;
    /**
     * The inbound client-tool-call feed — the far side of
     * `session:channel:tool_call`. Read via
     * `session.clientToolCalls.onChange((c) => c.respond(result))` or
     * `for await (const c of session.clientToolCalls)`; write by `correlationId`
     * via `session.clientToolCalls.respond(correlationId, result)`. Each yielded
     * handle carries the validated `input` + a typed `.respond` (a no-op for
     * fire-and-forget relays that carry no `correlationId`).
     */
    readonly clientToolCalls: ClientToolCallsHandle;
    /**
     * The ergonomic router over {@link clientToolCalls}: dispatch each call to
     * `handlers[name]` (or `opts.onUnknown`), auto-respond with the result, and
     * turn a throw / unknown tool into an error result. Fire-and-forget calls
     * still dispatch their handler but skip the respond. Returns an
     * {@link Unsubscribe}.
     */
    readonly routeClientTools: (
      handlers: Readonly<Record<string, ClientToolHandler>>,
      opts?: RouteClientToolsOptions,
    ) => Unsubscribe;
    /**
     * Apply a confirmation {@link ConfirmPolicy} to inbound tool-confirmation
     * elicitations (`hints.kind === "tool_confirmation"`): `"approve"` /
     * `"deny"` / a predicate on the request. Non-confirmation elicitations are
     * left untouched. Returns an {@link Unsubscribe}. Do NOT also answer
     * `tool_confirmation` in your own `session.elicitations` loop — last
     * responder wins.
     */
    readonly confirmClientTools: (policy: ConfirmPolicy) => Unsubscribe;
  }
}

registerSessionHandleExtension(
  "setClientTools",
  (client: ClientProtocol, sessionId: string) =>
    (declarations: readonly ClientToolDeclaration[]): Promise<SessionSetClientToolsResult> =>
      client.request("session/set_client_tools", { sessionId, declarations }),
);

registerSessionHandleExtension(
  "respondToToolCall",
  (client: ClientProtocol, sessionId: string) =>
    (correlationId: string, result: ToolResultInput): Promise<void> =>
      respondToToolCall(client, sessionId, correlationId, result),
);

registerSessionHandleExtension("clientToolCalls", (client: ClientProtocol, sessionId: string) =>
  clientToolCallStream(client, sessionId),
);

registerSessionHandleExtension(
  "routeClientTools",
  (client: ClientProtocol, sessionId: string) =>
    (
      handlers: Readonly<Record<string, ClientToolHandler>>,
      opts?: RouteClientToolsOptions,
    ): Unsubscribe =>
      routeClientTools(client, sessionId, handlers, opts),
);

registerSessionHandleExtension(
  "confirmClientTools",
  (client: ClientProtocol, sessionId: string) =>
    (policy: ConfirmPolicy): Unsubscribe =>
      confirmClientTools(client, sessionId, policy),
);
