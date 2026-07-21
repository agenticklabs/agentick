# @agentick/credentials-next

**v2 substrate-level credential storage.** Server-resident; credentials never cross the wire.

Bundled in the `agentick` metapackage. Drop-in replacement for v1's
`@agentick/secrets`, with generic-typed values, namespaced keys, native
reactivity, and the typed-error infrastructure from ADR 41.

## Status

Slice **281a** (shipped): substrate interfaces + bundled reference
adapters (`inMemoryCredentialsStore`, `envCredentialsStore`) + typed
errors + store conformance suite.

Slice **281b.1** (this commit): `CredentialsHarness` substrate
harness class (Effect-typed; `BaseHarness`-derived) + module
augmentation adding `bridges.credentials` slot + harness conformance
suite + `/testing` doubles (`fakeCredentialsHarness`,
`stubCredentialsStore`, `unavailableCredentialsStore`). NO Extension
factory yet; NO app/gateway wiring yet — pure harness contract
testable in isolation.

Slice **281b.2** (this commit): `withCredentials({ store })`
`AppExtension` factory — constructs ONE `CredentialsHarness` at
install time and registers it on the app's `extensionBridges`
map. Sessions inherit the SAME instance via the existing
`extensionBridges`-cascade pattern (the app's `createSession`
copies the app-level map into each session's bridge tree).
Cross-session sharing is therefore an emergent property of
`AppHarness` — already covered by app-next's own tests — not a
property of `withCredentials`. This slice tests the extension's
own contract: registration shape, harness wiring, lifecycle.

Slice **281c**: Migrate `withMCP` from the placeholder
`CredentialsStore<T>` shim (#277a) to read `installer.credentials`.
Delete the per-MCP shim.

When #254 (`GatewayExtension` factory) ships, `withCredentials`
gains a third install variant that puts the harness at gateway level
— cascading down to apps the same way app-level cascades to sessions
today.

## Why a new package

v1's `@agentick/secrets` had the right shape but the wrong types:

| Concern         | v1 `secrets`              | v2 `credentials-next`               |
|-----------------|---------------------------|-------------------------------------|
| Value type      | `string` only             | Generic `T` per call site           |
| Namespacing     | Flat key-space            | `(namespace, key)` tuples           |
| Reactivity      | None — poll if you care   | `onChange` + harness PubSub fan-out |
| Enumeration     | `list()` over flat keys   | `keys(namespace)` per-domain        |
| Errors          | Throws raw `Error`        | `AgentickError` subclasses (ADR 41) |
| Effect-typed    | No                        | Yes (via spec-next errors)          |
| Pluggable       | Yes (keychain/libsecret/env/memory) | Yes (same set + encrypted-file + KV + adopter-written) |

The shape is intentionally similar to v1's, just with the type system
and reactivity v2 has elsewhere — adopters porting from v1 will find
the conceptual move trivial.

## Architecture

```
┌────────────────────────────────────────┐
│  CredentialsHarness  (281b)            │  ← substrate harness;
│  - lifecycle, conformance              │    augments HookBridges,
│  - change-notification PubSub          │    owns scoping, reactive
│  - namespace scoping                   │    fan-out
└──────────────┬─────────────────────────┘
               │ .store: CredentialsStore
               ▼
┌────────────────────────────────────────┐
│  CredentialsStore  (interface)         │  ← pluggable backend
│  - get / set / delete / has / keys     │    adapter; ONE per
│  - optional onChange                   │    gateway
└──────────────┬─────────────────────────┘
               │ implementations
               ▼
┌────────────────────────────────────────┐
│  Bundled reference adapters            │
│  ✅ inMemoryCredentialsStore           │
│  ✅ envCredentialsStore                │
│  ⏳ keychainCredentialsStore (macOS)   │
│  ⏳ libsecretCredentialsStore (Linux)  │
│  ⏳ encryptedFileCredentialsStore      │
│  ⏳ kvCredentialsStore (cluster-redis) │
│                                        │
│  Adopter-written adapters              │
│  • 1Password, Vault, AWS Secrets       │
│  • Same interface; same conformance    │
└────────────────────────────────────────┘
```

Same pattern as `@agentick/sandbox-next` + its runtime adapters
(`sandbox-local`, `sandbox-docker`, `sandbox-secure-exec`).

## Server-resident invariant

**Credentials never cross the wire.** The harness lives at the
gateway, all adapters are constructed server-side, all reads/writes
happen server-side. Browser/React UIs that need to drive credential
lifecycle (re-auth, disconnect) do so via action verbs over the
client wire — the server resolves the verb against the
credentials harness; the response carries status (`connected`,
`credentials-expired`, etc.), never tokens.

See `feedback_credentials_never_cross_wire` memory and #279 for the
client wire projection design.

### Async-only, no projection, empty wire surface

Credentials is the data-layer store-substrate's deliberate
counter-example — the store-backed harness that proves three Playbook
rules are CONDITIONAL, not universal:

- **No `View` (P5).** The harness reads its `CredentialsStore`
  LIVE and async — `get`/`has`/`keys` are bare `await store.<verb>()`,
  with NO synchronous cache. Post-convergence a store-backed harness
  holds a `View` / `LogView` **IFF it has a synchronous read surface**:
  the render-read / sync-read harnesses (knobs, state, skills, prompts,
  tasks, timeline, resources) all do; credentials is the deliberate
  async-only exception — its reads are off the render path, so it holds
  NO `View` and is not `SnapshotCapable`. The rule is "every SYNC-READ
  harness has a view", not "every store-backed harness does".
- **Empty wire surface (P6).** The harness projects NOTHING to the
  client — the valid empty case. Client-driven lifecycle travels as
  action verbs, not a state mirror.
- **`onChange` as change SOURCE.** When the adapter exposes
  `onChange`, the harness forwards THAT (a possibly-shared,
  externally-mutated store) as its change source rather than
  publishing a self-caused stream — the cross-consumer observation
  seam, not a single-writer's own echo.

## Quick start

```ts
import {
  inMemoryCredentialsStore,
  envCredentialsStore,
} from "@agentick/credentials-next";

// Tests / ephemeral CLI
const store = inMemoryCredentialsStore();

// Platform-managed env vars (k8s secrets, Vercel env, Docker --env-file)
const envStore = envCredentialsStore({ prefix: "AGENTICK_CRED" });

// Adopter use — app-level install (the production path):
const app = await createApp(<Agent />, {
  executor,
  extensions: [
    withCredentials({ store: envStore }),
  ],
});

// Sessions automatically inherit the shared CredentialsHarness via
// the app's extensionBridges cascade. From a session:
//   const tokens = await session.bridges.credentials?.get<OAuthTokens>(
//     "mcp", "linear",
//   );
```

## API

### `CredentialsStore`

Adapter interface every backend implements. Always async — even
in-memory.

```ts
interface CredentialsStore {
  get<T>(namespace: string, key: string): Promise<T | undefined>;
  set<T>(namespace: string, key: string, value: T): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
  has(namespace: string, key: string): Promise<boolean>;
  keys(namespace: string): Promise<readonly string[]>;
  onChange?(listener: (event: { namespace: string; key: string }) => void): () => void;
  readonly backend: string;
}
```

Namespace conventions:
- `mcp:<serverId>` — MCP server credentials
- `gateway:bearer` — gateway service auth
- `sandbox:<runtimeId>` — sandbox runtime credentials
- `secrets:<name>` — non-credential confidential payloads (rare;
  encryption-at-rest keys, code-signing material)

### `inMemoryCredentialsStore()`

Lost on process exit. Default for tests and ephemeral CLIs. Supports
reactive change notification.

Composes `MemoryCollection` from `@agentick/store-next` (composite
`namespace\x1fkey` primary key over a `CredentialEntry` record) rather
than hand-rolling a `Map` + listener set — the KV surface
(`get`/`set`/`has`/`keys`/`delete`) maps onto the collection's
`put`/`get`/`list`/`delete`, and `onChange` adapts the collection's
`{ key, value?, prev? }` delta back to the credentials
`{ namespace, key }` event. It keeps the KV port shape (it does NOT
extend `CollectionStore` — different method signature) while inheriting
the generic's mechanics and the shared-store `onChange` observation seam.

### `envCredentialsStore(options?)`

Environment-variable backed. Reads `<PREFIX>_<NAMESPACE_UPPER>_<KEY_UPPER>`
(default prefix `AGENTICK_CRED`). Values JSON-encoded.

```ts
envCredentialsStore({ prefix?: string; writable?: boolean })
```

- `prefix` (default `"AGENTICK_CRED"`) — env-var namespace prefix.
- `writable` (default `false`) — allow `set` / `delete` to mutate
  `process.env`. Off by default so accidental writes throw rather
  than silently mutating process-local state.

Limitations: no native reactivity (env doesn't emit change events);
keys are recovered lower-cased from the env name (slug is lossy).

### `runCredentialsStoreConformance(options)`

Vitest-compatible conformance suite. Adopter-written adapters call
this from their own test file with their factory to guarantee
substrate compliance.

```ts
runCredentialsStoreConformance({
  label: "myAdapter",
  factory: () => myCredentialsStore({ ... }),
  capabilities: {
    writable?: true,    // off if read-only
    reactivity?: true,  // off if no native change events
  },
});
```

Pinned behaviors: round-trip, namespace isolation, idempotent
delete, complete enumeration, reactive change notifications,
backend identifier stability.

### `CredentialsHarness`

Substrate harness wrapping a `CredentialsStore` with reactive change
notification. Implements `CredentialsHarnessProtocol` (lives in
`@agentick/spec-next`).

```ts
import {
  CredentialsHarness,
  inMemoryCredentialsStore,
} from "@agentick/credentials-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

const harness = new CredentialsHarness(
  "app-creds",
  inMemoryCredentialsStore(),
  new MemoryJournal(),
  new LocalEventBus(),
  new LocalInbox(),
);

await harness.set("mcp", "linear", { access_token: "..." });
const tokens = await harness.get<{ access_token: string }>("mcp", "linear");

const off = harness.subscribe((ev) => {
  console.log(`changed: ${ev.namespace}/${ev.key}`);
});
// ... later
off();
await harness.close();
```

Surface (matches `CredentialsHarnessProtocol`):
- `get<T>(namespace, key)` / `set<T>(namespace, key, value)` /
  `delete(namespace, key)` / `has(namespace, key)` /
  `keys(namespace)` — proxies to the underlying store.
- `subscribe(listener)` — fan-out of `CredentialsChangeEvent`
  (`{ namespace, key }`) for internal writes AND external rotations
  (when the adapter implements `onChange`).
- `id` / `address` — BaseHarness convention; `address` is
  `credentials:<id>`.
- `close()` — drops subscribers, unsubscribes from the underlying
  store, idempotent.

Adopters typically don't construct `CredentialsHarness` directly —
slice 281b.2 ships `withCredentials({ store })` which wires
construction + bridge registration through the app extension
lifecycle. Direct construction is for tests, custom adapter
integrations, and `fakeCredentialsHarness()`.

### Errors

All `AgentickError` subclasses; round-trip-safe via the spec-next
codec (#257). Re-exported from `@agentick/credentials-next` for
convenience.

| Class                            | When it fires                                                         |
|----------------------------------|-----------------------------------------------------------------------|
| `CredentialsError` (abstract)    | Base — `err instanceof CredentialsError` catches all                  |
| `CredentialsNotFound`            | Caller asserted presence but key absent (`get` itself returns undef) |
| `CredentialsBackendUnavailable`  | Backend unreachable — keychain locked, KV refused, env missing       |
| `CredentialsCorrupted`           | Read succeeded; value cannot be deserialized                          |
| `CredentialsWriteFailed`         | Write rejected — disk full, keychain denied, read-only store         |

## Verified by

- `src/__tests__/conformance.spec.ts` — `inMemoryCredentialsStore` +
  `envCredentialsStore` (writable mode) both pass the store
  conformance suite.
- `src/__tests__/harness-conformance.spec.ts` —
  `fakeCredentialsHarness()` passes the harness contract: fan-out
  of internal set/delete, forwarding of external store changes,
  no double-publish when the adapter has native `onChange`, no-op
  delete suppresses events, listener-error isolation, `Unsubscribe`
  stops future events, `close()` idempotency, `close()` drops
  subscribers, `id` + `address` follow BaseHarness convention.
- `src/__tests__/with-credentials.spec.ts` — `withCredentials({ store })`
  registers a `CredentialsHarness` under the `"credentials"` slot,
  scopes the harness id under the host id (`<appId>:credentials`),
  wires the harness over the adopter-supplied store, and schedules
  `harness.close()` on host shutdown.

## Roadmap & known gaps

- **`CredentialsHarness` substrate (281b)**: the harness itself is
  not in this slice. Today adopters consume `CredentialsStore`
  directly; the harness layer (PubSub fan-out, augmentation,
  conformance integration with `HookBridges`) lands next.
- **Gateway wiring (281c)**: `createGateway({ credentials })` and
  `installer.credentials` slot are not wired yet. `withMCP` still
  uses the placeholder `CredentialsStore<T>` from #277a; substrate
  migration follows.
- **Additional bundled adapters**: keychain, libsecret,
  encrypted-file, and KV adapters port from v1 (or are written
  fresh for the encrypted-file and KV cases) in follow-up slices.
  The interface is locked, so they're additive.
- **Client wire projection**: the client surface for credential
  lifecycle (action verbs only; no token material) is #279, gated
  on #280 (Wire Extensions framework).
