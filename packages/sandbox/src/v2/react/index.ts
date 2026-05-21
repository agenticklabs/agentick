/**
 * `@agentick/sandbox/v2/react` — React bindings for the sandbox harness.
 *
 * Adopters import from here when they're using the
 * `@agentick/reconciler-react` reconciler. The agnostic surface
 * (bridge, harness, types) ships from `@agentick/sandbox/v2`.
 *
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md
 */

// Module augmentation runs as a side effect of importing the bridge.
import "../augment.js";

export { Sandbox, type SandboxProps } from "./component.js";
export { useSandbox } from "./hook.js";
export { SandboxContext } from "./context.js";

// Re-export from /v2 for ergonomic single-import adoption: adopters
// who import from `@agentick/sandbox/v2/react` get the factory + the
// components in one place.
export { withSandbox } from "../extension.js";
export type { WithSandboxOptions } from "../extension.js";
export { inMemorySandboxBridge, type SandboxBridge, type SandboxRegistration } from "../bridge.js";
export { SandboxHarness, type SandboxStatus } from "../harness.js";

// Pre-built tool components
export { Bash, ReadFile, WriteFile, EditFile } from "./tools.js";
