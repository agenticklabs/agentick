/**
 * Tool executor runtime types.
 *
 * Handler signatures + validator interfaces moved to `@agentick/spec`
 * (data/tool-handler.ts + data/validator.ts) so the authoring layer
 * (`@agentick/tool`) can consume them without depending on this
 * runtime package. Re-exported here for backwards-compat with code
 * that imports the names from `@agentick/tool-executor`.
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
  ToolHandler,
  ToolRegistration,
  Validator,
} from "@agentick/spec";

// Re-export the moved types so existing import paths keep working.
export type {
  HandlerChannelSeed,
  ToolHandler,
  ToolHandlerCtx,
  ToolHandlerResult,
  Validator,
  ValidatorResult,
} from "@agentick/spec";

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
   * tighter override is in scope. `undefined` (the default) means
   * "wait forever".
   */
  readonly defaultConfirmationTimeoutMs?: number;
}
