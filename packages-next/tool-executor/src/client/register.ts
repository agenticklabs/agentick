/**
 * ADR 87 — contribute the client-tool WRITE verbs to the client `SessionHandle`.
 *
 * Importing `@agentick/tool-executor-next/client` both TYPES the slots
 * (`declare module`) and REGISTERS the runtime factories, so
 * `client.session(id).setClientTools(...)` / `.respondToToolCall(...)`
 * self-assemble — the client twin of the server's `session.toolExecutor` seam
 * behind `session/set_client_tools` / `session/respond_to_tool_call`.
 *
 * Write side only (stage 2). The client-side ROUTER — subscribing to
 * `session:channel:tool_call` requests, mapping each to a user handler, and
 * calling `respondToToolCall` — is STAGE 3. These verbs give stage 3 the
 * request primitives.
 *
 * Depends on `@agentick/client-core-next` + spec types only — NOT on the
 * tool-executor harness runtime — so it stays out of a browser bundle, matching
 * the elicitation/tasks/knobs `/client` convention.
 */

import { registerSessionHandleExtension } from "@agentick/client-core-next";
import type {
  ClientProtocol,
  ClientToolDeclaration,
  SessionSetClientToolsResult,
  ToolResultInput,
} from "@agentick/spec-next";

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
    async (correlationId: string, result: ToolResultInput): Promise<void> => {
      await client.request("session/respond_to_tool_call", { sessionId, correlationId, result });
    },
);
