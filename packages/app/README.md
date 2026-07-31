# @agentick/app

**The outermost runtime boundary.** One app owns the substrate (journal, bus, inbox), the shared spine (compiler, loop, model executor, tool executor), and the session registry. `createApp` is the one door into all of it.

The split that explains the whole options bag: everything at the app is **shared**, everything below it is **per-session**. `model` sits at the app because provider clients are session-agnostic; a conversation sits at the session because a conversation is. Configure the shared things once and every session inherits them.

## Install

```bash
npm install @agentick/app
```

Subpaths: `/react` (same surface, with the JSX compiler pre-wired).

## Quick start

```tsx
import { createApp } from "@agentick/app/react";
import { openai } from "@agentick/model-openai";

const app = await createApp(<Agent />, { model: openai("gpt-4o") });

const session = await app.createSession();
const handle = await session.send({ messages: [{ role: "user", content: "Hello" }] });
console.log((await handle.result).response);

await app.closeApp();
```

`createApp` is async because the substrate's inbox registrations must be complete before the first command — awaiting it is the guarantee that `app.createSession()` on the next line cannot race.

The `/react` subpath defaults `compiler` to the JSX compiler. Bring your own and import from `@agentick/app` instead:

```ts
import { createApp } from "@agentick/app";
import type { CompilerFactory } from "@agentick/spec";

declare const myCompiler: CompilerFactory;

const app = await createApp(rootElement, { model, compiler: myCompiler });
```

`rootElement` is opaque to the app — the bound compiler owns its type.

## One execution, nothing persists — `run()`

```tsx
import { run } from "@agentick/app/react";

const result = await run(<Agent />, {
  model: openai("gpt-4o"),
  messages: [{ role: "user", content: "What's 47 * 23?" }],
}).result;
```

A temporary app and session are created, the element executes once — full loop, tree and model and tools — and everything tears down when the execution settles. It streams too:

```tsx
for await (const event of run(<Agent />, { model, messages })) {
  render(event);
}
```

`run` takes every `createApp` option plus `messages`, `history`, `props`, `maxTicks`, and `signal`. It is the middle rung of a three-step ladder, each step strictly adding to the last:

| Reach for                | When                                              | From                        |
| ------------------------ | ------------------------------------------------- | --------------------------- |
| `generate({ model, … })` | One model call, no tree, no tools                 | [@agentick/model](../model) |
| `run(<Agent/>, …)`       | One execution — tree, model, tools — nothing kept | this package                |
| `createApp` + sessions   | Conversations that persist and resume             | this package                |

## Configuring the app

### `model` vs `modelExecutor`

`model` is _what to call_ — a bare adapter. The app wraps it in the one model executor on its substrate, so executor events land on `app.events(...)` with no wiring. `modelExecutor` is _how to execute_ — an engine you built. **At most one:** passing both throws, and passing a bare adapter to `modelExecutor` throws (it belongs on `model`).

Passing **neither** is legal. A model-less app is fully valid — dispatch, snapshot/restore, and wire plumbing all work without one. The requirement is enforced at execution time: a `send` whose effective-model cascade (per-tick `<Model>` → per-send override → session default) resolves empty fails with `NoModelForExecutionError`.

### Namespace slots — configuring a per-session capability from the app

A namespace like the timeline is per-session, but its _configuration_ belongs at the app. So each namespace package contributes its own top-level slot:

```tsx
import { createApp } from "@agentick/app/react";
import { defineTimeline, hydrateTail } from "@agentick/timeline";
import { fsTimelineStore } from "@agentick/timeline-fs";

const app = await createApp(<Agent />, {
  model,
  timeline: defineTimeline({
    store: fsTimelineStore({ dir: "./.agentick/transcripts" }),
    hydrate: hydrateTail(200),
  }),
});
```

There is **no `timeline?:` line in this package.** The slot arrives by module augmentation from `@agentick/timeline` and a side-effect registration that tells the app "`timeline` is a namespace key, forward it" — the app names no namespace and imports no namespace package for this. Install an optional namespace and its slot appears on `createApp` the same way; don't, and it never exists at the type level.

Every slot takes the same two forms and no third: a `defineX(...)` **definition** (or the identical inline bag — `timeline: { store }` is the same type) or a **live instance** when you own the lifecycle.

```tsx
const app = await createApp(<Agent />, { model, timeline: { store } }); // inline bag
```

### `extensions` — the fully-dynamic escape hatch

Slots are declarative and statically typed. `extensions: []` is the array you build at runtime — conditional composition, a slot-less third party, anything assembled in a loop:

```tsx
import { withMCP } from "@agentick/mcp";
import { withTimeline } from "@agentick/timeline";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const app = await createApp(<Agent />, {
  model,
  extensions: [
    withMCP({
      servers: [
        {
          serverId: "fs",
          transport: new StdioClientTransport({ command: "mcp-server-filesystem" }),
        },
      ],
    }),
    ...(process.env.TRANSCRIPTS ? [withTimeline({ store })] : []),
  ],
});
```

App extensions install once at construction; session extensions re-install per session. The `target` field routes each one — you never sort them yourself. Order is install order, and a slot-name collision is last-writer-wins, so an adopter extension listed after a framework default overrides it.

### Genesis — what a session opens on

A store-bearing namespace carries a `hydrate` seam, and the app is what runs it. Three laws are worth knowing because they are the ones that bite:

- **Genesis completes before the first render.** The first compile already sees the resumed conversation — there is no window where the tree renders against an empty log.
- **A throwing hydrator fails `createSession`** with its typed error (`TimelineHydrateFailed` for the timeline). There is no half-hydrated session that only explodes at the first `send`.
- **Genesis runs on create and resume, never on fork or spawn.** A forked child inherits its parent's image directly, so a second genesis would duplicate it.

```tsx
const app = await createApp(<Agent />, { model, timeline: { store } });

const a = await app.createSession({ sessionId: "chat-1" }); // genesis runs
const b = await app.createSession({ sessionId: "chat-1" }); // same id, later process → genesis runs
const child = await a.spawn(<SubAgent />, { messages }); // inherits; no genesis
```

Create-is-resume: there is no separate `resume` verb. Opening a session id whose durable log exists rehydrates it.

## Sessions

### `getSession` vs `listSessions`

The app keeps **two** structures for sessions, deliberately not merged:

| Structure         | Holds                                         | Read it for                                        |
| ----------------- | --------------------------------------------- | -------------------------------------------------- |
| **Live registry** | `sessionId → live session`, in-memory         | Routing and interaction — `app.getSession(id)`     |
| **Session store** | `sessionId → SessionRecord`, durable superset | "List / resume my sessions" — `app.listSessions()` |

The store is the queryable superset: every non-ephemeral session ever, including closed ones the live registry dropped.

```ts
const live = app.getSession("chat-1"); // undefined once closed or paged out
const mine = await app.listSessions({ status: "active", updatedAfter: Date.now() - 86_400_000 });
const record = await app.getSessionRecord("chat-1"); // resolves closed sessions too
```

It is an app singleton, defaulting to a node-local in-memory store. Swap a durable adapter and the list survives an app restart — which is the store's entire purpose. Ephemeral `runOnce` sessions get no store entry; they are throwaway and stay out of the durable list.

`title` / `description` / `metadata` are yours to populate — seed them at `createSession({ title })` or set them later with `app.setSessionMeta(id, { title })`. The framework stores them and is blind to their semantics.

### Close vs destroy

Two removal verbs, deliberately far apart.

`session.close()` is the gentle one — hang up. The session ends, its durable record survives as history on a `closed` status, and its **detached** tasks keep running: they were spawned to outlive the conversation.

`app.destroySession(id)` deletes the thread. It is transitive and it is the strongest form:

```ts
const { live, record } = await app.destroySession("chat-1", { reason: "user deleted the thread" });
live.abortedExecutions; //  in-flight work stopped, across the whole spawn subtree
live.disposedDescendants; //  sub-agent sessions torn down with it
live.cancelledDetachedTasks; //  the tasks close would have left running
record.existed; //  there was a durable record to delete
```

Aborting is transitive because nothing else is: `session.abort()` reaches only that session's own current execution, and a spawned child feels its parent's construction signal without its running execution being cancelled — so destroy walks the live subtree and aborts each descendant itself.

**Idempotent.** Destroying an id that is already gone is a success reporting `live.found: false` / `record.existed: false`. You get facts, not an exception, for the case you were probably racing anyway.

**Descendant records are not deleted** — only the named one. Whether deleting a parent cascades to its children's rows is your store's decision (a SQL `ON DELETE CASCADE` is exactly where that belongs), and so is what deletion MEANS at all: `SessionStore.delete` may soft-flag or hard-remove. That is why the result reports whether a record `existed`, and makes no claim about what happened to it.

Over the wire it is `app/destroy_session`, and it is ownership-gated twice: once by the dispatch gate on the live session's principal, once by the handler on the durable record's — because a session that is no longer live has no live target for the gate to read.

A client holding a session id with no app id beside it — from a cross-app listing — reaches the same verb through [`gateway.destroySession(id)`](../gateway#reaching-a-session-without-naming-its-app), which resolves the owning app itself and reports which one it was.

### Who answered — `appId` joined to the app's `title`

An app declares the same `id` / `title` / `description` triple a tool or a prompt does:

```tsx
const app = await createApp(<Ernesto />, {
  model,
  appId: "ernesto",
  title: "Ernesto",
  description: "Knowify's assistant",
});
```

A session records which app opened it, so **who answered is the app** — one app mounts one root element, and a client that reached the sessions through `app("ernesto")` already knows which app that is. It reads the name off the app:

```ts
const { title } = await client.gateway.getApp("ernesto"); // "Ernesto"
const { sessions } = await client.gateway.app("ernesto").listSessions();
sessions[0].title; // the THREAD's title — not the app's
```

**A live join, on purpose.** Copying a display name onto every session record would make renaming an app a data migration and freeze historical threads under the old label. Renaming should relabel them. That is the opposite of `boundary.target`, which stamps the model that ran a turn onto the timeline precisely so a later model swap cannot rewrite it — evidence about the past must not move, a display label should.

There is no per-session author field. A spawned child shares its parent's `appId`, so naming individual specialists is a spawn-level concern and waits for one; inventing the field now would mean maintaining it everywhere for a feature that does not exist.

**`title` is not `name`.** `name` is the telemetry identity dimension — a deployment-flavoured value like `"assistant-api-prod"`. They are deliberately not defaulted from one another: promoting an ops identifier to a user-visible label is easy to add and awkward to remove.

### Bounding the live registry

The live registry is otherwise an unbounded map — a leak in a deployment that opens sessions and never closes them. Two knobs cap it by **paging out** idle sessions:

```tsx
const app = await createApp(<Agent />, {
  model,
  sessions: {
    store: pgSessionStore,
    maxActive: 500, // soft LRU cap on live sessions
    idleTimeout: 30 * 60_000, // page out after 30 min idle
  },
});
```

`maxActive` is a **soft** cap: when a create pushes the live count over it, the least-recently-active evictable session is paged out. Soft because an in-flight session is never evicted, so a burst may exceed the cap transiently; the bound is restored at the next create or sweep. `idleTimeout` is milliseconds of inactivity after which a background sweep pages a session out — on an `unref`'d timer, so a quiet app still releases memory without traffic to trigger it.

> [!IMPORTANT]
> **Eviction is paging, not deletion.** The live harness is torn down; the durable record and timeline store survive. The next `createSession(sameId)` reconstructs and rehydrates it, so eviction is invisible to correctness — _provided_ the backing is durable. Without a durable timeline store, a paged-out session reopens with an empty conversation.

A `getSession(id)` handle captured before an eviction points at the closed instance; re-fetch after the window. Activity is any operation scoped to the session, tracked off the shared bus — so a session constructed with its **own** bus factory (a multi-tenant isolation lever) is not activity-tracked, and should be paired with an explicit `session.close()` rather than idle eviction.

Both the LRU page-out and the idle sweep call `session.close({ reason: "evicted" })` — the same operation an explicit teardown runs, not a path around it. So a `onBeforeSessionClose` observer sees page-outs, and the audit trail tells a page-out from a hangup by the record's `reason`, not by which code path ran.

### App-wide `signal`

One `AbortSignal` fans into every session. It is `closeApp()` in **abort shape** — a cascading cancel, not a teardown (the substrate survives):

```tsx
const controller = new AbortController();
const app = await createApp(<Agent />, { model, signal: controller.signal });

controller.abort(); // shutdown, deadline, client disconnect
```

When it fires, every active session's in-flight execution aborts (the app signal merges into each per-send execution signal), and new work is refused: `createSession` / `runOnce` throw `AppClosedError`, and a `send()` on an already-created session resolves `aborted` with 0 ticks and no model call. A per-session `createSession({ signal })` overrides the app signal for that session.

### Spawn — depth, lineage, teardown

`session.spawn(...)` creates a child session bound to the same app.

```tsx
const app = await createApp(<Agent />, { model, sessions: { maxSpawnDepth: 10 } });
```

- **Depth ceiling.** A session already `maxSpawnDepth` deep cannot spawn further — `spawn()` throws `SpawnDepthExceededError` with `{ depth, maxDepth }`. It fails closed, so a self-recursive agent crashes with a clear error instead of blowing the stack. Depth is just `spawnPath.length`; the default is 10.
- **Lineage.** A child carries `spawnPath` — its ancestor ids, root-first. It lands on the child's `SessionRecord`, on the loop's event scope (so bus and journal envelopes attribute sub-agent work), and on the child's execution handle stream. With `parentSessionId`, the records reconstruct the whole spawn graph.
- **Teardown cascade.** The parent's signal is fanned into each child, so a parent abort tears down the child's in-flight work; a parent close or abort disposes its children transitively. No sub-session leaks.

## Lifecycle operations

Spawn and close are **operations**, not bare method calls — they run through the same pipeline as any command, which is what makes them guardable.

A spawn is two linked operations: `session:command:spawn` (this session's layer — the depth ceiling, lineage, principal descent) parents `app:command:create-child-session` (this app's layer — construction and registry admission). They share a **body** with host `createSession`, not an envelope. That distinction is the point:

```ts
// "This agent may not spawn sub-agents" — without also blocking host session creation.
app.guard((_input, ctx) =>
  ctx.op === "SessionSpawn" ? { kind: "veto", reason: "no-subagents" } : undefined,
);
```

A spawn emits no `app:create-session` record, so a guard on host session creation does not silently police spawns, and vice versa. A veto at either layer creates no child and no registry entry.

Close emits `session:command:close` carrying its `reason` (`"closed"`, `"evicted"`, …). It is bus-only by policy — the envelope reaches `app.events(...)` without filling the journal — and a veto leaves the session usable.

## Hooks, guards, and middleware

Three seams around operations, distinguished by how much they know about the op:

| Seam           | Sees                                | Scope                | Registered                                  |
| -------------- | ----------------------------------- | -------------------- | ------------------------------------------- |
| **Guard**      | One named verb's input → a verdict  | Admission, outermost | `createApp({ guards })` or `app.guard(fn)`  |
| **Hook**       | One named verb's typed input/output | Transform            | `createApp({ hooks })` or `app.hook({ … })` |
| **Middleware** | Every op, opaquely                  | Wrap                 | `app.use(mw)` / `app.fx.use(mw)`            |

```tsx
const app = await createApp(<Agent />, {
  model,
  hooks: {
    onAfterToolDispatch: (result) => redactSecrets(result),
  },
  guards: {
    timelineAppend: (input) =>
      input.entries.length > 500 ? { kind: "veto", reason: "batch too large" } : undefined,
  },
});
```

Hook keys are `onBefore`/`onAfter` + the command (`onBeforeToolDispatch`). Guard keys are the bare command (`timelineAppend`) — guards are not lifecycle observers, they are admission decisions, and the naming says so. Both are derived from the command registry, so a typo is a compile error and a new command mints its keys automatically.

Middleware wraps every op the app or anything it constructs runs — the deployment-global seam for audit, tracing, and metrics:

```ts
const off = app.use(async (input, next, ctx) => {
  const started = Date.now();
  try {
    return await next(input);
  } finally {
    audit.record({ session: ctx.sessionId, op: ctx.opId, ms: Date.now() - started });
  }
});
```

Use `app.fx.use` for middleware that must stay in-fiber (span nesting, structured cancel that reaches inner ops) — the async form severs the fiber at `await`, which is fine for observation and wrong for propagation.

### The cascade

**Guards float outermost, then the fold composes.** For any one operation the order is: app guards → definition guards → app `before` hooks → definition `before` hooks, with `after` hooks unwinding in reverse. Governance outranks local policy; a `defineX({ guards })` bag never runs ahead of the app's.

Hooks **compose, they do not override** — app-level and session-level both fire, app-outer. And the cascade is a **construction fold**: each session snapshots the app's resolved interceptors at birth, so `app.use` / `app.guard` registered _before_ a session is created reaches it and registered _after_ does not. Register app-level policy before you open sessions.

## Telemetry

Strictly opt-in, one switch, three forms — all of them turn on framework enrichment (agent identity, model/tool/tick attributes, token usage and cost on generate terminals) and thread a provider down to `ctx.trace` / `ctx.metrics` in your tool handlers.

```tsx
import { createApp, createTelemetry } from "@agentick/app/react";
import { otlpSink } from "@agentick/telemetry-otlp";

const app = await createApp(<Agent />, {
  name: "triage-bot",
  model,
  telemetry: createTelemetry({ serviceName: "triage-bot" }, otlpSink()),
});
```

- **`telemetry: true`** — enrichment on. With no exporter wired it attempts env-driven OTLP autodiscovery: if `OTEL_EXPORTER_OTLP_ENDPOINT` is set it lazily loads `@agentick/telemetry-otlp` and exports; if that package isn't installed it logs one line and continues. Autodiscovery fires **only** when the endpoint env is explicitly set — a deliberate divergence from the OTel SDK's silent-localhost default, so there is no accidental export spam. With no endpoint, enrichment still annotates spans on the no-op tracer.
- **`createTelemetry(options, ...sinks)`** — the standard-OTel form, no Effect import. A sink is `{ spanProcessor?, metricReader?, attributes? }`; a plain object literal is a valid sink. Every sink merges (processors concat, readers concat, attributes merge under the options').
- **`{ layer }`** — hand in an `@effect/opentelemetry` tracer layer when you already have one. A layer and span processors given together compose additively; the layer is never overridden.

Nothing wraps your instruments. Sampling, filtering, and batching stay expressed as your own OTel `SpanProcessor` / `MetricReader` instances, handed to the SDK raw. Exporter dependencies live in `@agentick/telemetry-otlp`, so this package stays exporter-dep-free.

`telemetryNamespace` prefixes every framework attribute (`<ns>.op_id`, `<ns>.app.name`), defaulting to `"agentick"` — whitelabel the framework's keys without touching `gen_ai.*` semconv keys, which stay verbatim.

Every `ctx.metrics.*` emission carries the low-cardinality labels `{ tool, op }`, plus `{ app: <name> }` when the app is named. That `app` label matters under a gateway: two apps inheriting one gateway telemetry setting share the same reader instances, so the wiring materializes one meter provider per `createTelemetry` product and refcounts it across every inheriting app. High-cardinality identity (`sessionId`, `executionId`) rides spans and logs, never a metric label.

## Cluster

Pass a `cluster` factory to replace the app's substrate with cluster-aware bus and inbox routing. Local emits fan out to other nodes; remote events arrive locally.

```tsx
import { defineUnixCluster } from "@agentick/cluster-net";

const app = await createApp(<Agent />, {
  model,
  cluster: defineUnixCluster({ socketPath: "/tmp/cluster.sock" }),
});

await app.closeApp(); // closes the cluster too
```

> [!WARNING]
> **One cluster per process.** Two `createApp({ cluster })` calls with the same factory produce two independent clusters — double connections, double delivery. For multi-app deployments wire the cluster at the [gateway](../gateway) and let apps inherit.

`createApp({ cluster, bus: instance })` is fine; `createApp({ cluster, bus: LocalEventBus.factory() })` throws. The cluster needs a concrete substrate to wrap and cannot resolve a factory without the parent shell that _is_ the substrate — resolve factories yourself if you need that combination.

## API

### `@agentick/app`

| Export                                           | Purpose                                                  |
| ------------------------------------------------ | -------------------------------------------------------- |
| `createApp(rootElement, options)`                | Construct an app; resolves once the substrate is ready   |
| `run(rootElement, options)`                      | One execution, nothing persists; awaitable and iterable  |
| `createTelemetry(options, ...sinks)`             | Build a telemetry setting from standard OTel instruments |
| `AppHarness`                                     | The implementation, for direct construction              |
| `builtinWireExtensions`                          | The bundled wire methods, for a hand-assembled gateway   |
| `AppHarnessOptions` / `CreateAppOptions` (types) | The full options surface                                 |

### `createApp` options

| Field                       | Type                                                   | Notes                                                                                    |
| --------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `model`                     | `LanguageModelAdapter`                                 | What to call. At most one of `model` / `modelExecutor`; both omitted is a model-less app |
| `modelExecutor`             | `LanguageModelExecutor` \| factory                     | How to execute. A bare adapter belongs on `model`                                        |
| `compiler`                  | `CompilerProtocol` \| factory                          | Required; defaulted by the `/react` subpath                                              |
| `loop`                      | `LoopExecutorProtocol` \| factory                      | Defaults to the bundled loop executor                                                    |
| `tools`                     | `ToolDeclaration[]`                                    | App-scope registry; threads to every session                                             |
| `hooks`                     | `CommandHooks`                                         | Declarative per-verb transforms; folded once at construction                             |
| `guards`                    | `CommandGuards`                                        | Declarative per-verb admission verdicts                                                  |
| `extensions`                | `Extension[]`                                          | The dynamic composition array; routed by `target`                                        |
| `sessions`                  | `{ store?, maxActive?, idleTimeout?, maxSpawnDepth? }` | Durable resume index, live-registry bounds, spawn ceiling                                |
| `signal`                    | `AbortSignal`                                          | App-wide cascading cancel                                                                |
| `cluster`                   | `ClusterFactory`                                       | Substrate fusion across nodes                                                            |
| `bus` / `inbox` / `journal` | instance \| factory                                    | Substrate overrides                                                                      |
| `telemetry`                 | `boolean` \| `TelemetrySetting`                        | The one observability switch; off by default                                             |
| `telemetryNamespace`        | `string`                                               | Prefix on framework attribute keys; defaults to `"agentick"`                             |
| `name`                      | `string`                                               | Logical app name — the telemetry identity dimension and default `functionId`             |
| `metadata`                  | `Record<string, unknown>`                              | Adopter bag carried on the instance                                                      |
| `appId`                     | `string`                                               | Defaults to `app:${ulid()}`                                                              |
| `title`                     | `string`                                               | Display label — what a person reads. Distinct from `name`; see below                     |
| `description`               | `string`                                               | One line for a picker or catalog                                                         |
| _namespace slots_           | e.g. `timeline`                                        | Contributed by namespace packages; not declared here                                     |

Also accepted: `models`, `session`, `toolExecutor`, `tasks`, `defaultMaxTicks`, `streaming`, `narrate`, `migrateSnapshot`, `initialProps`, `initialKnobs`, `target`, `interceptorParent`.

### `AppHarness`

| Member                           | Returns                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| `createSession(input?)`          | A session bound to this app; opening an existing id resumes |
| `runOnce(input)`                 | One execution in an ephemeral session                       |
| `getSession(id)`                 | The live session, or `undefined`                            |
| `listSessions(query?)`           | Durable records — the queryable superset                    |
| `getSessionRecord(id)`           | One durable record, closed sessions included                |
| `setSessionMeta(id, meta)`       | Set app-owned `title` / `description` / `metadata`          |
| `destroySession(id, opts?)`      | Delete a session — transitive, strongest form               |
| `events(query?)`                 | Cross-session bus subscription                              |
| `use(mw)` / `fx.use(mw)`         | Register middleware; returns an unsubscribe                 |
| `guard(fn)` / `hook(bag)`        | Register a guard / hooks imperatively                       |
| `hooks.onBeforeToolDispatch(fn)` | Per-verb imperative registrar                               |
| `closeApp()`                     | Close every session, fire close handlers, tear down         |

`closeApp()` closes registered sessions, fires extension close handlers in reverse registration order, closes the cluster if there is one, then tears down the substrate. Idempotent. `close()` is the same operation under the name every harness shares.

## Patterns

**Tools at app scope.** `createApp({ tools })` reaches every session; `createSession({ tools })` overrides per session, and the narrower scope wins. Build them with [@agentick/tool](../tool).

```tsx
import { createTool } from "@agentick/tool";
import { z } from "zod";

const calculator = createTool({
  name: "calculator",
  description: "Add two numbers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  handler: async ({ a, b }) => [{ type: "text", text: `${a + b}` }],
});

const app = await createApp(<Agent />, { model, tools: [calculator] });
```

**Sessions.** [@agentick/session](../session) owns `send`, steering, spawn/fork, and the snapshot surface.

**Conversations.** [@agentick/timeline](../timeline) owns the log, its store port, and compaction.

**Serving over a wire.** [@agentick/gateway](../gateway) hosts apps, owns the cluster for multi-app deployments, and cascades extensions down to every app and session beneath it.

**Interceptor mechanics.** [@agentick/runtime](../runtime) owns the operation pipeline, the hook-name derivation, and the middleware tiers.

## Roadmap & known gaps

- **No double-wrap detection.** Pass the same substrate instance to two `createApp({ cluster })` calls and the local bus gets two subscriptions per cluster event — double delivery, with nothing to warn you.
- **No mid-flight cluster swap.** Replacing a cluster means closing the app and constructing a new one.
- **Namespace slots carry a name only.** The app pulls a slot's value out at the layer that owns the namespace. Extension-installed namespaces (skills, prompts, tasks, sandbox) still need `extensions: []` rather than a top-level slot.
- **No per-session namespace override.** Namespace configuration is app-wide; `createSession` takes no `timeline` override.
- **`onSessionClose` does not fire on eviction.** Paging out is not a lifecycle end, so the app-level handler stays quiet; the session's own bridge and extension close handlers do run.

## Verified by

- `src/__tests__/app-harness.spec.tsx` — construction, session lifecycle, close cascade, and the durable store: `listSessions` / `getSessionRecord` read it, records mirror lifecycle and execution accounting (status, `executionCount`, `currentExecutionId`, aggregated usage, close → `closed`), `setSessionMeta` sets the app-owned slots, and ephemeral `runOnce` sessions stay out of the list.
- `src/__tests__/genesis-lifecycle.spec.tsx` — the app-level namespace slot reaching the session's timeline (definition form and inline bag), the genesis and shaping seams riding it, the zero-config default with no slot, genesis completing before first render, `createSession` failing with the typed error on a throwing hydrator, and the fork/spawn law (no re-genesis) against a resume that does re-run it.
- `src/__tests__/lifecycle-operations.spec.tsx` — the spawn and close envelopes end to end: spawn emits both operations with the child-create carrying `{ sessionId, parentSessionId, spawnPath }` and naming the spawn as its parent op, a spawn adds no host-create record, a fork adds snapshot + restore records, a guard veto at either layer creates no child, a spawn-only guard leaves host `createSession` alone, and close stays out of the journal while a veto leaves the session usable.
- `src/__tests__/hooks-cascade.spec.tsx` — `createApp({ hooks })` firing on dispatch, `createSession({ hooks })` composing app-outer, `onAfter*` transforms flowing through, and no-hooks being behavior-preserving.
- `src/__tests__/session-eviction.spec.tsx` — `maxActive` evicting the least-recently-active session (LRU order proven via a send that refreshes an older one), `idleTimeout` paging out a quiet session on the sweep, an evicted session reopening with its timeline rehydrated, and an in-flight execution never being evicted.
- `src/__tests__/app-signal.spec.tsx` — an aborted app signal refusing new work at the edge, fanning into every session so a post-abort `send` resolves `aborted` with 0 ticks, and tearing down an in-flight execution.
- `src/__tests__/spawn-hardening.spec.tsx` — the depth ceiling failing a too-deep spawn (configured cap and the default chain), `spawnPath` landing on the record, the loop scope, and the handle stream, and a parent close or abort disposing its children with no registry leak.
- `src/__tests__/destroy-session.spec.tsx` — destroy aborting a grandchild held mid-tool and disposing the whole subtree, cancelling a detached task the same setup under `close()` leaves running, calling `SessionStore.delete` exactly once by id while a bystander's record survives, reaching a closed session's record, and staying silent (not faulting) on a second destroy.
- `src/__tests__/session-principal-lifecycle.spec.tsx` — owning-principal inheritance across spawn and fork, fork metadata inheritance, and the `onSessionCreate` reshape and veto arms.
- `src/__tests__/create-app-cluster.spec.tsx` — cluster wiring, factory-substrate rejection, and close via registry removal.
- `src/__tests__/session-extensions.spec.ts` + `layered-tools.spec.tsx` — extension target routing with per-session install, and app-scope tool propagation.
- `src/__tests__/telemetry-e2e.spec.tsx`, `telemetry-wiring.spec.ts`, `telemetry.spec.ts` — the `createTelemetry` → `ctx.trace` / `ctx.metrics` → sink path, sink merging and validation and env autodiscovery, and enrichment on/off.
- `src/__tests__/run.spec.tsx` — `run()` as awaitable and iterable, with teardown on settle.
