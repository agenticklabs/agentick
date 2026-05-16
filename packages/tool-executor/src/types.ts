/**
 * Internal types for the tool executor harness.
 *
 * The shapes here are NOT part of `@agentick/spec` — they live above
 * the spec firewall and may carry executable code (validators,
 * handlers, AbortControllers). The spec exposes only JSON-shaped
 * declarations + handler refs.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import type { Effect } from "effect";
import type {
  ContentBlock,
  StandardSchemaIssue,
} from "@agentick/spec";

// ============================================================================
// Channel event (forward-compatible shim)
// ============================================================================

/**
 * Subset of {@link import("@agentick/spec").ChannelEvent} the tool
 * handler context needs to emit. The session harness materializes the
 * full envelope from this seed; the tool executor doesn't own session
 * sequencing.
 */
export interface HandlerChannelSeed {
  readonly name: `session:channel:${string}`;
  readonly payload: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Tool handler context
// ============================================================================

/**
 * Context object passed to every tool handler as the second argument's
 * `ctx` field. Surface the handler is allowed to interact with:
 *
 * - `signal`: the dispatch's `AbortSignal`. Composes the harness-internal
 *   abort + the caller-supplied `DispatchInput.signal`.
 * - `setState(key, value)`: stash arbitrary state under a string key.
 *   Used by the stateful tool pattern (`<Tool render={() => …}>`) so
 *   the render hook can read state set by the handler. The store is
 *   per-harness; it persists across dispatches and is exposed via
 *   `ToolExecutorHarness.getState(key)`.
 * - `emit(seed)`: surface a session channel event seed. The tool
 *   executor doesn't sequence channels — the session harness wires
 *   this through to the bus on its end. In tests, `emit` is the
 *   observable signal that the handler talked back.
 *
 * `[V1-INHERITED, REFINED]` v1 exposed the same fields plus a few that
 * v2 routes through other harnesses (timeline writes, in particular).
 */
export interface ToolHandlerCtx {
  readonly toolCallId: string;
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  readonly signal: AbortSignal;
  setState(key: string, value: unknown): void;
  emit(seed: HandlerChannelSeed): void;
}

// ============================================================================
// Handler shape
// ============================================================================

/**
 * Tool handler bodies may return any of three shapes:
 *
 *   1. **Sync** — `readonly ContentBlock[]`
 *   2. **Promise** — `Promise<readonly ContentBlock[]>` (the v1-compatible
 *      ergonomic; gets scope via `ctx`, abort via `ctx.signal`)
 *   3. **Effect** — `Effect<readonly ContentBlock[], unknown, never>`
 *      (sees the harness's FiberRef via `getContext`, integrates with
 *      `Effect.scoped` finalizers, cancels via fiber interrupt)
 *
 * Effect-typed handlers are the **preferred** form once the body needs
 * retry / timeout / structured-concurrency / finalizers. The Promise
 * form remains supported indefinitely — `createTool` (when it lands)
 * will accept both and dispatch picks the right invocation path.
 *
 * The first argument is the validated input (typed `unknown` at the
 * harness boundary — the validator narrows). The second is the
 * per-dispatch dependency bundle: `ctx` (harness-provided) and `use`
 * (render-time `use:` deps captured by the reconciler).
 */
export type ToolHandlerResult =
  | readonly ContentBlock[]
  | Promise<readonly ContentBlock[]>
  | Effect.Effect<readonly ContentBlock[], unknown, never>;

export type ToolHandler = (
  input: unknown,
  deps: {
    readonly ctx: ToolHandlerCtx;
    readonly use: Readonly<Record<string, unknown>>;
  },
) => ToolHandlerResult;

// ============================================================================
// Validator
// ============================================================================

/**
 * Minimal validator shape the tool executor uses to gate handler input.
 * Returns `value` on success and `issues` on failure — same envelope as
 * Standard Schema's `validate()` so impls can pass a wrapped Standard
 * Schema through directly (see {@link fromStandardSchema}).
 *
 * Async validation is supported — the harness `await`s the result.
 */
export interface Validator {
  validate(
    value: unknown,
  ):
    | ValidatorResult
    | Promise<ValidatorResult>;
}

export type ValidatorResult =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly value?: undefined; readonly issues: readonly StandardSchemaIssue[] };

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

import type { ToolRegistration } from "@agentick/spec";

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
   * Default: undefined (no harness-level timeout — relies on tool /
   * caller for timing-out).
   */
  readonly defaultTimeoutMs?: number;
}
