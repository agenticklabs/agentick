# @agentick/app-next

**Reference app harness** for Agentick v2 — the outermost runtime
boundary that owns shared substrate, shared sub-harnesses
(compiler, loop, executor, tool-executor), the session registry,
and the `createApp` ergonomic surface.

Compiler-agnostic. Adopters writing React agents import from
`@agentick/app-next/react` (defaults the compiler to `reactCompiler()`);
adopters using a custom compiler import from `@agentick/app-next`
directly and pass their own factory.

**Design:**
[ADR 09 — App harness](../../docs/proposals/v2/blueprint/09-app-harness.md) ·
[ADR 31 — Harness hierarchy](../../docs/proposals/v2/blueprint/31-harness-hierarchy.md) ·
[ADR 38 — Cluster lifecycle + ownership](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md)

## Quick start

### React (the 80% case)

```typescript
import { createApp } from "@agentick/app-next/react";
import { aisdk } from "@agentick/model-ai-sdk-next";
import { openai } from "@ai-sdk/openai";

const app = await createApp(<Agent />, {
  model: aisdk(openai("gpt-4o")),
});

const session = await app.createSession();
const handle = await session.send({
  messages: [{ role: "user", content: "Hello" }],
});
console.log((await handle.result).response);
await app.closeApp();
```

### Custom compiler

```typescript
import { createApp } from "@agentick/app-next";
import { openai } from "@agentick/model-openai-next";
import { myCompiler } from "./my-compiler";

const app = await createApp(rootElement, {
  model: openai("gpt-4o"),
  compiler: myCompiler(),
});
```

### One-shot: `run()`

No persistent app — a temporary app + session is created, the element
executes once (full loop: tree + model + tools), and everything tears
down when the execution settles:

```ts
import { run } from "@agentick/app-next/react";
import { openai } from "@agentick/model-openai-next";

const result = await run(<Agent />, {
  model: openai("gpt-4o"),
  messages: [{ role: "user", content: "What's 47 * 23?" }],
}).result;

// Or stream it:
for await (const event of run(<Agent />, { model, messages })) {
  render(event);
}
```

The ergonomics ladder: `generate({ model, messages })` (one model call,
no tree — from `@agentick/model-next`) → `run(<Agent/>, ...)` (one
execution, nothing persists — this package) → `createApp` + sessions
(persistent). Each tier strictly adds.

## Cluster integration

Pass `cluster: ClusterFactory` to wrap the app's substrate with
cluster-aware bus + inbox routing. `app.closeApp()` tears down the
cluster.

```typescript
import { createApp } from "@agentick/app-next/react";
import { defineUnixCluster } from "@agentick/cluster-net-next";

const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
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

**`model` vs `executor` (ADR 52).** `model` is _what to call_ — a bare
`LanguageModelAdapter`; the app wraps it in the ONE
`LanguageModelExecutor` on its substrate, so executor events land on
`app.events(...)` with zero wiring. `executor` is _how to execute_ — a
BYO engine you constructed yourself. **Exactly one is required**, and
they are mutually exclusive; passing a bare adapter to `executor`
throws (it belongs on `model`).

| Field                | Type                                         | Notes                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`              | `LanguageModelAdapter`                       | The model to call — `openai("gpt-4o")`, `aisdk(model)`, `google(...)`, etc. Standard path. Exactly one of `model` / `executor` required.                                                                                                                      |
| `executor`           | `LanguageModelExecutor` or `ExecutorFactory` | BYO execution engine. A bare adapter goes on `model`, not here.                                                                                                                                                                                               |
| `target`             | `ExecutionTarget`                            | Optional. Defaults to `executor.target`.                                                                                                                                                                                                                      |
| `compiler`           | `CompilerProtocol` or `CompilerFactory`      | Required (omittable via `/react` subpath default).                                                                                                                                                                                                            |
| `loop`               | `LoopExecutorProtocol` or factory            | Optional. Defaults to the bundled `LoopExecutorHarness`.                                                                                                                                                                                                      |
| `cluster`            | `ClusterFactory`                             | Optional. See "Cluster integration" above.                                                                                                                                                                                                                    |
| `tools`              | `ToolDeclaration[]`                          | App-scope tool registry. Threads to every session.                                                                                                                                                                                                            |
| `hooks`              | `CommandHooks`                               | App-scope command-lifecycle hooks (`onBefore*` / `onAfter*`, ADR 80). Folded once at construction; every session composes its own onto these (ADR 82). See the "Hooks" pattern below.                                                                         |
| `extensions`         | `Extension[]`                                | App + session extensions. Composed at construction.                                                                                                                                                                                                           |
| `bus`                | `EventBus` or factory                        | Optional substrate override.                                                                                                                                                                                                                                  |
| `inbox`              | `MessageInbox` or factory                    | Optional substrate override.                                                                                                                                                                                                                                  |
| `journal`            | `OperationJournal` or factory                | Optional substrate override.                                                                                                                                                                                                                                  |
| `metadata`           | `Record<string, unknown>`                    | Adopter-defined bag carried on the harness instance.                                                                                                                                                                                                          |
| `telemetry`          | `TelemetryLayer`                             | Optional Effect `Layer` (e.g. `@effect/opentelemetry`'s `NodeSdk`). Built into an app-scoped `ManagedRuntime` at construction; app-edge operations run on it so `Effect.withSpan` annotations reach the tracer (ADR 78). BYO — no OTel dependency is bundled. |
| `telemetryNamespace` | `string`                                     | Span-attribute prefix on every `<ns>.op_id` / `<ns>.surface` attribute. Defaults to `"agentick"`; set it to whitelabel your deployment's traces.                                                                                                              |
| `appId`              | `string`                                     | Defaults to `app:${ulid()}`.                                                                                                                                                                                                                                  |

Returns `Promise<AppHarness>` after substrate readiness signals. Not
exhaustive — see [typedoc](https://agentick.dev) / `AppHarnessOptions`
in `src/harness.ts` for every slot (`models`, `session`, `toolExecutor`,
`defaultMaxTicks`, `streaming`, …).

### `app.createSession(opts?)`

Constructs a `SessionHarness` bound to this app. Sessions share the
app's substrate + sub-harnesses; only session-scope state (timeline,
knobs, extensions targeting `"session"`) is per-session.

**Single construction site for substrate primitives (#159).** The
AppHarness is the ONE place the per-session `ElicitationHarness`,
`TasksHarness`, and `ResourcesHarness` (ADR 62) are constructed — BEFORE
session-extension installs run. Each is threaded, as a single shared
instance, into the ToolExecutor (`ctx.elicitation` / `ctx.tasks` /
`ctx.resource`), the session bridges (`bridges.*`), the session accessors
(`session.elicitation` / `session.tasks` / `session.resources`), and the
`SessionInstaller` (`installer.elicitation` / `.tasks` / `.resources`).
Extensions (`withTasks`, `withResources`, `withMCP`, …) must NOT
construct their own — that would collide on the inbox address and fork
the registry that `ctx.*` vs `bridges.*` vs `session.*` resolve to. They
consume the wired instance instead (e.g. `withResources` registers the
`resource_*` model tools; `withMCP` proxy-registers remote resources into
`installer.resources`).

### `app.getSession(id)` vs. `app.listSessions(query)` — the E11 split

The app keeps **two** structures for sessions, deliberately not merged (data-layer
plan E11):

- The **live registry** — `sessionId → live SessionHarness`, in-memory,
  ephemeral (a session is dropped from it on close). Read it for **routing /
  interaction** via `app.getSession(id)`.
- The durable **`SessionStore`** — `sessionId → SessionRecord`, the queryable
  **superset** (every non-ephemeral session ever, including closed ones the live
  registry dropped). It is the backing for every "list / resume my sessions"
  surface. Read it via:
  - `app.listSessions(query?)` → `Promise<readonly SessionRecord[]>`, filtered by
    `appId` / `status` / `parentSessionId` / `updatedAfter` recency.
  - `app.getSessionRecord(id)` → `Promise<SessionRecord | undefined>` (resolves
    closed / historical sessions too).

The store is an app-singleton (`createApp({ sessions: { store } })`, defaults to a
node-local `InMemorySessionStore` — swap a durable adapter for survival across app
restart, the store's purpose as the resume index). Each non-ephemeral session
mirrors its metadata into it off the critical path (no projection). Ephemeral
`runOnce` sessions get NO store — they are throwaway and stay out of the durable
list.

App-owned descriptive slots (`title` / `description` / `metadata`) are the app's
to populate — seed them at `createSession({ title, description })` or set them
later via `app.setSessionMeta(id, { title?, description?, metadata? })`. The
framework STORES them and is blind to their semantics.

### `app.closeApp()` / `app.close()`

Closes every registered session, fires extension close handlers in
reverse registration order, closes the cluster (if `createApp({cluster})`
was used), then tears down the substrate. Idempotent.

## Patterns

### Tools at the app scope

```typescript
import { createTool } from "@agentick/tool-next";
import { z } from "zod";

const calculator = createTool({
  name: "calculator",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  handler: async ({ a, b }) => [{ type: "text", text: `${a + b}` }],
});

const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
  tools: [calculator],
});
```

Tools at this scope are available to every session created from this
app. Per-session scoping happens via `app.createSession({ tools })`
overrides (`CreateSessionInput.tools`, session scope wins over app).

### Extensions

App-level extensions install once at construction and stay alive for
the app's lifetime. Session-level extensions install per-session via
the same `extensions: [...]` array; the harness routes by `target`.

```typescript
import { withMCP } from "@agentick/mcp-next";

const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
  extensions: [
    withMCP({ servers: [...] }), // target: "session" — re-installs per session
  ],
});
```

### Middleware — deployment-global (tier 3)

The app is each session's **construction parent**, so `app.use(mw)`
structurally wraps _every_ operation of _every_ session it creates — the
deployment-global seam for audit, tracing, journaling, and metrics (ADR 76,
tier 3). It's the same middleware primitive every harness exposes; registering
it on the app just gives it the broadest structural scope. **Guards
(`harness.guard(...)`, ADR 83) inherit the same way** — guards and transforms
ride one interceptor chain, folded down the construction tree together.

**The cascade is a construction-fold (ADR 83).** Each session snapshots the
app's resolved interceptors at construction; there is no live parent-walk. So
`app.use` / `app.guard` registered BEFORE a session is created reaches that
session; registered AFTER it does not (its fold already ran). Guards are
registered imperatively via `harness.guard(...)` — there is **no
`createApp({ guards })` option** (unlike `hooks`, which folds declaratively).

```typescript
// Pure-JS async form — reads the op's RuntimeContext (ctx) and severs the
// fiber at `await` (fine for observation). Returns an Unsubscribe.
const off = app.use(async (input, next, ctx) => {
  const started = Date.now();
  try {
    return await next(input);
  } finally {
    audit.record({ session: ctx.sessionId, op: ctx.opId, ms: Date.now() - started });
  }
});

// Effect-native form for middleware that must stay in-fiber (span-nesting,
// structured cancel that reaches inner ops):
app.fx.use((input, next) =>
  Effect.gen(function* () {
    /* … */ return yield* next(input);
  }),
);
```

Note the SHARED spine harnesses (loop / executor / tool) are construction
_siblings_ of the session, not children — a **per-session** concern _around the
model call_ is tier 4 (`withCallMiddleware`), not `app.use`. Full tier model and
the `use` vs `fx.use` split: [runtime README — Operation middleware](../runtime/README.md#operation-middleware--three-tiers-adr-76).

### Hooks — lifecycle participation (`onBefore*` / `onAfter*`)

Where middleware wraps _every_ op opaquely, **hooks** participate in a _named_
verb by command id — `onBeforeToolDispatch`, `onAfterToolDispatch`, … — typed
over that verb's real input/output. A `before` hook transforms the command input
(or vetoes by throwing); an `after` hook transforms the output. They ride the
same `liftMiddleware` fiber path as `use`, so ambient context and interruption
survive the `await`.

```typescript
const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
  hooks: {
    // Transform the dispatch result soundly (sees + returns a DispatchResult).
    onAfterToolDispatch: (result, ctx) => redactSecrets(result),
  },
});
```

**The cascade composes, it does not override.** App hooks fold at construction;
`createSession({ hooks })` composes the session's own onto the app's (both fire,
**app-outer**). Guards and `use` middleware inherit through the **same
construction-fold** (ADR 83) — one snapshot at the session's birth, no live
parent-walk. Hooks can also be registered **imperatively at runtime** on any
harness: `harness.hook({ onBeforeToolDispatch: fn })` or the per-verb proxy
`harness.hooks.onBeforeToolDispatch(fn)` — each returns an `Unsubscribe`. Like
`use`/`guard`, imperative registration affects that harness's own future ops, not
already-constructed children (the fold snapshot). Full mechanism (naming as a
total function of the command id, the typed `CommandRegistry`, compose-not-override,
the construction-fold): [runtime README — Command lifecycle hooks](../runtime/README.md#command-lifecycle-hooks-adr-80--82).

## Status

Phase 5 (cluster fusion) — landed. `createApp({cluster})` is the
substrate-fusion adopter path; `joinXCluster` is the side-channel
counterpart (see [ADR 38](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md)).

## Verified by

- `src/__tests__/app-harness.spec.tsx` — construction + session
  lifecycle + close cascade; the durable `SessionStore` (E11):
  `listSessions` / `getSessionRecord` read the store, records mirror
  lifecycle + execution accounting (status, `executionCount`,
  `currentExecutionId`, aggregated `usage`, close→`closed`),
  `setSessionMeta` sets app-owned slots, and ephemeral `runOnce` sessions
  stay out of the durable list.
- `src/__tests__/create-app-cluster.spec.tsx` — `cluster: ...`
  wiring, factory-substrate rejection, close-via-registry-removal.
- `src/__tests__/session-extensions.spec.ts` — extension target
  routing + per-session install.
- `src/__tests__/layered-tools.spec.tsx` — app-scope tool propagation
  to sessions.
- `src/__tests__/hooks-cascade.spec.tsx` — `createApp({ hooks })` fires
  on dispatch, `createSession({ hooks })` composes app-outer, `onAfter*`
  transforms flow through, no-hooks is behavior-preserving.

## Known gaps

- No double-wrap detection. If an adopter passes the same shared
  substrate instance to multiple `createApp({cluster})` calls, the
  local bus receives two subscriptions for every cluster event →
  double-deliver. See [ADR 38 §"What this ADR does NOT pin"](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md#what-this-adr-does-not-pin).
- No mid-flight cluster swap. To replace a cluster, close the app
  and construct a new one.
