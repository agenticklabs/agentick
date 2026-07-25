/**
 * `CredentialsStore` — pluggable backend adapter for the
 * {@link CredentialsHarness} substrate.
 *
 * Same shape as `SandboxRuntime` or `TasksExecutor`: the harness owns
 * the substrate-level concerns (lifecycle, namespace-scoped bridges,
 * reactive change fan-out via PubSub, conformance); the store
 * implements the persistence layer.
 *
 * **Server-resident invariant.** Stores are constructed at gateway
 * boot and never accessed from client-side code. Credential material
 * never crosses the wire (see #279 + the `feedback_credentials_never_cross_wire`
 * memory). Adopters that need to drive credential lifecycle from a
 * browser/React UI do so by sending action verbs (`reauthenticate()`,
 * `disconnect()`) over the wire; the server resolves them through the
 * store.
 *
 * Reference adapters bundled with this package:
 *
 *   - {@link inMemoryCredentialsStore} — `Map`-backed; default for tests
 *     and ephemeral CLIs.
 *   - {@link envCredentialsStore} — environment-variable backed; useful
 *     for headless deployments where credentials come from the platform
 *     runtime (k8s secrets, Vercel env, etc.).
 *
 * Additional first-party adapters (`keychainCredentialsStore`,
 * `libsecretCredentialsStore`, `encryptedFileCredentialsStore`,
 * `kvCredentialsStore`) land in follow-up slices once the substrate
 * surface is locked.
 *
 * Adopters write custom adapters (1Password, HashiCorp Vault, AWS
 * Secrets Manager, etc.) by implementing the interface — same model
 * as `@agentick/sandbox` and its `sandbox-local` / `sandbox-docker` /
 * `sandbox-secure-exec` adapters.
 *
 * @see #281 — CredentialsHarness substrate
 */

import type { Store, StoreCtx } from "@agentick/spec";

/**
 * The credentials store's record — the `(namespace, key)` coordinate plus its
 * opaque value. The `T` of the {@link Store} seam a `CredentialsStore` projects.
 * `value` is `unknown`: the store marshals it (JSON for env / KV, opaque blob
 * for keychain) and does NOT enforce a schema — that is the calling harness's
 * job. The value-projecting ergonomic surface (`get<V>`) narrows it per call.
 */
export interface CredentialEntry {
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
}

/**
 * The credentials store's {@link Store} QUERY vocabulary — scope a projection to
 * one namespace (`{ namespace }`) or, omitting it (`undefined` / `{}`), request
 * every entry the backend can enumerate. The seam analogue of `keys(namespace)`,
 * but projecting whole {@link CredentialEntry} records rather than bare keys.
 */
export interface CredentialQuery {
  /** Scope to one namespace. Omit → every entry (backends that can enumerate all). */
  readonly namespace?: string;
}

/**
 * The credentials store's {@link Store} MUTATION vocabulary — a keyed `set`
 * (upsert the entry) or a keyed `delete`. The seam analogue of the `set` /
 * `delete` ergonomic methods.
 */
export type CredentialMutation =
  | { readonly set: CredentialEntry }
  | { readonly delete: { readonly namespace: string; readonly key: string } };

/**
 * Adopter-pluggable credentials backend. The harness scopes every call
 * to a `(namespace, key)` pair — convention is `<harness>:<discriminator>`
 * (e.g. `mcp:server-foo`, `gateway:bearer`, `sandbox:runtime-bar`) — and
 * never lets one harness's namespace leak into another.
 *
 * ## A {@link Store} profile — conformant, not an island
 *
 * `CredentialsStore extends Store<CredentialEntry, CredentialQuery,
 * CredentialMutation>`: it keeps its value-projecting ergonomic surface
 * (`get<V>` / `set<V>` / `has` / `keys` / `delete` / `onChange`) but ALSO
 * satisfies the universal seam — `query` projects {@link CredentialEntry}
 * records under a namespace, `mutate` sets/deletes. Every store in the
 * framework is `Store`; credentials is no exception. The seam is no more
 * value-exposing than `get` already is: the store is server-resident (credential
 * material never crosses the wire — see the file header), so projecting entries
 * with their values is consistent with the existing server-side surface.
 *
 * Values are generic `T` at the call site; backends marshal as needed
 * (JSON-encode for env / KV, opaque blob for keychain, encrypted bytes
 * for file). The store does NOT enforce a schema — that's the calling
 * harness's responsibility.
 *
 * All operations are async — real backends hit IPC / disk / network;
 * in-memory impls resolve synchronously inside Promises.
 *
 * ## `ctx: StoreCtx` — the runtime-scope carrier (Run B, Ryan's call)
 *
 * Every DATA method takes a mandatory {@link StoreCtx} as its FINAL argument —
 * the same explicit runtime-scope carrier every other store archetype threads
 * across the Effect→Promise boundary. A secrets adapter needs it to resolve
 * WHOSE / WHICH secret: a real backend (AWS Secrets Manager, HashiCorp Vault,
 * 1Password) reads `ctx.principal` (the identity the credential belongs to) and
 * `ctx.scope` fields to pick the right secret path / tenant / vault mount. The
 * bundled in-memory / env reference adapters IGNORE `ctx` — they hold no
 * identity-scoped state — but the port carries it so an identity-aware adapter
 * conforms to the SAME shape. `onChange` stays ctx-less: it is a registration,
 * not a scoped data operation.
 */
export interface CredentialsStore extends Store<
  CredentialEntry,
  CredentialQuery,
  CredentialMutation
> {
  /**
   * SEAM READ — project {@link CredentialEntry} records shaped by a
   * {@link CredentialQuery}. `{ namespace }` scopes to one namespace; an absent
   * query requests every enumerable entry. The value-projecting analogue of
   * `keys(namespace)`; `get` remains the single-key sugar. `ctx` — see
   * {@link StoreCtx}; an identity-aware backend scopes to `ctx.principal`.
   */
  query(q: CredentialQuery | undefined, ctx: StoreCtx): Promise<readonly CredentialEntry[]>;

  /**
   * SEAM WRITE — apply a {@link CredentialMutation}. `{ set }` upserts the entry
   * (the `set` sugar); `{ delete }` removes it (the `delete` sugar). `ctx` — see
   * {@link StoreCtx}.
   */
  mutate(m: CredentialMutation, ctx: StoreCtx): Promise<void>;

  /**
   * Read stored credentials. Resolves `undefined` for absent keys —
   * the harness lifts this to `CredentialsNotFound` only when the
   * caller specifically asserts presence (a `require`-style accessor;
   * `get` itself never throws on absence).
   *
   * MAY throw `CredentialsBackendUnavailable` if the backend is
   * unreachable, `CredentialsCorrupted` if the value cannot be
   * deserialized. `ctx` — see {@link StoreCtx}; an identity-aware
   * backend resolves the secret against `ctx.principal`.
   */
  get<T>(namespace: string, key: string, ctx: StoreCtx): Promise<T | undefined>;

  /**
   * Persist credentials. Overwrites any prior entry for the same
   * `(namespace, key)`. MAY throw `CredentialsBackendUnavailable` or
   * `CredentialsWriteFailed`. `ctx` — see {@link StoreCtx}.
   */
  set<T>(namespace: string, key: string, value: T, ctx: StoreCtx): Promise<void>;

  /**
   * Drop credentials. Idempotent — deleting an unknown key resolves
   * normally. Returns `true` if a value was actually removed, `false`
   * if the key was absent. `ctx` — see {@link StoreCtx}.
   */
  delete(namespace: string, key: string, ctx: StoreCtx): Promise<boolean>;

  /**
   * Existence check. Cheap when the backend supports it; MAY fall
   * back to `get(...) !== undefined` for backends that don't have a
   * dedicated existence verb. `ctx` — see {@link StoreCtx}.
   */
  has(namespace: string, key: string, ctx: StoreCtx): Promise<boolean>;

  /**
   * Enumerate keys in a namespace.
   *
   * **Foundational** per the `enumeration-is-foundational` rule:
   * adopter UIs need to render "what credentials does this namespace
   * have?" without prior knowledge of any specific key. Without this
   * primitive, every harness invents its own out-of-band discovery.
   *
   * Returns `[]` for unknown namespaces. Order is not specified. `ctx`
   * — see {@link StoreCtx}; an identity-aware backend scopes the
   * enumeration to `ctx.principal`.
   */
  keys(namespace: string, ctx: StoreCtx): Promise<readonly string[]>;

  /**
   * Optional external-change notification hook. Backends that natively
   * observe their underlying storage (keychain rotation via FS events,
   * KV change streams) expose this so the harness can fan changes out
   * to consumers without polling.
   *
   * Stores that don't support reactivity OMIT this method — the
   * harness handles its own change notifications for `set` / `delete`
   * calls it routes itself; the optional hook only adds visibility
   * into changes the harness didn't cause (another process editing
   * the keychain, an admin pushing to KV, etc.).
   */
  onChange?(
    listener: (event: { readonly namespace: string; readonly key: string }) => void,
  ): () => void;

  /**
   * Stable identifier for telemetry and error reporting. Examples:
   * `"in-memory"`, `"env"`, `"keychain"`, `"libsecret"`,
   * `"encrypted-file"`. Adopter-written adapters pick their own
   * (`"1password"`, `"vault"`, etc.) — should be lowercase kebab-case
   * by convention.
   */
  readonly backend: string;
}
