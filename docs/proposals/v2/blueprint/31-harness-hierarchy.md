# ADR 31 — Self-similar slottable harness hierarchy

**Status:** Active · 2026-06-03
**Builds on:** ADR 26 (Harness as the single shape), ADR 27 (Modular built-ins), ADR 29 (Bus overhaul)
**Supersedes:** ADR 30 (App-as-recipe — wrong scope; the hierarchy below achieves the same goals without forcing the inversion).
**Touches:** `@agentick/spec` (factory types, `BaseHarness` protocol additions, `SessionHarnessOptions` expansion), `@agentick/runtime` (substrate primitives gain optional parent constructor + documented composition semantics; `createFactory` static helpers reshaped), `@agentick/app`, `@agentick/session`, future `@agentick/gateway` + `@agentick/skills`.

## TL;DR

**Every level of agentick is the same shape.** A harness is a node in a hierarchy with:

- an identity + optional parent reference + construction-time input,
- **substrate** (`bus`, `inbox`, `journal`) — uniform across every `BaseHarness`,
- **slots** — harness-specific children (apps, sessions, executor, loop, etc.),
- a lifecycle (`onClose`).

**Substrate slots and harness slots accept `instance | factory`.** Session slot accepts `config-bag | factory` (no instance — sessions are units of execution, not infrastructure to share). One factory signature everywhere:

```ts
type Factory<R, P extends BaseHarness> = (parent: P) => R | Promise<R> | Effect<R, never, never>;
```

No `FactoryDeps`. No `Lifecycle` interface. Parent carries identity, substrate access, lifecycle hook (`onClose`), construction input, runtime-context access.

**Three-level hierarchy in v2:** `GatewayHarness` → `AppHarness` → `SessionHarness`.
- Gateway: cluster-node level. ADR 29's cluster substrate (`ClusterEventBus`, `ClusterJournal`, …) lives here.
- App: configuration + supervisor. Apps host sessions. Typically passes gateway substrate through.
- **Session: tenant boundary.** Multi-tenancy is structural at session level via per-session substrate factories wrapping upstream.

**Substrate primitives are composable.** `LocalEventBus`, `MemoryJournal`, `LocalInbox` accept an optional `parent` in their constructor. Wrapping a parent produces the documented composition behavior per impl (bus + journal: fan-in writes / isolated reads; inbox: full isolation — addressing semantics make fan-in actively wrong).

**Multi-tenancy is emergent, not a feature.** The framework defines no `tenantId` field anywhere. Adopter wires tenancy via substrate factories + closure capture + the `metadata: Record<string, unknown>` bag the framework hosts on every harness.

This is the v1 mental model returned (engine = supervisor, execution = runtime) — generalized through one more layer (gateway for cluster) and made uniform across every harness.

## What this fixes

### 1. Phase 1's misshapen abstractions

Phase 1 of ADR 30 shipped `FactoryDeps` and `Lifecycle` as separate types. Both redundant once you accept the self-similar hierarchy — the parent harness IS the lifecycle, IS the identity context, IS the substrate access point. Splitting it into two narrow interfaces was a two-level worldview that doesn't generalize to N-level recursive.

Phase 1's `Factory<T> = (deps, lifecycle) => T` becomes `Factory<R, P> = (parent: P) => R | Promise<R> | Effect<R, never, never>`. One concept (parent) where there were three (parent, deps, lifecycle).

### 2. ADR 30's "sessions own substrate" inversion was the wrong scope

ADR 30 proposed AppHarness becomes a recipe — sessions construct their own substrate. That solved per-session isolation but required reshaping the entire AppHarness construction story.

The hierarchical model achieves the same goals (per-session isolation, multi-tenant cloud, hibernate portability) without the inversion:
- App keeps its substrate (today's behavior preserved by default).
- Sessions opt-in to per-session substrate via factory slots.
- Per-session factories wrap upstream — fan-in to app substrate happens by virtue of the parent constructor.
- `app.events()` continues to read the app bus directly — no fan-in machinery.

ADR 30 in full is therefore superseded.

### 3. The "two factory shapes" footgun goes away

One uniform shape. Every factory takes `parent`. Whether parent is `GatewayHarness`, `AppHarness`, `SessionHarness`, or a future harness, the shape is identical.

### 4. Cluster integration has a natural home

ADR 29's batching/cursor/log primitives target Gateway-level substrate. `ClusterEventBus` / `ClusterJournal` / `ClusterInbox` satisfy the existing substrate protocols at the gateway. Apps and sessions below wrap or use directly. No special-case at non-gateway layers.

### 5. v1's mental model returns, generalized

v1's engine/execution split (engine = config, execution = runtime) is restored. Sessions are first-class units of execution. The new wrinkle: a layer above app (gateway) for cluster mode, and a layer below (future per-execution harnesses?) — all the same shape.

## The model

### Self-similar harness node

```ts
abstract class BaseHarness<
  Parent extends BaseHarness<any, any> | undefined = undefined,
  Input = unknown,
> {
  readonly id: string;
  readonly parent: Parent;
  readonly input: Input;
  readonly metadata: Readonly<Record<string, unknown>>;  // adopter bag

  // Substrate — uniform across every BaseHarness subclass.
  readonly bus: EventBus;
  readonly inbox: MessageInbox;
  readonly journal: OperationJournal;

  // Lifecycle — registered on by factories during construction.
  onClose(handler: () => void | Promise<void>): void;

  // Sync read of the current operation's RuntimeContext (sessionId,
  // executionId, tickId, opId, parentOpId, correlationId). Valid only
  // when called inside an Effect fiber that has a `RuntimeContextRef`
  // set — i.e., during factory execution within the parent's
  // `createSession` / `createApp` / etc. Operation. Throws outside.
  runtimeContext(): RuntimeContext;

  // close() runs every registered onClose handler in LIFO order with
  // error isolation. Closes substrate constructed by THIS harness
  // (factory path); borrowed substrate from parent is untouched.
  close(): Promise<void>;
}
```

The `Parent` type parameter gives compile-time access to grandparents — `session.parent` typed as `AppHarness`, `session.parent.parent` typed as `GatewayHarness | undefined`. Plain `BaseHarness` (no parent typing) defaults to `undefined`.

### The factory shape — one signature

```ts
type Factory<R, P extends BaseHarness<any, any>> =
  (parent: P) => R | Promise<R> | Effect<R, never, never>;
```

- **Sync return**: construct + return.
- **Promise return**: async construction (remote handshake, etc.).
- **Effect return**: Effect-native. Yield `RuntimeContextRef` for fiber-tracked context; yield `Effect.acquireRelease` for automatic close registration on parent's scope.

Sync/Promise factories that need fiber context call `parent.runtimeContext()` synchronously. Effect factories yield directly. Both compose.

Factories register cleanup via `parent.onClose(h)`. Standard pattern:

```ts
const factory: EventBusFactory = (parent) => {
  const bus = new LocalEventBus({ parent: parent.bus });
  parent.onClose(() => bus.close());
  return bus;
};
```

**No marker properties.** Phase 1's `eventBusFactory: true` etc. were redundant — `typeof slot === "function"` discriminates cleanly since substrate primitives are object-shaped. Factory types become plain function-type aliases.

### The slot pattern matrix

| Slot type | Forms accepted | Why |
|---|---|---|
| Substrate (bus/inbox/journal) | `instance \| factory` | Substrate is infrastructure. Can be shared (instance) or per-session (factory). |
| Harness slots (executor/loop/reconciler/tools) | `instance \| factory` | Same shape as substrate. Sharing has structural meaning. |
| Session slot at `AppHarnessOptions.session` | `SessionDefaults \| SessionFactory<P>` | Sessions are units of execution, not infrastructure. Instance-sharing has no meaning. Config-bag form supplies defaults; factory form is full custom construction. |
| Gateway → apps slot | `AppHarness[] \| AppFactory \| AppRouter` | Eager (list) for fixed app sets; lazy factory or router for on-demand. |

Each slot's pattern reflects what "shared" means for that resource type.

### Composable substrate primitives

Substrate impls accept an optional `parent` in a uniform options-object signature:

```ts
new LocalEventBus({ parent?, /* future fields */ })
new LocalInbox({ parent?, idempotencyTtlMs?, idempotencyMaxEntries?, ... })
new MemoryJournal({ parent?, capacity?, ... })
```

Default composition semantics (concrete per impl, documented in their package READMEs):

- **`LocalEventBus` with parent** — writes publish to BOTH local buffer and parent; subscribers attach to local buffer only. **Fan-in writes / isolated reads.** The tenant-scoped bus pattern.
- **`MemoryJournal` with parent** — same shape as bus. Writes append to both; reads return local entries.
- **`LocalInbox` with parent** — **full isolation.** Handlers receive messages from local inbox only; `send` to local routes to local handlers, not parent. This asymmetry vs bus/journal is *deliberate*: inboxes are addressable (you `send` to a named address), not broadcast. Fan-in to a parent inbox would mean every tenant-scoped handler also receives every other tenant's messages — actively wrong, not just leaky. Isolation is the only meaningful default.

Adopters who want different semantics (strict isolation across all substrate, bidirectional bridging, etc.) write their own composition.

### Two-phase construction

A harness exists in two phases:

1. **Shell** — instantiated with `(id, parent, input)`. Has `onClose`, `metadata`, `runtimeContext()`, `parent`, `input`. Substrate not yet wired.
2. **Wired** — substrate factories ran with the shell as parent; slot factories ran; harness's substrate + slot fields populated. Harness is "ready."

**Order at each level:**

1. Construct shell with `(id, parent, input)`.
2. Resolve substrate slots: `journal` → `bus` → `inbox`. Instance: use as-is. Factory: call with shell as parent.
3. Set shell.journal / .bus / .inbox.
4. Resolve harness slots: factories called with the (substrate-wired) shell as parent.
5. Mark `ready`.

Children harnesses (slots holding them) follow the same two-phase construction with this harness as their parent. The hierarchy is constructed top-down — parent fully wired before children.

### Close-Operation semantics — bus-only by policy override

Harnesses that wrap close in a `runOperation` (`AppHarness.closeApp`, `SessionHarness.close`, future `GatewayHarness.close`) have a structural tension: the Operation framework writes "requested" and "terminal" envelopes to the journal around the close body, but adopter-registered `onClose` handlers in the close body typically *close the journal itself*. Writing the terminal envelope to a closed journal crashes.

The clean fix: **close-Operation envelopes are routed bus-only via `JournalingPolicy.override`.** The framework's "requested" / "terminal" envelopes for the close-Op skip the journal entirely and publish only to the bus. Bus subscribers (devtools, audit, observability) still see close happen; the journal stays uninvolved.

```ts
// AppHarness constructor:
super("app", appId, journal, bus, inbox, {
  metadata: options.metadata,
  policy: {
    ...DEFAULT_JOURNALING_POLICY,
    override: {
      "app:command:close-app": "bus-only",
    },
  },
});
```

This means `BaseHarness.close()` runs in the simple form — `inboxUnsubscribe()` + LIFO unwind of `onClose` handlers — without special-casing close-Operations. Subclasses with a close-Op just mark their op name `"bus-only"` in their construction policy. The journal can be closed by an `onClose` handler inside the body without crashing the framework.

Adopters who *want* close-Op events journaled (durable audit of close lifecycle) can flip the override back to `"always"` — they accept responsibility for keeping the journal alive across the close.

The closed-bus case is harmless: `LocalEventBus.publish` on a closed bus returns `Effect.void` (early-returns). So even if the body closes the bus too, the framework's terminal-envelope publish is a silent no-op rather than a crash.

**Why "close events shouldn't journal" is the correct semantic:**
- Close is one-shot terminal — there's no replay of close.
- Close is idempotent at the harness level (`_closed` flag short-circuits double-close).
- The journal's job is to record operations whose outcomes might need to be retrieved (idempotency, audit, replay). Close doesn't fit that — it destroys the journal as part of its body.

### Construction input carried on the shell

The harness shell stores its construction input. Factories read it via `parent.input` or the shorter `parent.metadata` (adopter-defined sub-bag of input).

```ts
interface CreateSessionInput<P = unknown> {
  // Identity / structure (override-able per call; defaults from app-level config)
  sessionId?: string;
  parentSessionId?: string;
  rootElement?: unknown;            // overrides app's rootElement (consistent name)

  // Substrate overrides — instance | factory
  bus?:     EventBus              | EventBusFactory;
  inbox?:   MessageInbox          | MessageInboxFactory;
  journal?: OperationJournal      | OperationJournalFactory;

  // Harness slot overrides — instance | factory (rare per-session use)
  reconciler?:   ReconcilerProtocol     | ReconcilerFactory;
  loop?:         LoopExecutorProtocol   | LoopExecutorFactory;
  executor?:     LanguageModelExecutor  | ExecutorFactory;
  toolExecutor?: ToolExecutorProtocol   | ToolExecutorFactory;

  // Adopter inputs
  initialProps?: P;
  initialKnobs?: Readonly<Record<string, unknown>>;
  initialState?: Readonly<Record<string, unknown>>;
  maxTicks?: number;
  defaultStreaming?: boolean;
  signal?: AbortSignal;
  tools?: ReadonlyArray<unknown>;   // session-scoped additional tools

  // Adopter-defined bag. Framework defines no keys. Where
  // tenant-equivalent state lives if adopters want it.
  metadata?: Readonly<Record<string, unknown>>;
}

type SessionHarnessOptions<P = unknown> = CreateSessionInput<P> & {
  // Required at construction time — framework wires these.
  readonly parent: AppHarness;
  readonly sessionId: string;
};
```

Substrate factory reads adopter data via parent.metadata:

```ts
session: {
  bus: (sessionShell) => {
    const upstream = sessionShell.parent.bus;
    const adopterTenant = sessionShell.metadata["tenant"];  // adopter key, not framework
    return adopterTenant
      ? new LocalEventBus({ parent: upstream, scope: adopterTenant })
      : new LocalEventBus({ parent: upstream });
  },
}
```

### Multi-tenancy emerges from primitives

No `tenantId` anywhere in the framework. The three primitives that compose into tenancy:

1. **Substrate slots accept factories** → per-session substrate is possible.
2. **Substrate primitives accept optional parent** → factories can wrap upstream.
3. **Harness shells carry adopter-defined `metadata`** → tenant info flows through.

Adopter wires tenancy:

```ts
// Adopter-side. Framework sees no "tenant" anywhere.
const app = createApp(<Agent />, {
  bus: new ClusterEventBus(cluster),
  session: {
    bus: (sessionShell) => {
      const tenant = sessionShell.metadata["tenant"];
      return new LocalEventBus({ parent: sessionShell.parent.bus, scope: tenant });
    },
  },
});

async function handleRequest(req) {
  return app.createSession({
    metadata: { tenant: req.tenantId, traceId: req.traceId },
  });
}
```

### Cluster integration — ADR 29 substrate at Gateway

Gateway substrate is the integration point for `@effect/cluster`:

- `ClusterEventBus`, `ClusterJournal`, `ClusterInbox` implement the existing substrate protocols.
- Gateway slots accept them as instances (typical) or factories.
- Apps and sessions below the gateway wrap or pass through via the same patterns.

ADR 29's compileQuery (Phase A, already shipped), per-surface batching policy (Phase B), cursor-based subscriptions (Phase C), `@effect/cluster` impl (Phase D) all apply uniformly across the hierarchy.

## Observation vs control flow — separate surfaces

`session.events(filter)` and `app.events(filter)` are **observation only**. Bus subscribers cannot affect execution — same contract as ADR 19. They read; they never write back into the operation pipeline.

Steering / control flow uses the reconciler surface:

- **`useLoopControl`** — components decide whether the loop continues. The v2-native steering API.
- **`useOnTickEnd` / `useOnExecutionEnd`** — render-time hooks with optional side-effect-into-control-flow via `useLoopControl`.
- **Lifecycle handlers via `BaseHarness`'s phase contract** — `before` / `replace` / `defer` / `veto` verdicts. Substrate-level steering.

v1's `onComplete: (result) => void` callbacks were misuse — they couldn't actually steer. v2 drops the callback fields entirely:

| v1 callback | v2 replacement |
|---|---|
| `onEvent` | `session.events({})` |
| `onTickStart` | `session.events({ phase: "tick-start" })` or `useOnTickStart` |
| `onTickEnd` | `session.events({ phase: "tick-end" })` or `useOnTickEnd` |
| `onComplete` | `session.events({ phase: "execution-end" })` |
| `onError` | `session.events({ phase: "error" })` or `useOnError` |

Adopters who used callbacks for *observation*: switch to `events()`.
Adopters who used callbacks for *steering*: they were stuck in v1; v2 routes them to the reconciler hooks where steering actually works.

## Open design questions — resolved

### 1. `runtimeContext()` semantics on a not-yet-wired shell

**Resolved.** `runtimeContext()` reads the CURRENT fiber's `RuntimeContextRef` regardless of whether the harness's own substrate is wired. Factories run INSIDE the parent's `createSession` (or `createApp`) Operation, so the fiber has a context. Outside an Effect fiber → throws (or returns a documented default — leaning throws for fail-fast). Adopters who hold a long-lived factory reference and call its helpers later get a defined error, not silent garbage.

### 2. Opinionated composition defaults

**Resolved.** Substrate primitives ship documented defaults (fan-in for bus + journal, isolation for inbox). Adopters who want different semantics use a different class or subclass. Friction-vs-flexibility tradeoff favors flexibility-via-substitution over opinionated-default-as-only-option.

### 3. Gateway → apps slot

**Resolved.** Support both eager (list) and lazy (factory or router). Same `instance | factory` discrimination at runtime; type union covers both list and function shapes.

### 4. `BaseHarness.parent` typing

**Resolved.** Generic over parent type. `class BaseHarness<Parent, Input>` so `session.parent` typed as `AppHarness`, `session.parent.parent` typed as `GatewayHarness | undefined`. Adopters of plain BaseHarness default to undefined parent.

### 5. Ancestor accessors

**Resolved.** Each harness defines typed properties pointing to specific ancestors. `SessionHarness.app: AppHarness`, `SessionHarness.gateway: GatewayHarness | undefined`, etc. Eager named properties — easy autocomplete, type-narrowed, no runtime walk. Per harness class.

## Future directions

### Skills harness — built-in top-level extension

Skill registry currently lives as an app-level field. Under the harness pattern, it should be its own harness: `SkillsHarness extends BaseHarness<App, SkillsOptions>`. App slot: `skills?: SkillsHarness | SkillsFactory`. Skill registration / lookup goes through the harness; per-session skill scoping becomes possible via session-level overrides.

Plan: build it as a built-in top-level extension (in `@agentick/skills`, bundled into the public metapackage), shipped after the hierarchy lands.

### Cluster harness package

`@agentick/cluster` for `ClusterEventBus`/`ClusterJournal`/`ClusterInbox` + future `GatewayHarness`. Depends on `@effect/cluster`.

### Per-execution harness?

Currently, sessions own executions (a session has 1..N executions over its lifetime). A future ADR may explore whether per-execution scope deserves its own harness. Self-similar pattern would make this trivial to add — same factory shape, same slots.

## Phased rollout

### Phase 0 — ADR review (this doc)

Complete with this update. Code work begins after commit.

### Phase 1' — Reshape (replaces the original Phase 1)

- Delete `FactoryDeps`, `Lifecycle` from spec.
- Change `Factory<R, P>` signature to `(parent: P) => R | Promise<R> | Effect<R>`.
- Drop xFactory marker properties from per-resource factory interfaces — typeof discrimination is sufficient.
- Reshape `createFactory` helpers.
- Add optional `parent` parameter to substrate primitive constructors with documented composition semantics.
- Add `parent.runtimeContext()` accessor on `BaseHarness`.
- Add `BaseHarness.parent` and `BaseHarness.input` generic types.
- Add `metadata` field to BaseHarness construction options.

~Half a day. Tests reshape (`mockLifecycle` → `mockParent`).

### Phase 2 — App-level substrate slots accept instance | factory

- `AppHarnessOptions.bus` / `inbox` / `journal` accept the unified type.
- `AppHarness` resolves slots at app-init.

2–3 days. Backwards compatible.

### Phase 3 — Session-level substrate slots + `app.createSession` shape — SHIPPED

Landed in commits `2f5b0dfb` (Phase 3) + cleanup follow-up:

- `CreateSessionInput<P>` gains `bus / inbox / journal` as `instance | factory`. Factory parent is `SessionSubstrateParent` (the session shell) whose `.bus / .inbox / .journal` expose the APP's substrate as default upstream.
- `SessionHarnessOptions<P>` gains the same substrate slots + adopter `metadata`.
- `SessionSubstrateParent` lives in spec at `protocol/session-harness.ts`; session re-exports for convenience.
- `CreateSessionInput<P>` also gains `rootElement` (per-call agent override), `initialState`, `parentSessionId`, plus `signal` and `tools` (typed but plumbing deferred — see below).
- `SessionHarness` constructor uses the explicit-parent resolver (from `@agentick/runtime`); per-session close-op envelopes marked `"bus-only"` via `JournalingPolicy.override` so session-level journal factories can close the journal in their `onClose` without crashing the close Operation (Option G).
- `AppHarness.createSessionBody` cascades: per-call input > app-level `session.*` defaults > inherit.
- Multi-tenant adopters unblocked. Tenancy is emergent: framework defines no `tenantId`; adopters wire via factory + closure + metadata.

**Deferred from this phase, tracked explicitly:**

- **`SessionFactory<P>` at `AppHarnessOptions.session`** as alternative to the config bag. The config bag (`SessionDefaults<P>`) covers every multi-tenant use case; the full SessionFactory form (`(parent, input) => SessionHarness`) is a power-user customization for adopters who want to fully take over session construction. Tracked for Phase 5 polish.
- **`signal` plumbing into SessionHarness lifecycle** — the field is accepted at the API but not yet wired to abort a running session when fired. Needs SessionHarness lifecycle work.
- **`tools` field plumbing into per-session ToolExecutor** — the field is accepted; merging with app-level tools needs ToolExecutor wiring work.
- **v1 callback field migration note in CHANGELOG** — no CHANGELOG infra yet; deferred until v2.0 RC.

These deferrals don't block multi-tenant adopters and don't compromise the architecture.

### Phase 4 — `GatewayHarness` lands

- New `@agentick/gateway` package.
- `GatewayHarness extends BaseHarness` with slots for `apps` (eager + lazy).
- Cluster substrate impls (`ClusterEventBus`, `ClusterJournal`) ship in `@agentick/cluster`.
- Existing apps continue to work without a gateway (the gateway is optional).

Depends on ADR 29 Phase B+. 2–4 weeks.

### Phase 5 — Skills harness + ergonomics polish

- `@agentick/skills` ships SkillsHarness as a built-in top-level extension.
- Named ancestor accessors finalized per harness class.
- Composition primitive helpers if the constructor-parent defaults aren't expressive enough.
- Documentation + examples.

1 week.

## Migration from Phase 1

Phase 1 of ADR 30 shipped four things; three reshape, one stays:

| Shipped | Status | Reshape |
| --- | --- | --- |
| `Factory<T>` typedef in spec | Reshape | Signature → `(parent: P) => R` |
| `FactoryDeps` interface | Delete | Identity via `parent.id` |
| `Lifecycle` interface | Delete | `parent.onClose(h)` |
| `createFactory` static helpers | Reshape | Same name, new factory signature |
| xFactory marker properties on per-resource factories | Delete | `typeof slot === "function"` suffices |
| `create-factory.spec.ts` tests | Reshape | `mockLifecycle()` → `mockParent()` |

Half a day of mechanical changes. The Phase 1 commit (`dce217c1`) was internal — no external adopter built against it, so the rewrite is safe.

## ADR 30 disposition

ADR 30 is **superseded** by this one. Its design exploration is still useful background reading and stays in `blueprint/` with status updated to `Superseded by ADR 31`.

## References

- `docs/proposals/v2/blueprint/19-foundation.md` — original substrate contract.
- `docs/proposals/v2/blueprint/26-harness-api-shape.md` — the slot pattern this builds on.
- `docs/proposals/v2/blueprint/27-modular-built-ins.md` — augmentation pattern for adopter-supplied harnesses.
- `docs/proposals/v2/blueprint/29-bus-overhaul.md` — cluster-substrate work that fits at the gateway layer.
- `docs/proposals/v2/blueprint/30-app-as-recipe.md` — superseded by this ADR; retains the design exploration.
- v1 `packages/core/src/app/types.ts` `SessionOptions` — the v1 shape this returns to (modernized for v2's slot model + substrate slots).
- v1 `packages/core/src/engine` — the engine/execution split this returns to, generalized through one more layer.
