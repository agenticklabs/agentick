# @agentick/runtime-next

In-process substrate for Agentick v2. Provides the default implementation
of the `@agentick/spec-next` protocol interfaces:

| Implementation  | Spec interface                      |
| --------------- | ----------------------------------- |
| `MemoryJournal` | `OperationJournal`                  |
| `LocalEventBus` | `EventBus`                          |
| `LocalInbox`    | `MessageInbox`                      |
| `BaseHarness`   | (not a spec interface — base class) |

`BaseHarness` is the inheritance point every concrete harness sits on
top of. It composes journal + bus + inbox into the five-surface model
(commands, inbox, lifecycle handlers, middleware, events) described in
`docs/proposals/v2/blueprint/01-harness-principle.md`.

This package is **in-process only**. Distribution (cluster) and
persistence (postgres/sqlite/redis) are separate packages that
implement the same `@agentick/spec-next` protocol interfaces.

## Status

Phase 2 of the v2 implementation plan — see
`docs/proposals/v2/STATUS.md`.

---

## RuntimeContext — scope identity that propagates through Effect fibers

`RuntimeContext` is the ambient state a handler, middleware, or
observer sees. It extends `EventScope` (the canonical event-routing
identity coordinates from `@agentick/spec-next`) with operation-level
state, diagnostic ephemera, and an adopter-augmentable `user` slot.

```ts
import type { RuntimeContext } from "@agentick/runtime-next";

interface RuntimeContext extends EventScope {
  // Inherited from EventScope: appId / sessionId / executionId /
  // tickId / parentSessionId / spawnPath / nodeId / gatewayId
  // + augmented harness identifiers (sandboxId, mcpConnectionId, ...)

  // Operation-level state:
  readonly opId?: string;
  readonly parentOpId?: string;

  // Diagnostic ephemera:
  readonly correlationId?: string;
  readonly traceparent?: string;

  // Adopter extension (typed via module augmentation):
  readonly user?: RuntimeContextUser;
}
```

### Adopter extension via module augmentation

`RuntimeContextUser` is an empty seed in spec-next. Adopters augment
via `declare module` to type their own per-call ambient state.
Mirrors the v1 `UserContext` pattern + the v2 `HookBridges` /
`EventScopeExtensions` empty-seed convention used elsewhere.

```ts
// In your app's setup:
declare module "@agentick/runtime-next" {
  interface RuntimeContextUser {
    readonly tenantId: string;
    readonly userId: string;
    readonly requestId?: string;
    readonly featureFlags?: Readonly<Record<string, boolean>>;
  }
}

// Then anywhere ctx is in scope:
async (input, { ctx }) => {
  const tenant = ctx.user?.tenantId; // typed!
  // ...
};
```

⚠️ **The framework's auth-bearing primitives do NOT consult
`ctx.user` for authorization.** Per ADR 45's structural-identity
rule, principal-bearing resources (MCP client harness, sandbox
runtime, etc.) encode the principal in their construction identity.
Adopters MAY put `userId` / `tenantId` in `ctx.user` for their OWN
telemetry / branching / logging, but it isn't a security boundary.

### Reading + writing context

| Surface                   | When                                    | How                                                                                                                                          |
| ------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `yield* getContext`       | Inside an Effect chain (substrate code) | Effect-native read — works correctly within fiber lineage.                                                                                   |
| `withContext(scope, eff)` | Inside an Effect chain                  | Scoped write — inner wins on collision; reverts on Effect exit.                                                                              |
| `readContext()`           | Outside an Effect chain (rare)          | Sync snapshot. Honest contract: works outside Effect fibers, returns `EMPTY_CONTEXT` inside Effect fibers (the nested `Effect.runSync` gap). |
| `ctx` via deps parameter  | Adopter handlers, middleware, hooks     | **Preferred pattern.** JS closure captures `ctx` through any async chain the function authors.                                               |

The `readContext()` function exists as an escape hatch for places that
genuinely can't receive `ctx` as a parameter (top-level subscribers,
plugin hooks with fixed signatures). Most code should NOT use it —
receive `ctx` via deps and let closure semantics propagate it.

### Why no `runWithContext` (sync scoped-set)

Per ADR 45: `Effect.runSync(withContext(scope, Effect.sync(fn)))`
doesn't work — the nested `Effect.runSync(getContext)` inside `fn`
starts a fresh root fiber that doesn't inherit the outer's FiberRef.
Faithfully imitating v1's ALS-based `Context.run` would require
AsyncLocalStorage as a parallel substrate; this was explicitly
rejected (Node-tie, worker-thread caveat, cross-runtime portability
cost). Callers needing a scoped sync set should either:

- (a) Restructure to receive `ctx` via a deps parameter (closure
  capture handles propagation through any async work).
- (b) Enter Effect-land at the boundary:
  `Effect.runPromise(withContext(scope, eff))`.

See `docs/proposals/v2/blueprint/45-runtime-context-model.md` for the
full rationale.

---

## Effect fibers, forks, and lifetimes

Substrate code is Effect-typed end-to-end. Adopter code is typically
Promise-typed (with dual-shape support for adopters who want full
Effect power). Understanding how fibers compose is helpful for
anyone going into substrate-internal work or implementing custom
harnesses.

### Run-functions vs fork

| Function                 | Call site            | Creates                    | Inherits FiberRef?                         |
| ------------------------ | -------------------- | -------------------------- | ------------------------------------------ |
| `Effect.fork(eff)`       | Inside Effect        | CHILD fiber of caller      | **Yes** — child inherits parent's snapshot |
| `Effect.runFork(eff)`    | Raw JS (entry point) | ROOT fiber, returns handle | **No** — no parent to inherit from         |
| `Effect.runSync(eff)`    | Raw JS (entry point) | ROOT fiber, blocking       | **No** — fresh root fiber                  |
| `Effect.runPromise(eff)` | Raw JS (entry point) | ROOT fiber, async          | **No** — fresh root fiber                  |

**Discipline:**

- **Inside Effect, never call `runX`.** If you want to spawn child
  work, use `yield* eff` (same fiber) or `Effect.fork(eff)`
  (child fiber). Nested `runX` is almost always a bug — it silently
  loses FiberRef state.
- **At substrate edges (request entry, sync escape), use `runX`
  deliberately.** Match the run-function to your blocking needs:
  `runSync` if you need the result synchronously, `runPromise` for
  async, `runFork` for fire-and-forget with a handle.

### Lifetime models

Effect's structured concurrency gives us four fork shapes covering
the lifetime models the framework needs:

| Primitive                   | Lifetime                                                             | When to use                                                                                   |
| --------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Effect.fork(eff)`          | Tied to parent fiber. Parent dies → child interrupted.               | **Default.** Tool handler spawning concurrent sub-work that should die when the handler dies. |
| `Effect.forkScoped(eff)`    | Tied to a `Scope`. Scope finalizes → fiber interrupted.              | Resources managed within `Effect.scoped(...)` blocks.                                         |
| `Effect.forkIn(scope)(eff)` | Tied to an EXPLICIT scope you provide.                               | Adopter-managed lifetimes (`app.scope`, `gateway.scope`, etc.).                               |
| `Effect.forkDaemon(eff)`    | Detached from parent. Outlives parent. Only the runtime can kill it. | Long-running work that must survive its initiating session (background sync, deploy step).    |

**Cascading abort is the default** — `runOperation`'s body runs in a
fiber, and any work spawned inside via `yield*` or `Effect.fork` is
structured-concurrency-correct. When the parent op is interrupted
(timeout, user cancel, parent error), all child work is interrupted
too. `Effect.scoped(body)` around the body ensures resource cleanup
runs.

**Daemon fork breaks structured concurrency on purpose** — used when
work should outlive its initiating session. `Effect.forkDaemon` is
the v2 primitive for this; it has no clean analog in v1.

### How `runOperation` uses this

`BaseHarness.runOperation(op, body)` runs `body` in the calling
fiber's lineage. It reads ambient context (`yield* getContext`),
enriches it (sets `opId`, `parentOpId`), and scopes the body via
`withContext(enriched, ...)`. Nested `runOperation` calls compose:

```
outerHarness.runOperation(opA, body)
  yield* withContext(ctxA = {opId:"A", parentOpId:undef}, body):
    body() runs — calls innerHarness.runOperation(opB, ...)
      ambient = ctxA (inherited via FiberRef)
      yield* withContext(ctxB = {opId:"B", parentOpId:"A"}, innerBody):
        innerBody() — sees ctxB
      reverts to ctxA
    body resumes
  reverts to no scope
```

Same fiber throughout. FiberRef stacks via `Effect.locally`. Each
nested call enriches and scopes; reverts cleanly on exit.

**Cross-harness via the inbox** is different: when harness A sends a
message to harness B's inbox, B's handler runs in a DIFFERENT fiber
(spawned by the inbox dispatcher). FiberRef does not propagate across
the wire. Instead, the message envelope carries `scope` and
`correlationId` explicitly; B's `runOperation` reconstructs context
from the envelope. No FiberRef propagation expected; the envelope IS
the carrier.

---

## Runtime signals — `emitLog` / `emitProgress` (ADR 64)

`BaseHarness` exposes two protected helpers for the runtime signal
family — the shared emit seam behind `ctx.log` / `ctx.progress` and any
harness / loop that wants structured out-of-band diagnostics:

```ts
protected emitLog(scope, level, data, logger?): Effect<void, JournalError, never>
protected emitProgress(scope, p: ProgressEventPayload): Effect<void, JournalError, never>
```

Each builds one discrete envelope (`<surface>:signal:log` /
`:progress`, phase `terminal`, the `*EventPayload`, the caller's scope
plus the harness principal) and appends it to the bus. They are
**structurally bus-only** — they bypass `publish` / the journaling
policy and append straight to the bus, so signals are NEVER journaled
even though `terminal` is an `alwaysJournal` phase (routing diagnostic
spam into the recovery spine would bloat it for zero durability
benefit). A subscriber probe keeps the no-listener cost to one map
lookup. Fire-and-forget: callers launch them via `Effect.runFork`.

Consumers subscribe via the bus (the MCP-server projection, the
gateway→client projection). There is intentionally NO ambient global
`Context.log` — non-tool components that log ARE harnesses and emit via
these helpers (see `TODO(#19-ambient)`).

Verified by `src/__tests__/signals.spec.ts`.

## Lifting between Promise-land and Effect-land

Adopter code is typically `async (input, deps) => result`. Substrate
code is Effect-typed. The `liftToEffect` helper (re-exported from
`@agentick/utils-next`) is the type-shape bridge:

```ts
import { liftToEffect } from "@agentick/utils-next";

const fetchUser = async (id: string) => fetch(`/api/users/${id}`);
const fetchUserEff = liftToEffect(fetchUser);
// fetchUserEff: (id: string) => Effect.Effect<Response, unknown>

// Compose in Effect chains:
yield * fetchUserEff("42");
```

**Properties:**

- **Type-shape only.** Does NOT fork. The returned Effect is unrun
  until the caller composes it via `yield*` / `Effect.fork` / etc.
- **Lazy.** Uses `Effect.suspend` so `fn(args)` doesn't execute until
  the Effect runs (matches Effect convention; no side effects leak
  into construction).
- **Idempotent on Effect inputs.** If `fn` already returns an Effect,
  the lifted function passes it through unchanged (no double-wrap).
- **Does NOT bridge context into the Promise body.** If the wrapped
  Promise's body calls `readContext()`, it sees `EMPTY_CONTEXT` —
  the body is outside the fiber. Pass `ctx` to the function via deps
  and let closure capture handle propagation.

For surface-specific lifts that DO bridge context (`liftHandler` for
tool handlers — captures ctx from FiberRef + passes via deps), see
the owning package. The pattern, when needed:

```ts
import { Effect } from "effect";
import { getContext } from "@agentick/runtime-next";

const liftHandler =
  <I, D, E = unknown>(
    fn: (
      input: I,
      deps: D & { ctx: RuntimeContext },
    ) => Promise<readonly ContentBlock[]> | Effect.Effect<readonly ContentBlock[], E>,
  ) =>
  (input: I, depsBase: D) =>
    Effect.gen(function* () {
      const ctx = yield* getContext;
      const result = fn(input, { ...depsBase, ctx });
      if (Effect.isEffect(result)) return yield* result;
      return yield* Effect.tryPromise(() => Promise.resolve(result));
    });
```

The handler body has `ctx` in lexical scope via the deps parameter.
Async work inside the body captures it via JS closure — no
`readContext()` needed inside the handler.

## The edge bridges — `runHarnessProtocol` / `runHarnessStream`

The `.fx` dual-typed edge (ADR 77) is Effect-canonical; the Promise/AsyncStream
facades are DERIVED at the entity edge by these two bridges.

**`runHarnessProtocol(effect, runtime?)`** — Effect → Promise. Runs `effect`
to a settled `Exit` and normalizes it (typed failures re-thrown, defects
surfaced). The single `runPromise` boundary a harness facade crosses:

```ts
// A harness facade IS its `.fx` twin bridged once:
run(input: RunInput): Promise<ExecutorTerminal> {
  return runHarnessProtocol(this.runFx(input)); // fx.run minus the runPromise
}
```

Pass the optional `runtime` (an app-scoped `ManagedRuntime` built from a
telemetry `Layer`) to run the whole composed fiber on a real tracer — that is
how a `session.send` produces a **nested** span tree (see `@agentick/session-next`).

**`runHarnessStream(build, options?)`** — the streaming sibling, Effect →
`AsyncStream`. All the Queue / `forkDaemon` / iterator / result-Promise
machinery lives here ONCE; each streaming edge supplies only its sink-fold
`build` + policy hooks (`queueCapacity`, `isCancellation`, `onStart`,
`onAbort`, `runtime`). The executor's `executeStream` facade is
`runHarnessStream((sink) => this.executeStreamFx(input, sink), { … })`.

## Operation middleware — three tiers (ADR 76)

`runOperation` composes middleware around every operation body,
**outermost → innermost**:

```
tier 4 — call-scoped (FiberRef, broadest)
  → tier 3 — inherited construction-ancestors (root → parent)
    → tier 2 — this harness's own chain
      → before-verdict handlers (veto > replace > defer > proceed)
        → operation body
```

Within any one chain, first-registered is outermost. A `Middleware` wraps the
body: call `next(input)` to proceed, or return a value to short-circuit.

```ts
import type { Middleware } from "@agentick/runtime-next";

const timing: Middleware = (input, next) =>
  Effect.gen(function* () {
    const start = Date.now();
    const result = yield* next(input);
    // …record Date.now() - start…
    return result;
  });
```

### Two surfaces: `use` (pure-JS) and `fx.use` (Effect) — you do NOT need Effect

Middleware comes in two forms, registered through the **two surfaces every
harness already exposes** — the same facade/twin split as every operation
(`harness.use : harness.fx.use  ::  harness.run : harness.fx.run`):

- **`harness.use(mw)`** takes an **`AsyncMiddleware`** (pure JS) — `next(input)`
  returns a `Promise`; `await` it. No Effect knowledge required. The operation's
  `RuntimeContext` is handed to you as an explicit **third argument** (`ctx`),
  since an async middleware runs outside the fiber and can't read `getContext`.
- **`harness.fx.use(mw)`** takes an Effect-native **`Middleware`** — `next(input)`
  returns an Effect; composes IN the fiber. Telemetry span-nesting and structured
  interruption propagate through it.

```ts
// Pure-JS — the ergonomic form. `use` types the inline arrow cleanly.
harness.use(async (input, next, ctx) => {
  const start = Date.now();
  const result = await next(input);
  metrics.record(ctx.sessionId, ctx.opId, Date.now() - start);
  return result;
});

// Effect-native — for middleware that must stay in-fiber.
harness.fx.use((input, next) =>
  Effect.gen(function* () {
    const t0 = yield* Clock.currentTimeMillis;
    const result = yield* next(input);
    yield* recordSpan(Clock.currentTimeMillis - t0);
    return result;
  }),
);
```

Splitting the forms across the two surfaces is what lets EACH be a single type,
so an inline arrow infers its params cleanly — one overloaded `use` could not
(the async and Effect `next` contracts are incompatible, and the union kills
inline inference for both).

> **Honest caveat — an async middleware severs the fiber (span-nesting, not
> interruption).** `await next(input)` runs the inner ops on a forked root fiber,
> so the ADR 77 spine's in-fiber propagation stops AT it for **OTel span-parent
> nesting** — a span opened inside the wrapped ops will not nest under the
> middleware's op. Two things ARE re-threaded across the boundary: the captured
> `ctx` (so `parentOpId`, the causal tree, survives and traces stay
> reconstructable from attributes) and **interruption** (the lift forks the
> continuation and interrupts it when the outer op is aborted, so cancelling a
> `send` tears down the inner model/tool call instead of leaking a detached
> root). What you DON'T get from `use` is span-nesting and having the
> middleware's own body run in-fiber. That's *why* `ctx` is passed explicitly
> (you can't read a fiber you left) and why `fx.use` exists: use the Effect form
> when you need per-op spans that nest through the middleware. **Async =
> ergonomic (context + abort re-threaded); Effect = fully in-fiber.**

### Which surface — a use-case catalog

Reach for `use` (async) by default; drop to `fx.use` (Effect) only when the
middleware must stay _inside_ the fiber. Rule of thumb: **observe → `use`;
control the fiber → `fx.use`.**

| Use case                                        | Surface           | Why                                                             |
| ----------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| Timing / metrics / structured logging           | `use`             | Reads `ctx` (sessionId, opId, traceparent); severing is fine   |
| Auth / quota guard (short-circuit before `next`) | `use`             | Return a value without calling `next` — no fiber needed        |
| Retry with backoff around a flaky op             | `use`             | A `for` loop `await`ing `next` reads naturally in async JS     |
| Result rewriting / redaction after `next`        | `use`             | Pure transform of the awaited result                           |
| A per-op OTel span that **nests** under the op   | `fx.use`          | Span parent-linkage needs in-fiber propagation                 |
| A timeout / cancel that tears down **inner** work | `fx.use` / tier 4 | Structured interruption must cross into the wrapped ops         |
| Providing a scoped resource to inner ops         | `fx.use`          | FiberRef/Layer scoping only survives in-fiber                  |

```ts
// use — short-circuit guard (never calls next): the op never runs.
harness.use(async (input, next, ctx) => {
  if (!isAuthorized(ctx.user)) return denied(); // no next() → body skipped
  return next(input);
});

// use — retry: async control flow is exactly what async middleware is good at.
harness.use(async (input, next) => {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await next(input);
    } catch (err) {
      lastErr = err;
      await sleep(2 ** attempt * 50);
    }
  }
  throw lastErr;
});
```

**Tier 2 — per-instance** (`harness.use(mw)`): wraps that harness's own ops.
Returns an `Unsubscribe`.

**Tier 3 — structural inheritance:** a harness's effective stack is its
**construction-ancestors'** chains, root-outermost, wrapping its own. The app
is each session's construction parent, so `app.use(mw)` structurally wraps
every session op — deployment-global tracing / journaling / audit. The
before-verdict handlers inherit the same way (`app.on*()` reaches a descendant
op). Walked fresh per op (late registration honored); behavior-preserving when
no ancestor registered anything. The SHARED spine harnesses (loop / executor /
tool) are construction-_siblings_, not children — a session-scoped concern
around the model call is tier 4, not tier 3.

**Tier 4 — call-scoped** (`withCallMiddleware(mw, effect)`): the Effect-native,
dynamic-scope power. Scopes `mw` around every nested `runOperation` the effect
transitively reaches — **in ANY harness, across construction-siblings** — then
evaporates. Enabled by the ADR 77 spine: the call is one fiber, so a FiberRef
propagates the middleware list across boundaries. This is the _only_ correct
scope for per-request / per-session middleware around a _shared_ harness:

```ts
import { withCallMiddleware } from "@agentick/runtime-next";

// budgetCap wraps every op this send transitively reaches — the model call
// (executor) and each tool dispatch, though they're shared singletons — then
// is gone when the send settles. Nested calls accumulate (outer stays outermost).
yield * withCallMiddleware([budgetCap], loop.fx.runExecution(sendInput));
```

> **Full write-up:** [ADR 76 — Operation middleware scoping](../../docs/proposals/v2/blueprint/76-operation-middleware-scoping.md).

---

## See also

- `docs/proposals/v2/blueprint/45-runtime-context-model.md` — full
  design rationale (structural identity, closure-capture propagation,
  rejected alternatives)
- `docs/proposals/v2/blueprint/01-harness-principle.md` — the
  five-surface model `BaseHarness` implements
- `docs/proposals/v2/blueprint/19-foundation.md` — substrate
  foundations (journal / bus / inbox)
- ADR 43 — Unified `ToolHandlerCtx` (the deps shape `ctx` arrives
  through)
