/**
 * `RuntimeContext` — the pure-data causality/identity core (ADR 45/91).
 *
 * The trunk of the ctx spine (ADR 91): a spec-resident, dependency-free,
 * frozen-data record that every boundary context derives from. It extends
 * `EventScope` (the canonical event-routing identity coordinates) with
 * operation-level identity, diagnostic ephemera, and an adopter-augmentable
 * `user` slot. It carries **zero runtime dependencies** — no closures, no
 * Effect, no FiberRef — which is why it lives here in spec and not in
 * `@agentick/runtime` (ADR 91 §1 moved it out of the runtime substrate).
 *
 * The FiberRef PROPAGATION machinery (`RuntimeContextRef` / `getContext` /
 * `withContext` / `readContext`) stays in `@agentick/runtime` — spec owns the
 * TYPE, runtime owns the MECHANISM. The capability facets
 * (`Observability` = `log`/`trace`/`metrics`, `Ops` = `run`/`runner`) are
 * DERIVED from this data at a boundary crossing (see `deriveContext` in
 * runtime), never serialized and never on the trunk.
 *
 *   - **Inside Effect**: substrate code reads via `yield* getContext` and
 *     scopes via `withContext(scope, effect)`. FiberRef-backed.
 *   - **Outside Effect** (adopter tool handlers, middleware, hooks):
 *     receive `ctx` as a parameter (ADR 43); JS closure semantics propagate
 *     it through any async chain the function authors.
 *
 * Per ADR 45/91 — see `docs/proposals/v2/blueprint/45-runtime-context-model.md`
 * and `docs/proposals/v2/blueprint/91-ctx-spine.md`.
 *
 * @see EventScope (the canonical identity coordinates this extends)
 * @see RuntimeContextUser (the adopter-augmentable extension slot)
 */

import type { EventScope } from "./events.js";
import type { Observability } from "./observability.js";
import type { Ops } from "./ops.js";

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
 *     declare module "@agentick/spec" {
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
 * Mirrors the `HookBridges` / `EventScopeExtensions` empty-seed convention.
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
// The composed boundary shape (ADR 91 §1 — "that intersection IS the spine")
// ============================================================================

/**
 * `OperationCtx` — the trunk + the two capability facets: the canonical
 * boundary-context shape every framework handler/callback seam receives
 * (ADR 91 §1). It is exactly {@link RuntimeContext} (causality/identity data)
 * intersected with {@link Observability} (`log`/`trace`/`metrics`) and
 * {@link Ops} (`run`/`runner`) — the derived facets a boundary crossing
 * attaches over the pure-data trunk.
 *
 * This is the ONE name for that intersection: seams (`ResourceResolver`,
 * `PromptDeclaration.render`, `CompletionContext`, `TaskWorkContext`, …) and
 * the runtime `deriveContext` all reference `OperationCtx` rather than
 * re-writing `RuntimeContext & Observability & Ops` at each site. The
 * runtime's `InterceptorCtx` is the same intersection under its own boundary
 * name.
 *
 * A boundary ctx that additionally carries boundary-specific facets is
 * `OperationCtx & <boundary facets>`. The branded, framework-minted form is
 * `Derived<OperationCtx>` (or `Derived<OperationCtx & X>`) — see
 * {@link Derived}.
 *
 * @see docs/proposals/v2/blueprint/91-ctx-spine.md §1
 */
export type OperationCtx = RuntimeContext & Observability & Ops;

// ============================================================================
// The derivation brand (ADR 91 §Enforcement)
// ============================================================================

declare const DERIVED: unique symbol;

/**
 * The nominal brand a boundary context earns by passing through the runtime's
 * `deriveContext` — the ONLY sanctioned producer (ADR 91). The brand's symbol
 * is module-private and unexported, so a `{}`-shaped hand-assembled bag cannot
 * satisfy `Derived<C>` structurally; a framework seam-invocation site typed to
 * accept `Derived<C>` therefore rejects a fabricated ctx at COMPILE time. The
 * brand is purely type-level (no runtime property) — `deriveContext` stamps it
 * with a single `as Derived<C>` cast; adopter handler signatures keep the plain
 * interfaces (a branded value satisfies a plain one — zero adopter friction).
 *
 * @see docs/proposals/v2/blueprint/91-ctx-spine.md §Enforcement
 */
export type Derived<C> = C & { readonly [DERIVED]: true };
