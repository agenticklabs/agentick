# @agentick/app

**Reference app harness** for Agentick v2 — the outermost runtime
boundary that owns shared substrate, shared sub-harnesses
(compiler, loop, executor, tool-executor), the session registry,
and the `createApp` ergonomic surface.

Compiler-agnostic. Adopters writing React agents import from
`@agentick/app/react` (defaults the compiler to `reactCompiler()`);
adopters using a custom compiler import from `@agentick/app`
directly and pass their own factory.

**Design:**
[ADR 09 — App harness](../../docs/proposals/v2/blueprint/09-app-harness.md) ·
[ADR 31 — Harness hierarchy](../../docs/proposals/v2/blueprint/31-harness-hierarchy.md) ·
[ADR 38 — Cluster lifecycle + ownership](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md)

## Quick start

### React (the 80% case)

```typescript
import { createApp } from "@agentick/app/react";
import { aisdk } from "@agentick/model-ai-sdk";
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
import { createApp } from "@agentick/app";
import { openai } from "@agentick/model-openai";
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
import { run } from "@agentick/app/react";
import { openai } from "@agentick/model-openai";

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
no tree — from `@agentick/model`) → `run(<Agent/>, ...)` (one
execution, nothing persists — this package) → `createApp` + sessions
(persistent). Each tier strictly adds.

## Cluster integration

Pass `cluster: ClusterFactory` to wrap the app's substrate with
cluster-aware bus + inbox routing. `app.closeApp()` tears down the
cluster.

```typescript
import { createApp } from "@agentick/app/react";
import { defineUnixCluster } from "@agentick/cluster-net";

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
[`@agentick/gateway`](../gateway/README.md) and
[ADR 38 §"Hard rules"](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md#hard-rules).

**Constraint.** `createApp({cluster, bus: instance})` is fine. `createApp({cluster, bus: LocalEventBus.factory()})` throws — the cluster needs a concrete substrate to wrap; we can't resolve factories without the parent shell that IS the substrate. Resolve factories yourself if you need this combination.

## API reference

### `createApp(rootElement, options)`

**`model` vs `modelExecutor` (ADR 52).** `model` is _what to call_ — a bare
`LanguageModelAdapter`; the app wraps it in the ONE
`LanguageModelExecutor` on its substrate, so executor events land on
`app.events(...)` with zero wiring. `modelExecutor` is _how to execute_ — a
BYO engine you constructed yourself. **At most one** — passing both throws,
and they are mutually exclusive; passing a bare adapter to `modelExecutor`
throws (it belongs on `model`). Passing **neither** is legal: a model-less
app is fully valid (dispatch, snapshot/restore, and wire plumbing all work
without a model). The model requirement is enforced at **execution time** —
a `send` whose effective-model cascade (`per-tick <Model>` > `per-send
override` > `session default`) is empty fails with `NoModelForExecutionError`.

| Field                | Type                                                   | Notes                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`              | `LanguageModelAdapter`                                 | The model to call — `openai("gpt-4o")`, `aisdk(model)`, `google(...)`, etc. Standard path. At most one of `model` / `modelExecutor`; both omitted → model-less app (send fails at execution time).                                                            |
| `modelExecutor`      | `LanguageModelExecutor` or `ExecutorFactory`           | BYO execution engine. A bare adapter goes on `model`, not here.                                                                                                                                                                                               |
| `target`             | `ExecutionTarget`                                      | Optional. Defaults to `modelExecutor.target`.                                                                                                                                                                                                                 |
| `compiler`           | `CompilerProtocol` or `CompilerFactory`                | Required (omittable via `/react` subpath default).                                                                                                                                                                                                            |
| `loop`               | `LoopExecutorProtocol` or factory                      | Optional. Defaults to the bundled `LoopExecutorHarness`.                                                                                                                                                                                                      |
| `cluster`            | `ClusterFactory`                                       | Optional. See "Cluster integration" above.                                                                                                                                                                                                                    |
| `tools`              | `ToolDeclaration[]`                                    | App-scope tool registry. Threads to every session.                                                                                                                                                                                                            |
| `hooks`              | `CommandHooks`                                         | App-scope command-lifecycle hooks (`onBefore*` / `onAfter*`, ADR 80). Folded once at construction; every session composes its own onto these (ADR 82). See the "Hooks" pattern below.                                                                         |
| `extensions`         | `Extension[]`                                          | App + session extensions. Composed at construction.                                                                                                                                                                                                           |
| `bus`                | `EventBus` or factory                                  | Optional substrate override.                                                                                                                                                                                                                                  |
| `inbox`              | `MessageInbox` or factory                              | Optional substrate override.                                                                                                                                                                                                                                  |
| `journal`            | `OperationJournal` or factory                          | Optional substrate override.                                                                                                                                                                                                                                  |
| `signal`             | `AbortSignal`                                          | App-wide cascade (PA1). Firing it aborts every active session's in-flight execution and refuses new work — `closeApp()` in abort shape. See "App-wide `signal`" below.                                                                                        |
| `sessions`           | `{ store?, maxActive?, idleTimeout?, maxSpawnDepth? }` | Durable session store + the bounded-registry knobs (PA2/PA3) + the spawn depth ceiling (SP4). See "Bounded live registry" and "Spawn hardening" below.                                                                                                        |
| `metadata`           | `Record<string, unknown>`                              | Adopter-defined bag carried on the harness instance.                                                                                                                                                                                                          |
| `name`               | `string`                                               | Logical app name — the telemetry agent-identity dimension. Stamped as `<ns>.app.name` and used as the default `functionId` when telemetry enrichment is on. Otherwise inert.                                                                                   |
| `telemetry`          | `boolean \| TelemetryLayer \| TelemetryOptions`        | **The one switch** (strictly opt-in). `true` turns on framework enrichment + OTLP autodiscovery; `{ serviceName?, attributes?, spanProcessor?, metricReader?, layer?, autoDiscover? }` (build it with `createTelemetry`) wires standard-OTel export; a raw `Layer` is the Effect escape hatch. Off (omitted/`false`) = zero overhead. **See "Observability & telemetry" below.** |
| `telemetryNamespace` | `string`                                               | Prefix on every framework attribute (`<ns>.op_id`, `<ns>.app.name`, …). Defaults to `"agentick"`; whitelabels the framework keys. `gen_ai.*` semconv keys stay verbatim (never whitelabeled).                                                                 |
| `appId`              | `string`                                               | Defaults to `app:${ulid()}`.                                                                                                                                                                                                                                  |

Returns `Promise<AppHarness>` after substrate readiness signals. Not
exhaustive — see [typedoc](https://agentick.dev) / `AppHarnessOptions`
in `src/harness.ts` for every slot (`models`, `session`, `toolExecutor`,
`defaultMaxTicks`, `streaming`, …).

### Observability & telemetry

The `telemetry` switch is strictly opt-in and takes three inline forms, all
turning framework enrichment on (agent-identity + model/tool/tick attrs, token
usage + cost on generate terminals) AND threading a provider down to
`ctx.trace` / `ctx.metrics` in your tool handlers:

- **`telemetry: true`** — enrichment on. With no exporter wired it attempts
  **env-driven OTLP autodiscovery**: if `OTEL_EXPORTER_OTLP_ENDPOINT` is set it
  lazily loads `@agentick/telemetry-otlp` and exports over OTLP; if that
  package isn't installed it logs one line and continues (never crashes). This
  is a deliberate divergence from the OTel SDK's silent-localhost default —
  autodiscovery fires **only** when the endpoint env is explicitly set, so
  there's no accidental export spam. With no endpoint env, enrichment still
  annotates spans on the no-op tracer (annotation on, export off).
- **`telemetry: createTelemetry(options, ...sinks)`** — the standard-OTel form,
  no Effect import. A `TelemetrySink = { spanProcessor?, metricReader?, attributes? }`
  is a destination bundle; a raw object literal IS a valid sink, or use
  `otlpSink()` from `@agentick/telemetry-otlp`. `createTelemetry` merges
  every sink (span processors concat, metric readers concat, `attributes` merge
  under the options') and returns the existing `TelemetrySetting` — the slot
  union does not grow.
- **`telemetry: { layer }`** — the Effect-native escape hatch (ADR-42
  dichotomy). Hand in an `@effect/opentelemetry` tracer `Layer` when you already
  have one. A `layer` and `spanProcessor`s given together compose **additively**
  (both export); the `layer` is never overridden.

```ts
import { createApp, createTelemetry } from "@agentick/app/react";
import { otlpSink } from "@agentick/telemetry-otlp";

const app = await createApp(<Agent />, {
  name: "triage-bot",
  telemetry: createTelemetry({ serviceName: "triage-bot" }, otlpSink()),
});
```

**The never-wrap guardrail.** The framework adds **no** proprietary layer between
you and OpenTelemetry: sampling, filtering, and batching stay expressed as your
own standard OTel `SpanProcessor` / `MetricReader` instances. `createTelemetry`
merges destinations and hands the raw objects to the SDK — nothing wraps them.
Span processors become an Effect tracer runtime (via `@effect/opentelemetry`);
metric readers back an OTel `MeterProvider` behind the `MetricSink` seam. OTel
exporter deps live in `@agentick/telemetry-otlp`, so this package stays
exporter-dep-free. `telemetryNamespace` whitelabels the framework's own
attribute keys (`gen_ai.*` semconv keys stay verbatim).

**Metric labels + multi-app sharing.** Every `ctx.metrics.*` emission carries the
low-cardinality ambient labels `{ tool, op }`, plus `{ app: <name> }` when the
app is named. The `app` label matters under a gateway: two apps inheriting one
gateway `telemetry` setting share the SAME `MetricReader` instances, and a reader
binds to exactly one `MeterProvider`, so the wiring materializes **one
`MeterProvider` per `createTelemetry` product** and shares the `MetricSink`
across every inheriting app (refcounted — the last app to close flushes + shuts
it down). The `app` label keeps those shared-sink metrics distinguishable. High-
cardinality identity (`sessionId` / `executionId`) rides spans + logs, never a
metric label.

> Verified by `src/__tests__/telemetry-e2e.spec.tsx` (the full
> `createTelemetry` → `ctx.trace`/`ctx.metrics` → sink path),
> `src/__tests__/telemetry-wiring.spec.ts` (merge + validation + env + build),
> and `src/__tests__/telemetry.spec.ts` (enrichment on/off). The complete model
> lives in the [observability guide](../../docs/proposals/v2/guide-observability.md).

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

### Bounded live registry — `sessions.maxActive` / `sessions.idleTimeout` (PA2/PA3)

The live registry (`getSession`) is otherwise an unbounded `Map` — a memory
leak in long-lived deployments that open sessions and never close them. Two
knobs cap it by **paging out** idle sessions:

```ts
const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
  sessions: {
    store: pgSessionStore, // durable resume index (E11)
    maxActive: 500, // soft LRU cap on LIVE sessions
    idleTimeout: 30 * 60_000, // page out after 30 min idle
  },
});
```

- **`maxActive`** — a **soft** LRU cap. When a `createSession` pushes the live
  count over it, the **least-recently-active evictable** session is paged out.
  Soft because an in-flight session is never evicted, so a burst of concurrent
  work may exceed the cap transiently; the bound is restored at the next create
  or idle sweep.
- **`idleTimeout`** — ms of inactivity after which a background sweep pages a
  session out. The sweep runs on an `unref`'d timer, so a **quiet** long-lived
  app still releases memory (no traffic required to fire it).

**Activity** = any operation scoped to the session (send, dispatch, snapshot, a
repeat `createSession` open, …), tracked off the shared bus. _Caveat:_ a session
constructed with its OWN bus factory (`createSession({ bus: LocalEventBus.factory() })`,
a multi-tenant-isolation lever) does not publish to the app bus and so is not
activity-tracked this way — pair per-session-bus isolation with explicit
`session.close()` rather than idle eviction.

**Eviction is paging, NOT deletion.** An evicted session's live harness is torn
down (compiler mount + bridges freed) but its durable `SessionRecord` + timeline
store survive. The next `createSession(sameId)` transparently reconstructs and
rehydrates it via the ADR-49 open-or-rehydrate path — so eviction is invisible
to correctness. Two consequences to know:

- Rehydrated state is only as complete as the durable backing. Configure a
  durable **timeline store** (`session: { timeline: { store } }`) if you need a
  paged-out session's conversation to survive; without one, reopen starts fresh.
- A `getSession(id)` handle captured _before_ an eviction is stale (points at the
  now-closed instance). Re-fetch via `createSession(id)` / `getSession(id)` after
  the eviction window — the E11 "live routing handle may be dropped" contract.

The app-level `onSessionClose` handler does **not** fire on eviction (paging is
not a lifecycle end); the session's own bridge/extension close handlers do.
Ephemeral `runOnce` sessions are never LRU/idle-evicted — they self-dispose.

### App-wide `signal` (PA1)

`createApp({ signal })` fans a single `AbortSignal` into every session. It is
`closeApp()` in **abort shape** — a cascading cancel rather than a teardown (it
does not dispose the substrate):

```ts
const controller = new AbortController();
const app = await createApp(<Agent />, { model, signal: controller.signal });
// … later, on shutdown / deadline / client disconnect:
controller.abort();
```

When the signal fires:

- every active session's **in-flight execution aborts** — each session merges the
  app signal into its per-send execution signal, so the loop tears the work down
  immediately (reusing the existing per-send abort plumbing, no bespoke engine);
- **new work is refused** — `createSession` / `runOnce` throw `AppClosedError`
  (admission treats an aborted app like a closed one), and a `send()` on an
  already-created session resolves an `aborted` result (`stopReason: "aborted"`,
  0 ticks) without a model call.

A per-session `createSession({ signal })` overrides the app signal for that
session (the caller owns that session's cancel).

### Spawn hardening — depth ceiling, lineage, teardown (SP4–SP6)

`session.spawn(...)` creates a **child session** bound to the same app. Three
guarantees keep a sub-agent tree safe and observable:

```ts
const app = await createApp(<Agent />, {
  model,
  sessions: { maxSpawnDepth: 10 }, // default 10 — the recursion bound
});
```

- **Depth ceiling (SP4).** A session whose spawn lineage is already
  `maxSpawnDepth` deep cannot spawn further — `spawn()` throws the typed
  `SpawnDepthExceededError` (`{ depth, maxDepth }`), failing closed so an agent
  that recursively spawns itself crashes with a clear error instead of blowing
  the stack. Depth is simply `spawnPath.length`.
- **Lineage / attribution (SP5).** A child carries a `spawnPath` — the ancestor
  session ids, root-first (`[root, …, parent]`); its length is the depth. It is
  stamped on the child's `SessionRecord.spawnPath` (so a sessions-list attributes
  a sub-agent to its whole chain), on the loop's `run-execution`/`tick`
  `EventScope` (so bus/journal envelopes attribute sub-agent work), and on the
  child's per-execution handle stream. Combined with `parentSessionId`, the
  session records reconstruct the whole spawn DAG.
- **Teardown cascade (SP6).** The parent's construction signal is fanned into
  each child, so a **parent abort tears down the child's in-flight work**
  (the same merge-into-execution plumbing as the app signal). A **parent close
  or abort disposes its children** — removed from the live registry and closed —
  so no sub-session leaks; children dispose their own children transitively.

### `app.closeApp()` / `app.close()`

Closes every registered session, fires extension close handlers in
reverse registration order, closes the cluster (if `createApp({cluster})`
was used), then tears down the substrate. Idempotent.

## Patterns

### Tools at the app scope

```typescript
import { createTool } from "@agentick/tool";
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
import { withMCP } from "@agentick/mcp";

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
- `src/__tests__/session-eviction.spec.tsx` (PA2/PA3) — `maxActive`
  evicts the least-recently-active session (LRU order proven via a send
  that refreshes an older session), `idleTimeout` pages out a quiet
  session on the background sweep, an evicted session reopens with its
  timeline rehydrated from the durable store, and an in-flight execution
  is never evicted (soft cap restored once it settles).
- `src/__tests__/app-signal.spec.tsx` (PA1) — an aborted app signal
  refuses new work at the app edge, is fanned into every session (a
  post-abort `send` on any resolves `aborted`, 0 ticks), and tears down
  an in-flight execution mid-flight.
- `src/__tests__/spawn-hardening.spec.tsx` (SP4–SP6) — `maxSpawnDepth`
  fails a too-deep spawn with `SpawnDepthExceededError` (configured cap +
  the default-10 chain), a child's `spawnPath` lineage lands on its
  `SessionRecord`, its loop `EventScope`, and its handle stream, and a
  parent close / abort disposes its spawned children (no registry leak;
  abort mid-child-execution tears the child down without a compiler race).

## Known gaps

- No double-wrap detection. If an adopter passes the same shared
  substrate instance to multiple `createApp({cluster})` calls, the
  local bus receives two subscriptions for every cluster event →
  double-deliver. See [ADR 38 §"What this ADR does NOT pin"](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md#what-this-adr-does-not-pin).
- No mid-flight cluster swap. To replace a cluster, close the app
  and construct a new one.
