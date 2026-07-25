/**
 * ADR 87 — contribute the elicitation surface to the client `SessionHandle`.
 *
 * Importing `@agentick/elicitation/client` both TYPES the slot
 * (`declare module`) and REGISTERS the runtime factory, so the
 * `client.session(id).elicitations` PROPERTY (an `ElicitationsHandle`)
 * self-assembles — the client twin of the server's `bridges.elicitation`.
 *
 * This member used to be hardcoded on `SessionHandle` in client-core;
 * relocating it here keeps client-core harness-agnostic (same bundled-not-
 * privileged law as tasks/knobs). Read the handle via
 * `for await (const e of session.elicitations)` or
 * `session.elicitations.onChange(...)`; reply via `session.elicitations.respond(...)`
 * (or per-item `e.accept`/`e.decline`/`e.cancel`).
 */

import { registerSessionHandleExtension } from "@agentick/client-core";

import { elicitationsHandle, type ElicitationsHandle } from "./elicitations.js";

declare module "@agentick/spec" {
  interface SessionHandleExtensions {
    /**
     * The elicitation resource handle on the `ClientHandle` contract:
     * `list()`/`get(id)` over the PENDING asks (Enumerable — a client connecting
     * mid-ask sees the outstanding prompt), the zero-arg `subscribe(cb)` store
     * contract, and `respond(correlationId, body)` (Respondable by-id).
     * `list()` yields item handles, each carrying typed
     * `.accept`/`.decline`/`.cancel`:
     * `session.elicitations.subscribe(() => { for (const e of session.elicitations.list()) showDialog(e); })`.
     */
    readonly elicitations: ElicitationsHandle;
  }
}

registerSessionHandleExtension("elicitations", (client, sessionId) =>
  elicitationsHandle(client, sessionId),
);
