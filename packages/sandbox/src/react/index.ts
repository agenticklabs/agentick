/**
 * `@agentick/sandbox/react` — React bindings for the sandbox harness.
 *
 * Adopters import from here when they're using the
 * `@agentick/compiler-react` compiler. The agnostic surface
 * (bridge, harness, types) ships from `@agentick/sandbox`.
 *
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md
 */

// Module augmentation runs as a side effect of importing the bridge.
import "../augment.js";

export { Sandbox, type SandboxProps } from "./component.js";
export { useSandbox } from "./hook.js";
export { SandboxContext } from "./context.js";

// Re-export for ergonomic single-import adoption: adopters who import
// from `@agentick/sandbox/react` get the factory + the components
// in one place.
export { withSandbox, EXTENSION_NAME } from "../extension.js";
export { defineSandbox, type SandboxDefinition } from "../definition.js";
export { inMemorySandboxBridge, type SandboxBridge, type SandboxRegistration } from "../bridge.js";
export { SandboxHarness, type SandboxStatus } from "../harness.js";

// Pre-built tool components
export { Bash, ReadFile, WriteFile, EditFile } from "./tools.js";
