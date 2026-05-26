/**
 * `@agentick/state/react` — React bindings for StateHarness.
 *
 * Per ADR 27, the React surface for a harness lives in its own /react
 * subpath.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

// Side-effect import — registers the HookBridges.state slot.
import "../augment.js";

export { useSessionState } from "./use-session-state.js";
