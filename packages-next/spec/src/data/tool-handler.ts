/**
 * Tool handler runtime types.
 *
 * Sits in `@agentick/spec-next` because it's the shape of every
 * implementation a tool-author or harness adopts. Pure interface
 * declarations — no executable code in this file. Validators and
 * resolver impls (which carry code) stay in `@agentick/tool-executor-next`
 * and `@agentick/tool-next` respectively.
 *
 * `[V1-INHERITED, REFINED]` from v1's `ToolHandler` + `ToolHandlerContext`.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import type { Effect } from "effect";

import type { ContentBlock } from "./content-blocks.js";

// ============================================================================
// Channel emit seed
// ============================================================================

/**
 * Subset of {@link import("../protocol/channels.js").ChannelEvent} the
 * tool handler context emits. The session harness materializes the
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
 *   Used by the stateful tool pattern.
 * - `emit(seed)`: surface a session channel event seed. The tool
 *   executor doesn't sequence channels — the session harness wires
 *   this through to the bus on its end.
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
 *   2. **Promise** — `Promise<readonly ContentBlock[]>`
 *   3. **Effect** — `Effect<readonly ContentBlock[], unknown, never>`
 *
 * Effect-typed handlers are preferred for retry / timeout / structured
 * concurrency / finalizers. Promise/sync forms remain supported.
 *
 * The first argument is validated input (`unknown` at the harness
 * boundary — the validator narrows). The second is the per-dispatch
 * dependency bundle: `ctx` (harness-provided) and `use` (render-time
 * deps captured by the reconciler).
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
