/**
 * The crossing operation (ADR 92 §Slice A, Family 1) — every inbound MCP
 * request handler runs as a named, journaled, guardable, span-parented
 * operation.
 *
 * Before this module a `setRequestHandler` callback invoked its handler
 * directly: no journal record, no hook, no guard, and every op the handler
 * triggered downstream became an ORPHANED ROOT with no connection identity and
 * no parentage. The grammar's law says a crossing MUST be an operation iff an
 * adopter could ever want to hook it, guard it, or find it in the audit trail —
 * external ingress qualifies by definition.
 *
 * ## The shape
 *
 *   ConnectionGuard        (pre-op, once per connection — `acceptConnection`)
 *   Authenticator          (PRE-OP, per request — admission, never an operation)
 *   ─────────────────────  mcp:command:<verb> begins here
 *     Authorizer           guard-kind interceptor
 *     RateLimiter          guard-kind interceptor
 *     InputSanitizer       transform-kind interceptor (rewrites the op input)
 *     <adopter guards/hooks on the harness>
 *     body                 the SDK request handler
 *   ─────────────────────  terminal
 *
 * Authentication stays PRE-OP deliberately: admission denied means no work unit
 * exists, so there is nothing to journal as an operation. Its failure becomes
 * visible as a discrete admission-failure EVENT instead (ADR 92 §Family 1.3).
 * Everything downstream of admission — the three per-operation stages — maps
 * onto the op's guard seam, so the staged `auth: {...}` config is now SUGAR
 * over guard registration rather than a parallel enforcement mechanism.
 *
 * ## Wire invisibility
 *
 * Each stage keeps throwing its existing typed `McpServerError`, which
 * `runOperation` re-raises verbatim after publishing `terminal:failed`. The
 * JSON-RPC frame a client sees is byte-identical to the pre-op path; the
 * envelope is additive.
 *
 * @see docs/proposals/v2/blueprint/92-operation-grammar-completion.md
 */

import { Effect } from "effect";
import type { Derived, McpRequestContext, Middleware } from "@agentick/spec";
import { McpServerAuthzDenied, McpServerRateLimited } from "@agentick/spec";
import {
  type AsyncMiddleware,
  liftMiddleware,
  scopeToCommand,
  tagInterceptor,
} from "@agentick/runtime";
import { omitUndefined } from "@agentick/utils";

import type { OperationInfo, ResolvedSecurity } from "../security/stages.js";

/**
 * The kebab verbs the MCP server projects, one per SDK request crossing. The
 * `mcp:command:<verb>` op name derives directly from these, so
 * `deriveHookNames` mints `onBeforeCallTool` / `onAfterCallTool` and an adopter
 * guard self-scopes by the `CallTool` command tag.
 */
export type McpCrossingVerb =
  | "initialize"
  | "list-tools"
  | "call-tool"
  | "list-resources"
  | "list-resource-templates"
  | "read-resource"
  | "subscribe-resource"
  | "unsubscribe-resource"
  | "list-prompts"
  | "get-prompt"
  | "complete";

/** Op name for a crossing verb — the single place the naming law is applied. */
export function crossingOpName(verb: McpCrossingVerb): string {
  return `mcp:command:${verb}`;
}

/**
 * The crossing operation's INPUT — the value the interceptor cascade sees and
 * may reshape. `params` is the wire request's parameters (journaled verbatim as
 * the `requested` payload); `toolInput` is the tool-call argument object, the
 * only field the `InputSanitizer` stage rewrites.
 */
export interface McpCrossingInput {
  readonly params: Readonly<Record<string, unknown>>;
  readonly toolInput: Record<string, unknown> | undefined;
}

/**
 * One inbound crossing, as declared by a projection.
 *
 * `X` is the crossing's OWN ctx extras — boundary fields this particular verb
 * contributes, composed INTO the branded ctx mint and surfaced on the body's
 * `ctx` (see {@link McpCrossing.ctxExtras}). Defaults to nothing, so a crossing
 * that adds no fields declares only `R`.
 */
export interface McpCrossing<R, X extends object = Record<never, never>> {
  readonly verb: McpCrossingVerb;
  /** What the per-operation security stages authorize + rate-limit. */
  readonly operation: OperationInfo;
  /** Wire request parameters — the journaled op input. */
  readonly params?: Readonly<Record<string, unknown>>;
  /** Tool-call arguments, when this crossing carries any. */
  readonly toolInput?: Readonly<Record<string, unknown>>;
  /**
   * Per-crossing context extras merged into the request ctx AFTER
   * authentication — currently only `tools/call`'s `_meta.progressToken`.
   */
  readonly progressToken?: string | number;
  /**
   * The SDK's per-request cancellation signal ({@link McpHandlerExtra}),
   * threaded onto the body's `ctx.signal` so a handler's own async work
   * aborts when the CALLER gives up. The SDK fires it on both
   * `notifications/cancelled` for this request id and connection close
   * (`Protocol._onclose` aborts every in-flight handler), so it is the
   * complete cancellation source for a crossing — a projection passing
   * it through is all the wiring `ctx.signal` needs.
   *
   * Absent ⇒ the ctx carries a signal that never aborts (the pre-#254
   * behavior), which is also what the off-connection contexts get.
   */
  readonly signal?: AbortSignal;
  /**
   * This crossing's OWN boundary fields, composed INTO the branded ctx mint and
   * typed onto the body's `ctx` as `Derived<McpRequestContext & X>`.
   *
   * The generalization of what `progressToken` did by hand. It exists because the
   * alternative a projection reaches for — `{ ...ctx, extra }` inside the body —
   * ERASES the `Derived` brand and eagerly forces the five lazy facet getters
   * (ADR 91 §Phase-2 brand totalization). A field known before the body runs
   * belongs in the mint, and every field a completion crossing adds
   * (`resolvedArguments`) is known from the request params.
   *
   * Boundary fields only: these land on the ctx the body and the seams it invokes
   * read, NOT on the op's `EventScope`, so nothing here reaches the bus or the
   * journal.
   */
  readonly ctxExtras?: X;
  /**
   * The SDK request handler body. Receives the POST-CASCADE input (so an
   * `InputSanitizer` or an adopter `onBeforeCallTool` hook that reshapes the
   * arguments is honored), the authenticated request ctx (carrying
   * {@link ctxExtras}), and the crossing's {@link OnCrossingFiber} runner for
   * composing harness `.fx` twins.
   */
  readonly run: (
    input: McpCrossingInput,
    ctx: Derived<McpRequestContext & X>,
    onFiber: OnCrossingFiber,
  ) => Promise<R>;
}

/**
 * The slice of the SDK's `RequestHandlerExtra` the crossings read — its
 * per-request cancellation signal. Narrowed deliberately: a projection
 * that grew a dependency on `authInfo` / `sessionId` / `sendRequest`
 * would be reaching around the harness's own admission + ctx mint.
 */
export interface McpHandlerExtra {
  readonly signal: AbortSignal;
}

/**
 * Run a harness's Effect-canonical (`.fx`) twin ON THE CROSSING'S FIBER —
 * the capability a projection body needs to keep the trunk (ADR 92 §Slice A).
 *
 * The SDK hands us a Promise-shaped request handler, so a projection body is
 * plain async code sitting INSIDE the crossing operation's fiber but unable to
 * `yield*`. Calling a harness's Promise facade from there (`resources.read(uri)`)
 * re-enters Effect on a fresh ROOT fiber that inherits no FiberRef: the inner
 * `resources:command:read` op journals as an orphan and its resolver receives a
 * ctx with no connection identity. Running the harness's `.fx` twin through
 * THIS instead runs it on the runtime captured inside the crossing body, so the
 * FiberRef trunk flows: the inner command becomes a proper child (crossing opId
 * as `parentOpId`, connection dim + identity inherited) and `currentOperationCtx()`
 * in the harness sees the crossing's identity.
 *
 * The inner command keeps its own `origin` (host) — the WIRE origin belongs to
 * the crossing, which already ran admission and the security stages; stamping
 * `wire` on the inner read would re-submit it to the wire-exposure grant gate
 * that the crossing has already satisfied.
 */
export type OnCrossingFiber = <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>;

/**
 * The capability a projection receives instead of `{ security, buildContext }`
 * — it owns admission, op manufacture, the guard mapping, and the ctx mint.
 * One bound instance per connection.
 */
export type RunCrossing = <R, X extends object = Record<never, never>>(
  crossing: McpCrossing<R, X>,
) => Promise<R>;

/**
 * Map the three PER-OPERATION security stages onto tier-4 call-scoped
 * interceptors for one crossing op (ADR 92 §Family 1.1 — "the staged
 * `auth: {...}` API stays as sugar over guard registration, not a parallel
 * mechanism").
 *
 * `Authorizer` and `RateLimiter` are `guard`-kind: they admit or reject and
 * never touch the input. `InputSanitizer` is `transform`-kind: it rewrites the
 * op input in place of the body's arguments. The runner's stable
 * guard-outermost ordering therefore reproduces the pipeline's fixed order
 * (authorize → rate-limit → sanitize) without the pipeline runner.
 *
 * Each stage rejects by THROWING its existing typed error rather than raising a
 * veto signal: the operation runner re-raises the original after publishing
 * `terminal:failed`, so the JSON-RPC error a client sees is unchanged. A veto
 * signal would surface as `OperationOutcomeError` — a different wire frame.
 * Adopter guards registered on the harness keep the veto semantics; these
 * bundled stages deliberately do not.
 *
 * Every stage self-scopes to the crossing's command tag, so none of them fire
 * on the nested ops the handler body triggers.
 */
export function securityStageInterceptors(args: {
  readonly security: ResolvedSecurity;
  readonly ctx: McpRequestContext;
  readonly operation: OperationInfo;
  readonly command: string;
}): Middleware<unknown, unknown, unknown>[] {
  const { security, ctx, operation, command } = args;

  const authorize: AsyncMiddleware = async (input, next) => {
    const authz = await security.authorizer(ctx, operation);
    if (!authz.allowed) {
      throw new McpServerAuthzDenied({ reason: authz.reason || "Forbidden" });
    }
    return next(input);
  };

  const rateLimit: AsyncMiddleware = async (input, next) => {
    const rate = await security.rateLimiter(ctx, operation);
    if (!rate.allowed) {
      throw new McpServerRateLimited(omitUndefined({ retryAfterMs: rate.retryAfterMs }));
    }
    return next(input);
  };

  // Tool calls only — the sanitizer stage exists to scrub model-supplied
  // arguments, and no other crossing carries any.
  const sanitize: AsyncMiddleware = async (input, next) => {
    const current = input as McpCrossingInput;
    if (operation.type !== "tool_call" || current.toolInput === undefined) {
      return next(input);
    }
    const sanitized = await security.inputSanitizer(ctx, operation.name ?? "", current.toolInput);
    return next({ ...current, toolInput: sanitized });
  };

  return [
    tagInterceptor("guard", liftMiddleware(scopeToCommand(command, authorize))),
    tagInterceptor("guard", liftMiddleware(scopeToCommand(command, rateLimit))),
    tagInterceptor("transform", liftMiddleware(scopeToCommand(command, sanitize))),
  ] as Middleware<unknown, unknown, unknown>[];
}

/**
 * Lift the SDK handler body onto the Effect channel, preserving error identity
 * — `runOperation` re-raises whatever this fails with, so a thrown
 * `McpServerError` reaches the SDK serializer unchanged.
 */
export function crossingBody<R, X extends object>(
  run: McpCrossing<R, X>["run"],
  ctx: Derived<McpRequestContext & X>,
  onFiber: OnCrossingFiber,
): (input: McpCrossingInput) => Effect.Effect<R, unknown, never> {
  return (input) =>
    Effect.tryPromise({
      try: () => run(input, ctx, onFiber),
      catch: (cause) => cause,
    });
}
