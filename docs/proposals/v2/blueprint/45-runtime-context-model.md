# ADR 45 — Runtime context model: unified scope, closure-capture propagation, structural-identity for auth

**Status:** Revised — 2026-06-30.
**Supersedes:** the first draft of this same ADR (committed 2026-06-30 earlier, then substantially revised after expert review). The prior draft overclaimed in two places — `Operation.scope` was incorrectly proposed as redundant with `RuntimeContext`, and ALS coupling was proposed as the propagation backbone when closure-capture-via-deps is actually sufficient. Both corrected here.

**Touches:** `@agentick/spec/data/events.ts` (EventScope canonicalization +
empty-seed augmentation), `@agentick/spec/data/runtime-context.ts`
(new — extends EventScope), `@agentick/runtime/substrate/runtime-context.ts`
(narrow + clarify `readContext()` contract; drop sync `runWithContext`),
`@agentick/spec/data/tool-handler.ts` (dual-typed handler signatures),
`@agentick/tool-executor` (handler invocation site —
discriminates on return type), `@agentick/utils/effect-lift.ts`
(new — `liftToEffect` generic helper), `@agentick/sandbox` +
`@agentick/mcp` (migrate hardcoded `sandboxId` / `mcpConnectionId`
fields from spec to package-level augmentations). Cross-references ADR
26 (harness API shape), ADR 27 (modular built-ins — augmentation
pattern this ADR extends), ADR 34 (scoped capability cascade), ADR 41
(error hierarchy), ADR 43 (unified tool-handler ctx — adds the dual-type
shape here).

**Driver:** During #277b we shipped MCP credentials integration with a
`credentialKey: (ctx, deps) => string` strategy for multi-tenant key
derivation. The retro caveat exposed: `readContext()` is unreliable
outside Effect fibers (post-`Effect.runSync` calls, Promise chains,
callback-based libraries). Auth material in `RuntimeContext.request:
Record<string, unknown>` is therefore brittle. Three follow-up
conversations distilled the architectural answer: (1) **identity is
structural for auth-bearing resources** — they encode principal in
construction, never read it from ambient context; (2) **context is
propagated via closure-capture-on-deps for adopter code, FiberRef for
substrate code** — no ALS substrate, no Node-tie, no cross-Promise
ambient propagation; (3) **EventScope is the canonical identity space
with module augmentation** — sandbox-next, mcp-next, etc. augment it
with their own identifiers; RuntimeContext is EventScope + op-level
state + diagnostic ephemera + adopter `user` bag.

---

## TL;DR

1. **Unified identity space.** `EventScope` is canonical and augmentable
   via `EventScopeExtensions` (empty-seed module augmentation, mirrors
   `HookBridges`). Each harness package adds its own identifier
   (`sandboxId` from sandbox-next, `mcpConnectionId` from mcp-next,
   etc.) — no hardcoding identifiers in spec-next. `RuntimeContext`
   **extends** `EventScope` with operation-level state (`opId`,
   `parentOpId`), diagnostic ephemera (`correlationId`, `traceparent`),
   and the adopter-augmentable `RuntimeContextUser` slot.

2. **Closure-capture-via-deps is the primary propagation pattern.**
   Tool handlers, middleware, hooks, sub-routines — all receive
   `ctx: RuntimeContext` as an explicit deps parameter (already true
   for ToolHandler per ADR 43). JS closure semantics propagate `ctx`
   through any async chain the function authors. No ambient magic,
   no Node-tie, no propagation gap. **The `liftHandler` helper
   captures ctx at lift time and passes it through deps** — so even
   plain async handlers get ctx in their lexical scope without
   calling `readContext()`.

3. **FiberRef serves substrate-internal Effect chains.** Substrate
   code (`runOperation`, `runHarnessProtocol`, harness internals) is
   Effect-typed end-to-end. FiberRef propagates within that fiber
   lineage. `withContext(scope, effect)` is the Effect-typed scoped
   write. `yield* getContext` is the Effect-typed read. **`readContext()`
   is a documented escape hatch with stated limits — works outside
   Effect fibers, NOT inside Effect fibers** (nested `Effect.runSync`
   creates a fresh root fiber with default FiberRef state).

4. **Structural identity is the rule for auth-bearing resources.**
   Resources that hold per-principal state (`McpClientHarness`,
   `SandboxRuntime`, `OAuthProvider`) encode the principal in their
   identity — different principal → different instance. Authorization
   is enforced by object reference, never by reading `ctx.user`.
   **Not a universal rule** — stateless / diagnostic / substrate-singleton
   resources (CredentialsHarness, ToolExecutor, TasksHarness) stay
   one-instance-per-app-or-session and accept principal via key
   composition or session identity.

5. **Drop `RuntimeContext.request: Record<string, unknown>`.** Replaced
   with `RuntimeContext.user?: RuntimeContextUser` augmented via
   `declare module`. Typed adopter extension, no escape-hatch bag.

6. **Dual-typed tool handlers.** Handler signature accepts either a
   Promise return or an Effect return. Executor discriminates on
   return type (`Effect.isEffect(result)`). Server-side convention —
   client SDK stays Promise-only. Same dual-shape pattern the kernel
   procedure layer already uses.

7. **No ALS, no sync `runWithContext`.** Both were proposed in the
   prior draft; both rejected after analysis. ALS adds Node-tie for
   value (cross-Promise ambient propagation) we can mostly avoid via
   structural identity + closure-capture. Sync `runWithContext` is
   architecturally impossible on FiberRef alone (nested
   `Effect.runSync` doesn't inherit); pretending otherwise via ALS
   is the cost we're choosing not to pay.

---

## Driver — what made this ADR necessary

### The propagation gap

`RuntimeContext` lives in an Effect `FiberRef`. Substrate code reads
and writes it via Effect-typed primitives (`getContext` / `withContext`).
The current `readContext()` sync escape hatch does
`Effect.runSync(getContext)` to extract a snapshot.

**The gap:** `Effect.runSync(eff)` always starts a fresh root fiber
with FiberRef DEFAULTS. It does not inherit FiberRef state from any
prior `runSync`-started fiber, nor from any outer fiber if called
from inside one. So:

- `readContext()` called inside an active Effect fiber → returns
  `EMPTY_CONTEXT` (not the parent fiber's state).
- `readContext()` called from inside a Promise chain that's awaited
  by Effect → returns `EMPTY_CONTEXT`.
- `readContext()` called from raw JS with no prior FiberRef write →
  returns `EMPTY_CONTEXT` (correct, no scope was set).

The function works ONLY if you have done `Effect.runSync(withContext(scope,
Effect.sync(() => readContext())))` at the immediate outer level — and
even then it's brittle.

### Why the prior #277b multi-tenant story was wrong

The `withMCP({ credentialKey })` strategy proposed:

```ts
credentialKey: (ctx, { serverId, field }) =>
  `mcp:${ctx.request?.userId ?? "anon"}:${serverId}:${field}`;
```

`ctx` was supposed to come from `readContext()` called inside
`withMCP`'s install loop. But `withMCP.install` runs inside the session
install path which IS inside an Effect fiber. `readContext()` there
returns `EMPTY_CONTEXT` (the runSync gap), so `ctx.request?.userId` is
always undefined. The multi-tenant case silently fails to discriminate.

This wasn't a "documentation caveat" — it was a structural design bug
masked by the runSync semantics. The retro committed extensive JSDoc
explaining the limitation; this ADR commits to the _fix_.

### Three architectural insights

1. **Identity that bears authorization is structural, not contextual.**
   `McpClientHarness` for user-42 is a DIFFERENT INSTANCE than for
   user-43. The principal lives in the harness's identity. No
   propagation needed. The propagation gap doesn't matter because
   nothing reads principal from ambient context.

2. **Closure-capture is the cleanest propagation for adopter code.**
   `ctx` arrives as a deps parameter to the handler. JS closure
   semantics carry it through any async chain the handler authors.
   No FiberRef magic, no ALS, no Node-tie. Works in any JS runtime.

3. **FiberRef is right for substrate-internal Effect work.** Substrate
   code is Effect-typed end-to-end; FiberRef propagates within fiber
   lineage natively. The substrate uses `yield* getContext` and
   `withContext(scope, eff)` — both are fiber-aware.

---

## The unified identity space

### EventScope is canonical

```ts
// @agentick/spec/data/events.ts

/**
 * Empty seed — package-level augmentation slot. Each harness package
 * with its own identifier dimensions augments this via:
 *
 *   declare module "@agentick/spec" {
 *     interface EventScopeExtensions {
 *       readonly sandboxId?: string;
 *     }
 *   }
 *
 * Mirrors the `HookBridges` empty-seed pattern. Spec-next stays
 * harness-agnostic — only framework-core identity dimensions live
 * in the canonical `EventScope`. Harness-specific dimensions live in
 * the augmenting packages.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EventScopeExtensions {}

/**
 * Canonical identity coordinates attached to every event envelope.
 * Subscribers filter by these (`bridges.events({ scope: { sessionId } })`);
 * the journal records them; the cluster wire serializes them.
 *
 * Augmentable via {@link EventScopeExtensions}.
 */
export interface EventScope extends EventScopeExtensions {
  readonly appId?: string;
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  readonly parentSessionId?: string;
  readonly spawnPath?: readonly string[];
  readonly nodeId?: string;
  readonly gatewayId?: string;
}
```

The current hardcoded `sandboxId` and `mcpConnectionId` migrate out of
spec-next into their owning packages:

```ts
// @agentick/sandbox/augment.ts
declare module "@agentick/spec" {
  interface EventScopeExtensions {
    readonly sandboxId?: string;
  }
}

// @agentick/mcp/augment.ts (client subpath)
declare module "@agentick/spec" {
  interface EventScopeExtensions {
    readonly mcpConnectionId?: string;
  }
}

// @agentick/mcp/server/augment.ts
declare module "@agentick/spec" {
  interface EventScopeExtensions {
    readonly mcpServerId?: string;
  }
}
```

New harnesses just follow suit. No coupling back to spec-next.

### RuntimeContext extends EventScope

```ts
// @agentick/spec/data/runtime-context.ts (new home)

/**
 * Empty seed — adopter app code augments this with their own
 * per-call ambient state:
 *
 *   declare module "@agentick/spec" {
 *     interface RuntimeContextUser {
 *       readonly tenantId: string;
 *       readonly userId: string;
 *       readonly requestId?: string;
 *     }
 *   }
 *
 * Mirrors v1's `UserContext` augmentation pattern (which v2 dropped
 * during the rewrite; this ADR restores the discipline). Adopter
 * state — NOT trusted by the framework for authorization. Adopters
 * use it for telemetry, branching, logging, whatever they need.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RuntimeContextUser {}

/**
 * Ambient runtime state. Inherits identity coordinates from EventScope
 * (so EventScope.sandboxId is also RuntimeContext.sandboxId), adds
 * operation-level state, diagnostic ephemera, and adopter extension.
 *
 * Propagated through Effect fibers via FiberRef (substrate-internal).
 * For adopter code (tool handlers, middleware, hooks), it arrives as
 * an explicit deps parameter — closure semantics propagate it through
 * any async chain the handler authors.
 */
export interface RuntimeContext extends EventScope {
  // operation-level state (NOT in EventScope because envelopes already
  // carry opId at the top level; the runtime version is for code that
  // wants to read "what's my current op" without unpacking an envelope)
  readonly opId?: string;
  readonly parentOpId?: string;

  // diagnostic ephemera (per-request bundle, OTel trace context)
  readonly correlationId?: string;
  readonly traceparent?: string;

  // adopter extension (typed via module augmentation)
  readonly user?: RuntimeContextUser;
}
```

### What this gets us

- **One augmentation pattern.** A harness adds `sandboxId` to
  `EventScopeExtensions` ONCE; it appears in BOTH `EventScope` (events
  filter by it) AND `RuntimeContext` (code reads it). No double-typing.
- **Subscribers and code share identity coordinates.** "Tell me events
  scoped to `{ sessionId: x, sandboxId: y }`" uses the same field names
  as "what session/sandbox am I in." Less cognitive overhead.
- **Spec-next stays harness-agnostic.** No hardcoded `sandboxId` /
  `mcpConnectionId` / future-harness identifier baked into events.ts.
  The augmentation pattern lets the spec evolve cleanly.
- **RuntimeContext stays small.** Op-level state (opId/parentOpId) +
  diagnostic ephemera + adopter bag. Routing identity comes via the
  inherited EventScope fields.

---

## Closure-capture-via-deps

### The pattern

Adopter code that needs ambient context receives `ctx` as an explicit
parameter. JS closure semantics handle propagation through any async
chain the function authors.

```ts
const handler: ToolHandler<MyInput> = async (input, { ctx }) => {
  // ctx is in scope.
  logger.info({ tenant: ctx.user?.tenantId }, "tool ran");

  // Async work inside the handler captures ctx via closure.
  const result = await fetch(`/api/${ctx.user?.tenantId}/data`);
  await persistTrace({ correlationId: ctx.correlationId, result });

  return [{ type: "text", text: String(result) }];
};
```

The handler body has `ctx` in lexical scope from the moment it's
called. Every line — including `await`ed continuations — can reference
`ctx`. No `readContext()` calls needed inside the handler. No FiberRef
visibility concerns. No ALS instrumentation. Just closures.

### Why closure-capture beats ambient propagation

| Concern                  | Ambient (FiberRef/ALS)                       | Closure-capture-via-deps         |
| ------------------------ | -------------------------------------------- | -------------------------------- |
| Runtime-portable         | Node + Bun + Deno (compat); no browser       | Any JS runtime                   |
| Worker-thread safe       | No (ALS) / partial (FiberRef)                | Yes (closure is lexical)         |
| Cross-Promise visibility | Yes (ALS) / no (FiberRef alone)              | Yes (closure is async-agnostic)  |
| Resource-bloat           | None                                         | None                             |
| Mental model             | "Implicit, look elsewhere"                   | "Explicit, look at signature"    |
| Refactor-safe            | Async-boundary changes can break propagation | Closure scope survives refactors |
| Auditable                | Hard — can't grep "who reads my context"     | Easy — grep function signatures  |
| Discoverable             | Hidden                                       | Visible in IDE autocomplete      |

The only thing ambient buys: code that DIDN'T receive ctx as a
parameter can still read it. That's a feature for cross-cutting
ambient concerns (logging plumbed deep into a third-party library,
etc.). It's also the failure mode — code reading ambient state it
shouldn't, security bugs from propagation surprises.

### The lift helper preserves the pattern

```ts
// @agentick/utils/effect-lift.ts

export function liftToEffect<Args extends readonly unknown[], A, E = unknown>(
  fn: (...args: Args) => A | Promise<A> | Effect.Effect<A, E>,
  errorMap?: (err: unknown) => E,
): (...args: Args) => Effect.Effect<A, E> {
  return (...args) => {
    const result = fn(...args);
    if (Effect.isEffect(result)) return result;
    return Effect.tryPromise({
      try: () => Promise.resolve(result),
      catch: errorMap ?? ((err) => err as E),
    });
  };
}
```

Surface-specific lift for tool handlers (the canonical pattern):

```ts
// @agentick/tool/lift.ts

import { liftToEffect } from "@agentick/utils";
import { getContext } from "@agentick/runtime";

/**
 * Lift a tool handler into Effect form WITH automatic ctx-capture
 * from the substrate's FiberRef. The lifted Effect reads the current
 * context inside the fiber, then passes it through to the handler
 * via deps — so the handler body has `ctx` in scope without needing
 * `readContext()`.
 *
 * Use cases:
 *   - Composing handlers with Effect-typed middleware.
 *   - Calling handlers from outside the executor (testing).
 *   - Explicit error-channel typing.
 *
 * Most adopters never call this — the executor's dual-typing handles
 * the Effect-wrap implicitly. Reach for it when you need explicit
 * Effect composition.
 */
export const liftHandler =
  <I, D extends { ctx?: RuntimeContext }, E = unknown>(
    fn: (
      input: I,
      deps: D & { ctx: RuntimeContext },
    ) =>
      | readonly ContentBlock[]
      | Promise<readonly ContentBlock[]>
      | Effect.Effect<readonly ContentBlock[], E>,
    errorMap?: (err: unknown) => E,
  ): ((input: I, depsBase: Omit<D, "ctx">) => Effect.Effect<readonly ContentBlock[], E>) =>
  (input, depsBase) =>
    Effect.gen(function* () {
      const ctx = yield* getContext; // read FROM the fiber's FiberRef
      const deps = { ...depsBase, ctx } as D & { ctx: RuntimeContext };
      const result = fn(input, deps);
      if (Effect.isEffect(result)) return yield* result;
      return yield* Effect.tryPromise({
        try: () => Promise.resolve(result),
        catch: errorMap ?? ((err) => err as E),
      });
    });
```

**The lift captures ctx INSIDE Effect (where FiberRef works) and passes
it explicitly to the handler.** The handler's closure carries ctx
through whatever async work it does. The handler never calls
`readContext()`. The propagation gap doesn't apply.

This is the answer to "how do adopters get context without parameter
passing?" — they don't. They get it via a parameter (which closure
captures throughout the body). The framework's job is to make that
parameter ergonomic and ensure it's populated correctly at lift time.

---

## FiberRef vs. ambient — the discipline

### Inside Effect, FiberRef works correctly

Substrate code is Effect-typed end-to-end. Within a single fiber's
execution chain (`Effect.gen` / `flatMap` / `tap` / etc.), FiberRef
state propagates natively.

```ts
// Substrate code (e.g., inside runOperation):
return Effect.gen(function* () {
  const ambient = yield* getContext; // reads current fiber's FiberRef
  const enriched = { ...ambient, opId: op.opId, parentOpId: ambient.opId };
  return yield* withContext(enriched, body(op.input)); // scopes the fiber
});
```

This is the correct pattern. No `readContext()`, no `Effect.runSync`,
no fiber escape.

### `Effect.fork` vs. `Effect.runFork` — important distinction

| Function                 | Where called              | What it does                                                | FiberRef inherits?                                  |
| ------------------------ | ------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `Effect.fork(eff)`       | Inside an active Effect   | Creates a CHILD fiber that runs concurrently with parent    | **Yes** — child inherits parent's FiberRef snapshot |
| `Effect.runFork(eff)`    | From raw JS (entry point) | Creates a ROOT fiber, returns a `RuntimeFiber<E, A>` handle | **No** — no parent to inherit from                  |
| `Effect.runSync(eff)`    | From raw JS (entry point) | Creates a ROOT fiber, runs to completion synchronously      | **No** — fresh root fiber every call                |
| `Effect.runPromise(eff)` | From raw JS (entry point) | Creates a ROOT fiber, returns a Promise                     | **No** — fresh root fiber every call                |

**The discipline:**

1. **Inside Effect, never call `runX`.** If you find yourself wanting
   to, you want `yield* eff` or `Effect.fork(eff)` instead. Nested
   `runX` is almost always a bug — it loses FiberRef state silently.

2. **At substrate edges (request entry, sync escape), use `runX`
   deliberately.** Match the run-function to your blocking needs:
   `runSync` if you need the result synchronously, `runPromise` for
   async, `runFork` for fire-and-forget with a handle.

3. **Within Effect, use `Effect.fork` for spawning concurrent child
   work.** The child inherits the parent's FiberRef, so the new fiber
   sees the parent's RuntimeContext.

### `readContext()` honest contract

```ts
/**
 * Sync read of RuntimeContext.
 *
 * Works correctly:
 *   - Called from raw JS code where a prior `withContext` was used
 *     to wrap the entire call stack (rare in v2).
 *
 * Does NOT work as expected:
 *   - Called from INSIDE an active Effect fiber — nested
 *     `Effect.runSync(getContext)` creates a fresh fiber that does
 *     NOT inherit the outer fiber's FiberRef. Returns EMPTY_CONTEXT.
 *     Use `yield* getContext` inside Effect instead.
 *   - Called from inside a Promise chain awaited by an Effect — the
 *     Promise's continuation runs outside the fiber. Returns
 *     EMPTY_CONTEXT.
 *
 * **Preferred patterns:**
 *   - Adopter code: receive `ctx` as a parameter (via deps).
 *   - Substrate code: use `yield* getContext` inside Effect chains.
 *   - Bridging: `liftHandler` (or `liftToEffect`) captures ctx at
 *     lift time and passes it through deps to the wrapped function.
 *
 * `readContext()` exists for places where neither pattern fits —
 * top-level subscribers that don't receive deps, plugin hooks with
 * fixed signatures, etc. Use sparingly, and prefer refactoring the
 * callsite to receive ctx explicitly.
 */
export function readContext(): RuntimeContext;
```

---

## Structural identity — strong guideline, NOT a universal rule

### When structural identity is right

Resources that hold per-principal STATE — auth tokens, connection
descriptors, per-flow PKCE, sandbox chroot+permissions — should be
constructed per-principal. The principal is encoded in the resource's
identity, not read from ambient context.

```ts
// Multi-tenant deployment:
const harness = new McpClientHarness(
  `${sessionId}:mcp:linear:user-${userId}`,
  ...,
  { serverId: `linear:user-${userId}`, ... },
);

// Single-tenant deployment (most adopters):
const harness = new McpClientHarness(
  `${sessionId}:mcp:linear`,
  ...,
  { serverId: "linear", ... },
);
```

**Why structural for these:**

- Concurrent multi-principal access is structurally impossible because
  each principal has a different object reference. No risk of token
  cross-contamination via context bugs.
- Cleanup per-principal is bounded — close the harness, gone. No
  shared state to wash.
- Cluster routing follows naturally — principal-keyed harness identity
  maps to principal-keyed cluster routing.
- Auditable — `new McpClientHarness(...)` callsites are greppable; the
  set of principals served is enumerable.

### When structural identity is overkill

Resources that have no meaningful per-principal state — substrate
primitives, stateless services, diagnostic concerns — should NOT be
instantiated per-principal. Principal is a key into the resource's
state, not a discriminator of the resource itself.

| Resource             | Per-principal?            | Why                                                                 |
| -------------------- | ------------------------- | ------------------------------------------------------------------- |
| `McpClientHarness`   | YES                       | Per-principal auth + connection state                               |
| `SandboxRuntime`     | YES                       | Per-principal chroot + permissions                                  |
| `OAuthProvider`      | YES (per session, server) | Per-flow PKCE + pending auth                                        |
| `CredentialsHarness` | NO                        | Substrate primitive; principal lives in keys (`mcp:user-42:tokens`) |
| `ToolExecutor`       | NO                        | Per-session; sessions are typically per-principal                   |
| `TasksHarness`       | NO                        | Per-session; inherits principal from session                        |
| Loggers, tracers     | NO                        | Cross-cutting; principal is a tag                                   |

The rule applied universally would lead to N×waste with no correctness
payoff for stateless resources. Apply where it solves a real
correctness problem (cross-contamination of auth-bearing state), not
as a religion.

### The rule, stated honestly

**For resources that hold auth-bearing state: encode principal in
construction; never read principal from ambient context for
authorization decisions.**

For everything else: take the simplest shape that fits — substrate
primitives stay singletons, session-scoped state lives in
session-scoped objects, principal lives in keys / session identity /
explicit parameters.

---

## Dual-typed tool handlers

```ts
type ToolHandler<I> =
  | ((input: I, deps: ToolDeps) => readonly ContentBlock[] | Promise<readonly ContentBlock[]>)
  | ((input: I, deps: ToolDeps) => Effect.Effect<readonly ContentBlock[], McpClientError>);
```

The executor discriminates at the call site:

```ts
// In @agentick/tool-executor:
const result = handler(input, deps);
if (Effect.isEffect(result)) {
  return yield * result;
}
return yield * Effect.tryPromise(() => Promise.resolve(result));
```

**Server-side convention** — wherever adopter code crosses into framework
substrate (tool handlers, middleware, hooks, capability handlers),
the type accepts both Promise-returning and Effect-returning shapes.
The executor / dispatch site handles both uniformly.

**Client-side stays Promise-only.** The client SDK is RPC + state; there's
no substrate to cross into. UI code uses Promises + (optionally) the
deps-passed `ctx` for diagnostic state.

### Why dual-type instead of Effect-only

- **Most tools are simple.** `async (input, deps) => [{...}]` is the
  natural authoring shape. Forcing Effect would impose ceremony where
  none is warranted.
- **Effect-adopters get full power.** Typed errors, FiberRef
  propagation, structured concurrency — all available when the
  handler returns Effect.
- **Lift helpers bridge the gap.** Adopters who want explicit Effect
  typing without writing `Effect.gen` use `liftHandler(async ...)`.
  The lift is purely shape-shifting — no runtime cost beyond the
  `Effect.tryPromise` wrap that would happen at the executor anyway.

---

## What `Operation.scope` keeps (and gives up)

Reviewed against the actual code; the prior draft was wrong to propose
collapse. Decision after correction:

**Keep `Operation.scope: EventScope`.** EventScope is the per-operation
routing/filtering identity (sessionId/sandboxId/mcpConnectionId/etc.).
Subscribers filter by it; the journal records it; the cluster
serializes it. Operations carry their own EventScope because each
operation knows where it was MADE TO RUN — that's not derivable from
ambient context alone (e.g., a sandbox operation knows it's a sandbox
op; the session running it may have multiple sandboxes).

**Auto-derive `Operation.parentOpId` and `Operation.correlationId`
from ambient RuntimeContext when not set by the caller.** Already done
for `parentOpId` (see `base-harness.ts` lines 469-473); extend the
pattern to `correlationId`. This is a small ergonomics win, not the
big collapse the prior draft proposed.

**The relationship between `Operation.scope` (EventScope) and
RuntimeContext is one of derivation.** `runOperation` reads
`Operation.scope`, projects the shared fields into a RuntimeContext,
writes that to the FiberRef:

```ts
// In runOperation:
const ambient = yield * getContext;
const ctxFromOp: RuntimeContext = {
  // EventScope fields auto-inherited via the extends relationship:
  ...op.scope,
  // Op-level state from the operation itself:
  opId: op.opId,
  parentOpId: op.parentOpId ?? ambient.opId,
  correlationId: op.correlationId ?? ambient.correlationId,
};
return yield * withContext(ctxFromOp, body(op.input));
```

EventScope is canonical. RuntimeContext is EventScope + op-level state

- diagnostic ephemera. `runOperation` bridges them.

---

## What `RuntimeContext.request` becomes

```ts
// REMOVED:
//   readonly request?: Readonly<Record<string, unknown>>;

// REPLACED WITH:
readonly user?: RuntimeContextUser;
```

`RuntimeContextUser` is empty-seed module-augmentable — exactly the same
pattern as v1's `UserContext`. Adopters augment:

```ts
declare module "@agentick/spec" {
  interface RuntimeContextUser {
    readonly tenantId: string;
    readonly userId: string;
    readonly requestId?: string;
    readonly featureFlags?: Readonly<Record<string, boolean>>;
  }
}

// Now:
const scope = readContext();
scope.user?.tenantId; // typed, autocompletes in IDE
```

Adopters putting `userId` in here are using it for THEIR OWN telemetry /
branching / logging — NOT for framework authorization. The framework's
auth-bearing primitives (MCP harness identity, sandbox identity, etc.)
do not consult `ctx.user`.

---

## What we considered and rejected

### ALS coupling

Proposed in the first draft as the propagation backbone. Rejected after
analysis:

- **Node-tie.** ALS works in Node, Bun (via `node:async_hooks`), Deno
  (Node compat). Browsers: no. TC39 `AsyncContext` is years out.
- **Worker-thread caveat.** ALS doesn't propagate across worker threads
  — would create surprising behavior for adopters dispatching to worker
  pools.
- **Library-break risk.** Some callback-based libraries break the ALS
  chain. Hard to audit, easy to miss.
- **Solves a problem we mostly don't have.** Closure-capture-via-deps
  handles 90% of adopter cases. Effect-typed substrate handles the
  rest. Structural identity handles auth. The residual is diagnostic
  ambient state — not worth the substrate complexity.
- **`readContext()` already broken inside fibers.** Even with ALS,
  inside-Effect-fiber sync reads would still need the FiberRef route.
  Two propagation substrates to keep in sync = double the failure modes.

If a real need emerges (third-party library deeply integrated with
adopter code where ambient context truly is required), revisit with
TC39 `AsyncContext` as the target — it's the runtime-agnostic answer
when the standard ships.

### Sync `runWithContext` primitive

Proposed in the first draft + originally scoped as #284. Rejected:

- **Impossible on FiberRef alone.** `Effect.runSync(withContext(scope,
Effect.sync(fn)))` doesn't propagate FiberRef to nested
  `Effect.runSync(getContext)` inside `fn`. That's the very gap that
  drove this ADR. Pretending otherwise creates silent failure.
- **ALS would solve it but we're not shipping ALS.** See above.
- **`withContext` inside Effect is sufficient.** Substrate code that
  needs scoped writes uses Effect-typed `withContext(scope, eff)`.
  Adopter code that needs scoped writes either: (a) wraps in
  `Effect.runPromise(withContext(...))` if they're already at an
  Effect entry point, OR (b) doesn't need it — they have `ctx` as a
  parameter and closure-capture handles propagation.

### Operation.scope collapse

Proposed in the first draft. Rejected after reading the actual code:

- **EventScope is richer than RuntimeContext.** It carries
  routing-identity dimensions (appId, sandboxId, mcpConnectionId,
  spawnPath, etc.) that don't belong in RuntimeContext.
- **Per-operation scope is the right abstraction.** Each operation
  knows where it was MADE TO RUN. That's not derivable from ambient
  context (an outer session may host multiple sandboxes; the sandbox
  op's scope is the SANDBOX's identifier).
- **`runOperation` already does the right thing.** Reads Operation.scope,
  derives RuntimeContext, writes to FiberRef. No collapse needed.

### Universal "identity is structural" rule

Proposed in the first draft. Rejected as overclaim:

- **Stateless / diagnostic resources don't benefit.** CredentialsHarness,
  ToolExecutor, loggers, tracers — instantiating per-principal would
  be N×waste with no correctness payoff.
- **Cross-cutting concerns can't structurally encode principal.** A
  logger for "user-42's logs" is awkward; principal-as-tag is fine
  for telemetry.
- **The rule is for auth-bearing state.** Narrower scope, stronger
  guarantee where it applies.

---

## Migration plan (revised #284 scope)

The implementation work shrinks substantially from the first draft.

### Phase A — type changes (small, mostly mechanical)

1. **Add `EventScopeExtensions` empty seed.** Spec-next.
2. **Migrate `sandboxId` from EventScope to sandbox-next augmentation.**
   Move the field; add `declare module` in sandbox-next/augment.ts.
3. **Migrate `mcpConnectionId` from EventScope to mcp-next augmentation.**
   Same pattern — add to mcp-next/augment.ts (client subpath) and
   mcp-next/server/augment.ts.
4. **Define `RuntimeContext` as `extends EventScope`.** Move from
   runtime-next/substrate/runtime-context.ts to spec-next/data/runtime-context.ts
   for visibility.
5. **Add `RuntimeContextUser` empty seed.** Spec-next.
6. **Drop `RuntimeContext.request`.** Replaced with `user?: RuntimeContextUser`.
7. **Sweep callsites.** Any code reading `ctx.request?.X` either
   (a) moves to `ctx.user?.X` after the adopter augments, or
   (b) gets refactored to receive the value via explicit parameter.

### Phase B — lift helpers

1. **Ship `liftToEffect` in `@agentick/utils`.** The generic lift.
2. **Ship `liftHandler` in `@agentick/tool`.** Specific to
   ToolHandler. Captures ctx from FiberRef + passes to handler via deps.
3. **Ship `liftMiddleware`, `liftHook`, etc.** Mirroring pattern for
   each adopter-facing surface.

### Phase C — dual-typed tool handlers

1. **Widen `ToolHandler` type union.** Effect return arm added.
2. **Update tool-executor to discriminate.** `Effect.isEffect(result)`
   branch.
3. **Tests cover both shapes.** Round-trip from each.

### Phase D — `readContext()` honesty + audit

1. **Update `readContext()` JSDoc with honest contract.** Inside-Effect
   limits documented.
2. **Audit substrate code for `Effect.runSync` callsites.** Each
   classified: substrate edge (keep) or nested misuse (replace with
   `yield* eff`).
3. **Audit `readContext()` callsites.** Each classified: outside Effect
   (keep), inside Effect (replace with `yield* getContext`), inside a
   handler with `ctx` available via deps (refactor to use the param).

### What this ADR does NOT ship

- ALS coupling (rejected — see "considered and rejected").
- Sync `runWithContext` (rejected — see "considered and rejected").
- The full sweep of callsites (#290) — that's a separate ticket; this
  ADR ships the discipline, individual sweeps happen incrementally.

---

## Lint rules worth considering

To keep the discipline in place:

1. **Forbid `Effect.runSync` outside an allowlist of entry-point
   files.** Allowlist = `runtime-next/substrate/runtime-context.ts`
   (`readContext`), `runtime-next/substrate/base-harness.ts` (operation
   driver), tool-executor's top-level run, any other substrate edge.

2. **Forbid `readContext()` inside `Effect.gen` blocks.** False
   positives rare; the two surfaces are semantically distinct.

3. **Warn on `RuntimeContext.request` reads** (after the field is
   removed — the lint catches stale code post-migration).

4. **Warn on `Operation.scope.sessionId` reads where
   `(yield* getContext).sessionId` would work better** — soft pattern.

Custom oxlint rules, narrow scope. Land alongside Phase A.

---

## Open questions

### 1. What happens to `runWithContext` / `runWithContextAsync` exports

The current `runtime-context.ts` documents these as "not shipped on
FiberRef alone" — see the existing NOTE block. With this ADR, they
stay unshipped. Existing callers either:

- (a) Use `withContext(scope, effect)` inside Effect (the right pattern).
- (b) Receive `ctx` as a parameter (closure-capture).
- (c) Refactor to enter Effect-land at the boundary
  (`Effect.runPromise(withContext(scope, eff))`).

No public API change beyond the rejected sync primitive.

### 2. Per-field journaling of `RuntimeContextUser`

The adopter `user` bag may contain PII. Default journal serialization:
**exclude `user` by default; opt-in via `journalingPolicy.includeUserContext`
or per-field selectors.**

### 3. `RuntimeContext` discoverability for new contributors

`RuntimeContextUser` augmentation is loudly documented in:

- `@agentick/runtime/README.md` (full section + worked example)
- JSDoc on `RuntimeContextUser` itself (example block + warning that
  framework auth doesn't consult `ctx.user`)
- `docs/proposals/v2/blueprint/00-overview.md` mentions adopter
  extension story

### 4. Audit cadence

The sweep of `Effect.runSync` + `readContext()` callsites happens
incrementally — each package's typecheck + tests are the gate. The
lint rules (when added) catch regressions automatically.

---

## Cross-references

- ADR 26 — Harness API shape (the BaseHarness pattern that operations
  flow through)
- ADR 27 — Modular built-ins (the empty-seed module-augmentation
  convention `EventScopeExtensions` + `RuntimeContextUser` mirror)
- ADR 34 — Scoped capability cascade (how policies layer across
  app/session/tick — RuntimeContext is the cascade carrier)
- ADR 41 — Error hierarchy (typed errors that respect Effect's `E`
  channel — dual-typed handlers inherit this discipline)
- ADR 43 — Unified tool-handler ctx (the `ToolHandlerCtx` that becomes
  dual-typed in this ADR)
- #277 — MCP connection-status + credentials integration (the driver
  that surfaced the propagation gap)
- #284 — runtime-next runtime-context implementation (the work this
  ADR specifies, revised scope after corrections)
- #288 — narrow `RuntimeContext.request` (becomes part of Phase A here)
- #289 — principal-bearing harnesses construct per-principal (the
  rule this ADR codifies — applies where structural identity is right)
- #290 — async-boundary capture-replay sweep (the residual sweep, less
  urgent now that closure-capture is the primary pattern)
