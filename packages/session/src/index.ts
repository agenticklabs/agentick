/**
 * `@agentick/session` — reference session harness.
 *
 * The integration site that wires JSX agent + reconciler + loop
 * executor into the user-facing `session.send({ messages })` surface.
 *
 * @see docs/proposals/v2/blueprint/08-session-harness.md
 */

export {
  SessionHarness,
  type SessionHarnessOptions,
} from "./harness.js";
export { SessionStateStore, type AppendMessageInput } from "./session-state.js";
