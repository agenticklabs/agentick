# 09 — App Harness

**Status:** Synthesized with placeholders
`[SOURCE: runtime.md, harness-principle.md, cluster.md, gateway.md]`

The app harness is the outermost runtime boundary. It owns the agent
**definition** (the JSX root element, the configuration), the session
registry, and cross-session concerns (broadcast events, multi-session
observability).

```
                ┌────────────────────────────────────────────┐
                │                App harness                 │
                │                                            │
   commands ──► │  createSession · runOnce · getSession      │ ──► events
                │  listSessions · closeApp · use             │
                │                                            │
   interceptors◄┤   sessions registry · cross-session bus    │ ──► outcomes
                │   global services (renderer registry,      │
                │   persistence, executor adapters, ...)     │
                └─────────────┬──────────────────────────────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │   Sessions ...   │  one harness per session
                     └──────────────────┘
```

`[V1-REPLACED]` of v1's `Agentick` instance + `App` class
(`packages/core/src/app/app.ts`, `packages/core/src/agentick-instance.ts`).
The app harness is a clean library object; cluster mode wraps it for
distributed deployment.

## What this harness manages

- The agent definition: the **root JSX element**, configuration
  (renderer registry, executor adapters, persistence, model defaults,
  tools, sandbox provider, telemetry).
- The session registry (active and hibernated session IDs and their
  current locations in cluster mode).
- App-level interceptor and event registration (the global scope of
  `01-harness-principle.md` §Handler scopes and ordering).
- Cross-session pub/sub fan-out.
- Lifecycle of long-lived app-level resources (sandbox provider, MCP
  clients shared across sessions, telemetry exporters).

It does NOT own:

- Per-session state (session harness).
- Tick orchestration (loop executor).
- Provider mechanics (executor harness).

## Commands in

```ts
interface AppHarnessProtocol<P = unknown> {
  createSession(input: CreateSessionInput<P>): Effect<Session<P>, AppError, AppEnv>;

  runOnce(input: RunOnceInput<P>): Effect<RunOnceResult, AppError, AppEnv>;

  getSession(id: string): Effect<Session<P> | null, AppError, AppEnv>;

  listSessions(filter?: SessionFilter): Effect<SessionListEntry[], AppError, AppEnv>;

  closeApp(): Effect<void, never, AppEnv>;

  // Registration (synchronous; not a command per se, but exposed)
  use(integration: AppIntegration): void;
}
```

```ts
interface CreateSessionInput<P> {
  sessionId?: string; // generated if omitted
  parentSessionId?: string | null;
  metadata?: Record<string, unknown>;
  initialProps?: P;
  initialContext?: Record<string, unknown>;
}

interface RunOnceInput<P> {
  send: SendInput<P>;
  initialProps?: P;
  metadata?: Record<string, unknown>;
}

interface RunOnceResult {
  result: SendResult;
  events: ProtocolEvent[]; // captured (default off; see config)
}
```

`runOnce` is the `App.run(...)` shortcut: create an ephemeral session,
run one execution, close. The session ID is internal and not registered.

### `use` — register interceptors / observers / integrations

```ts
interface AppIntegration {
  name: string;
  install(ctx: AppIntegrationContext): void;
}

interface AppIntegrationContext {
  interceptors: InterceptorRegistry;
  observers: ObserverRegistry;
  services: ServiceRegistry;
}
```

A REPL "runner," a tracing exporter, a custom permission policy — they
all install via `app.use(...)`. The integration registers what it needs
on the registries in scope `global` or `app`.

`[V1-REPLACED]` of v1's `app.use(middleware)` and `ExecutionRunner`
config slot. Now there's one extension surface.

## Events out

All on `surface: "app"`.

```
app:lifecycle:created:terminal
app:lifecycle:closed:terminal

app:session:created:terminal
app:session:closed:terminal
app:session:hibernated:terminal       (re-tagged from session)
app:session:restored:terminal         (re-tagged from session)

app:integration:installed:terminal

app:cross-session:event               (per-session events fan-up here)
                                      (carries inner envelope as payload)
```

The cross-session bus is what observers (audit logs, ops dashboards,
"all sessions in this app") subscribe to. Per-session events are mirrored
here with their `scope.sessionId` field intact.

**Cost when no app-level subscribers**: zero
(`[SOURCE: runtime.md §Observability]`). The cross-session mirror is
conditional on subscriber count.

## Lifecycle handlers + middleware

Per the five-surface model:

```ts
// Lifecycle handlers (.onX)
app.onSessionCreate(handler: (input: CreateSessionInput) => Promise<HandlerVerdict | void>)
app.onSessionClose(handler: (info: { sessionId: string }) => Promise<HandlerVerdict | void>)
app.onAppClose(handler: () => Promise<void>)

// Middleware (.use, around-style)
app.use({
  aroundCreateSession: (input, next) => { ... },
  aroundRunOnce: (input, next) => { ... },
});
```

Use cases:

| Surface                                  | Use case                        |
| ---------------------------------------- | ------------------------------- |
| `onSessionCreate` veto                   | Tenant quota exceeded           |
| `onSessionCreate` (proceed with rewrite) | Inject tenant-specific metadata |
| `onSessionClose` defer                   | Flush analytics before close    |
| `onAppClose`                             | Persist final app state         |
| `aroundCreateSession`                    | Wrap with auth check            |

The legacy `app.use(integration)` for full integrations remains; it
installs a bundle of handlers/middleware/observers under one name.

## Inbox messages

The app harness accepts inbound messages at address `app:{appId}`:

| Message type     | Payload               | Effect                                            |
| ---------------- | --------------------- | ------------------------------------------------- |
| `create-session` | `CreateSessionInput`  | Creates a new session; returns the new sessionId. |
| `close-app`      | `{ reason?: string }` | Initiates app shutdown.                           |
| `list-sessions`  | `SessionFilter?`      | Returns matching session ids.                     |

App-level inbox messages are typically sent by the gateway in cluster
mode. In Tier 0/1, in-process callers use the direct command methods
(`app.createSession(...)`, etc.).

## Outcomes and failures

```ts
type AppError =
  | AppNotInitializedError
  | SessionAlreadyExistsError
  | SessionNotFoundError
  | AuthError // when policy interceptor vetoes
  | AppClosedError;

interface AppNotInitializedError {
  _tag: "AppNotInitializedError";
}
interface SessionAlreadyExistsError {
  _tag: "SessionAlreadyExistsError";
  sessionId: string;
}
interface SessionNotFoundError {
  _tag: "SessionNotFoundError";
  sessionId: string;
}
interface AppClosedError {
  _tag: "AppClosedError";
}
```

## App configuration

```ts
interface AppOptions<P> {
  // Required
  rootElement: JSX.Element;

  // Defaults pushed into every session
  model?: ExecutionTarget;
  tools?: ToolDeclaration[]; // additional to JSX-declared
  sandbox?: SandboxProvider;
  renderer?: FormatterRef; // default content renderer

  // Renderer registry — non-default renderers
  renderers?: Renderer[];

  // Executor adapters — keyed by provider name
  executors?: Record<string, ExecutorProtocol>;

  // Persistence (Tier 1+; see 14-state-tiers.md)
  persistence?: PersistenceLayer;

  // Telemetry (OTel exporter Layer; see 10-events-and-interceptors.md)
  telemetry?: TelemetryLayer;

  // Tick policy
  maxTicks?: number;

  // App-level interceptors / observers (alternative to use())
  interceptors?: InterceptorRegistration[];
  observers?: ObserverRegistration[];

  // Recording / DevTools
  devTools?: boolean;
  recording?: "full" | "lightweight" | "none";
}
```

`[V1-INHERITED]` shape from `packages/core/src/app/types.ts:458`
(`AppOptions`), refined for v2. Differences:

- `runner` removed (replaced by interceptors).
- `executor` slot replaced by `executors` registry (keyed by provider).
- `renderer` and `renderers` added.
- `persistence` is a Layer rather than a `SessionStore` (composable
  across session record / timeline / blob storage).

## App definition: JSX vs config

`[SOURCE: runtime.md (earlier draft) §Two paths to compiled context]` —
the dual paths are preserved:

```tsx
// Path A — config:
const App = createApp(<MyAgent />, {
  model: gpt5,
  tools: [searchTool, sendEmailTool],
  sandbox: localProvider(),
});

// Path B — JSX:
function MyAgent({ user, query }: Props) {
  return (
    <Sandbox provider={localProvider()}>
      <Model model={gpt5} />
      <Tool definition={searchTool} />
      <Tool definition={sendEmailTool} />

      <System>You are helpful</System>
      <Timeline />
      <User>{query}</User>
    </Sandbox>
  );
}
createApp(<MyAgent />);

// Path C — hybrid (typical):
createApp(<MyAgent />, { persistence: postgresPersistence() });
```

Resolution rules:

| Concern           | Rule                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| Model             | JSX wins; `<Model>` overrides config; multiple `<Model>` scope to nearest ancestor |
| Tools             | union; JSX wins on name collision                                                  |
| Sandbox           | JSX-only (naturally tree-scoped); config sets root default                         |
| Renderer          | JSX-scoped; config sets default                                                    |
| Persistence       | config-only (bootstrap concern; chicken-and-egg with hydration)                    |
| Executor adapters | config-only (per-provider)                                                         |
| Telemetry         | config-only                                                                        |

## Session registry

```ts
interface SessionRegistry {
  has(id: string): boolean;
  get(id: string): SessionEntry | undefined;
  list(filter?: SessionFilter): SessionEntry[];
  add(entry: SessionEntry): void;
  remove(id: string): void;
  count(filter?: SessionFilter): number;
}

interface SessionEntry {
  id: string;
  parentSessionId: string | null;
  status: SessionStatus;
  metadata: Record<string, unknown>;
  createdAt: number;
  lastActiveAt?: number;
  // In cluster mode, the entry also carries node placement info
  cluster?: { nodeId?: string; shard?: number };
}

interface SessionFilter {
  status?: SessionStatus | SessionStatus[];
  metadata?: Record<string, unknown>;
  parentSessionId?: string | null;
  // In cluster mode:
  nodeId?: string;
}

interface SessionListEntry extends SessionEntry {}
```

`[PLACEHOLDER]` shape — synthesized; sign-off needed.

In library mode the registry is an in-memory `Map`. In cluster mode it's
a distributed view backed by the cluster's entity manager.

## Lifecycle

```
createApp(rootElement, options)
   ──► installs services in order:
       1. Spec validators
       2. Renderer registry
       3. Executor adapters
       4. Persistence Layer
       5. Telemetry Layer
       6. App-level interceptors / observers
   ──► emits app:lifecycle:created:terminal
   ──► returns App handle

app.session(id?) / app.createSession(...)
   ──► app:session:created:terminal
   ──► instantiates SessionHarness with rootElement + per-session state
   ──► hydrates from persistence if id was hibernated

app.runOnce(input)
   ──► creates ephemeral session
   ──► dispatches send → loop executor
   ──► awaits result
   ──► closes session
   ──► returns RunOnceResult

app.closeApp()
   ──► closes all open sessions (interceptors run per-session)
   ──► flushes telemetry
   ──► releases shared resources (sandbox provider, MCP clients, persistence pool)
   ──► emits app:lifecycle:closed:terminal
```

## App-level services

The app constructs and owns shared services. Services are accessible to
session-level code via Effect's service-injection idiom (Layer/Tag) but
the user surface remains imperative.

| Service                              | Owned by app | Owned by session             |
| ------------------------------------ | ------------ | ---------------------------- |
| Renderer registry                    | yes          | (reads via app)              |
| Executor adapters                    | yes          | (reads via app)              |
| Persistence backend                  | yes          | (reads via app)              |
| Telemetry exporter                   | yes          | (reads via app)              |
| Sandbox provider (default)           | yes          | (overridden per session JSX) |
| MCP clients (shared across sessions) | yes          | (overridden per session JSX) |
| Tool registry root                   | yes          | (extended per session)       |
| Knob declarations registry           | (root)       | per session                  |
| Channel registry                     | (root)       | per session                  |

## Cross-session observability

```
                Per-session PubSub<ProtocolEvent>      ← session subscribers
                          │
                          ▼ (fan-up; conditional on app subscriber count)
                App-wide PubSub<ProtocolEvent>          ← cross-session subscribers
                          │
                          ▼ (in cluster mode: distributed via cluster bus)
                Cluster-wide bus                         ← cross-node subscribers
```

Per-session events are tagged with `scope.sessionId` (and `scope.appId` in
multi-app deployments). Subscribers attach at the appropriate scope:

```ts
// Session-scoped subscriber
const session = await app.session(id);
for await (const event of session.events()) { ... }

// App-scoped (across all sessions)
for await (const event of app.events({ name: { prefix: "tool:" } })) { ... }

// Filtered
for await (const event of app.events({
  name: { exact: "executor:request:terminal" },
  outcome: ["failed", "vetoed"],
})) { ... }
```

`[V1-REPLACED]` of v1's `EventEmitter` listeners on session +
DevTools-specific handling.

## Telemetry

OpenTelemetry-compatible. Spans wrap each command boundary; metrics are
declared with `Effect.Metric`. Telemetry attaches at app construction:

```ts
import { NodeSdk } from "@effect/opentelemetry";

const TelemetryLayer = NodeSdk.layer(() => ({
  resource: { serviceName: "my-agent" },
  spanProcessor: new BatchSpanProcessor(otlpExporter),
}));

createApp(<Agent />, { telemetry: TelemetryLayer });
```

Span hierarchy follows the harness stack:

```
session:execution
  loop:tick
    compiler:compile
    executor:request
      executor:project
      executor:provider
      executor:normalize
    tool:dispatch (per call, in parallel)
      tool:validation
      tool:handler
```

Metrics shipped:

```
agentick.tokens.input              counter
agentick.tokens.output             counter
agentick.tokens.cached_input       counter
agentick.cache.hit_ratio           gauge
agentick.tick.duration             histogram
agentick.executor.duration         histogram
agentick.tool.dispatch.count       counter
agentick.tool.dispatch.duration    histogram
agentick.session.active            gauge
agentick.session.hibernated        gauge
agentick.compile.iterations        histogram
agentick.compile.forced_stable     counter
```

`[PROPOSAL]` exact metric names and units; sign-off needed.

## Multi-tenancy

Per-tenant isolation is achieved through:

1. `metadata.tenantId` on session creation.
2. `app.events({ scope: { tenantId } })` for tenant-scoped subscribers.
3. App-level interceptors that enforce tenant authorization on
   `session-create`.

Shared resources (rate limiters, caches) need tenant-aware coordination.
`[GAP]` — exact mechanism (STM, Ref, backend-managed) is open per
`runtime.md` Open Question 11. Lean: backend-managed (e.g., Redis-based
limiter); see `11-cluster.md`.

## Headless

A session with no subscribers (no events listener, no channel reader, no
telemetry exporter, no cross-session subscriber) runs identically to one
with 50. PubSub bounded buffers don't fill if there are no subscribers
(per `01-harness-principle.md`).

## Composition

```
External code               App harness                Sessions / Loop / ...
─────────────               ───────────                ─────────────────────
createApp(<Agent/>, opts)
                            registers services
                            emits app:lifecycle:created
                            ◄── App handle

app.session(id)             registry lookup
                            (or hydrate from persistence)
                            instantiates SessionHarness ──► constructed
                            ◄── Session

app.events({...})           subscribes to app PubSub
                            ◄── Stream<ProtocolEvent>

app.use(integration)        registers interceptors/observers
                            ◄── void

app.closeApp()              closes all sessions ──► closes per session
                            flushes telemetry
                            ◄── void
```

## Decisions captured

- App is the outermost runtime boundary.
- Library-first; cluster wraps without changing surface.
- Session registry, cross-session bus, and shared services live here.
- App-level interceptors are the "global" scope.
- `runOnce` is sugar for ephemeral session + send + close.
- Path A (config), Path B (JSX), and Path C (hybrid) all valid for
  defining the agent.
- Telemetry is structural (not bolted on).

## Open questions

- Multi-tenant rate-limiter coordination mechanism (lean: backend-managed).
- Recording mode taxonomy (carried from v1; still TBD).
- Exact metric names and units (placeholder; sign-off).
- `SessionRegistry` shape (placeholder; sign-off).
- App-vs-session ownership of MCP clients (per JSX vs config).
