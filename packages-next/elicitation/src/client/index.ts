/**
 * `@agentick/elicitation-next/client` — the client-side elicitation surface.
 *
 * The far side of the `session:channel:elicitation` request channel + the
 * `session/respond_to_elicitation` reply command. Depends on
 * `@agentick/client-core-next` (the sub-handle registry) + spec types — NOT on the
 * elicitation harness runtime, so it stays out of a browser bundle. Mirrors the
 * tasks/knobs `/client` convention.
 *
 * Importing this subpath contributes `client.session(id).elicitations()` and
 * `.respondToElicitation(...)` to the client `SessionHandle` (ADR 87).
 */

export {
  elicitationStream,
  respondToElicitation,
  type ElicitationReplyInput,
  type ElicitationsHandle,
} from "./elicitations.js";

// Side-effect: contribute the elicitation slots to the client SessionHandle.
import "./register.js";
