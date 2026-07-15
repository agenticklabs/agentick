/**
 * ADR 87 — contribute the elicitation surface to the client `SessionHandle`.
 *
 * Importing `@agentick/elicitation-next/client` both TYPES the slots
 * (`declare module`) and REGISTERS the runtime factories, so
 * `client.session(id).elicitations()` / `.respondToElicitation(...)`
 * self-assemble — the client twin of the server's `bridges.elicitation`.
 *
 * These two members used to be hardcoded on `SessionHandle` in client-core;
 * relocating them here keeps client-core harness-agnostic (same bundled-not-
 * privileged law as tasks/knobs). The public API is unchanged — a registrant
 * slot may be a method (the getter yields the function), so call sites keep
 * `session.elicitations(opts?)` / `session.respondToElicitation(input)`.
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
