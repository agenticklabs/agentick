/**
 * Tool handler runtime types.
 *
 * Sits in `@agentick/spec` because it's the shape of every
 * implementation a tool-author or harness adopts. Pure interface
 * declarations — no executable code in this file. Validators and
 * resolver impls (which carry code) stay in `@agentick/tool-executor`
 * and `@agentick/tool` respectively.
 *
 * `[V1-INHERITED, REFINED]` from v1's `ToolHandler` + `ToolHandlerContext`.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import type { Effect } from "effect";

import type { Elicit } from "../protocol/elicit-api.js";
import type { ContentBlock } from "./content-blocks.js";
import type { Observability } from "./observability.js";
import type { Ops } from "./ops.js";
import type { RuntimeContext } from "./runtime-context.js";
import type { ToolResultInput } from "./tool-result.js";
import type { Progress, ProgressToken } from "./signals.js";

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
 * Empty seed for optional, dispatch-resolved `ctx` slots (ADR 66).
 *
 * Mirrors {@link import("../protocol/hook-bridges.js").HookBridges} and
 * {@link import("./events.js").EventScopeExtensions}: spec declares the
 * empty interface and hardcodes NO optional harness; each optional
 * harness package augments it from its own `augment.ts` via
 *
 *   declare module "@agentick/spec" {
 *     interface ToolHandlerCtxExtensions {
 *       readonly sandbox?: SandboxBridge;
 *     }
 *   }
 *
 * so the slot surfaces as a top-level `ctx.<slot>` field, typed by the
 * augmentation and filled at dispatch by the wiring layer (AppHarness)
 * from the live bridge. The executor stays harness-agnostic — it
 * spreads an opaque `Record<string, unknown>` (`ctxExtensions`) onto
 * every ctx and never imports any harness.
 *
 * @see docs/proposals/v2/blueprint/66-tool-dependency-resolution.md
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ToolHandlerCtxExtensions {}

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
 * - `tools`: the session's `ToolsHandle`. Dispatch a sibling tool by
 *   name (`ctx.tools.dispatch(name, input)`) — the same door and
 *   `"dispatch"` exposure gate as a host-side caller.
 *
 * Substrate-primitive slots vs `use:` slots — the rule:
 * framework-provided harnesses that EVERY session has (elicitation,
 * tasks, and future sampling/roots when those bridges ship) live on
 * `ctx` as hardcoded fields below. OPTIONAL harnesses that not every
 * deployment mounts (sandbox, custom MCP refs) contribute their slot
 * via module augmentation of {@link ToolHandlerCtxExtensions} (ADR 66)
 * and are dispatch-resolved from the live bridge — NOT captured at
 * render through the JSX `use:` bag. `use:` is now reserved for
 * genuinely tree-positional context (a value set by an ancestor
 * provider at a specific tree position, reachable only during render).
 *
 * @see docs/proposals/v2/blueprint/66-tool-dependency-resolution.md
 */
export interface ToolHandlerCtx
  extends ToolHandlerCtxExtensions, RuntimeContext, Observability, Ops {
  // ── Universal — every transport populates these ───────────────────
  // The work-path identity (`sessionId` / `executionId` / `tickId`) +
  // operation coordinates (`opId` / `principal` / `origin` / …) are the
  // {@link RuntimeContext} trunk, derived from the dispatching crossing
  // (ADR 91) — no longer re-declared flat here.
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  setState(key: string, value: unknown): void;
  emit(seed: HandlerChannelSeed): void;

  // NOTE: `log` + `trace` + `metrics` are inherited from the
  // {@link Observability} facet (ADR 64/78); `run` + `runner` from the
  // {@link Ops} facet (the ad-hoc-operation ladder). `log` behavior is
  // unchanged (bus event, projections forward); `trace`/`metrics` are the
  // telemetry surface (no-ops off); `run` mints a journaled operation.

  /**
   * The structured `progress` signal surface — out-of-band liveness for
   * long-running work (ADR 64). ALWAYS present on every transport (see
   * {@link log} for the emit-once / project-everywhere rationale). The
   * MCP-server projection forwards to `notifications/progress` correlated by
   * `token`; the agentick client receives via the existing per-token progress
   * stream.
   *
   * A CALLABLE OBJECT, exactly like `ctx.log`:
   *
   * ```ts
   * const p = ctx.progress.begin({ total: files.length }); // the everyday door
   * for (const f of files) p.advance(1, f.name);
   * p.done();
   *
   * ctx.progress(ctx.mcp!.progressToken!, { progress: 3, total: 10 }); // the raw door
   * ```
   *
   * `begin()` mints the token from the dispatch (the tool call id), so a
   * handler never invents one, and the returned reporter
   * upholds the four laws on {@link import("./signals.js").ProgressUpdate} by
   * construction.
   * The call form stays the raw door — reach for it to echo a token that came
   * from somewhere else (an MCP client's `_meta.progressToken`) or when the
   * handler owns its own counting.
   *
   * Fire-and-forget — NEVER a control path; never awaited, never throws.
   *
   * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
   */
  readonly progress: Progress;

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

  // ── Sugar surfaces (NEW — ADR 43; same in both transports) ────────

  /**
   * Sugar over the underlying elicit transport. Present whenever the
   * elicit transport is available (in-process: an `ElicitationHarness`
   * is mounted; MCP: the connected client advertised the capability +
   * server didn't opt out). `undefined` otherwise — tool handlers
   * MUST check before use. Cross-transport portable: a handler that
   * calls `ctx.elicit!.text(...)` runs identically in an in-process
   * Agentick session AND inside an MCP server.
   */
  readonly elicit?: Elicit;

  // ── Raw substrate primitives (existing — power-user access) ───────

  /**
   * The session's elicitation harness. `undefined` only on
   * substrate-stripped test fixtures; production sessions always
   * have one. Prefer {@link Elicit} sugar via `ctx.elicit` for
   * cross-transport portability; reach for this when you need raw
   * protocol surface.
   */
  readonly elicitation?: import("../protocol/elicitation-harness.js").ElicitationHarnessProtocol;
  /**
   * The session's tasks harness. `undefined` only on
   * substrate-stripped test fixtures.
   */
  readonly tasks?: import("../protocol/tasks-harness.js").TasksHarnessProtocol;
  /**
   * The session's resources harness (ADR 62) — the application-controlled
   * read-projection seam. A tool handler resolves readable content by URI
   * through it: `await ctx.resource!.read(uri)` / `ctx.resource!.list()`.
   * The registry is populated by the React `<Resource>` front-end, adopter
   * code, and remote MCP servers surfaced by `withMCP` (each proxied under
   * its adopter alias).
   *
   * Same "substrate primitive on ctx" rationale as {@link tasks}: the
   * AppHarness constructs ONE per session at the single construction site
   * and threads that instance here + into `bridges.resources`. `undefined`
   * only on substrate-stripped test fixtures; production sessions always
   * have one.
   */
  readonly resource?: import("../protocol/resources-harness.js").Resources;
  /**
   * The session's tools handle — the one dispatch door, on ctx. A handler
   * invokes a sibling tool by name (`ctx.tools.dispatch(name, input)`) through
   * the same journaled path and the same `"dispatch"` exposure gate as a
   * host-side caller; `list()`/`get()` read the live registry. Composition
   * policy (recursion, budgets) belongs to guards at the dispatch seam, not
   * here. Same "substrate primitive on ctx" rationale as {@link tasks}.
   * `undefined` only on substrate-stripped test fixtures.
   */
  readonly tools?: import("../protocol/tool-executor.js").ToolsHandle;

  // ── Transport discriminator + extras (NEW — ADR 43) ───────────────

  /**
   * Which transport invoked this handler. `"in-process"` for tools
   * dispatched by an Agentick session's tool executor; `"mcp"` for
   * tools projected onto the MCP server wire. Discriminator for the
   * {@link mcp} field below. Common code ignores it — the universal
   * fields above are enough. Only branch on this when the tool
   * genuinely needs different behavior per transport.
   */
  readonly transport: "in-process" | "mcp";

  /**
   * MCP transport-specific extras. Present iff `transport === "mcp"`.
   * Carries wire-level identity material (connection id, client caps,
   * authenticated user, progress callback) that's meaningless for
   * in-process dispatch. Use `ctx.mcp?.clientCapabilities` etc. for
   * defensively-typed code; reach inside without `?` after narrowing
   * on `transport`.
   */
  readonly mcp?: McpRequestExtras;

  /**
   * Free-form per-call metadata. Adopter extension point. Populated
   * by the projection layer in the MCP-server case (`headers`,
   * `origin`, `remoteAddress`); empty by default for in-process.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// MCP request extras (ADR 43)
// ============================================================================

/**
 * A single MCP root — a `file://` directory/file boundary advertised
 * across the client↔server seam. Roots are advisory scoping ("operate
 * within these directories"), NOT enforced containment and NOT content
 * transfer (that is resources, ADR 62).
 *
 * Canonical home is @agentick/spec so both directions type against ONE shape:
 * the outbound client config (`McpRootsSource` in `@agentick/mcp`)
 * and the inbound per-connection read ({@link McpRequestExtras.clientRoots}).
 *
 * @see docs/proposals/v2/blueprint/65-roots-as-projection.md
 */
export interface McpRoot {
  readonly uri: string;
  readonly name?: string;
}

/**
 * MCP-transport-specific ctx extras. Lives under `ToolHandlerCtx.mcp`
 * when `transport === "mcp"`. The fields here are the wire-level
 * identity material that's meaningless in the in-process case —
 * connection ids, client capabilities, progress callbacks, the
 * authenticated principal as surfaced by the auth pipeline.
 *
 * ADR 43 moved these out of a standalone `McpRequestContext`
 * interface into this sub-slot so tool handlers don't see a
 * transport-divergent ctx shape.
 */
export interface McpRequestExtras {
  /** Identifier of the McpServerHarness instance the request reached. */
  readonly serverId: string;
  /** Identifier of the underlying transport connection. */
  readonly connectionId: string;
  /** Transport kind ("stdio" / "http" / "ws" / "in-memory" / ...). */
  readonly transportKind: string;
  /** Time the connection was established, wall-clock ms. */
  readonly connectedAt: number;
  /**
   * Authenticated principal. Populated by the `Authenticator` stage.
   * `null` for connections that pass `ConnectionGuard` but have no
   * explicit authentication (default-allow transports).
   */
  readonly user: McpAuthenticatedUser | null;
  /** Client identification from `initialize` handshake. */
  readonly clientInfo: { readonly name: string; readonly version: string } | null;
  /** Capability map the client advertised in `initialize`. */
  readonly clientCapabilities: Readonly<Record<string, unknown>> | null;
  /**
   * The connecting client's `file://` roots (ADR 65 — inbound direction).
   * Populated per-connection when the client advertised the `roots`
   * capability: the server pulls `roots/list` after initialize and
   * re-pulls on `notifications/roots/list_changed`. Isolated per
   * connection — connection A's roots never appear on connection B's ctx.
   *
   * `undefined` when the client did not advertise `roots`, or before the
   * first pull resolves (fire-and-forget; never a control path). Roots
   * are advisory scoping, so a handler treats absence as "no declared
   * boundary," not an error.
   *
   * TODO(#237-4b / ADR-65): roots-registry upgrade path — if a unified,
   * inspectable, cross-source mount registry is ever needed, a RootsHarness
   * slots UNDER this provider-fn seam (provider reads from it; inbound writes
   * to it; add wire enumerate+subscribe). See ADR 65 for the trigger + rationale.
   */
  readonly clientRoots?: readonly McpRoot[];
  /**
   * The client-supplied `_meta.progressToken` for THIS request, if any
   * (ADR 64). Pass it to `ctx.progress(...)` so the MCP progress
   * projection correlates to the client's call — the wire
   * `notifications/progress` echoes this exact token, which the client
   * SDK maps back to the in-flight request (its `onprogress` fires).
   * `undefined` when the client didn't opt into progress for this call.
   *
   * NOTE(ADR 64): the direct `sendProgress` callback was retired in
   * favor of the universal `ctx.progress` signal (emits one bus event
   * the MCP-server progress projection forwards to
   * `notifications/progress`). This token is the ONLY progress-related
   * datum that survives on `ctx.mcp` — it's per-request correlation
   * input, not a sink. Parallel to retiring the direct `log` sink —
   * one emit seam, projections subscribe.
   */
  readonly progressToken?: ProgressToken;
}

/**
 * Authenticated principal. Adopter `Authenticator` stages populate
 * this. The `roles` + `scopes` fields are conventional but unenforced
 * at the spec layer — adopters' `Authorizer` stage decides how to use
 * them.
 *
 * (Moved here from `protocol/mcp-server-harness.ts` to break the
 * import cycle introduced by ADR 43. The type stays re-exported
 * from `protocol/mcp-server-harness.ts` for back-compat.)
 */
export interface McpAuthenticatedUser {
  readonly id: string;
  readonly displayName?: string;
  readonly roles?: readonly string[];
  readonly scopes?: readonly string[];
  readonly [key: string]: unknown;
}

// ============================================================================
// Handler shape
// ============================================================================

/**
 * Tool handler bodies may return one of the following shapes. The
 * synchronous/promised/Effect forms carry the ADR 70 **result currency**
 * ({@link ToolResultInput}); the `TaskHandle` forms resolve with
 * `ContentBlock[]` (a task resolves with content, not an envelope):
 *
 *   1. **Sync** — {@link ToolResultInput}: a bare `string` (sugar for one
 *      text block), a `readonly ContentBlock[]` (today's shape), or a
 *      `ToolResultEnvelope` (`{ content, structuredContent?, isError?,
 *      metadata? }`). The three are DISCRIMINABLE (string / array /
 *      object-with-`content`), so a wrong-shape return is a type error.
 *   2. **Promise** — `Promise<ToolResultInput>`.
 *   3. **Effect** — `Effect<ToolResultInput, unknown, never>`.
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
 * The currency normalizes to ONE internal result at dispatch (see
 * {@link import("./tool-result.js").normalizeToolResult}); when the tool
 * declares `outputSchema`, the executor validates the envelope's
 * `structuredContent` against it (mirroring `inputSchema`).
 *
 * Effect-typed handlers are preferred for retry / timeout /
 * structured concurrency / finalizers. Promise/sync forms remain
 * supported.
 *
 * The first argument is validated input (`unknown` at the harness
 * boundary — the validator narrows). The second is the per-dispatch
 * dependency bundle: `ctx` (harness-provided) and `use` (render-time
 * deps captured by the compiler).
 *
 * @see docs/proposals/v2/blueprint/70-tool-result-currency.md
 */
export type ToolHandlerResult =
  | ToolResultInput
  | Promise<ToolResultInput>
  | Effect.Effect<ToolResultInput, unknown, never>
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
