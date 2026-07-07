/**
 * `@agentick/sandbox-next` — the BASE sandbox package (ADR 59).
 *
 * Holds the harness + bridge impl + ACL, the `SandboxProvider`
 * construction contract + `SandboxHandle` live-object interface, the
 * crown-jewel `applyEdits` transform, and the pure network matcher.
 * Providers (`sandbox-local-next`, `sandbox-docker-next`) dep THIS
 * package and implement `SandboxProvider` — mirroring
 * `model-openai-next → model-next`.
 *
 * This entry is REACT-FREE. React bindings (`<Sandbox>`, `useSandbox`,
 * the pre-built tool components) ship from `@agentick/sandbox-next/react`.
 * The provider conformance suite + the in-memory fake ship from
 * `@agentick/sandbox-next/testing`.
 *
 * It re-exports the spec sandbox WIRE types alongside its own
 * construction contracts, so a provider has ONE import source.
 *
 * Importing anything from this module brings the `HookBridges.sandbox`
 * augmentation in, so adopters' `useBridges().sandbox` is typed.
 *
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

// Side-effect import — module augmentation runs as a top-level
// `declare module` block when this file (or anything that imports it)
// is loaded.
import "./augment.js";

// ── Construction contracts + live-object interfaces (ADR 59) ────────────────
// NOT wire types — the provider↔harness internal contracts. Providers
// implement `SandboxProvider` and return a `SandboxHandle`.
export type {
  SandboxProvider,
  SandboxHandle,
  SandboxCreateOptions,
  SandboxSnapshot,
  SandboxIntent,
} from "./contract.js";

// ── Spec sandbox WIRE types (re-exported for a single import source) ─────────
// The inbox-serialized command payloads/results, the network firewall
// vocabulary, and the ACL / telemetry shapes. Providers can import these
// from here instead of reaching into `@agentick/spec-next` directly. The
// sandbox error CLASSES are re-exported below via `./errors.js`.
export type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxExecInput,
  SandboxExecDelta,
  SandboxReadFileInput,
  SandboxWriteFileInput,
  SandboxEditFileInput,
  SandboxEdit,
  SandboxEditChange,
  SandboxEditResult,
  SandboxMount,
  SandboxAddMountInput,
  SandboxRemoveMountInput,
  SandboxPermissions,
  SandboxResourceLimits,
  SandboxACL,
  SandboxPermissionRequest,
  SandboxPermissionResponse,
  NetworkRule,
  ProxiedRequest,
} from "@agentick/spec-next";

export { inMemorySandboxBridge, type SandboxBridge, type SandboxRegistration } from "./bridge.js";

export { SandboxHarness, type SandboxHarnessOptions, type SandboxStatus } from "./harness.js";

// The crown-jewel edit transform + the pure egress matcher live in this
// base package so providers (which dep the base) share one implementation
// (ADR 59).
export { applyEdits, EditError } from "./edit.js";
export { matchRequest, matchDomain, type MatchResult, type NetworkRequest } from "./net.js";

export {
  SessionACL,
  matches as matchesACLPattern,
  type ACLDecision,
  type SessionACLSnapshot,
} from "./acl.js";

export * from "./errors.js";

export { withSandbox, type WithSandboxOptions } from "./extension.js";
