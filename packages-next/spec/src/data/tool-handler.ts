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
 * - `elicitation`: the session's `ElicitationHarnessProtocol`. Use to
 *   ask the user for input mid-handler (`ctx.elicitation.elicit(...)`).
 *   Substrate primitive present on every session — direct access
 *   here rather than the JSX `use:` ceremony.
 * - `tasks`: the session's `TasksHarnessProtocol`. Use to spawn
 *   managed long-running work (`ctx.tasks.submit(...)`). Same
 *   "substrate primitive on ctx" rationale as elicitation.
 *
 * Substrate-primitive slots vs `use:` slots — the rule:
 * framework-provided harnesses that EVERY session has (elicitation,
 * tasks, and future sampling/roots when those bridges ship) live on
 * `ctx`. Extension-provided / provider-scoped things (sandbox
 * bridge, custom MCP refs) flow through the JSX `use:` capture.
 */
export interface ToolHandlerCtx {
  readonly toolCallId: string;
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  readonly signal: AbortSignal;
  setState(key: string, value: unknown): void;
  emit(seed: HandlerChannelSeed): void;
  /**
   * The session's elicitation harness. `undefined` only on
   * substrate-stripped test fixtures; production sessions always
   * have one. Cast / null-coalesce if you're in a test that omits
   * it.
   */
  readonly elicitation?: import("../protocol/elicitation-harness.js").ElicitationHarnessProtocol;
  /**
   * The session's tasks harness. `undefined` only on
   * substrate-stripped test fixtures.
   */
  readonly tasks?: import("../protocol/tasks-harness.js").TasksHarnessProtocol;
  /**
   * Caller-resolved task mode for THIS dispatch. Mirrors
   * `DispatchInput.task` after defaulting (`"auto"` when omitted).
   * Handlers that have a sync-or-task choice — paradigm case is an
   * MCP `taskSupport: "supported"` tool whose wire opt-in is per
   * call — branch on this to route through `ctx.tasks.submit(...)`
   * versus a sync wire op.
   *
   *   `"auto"`   — caller didn't specify; executor's host/model
   *                heuristics decide the surface (Pattern A vs B).
   *                For `supported` tools, handler MAY default to
   *                inline.
   *   `"ref"`    — caller explicitly asked for Pattern B; handler
   *                MUST return a `TaskHandle` (executor serializes
   *                a {@link TaskRefBlock}).
   *   `"inline"` — caller explicitly forbids task mode; handler
   *                MUST return blocks (no `TaskHandle`).
   *
   * Conflicts (e.g. `"ref"` against an `"unsupported"` tool) are
   * pre-flight rejected by the executor before the handler runs,
   * so handlers never see contradictory `task` × `taskSupport`
   * combinations.
   */
  readonly task: "auto" | "ref" | "inline";
}

// ============================================================================
// Handler shape
// ============================================================================

/**
 * Tool handler bodies may return any of four shapes:
 *
 *   1. **Sync** — `readonly ContentBlock[]`
 *   2. **Promise** — `Promise<readonly ContentBlock[]>`
 *   3. **Effect** — `Effect<readonly ContentBlock[], unknown, never>`
 *   4. **TaskHandle** — `TaskHandle<readonly ContentBlock[]>` (the
 *      handler `submit`-ed long-running work via `ctx.tasks.submit`
 *      and returned the handle). The executor branches on the
 *      tool's `taskSupport` annotation:
 *      - `"unsupported"` (default) or undef → executor awaits
 *        `handle.result` transparently. Model sees the eventual
 *        blocks; never sees the taskId.
 *      - `"required"` → executor serializes the task ref
 *        (`{taskId, status, ttl?, statusMessage?}`) and returns it
 *        to the model as a typed content block. Model uses
 *        `tasks.list / get / cancel / await` to manage the task
 *        across subsequent ticks.
 *      - `"supported"` → caller-choice; landed in a follow-up
 *        slice.
 *
 * Effect-typed handlers are preferred for retry / timeout /
 * structured concurrency / finalizers. Promise/sync forms remain
 * supported.
 *
 * The first argument is validated input (`unknown` at the harness
 * boundary — the validator narrows). The second is the per-dispatch
 * dependency bundle: `ctx` (harness-provided) and `use` (render-time
 * deps captured by the reconciler).
 */
export type ToolHandlerResult =
  | readonly ContentBlock[]
  | Promise<readonly ContentBlock[]>
  | Effect.Effect<readonly ContentBlock[], unknown, never>
  | import("../protocol/tasks-harness.js").TaskHandle<readonly ContentBlock[]>
  | Promise<import("../protocol/tasks-harness.js").TaskHandle<readonly ContentBlock[]>>
  | Effect.Effect<
      import("../protocol/tasks-harness.js").TaskHandle<readonly ContentBlock[]>,
      unknown,
      never
    >;

export type ToolHandler = (
  input: unknown,
  deps: {
    readonly ctx: ToolHandlerCtx;
    readonly use: Readonly<Record<string, unknown>>;
  },
) => ToolHandlerResult;
