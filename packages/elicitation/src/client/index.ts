/**
 * `@agentick/elicitation/client` — the client-side elicitation surface.
 *
 * The far side of the `session:channel:elicitation` request channel + the
 * `session/respond_to_elicitation` reply command. Depends on
 * `@agentick/client-core` (the sub-handle registry) + spec types — NOT on the
 * elicitation harness runtime, so it stays out of a browser bundle. Mirrors the
 * tasks/knobs `/client` convention.
 *
 * Importing this subpath contributes the `client.session(id).elicitations`
 * property (an `ElicitationsHandle` — `list()`/`get(id)` the pending asks,
 * `subscribe(cb)`, reply via `.respond(id, body)` or a listed item's
 * `.accept`/`.decline`/`.cancel`) to the client `SessionHandle` (ADR 87). It
 * also exports the `respondToElicitation` free function — the by-`correlationId`
 * reply escape hatch for code not holding the handle.
 */

export {
  elicitationsHandle,
  respondToElicitation,
  type ElicitationClient,
  type ElicitationReplyBody,
  type ElicitationReplyInput,
  type ElicitationsHandle,
} from "./elicitations.js";

// Side-effect: contribute the elicitation slots to the client SessionHandle.
import "./register.js";
