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
 * as `@agentick/sandbox-next` and its `sandbox-local` / `sandbox-docker` /
 * `sandbox-secure-exec` adapters.
 *
 * @see #281 — CredentialsHarness substrate
 */

/**
 * Adopter-pluggable credentials backend. The harness scopes every call
 * to a `(namespace, key)` pair — convention is `<harness>:<discriminator>`
 * (e.g. `mcp:server-foo`, `gateway:bearer`, `sandbox:runtime-bar`) — and
 * never lets one harness's namespace leak into another.
 *
 * Values are generic `T` at the call site; backends marshal as needed
 * (JSON-encode for env / KV, opaque blob for keychain, encrypted bytes
 * for file). The store does NOT enforce a schema — that's the calling
 * harness's responsibility.
 *
 * All operations are async — real backends hit IPC / disk / network;
 * in-memory impls resolve synchronously inside Promises.
 */
export interface CredentialsStore {
  /**
   * Read stored credentials. Resolves `undefined` for absent keys —
   * the harness lifts this to `CredentialsNotFound` only when the
   * caller specifically asserts presence (a `require`-style accessor;
   * `get` itself never throws on absence).
   *
   * MAY throw `CredentialsBackendUnavailable` if the backend is
   * unreachable, `CredentialsCorrupted` if the value cannot be
   * deserialized.
   */
  get<T>(namespace: string, key: string): Promise<T | undefined>;

  /**
   * Persist credentials. Overwrites any prior entry for the same
   * `(namespace, key)`. MAY throw `CredentialsBackendUnavailable` or
   * `CredentialsWriteFailed`.
   */
  set<T>(namespace: string, key: string, value: T): Promise<void>;

  /**
   * Drop credentials. Idempotent — deleting an unknown key resolves
   * normally. Returns `true` if a value was actually removed, `false`
   * if the key was absent.
   */
  delete(namespace: string, key: string): Promise<boolean>;

  /**
   * Existence check. Cheap when the backend supports it; MAY fall
   * back to `get(...) !== undefined` for backends that don't have a
   * dedicated existence verb.
   */
  has(namespace: string, key: string): Promise<boolean>;

  /**
   * Enumerate keys in a namespace.
   *
   * **Foundational** per the `enumeration-is-foundational` rule:
   * adopter UIs need to render "what credentials does this namespace
   * have?" without prior knowledge of any specific key. Without this
   * primitive, every harness invents its own out-of-band discovery.
   *
   * Returns `[]` for unknown namespaces. Order is not specified.
   */
  keys(namespace: string): Promise<readonly string[]>;

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
