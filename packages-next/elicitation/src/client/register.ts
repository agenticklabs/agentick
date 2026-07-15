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
import type { ClientElicitationStream, Cursor } from "@agentick/spec-next";

import {
  elicitationStream,
  respondToElicitation,
  type ElicitationReplyInput,
} from "./elicitations.js";

declare module "@agentick/spec-next" {
  interface SessionHandleExtensions {
    /**
     * AsyncIterable of inbound elicitation requests for this session. Each
     * yielded {@link ClientElicitationHandle} carries typed `.accept` /
     * `.decline` / `.cancel`. Pass `fromCursor` to resume from a saved point.
     */
    elicitations(opts?: { fromCursor?: Cursor }): ClientElicitationStream;
    /**
     * Reply to a pending elicitation by `correlationId` — the direct command
     * for code not holding a handle (the handle's `.accept` etc. use this).
     */
    respondToElicitation(input: ElicitationReplyInput): Promise<void>;
  }
}

registerSessionHandleExtension(
  "elicitations",
  (client, sessionId) =>
    (opts?: { fromCursor?: Cursor }): ClientElicitationStream =>
      elicitationStream(client, sessionId, opts?.fromCursor),
);

registerSessionHandleExtension(
  "respondToElicitation",
  (client, sessionId) =>
    (input: ElicitationReplyInput): Promise<void> =>
      respondToElicitation(client, sessionId, input),
);
