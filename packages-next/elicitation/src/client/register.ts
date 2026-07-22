/**
 * ADR 87 — contribute the elicitation surface to the client `SessionHandle`.
 *
 * Importing `@agentick/elicitation-next/client` both TYPES the slot
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

import { registerSessionHandleExtension } from "@agentick/client-core-next";

import { elicitationStream, type ElicitationsHandle } from "./elicitations.js";

declare module "@agentick/spec-next" {
  interface SessionHandleExtensions {
    /**
     * The elicitation resource handle — read surface + write command, the CQRS
     * shape shared by `session.knobs` (view + `set`) and `session.tasks`. Read
     * via `session.elicitations.onChange((e) => e.accept(value))` or
     * `for await (const e of session.elicitations)`; write by `correlationId`
     * via `session.elicitations.respond(input)`. Each yielded
     * {@link ClientElicitationHandle} carries typed `.accept`/`.decline`/`.cancel`.
     */
    readonly elicitations: ElicitationsHandle;
  }
}

registerSessionHandleExtension("elicitations", (client, sessionId) =>
  elicitationStream(client, sessionId),
);
