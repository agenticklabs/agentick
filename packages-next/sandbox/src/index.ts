/**
 * `@agentick/sandbox/v2` — sandbox-as-harness surface.
 *
 * The agnostic half (bridge + harness + types + augmentation +
 * extension factory). React-specific bindings ship from
 * `@agentick/sandbox/v2/react`.
 *
 * Importing anything from this module brings the `HookBridges.sandbox`
 * augmentation in, so adopters' `useBridges().sandbox` is typed.
 *
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md
 */

// Side-effect import — module augmentation runs as a top-level
// `declare module` block when this file (or anything that imports it)
// is loaded.
import "./augment.js";

export { inMemorySandboxBridge, type SandboxBridge, type SandboxRegistration } from "./bridge.js";

export { SandboxHarness, type SandboxHarnessOptions, type SandboxStatus } from "./harness.js";

export { applyEdits, EditError } from "./edit.js";

export {
  SessionACL,
  matches as matchesACLPattern,
  type ACLDecision,
  type SessionACLSnapshot,
} from "./acl.js";

export * from "./errors.js";

export { withSandbox, type WithSandboxOptions } from "./extension.js";
