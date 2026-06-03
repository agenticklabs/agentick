# ADR 30 — App-as-recipe: sessions own the substrate

**Status:** Proposed · 2026-06-03
**Builds on:** ADR 26 (Harness as the single shape), ADR 27 (Modular built-ins), ADR 29 (Bus overhaul)
**Touches:** `@agentick/app` (`AppHarness`, `createApp`), `@agentick/session` (`SessionHarness` construction), `@agentick/runtime` (`LocalEventBus`/`LocalInbox`/`MemoryJournal` static `createFactory` helpers), `@agentick/spec` (factory type signatures for the three substrate primitives).

## TL;DR

**Today, `AppHarness` owns the substrate; sessions borrow it.** That asymmetry is an accident, not an architecture — it predates the realization that multi-tenant cloud needs per-tenant isolation and that sessions are the natural unit of cluster sharding.

**Inversion: `AppHarness` becomes a recipe, sessions own the substrate.** The App holds factories + the agent template + shared adopter config. Each `createSession()` constructs a fresh `SessionHarness` with its own substrate (journal/bus/inbox) and its own substrate-coupled harnesses (reconciler/loop/executor/toolExecutor) built via the App's factories. Sessions are self-contained worlds.

**Every resource slot accepts an instance OR a factory.** Pass an instance → share across sessions (today's behavior). Pass a factory → construct per-session. Default → built-in factory returning a fresh in-memory implementation. The escape hatch is clean and uniform across all slots — substrate (bus, inbox, journal), substrate-coupled harnesses (reconciler, loop, executor, tools), even extensions.

**Built-ins ship `createFactory(configFn)` static helpers.** `LocalEventBus.createFactory((deps) => ({ overflow: "drop-oldest" }))` builds a typed factory whose per-call config can capture session context. Adopters can write factories by hand (`() => new LocalEventBus(opts)`); the static helper is ergonomic sugar.

## What this fixes

### 1. Asymmetric substrate ownership

Current `AppHarness` constructs:
- **Shared at app init**: `journal`, `bus`, `inbox`, `reconciler`, `loop`, `executor`. Used by every session.
- **Constructed per session**: `toolExecutor`, `sessionHarness`. Receive references to the shared substrate.

The split was justified as "amortize construction cost across sessions." It produces real architectural problems:

- **Cross-cutting events leak across sessions.** Executor delta events (the highest-volume traffic) emit to the shared bus. A per-session subscriber sees its own session's events AND every other session's executor deltas.
- **Per-tenant isolation requires per-tenant `AppHarness` instances** — i.e., the entire shared-cost optimization gets thrown away when you actually need isolation.
- **Hibernate/restore captures session state but not substrate state.** Restoring a session against a different `AppHarness` doesn't quite work because the session's bridges + scope IDs are tied to the original app's substrate.

### 2. The mental model never matched the implementation

In v1, the engine was app-level config (model, tools, hooks) and `EngineExecution` was the per-call session. The engine didn't own a substrate; each execution stood up its own state. Adopters internalized "execution = session, engine = config." When v2 made the engine into `AppHarness` and the execution into `SessionHarness`, we accidentally inverted the ownership model and confused everyone.

### 3. Cluster substrate doesn't fit the current shape

`@effect/cluster`-backed `EventBus` / `OperationJournal` impls (ADR 29 Phase D) are shared infrastructure: one cluster journal serves every session in the cluster. The current "shared instance at app level" pattern almost works — but it forces "one app per cluster" or "one app per tenant within a cluster," which the user surface can't express cleanly. With factories, the cluster substrate gets resolved at session-create time: the factory returns a tenant-scoped wrapper over the shared cluster resource. Session owns the subscriber lifecycle; the underlying resource is cluster-shared.

## The new model

### AppHarness as a recipe

```ts
// AppHarnessOptions — what the App holds
interface AppHarnessOptions<P> {
  rootElement: unknown;
  target?: ExecutionTarget;

  // Substrate slots — instance OR factory OR undefined (default in-memory factory)
  bus?: EventBus | EventBusFactory;
  journal?: OperationJournal | OperationJournalFactory;
  inbox?: MessageInbox | MessageInboxFactory;

  // Substrate-coupled harnesses — instance OR factory OR undefined
  reconciler?: ReconcilerProtocol | ReconcilerFactory;
  loop?: LoopExecutorProtocol | LoopExecutorFactory;
  executor?: LanguageModelExecutor | ExecutorFactory;
  tools?: ToolExecutorProtocol | ToolExecutorFactory;

  // App-shared (not substrate — adopter-level config)
  toolHandlers?: ReadonlyMap<string, ToolHandler>;     // seed for new sessions
  extensions?: Extension[];                            // session-targeted ones forwarded
  telemetry?: TelemetryLayer;
  sessionDefaults?: SessionDefaults;                    // streaming, maxTicks, props, knobs
  onSessionCreate?: SessionCreateHandler[];

  appId?: string;
}

class AppHarness<P> implements AppHarnessProtocol<P> {
  // What the App actually retains at runtime
  private readonly factories: ResolvedFactories<P>;
  private readonly handlerSeed: ReadonlyMap<string, ToolHandler>;
  private readonly registry: SessionRegistry<P>;      // metadata only: id, status, createdAt
  private readonly sessionDefaults: SessionDefaults;
  private readonly hooks: AppHooks<P>;
  private readonly telemetry: TelemetryLayer | undefined;

  // No journal, no bus, no inbox, no shared reconciler/loop/executor at the App level.
}
```

### createSession — sessions construct their own world

```ts
createSession(input: CreateSessionInput<P> = {}): Promise<SessionHarnessProtocol<P>> {
  const sessionId = input.sessionId ?? `session:${ulid()}`;
  const deps: FactoryDeps = { sessionId, appId: this.appId };

  // 1. Substrate — fresh per session by default, can be shared via instances
  const bus      = resolveSlot(this.factories.bus, deps);
  const journal  = resolveSlot(this.factories.journal, deps);
  const inbox    = resolveSlot(this.factories.inbox, deps);

  // 2. Substrate-coupled harnesses — same pattern, with substrate threaded in
  const harnessDeps = { ...deps, journal, bus, inbox };
  const reconciler   = resolveSlot(this.factories.reconciler, harnessDeps);
  const loop         = resolveSlot(this.factories.loop, harnessDeps);
  const executor     = resolveSlot(this.factories.executor, harnessDeps);
  const toolExecutor = resolveSlot(this.factories.tools, {
    ...harnessDeps,
    handlerResolver: this.makeSessionHandlerResolver(),  // session-scoped, seeded from app
  });

  // 3. SessionHarness orchestrates them
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId,
    agent: input.agent ?? this.rootElement,
    reconciler,
    loop,
    executor,
    toolExecutor,
    /* ...rest of session defaults cascaded... */
  });

  this.registry.add(sessionId, { /* metadata only */ });
  return session.ready.then(() => session);
}

// resolveSlot — the heart of the instance-or-factory escape hatch
function resolveSlot<T>(
  slot: T | Factory<T> | undefined,
  deps: FactoryDeps,
  defaultFactory: () => Factory<T>,
): T {
  if (slot === undefined) return defaultFactory()(deps);
  if (typeof slot === "function") return (slot as Factory<T>)(deps);
  return slot;
}
```

### Instance-or-factory: the escape hatch

The discrimination is `typeof slot === "function"`. Substrate primitives (`EventBus`, `MessageInbox`, `OperationJournal`) are object interfaces with methods — never callable. Substrate-coupled harnesses (`ReconcilerProtocol`, `LoopExecutorProtocol`, etc.) are also object interfaces. Functions in a slot are always factories.

Three modes for any slot:

```ts
// Mode 1 — default: per-session in-memory instance
createApp(<Agent />, { executor: openai("gpt-4o") });
// → each session gets a fresh LocalEventBus, MemoryJournal, LocalInbox, etc.

// Mode 2 — shared instance across sessions (today's behavior, opt-in)
const sharedBus = new LocalEventBus();
createApp(<Agent />, {
  executor: openai("gpt-4o"),
  bus: sharedBus,           // every session uses this exact instance
});

// Mode 3 — per-session factory (cluster, per-tenant, custom config)
createApp(<Agent />, {
  executor: openai("gpt-4o"),
  bus: LocalEventBus.createFactory((deps) => ({
    overflow: "drop-oldest",
    bufferSize: 1024,
  })),
  // Or: bus: ClusterEventBus.forTenant(deps.sessionId)
});
```

### `createFactory` static helper

Each in-memory built-in ships a static `createFactory`:

```ts
// @agentick/runtime
class LocalEventBus implements EventBus {
  static createFactory(
    configFn?: (deps: FactoryDeps) => LocalEventBusOptions
  ): EventBusFactory {
    return (deps) => new LocalEventBus(configFn?.(deps));
  }
  // ... rest of the class
}

class LocalInbox implements MessageInbox {
  static createFactory(
    configFn?: (deps: FactoryDeps) => LocalInboxOptions
  ): MessageInboxFactory { /* ... */ }
}

class MemoryJournal implements OperationJournal {
  static createFactory(
    configFn?: (deps: FactoryDeps) => MemoryJournalOptions
  ): OperationJournalFactory { /* ... */ }
}
```

Usage:

```ts
createApp(<Agent />, {
  bus: LocalEventBus.createFactory((deps) => ({
    bufferSize: deps.sessionId.startsWith("priority:") ? 4096 : 256,
  })),
  journal: MemoryJournal.createFactory(() => ({ capacity: 50_000 })),
});
```

The factory captures the config closure; each `createSession` invocation calls the closure to build fresh options. If config is static, pass `() => staticOpts` once.

### What's NOT a factory: app-shared config

Some things make no sense to be per-session:

- **Tool handler registry** — adopters register handlers by name at app init via `toolHandlers`. These need to flow into every session. Stays at app level as a **handler seed**; each session gets its own handler resolver pre-populated from the seed at create time. Sessions can register additional handlers (JSX-declared tools) without contaminating other sessions.
- **Session registry** — the App tracks which sessions exist (`getSession`, `listSessions`). Metadata only — no substrate.
- **Lifecycle hooks** — `onSessionCreate` runs at every createSession, before substrate construction. App-level.
- **Telemetry layer** — adopter's OTel exporter / metrics sink. App-level; sessions inherit but don't own.
- **App-targeted extensions** — extensions whose `target === "app"` install once on the App. Session-targeted extensions install per-session (already the case today via `AppExtension` / `SessionExtension`).

### `app.events()` — fan-in across live sessions

Today `app.events(filter)` reads from the shared app bus. Under the new model there is no app bus.

**Solution:** `app.events(filter)` becomes a **fan-in subscription** that internally tails every live session's bus + auto-subscribes to new sessions as they're created. Lazy — no events flow until an adopter calls `app.events()`. Closes per-session subscriptions on session close.

```ts
app.events(filter): AsyncIterable<ProtocolEvent> {
  return mergeStreams(
    [...this.registry.entries()].map(({ session }) => session.events(filter)),
    this.newSessionStream(filter),   // emits new session's events as they appear
  );
}
```

Cost: O(N) subscriber registrations per app.events() call, where N is concurrent sessions. For UI / devtools tunneling, N is small. For cluster-wide observability, adopters use the cluster bus directly (cheaper).

### `app.spawn` / `session.spawn` — child inheritance

Today, `session.spawn(ChildAgent, ...)` creates a child session that shares the parent's substrate references (which are app-level today).

Under the new model: by default, child sessions **inherit the parent session's substrate instances** (same bus, same journal, same inbox). This preserves the typical adopter expectation: spawned children's events appear in the parent's event stream.

Explicit override available:

```ts
const child = await parent.spawn(ChildAgent, input, {
  bus: childSpecificBus,           // child uses a separate bus
  // journal, inbox same shape
});
```

For multi-tenant where child sessions should isolate fully, adopters pass tenant-scoped factories at spawn time.

### Hibernate / restore

Today, hibernate captures the SessionHarness state. Restore-against-a-new-app sometimes works, sometimes leaks (scope IDs tied to old app).

Under the new model, **a hibernated session captures everything needed to reconstruct itself**: substrate snapshot (if the bus / journal impl supports it), reconciler snapshot, knob state, timeline, etc. Restore is "construct a fresh session via these factories + replay the snapshot." Sessions are portable across apps. Cluster sharding becomes "rehydrate this session's hibernation snapshot on whatever node currently owns its shard."

## What the App actually retains at runtime

Minimal:

```ts
class AppHarness<P> implements AppHarnessProtocol<P> {
  // pure configuration — resolved factories + adopter-level config
  private readonly factories: ResolvedFactories<P>;
  private readonly handlerSeed: ReadonlyMap<string, ToolHandler>;
  private readonly sessionDefaults: SessionDefaults;
  private readonly hooks: AppHooks<P>;
  private readonly telemetry: TelemetryLayer | undefined;
  private readonly extensionsForSessions: SessionExtension[];

  // runtime state — session registry + app-targeted extension lifecycle
  private readonly registry: SessionRegistry<P>;
  private readonly extensionCloseHandlers: Array<() => Promise<void>>;

  // No journal. No bus. No inbox.
  // No long-lived reconciler / loop / executor / toolExecutor.
}
```

The App is still a `BaseHarness`-derived thing in the sense that it has inbox-message handling (for app-targeted extensions installing services) and lifecycle hooks (`closeApp` interrupts all live sessions). But it owns no substrate of its own; it dispatches inbox messages via a thin private substrate used only for app-targeted concerns.

### Should we rename?

Considered. Keep `AppHarness` — less churn, and it's still a harness in the protocol-conforming sense (BaseHarness, inbox-dispatchable, lifecycle, journaling policy). The semantic shift is documented in the package README + this ADR. `app` as an adopter-facing concept stays correct: it's the configuration scope for a family of sessions.

## Implementation phases

Each phase ships independently.

### Phase 1 — Factory typedefs + `createFactory` helpers (1-2 days)

- Spec: define `Factory<T>` and per-resource factory aliases (`EventBusFactory`, etc.).
- Runtime: `LocalEventBus.createFactory`, `LocalInbox.createFactory`, `MemoryJournal.createFactory`.
- No AppHarness change yet. Adopters can already use the static helpers with the existing slot pattern (since existing executor/loop/reconciler/tools slots already accept factories).

### Phase 2 — AppHarnessOptions accepts factories for substrate slots (2-3 days)

- Add `bus`, `journal`, `inbox` slots to `AppHarnessOptions` that accept instance-or-factory.
- `resolveSlot` helper in app/src/harness.ts.
- App constructor still defaults to single-instance behavior IF substrate slots are passed as instances; falls back to "fresh instance per session" if undefined (Phase 3 makes per-session the default).
- Update existing tests (most pass instances; behavior unchanged for them).

### Phase 3 — Sessions own everything (the actual inversion, 1 week)

- Move substrate + harness construction from AppHarness ctor into `createSessionBody`.
- AppHarness only holds factories + registry metadata + handlerSeed + hooks.
- Per-session handler resolver, seeded from app handlerSeed at session create.
- `app.events()` reshaped to fan-in subscriber across live sessions.
- example/v2-real updated to confirm adopter-facing API still feels right.
- Workspace tests pass.
- ADR 26/27 documentation updated to reflect.

### Phase 4 — Hibernate/restore portability (post-1.0, 1-2 weeks)

- SessionHarness snapshot grows to capture substrate state where possible.
- Restore = construct fresh session via factories + replay snapshot.
- Cluster shard migration enabled.
- Out of scope for the immediate inversion.

## Migration / backwards compatibility

**Adopter-facing surface**: minimal change.

- `createApp(<Agent />, { executor })` — still works.
- `app.createSession()` — still works.
- `app.runOnce({ messages })` — still works.
- `app.send("text")` — still works.
- `app.events(filter)` — still works (now fan-in instead of single-bus read).
- `app.close()` — still works (now closes every session instead of closing the app substrate).

**Adopters who reach into App internals** (e.g., `app.bus.subscribe(...)` directly) will break. The codebase grep should be cheap; we have a small set of in-repo callsites.

**Test impact**: `example/v2-real`, `packages/app/src/__tests__/*`, sandbox tests, scenario examples. All go through the public API; should pass after the refactor with no test changes.

## Open design decisions

### 1. Should `app.events()` fan-in or be dropped?

**Recommendation:** fan-in. Adopters do reach for this in devtools and unified observability flows. Dropping it removes a useful affordance for a small cost in subscriber-registration overhead.

### 2. Should we preserve the `toolHandlers: Map` app-init seed pattern, or move tool registration fully to session level?

**Recommendation:** keep the seed. App-level adopter-registered handlers are common (initialization code at boot registers a curated set of tools); requiring re-registration per session is annoying. The seed flows into each new session's resolver at create time; sessions can extend.

### 3. Should built-in factories accept a `FactoryDeps` argument with session context?

```ts
LocalEventBus.createFactory((deps: { sessionId, appId }) => ({ /* ... */ }))
```

vs the simpler form:

```ts
LocalEventBus.createFactory(() => ({ /* ... */ }))
```

**Recommendation:** **yes, pass `FactoryDeps`**. Adopters need session context for per-tenant routing (`new ClusterBus({ tenant: tenantOf(deps.sessionId) })`). The argument is optional in TS terms; adopters who don't need it can omit.

### 4. What about app-targeted extensions that need a substrate?

Today, app-targeted extensions install via the `AppInstaller` which exposes `substrate: { journal, bus, inbox }`. Under the new model, app-targeted extensions don't have a substrate to install into (no app bus). Three options:

- (a) **App-targeted extensions install at session-create time**, scoped to that session's substrate. Renames the category to "auto-install-per-session extensions."
- (b) **App keeps a private internal substrate** used only for app-targeted concerns. Extensions install into that.
- (c) **Drop app-targeted extensions**. Everything is session-targeted.

**Recommendation:** **(a)**. Cleanest semantic. App-targeted extensions are rare in practice; mostly Sandbox/MCP/Subscription, which fit "auto-install per session" naturally.

### 5. Cluster substrate sharing — what's the contract?

When a session factory returns a SHARED cluster bus (same instance across all sessions in this app), session-close behavior should NOT shut down the bus. Solution: factories return the resource; sessions close ONLY resources they constructed themselves. Implementation: factories return either a fresh instance (sessions own lifecycle) or a wrapper around a shared resource (`SharedRef<T>`) with ref-counted close.

**Recommendation:** decide during Phase 3 implementation. Likely shape: factories return `{ instance: T, owned: boolean }` so the session knows whether to call close on its own.

## Why now

We've spent two weeks getting the executor + layered providerOptions story right. The next architectural challenges (ADR 29 bus overhaul + cluster substrate + per-tenant isolation + hibernate portability) all want sessions to own their substrate. The inversion is foundational to all of them.

The cost of doing this NOW is small (a 1-week refactor with minimal adopter surface change). The cost of doing it LATER grows fast as more adopters write code against `app.bus` / `app.journal` directly.

## References

- `docs/proposals/v2/blueprint/26-harness-api-shape.md` (the slot pattern this builds on)
- `docs/proposals/v2/blueprint/27-modular-built-ins.md` (modular extension pattern)
- `docs/proposals/v2/blueprint/29-bus-overhaul.md` (the bus + log primitive this enables)
- `packages/app/src/harness.ts` (current AppHarness — the inversion target)
- `packages/session/src/harness.ts` (current SessionHarness — gains substrate ownership)
- v1 `packages/core/src/engine/*` (the mental model we're returning to: engine = config, execution = runtime)
