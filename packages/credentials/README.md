# @agentick/credentials

**Credentials never cross the wire, and the secret is never an operation input.** This is the server-resident store for OAuth tokens, API keys, and anything else an agent must hold but must not leak: namespaced, generically typed, reactive when the backend can be, and pluggable behind one small adapter interface.

The second half of that sentence is the design. Credential writes are journaled operations — guardable, hookable, auditable — but the value is structurally absent from the operation's input type. There is no redaction pass to misconfigure or forget, because there is nothing to redact: what was never in the input cannot be journaled, broadcast, or handed to adopter code.

## Install

```bash
npm install @agentick/credentials
```

Subpaths: `/testing` (doubles plus the store and harness conformance suites).

## Quick start

Install it as an app extension and every session of that app shares one instance:

```ts
import { withCredentials, envCredentialsStore } from "@agentick/credentials";

const app = await createApp(<Agent />, {
  compiler,
  model,
  extensions: [withCredentials({ store: envCredentialsStore({ prefix: "AGENTICK_CRED" }) })],
});
```

From a session, or from any tool handler that can reach the bridges:

```ts
const tokens = await session.bridges.credentials?.get<OAuthTokens>("mcp", "linear");
await session.bridges.credentials?.set("mcp", "linear", refreshed);
```

Sessions share the instance rather than each getting their own, which is the point: an OAuth grant obtained in one conversation is usable in the next without re-authenticating. That sharing is a property of how the app cascades its extension bridges, not something this package arranges.

## Namespaced, not flat

Every value is addressed by a `(namespace, key)` pair, and the store sees only opaque triples. The conventions:

| Namespace             | Holds                                                  |
| --------------------- | ------------------------------------------------------ |
| `mcp:<serverId>`      | Credentials for one MCP server.                        |
| `gateway:bearer`      | Gateway service authentication.                        |
| `sandbox:<runtimeId>` | Sandbox runtime credentials.                           |
| `secrets:<name>`      | Confidential payloads that are not credentials — rare. |

Namespacing is what makes the audit and guard stories usable: "who touched production credentials" is a scope query, and "require approval for production writes" is a guard that reads one field.

> [!WARNING]
> A namespace organizes the key space; it is **not** a capability boundary. Nothing structural stops a caller from passing a namespace it has no business reading — see [Roadmap & known gaps](#roadmap--known-gaps).

Enumeration is part of the interface, not an extra. Every backend implements `keys(namespace)`, so a UI can render what exists without being told the keys first.

## The redaction law

`set` and `delete` are operations. A credential write is a security state mutation, so it belongs in the audit trail and under a guard:

| Operation                    | Scope                                    | Input                | Journaled            |
| ---------------------------- | ---------------------------------------- | -------------------- | -------------------- |
| `credentials:command:set`    | `{ credentialNamespace, credentialKey }` | `{ namespace, key }` | requested + terminal |
| `credentials:command:delete` | `{ credentialNamespace, credentialKey }` | `{ namespace, key }` | requested + terminal |

**The value is not an operation input.** That single fact is the whole law:

```ts
export interface CredentialsMutationInput {
  readonly namespace: string;
  readonly key: string;
  // there is no `value` field, and there never will be
}
```

The journal record, the bus envelope, every middleware, and every guard observe the operation's **input**. The value travels as a closure argument on the operation body instead, reaching the store and nothing else.

> [!IMPORTANT]
> This is why the law is structural rather than a scrubbing pass. A post-hoc redaction step can be misconfigured, skipped, or left behind when someone adds a field. Here, adding a leak would mean editing that interface — which is a code review, not an oversight.

So a guard sees the address and never the material:

```ts
harness.guard<{ namespace: string }>((input) =>
  input.namespace === "production" && !operatorApproved()
    ? { kind: "veto", reason: "production-credentials-require-approval" }
    : undefined,
);
```

A vetoed `set` never reaches the store and publishes no change notification; a vetoed `delete` leaves the entry in place. And because the harness folds into the installing app's interceptor chain — live, so a guard registered later still applies — an `app.guard()` reaches credential writes without knowing this package exists.

Auditing is a scope query over the same operations:

```ts
app.events({ scope: { credentialNamespace: "oauth" } });
```

### Reads are data-plane

`get`, `has`, and `keys` are **not** operations. They proxy straight to the store, emit nothing on the bus, and a blanket write-freezing guard does not block them. That asymmetry is deliberate: a read is not a state mutation, and making it an operation would put a namespace and key into the audit trail on every render-adjacent lookup for no security benefit.

The corollary of the law is that `set` is deliberately **not inbox-addressable**. A credential has no serializable command form — making it one would turn the input into a wire payload by construction. A remote caller drives credential lifecycle through wire verbs that resolve server-side and return status, never material.

Running under an operation does enrich the store's context: an adapter sees the write's own `opId`, `parentOpId`, `correlationId`, and `traceparent`. Reads, having no operation fiber, get the base construction context.

## Reacting to change

`subscribe` fans out `CredentialsChangeEvent` (`{ namespace, key }`) — and it covers rotations this process did not perform:

```ts
const off = harness.subscribe((ev) => {
  console.log(`changed: ${ev.namespace}/${ev.key}`);
  if (ev.namespace.startsWith("mcp:")) reconnectServer(ev.namespace);
});
```

When the adapter implements `onChange`, the harness forwards **that** as its change source rather than publishing its own echo. This is what makes an externally-mutated store work correctly: a sibling process rotating a keychain entry, or an operator pushing to a shared KV, produces the same event a local write does. Routing everything through the single store seam is both complete and free of double-publishing. Only when the adapter has no `onChange` does the harness fall back to publishing its own writes — the only changes it can then see.

A no-op delete publishes nothing. A throwing listener does not affect the others.

## Backends

`CredentialsStore` is the adapter interface. Always async, even in memory:

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

Two are bundled:

**`inMemoryCredentialsStore()`** — lost on process exit; the default for tests and ephemeral CLIs. Emits change events. It composes a memory collection from [@agentick/store](../store) over a composite key rather than hand-rolling a map and a listener set, so it inherits that generic's mechanics and its shared-store observation seam while keeping the key-value shape.

**`envCredentialsStore(options?)`** — reads `<PREFIX>_<NAMESPACE>_<KEY>` (uppercased, default prefix `AGENTICK_CRED`) with JSON-encoded values. The backend for platform-managed secrets: Kubernetes secrets, a hosting provider's env vars, `docker --env-file`.

```ts
envCredentialsStore({ prefix: "AGENTICK_CRED", writable: false });
```

`writable` is `false` by default, so an accidental `set` throws rather than silently mutating process-local state that no other process will see. Env has no change events, so there is no reactivity here, and keys come back lower-cased because the env-name slug is lossy.

### Writing your own

Implement the interface and certify it. Vault, 1Password, and AWS Secrets Manager adapters are ordinary adopter code — there is no privileged backend.

```ts
import { runCredentialsStoreConformance } from "@agentick/credentials/testing";

runCredentialsStoreConformance({
  label: "myAdapter",
  factory: () => myCredentialsStore({ endpoint }),
  capabilities: {
    writable: true, // omit if read-only
    reactivity: true, // omit if no native change events
  },
});
```

The suite pins round-trip, namespace isolation, idempotent delete, complete enumeration, change notification, and backend-identifier stability. The capability flags exist so a read-only or non-reactive backend is a legitimate implementation rather than a failing one.

## Constructing the harness directly

`withCredentials` is the production path. Direct construction is for tests and custom integrations:

```ts
import { CredentialsHarness, inMemoryCredentialsStore } from "@agentick/credentials";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

const harness = new CredentialsHarness(
  "app-creds",
  inMemoryCredentialsStore(),
  new MemoryJournal(),
  new LocalEventBus(),
  new LocalInbox(),
);

await harness.set("mcp", "linear", { access_token: "…" });
const tokens = await harness.get<{ access_token: string }>("mcp", "linear");

await harness.close(); // drops subscribers, unsubscribes from the store, idempotent
```

## No projection, no client mirror

Credentials is the deliberate exception to two patterns the other store-backed surfaces follow, and knowing that saves you looking for machinery that is intentionally absent.

**It holds no synchronous view.** Reads are bare awaits against the store with no synchronous cache, because credential reads are off the render path. A store-backed surface holds a synchronous projection if and only if it has a synchronous read surface — timeline, knobs, state, skills, prompts, tasks, and resources all do. This one does not, and so it is not snapshot-capable.

**It projects nothing to the client.** The wire surface is empty, and that is the valid empty case rather than an unfinished one. A browser UI that needs to drive credential lifecycle — re-authenticate, disconnect — sends an action verb; the server resolves it against the harness and answers with status (`connected`, `credentials-expired`), never with tokens.

## API

### `@agentick/credentials`

| Export                            | Purpose                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `withCredentials({ store })`      | App extension. One harness per app, shared by every session. |
| `CredentialsHarness`              | The implementation, for direct construction.                 |
| `inMemoryCredentialsStore()`      | Bundled in-memory backend. Emits change events.              |
| `envCredentialsStore(options?)`   | Bundled environment-variable backend.                        |
| `CredentialsStore` (type)         | The adapter interface.                                       |
| `CredentialsMutationInput` (type) | The operation input — the redaction law, as a type.          |
| `CredentialsChangeEvent` (type)   | `{ namespace, key }`.                                        |

### `bridges.credentials`

| Member                          | Kind       | Returns                                                |
| ------------------------------- | ---------- | ------------------------------------------------------ |
| `set<T>(namespace, key, value)` | Operation  | Guardable, hookable, journaled.                        |
| `delete(namespace, key)`        | Operation  | `boolean` — false when nothing was there.              |
| `get<T>(namespace, key)`        | Data-plane | `T \| undefined`.                                      |
| `has(namespace, key)`           | Data-plane | `boolean`.                                             |
| `keys(namespace)`               | Data-plane | `readonly string[]`.                                   |
| `subscribe(listener)`           | —          | `Unsubscribe`. Internal writes and external rotations. |
| `id` / `address`                | —          | `address` is `credentials:<id>`.                       |
| `close()`                       | —          | Idempotent teardown.                                   |

### `@agentick/credentials/testing`

| Export                             | Purpose                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| `fakeCredentialsHarness(options?)` | The real harness over an in-memory store. Prefer this.       |
| `fakeCredentialsStore()`           | The in-memory store alone, under the double's name.          |
| `stubCredentialsStore(options?)`   | Canned answers, no persistence behavior.                     |
| `unavailableCredentialsStore()`    | Every call fails — for exercising backend-unavailable paths. |
| `runCredentialsStoreConformance`   | Certify a backend adapter.                                   |
| `runCredentialsHarnessConformance` | Certify an alternate harness implementation.                 |

Prefer `fakeCredentialsHarness()` when testing consumer code: it exercises the real harness over an in-memory store, so your consumer hits the same code path production does. Reach for `stubCredentialsStore` only when the test cares what the consumer does _with_ a credential and not about persistence.

### Errors

All are `AgentickError` subclasses and round-trip safely across a process boundary. Re-exported here so a package depending only on credentials gets them without a second import.

| Class                           | Fires when                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `CredentialsError` (abstract)   | Base — `err instanceof CredentialsError` catches all of them.                       |
| `CredentialsNotFound`           | A caller asserted presence but the key is absent. `get` itself returns `undefined`. |
| `CredentialsBackendUnavailable` | Backend unreachable — keychain locked, KV refused, env missing.                     |
| `CredentialsCorrupted`          | The read succeeded but the value will not deserialize.                              |
| `CredentialsWriteFailed`        | Write rejected — disk full, keychain denied, read-only store.                       |

## Patterns

**MCP servers.** [@agentick/mcp](../mcp) reads this surface for per-server OAuth tokens, which is why the `mcp:<serverId>` namespace convention exists.

**Storage generics.** [@agentick/store](../store) supplies the collection primitive the in-memory backend composes, and is where to look when writing a backend over something that already has a store adapter.

**Shapes.** [@agentick/spec](../spec) owns `CredentialsHarnessProtocol`, `CredentialsChangeEvent`, and the error classes.

**The edge.** [@agentick/gateway](../gateway) is where the never-cross-the-wire invariant is enforced for the audit trail too: its admission-failure events carry connection shape and never credential material.

## Roadmap & known gaps

- **App-level install only.** `withCredentials` returns an app extension. A gateway-level variant that cascades to every hosted app is not built, so a multi-app process configures each app.
- **Two bundled backends.** Keychain (macOS), libsecret (Linux), encrypted-file, and cluster-KV adapters are not shipped. The interface is locked, so they are purely additive — and adopter-written adapters are first-class today.
- **No client wire projection.** The action-verb surface for driving credential lifecycle from a browser is described above as the intended design, but no wire extension implements it yet. Nothing about credentials is reachable from a client today.
- **Env keys are lossy.** `envCredentialsStore` recovers keys lower-cased from the environment variable name, so a mixed-case key round-trips as lower-case. Enumeration over an env backend is therefore approximate.
- **No expiry or rotation policy.** The store holds opaque values; token refresh, expiry tracking, and rotation schedules are the consumer's concern. `subscribe` is the hook a consumer builds those on.
- **Namespace isolation is not construction-bound — treat the namespace as an argument, not a boundary.** A harness will read any namespace it is asked for, so two harnesses sharing one store do not isolate from each other: given a shared store, a handle scoped to `user-b` can read `user-a`'s namespace simply by passing it. Namespacing organizes the key space and gives audit and guards something to match on; it is not a capability boundary. Until a scoped handle binds its prefix at construction — which would make a cross-scope read unrepresentable rather than merely discouraged — enforce per-tenant separation with a guard on the write path and separate stores on the read path.

## Verified by

- `src/__tests__/mutation-operations.spec.ts` — the redaction law, asserted rather than asserted-about. `set` and `delete` emit their operations with the `{ credentialNamespace, credentialKey }` scope and journal both `requested` and `terminal`; the operation input is exactly `{ namespace, key }`; the body threads the enriched store context so an adapter sees the write's `opId`. **The redaction assertion:** after writing a distinctive secret both as a bare string and nested inside an object, the fully serialized journal — every record, not only the credentials operations — and the fully serialized bus stream contain neither the value nor any fragment of it, while still containing the operation name and the key, so the assertion is not vacuous. Also: a vetoed `set` never reaches the store and publishes nothing, a vetoed `delete` leaves the entry, an input-reading guard vetoes one namespace while a sibling proceeds, and `get`/`has`/`keys` emit nothing and survive a blanket write-freezing guard.
- `src/__tests__/harness-conformance.spec.ts` — `fakeCredentialsHarness()` against the harness contract: fan-out for internal writes, forwarding of external store changes, **no double-publish** when the adapter has native `onChange`, no-op delete suppressing events, listener-error isolation, unsubscribe stopping future events, `close()` idempotency and subscriber drop, and the `id`/`address` convention.
- `src/__tests__/conformance.spec.ts` — both bundled backends pass the store conformance suite, `envCredentialsStore` in writable mode.
- `src/__tests__/with-credentials.spec.ts` — the extension registers a harness under the `credentials` slot, scopes its id under the host id, wires it over the adopter-supplied store, and schedules `close()` on host shutdown.
- `src/__tests__/layered-isolation-proof.spec.ts` — several harnesses over one shared store: writes land in the shared backing, distinct namespaces do not observe each other through ordinary use, and — pinned deliberately as a gap rather than a property — a handle reading another namespace it was simply handed. See the isolation entry above.
