# @agentick/runtime

**The in-process substrate every harness stands on.** A journal, an event bus, a message inbox, and `BaseHarness` — the class that composes the three into the operation grammar: a verb runs through a phase contract, emits envelopes, admits interceptors, and hands its handlers a `ctx`.

Two audiences read this page. **Adopters** come for `ctx` — the `log`/`trace`/`metrics`/`run`/`runner` facets every handler, hook, and guard receives — and for the telemetry switch. **Harness authors** come for `BaseHarness`, `command` / `commandStream`, and `deriveContext`. Sections say which.

This package is in-process only. Distribution ([@agentick/cluster](../cluster)) and durability (the store packages) implement the same [@agentick/spec](../spec) interfaces from the outside.

## Install

```bash
npm install @agentick/runtime
```

Subpath: `/testing` (stub + spy doubles, a branded test ctx).

## Quick start

You rarely construct anything from this package. What you reach for is the `ctx` that arrives at every seam — and the interceptor surface that lets you wrap any verb the framework runs:

```ts
// `use` registers an interceptor around every operation this harness — and
// every harness constructed beneath it — runs.
app.use(async (input, next, ctx) => {
  ctx.metrics.count("op.started", 1);
  const result = await ctx.trace("guarded-work", (span) => {
    span.setAttribute("session.present", ctx.sessionId !== undefined);
    return next(input);
  });
  ctx.log.info({ op: ctx.op, sessionId: ctx.sessionId });
  return result;
});
```

That middleware wraps **every operation the app and its sessions run** — the model call, each tool dispatch, each timeline append. No Effect import, no provider tree, no config file. `ctx.log` is live either way; `ctx.trace` and `ctx.metrics` become real once the [telemetry switch](#telemetry) is on, and are free no-ops until then.

## The substrate trio

Three implementations of three [@agentick/spec](../spec) protocols. Each is the default an unconfigured harness gets, and each is swappable at a slot.

| Implementation          | Protocol           | What it is                                                                                                                   |
| ----------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `MemoryJournal`         | `OperationJournal` | Bounded append-only ring with idempotency lookup and cursored reads. The recovery + audit record.                            |
| `LocalEventBus`         | `EventBus`         | Ring buffer with per-subscriber cursor pull, per-surface batching and retention, lazy fan-out. The observation stream.       |
| `LocalInbox`            | `MessageInbox`     | Address registry with per-`messageId` idempotency. `send` is fire-and-forget with an ack; `ask` awaits the handler's return. |
| `LocalChannelPublisher` | `ChannelPublisher` | Per-channel monotonic sequence over the bus, published through the subscriber-aware lazy path.                               |

The journal is what makes a completed operation replayable: a repeat invocation with the same `opId` returns the cached terminal instead of re-running the body. The bus is what makes it observable: `requested` → `before` → `delta*` → `terminal` envelopes, queryable by surface, name, phase, outcome, and scope.

Each is composable in one direction — **fan-in writes, isolated reads.** A child bus appends to its parent as well as locally; subscribers on the child see only local events. That is how a tenant- or session-scoped substrate nests inside an app-wide one without leaking:

```ts
import { LocalEventBus, MemoryJournal } from "@agentick/runtime";

const appBus = new LocalEventBus();
const sessionBus = new LocalEventBus({ parent: appBus }); // writes fan in, reads stay local
const journal = new MemoryJournal({ capacity: 50_000 });
void journal;
void sessionBus;
```

The `createFactory` form is the slot-shaped twin — `bus: LocalEventBus.createFactory()` on a harness defaults to fan-in against the parent's bus and registers its own close on the parent's teardown.

> [!NOTE]
> Substrate slots resolve **synchronously**: a harness passes them through `super(...)`, which cannot await. A factory that returns a Promise throws with a message pointing at instances instead.

## Declaring a harness

_Harness authors._ `BaseHarness` gives a subclass five surfaces: **commands** (the heavy path — phase contract, journaling, idempotency, interceptors), the **inbox** (`handleMessage` plus `onMessage` overrides), **lifecycle** (`onClose`, `ready`, `close`), **interceptors** (`use` / `guard` / `hook`), and **events** (`emit` / `emitDelta` and the signal helpers).

`command({ name, handler })` is the single declaration site for a non-streaming verb. One call registers the verb, mints its typed lifecycle hooks, makes it inbox-addressable, and returns the public Promise-shaped method:

```ts
import { Effect } from "effect";
import { HandlerError } from "@agentick/spec";
import type { MessageEnvelope, MessageHandlerError } from "@agentick/spec";
import { BaseHarness, LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

interface Credit {
  readonly amount: number;
}

// Opt the verb into typed hooks: one line, in the package that owns it.
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "ledger:credit": { input: Credit; output: number };
  }
}

class LedgerHarness extends BaseHarness<"ledger"> {
  private balance = 0;
  /** The declared verb, as a public method. */
  readonly credit: (input: Credit) => Promise<number>;

  constructor(id: string) {
    super("ledger", id, new MemoryJournal(), new LocalEventBus(), new LocalInbox());
    this.credit = this.command<Credit, number, never>({
      name: "ledger:credit", // must be prefixed with this harness's surface
      description: "add to the balance",
      scope: () => ({ sessionId: this.scopeId }),
      handler: ({ amount }) => Effect.sync(() => (this.balance += amount)),
    });
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error(`unknown: ${msg.type}`) }));
  }
}

const ledger = new LedgerHarness("acct-1");
await ledger.ready; // inbox registration settled — now addressable
await ledger.credit({ amount: 100 });
ledger.hooks.onBeforeLedgerCredit((input) => ({ amount: Math.min(input.amount, 50) }));
```

The name is load-bearing in four places at once: it is the inbox message type, the op-name root, the authz scope label, and (via `:` → `/`) the wire method. Declaring also enumerates the verb through `harness.commands()` and the `<surface>:commands` meta-verb, and validates an inbound payload against `input` exactly once — the wire never re-validates.

That meta-verb is what makes a declaration self-describing rather than something a client has to be told about: a remote caller asks `<surface>/commands` and gets back every declared verb with its `exposure`, so a harness mounted on a session announces its own capability. It is one of the two discovery doors — [@agentick/gateway](../gateway#discovery--two-doors) documents it alongside `_extensions/list`, which answers the different question of what the server registered.

Hook names are a total function of the verb: `on` + `Before|After` + PascalCase of the id. `ledger:credit` mints `onBeforeLedgerCredit` / `onAfterLedgerCredit` plus the bare `onLedgerCredit` full-middleware key. Only augmented verbs are typed keys, so a typo does not compile.

> [!IMPORTANT]
> Commands carry verbs plus serializable data only. An operation with a required function parameter must not be declared — give it a construction-bound default and declare the data-only signal form, keeping the function-arg variant as a plain method.

### `commandStream` — the streaming twin

`commandStream({ name, body })` is the second declaration site. It fuses the same registry registration and the same interceptor cascade with the async-iterator machinery, so there is no second interceptor path: `guard → onBefore(input) → body → onAfter(R)` fires at the stream's **start** and **terminal**, exactly as for a non-streaming command.

```ts
import { Effect } from "effect";
import { HandlerError } from "@agentick/spec";
import type { AsyncStream, MessageEnvelope, MessageHandlerError } from "@agentick/spec";
import { BaseHarness, LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

class TickerHarness extends BaseHarness<"ledger"> {
  readonly ticks: (input: { readonly n: number }) => AsyncStream<number, number>;

  constructor(id: string) {
    super("ledger", id, new MemoryJournal(), new LocalEventBus(), new LocalInbox());
    const cmd = this.commandStream<{ readonly n: number }, number, number, never>({
      name: "ledger:ticks",
      // `body` emits chunks as a side effect and returns the final result.
      body: (input, sink) =>
        Effect.gen(function* () {
          for (let i = 0; i < input.n; i++) yield* sink(i);
          return input.n;
        }),
      // Declaration-time per-chunk interception, closest to the body.
      chunk: [{ observe: (chunk) => void chunk }],
    });
    this.ticks = cmd.stream;
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error(`unknown: ${msg.type}`) }));
  }
}

const ticker = new TickerHarness("t1");
const stream = ticker.ticks({ n: 3 });
for await (const chunk of stream) console.log(chunk); // 0, 1, 2
console.log(await stream.result); // 3
```

The declaration yields three consumption faces over **one** run: `.stream` (the `AsyncStream` — `for await` the chunks, `await .result` for the return), `.fx` (the Effect-native sink-fold twin an in-fiber caller composes with `yield*`), and the registry `run` an inbox or remote caller reaches, which drives the same operation with a no-op sink and returns the drained result. Boundary hooks fire once, identically, on all three.

`stream.abort(reason)` interrupts the operation fiber. An aborted run publishes no `terminal:succeeded` and fires no `onAfter` with a bogus value — `.result` rejects with the interrupted cause.

### `on<Verb>Chunk` — per-chunk interception

Beyond the boundary hooks, a streaming verb mints an `on<Verb>Chunk` registrar and accepts a `def.chunk` list. Both take interceptors that **sink-wrap** the body's sink — they run between the body's emit and the downstream sink, so all three faces see the transformed chunks. Two kinds, shape-discriminated:

```ts
import type { ChunkInterceptor } from "@agentick/runtime";

// observe — a tap. Sees each chunk in order; cannot alter or drop it.
const meter: ChunkInterceptor<string> = { observe: (chunk) => void chunk.length };

// transform — a stateful map. Emit zero times to buffer, once to map, many to fan out.
const pairs: ChunkInterceptor<string> = (() => {
  let buf: string[] = [];
  return {
    onChunk: (chunk, emit) => {
      buf.push(chunk);
      if (buf.length === 2) {
        emit(buf.join(""));
        buf = [];
      }
    },
    // Runs ONCE at the terminal boundary — after the body's last emit, before
    // `onAfter` — so an N→1 coalescer never loses its tail.
    onFlush: (emit) => {
      if (buf.length > 0) emit(buf.join(""));
      buf = [];
    },
  };
})();
void [meter, pairs];
```

Interceptors compose in registration order into `body → i0 → i1 → … → sink`, with `def.chunk` entries closest to the body. `onFlush` is reached only on clean completion — an aborted body never returns, so no bogus tail escapes. With none registered the sink is not wrapped at all, and unregistering the last one restores the raw sink.

## `deriveContext` — the one branded boundary context

Every `ctx` the framework hands a seam is **derived from the invoking crossing's `RuntimeContext`** — never a bag fabricated from nothing. `deriveContext` is the single constructor: it copies the parent trunk, attaches the five lazy facet getters, and stamps a spec-private brand.

```ts
import { deriveContext } from "@agentick/runtime";
import type { ContextFacets, RuntimeContext } from "@agentick/runtime";

declare const parentTrunk: RuntimeContext;
declare const facets: ContextFacets;

// Off-fiber crossing (an inbound connection, a task submitted from plain JS):
// pass the parent trunk explicitly.
const ctx = deriveContext(parentTrunk, facets);
void ctx.sessionId;

// In-fiber Effect callers read the parent from the ambient FiberRef. A
// synchronous ambient read is the `readContext()` trap, so this form is
// Effect-native and yields.
const eff = deriveContext(facets);
void eff;
```

The brand is the enforcement point: a framework seam typed to accept a derived ctx rejects a hand-assembled object at compile time, while adopter handler signatures keep the plain interfaces (a branded value satisfies a plain one — zero adopter friction). Tests mint one with `deriveTestContext` from `/testing`.

A third argument composes a boundary's **own** fields into the same branded mint, and it is applied as property descriptors rather than a spread — so an extra defined as a live getter stays lazy instead of being forced at derivation. Precedence is facets ▸ extras ▸ trunk.

### `RuntimeContext` — the trunk

`RuntimeContext` is pure frozen data with zero runtime dependencies: the event-routing identity coordinates (`appId` / `sessionId` / `executionId` / `tickId` / `parentSessionId` / `spawnPath` / `nodeId` / `gatewayId`, plus every harness-augmented identifier such as `sandboxId`), the operation-level fields (`opId`, `parentOpId`, `op` — the current verb's Pascal suffix), diagnostic ephemera (`correlationId`, `traceparent`), and the adopter-augmentable `user` slot. The type lives in [@agentick/spec](../spec); this package owns the FiberRef propagation mechanism and re-exports the type.

`OperationCtx` is the composed boundary shape: the trunk intersected with the two facets. Every seam that receives diagnostics and the operation ladder — a tool handler's `ctx`, an interceptor ctx, a resource resolver, a prompt render — is that one type.

| Surface                   | Where                               | Behavior                                                                           |
| ------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| `ctx` via a parameter     | Handlers, middleware, hooks, guards | **The pattern.** JS closure capture carries it through any async chain you author. |
| `yield* getContext`       | Inside an Effect chain              | Effect-native read; correct within fiber lineage.                                  |
| `withContext(scope, eff)` | Inside an Effect chain              | Scoped overlay — inner wins on collision, reverts on Effect exit.                  |
| `readContext()`           | Outside an Effect chain (rare)      | Sync snapshot. Returns `EMPTY_CONTEXT` inside a fiber — see the gap below.         |

### Adopter extension via module augmentation

`RuntimeContextUser` is an empty seed. Type your own per-call ambient state onto it:

```ts
declare module "@agentick/spec" {
  interface RuntimeContextUser {
    readonly tenantId: string;
    readonly requestId?: string;
  }
}

app.use(async (input, next, ctx) => {
  ctx.log.with({ tenant: ctx.user?.tenantId }).debug({ op: ctx.op }); // typed
  return next(input);
});
```

> [!WARNING]
> The framework's auth-bearing primitives do **not** consult `ctx.user` for authorization. Principal-bearing resources encode the principal in their construction identity instead — a harness's `principal` is stamped authoritatively onto every event it emits and cannot be overridden per operation. Put `tenantId` in `ctx.user` for your own telemetry, branching, and logging; it is not a security boundary.

### Why there is no sync `runWithContext`

`Effect.runSync(withContext(scope, Effect.sync(fn)))` looks like it should work and does not: the nested `runSync` inside `fn` starts a fresh root fiber that does not inherit the outer's FiberRef. Reproducing a synchronous scoped set faithfully would mean carrying `AsyncLocalStorage` as a parallel substrate — a Node tie, a worker-thread caveat, and a cross-runtime portability cost. So it is not shipped. Two ways out: restructure to receive `ctx` as a parameter (closure capture handles any async work), or enter Effect at the boundary with `Effect.runPromise(withContext(scope, eff))`.

## The `ctx` facets

Five properties land flat on every ctx — the same spelling in a tool handler, an interceptor, a resource resolver, and the wire dispatch ctx. All five are lazy getters: nothing is built unless something touches it.

```ts
app.use(async (input, next, ctx) => {
  ctx.metrics.count("dispatch", 1, { tool: "search" }); // counter.add
  ctx.log.info({ starting: ctx.op }); // one bus event, level sugar over ctx.log(level, data)
  const rows = await ctx.trace("retrieval", async (span) => {
    span.setAttribute("attempt", 1);
    return next(input); // nested under the operation span
  });
  return rows;
});
```

**`ctx.log` is a callable object.** The verbatim form `ctx.log(level, data, logger?)` plus all eight RFC 5424 level methods (`debug` / `info` / `notice` / `warning` / `error` / `critical` / `alert` / `emergency`, with `warn` an alias that emits the canonical `"warning"`) plus `ctx.log.with(fields)` for pino-style child binding — every form collapsing to **one** bus event. It is always live, independent of the telemetry switch, and stamps the active `traceId`/`spanId` onto each event so logs join their span in the backend. Bound fields merge into the payload; a non-object payload is wrapped as `{ ...bound, msg: data }`.

**`ctx.metrics`** has three verbs: `count` (monotonic counter), `record` (histogram), `gauge` (last-value, not a sum and not a delta). Labels must stay low-cardinality — the framework's own defaults are bounded (tool name, op suffix) and high-cardinality identity rides spans and logs instead.

**`ctx.trace`** opens a named child span nested under the current operation span and returns your function's result. It is span-only: no journal, no hooks, no guards.

### The `run` / `runner` ladder

Climb by how much the system should know about the work.

| Rung         | Call                      | You get                                                                                               | Climb when                                                    |
| ------------ | ------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1 · count it | `ctx.metrics.count(name)` | A tally                                                                                               | You only need "how many"                                      |
| 2 · see it   | `ctx.trace(name, fn)`     | A span — timing and attribution, **no** journal/hooks/guards                                          | A sub-span inside a handler's own work (a retrieval, a parse) |
| 3 · run it   | `ctx.run(name, fn)`       | A real operation: journal envelope, the inherited interceptor fold, outcome taxonomy, a parented span | The step deserves a durable record and guard/hook reach       |
| 4 · name it  | A registered command      | Typed input/output, typed `onBefore/After<Verb>` hooks, inbox addressability, wire grantability       | The verb is part of the system's contract                     |

```ts
app.use(async (input, next, ctx) => {
  const audited = await ctx.run("audit", { input: { op: ctx.op } }, () => Promise.resolve(true));
  void audited;
  return next(input);
});
```

`ctx.run` mints `<surface>:run:<name>` — journaled, guard-vetoable, and hook-observable through the string-keyed generic tier — with its span parented under the enclosing op by the same mechanism `ctx.trace` uses. One parenting path for `trace` spans, `run` spans, and command spans alike.

> [!IMPORTANT]
> **Journaled is not memoized.** `ctx.run` writes a durable _observational_ record — name, timing, input, outcome — not a resumable checkpoint. Adopters arriving from Restate or Inngest will assume `run` skips a completed step on retry: it does not. Re-invoking re-runs the function.

`ctx.run`'s options are frozen-small on purpose (`input`, `metadata`, `spanAttributes`, `signal` — envelope data, never behavior). If it took the full command suite it would collapse rung 4 into rung 3. When you need more, `ctx.runner.runOperation(op, body)` is the primitive undiluted, exposed as a **run-only view** — never the harness's lifecycle or event emission, so handler code cannot tear down or reconfigure it.

## Interceptors — one primitive, three kinds, four tiers

Every declared verb runs through `runOperation`, which composes **one** interceptor list around the body. There is exactly one primitive — the wrapping middleware `(input, next, ctx) => output`. Everything at the operation boundary is a kind of it, or sugar over it.

| Kind        | Intent                            | Surface                                                             |
| ----------- | --------------------------------- | ------------------------------------------------------------------- |
| `guard`     | Admission control before the body | `harness.guard(decide)` — or a `guards: {}` bag                     |
| `transform` | Reshape input or output           | `harness.use` / `harness.fx.use`; **hooks** are keyed sugar over it |
| `observe`   | Pure side effect                  | A `use` middleware that reads and returns `next(...)`               |

### Two surfaces: `use` and `fx.use`

`harness.use(mw)` takes a pure-JS async middleware — `await next(input)`, no Effect knowledge required, with the operation's ctx handed over as an explicit third argument. `harness.fx.use(mw)` takes the Effect-native form and composes in-fiber. Splitting them across two surfaces is what lets each be a single type, so an inline arrow infers its parameters cleanly.

```ts
import { Clock, Effect } from "effect";

// Pure JS — the default. Short-circuit by not calling next().
app.use(async (input, next, ctx) => {
  if (ctx.user?.tenantId === undefined) return { denied: true };
  return next(input);
});

// Retry: async control flow is exactly what an async middleware is good at.
app.use(async (input, next) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await next(input);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
});

// Effect-native — when the middleware's OWN body must stay in-fiber.
app.fx.use((input, next) =>
  Effect.gen(function* () {
    const t0 = yield* Clock.currentTimeMillis;
    const result = yield* next(input);
    const elapsed = (yield* Clock.currentTimeMillis) - t0;
    void elapsed;
    return result;
  }),
);
```

> [!NOTE]
> **Only the async middleware's own body is off-fiber; everything it wraps is fully in-fiber.** The lift forks each continuation on the _ambient_ runtime — the fiber's Context, FiberRefs, and tracer — so span nesting, `parentOpId`, call-scoped middleware, and interruption all survive the `await` (aborting a send really does tear down the in-flight model or tool call). The one thing that stays off-fiber is the JS statements around `await next`, which is precisely why `ctx` is passed explicitly. Reach for `fx.use` only when the middleware's own logic must be interruptible or must establish fiber scope.

### Guards

A guard decides `proceed | veto | replace | defer` before the body. The decider returns a verdict — or `void`, meaning proceed — sync or async:

```ts
app.guard((input, ctx) =>
  ctx.user?.tenantId === undefined ? { kind: "veto", reason: "no tenant" } : undefined,
);
```

A non-`proceed` verdict is desugared into a typed control signal the guard raises; `runOperation` catches it and maps it to the matching terminal (`vetoed` and `deferred` fail with `OperationOutcomeError`; `replaced` succeeds with the supplied result). Guards are floated **outermost** by a stable sort, so a retry or transform middleware registered first still cannot swallow a raised veto. With several guards, precedence is compose order — the outermost non-`proceed` wins. `harness.listInterceptors(op)` enumerates the composed kinds.

> [!IMPORTANT]
> `guard : operation :: gate : loop`. This seam is operation admission. It is not [@agentick/gates](../gates), which is loop continuation — a different concept at a different scope.

### Hooks are op-scoped middleware

There is no separate hooks subsystem. A hook registers as a `transform` middleware on the one chain and self-scopes by comparing `ctx.op`, so hooks inherit through exactly the same path as guards and `use` middleware. `on<Verb>` is the primitive (the full typed middleware for one verb); `onBefore<Verb>` / `onAfter<Verb>` are one-sided sugar over it. A hook returns a value to transform, returns `void` to observe, and throws to veto.

```ts
import { createApp } from "@agentick/app";

// Declarative, at construction — the bags fold down the construction tree.
const app2 = await createApp(Agent, {
  compiler: reactCompiler(), // from @agentick/compiler-react
  model,
  hooks: { onBeforeLedgerCredit: (input) => ({ amount: Math.min(input.amount, 50) }) },
  guards: { ledgerCredit: (input) => (input.amount < 0 ? { kind: "veto" } : undefined) },
});

// Imperative, returning an Unsubscribe.
const off = app2.hook({ onAfterLedgerCredit: (output) => output });
app2.hooks.onLedgerCredit((input, next) => next(input)); // the full typed middleware
off();
```

Hooks **compose, they never override**: two registered layers both fire, outer bracketing inner.

### Where each tier wraps

```
guard-outermost, then broadest → innermost:
tier 4 — call-scoped (FiberRef, the whole dynamic call tree)
  → tier 3 — inherited from construction ancestors
    → tier 2 — this harness's own chain (guards + transforms + hooks)
      → the operation body
```

**Tier 2 — per instance.** `harness.use` / `.guard` / `.hook` wrap that harness's own operations. Within one chain, first-registered is outermost.

**Tier 3 — structural inheritance, live.** A harness's effective stack is its construction ancestors' chains wrapping its own, root-outermost. The app is each session's construction parent, so `app.use(mw)` wraps every session operation — deployment-wide tracing, journaling, audit. The relation is live in both directions: a new descendant pull-seeds the current set at construction, a registration made on an ancestor **afterwards** pushes down into already-constructed children and grandchildren, and the ancestor's `Unsubscribe` cascades the removal back out.

**Tier 4 — call-scoped.** `withCallMiddleware(mw, effect)` scopes middleware around every nested operation the effect transitively reaches — **in any harness, across construction siblings** — then evaporates. The shared spine harnesses (loop, executor, tool) are construction _siblings_, not children, so a per-request concern around the model call is tier 4, not tier 3. Nested calls accumulate, outer staying outermost.

```ts
import { Effect } from "effect";
import { withCallMiddleware, type Middleware } from "@agentick/runtime";

declare const budgetCap: Middleware<unknown, unknown, unknown>;
declare const sendEffect: Effect.Effect<void>;

// budgetCap wraps the model call and every tool dispatch this send reaches —
// shared singletons included — then is gone when the send settles.
const scoped = withCallMiddleware([budgetCap], sendEffect);
void scoped;
```

## Namespace slots

_Harness authors._ A package contributes its own front door. There is no privileged list anywhere: `createApp({ timeline })` does not exist because `@agentick/app` wrote `timeline?:` into an options interface — it exists because [@agentick/timeline](../timeline), a package the app never imports, augments an empty seed for the type and registers the name for the runtime.

```ts
import { registerNamespaceSlot } from "@agentick/runtime";

// Your package's own types — the definition it accepts and the protocol it exposes.
interface LedgerConfig {
  readonly startingBalance?: number;
}
interface LedgerProtocol {
  balance(): number;
}

declare module "@agentick/spec" {
  // The top-level config slot: createApp({ ledger: defineLedger({ … }) }).
  interface NamespaceSlots {
    readonly ledger?: LedgerConfig;
  }
  // The bridge namespace — what useBridges().ledger and the internal plumbing see.
  interface HookBridges {
    readonly ledger?: LedgerProtocol;
  }
  // The handler-ctx namespace — what ctx.ledger resolves to at dispatch.
  interface ToolHandlerCtxExtensions {
    readonly ledger?: LedgerProtocol;
  }
  // The session-facing handle — session.ledger.
  interface SessionHarnessProtocol<P> {
    readonly ledger?: LedgerProtocol;
  }
}

// The runtime half: tells the app that `ledger` is a config key to forward,
// without the app importing this package. Idempotent — a double import is safe.
registerNamespaceSlot("ledger");
```

Import the package and the slot lights up. The app reads `collectNamespaceSlots(options)` and forwards each present slot to the layer that owns that namespace, carrying it as `unknown` — the app never inspects a definition's shape. That is what keeps bundled and optional packages uniform: the metapackage bundles the built-ins so their slots are always lit, and an optional package's slot lights up on install plus import. `extensions: []` remains the fully dynamic escape hatch for runtime-built or conditional installs.

## Runtime signals

`emitLog` and `emitProgress` are the two protected helpers behind `ctx.log` and `ctx.progress`, available to any harness or loop that wants structured out-of-band diagnostics:

```
protected emitLog(scope, level, data, logger?, trace?): Effect<void, JournalError, never>
protected emitProgress(scope, payload): Effect<void, JournalError, never>
```

Each builds one discrete envelope — `<surface>:signal:log` or `:progress`, phase `terminal`, the caller's scope plus the harness principal — and appends it **straight to the bus**. Signals are structurally bus-only: they bypass the journaling policy entirely, so diagnostic volume never lands in the recovery spine even though `terminal` is otherwise an always-journal phase. A subscriber probe keeps the no-listener cost to one map lookup. Consumers subscribe on the bus — that is how the MCP server projects `notifications/message` and the gateway projects to clients.

There is deliberately no ambient global logger. Non-tool components that log **are** harnesses, and they emit through these two helpers.

## Promise ↔ Effect

Substrate code is Effect-typed end to end; adopter code is typically Promise-typed. Three bridges cross the boundary, and each is a one-liner at the edge.

`liftToEffect` (from [@agentick/utils](../utils)) is the type-shape lift: lazy via `Effect.suspend`, idempotent on Effect inputs, and it does **not** fork. It also does not bridge context into the Promise body — pass `ctx` as a parameter and let closure capture do the work.

`runHarnessProtocol(effect, runtime?)` is Effect → Promise: it runs to a settled `Exit` and normalizes it, so the body's own typed error is the rejection reason and `instanceof` / `_tag` checks still hold downstream. It is the single `runPromise` boundary a harness facade crosses. Pass the optional app-scoped runtime to run the composed fiber on a real tracer — that is how one `send` produces a nested span tree. `runHarnessProtocolOn(runtime, effect)` is the trunk-preserving sibling for a Promise-shaped boundary that sits _inside_ an operation: it runs on a runtime captured in-fiber, so the operation inherits the enclosing trunk instead of becoming an orphaned root.

`runHarnessStream(build, options?)` is the streaming sibling. All the queue, daemon-fork, iterator, and result-Promise machinery lives here once; each streaming edge supplies only its sink-fold plus a little policy (`queueCapacity` for backpressure depth, `isCancellation` to distinguish a clean cancel from a real failure, `onStart` / `onAbort`, `runtime`). `commandStream` is what you should reach for first — it wires this bridge to a declared verb for you.

Inside Effect, never call a `runX`: use `yield*` for the same fiber or `Effect.fork` for a child. A nested `runX` silently loses FiberRef state. At a genuine edge, pick the run function that matches your blocking need. For lifetimes: `Effect.fork` (dies with the parent — the default), `Effect.forkScoped` / `Effect.forkIn(scope)` (tied to a scope you name), `Effect.forkDaemon` (outlives the parent, for work that must survive its initiating session).

## Telemetry

Every operation already runs inside a span — `runOperation` wraps each body in `Effect.withSpan`. Telemetry here is **enrichment of those spans**, riding the same interceptor cascade as everything else. It is strictly opt-in.

### The one switch

```ts
import { createApp } from "@agentick/app";

const app3 = await createApp(Agent, {
  compiler: reactCompiler(), // from @agentick/compiler-react
  model,
  name: "triage-bot",
  telemetry: true, // the whole switch
});
void app3;
```

That is all. With the switch on you get, on every span the run touches: `agentick.app.name`; `agentick.function.id` (defaulted to the app name, so a single-purpose app has function-level traces with no extra config — override per send with `session.send({ telemetry: { functionId } })`); model, tool, tick, and session identity (`gen_ai.request.model`, `gen_ai.system`, `agentick.tool.name`, `agentick.tick.index`, `agentick.session_id`); and token usage plus cost on model terminals (`gen_ai.usage.input_tokens` / `output_tokens`, `gen_ai.response.finish_reason`, `agentick.usage.cost_usd` — absent for un-priced models, never a fabricated zero).

Three altitudes, and you pick by _when you know the value_:

| Altitude    | Seam                                            | Known                       |
| ----------- | ----------------------------------------------- | --------------------------- |
| per call    | `session.send({ telemetry: { metadata } })`     | At send time                |
| per op type | `harness.fx.use(spanAttributes(fn))`            | At registration, from input |
| per moment  | `yield* annotateOperationSpan(attrs)` in a body | Mid-execution, computed     |

```ts
import { Effect } from "effect";
import { annotateOperationSpan, spanAttributes, spanMiddleware } from "@agentick/runtime";

// per moment — in-fiber, anywhere: a command body, an Effect-native interceptor.
const body = Effect.gen(function* () {
  yield* annotateOperationSpan({ "acme.cache_hit": true });
});
void body;

// per op type — attributes computed from the op's input.
app.fx.use(spanAttributes((input) => ({ "acme.size": JSON.stringify(input).length })));

// a named CHILD span carved out of a body's work — and a lease you can release.
const stop = app.fx.use(spanMiddleware("acme.retrieval", () => ({ "acme.debug": true })));
stop();
```

The attribute bag is an open record at every seam, so a new dimension is a new key — never a framework change and never a release.

### The attribute-key naming rule

- Keys are **dot-separated, never colon** — colons appear only in span and operation _names_ (`model:command:generate`).
- Where the OTel GenAI semantic conventions define a key, it is used **verbatim** (`gen_ai.request.model`, `gen_ai.system`, `gen_ai.usage.*`, `gen_ai.response.finish_reason`; `service.name` for the resource). Vendor LLM dashboards recognize these automatically — that is the payoff, so they are never whitelabeled.
- Framework keys live under `${telemetryNamespace}.*`, default `agentick.*`. One knob renames the whole spine: `createApp({ telemetryNamespace: "acme" })` yields `acme.op_id`, and the `gen_ai.*` standards stay put.
- Your own ad-hoc keys are yours. The convention above is a recommendation, not a gate.

### Off is free

Omit `telemetry` (or pass `false`) and **no interceptors are registered**, the per-send seam short-circuits to a pass-through, and no runtime is built. `ctx.trace` and `ctx.metrics` collapse to process-global frozen singletons — `OFF_TRACE` and `NOOP_METRICS`, referentially identical across every ctx, zero per-operation allocation. `ctx.log` stays live regardless: emitting a bus event is always possible, and whether anything projects it is the subscriber's concern.

### Exporting

The framework bundles no OpenTelemetry dependency and adds no proprietary layer between you and OTel. Enrichment annotates spans; where they _go_ is standard OTel wiring you hand the app:

```ts
import { createTelemetry } from "@agentick/app";
import { otlpSink } from "@agentick/telemetry-otlp";

// Hand the result to `createApp({ telemetry })`.
const telemetry = createTelemetry(
  { serviceName: "triage-bot", attributes: { "deploy.region": "us-east" } },
  otlpSink({ endpoint: "http://localhost:4318" }),
);
void telemetry;
```

A sink is just a bag of standard OTel objects, so a raw literal is a valid one: `{ spanProcessor: new BatchSpanProcessor(exporter) }`, or `metricReader` for the metrics half — `createTelemetry` concatenates processors and readers across every sink you pass. Sampling, filtering, and batching stay expressed as the OTel objects you already know; the framework wraps nothing around them. An Effect `layer` is accepted as the substrate-native escape hatch and composes additively. [@agentick/telemetry-otlp](../telemetry-otlp) ships `otlpSink()` for the common case, and env-driven autodiscovery fires only when `OTEL_EXPORTER_OTLP_ENDPOINT` is explicitly set — a deliberate divergence from the SDK's silent-localhost default.

## API

### `@agentick/runtime`

| Export                                                                         | Purpose                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `MemoryJournal` · `LocalEventBus` · `LocalInbox`                               | The substrate trio; each with a `createFactory()` slot form                           |
| `LocalChannelPublisher`                                                        | Sequenced channel publication over a bus                                              |
| `BaseHarness`                                                                  | The inheritance point: commands, inbox, lifecycle, interceptors, events               |
| `inheritedFrom(installer)`                                                     | Recover typed interceptor-inheritance options from an installer handle                |
| `deriveContext(...)` / `ContextFacets`                                         | The one branded boundary-ctx constructor                                              |
| `getContext` · `withContext` · `readContext` · `EMPTY_CONTEXT`                 | Trunk propagation (`RuntimeContextRef` is the FiberRef behind them)                   |
| `withCallMiddleware(mw, eff)`                                                  | Tier-4 call-scoped interceptors                                                       |
| `composeMiddleware` · `MiddlewareChain` · `liftMiddleware`                     | Composition primitives (`liftMiddleware` lifts async → Effect on the ambient runtime) |
| `tagInterceptor` · `interceptorKind` · `orderInterceptors`                     | Interceptor kinds and the guard-outermost sort                                        |
| `OperationVeto` · `OperationDefer` · `OperationReplace`                        | The control signals a guard raises                                                    |
| `signalFromVerdict` · `isOperationSignal` · `OperationOutcomeError`            | Verdict desugaring and the non-success terminal error                                 |
| `hooksToMiddlewares` · `guardsToMiddlewares` · `commandGuardMiddleware`        | Declarative bags → op-scoped interceptors                                             |
| `qualifyNamespaceHooks` · `qualifyNamespaceGuards`                             | Bare-verb definition bags → discriminated command keys                                |
| `deriveHookNames` · `deriveChunkHookName` · `scopeToCommand`                   | Hook-name derivation and op-scoping                                                   |
| `annotateOperationSpan` · `spanAttributes` · `spanMiddleware`                  | The three span-enrichment seams                                                       |
| `runHarnessProtocol` · `runHarnessProtocolOn` · `runHarnessStream`             | The Effect → Promise / AsyncStream edge bridges                                       |
| `createOperationRunner` · `createCommandRunner`                                | The two engines `BaseHarness` composes (journaling/phases; registry/manufacture)      |
| `registerNamespaceSlot` · `registeredNamespaceSlots` · `collectNamespaceSlots` | The namespace-slot registry                                                           |
| `deriveObservability` · `deriveOps`                                            | The facet derivers (`deriveContext` is their sole caller)                             |
| `NOOP_SPAN` · `OFF_TRACE` · `NOOP_METRICS`                                     | The off-path singletons                                                               |
| `RequestResponseRegistry`                                                      | Correlated request/response bookkeeping behind `harness.request`                      |
| `busAsyncIterator` · `forkBusSubscription`                                     | Bus → `AsyncIterator` / callback, with per-event error isolation                      |
| `matchesQuery` · `compileQuery`                                                | The `EventQuery` predicate, interpreted or pre-compiled                               |
| `resolveSyncSubstrateSlot` · `ulid`                                            | Slot resolution (instance \| factory) and the id generator                            |
| `SESSION_ESCALATION_MESSAGE_TYPE` · `SESSION_TASK_WAKE_MESSAGE_TYPE`           | Substrate wire constants for escalation and task-wake                                 |

Key types: `Middleware` · `AsyncMiddleware` · `InterceptorKind` · `CommandRegistry` · `CommandHooks` · `CommandGuards` · `NamespaceHooks` · `NamespaceGuards` · `HookRegistrars` · `ChunkInterceptor` · `ChunkObserver` · `ChunkTransform` · `GuardDecider` · `RuntimeContext` · `RuntimeContextUser` · `AsyncStream` · `TelemetryProvider` · `MetricSink` · `BaseHarnessOptions` · `HarnessShell` · `HarnessFx` · `OperationRunner` · `CommandRunner` · `CommandDef` · `StreamCommandDef` · `Unsubscribe`.

### `BaseHarness` surfaces

| Member                                              | Visibility | Purpose                                                              |
| --------------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| `use(mw)` / `fx.use(mw)`                            | public     | Register an async / Effect-native interceptor; returns `Unsubscribe` |
| `guard(decide)` / `guard(bag)`                      | public     | Admission control, per harness or per named verb                     |
| `hook(config)` / `hooks.on<Verb>(fn)`               | public     | Command lifecycle hooks, declaratively or per verb                   |
| `listInterceptors(op)`                              | public     | Enumerate the composed kinds, outermost first                        |
| `onMessage(type, handler)`                          | public     | Add or override inbox handling for one message type                  |
| `commands()`                                        | public     | Wire-safe summaries of the declared verbs                            |
| `address` · `principal` · `metadata` · `input`      | public     | Construction identity                                                |
| `ready` · `onClose(h)` · `close()`                  | public     | Lifecycle — `ready` settles once inbox registration lands            |
| `command(def)` / `commandStream(def)`               | protected  | The two declaration sites                                            |
| `commandEffect(name, input)`                        | protected  | Invoke a declared verb in-fiber so causality threads                 |
| `runOperation(op, body)`                            | protected  | The heavy path directly, for a verb that is not a declared command   |
| `emit` / `emitLazy` / `emitDelta` / `emitDeltaLazy` | protected  | The light path; the lazy forms skip construction with no subscriber  |
| `emitLog` / `emitProgress`                          | protected  | The runtime signal family                                            |
| `request` / `notifyChannel` / `pendingRequests`     | protected  | Correlated ask, one-way notify, and the projectable pending set      |
| `spanAttributes(op)`                                | protected  | Override to add domain attributes to every operation span            |
| `handleMessage(msg)`                                | abstract   | The subclass's typed inbox switch                                    |

### `@agentick/runtime/testing`

| Export                                | Purpose                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `stubInbox(options?)`                 | Canned replies keyed by type or address, with `asks` / `sends` recorded      |
| `spyTelemetryProvider()`              | Recording tracer Layer + `MetricSink`; asserts spans (with parent) + metrics |
| `spyTelemetrySink()`                  | Recording OTel `SpanProcessor` + `MetricReader` — the full export path       |
| `deriveTestContext(parent?, facets?)` | A branded ctx for tests; `ctx.run` throws until you wire a runner            |

The **fakes** are the production in-memory implementations themselves — import `LocalInbox` / `LocalEventBus` / `MemoryJournal` from the package root for real routing and real semantics. This subpath is the stub/spy tier.

## Patterns

**Every harness.** [@agentick/timeline](../timeline), [@agentick/knobs](../knobs), [@agentick/tool-executor](../tool-executor), [@agentick/session](../session), [@agentick/gateway](../gateway) and the rest all extend `BaseHarness` and declare their verbs with `command`. The layout is uniform whether a package is bundled or installed separately.

**Protocols and shapes.** [@agentick/spec](../spec) owns `OperationJournal`, `EventBus`, `MessageInbox`, `RuntimeContext`, `OperationCtx`, `Observability`, `Ops`, and the hook-derivation generics. `@agentick/spec-conformance` certifies an alternate substrate implementation.

**Composition at the top.** [@agentick/app](../app) wires the switch, the interceptor cascade, and the shared spine; [@agentick/session](../session) is each session's construction child, which is why `app.use` reaches every session operation.

**Utilities.** [@agentick/utils](../utils) owns `liftToEffect`, `unwrapExit`, `omitUndefined`, `isEqual`, `waitFor`, and the scope matchers this package composes.

## Roadmap & known gaps

- **`readContext()` is honest, not magic.** It returns `EMPTY_CONTEXT` inside an Effect fiber (the nested-`runSync` gap) and inside a Promise continuation an Effect is awaiting. It exists for top-level subscribers and fixed-signature plugin hooks; everything else should receive `ctx` as a parameter.
- **No sync scoped set.** There is no `runWithContext`, and there will not be one without an `AsyncLocalStorage` substrate that was deliberately rejected.
- **`ctx.run` has no replay story.** The journal shape does not preclude one; none is built. Durable kill/resume rides the store protocols.
- **Chunk interceptors are harness-local.** They do not inherit down the construction tree, and a declarative session-config `onXChunk` is not folded through the hook path. Session-scoped chunk interception is future work.
- **Namespace slots carry a name only.** The app forwards the value to the layer that owns the namespace; a slot for an _extension-installed_ namespace still needs `extensions: []` until the `toExtension` arm lands, which waits on enough consumers to pin its shape.
- **Concurrent sibling `ctx.trace` bodies can cross-attribute a log.** The active-span reference is facet-scoped mutable state; sequential and nested use is exact, two racing siblings in one dispatch may not be.
- **`LocalEventBus` retention enforces `maxEvents`, not `maxAge`.** Time-based eviction is specified but not implemented; eviction is O(N) on the breaching surface's appends.
- **`ctx.metrics.gauge` is last-value only.** There is no up/down-counter verb for deltas.
- **Signals are bus-only by construction.** If you want a log or progress record in the durable journal, emit it as an operation (`ctx.run`) instead — the policy is not flippable per harness.
- **In-process only.** Cluster routing and durable journals/stores are separate packages implementing the same protocols; nothing here persists across a process restart.

## Verified by

- `src/__tests__/base-harness.spec.ts` — the phase contract (`requested` → `terminal`), idempotent replay on a repeated `opId`, the FiberRef trunk visible to body Effects, verdict outcomes, outer-wraps-inner middleware composition, the `onMessage` precedence chain (including that `request-response` auto-intercept always wins), and the `.fx` twins composing into one fiber tree.
- `src/__tests__/base-harness.spec.ts` (fiber-propagation block) + `call-middleware.spec.ts` — the async-middleware caveat, pinned: a span opened in the body nests under the op span _through_ an async `use`, the continuation still reads the op's trunk after the fork, a tier-4 middleware still wraps a nested op reached through it, interruption tears down the wrapped call, short-circuit and multi-`next` retry both behave, and tier 4 crosses construction siblings then evaporates.
- `src/__tests__/structural-middleware.spec.ts` — tier-3 live inheritance: pull-seed at construction, push to an already-built child and grandchild on late registration (including a late ancestor guard's veto), unsubscribe cascading to all descendants, and a closed child receiving no further pushes.
- `src/__tests__/guard-ordering.spec.ts` — deny-before-transform, including a broad ancestor guard beating a narrow descendant transform registered first, non-destructiveness on `proceed`, and the enumerable interceptor list.
- `src/__tests__/command-registry.spec.ts` + `command-runner.spec.ts` — declaration rules (surface prefix, duplicates across both declaration sites), operation manufacture and deterministic `opId`, inbox addressability with origin stamping and envelope causality, typed `InvalidPayload` with no operation run, `exposure: "internal"` non-addressability, and the `<surface>:commands` meta-verb.
- `src/__tests__/command-stream.spec.ts` — boundary hooks bracketing the chunks, one terminal carrying the final result, the `.fx` sink-fold twin firing the same cascade, a guard vetoing before any chunk, the async-iterator contract, abort with no `onAfter` and no `terminal:succeeded`, the registry drain, per-chunk observe/transform/coalesce, flush-on-terminal ordering before `onAfter`, no flush on abort, and zero overhead with none registered.
- `src/__tests__/command-hooks.spec.ts` + `hook-lifecycle-names.spec.ts` + `wire-command-hooks.type.spec.ts` — the name derivation locked to its type-level twin (colon, slash, kebab, and underscore forms), transform/observe/veto contracts, op-scoping by `ctx.op`, compose-not-override with onion ordering, fiber preservation through an awaiting hook, the dynamic `hook()` + `hooks` proxy, the `on<Verb>` full-middleware primitive, and no `any` leakage on the derived surface.
- `src/__tests__/operation-runner.spec.ts` — phases, replay of both succeeded and failed terminals, the original error re-raised on failure, signal → terminal mapping for all three non-`proceed` verdicts, authoritative principal stamping, auto-threaded `parentOpId`, and the light-path helpers.
- `src/__tests__/derive-context.spec.ts` + `ctx-brand.type.spec.ts` — the explicit-parent and ambient overloads, off-path singletons by referential identity, facets attached, `ctx.run` routing through the supplied runner, and — at compile time — a hand-assembled bag rejected at a brand-demanding seam while extras compose _into_ the brand.
- `src/__tests__/interceptor-ctx-facets.spec.ts` — all five facets flat on the middleware ctx, a hook's `ctx.trace` span parented under the op span, `adoptTelemetry` late-binding a provider (before it, no meter; after, the sink sees `{ op }`), and `ctx.run` from a middleware minting a journaled op parented under the enclosing one.
- `src/__tests__/observability.spec.ts` — the callable `Log` (call form, level sugar, `.with`), no trace ids stamped off the telemetry path, live child-span parenting, the log↔span correlation join (op span outside a trace, child span inside it), and metric namespacing with low-cardinality defaults overridden per call.
- `src/__tests__/signals.spec.ts` — one canonical `<surface>:signal:log` / `:progress` envelope with its payload and scope, the harness principal stamped, structurally bus-only (a control ping _is_ journaled, a signal is not), the no-subscriber probe, and cross-surface signal queries that never cross-match log with progress.
- `src/__tests__/span-helpers.spec.ts` — `annotateOperationSpan` from inside a body, `spanAttributes` via `fx.use` with unsubscribe as a lease, and `spanMiddleware(name)` opening a named child nested under the op.
- `src/__tests__/namespace-slots.spec.ts` — registration idempotence under a double import, projection of only the registered and present slots, explicit-`undefined` treated as absent, and nothing forwarded for an unregistered key.
- `src/__tests__/memory-journal.spec.ts` + `local-event-bus.spec.ts` + `local-event-bus-batching.spec.ts` + `local-inbox.spec.ts` — the spec conformance suites, plus capacity overflow with idempotency-key eviction, the cursor protocol (replay, tail, `CursorEvictedError` past retention, independent cursors), lazy fan-out, metrics, per-surface batch triggers with exact-over-wildcard precedence, drain on close, and fan-in writes with isolated reads.
- `src/__tests__/base-harness-slots.spec.ts` + `create-factory.spec.ts` + `base-harness-principal.spec.ts` — positional defaults, instance and factory overrides, the shell exposing the parent's substrate, `onClose` replay, the sync-only factory contract, the bundled `createFactory` fan-in defaults and hand-rolled factory patterns, and the principal as authoritative construction identity.
- `src/__tests__/harness-plumbing.spec.ts` — a mixed sync/async harness end to end: envelope flow identical for direct and inbox-routed calls, an unknown message type failing without crashing the harness, middleware on both paths, and `parentOpId` threading through nested operations.
- `src/__tests__/compile-query.spec.ts` + `request-response-registry.spec.ts` + `fork-bus-subscription.spec.ts` + `spy-telemetry-sink.spec.ts` — matcher agreement across every query shape plus specialization fast paths; register/resolve, timeout, signal abort, cancel-all; per-event isolation of a throwing _and_ a rejecting listener with idempotent unsubscribe; and the recording processor/reader resolving parents by name and collecting all three instrument kinds.
- The switch itself — enrichment defaults on, zero overhead off — is covered in [@agentick/app](../app) (`telemetry.spec.ts`) and [@agentick/session](../session) (`telemetry.spec.ts`). `ctx.run`'s cross-surface contract is covered in [@agentick/tool-executor](../tool-executor) (`ctx-run.spec.ts`) and by the ctx conformance suites in `@agentick/spec-conformance`.
