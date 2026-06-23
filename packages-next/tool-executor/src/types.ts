/**
 * Tool executor runtime types.
 *
 * Handler signatures + validator interfaces moved to `@agentick/spec-next`
 * (data/tool-handler.ts + data/validator.ts) so the authoring layer
 * (`@agentick/tool-next`) can consume them without depending on this
 * runtime package. Re-exported here for backwards-compat with code
 * that imports the names from `@agentick/tool-executor-next`.
 *
 * Genuinely runtime-only types — `HandlerEntry`, `HandlerResolver`,
 * `ToolExecutorHarnessOptions` — stay here. They reference runtime
 * impls (the resolver class, the channel publisher) and have no
 * business being in the spec.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import type {
  ChannelPublisher,
  ElicitationHarnessProtocol,
  TasksHarnessProtocol,
  ToolHandler,
  ToolRegistration,
  Validator,
} from "@agentick/spec-next";

// Re-export the moved types so existing import paths keep working.
export type {
  HandlerChannelSeed,
  ToolHandler,
  ToolHandlerCtx,
  ToolHandlerResult,
  Validator,
  ValidatorResult,
} from "@agentick/spec-next";

// ============================================================================
// Handler resolver
// ============================================================================

/**
 * One entry in the handler resolver — the actual function + the
 * compiled validator. Both come from outside the spec firewall.
 */
export interface HandlerEntry {
  readonly handler: ToolHandler;
  readonly validator: Validator;
}

/**
 * Resolves a `handlerRef` (string carried across the spec firewall) to
 * an executable {@link HandlerEntry}. The reference impl is
 * {@link import("./handler-resolver.js").InMemoryHandlerResolver}; gateway
 * deployments may substitute a cluster-aware resolver.
 */
export interface HandlerResolver {
  /** Return the handler entry for a given ref, or `undefined` if unknown. */
  resolve(handlerRef: string): HandlerEntry | undefined;
}

// ============================================================================
// Harness construction options
// ============================================================================

export interface ToolExecutorHarnessOptions {
  /**
   * Resolves `handlerRef` to a concrete handler + validator. The
   * reference impl (`InMemoryHandlerResolver`) lives in this package.
   */
  readonly handlerResolver: HandlerResolver;

  /**
   * Pre-registered tools applied before the inbox accepts traffic.
   * Equivalent to calling `register()` for each entry once `ready`
   * resolves — but synchronous, so callers don't have to interleave
   * `await`s.
   */
  readonly initialTools?: readonly ToolRegistration[];

  /**
   * Default per-dispatch timeout (milliseconds). Overridden by
   * `DispatchInput.timeoutMs` and `tool.annotations.timeout`.
   */
  readonly defaultTimeoutMs?: number;

  /**
   * Optional channel publisher. When set, `ctx.emit(seed)` calls from
   * tool handlers route through this publisher.
   */
  readonly channelPublisher?: ChannelPublisher;

  /**
   * Default confirmation-wait timeout (milliseconds) applied when a
   * tool with `annotations.requiresConfirmation` is dispatched and no
   * tighter override is in scope. `undefined` defers to the
   * ElicitationHarness's own `defaultTimeoutMs` (5 minutes).
   */
  readonly defaultConfirmationTimeoutMs?: number;

  /**
   * Elicitation harness used by the confirmation gate. Required:
   * tools annotated `requiresConfirmation: true` round-trip through
   * `elicitation.elicit(...)` instead of rolling their own channel.
   *
   * ALSO surfaced on `ctx.elicitation` for raw tool handlers that
   * want to ask the user for input mid-handler. Substrate primitive
   * present on every session — direct access without the JSX
   * `use:` ceremony.
   *
   * Wiring: in production, the session-extension layer constructs the
   * elicitation harness on the same substrate (shared bus/inbox) and
   * passes its protocol reference here. In tests, `createTestHarness`
   * builds both on a shared in-memory substrate.
   */
  readonly elicitation: ElicitationHarnessProtocol;

  /**
   * Tasks harness — optional today (every session has one once
   * `withTasks()` is in the extension list; gated on adopter
   * setup). Surfaced on `ctx.tasks` so handlers can `submit()`
   * long-running work. ToolExecutor also uses it to detect handler
   * returns of shape `TaskHandle` and branch on `taskSupport` (#156,
   * Pattern B behavior).
   *
   * When omitted: `ctx.tasks` is `undefined`; handlers must
   * null-coalesce. The `taskSupport` annotation default
   * (`"unsupported"`) means tasks are never used by sync tool paths,
   * so omission is safe for adopters who don't need long-running
   * tools.
   */
  readonly tasks?: TasksHarnessProtocol;
}
