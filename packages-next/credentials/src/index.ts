/**
 * `@agentick/credentials-next` — `CredentialsHarness` substrate +
 * pluggable backend adapters.
 *
 * v2's unified credential storage primitive. Replaces v1's
 * `@agentick/secrets` (string-only, flat namespace, non-reactive) and
 * supersedes the per-harness `CredentialsStore<T>` shims that
 * accumulated before the substrate landed.
 *
 * Architecture:
 *
 *   - `CredentialsStore` (interface) — adopter-pluggable backend
 *     adapter. Same shape as `SandboxRuntime` or `TasksExecutor`:
 *     the harness owns substrate concerns, the store owns
 *     persistence.
 *   - Reference adapters bundled here: in-memory, env. Additional
 *     first-party adapters (keychain, libsecret, encrypted-file, KV)
 *     ship in follow-up slices. Adopter-written adapters
 *     (1Password, HashiCorp Vault, AWS Secrets Manager) implement
 *     the interface directly.
 *   - `CredentialsHarness` (slice 281b) — the substrate harness
 *     itself; this slice ships the interfaces + adapters only.
 *
 * Invariants:
 *
 *   - **Server-resident always.** Credentials never cross the wire
 *     (see [[credentials-never-cross-wire]] memory and #279). The
 *     client surface for credential operations exposes verbs
 *     (`reauthenticate()`, `disconnect()`) and status, never tokens.
 *   - **Namespace-scoped.** Convention: `<harness>:<discriminator>`
 *     (`mcp:server-foo`, `gateway:bearer`, `sandbox:runtime-bar`).
 *     Non-credential secrets squat under `secrets:*` if needed —
 *     the store sees only opaque `(namespace, key, T)` triples.
 *   - **Enumeration foundational.** Every backend implements
 *     `keys(namespace)` so adopter UIs can render the topology
 *     without prior knowledge (see [[enumeration-is-foundational]]
 *     memory).
 *
 * @see #281 — substrate parent ticket
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md — ADR 27
 *      modularity pattern
 */

// Side-effect import — registers the `credentials` slot on `HookBridges`
// via TypeScript module augmentation. Per ADR 27, every harness
// package owns its own slot declaration.
import "./augment.js";

export type { CredentialsStore } from "./store.js";

export { CredentialsHarness, type CredentialsHarnessOptions } from "./harness.js";

export { withCredentials, type WithCredentialsOptions } from "./extension.js";

export type { CredentialsChangeEvent, CredentialsHarnessProtocol } from "@agentick/spec-next";

export {
  inMemoryCredentialsStore,
  envCredentialsStore,
  type EnvCredentialsStoreOptions,
} from "./stores/index.js";

export {
  runCredentialsStoreConformance,
  type CredentialsStoreConformanceOptions,
} from "./conformance.js";

export {
  runCredentialsHarnessConformance,
  type CredentialsHarnessConformanceOptions,
} from "./harness-conformance.js";

// Error types re-exported from spec-next for convenience — adopters
// who only depend on credentials-next get them without a second import.
export {
  CredentialsError,
  type CredentialsErrorChannel,
  CredentialsNotFound,
  CredentialsBackendUnavailable,
  CredentialsCorrupted,
  CredentialsWriteFailed,
} from "@agentick/spec-next";
