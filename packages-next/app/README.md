# @agentick/app-next

**Reference app harness** for Agentick v2 — the outermost runtime
boundary that owns shared substrate, shared sub-harnesses
(reconciler, loop, executor, tool-executor), the session registry,
and the `createApp` ergonomic surface.

Reconciler-agnostic. Adopters writing React agents import from
`@agentick/app-next/react` (defaults the reconciler to `reactReconciler()`);
adopters using a custom reconciler import from `@agentick/app-next`
directly and pass their own factory.

**Design:**
[ADR 09 — App harness](../../docs/proposals/v2/blueprint/09-app-harness.md) ·
[ADR 31 — Harness hierarchy](../../docs/proposals/v2/blueprint/31-harness-hierarchy.md) ·
[ADR 38 — Cluster lifecycle + ownership](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md)

## Quick start

### React (the 80% case)

```typescript
import { createApp } from "@agentick/app-next/react";
import { aisdk } from "@agentick/ai-sdk-next";
import { openai } from "@ai-sdk/openai";

const app = await createApp(<Agent />, {
  executor: aisdk({ model: openai("gpt-4o") }),
});

const session = await app.createSession();
const handle = await session.send({
  messages: [{ role: "user", content: "Hello" }],
});
console.log((await handle.result).response);
await app.closeApp();
```

### Custom reconciler

```typescript
import { createApp } from "@agentick/app-next";
import { myReconciler } from "./my-reconciler";

const app = await createApp(rootElement, {
  reconciler: myReconciler(),
  executor: ...,
});
```

## Cluster integration

Pass `cluster: ClusterFactory` to wrap the app's substrate with
cluster-aware bus + inbox routing. `app.closeApp()` tears down the
cluster.

```typescript
import { createApp } from "@agentick/app-next/react";
import { defineUnixCluster } from "@agentick/cluster-net-next";

const app = await createApp(<Agent />, {
  executor: ...,
  cluster: defineUnixCluster({ socketPath: "/tmp/cluster.sock" }),
});

// app.bus, app.inbox, app.journal are now the cluster-wrapped versions.
// Local emits fan out to other nodes; remote events arrive locally.

await app.closeApp(); // closes the cluster too
```

**One cluster per process.** Multiple `createApp({cluster})` calls
with the same `ClusterFactory` produce INDEPENDENT clusters (double
connections, double-delivery). For multi-app deployments, use a
gateway — see
[`@agentick/gateway-next`](../gateway/README.md) and
[ADR 38 §"Hard rules"](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md#hard-rules).

**Constraint.** `createApp({cluster, bus: instance})` is fine. `createApp({cluster, bus: LocalEventBus.factory()})` throws — the cluster needs a concrete substrate to wrap; we can't resolve factories without the parent shell that IS the substrate. Resolve factories yourself if you need this combination.

## API reference

### `createApp(rootElement, options)`

| Field         | Type                                          | Notes                                                |
| ------------- | --------------------------------------------- | ---------------------------------------------------- |
| `executor`    | `LanguageModelExecutor` or factory            | Required. Wire to your model adapter.                |
| `target`      | `ExecutionTarget`                             | Optional. Defaults to `executor.target`.             |
| `reconciler`  | `ReconcilerHarness` or factory                | Required (omittable via `/react` subpath default).   |
| `cluster`     | `ClusterFactory`                              | Optional. See "Cluster integration" above.           |
| `tools`       | `ToolDeclaration[]`                           | App-scope tool registry. Threads to every session.   |
| `extensions`  | `Extension[]`                                 | App + session extensions. Composed at construction.  |
| `bus`         | `EventBus` or factory                         | Optional substrate override.                         |
| `inbox`       | `MessageInbox` or factory                     | Optional substrate override.                         |
| `journal`     | `OperationJournal` or factory                 | Optional substrate override.                         |
| `metadata`    | `Record<string, unknown>`                     | Adopter-defined bag carried on the harness instance. |
| `appId`       | `string`                                      | Defaults to `app:${ulid()}`.                         |

Returns `Promise<AppHarness>` after substrate readiness signals.

### `app.createSession(opts?)`

Constructs a `SessionHarness` bound to this app. Sessions share the
app's substrate + sub-harnesses; only session-scope state (timeline,
knobs, extensions targeting `"session"`) is per-session.

### `app.closeApp()` / `app.close()`

Closes every registered session, fires extension close handlers in
reverse registration order, closes the cluster (if `createApp({cluster})`
was used), then tears down the substrate. Idempotent.

## Patterns

### Tools at the app scope

```typescript
const calculator = createTool({
  name: "calculator",
  input: z.object({ a: z.number(), b: z.number() }),
  handler: async ({ a, b }) => [{ type: "text", text: `${a + b}` }],
});

const app = await createApp(<Agent />, {
  executor: ...,
  tools: [calculator],
});
```

Tools at this scope are available to every session created from this
app. Per-session scoping happens via `session.createSession({tools})`
overrides.

### Extensions

App-level extensions install once at construction and stay alive for
the app's lifetime. Session-level extensions install per-session via
the same `extensions: [...]` array; the harness routes by `target`.

```typescript
import { withMCP } from "@agentick/mcp-next";

const app = await createApp(<Agent />, {
  executor: ...,
  extensions: [
    withMCP({ servers: [...] }), // target: "session" — re-installs per session
  ],
});
```

## Status

Phase 5 (cluster fusion) — landed. `createApp({cluster})` is the
substrate-fusion adopter path; `joinXCluster` is the side-channel
counterpart (see [ADR 38](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md)).

## Verified by

- `src/__tests__/app-harness.spec.tsx` — construction + session
  lifecycle + close cascade.
- `src/__tests__/create-app-cluster.spec.tsx` — `cluster: ...`
  wiring, factory-substrate rejection, close-via-registry-removal.
- `src/__tests__/session-extensions.spec.ts` — extension target
  routing + per-session install.
- `src/__tests__/layered-tools.spec.tsx` — app-scope tool propagation
  to sessions.

## Known gaps

- No double-wrap detection. If an adopter passes the same shared
  substrate instance to multiple `createApp({cluster})` calls, the
  local bus receives two subscriptions for every cluster event →
  double-deliver. See [ADR 38 §"What this ADR does NOT pin"](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md#what-this-adr-does-not-pin).
- No mid-flight cluster swap. To replace a cluster, close the app
  and construct a new one.
- `telemetry: TelemetryLayer` field is accepted but not yet applied
  to running commands. OTel set-up still happens out-of-band.
