/**
 * `@agentick/knobs-next/client` — the client-side projection of knob state.
 *
 * The far side of the `knobs-state` channel: a reactive view an app frontend
 * subscribes to. Depends on `@agentick/client-next` (the generic `channelView`)
 * — NOT on the knobs harness runtime. Mirrors the `/react` subpath convention:
 * a harness package may add a `/client` surface that depends on the generic
 * client without pulling the server harness into a browser bundle.
 */

export { knobsStateView, type KnobsState } from "./knobs-state-view.js";
