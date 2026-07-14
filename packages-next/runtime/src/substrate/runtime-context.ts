/**
 * RuntimeContext — ambient scope identity propagated through Effect fibers.
 *
 * Extends `EventScope` (the canonical event-routing identity coordinates,
 * declared in `@agentick/spec-next/data/events.ts`) with operation-level
 * state, diagnostic ephemera, and an adopter-augmentable `user` slot.
 *
 *   - **Inside Effect**: substrate code reads via `yield* getContext` and
 *     scopes via `withContext(scope, effect)`. FiberRef-backed.
 *   - **Outside Effect** (adopter tool handlers, middleware, hooks):
 *     receive `ctx` as a deps parameter (per ADR 43); JS closure semantics
 *     propagate it through any async chain the function authors. Do NOT
 *     call `readContext()` inside an active Effect fiber — nested
 *     `Effect.runSync` starts a fresh root fiber that doesn't inherit
 *     the outer's FiberRef. Use `yield* getContext` inside Effect.
 *
 * Per ADR 45 — see `docs/proposals/v2/blueprint/45-runtime-context-model.md`.
 *
 * @see EventScope (the canonical identity coordinates this extends)
 * @see RuntimeContextUser (the adopter-augmentable extension slot)
 */

import { Effect, FiberRef } from "effect";

import type { EventScope } from "@agentick/spec-next";

// ============================================================================
// Adopter extension slot
// ============================================================================

/**
 * Empty-seed augmentation slot for adopter-defined ambient state on
 * {@link RuntimeContext}. Adopter app code augments via module
 * declaration:
 *
 * @example
 *     // In your app's setup:
 *     declare module "@agentick/runtime-next" {
 *       interface RuntimeContextUser {
 *         readonly tenantId: string;
 *         readonly userId: string;
 *         readonly requestId?: string;
 *         readonly featureFlags?: Readonly<Record<string, boolean>>;
 *       }
 *     }
 *
 *     // Then anywhere ctx is in scope:
 *     async (input, { ctx }) => {
 *       const tenant = ctx.user?.tenantId;  // typed!
 *       // ...
 *     };
 *
 * Mirrors v1's `UserContext` augmentation pattern + the v2
 * `HookBridges` / `EventScopeExtensions` empty-seed convention.
 *
 * ⚠️  **The framework's auth-bearing primitives do NOT consult
 * `ctx.user` for authorization decisions.** Per ADR 45's structural-
 * identity rule, principal-bearing resources (MCP client harness,
 * sandbox runtime, etc.) encode the principal in their construction
 * identity. Adopters MAY put `userId` / `tenantId` in `ctx.user` for
 * their OWN telemetry / branching / logging, accepting that ambient
 * context across plain-async boundaries is best-effort (closure
 * capture handles 90% of cases; ambient-via-FiberRef breaks at
 * Promise boundaries).
 *
 * @see docs/proposals/v2/blueprint/45-runtime-context-model.md
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RuntimeContextUser {}

// ============================================================================
// Scope shape
// ============================================================================

/**
 * The runtime scope a handler / middleware / observer sees. Extends
 * {@link EventScope} (with all augmented harness identifiers like
 * `sandboxId`, `mcpConnectionId`) and adds operation-level state +
 * diagnostic ephemera + adopter extension.
 *
 * Every field is optional — outside any active bracket they are
 * `undefined`. Adopters reading framework-typed fields should treat
 * `undefined` as "no active scope of this kind."
 */
export interface RuntimeContext extends EventScope {
  // ── Operation-level identity (NOT in EventScope because envelopes
  //    already carry opId at the top level; the runtime version is for
  //    code that wants to read "what's my current op" without unpacking
  //    an envelope) ─────────────────────────────────────────────────

  readonly opId?: string;
  /** Parent operation id for causality. */
  readonly parentOpId?: string;
  /**
   * The current operation's command SUFFIX (ADR 83 amendment) — the Pascal
   * key `deriveHookNames` yields for `op.name` (e.g. `"tool:command:dispatch"`
   * → `"ToolDispatch"`). Set by `runOperation` for the op's lifetime. An
   * `on<Command>` middleware (a hook desugared onto the shared `.use` chain via
   * `scopeToCommand`) self-scopes by comparing `ctx.op` to its command — the
   * per-middleware replacement for the old keyed `Hooks` map lookup.
   */
  readonly op?: string;

  // ── Diagnostic ephemera (per-request bundle, OTel trace context) ───

  /** Request bundle id when one user request spawns many ops. */
  readonly correlationId?: string;
  /** W3C TraceContext header value when present. */
  readonly traceparent?: string;

  // ── Adopter extension (typed via module augmentation) ──────────────

  /**
   * Adopter-defined per-call ambient state. Typed via
   * {@link RuntimeContextUser} module augmentation.
   *
   * Framework primitives do NOT read this for authorization. Adopters
   * use it for telemetry, logging, branching, request correlation —
   * whatever fits the propagation guarantees (closure-capture is
   * sufficient for code-controlled async chains; ambient is
   * best-effort).
   */
  readonly user?: RuntimeContextUser;
}

/** The "no scope active" value. */
export const EMPTY_CONTEXT: RuntimeContext = Object.freeze({});

// ============================================================================
// FiberRef substrate
// ============================================================================

/**
 * The FiberRef that holds the active runtime context. Substrate-
 * internal; `getContext` / `withContext` are the documented surface.
 */
export const RuntimeContextRef = FiberRef.unsafeMake<RuntimeContext>(EMPTY_CONTEXT);

/** Effect-native read. */
export const getContext: Effect.Effect<RuntimeContext> = FiberRef.get(RuntimeContextRef);

/**
 * Synchronous accessor for the active runtime context.
 *
 * ## Honest contract
 *
 * **Works correctly:**
 *   - Called from raw JS at the top of a chain where the runtime has
 *     been set via a single `withContext(...)` scope that wraps the
 *     synchronous portion of the call (rare in v2; the substrate
 *     usually keeps context inside Effect chains).
 *
 * **Does NOT work as expected — returns `EMPTY_CONTEXT`:**
 *   - Called from INSIDE an active Effect fiber. Internally runs
 *     `Effect.runSync(getContext)` — that nested `runSync` starts a
 *     FRESH root fiber that does NOT inherit the outer fiber's
 *     FiberRef state. Use `yield* getContext` inside Effect chains.
 *   - Called from inside a Promise chain that's being awaited by an
 *     Effect (via `Effect.tryPromise`). The Promise's continuation
 *     runs outside the fiber; FiberRef is invisible there.
 *
 * **Preferred patterns** (per ADR 45):
 *   - **Adopter code**: receive `ctx` as a parameter via deps. JS
 *     closure semantics propagate ctx through any async chain you
 *     author. No `readContext()` call needed inside the body.
 *   - **Substrate code**: use `yield* getContext` inside Effect
 *     chains. Effect-native, fiber-aware, works correctly.
 *   - **Lifting between worlds**: use `liftHandler` / `liftToEffect`
 *     to capture ctx from FiberRef at lift time and thread it
 *     through deps to a plain-async handler.
 *
 * `readContext()` exists for the narrow case where neither pattern
 * fits — top-level subscribers / plugin hooks with fixed signatures
 * that don't receive deps. Use sparingly. Prefer refactoring the
 * callsite to receive ctx explicitly.
 *
 * @see docs/proposals/v2/blueprint/45-runtime-context-model.md
 */
export function readContext(): RuntimeContext {
  try {
    return Effect.runSync(getContext);
  } catch {
    return EMPTY_CONTEXT;
  }
}

/**
 * Run an Effect with the supplied scope merged into the ambient
 * runtime context. Visible to nested reads via `getContext`.
 *
 * Merge rule: inner wins on collision. Partial scope — only the
 * fields you specify are overlaid; unspecified fields keep their
 * ambient values.
 */
export function withContext<R, E, A>(
  scope: Partial<RuntimeContext>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const current = yield* FiberRef.get(RuntimeContextRef);
    const merged: RuntimeContext = { ...current, ...scope };
    return yield* Effect.locally(RuntimeContextRef, merged)(effect);
  });
}

// NOTE: `runWithContext` / `runWithContextAsync` — the v1 `Context.run(...)`
// sync-scoped-set analogs — are deliberately NOT shipped. Per ADR 45:
//
//   `Effect.runSync(withContext(scope, Effect.sync(fn)))` looks like
//   it should work but doesn't — the nested `Effect.runSync(getContext)`
//   inside `readContext()` starts a fresh fiber that doesn't inherit
//   the outer's locally-scoped FiberRef value. Faithfully imitating
//   v1's ALS-based Context.run would require AsyncLocalStorage as a
//   parallel substrate the FiberRef stays in sync with.
//
// The v2 design rejects ALS coupling — Node-tie, worker-thread caveat,
// cross-runtime portability cost — in favor of closure-capture-via-deps
// (the primary propagation pattern for adopter code) plus FiberRef-
// native propagation inside Effect chains. See:
//
//   docs/proposals/v2/blueprint/45-runtime-context-model.md — §"What
//   we considered and rejected — sync `runWithContext` primitive."
//
// Callers wanting a scoped sync set should either:
//   (a) Restructure to receive ctx via a deps parameter (closure
//       capture handles propagation through any async work).
//   (b) Enter Effect-land at the boundary:
//       `Effect.runPromise(withContext(scope, eff))`.
