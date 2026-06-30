# ADR 45 — Runtime context model: structural identity, propagated context, journal envelope

**Status:** Proposed — 2026-06-30.
**Touches:** `@agentick/runtime-next/substrate/runtime-context.ts`
(the canonical scope type + propagation primitives),
`@agentick/runtime-next/substrate/base-harness.ts` (operation
envelope construction), `@agentick/spec-next/protocol/operation.ts`
(`Operation.scope` collapse), `@agentick/spec-next/data/tool-handler.ts`
(dual-typed handler signatures), `@agentick/tool-executor-next` (handler
invocation site — Effect-wraps the call), every harness that constructs
`Operation` shapes (audit). Cross-references ADR 26 (harness API shape),
ADR 27 (modular built-ins), ADR 34 (scoped capability cascade), ADR 41
(error hierarchy), ADR 43 (unified tool-handler ctx).

**Driver:** During #277b we shipped MCP credentials integration with a
`credentialKey: (ctx, deps) => string` strategy for multi-tenant key
derivation. The retro caveat exposed the deeper issue: `readContext()`
is unreliable across plain async boundaries (post-`Effect.runSync` calls,
Promise chains outside Effect-land, callback-based libraries). Auth
material in `RuntimeContext.request` is therefore brittle — sometimes
present, sometimes silently `EMPTY_CONTEXT`, with no type-level
indication. Two follow-up conversations crystallized the architectural
answer: **identity is structural; context is for diagnostic ephemera;
operations don't carry their own scope — they read from + enrich the
ambient context**. This ADR codifies that.

---

## TL;DR

1. **Three layers, three responsibilities. No conflation.**
   - **Structural identity** — auth-bearing resources (`McpClientHarness`,
     `SandboxRuntime`, anything with credentials) encode the principal in
     their CONSTRUCTION. Different principal → different instance.
     Authorization is enforced by object identity, never by reading the
     context bag.
   - **Runtime context** — typed ambient state propagated by the
     substrate (FiberRef + AsyncLocalStorage). Carries identity
     dimensions (`sessionId`, `opId`, `correlationId`) AND adopter-defined
     extension (`user`). Used for telemetry, logging, observability, and
     adopter-internal lookups. NEVER trusted by the framework for
     authorization.
   - **Journal envelope** — typed subset of context serialized into every
     operation envelope. Replay-correct. PII-aware (adopter `user` bag
     not journaled by default).

2. **`Operation.scope` collapses into `RuntimeContext`.** Operations no
   longer carry `scope: { sessionId }` as a field. `runOperation` reads
   ambient context at start, enriches it (sets `opId`, `parentOpId`),
   and runs the body inside the enriched context. Journal envelopes
   serialize the typed dimensions automatically.

3. **`RuntimeContextUser` — empty-seed module-augmented adopter slot.**
   Mirrors the v1 `UserContext` augmentation pattern. Same convention
   as `HookBridges` augmentation across the v2 codebase. Adopters
   `declare module "@agentick/runtime-next" { interface RuntimeContextUser { ... } }`
   to type their per-call ambient state with whatever keys they want
   (`tenantId`, `userId`, `requestId`, `featureFlags`, etc.). The
   `RuntimeContext.request: Record<string, unknown>` escape hatch is
   removed.

4. **`runWithContext(scope, fn)` — sync scoped-set primitive.** Partial
   scope, merged into current. Writes to BOTH the Effect FiberRef AND
   an `AsyncLocalStorage` so sync reads across plain async boundaries
   (`fetch`, callback-based libs, adopter Promise chains) see the
   active context. Closes the gap that prevented `readContext()` from
   working outside Effect-typed code.

5. **Tool handlers become dual-typed.** The unified `ToolHandlerCtx`
   (ADR 43) gains a return-type union: handlers return either
   `Promise<ContentBlock[]>` OR `Effect.Effect<ContentBlock[], ...>`.
   The executor discriminates on return type. Adopters writing plain
   async get ALS-propagated context; adopters writing Effect get full
   FiberRef + typed errors. Server-side framework convention; the
   client-side SDK stays Promise-only (no Effect substrate exposed
   to UI code).

6. **Framework auth stays structural; adopter auth is adopter's problem.**
   Framework primitives (MCP harness, sandbox, credentials store) NEVER
   read principal from `ctx.user`. Adopters are free to put principal
   in `ctx.user.userId` for THEIR OWN telemetry / logging / per-call
   decisions, accepting the propagation tradeoffs. Two-layer model
   prevents adopter-supplied auth from accidentally cross-pollinating
   between framework primitives.

---

## Driver — the multi-tenant + propagation pain

### Where we are today

`RuntimeContext` is held in an Effect `FiberRef`. The substrate primitives
that propagate it correctly are:

- `getContext`: Effect-typed read. Works inside Effect.
- `withContext(scope, effect)`: Effect-typed scoped write. Inner wins on
  collision. Returns a new Effect.
- `readContext()`: sync escape hatch that runs `Effect.runSync(getContext)`
  internally. Works at the boundary of an active fiber.

**The propagation gap.** FiberRefs propagate WITHIN a fiber's structured
concurrency tree. They do NOT propagate:

1. **Across `Effect.runSync` calls** — each `Effect.runSync` starts a
   fresh root fiber. If `Effect.runSync(withContext(scope, Effect.sync(fn)))`
   runs `fn` which calls `Effect.runSync(getContext)`, the inner read
   starts ANOTHER fresh fiber that has no inherited context. This is
   why `runWithContext`-as-sync-only was deferred; FiberRef alone
   doesn't model it.
2. **Across plain Promise / `async` chains outside Effect** — the SDK's
   `client.connect()`, `fetch(...)`, adopter middleware, anything not
   wrapped in `Effect.tryPromise`. The fiber ends at the `await`
   boundary; reads inside the awaited Promise see `EMPTY_CONTEXT`.
3. **Across timer / `setImmediate` / external callback re-entry** —
   anything that crosses the JS event loop boundary outside Effect's
   control loses the fiber.

The #277b OAuth integration sat squarely in this gap. The OAuth provider's
`loadTokens` runs inside `SDK Client.connect()` — outside Effect — so any
adopter trying to derive a key from `readContext().user.tenantId` reads
`undefined`. The multi-tenant story was documented as "works only inside
fiber-preserved paths."

### The architectural insight

The fix is NOT "fight to propagate context everywhere." The fix is
**recognize that propagating principal through context is the wrong
shape**. Three insights, in order:

1. **Identity that bears authorization is structural, not contextual.**
   `McpClientHarness` for user-42 is a DIFFERENT INSTANCE than
   `McpClientHarness` for user-43 — they have different IDs, different
   tokens, different elicit addresses. The principal is encoded in the
   harness's IDENTITY, not in ambient state read at use-time. No
   propagation needed.

2. **Diagnostic context (correlationId, tickId, opId) is the right
   shape for ambient propagation.** It's per-request, immutable once
   set, and worst-case bug is misattributed log line — not a security
   incident. ALS-coupled FiberRef handles this elegantly.

3. **Adopter-defined state (`tenantId`, `requestId`, `featureFlags`) is
   adopter's problem.** Module-augmented `RuntimeContextUser` gives
   adopters typed access for their own purposes. Framework primitives
   never trust this bag for authorization. Adopters can use it for
   logging, branching, telemetry — wherever the propagation guarantees
   are acceptable.

This is the consensus in mature systems:

- **OpenTelemetry**: trace context propagates via W3C headers + ALS;
  baggage is for diagnostic strings, not auth. Auth is out-of-band
  (carried by tokens, validated separately).
- **Erlang/OTP**: PIDs are identity. Per-process state. Send a message
  to a PID and you've already named the recipient by identity. No
  context propagation needed.
- **Spring**: `SecurityContextHolder` (ALS-backed) carries the
  authenticated principal, but the principal is set ONCE at the auth
  filter boundary, never modified. Diagnostic context (MDC) is
  separate, propagated separately.
- **Go**: `context.Context` is explicit pass-through for cancellation,
  deadlines, request-scoped values. Idiomatic Go strongly discourages
  putting auth in context — "Use context values only for request-scoped
  data."
- **AWS Lambda**: invocation envelope carries identity. Handler reads
  it explicitly. No propagation because each invocation is fresh.

The pattern: **identity travels as explicit envelope fields at
boundaries, lives structurally inside the boundary; context propagation
is reserved for cancellation, tracing, and diagnostic concerns**.

---

## The three layers

### Layer 1: Structural identity

**Rule:** Stateful resources tied to a principal MUST take the principal
as a construction parameter and never read it from runtime context
afterward.

**Implementation:** the resource's identity (the value returned by
its `id` getter, the value used in inbox addresses, the value used to
key the registry) encodes the principal. Different principal → different
instance. Different instance → different memory address, different state,
different connection.

**Examples:**

```ts
// Single-tenant deployment (most adopters):
const harness = new McpClientHarness(
  `${sessionId}:mcp:linear`,
  ...,
  { serverId: "linear", ... },
);

// Multi-tenant deployment (gateway serving N users):
const harness = new McpClientHarness(
  `${sessionId}:mcp:linear:user-${userId}`,
  ...,
  { serverId: `linear:user-${userId}`, ... },
);
```

The session that opens these harnesses knows its principal at
construction time (auth middleware ran already, principal is on the
request envelope). Per-principal harness creation is a structural
fan-out, not a runtime branch.

**What this gives:**

- **Concurrency-safe by construction.** Two principals cannot collide
  because they're different objects in different memory addresses.
- **Runtime-agnostic.** Works in Node, Bun, Deno, browser — anywhere
  objects exist.
- **Refactor-safe.** Adding a new async boundary inside the harness
  doesn't break anything because nothing is being propagated through it.
- **Cluster-safe.** Distributing harnesses across nodes (per #152
  connection pool) follows the same principal-tuple key. Identity
  travels with the routing.
- **Auditable.** You can grep for who-creates-which-harness. You cannot
  grep for who-reads-which-context.

**Discipline:** every audit of a framework primitive that holds
auth-bearing state asks "does it read principal from context, or is
it structurally per-principal?" The former is a bug. (#289 tracks the
sweep.)

### Layer 2: Runtime context — typed ambient state

**Shape:**

```ts
export interface RuntimeContext {
  // Identity dimensions — typed, immutable, set at framework boundaries.
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  readonly opId?: string;
  readonly parentOpId?: string;

  // Correlation / tracing — typed, immutable, set at framework boundaries.
  readonly correlationId?: string;
  readonly traceparent?: string;

  // Adopter extension — typed via module augmentation.
  readonly user?: RuntimeContextUser;
}

/**
 * Empty seed — adopters augment via `declare module` to type the
 * `user` field on `RuntimeContext`. Mirrors the `HookBridges` empty-
 * seed pattern across the v2 codebase.
 *
 * @example
 *   // adopter app code
 *   declare module "@agentick/runtime-next" {
 *     interface RuntimeContextUser {
 *       readonly tenantId: string;
 *       readonly userId: string;
 *       readonly requestId?: string;
 *     }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RuntimeContextUser {}
```

**What lives where in the typed surface:**

| Field | Set by | Read by | Notes |
|---|---|---|---|
| `sessionId` | session-next at session creation | telemetry, journal, harnesses | structural — never use for auth |
| `executionId` | session-next at execution start | telemetry | per-`send()` |
| `tickId` | loop-executor at tick start | telemetry, journal | per-model-call |
| `opId` | runOperation entry | journal envelopes | per-operation |
| `parentOpId` | runOperation entry (from prior opId) | causality graph | for nested operations |
| `correlationId` | wire entry (HTTP request, RPC) | tracing, logs | per-request bundle |
| `traceparent` | OpenTelemetry middleware | OTel exporters | W3C trace context |
| `user.*` | adopter middleware / app code | adopter logging, branching | NEVER trusted for framework auth |

**Removed from `RuntimeContext`:**

- `request?: Readonly<Record<string, unknown>>` — replaced with typed
  `user?: RuntimeContextUser` augmentation.

**Propagation primitives:**

```ts
// Effect-typed read.
export const getContext: Effect.Effect<RuntimeContext>;

// Effect-typed scoped write. Inner wins on collision.
export function withContext<R, E, A>(
  scope: Partial<RuntimeContext>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R>;

// Sync read — works inside Effect fibers AND across plain async
// boundaries (after ALS coupling — see runWithContext below).
export function readContext(): RuntimeContext;

// Sync scoped-set primitive — writes to BOTH FiberRef AND
// AsyncLocalStorage. Partial scope, merged into current.
export function runWithContext<T>(
  scope: Partial<RuntimeContext>,
  fn: () => T,
): T;

// Async variant — for fn returning Promise.
export function runWithContextAsync<T>(
  scope: Partial<RuntimeContext>,
  fn: () => Promise<T>,
): Promise<T>;
```

**ALS coupling — the implementation.**

The substrate maintains TWO mirrors of the active context:

1. The Effect `FiberRef` — the source of truth inside Effect fibers.
2. A Node `AsyncLocalStorage<RuntimeContext>` — the source of truth
   across plain async chains.

`runWithContext(scope, fn)`:
1. Reads current context (FiberRef OR ALS — whichever is non-empty,
   prefer FiberRef when inside an Effect fiber).
2. Merges `scope` over current.
3. Establishes the merged value in BOTH ALS (`als.run(merged, ...)`)
   and FiberRef (`Effect.locally(RuntimeContextRef, merged)`).
4. Runs `fn` inside both scopes.

`readContext()`:
1. Tries FiberRef first via `Effect.runSync(getContext)`.
2. If FiberRef returns `EMPTY_CONTEXT` (no active fiber), falls back
   to `als.getStore()`.
3. Returns merged result or `EMPTY_CONTEXT`.

`withContext(scope, eff)` (Effect-typed):
1. Same as today — FiberRef-only. Effect-typed code stays inside Effect.

**Why both substrates.** FiberRef is the right primitive inside Effect:
fiber lineage propagation is automatic, structured-concurrency-aware,
and cluster-portable. ALS is the right primitive outside Effect: it
covers Node's full async-hook instrumentation (promises, timers,
callbacks, fs, net). Neither alone is sufficient; together they cover
the framework's hybrid Effect+plain-async reality.

**Caveats** (documented loudly in `runtime-context.ts`):

- **Worker threads** don't share ALS. Each worker has its own. If an
  adopter dispatches work to a worker pool, context doesn't follow.
- **Some legacy callback-based libraries** break ALS propagation
  (e.g., libraries that use private microtask queuing outside Node's
  promise hooks). Modern libraries are fine.
- **Browser / Bun / Deno** have partial or no ALS support. Server-side
  framework is Node-targeted; client SDK stays Promise-only without
  context (UI code passes identity as explicit props).
- **Within Effect**, prefer `withContext` over `runWithContext` —
  fiber-native is cheaper and clearer than the ALS bridge.

### Layer 3: Journal envelope

Operations capture a typed subset of `RuntimeContext` at envelope
construction. The journal serializes the framework-typed dimensions
(sessionId, executionId, tickId, opId, parentOpId, correlationId,
traceparent) by default. The adopter `user` bag is NOT serialized by
default — opt-in via `journalingPolicy: { includeUserContext: true }`
or per-field selectors.

**Rationale:** the framework can replay an execution from the journal
because it owns the typed dimensions. The adopter's `user` bag may
contain PII, large payloads, or stale references; making it opt-in
keeps the journal clean and replay-safe by default.

---

## Operation.scope collapse

### Before

```ts
interface Operation<I, O> {
  readonly opId: string;
  readonly surface: string;
  readonly name: string;
  readonly scope: { sessionId: string };  // ← redundant carrier
  readonly input: I;
}

// runOperation today:
const op: Operation<I, O> = {
  opId: `${surface}:${name}:${ulid()}`,
  surface,
  name,
  scope: { sessionId },  // duplicates RuntimeContext.sessionId
  input,
};
```

The `scope` field duplicated what RuntimeContext already carried. Two
sources of truth for the same identity dimension.

### After

```ts
interface Operation<I, O> {
  readonly opId: string;
  readonly surface: string;
  readonly name: string;
  readonly input: I;
  // scope field removed — operations READ from active RuntimeContext.
}

// runOperation:
function runOperation<I, O>(
  op: Operation<I, O>,
  body: (input: I) => Effect.Effect<O, ...>,
): Effect.Effect<O, ...> {
  return Effect.gen(function*() {
    const current = yield* getContext;
    const enriched: RuntimeContext = {
      ...current,
      opId: op.opId,
      parentOpId: current.opId,  // current op becomes the parent of nested ops
    };
    return yield* withContext(enriched, body(op.input));
  });
}
```

Operations no longer carry their own scope. They READ ambient context
when they run, ENRICH it (set opId + parentOpId), and propagate the
enriched context to children. The journal envelope serializes the
enriched context's typed subset.

### Why this is right

- **Single source of truth.** `sessionId` lives in one place
  (RuntimeContext); operations don't duplicate it.
- **Causality is implicit.** `parentOpId` is automatically the prior
  `opId` — no explicit threading.
- **Adopter extension comes along for free.** When an adopter sets
  `ctx.user.requestId` at the wire boundary, every nested operation's
  envelope sees it (if journaled).
- **Migrations are mechanical.** Every operation construction site
  that today writes `scope: { sessionId }` drops the field. Every
  consumer that today reads `op.scope.sessionId` reads
  `(yield* getContext).sessionId` instead.

### Migration

1. Update `Operation` type to drop `scope`.
2. Update `runOperation` / `runHarnessProtocol` to read+enrich context.
3. Sweep callers — drop `scope: { ... }` from Operation construction.
4. Sweep consumers — replace `op.scope.X` reads with `(yield* getContext).X`.
5. Update journal envelope serializer to read from RuntimeContext at
   envelope creation.

Backward-compatibility note: this is a breaking change to the
`Operation` shape, which is internal substrate. No public API change.

---

## Dual-typed tool handlers

### The convention

Tool handlers may return either a Promise OR an Effect:

```ts
type ToolHandler<I> =
  | ((input: I, deps: ToolDeps) => ContentBlock[] | Promise<ContentBlock[]>)
  | ((input: I, deps: ToolDeps) => Effect.Effect<ContentBlock[], McpClientError>);
```

The tool-executor (`@agentick/tool-executor-next`) discriminates at the
call site:

```ts
// In the executor:
const result = handler(input, deps);
if (Effect.isEffect(result)) {
  return yield* result;  // Effect-typed — full FiberRef + typed errors
} else {
  return yield* Effect.tryPromise(() => Promise.resolve(result));  // Promise-typed
}
```

### What this gives

- **Effect-adopters get full power.** Typed errors via `R`, FiberRef
  propagation, structured concurrency, Effect's built-in cancellation.
  Their handlers compose with Effect-typed substrate code naturally.
- **Plain-async adopters get convenience.** Most adopters write
  `async (input, ctx) => {...}` — that's their entire mental model.
  They get ALS-propagated context for free (post-#284); they don't
  have to learn Effect to write tools.
- **The executor handles both uniformly.** One call site,
  type-discriminated branch. No duplicated dispatch logic.

### Server-side only

The dual-typing applies to server-side primitives — tool handlers,
sandbox executors, MCP harness operations, anything that touches the
substrate. The CLIENT SDK stays Promise-only:

- Client code (browser, mobile, desktop UI) shouldn't need Effect.
- The client's RPC layer translates server-side Effect channels to
  Promise-resolving + JSON-RPC error responses.
- Adopter UI code reads context via `readContext()` (sync, ALS-backed)
  or via React-style hooks (`useRuntimeContext()` when wire projection
  lands).

The convention is: **wherever adopter code crosses into framework
substrate, dual-type**. On the client side, there is no substrate to
cross into — the client is RPC + state, not Effect.

---

## `RuntimeContextUser` augmentation

### Pattern

Mirrors the `HookBridges` empty-seed convention used elsewhere in v2:

```ts
// In @agentick/runtime-next:
export interface RuntimeContextUser {}  // empty seed

export interface RuntimeContext {
  // ... typed framework fields ...
  readonly user?: RuntimeContextUser;
}

// In adopter app code:
declare module "@agentick/runtime-next" {
  interface RuntimeContextUser {
    readonly tenantId: string;
    readonly userId: string;
    readonly requestId?: string;
    readonly featureFlags?: Readonly<Record<string, boolean>>;
  }
}

// Now everywhere in adopter code:
const scope = readContext();
const tenant = scope.user?.tenantId;  // typed!
```

### Why empty-seed module augmentation

- **Pattern consistency.** Every harness in v2 declares its slot via
  `declare module "@agentick/spec-next"` augmenting `HookBridges`. Same
  shape for `RuntimeContextUser`. Adopters already know the recipe.
- **Typed adopter state without framework opinion.** The framework has
  zero opinion about what adopters store. It just provides the slot.
- **Discoverable in IDE.** `ctx.user.` autocompletes to whatever the
  adopter defined. No `Record<string, unknown>` cast-fest.
- **Removes the `request` escape hatch.** The old `RuntimeContext.request:
  Record<string, unknown>` invited adopters to stuff anything in,
  including auth material. Typed augmentation forces them to think
  about what they're storing.

### Documentation discipline

`RuntimeContextUser` MUST be loudly documented as adopter-augmentable.
Three places:

1. `@agentick/runtime-next/README.md` — entire section on the
   augmentation pattern with the full example.
2. JSDoc on `RuntimeContextUser` itself — example block + cross-ref to
   this ADR + warning that auth-bearing fields should be considered
   adopter-managed (not framework-trusted).
3. Top-level `docs/proposals/v2/blueprint/00-overview.md` mentions
   adopter extension story.

The naming `RuntimeContextUser` follows v1's `UserContext` (it WAS
the field name in v1). Adopters migrating from v1 should find the
mental model familiar.

---

## What adopter code looks like

### Single-tenant deployment

```ts
// app.ts — single-user, no auth context to thread.
const app = createApp(MyAgent, {
  model: openai("gpt-4o"),
  extensions: [
    withMCP({ servers: [{ serverId: "linear", transport: linearFactory }] }),
    withCredentials({ store: inMemoryCredentialsStore() }),
  ],
});

// MCP harness id = `session-A:mcp:linear` (no principal suffix).
// withMCP's default credentialKey = `mcp:linear:tokens` (no principal).
// All correct — single-tenant doesn't need principal isolation.
```

### Multi-tenant deployment

```ts
// app.ts — gateway serving N principals.
declare module "@agentick/runtime-next" {
  interface RuntimeContextUser {
    readonly tenantId: string;
    readonly userId: string;
  }
}

// Wire boundary (gateway request handler):
gateway.handleRequest(async (req) => {
  return runWithContextAsync(
    {
      correlationId: req.id,
      user: { tenantId: req.tenant, userId: req.user },
    },
    async () => {
      const session = gateway.app(req.appId).getSession(req.sessionId);
      return session.send({ messages: req.messages });
    },
  );
});

// MCP harness construction (inside withMCP — per-session install):
withMCP({
  servers: [
    {
      // Principal IS the harness identity. Structural.
      serverId: `linear:${readContext().user!.userId}`,
      transport: linearFactory,
    },
  ],
  // Optional override — defaults to `mcp:<serverId>:<field>`.
  // serverId already includes user, so default is correct.
});

// Tool handler — reads ctx for telemetry, not auth.
const myTool = createTool({
  name: "my_tool",
  handler: async (input, { ctx }) => {
    const scope = ctx.readContext();
    logger.info({ tenant: scope.user?.tenantId, opId: scope.opId }, "tool ran");
    // ... handler body ...
    // Auth is handled by the harness identity already (per-user MCP client).
  },
});
```

### Effect-typed handler

```ts
const myTool = createTool({
  name: "my_tool",
  handler: (input, { ctx }) =>
    Effect.gen(function* () {
      const scope = yield* getContext;
      logger.info({ tenant: scope.user?.tenantId }, "tool ran");
      const result = yield* Effect.tryPromise(() => doWork(input));
      return [{ type: "text", text: result }];
    }),
});
```

---

## Migration plan

This is the scope of #284 (the design + primitive landing) + a few
follow-ups.

### #284 (this ADR's primitive work)

1. **Update `RuntimeContext` shape.** Add typed `traceparent`. Replace
   `request: Record<string, unknown>` with `user?: RuntimeContextUser`.
   Add `RuntimeContextUser` empty seed.
2. **Ship `runWithContext` + `runWithContextAsync`.** ALS-coupled
   FiberRef. Update `readContext` to fall back to ALS.
3. **Tests.** Cover propagation across:
   - Effect → Effect (FiberRef)
   - Effect → Promise → Effect (ALS bridge)
   - Promise → Promise (ALS only)
   - Worker thread (negative test — documented as not propagating)
   - Concurrent `runWithContext` calls (isolation correctness)
4. **README updates.** `@agentick/runtime-next/README.md` gets the
   augmentation pattern. JSDoc on `RuntimeContextUser` itself.

### #285 (sweep — incremental)

Sweep `Effect.runSync(getContext)` callsites — replace with `readContext()`
where appropriate. Mechanical refactor. Can happen package-by-package.

### #290 (capture-replay — tactical)

Audit framework-owned async boundaries (TasksHarness.submit, ToolExecutor
async handler invocation, MCP connect, Sandbox exec, Elicitation
Deferred resolution). Each captures `readContext()` at the boundary and
re-establishes via `runWithContext`. Should be largely unnecessary
after ALS coupling — but covers worker-thread and ALS-breaking-library
edge cases.

### #289 (structural identity audit)

Audit every principal-bearing harness — does its constructor accept
enough identity to disambiguate principals? Does any of its internals
read `readContext()` for principal lookup? Fix the latter. Document
the structural-identity rule as an ADR amendment.

### Operation.scope collapse

Probably ships in #284 alongside the primitive — they're co-dependent.
Operations need to read context for their typed-dimensions; the typed
dimensions need a clean carrier. One PR, related changes.

### Open: when does this land relative to #280

This ADR positions #284 as a prerequisite for #280 (wire extensions
framework). #280 will introduce its own context-propagation requirements
(correlationId across the wire, principal in envelopes, traceparent in
RPC headers). Designing #280 against a settled context model gives it
clean taxonomy; the converse risks ad-hoc context handling that gets
refactored.

---

## Open questions

### 1. `runWithContext` merge semantics — partial vs. replacement

This ADR specifies partial-scope merge: `runWithContext({ correlationId: "x" }, fn)`
merges into current context, doesn't replace it. **Confirmed.**

Open: should there be a `runWithoutContext(fn)` that explicitly clears?
Use case: testing where you want to verify a code path doesn't depend
on ambient context. Probably yes, ships in #284 testing utilities.

### 2. Adopter override of framework-typed fields

Should adopters be able to override framework-typed fields (e.g., set
`correlationId` themselves)? Yes — they're optional in the type, and
the merge rule says inner wins. Use case: an HTTP middleware that
extracts `traceparent` from request headers sets it on the context
before the framework processes the request. Document the merge
behavior.

### 3. Operation construction sites — sessionId discovery

If operations drop `scope.sessionId` as a field, sites that construct
Operations need to either (a) read sessionId from RuntimeContext at
construction time (and ASSUME it's set), or (b) require sessionId be
passed explicitly. Probably (b) for ergonomics — calling code already
has sessionId in hand. The Operation type can require sessionId as a
NON-OPTIONAL constructor param even though it's not stored on the
type. This needs ergonomic prototyping during #284 implementation.

### 4. Should the journal serialize `user` by default

Default to no — adopter `user` bag may contain PII. Opt-in via journaling
policy. Sweep journal policy to support per-field whitelisting if
adopters want partial serialization.

### 5. Browser context story

Client SDK doesn't have ALS. UI code is generally synchronous within a
React render or event handler, so explicit prop-threading is the
canonical answer. The wire layer carries `correlationId` etc. on
requests; the UI doesn't propagate them. Future ADR if needed.

---

## Why this ADR exists vs. just opening a PR

This is the foundation for #280, #289, #290, and the multi-tenant story
across the framework. Three architectural commitments (structural
identity / propagated context / journal envelope) deserve a doc that
future readers can cite. The MCP credentials work that drove this
ADR is fresh — capture the rationale now, before the design intent
gets lost in implementation churn.

---

## Cross-references

- ADR 26 — Harness API shape (the BaseHarness pattern that operations
  flow through)
- ADR 27 — Modular built-ins (the empty-seed module-augmentation
  convention `RuntimeContextUser` mirrors)
- ADR 34 — Scoped capability cascade (how policies layer across
  app/session/tick — RuntimeContext is the cascade carrier)
- ADR 41 — Error hierarchy (typed errors that respect Effect's `E`
  channel — dual-typed handlers inherit this discipline)
- ADR 43 — Unified tool-handler ctx (the `ToolHandlerCtx` that becomes
  dual-typed in this ADR)
- #277 — MCP connection-status + credentials integration (the driver)
- #284 — runtime-next sync scoped-set primitive (the implementation
  this ADR specifies)
- #285 — sweep `Effect.runSync(getContext)` → `readContext()`
- #288 — narrow `RuntimeContext.request` to diagnostic-only (the
  destructive prerequisite this ADR specifies the constructive
  replacement for)
- #289 — principal-bearing harnesses construct per-principal (the
  audit this ADR's structural rule mandates)
- #290 — async-boundary capture-replay sweep (tactical residual after
  ALS coupling)
