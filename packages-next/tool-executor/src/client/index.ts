/**
 * `@agentick/tool-executor-next/client` — the client-side client-tool surface.
 *
 * The write side of client-handled tools: `session.setClientTools(declarations)`
 * (DECLARE the client's full tool set into the session — a whole-slice replace)
 * and `session.respondToToolCall(correlationId, result)` (relay a tool-call
 * result back). Both ride `client.request(...)` against the session-namespace
 * wire methods `session/set_client_tools` / `session/respond_to_tool_call`.
 *
 * Depends on `@agentick/client-core-next` (the sub-handle registry) + spec
 * types — NOT on the tool-executor harness runtime, so it stays out of a
 * browser bundle. Mirrors the elicitation/tasks/knobs `/client` convention.
 *
 * Importing this subpath contributes `client.session(id).setClientTools(...)`
 * and `.respondToToolCall(...)` to the client `SessionHandle` (ADR 87).
 *
 * The client-side tool-call ROUTER (subscribe → dispatch to a user handler →
 * `respondToToolCall`) is STAGE 3 and not in this subpath yet.
 */

// Side-effect: type the slots (declare module) + register the runtime factories.
import "./register.js";
