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
  Resources,
  TasksHarnessProtocol,
  ToolHandler,
  ToolRegistration,
  Validator,
} from "@agentick/spec-next";
import type { Hooks } from "@agentick/runtime-next";

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

  /**
   * Resources harness (ADR 62) — surfaced on `ctx.resource` so tool
   * handlers resolve readable content by URI (`ctx.resource.read(uri)`
   * / `.list()`). Optional today: the AppHarness constructs ONE per
   * session at the single construction site and threads that instance
   * here + into `bridges.resources`, so production always has one; the
   * optional field covers substrate-stripped test fixtures.
   *
   * When omitted: `ctx.resource` is `undefined`; handlers must
   * null-coalesce. Same "substrate primitive on ctx" rationale as
   * {@link tasks} / {@link elicitation}.
   */
  readonly resources?: Resources;

  /**
   * Generic, harness-agnostic `ctx` extension bag (ADR 66). Every
   * key/value here is spread onto the `ctx` passed to every tool
   * handler, surfacing as a top-level `ctx.<key>`. The executor treats
   * the record as OPAQUE — it never imports or inspects the values;
   * their TYPES come from `declare module` augmentations of
   * `ToolHandlerCtxExtensions` in the owning harness packages (e.g.
   * `@agentick/sandbox-next` adds `ctx.sandbox`), and their VALUES are
   * filled by the wiring layer (the AppHarness) from the live bridges.
   *
   * This is what lets an optional harness be dispatch-resolved on `ctx`
   * without the executor depending on it. The reference is injected once
   * at construction, but it points at live bridges — reads inside a
   * handler (`ctx.sandbox.get(...)`) hit the current harness state, not a
   * render-time capture.
   *
   * @see docs/proposals/v2/blueprint/66-tool-dependency-resolution.md
   */
  readonly ctxExtensions?: Readonly<Record<string, unknown>>;

  /**
   * Resolved command lifecycle hooks (ADR 82) — the cascade-folded {@link Hooks}
   * value, forwarded to {@link BaseHarness}. `tool:dispatch` routes through
   * `runOperation`, so `onBefore/AfterToolDispatch` fire against this layer.
   * Defaults to `Hooks.empty`.
   */
  readonly hooks?: Hooks;
}
