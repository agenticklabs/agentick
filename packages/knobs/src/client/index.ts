/**
 * `@agentick/knobs/client` — the client-side projection of knob state.
 *
 * The far side of the `knobs-state` channel: a reactive view an app frontend
 * subscribes to. Depends on `@agentick/client-core` (the generic `channelView`)
 * — NOT on the knobs harness runtime. Mirrors the `/react` subpath convention:
 * a harness package may add a `/client` surface that depends on the generic
 * client without pulling the server harness into a browser bundle.
 */

// Type-only side effect: makes `knobs/set` a valid `WireMethods` row for the
// client handle's `transport.request("knobs/set", …)` — WITHOUT the server
// bridge augmentations (zero runtime).
import "../wire-augment.js";

export {
  knobsStateView,
  type KnobsState,
  type KnobsClient,
  type KnobsCommandClient,
} from "./knobs-state-view.js";
export { knobsHandle, type KnobsHandle } from "./knobs-handle.js";

// Side-effect: contribute `session.knobs` to the client SessionHandle (ADR 87).
import "./register.js";
