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

// The crown-jewel edit transform now lives in the shared, OS-free
// `@agentick/sandbox-edit-next` so providers (which can't import this
// harness package) share one implementation. Re-exported here so the
// harness's own import path is unchanged (ADR 59, Wave 2).
export { applyEdits, EditError } from "@agentick/sandbox-edit-next";

export {
  SessionACL,
  matches as matchesACLPattern,
  type ACLDecision,
  type SessionACLSnapshot,
} from "./acl.js";

export * from "./errors.js";

export { withSandbox, type WithSandboxOptions } from "./extension.js";
