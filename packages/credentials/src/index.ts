/**
 * `@agentick/credentials` — one harness, many providers (ADR 107).
 *
 * The framework's answer to "what may this principal act with", the twin of the
 * auth seam's "who is acting". `AuthSource` establishes an identity and the
 * journal records it; a credential provider resolves the authority that identity
 * acts with, and the journal records only that a resolution happened.
 *
 * ## Shape
 *
 * - {@link CredentialProvider} — one namespace's source. `get` is a RESOLUTION
 *   verb: read from a store, exchange a grant, or mint on demand. Everything
 *   past `get` is optional, because a minter has nothing to `set` and no
 *   meaningful `keys`.
 * - {@link CredentialsHarness} — a registry of providers keyed by namespace,
 *   with `register` / `unregister` / `start` / `stop`, the same shape the
 *   connectors harness has. Routing is exact: one owner per namespace, and an
 *   unregistered namespace is an error rather than an empty result.
 * - {@link defineCredentialProvider} — the authoring door, validating at
 *   definition time so a malformed provider fails where it is written.
 *
 * The harness always exists, with one provider pre-registered: an in-memory
 * store under {@link EPHEMERAL_NAMESPACE}. It is named for its lifetime because
 * a name promising persistence would invite the failure this package exists to
 * prevent — a credential silently gone after a restart. Nothing in the framework
 * writes to it.
 *
 * ## Invariants
 *
 * - **Server-resident always.** Credentials never cross the wire. A client
 *   surface exposes verbs (`reauthenticate()`, `disconnect()`) and status, never
 *   tokens.
 * - **Never on a tool handler's `ctx`.** The slot lives on `HookBridges`, so
 *   host and tree code reach it and tools do not. The actor choosing which tool
 *   to call is a model following untrusted input; a `ctx.credentials` would be a
 *   credential-exfiltration verb. Host code binds ports that hold authority, and
 *   tools call those ports.
 * - **No inbox protocol.** An inbox verb would be a network-reachable secret
 *   read. The refusal is deliberate.
 * - **Coordinates, never values.** Writes journal `credentialNamespace` /
 *   `credentialKey`; change events carry the same. An audit trail that proves
 *   which credential was read for which operation, without the secret touching
 *   the journal.
 *
 * @see docs/proposals/v2/blueprint/107-credentials-as-builtin.md
 */

// Side-effect import — registers the `credentials` slot on `HookBridges` via
// module augmentation. Per ADR 27, every harness package owns its own slot.
import "./augment.js";

export type { CredentialProvider, CredentialProviderSpec } from "./provider.js";
export { defineCredentialProvider } from "./define-provider.js";

export {
  CredentialsHarness,
  type CredentialsHarnessOptions,
  type CredentialsMutationInput,
  type CredentialsRegistryInput,
} from "./harness.js";

export {
  EPHEMERAL_NAMESPACE,
  envCredentialProvider,
  inMemoryCredentialProvider,
  type EnvCredentialProviderOptions,
  type InMemoryCredentialProviderOptions,
} from "./providers/index.js";

export {
  CredentialOperationUnsupported,
  DuplicateCredentialNamespace,
  UnknownCredentialNamespace,
} from "./errors.js";

export type { CredentialsChangeEvent, CredentialsHarnessProtocol } from "@agentick/spec";

// Error types re-exported from @agentick/spec for convenience — adopters who
// depend only on @agentick/credentials get them without a second import.
export {
  CredentialsError,
  type CredentialsErrorChannel,
  CredentialsNotFound,
  CredentialsBackendUnavailable,
  CredentialsCorrupted,
  CredentialsWriteFailed,
} from "@agentick/spec";
