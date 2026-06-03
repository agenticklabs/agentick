/**
 * Substrate factory primitives — ADR 30 §3 §5.
 *
 * Adopters supply substrate to an {@link AppHarness} either as an
 * INSTANCE (shared across all sessions in the app) or as a FACTORY
 * (constructed fresh per session via the recipe). The factory shape
 * captures two needs:
 *
 *  1. **Per-session context.** {@link FactoryDeps} carries the
 *     `sessionId` + `appId` so adopters can route to per-tenant
 *     cluster shards, branch buffer sizes on session shape, etc.
 *
 *  2. **Close semantics.** {@link Lifecycle} lets the factory register
 *     teardown that runs when the session containing the resource
 *     closes. Fresh per-session instances register their own
 *     `close()`; shared cluster resources DON'T register anything —
 *     session-close leaves them alive. The factory decides.
 *
 * The discrimination at the AppHarness slot is `typeof slot ===
 * "function"`: substrate primitives (`EventBus`, `MessageInbox`,
 * `OperationJournal`) are object interfaces and never callable, so any
 * function in a slot is unambiguously a factory.
 *
 * Per-resource factory aliases (`EventBusFactory`, etc.) live next to
 * the resource interfaces (`@agentick/spec/protocol/bus.ts`, etc.) so
 * adopters import them alongside the type they construct.
 *
 * @see docs/proposals/v2/blueprint/30-app-as-recipe.md
 */

// ============================================================================
// FactoryDeps — per-session context handed to factories
// ============================================================================

/**
 * Context exposed to substrate factories at session-construction time.
 * Read-only — factories may branch on these fields but cannot mutate
 * the session before it's constructed.
 *
 * The shape is intentionally minimal in v2.0. Future cluster work may
 * extend with resolved tenant id, shard hints, etc.
 */
export interface FactoryDeps {
  /**
   * The id assigned to the session being constructed. Either adopter-
   * supplied via `createSession({ sessionId })` or framework-generated
   * (`session:${ulid}`).
   */
  readonly sessionId: string;
  /** The id of the host AppHarness. */
  readonly appId: string;
}

// ============================================================================
// Lifecycle — close-registration handle, forward reference to the session
// ============================================================================

/**
 * Close-registration handle handed to substrate factories. Conceptually
 * a forward reference to the session-to-be's close scope: at factory-
 * execution time the session hasn't been constructed yet, but the scope
 * that will eventually become the session's exists.
 *
 * Implementation: internally backed by an `Effect.Scope` attached to the
 * session at construction. `onClose(h)` registers `h` as a finalizer on
 * that scope; `session.close()` closes the scope, firing every
 * registered finalizer in LIFO order with error isolation.
 *
 * Adopters never see Effect — they see `onClose(() => void | Promise<void>)`.
 *
 * @example Fresh per-session bus, session owns close:
 * ```ts
 * const factory: EventBusFactory = (deps, lifecycle) => {
 *   const bus = new LocalEventBus();
 *   lifecycle.onClose(() => bus.close());
 *   return bus;
 * };
 * ```
 *
 * @example Shared cluster bus — no `onClose` call:
 * ```ts
 * const sharedBus = new ClusterEventBus(config);
 * const factory: EventBusFactory = () => sharedBus;
 * // Session-close leaves sharedBus alive for other sessions.
 * ```
 *
 * @see docs/proposals/v2/blueprint/30-app-as-recipe.md §5
 */
export interface Lifecycle {
  /**
   * Register a teardown to run at session-close. Handlers run in LIFO
   * order against registration. Throwing handlers are logged and
   * skipped — a failure in one handler does NOT block subsequent
   * cleanups.
   */
  onClose(handler: () => void | Promise<void>): void;
}

// ============================================================================
// Factory<T> — generic factory shape
// ============================================================================

/**
 * Generic factory: takes per-session context + a close-registration
 * handle, returns the resource (sync or async).
 *
 * Per-resource factory aliases (`EventBusFactory`, `MessageInboxFactory`,
 * `OperationJournalFactory`) extend this with marker properties so the
 * AppHarness slot can disambiguate without relying solely on the
 * type system.
 */
export type Factory<T> = (deps: FactoryDeps, lifecycle: Lifecycle) => T | Promise<T>;
