# @agentick/credentials-next

**v2 substrate-level credential storage.** Server-resident; credentials never cross the wire.

Bundled in the `agentick` metapackage. Drop-in replacement for v1's
`@agentick/secrets`, with generic-typed values, namespaced keys, native
reactivity, and the typed-error infrastructure from ADR 41.

## Status

Slice **281a** (this commit): substrate interfaces + bundled
reference adapters (`inMemoryCredentialsStore`, `envCredentialsStore`)
+ typed errors + conformance suite.

Slice **281b**: `CredentialsHarness` substrate harness — augments
`HookBridges`, owns the change-notification PubSub, ships
conformance + testing doubles, wired through gateway/app/session
installers.

Slice **281c**: wire into `createGateway({ credentials })`; migrate
`withMCP` from the placeholder `CredentialsStore<T>` shim (#277a) to
the substrate harness; delete the per-MCP shim.

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

// Adopter use (post 281c — exact shape TBD when gateway wiring lands):
//
// const gateway = createGateway({
//   credentials: { store: envStore },
//   apps: [...],
// });
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

`Map`-backed, lost on process exit. Default for tests and ephemeral
CLIs. Supports reactive change notification.

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
  `envCredentialsStore` (writable mode) both pass the suite.

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
