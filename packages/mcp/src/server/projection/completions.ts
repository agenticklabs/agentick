/**
 * Argument-completion projection — the server side of MCP
 * `completion/complete`.
 *
 * ## One declaration, two wires
 *
 * A prompt argument declares HOW it completes once, on the declaration
 * (`complete:` — an inline resolver or a name into the completions registry).
 * That declaration answers the agentick wire (`completions/complete`) and this
 * one, because both routes ask the same seam. Nothing about a prompt has to be
 * restated to serve MCP.
 *
 * Resolution order for `ref/prompt`, in the order a request tries them:
 *
 *   1. **An explicit `completions.prompts[name][arg]` handler wins.** It is the
 *      adopter's deliberate per-server override, and it is the ONLY completion
 *      path a standalone server has — one projecting no native prompts surface
 *      (an MCP façade over a REST API, say) has no declaration to read.
 *   2. **Else the projected prompts surface's own seam.** `prompts.fx.complete`
 *      composed INSIDE the crossing, so the declaration's resolver runs on the
 *      crossing's fiber and its ctx carries the CONNECTION's identity
 *      (`ctx.mcp.user`) — the whole reason the twin exists. An inline resolver
 *      answers `resolved`; a NAMED ref comes back as a name (prompts holds
 *      resolvers, it does not own the registry), and the second hop resolves it
 *      against the wired completions registry, also on this fiber.
 *   3. **Else empty.** No handler, no prompts surface, an argument that declares
 *      nothing, a name no registry answers to, or an unknown PROMPT — all
 *      `{ completion: { values: [] } }`. MCP treats completion as best-effort
 *      discovery, so a client probes freely and never sees a protocol error.
 *
 * `ref/resource` routes to `options.resources[uriTemplate][argName]` (the
 * `ref.uri` carries the template uri). Resource-template completion has no
 * declaration seam to fold into — a `ResourceTemplateMeta` carries no per-variable
 * `complete` — so config handlers are the whole story there.
 *
 * The per-connection prompts `filter` applies: a prompt hidden from
 * `prompts/list` is not completable either, symmetric with the `prompts/get`
 * re-check. Completing an argument runs a resolver over the caller's data, which
 * is exactly the leak the filter exists to close.
 *
 * ## The 100-value cap lives HERE
 *
 * MCP caps a `completion/complete` response at 100 values. v1 baked that clamp
 * into every sugar builder, and v2's mcp package inherited it — so a builder
 * called from anywhere silently truncated, including from the native prompts
 * surface that has no such limit. Wire constraints live at the wire: the builders
 * (now in `@agentick/completions`) return everything they found, and
 * {@link clampToWireLimit} trims THIS wire's result to
 * {@link COMPLETION_MAX_VALUES}, setting `hasMore` when it does. Every path above
 * passes through that ONE site — a seam-resolved result is capped exactly like a
 * config-handler result, and the same resolver over the agentick wire is not
 * capped at all.
 */

import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { CompleteRequest, CompleteResult } from "@modelcontextprotocol/sdk/types.js";
import { CompleteRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Unsubscribe } from "@agentick/runtime";
import type {
  Completions,
  CompletionResult,
  McpRequestContext,
  PromptDeclaration,
  Prompts,
} from "@agentick/spec";
import { CompletionNotFound, PromptNotFound } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

import { normalizeCompletionResult, type CompletionHandler } from "../../protocol/completions.js";
import type { McpHandlerExtra, OnCrossingFiber, RunCrossing } from "./crossing.js";
import { projectPrompts } from "./prompts.js";

/** Spec-mandated max values per `completion/complete` response. */
export const COMPLETION_MAX_VALUES = 100;

/** The empty answer — the shape every unresolvable completion returns. */
const EMPTY: CompleteResult = { completion: { values: [] } };

/**
 * Trim a completion result to this wire's advertised limit, stamping `hasMore`
 * on truncation. The ONE enforcement point for the MCP cap — no builder and no
 * primitive applies it.
 *
 * @verifiedBy packages/mcp/src/server/__tests__/projection-completions-logging.spec.ts
 * @verifiedBy packages/mcp/src/server/__tests__/projection-completions-seam.spec.ts
 */
export function clampToWireLimit(
  result: CompletionResult,
  limit = COMPLETION_MAX_VALUES,
): CompletionResult {
  if (result.values.length <= limit) return result;
  return {
    values: result.values.slice(0, limit),
    ...omitUndefined({ total: result.total }),
    hasMore: true,
  };
}

export interface CompletionsProjectionOptions {
  /**
   * EXPLICIT prompt-argument handlers, keyed by prompt name then argument name.
   * Consulted FIRST — an entry here overrides the declaration's own `complete`.
   */
  readonly prompts: Readonly<Record<string, Readonly<Record<string, CompletionHandler>>>>;
  /**
   * Resource-template argument handlers, keyed by template uri (the
   * `ref.uri` a `ref/resource` request carries) then argument name.
   * Defaults to empty — a server with prompt completions only omits it.
   */
  readonly resources?: Readonly<Record<string, Readonly<Record<string, CompletionHandler>>>>;
  /**
   * The prompts surface this server projects, when it projects one. Its
   * declarations' `complete` seams answer any `ref/prompt` no explicit handler
   * claims. Absent for a standalone completions server.
   */
  readonly promptsSource?: Prompts;
  /** The prompts projection's per-connection visibility predicate, applied here too. */
  readonly promptsFilter?: (decl: PromptDeclaration, ctx: McpRequestContext) => boolean;
  /**
   * The completions registry that answers a NAMED ref the prompts seam hands
   * back. Absent ⇒ a named ref completes empty.
   */
  readonly completionsSource?: Completions;
  /** The crossing-operation runner for this connection (ADR 92 §Slice A). */
  readonly runCrossing: RunCrossing;
}

/**
 * Install the `completion/complete` request handler on an SDK Server.
 *
 * MUST only be called when the `completions` capability is advertised —
 * the SDK's `assertRequestHandlerCapability` throws otherwise.
 *
 * Returns a no-op `Unsubscribe` for symmetry with sibling projections
 * (the SDK has no request-handler removal API; teardown happens when
 * the connection's SDK Server closes).
 */
export function installCompletionsHandlers(
  sdkServer: SdkServer,
  options: CompletionsProjectionOptions,
): Unsubscribe {
  sdkServer.setRequestHandler(
    CompleteRequestSchema,
    async (request: CompleteRequest, extra: McpHandlerExtra): Promise<CompleteResult> => {
      const { ref, argument } = request.params;
      const resolvedArguments = request.params.context?.arguments ?? {};

      return options.runCrossing({
        verb: "complete",
        operation: {
          type: "completion",
          name: ref.type === "ref/prompt" ? ref.name : ref.uri,
        },
        params: { ref: ref.type, argument: argument.name },
        signal: extra.signal,
        // ADR 91 — `resolvedArguments` is a BOUNDARY field of this crossing, so
        // it composes INTO the branded ctx mint instead of being spread over the
        // ctx inside the body. The spread it replaces erased the `Derived` brand
        // and eagerly forced the five lazy facet getters.
        ctxExtras: { resolvedArguments },
        // The crossing threads its authenticated ctx (ADR 91 §2 / ADR 92 §Slice
        // A) so the completion handler sees the SAME trunk the request carries —
        // the request's redacted `identity` plus the `log`/`trace`/`run` facets,
        // with `ctx.run` minting CHILD ops of this crossing. It also carries the
        // `mcp` BOUNDARY FACET verbatim (`CompletionContext.mcp`): a ctx-only,
        // never-serialized handle on the full authenticated record, which is
        // where a handler that must call a downstream API on the caller's behalf
        // reads the live credential. A DB-backed completion scopes its query to
        // `ctx.identity.principal`; a prefix-match handler ignores everything but
        // `resolvedArguments`.
        run: async (_input, ctx, onFiber): Promise<CompleteResult> => {
          // 1. The explicit config handler — the adopter's override.
          const handler = resolveHandler(options, ref, argument.name);
          if (handler !== undefined) {
            return toWire(
              clampToWireLimit(normalizeCompletionResult(await handler(argument.value, ctx))),
            );
          }
          // 2. The declaration's own seam, for a projected prompt.
          if (ref.type === "ref/prompt") {
            const seamed = await completeViaSeam(options, ctx, onFiber, {
              prompt: ref.name,
              argument: argument.name,
              value: argument.value,
              resolvedArguments,
            });
            if (seamed !== undefined) return toWire(clampToWireLimit(seamed));
          }
          // An MCP-ORIGIN prompt needs no arm of its own, and now has none:
          // `surfaceRemotePrompts` folds it in carrying forwarding resolvers, so
          // re-exposing it over this server resolves at arm 2 and chains through to
          // the origin server — one seam, however many hops.
          // 3. Nothing to ask.
          return EMPTY;
        },
      });
    },
  );

  return () => {
    /* no-op — SDK owns request-handler lifecycle per connection */
  };
}

/**
 * Ask the projected prompt declaration what its argument completes to, running
 * the resolver ON THE CROSSING'S FIBER.
 *
 * Returns `undefined` — not an empty result — when this route has nothing to say,
 * so the caller distinguishes "the seam answered with no candidates" from "there
 * was no seam to ask". Both currently reach the wire as an empty list; keeping
 * them apart is what lets a future arm slot in behind this one.
 */
async function completeViaSeam(
  options: CompletionsProjectionOptions,
  ctx: McpRequestContext,
  onFiber: OnCrossingFiber,
  ask: {
    readonly prompt: string;
    readonly argument: string;
    readonly value: string;
    readonly resolvedArguments: Readonly<Record<string, string>>;
  },
): Promise<CompletionResult | undefined> {
  const source = options.promptsSource;
  if (source === undefined) return undefined;
  // Re-project so the per-connection filter decides completability, exactly as
  // `prompts/get` re-checks visibility before rendering. A prompt this connection
  // cannot see must not have its arguments completed against the caller's data.
  const visible = projectPrompts(source.list(), options.promptsFilter, ctx);
  if (!visible.some((p) => p.name === ask.prompt)) return undefined;

  // ON THE CROSSING'S FIBER (ADR 92 §Slice A) — the declaration's resolver sees
  // an `OperationCtx` carrying this caller's identity + the `mcp` boundary facet
  // (credential included). Through the Promise facade `complete` would mint from
  // the harness's own construction scope and the resolver would see the session
  // that owns the registry rather than the client that asked.
  let outcome;
  try {
    outcome = await onFiber(
      source.fx.complete({
        name: ask.prompt,
        argument: { name: ask.argument, value: ask.value },
        context: { arguments: ask.resolvedArguments },
      }),
    );
  } catch (cause) {
    // An unknown prompt is the one thing the seam raises rather than answering.
    // On this wire it is an empty completion, not an error: MCP's `ref/prompt`
    // completion is best-effort discovery, and the pre-seam projection already
    // answered unknown refs with `{ values: [] }`. Keeping that byte-identical
    // matters more than surfacing a lookup miss the client cannot act on.
    if (cause instanceof PromptNotFound) return undefined;
    throw cause;
  }

  if (outcome.kind === "resolved") return outcome.result;
  if (outcome.kind === "unavailable") return undefined;

  // The second hop: the argument named a registry source. Prompts handed the name
  // back because it holds resolvers without owning the registry; resolve it here,
  // still on the crossing's fiber.
  const registry = options.completionsSource;
  if (registry === undefined) return undefined;
  try {
    return await onFiber(
      registry.fx.resolve(outcome.completeRef, {
        value: ask.value,
        resolvedArguments: ask.resolvedArguments,
      }),
    );
  } catch (cause) {
    // A ref nobody bound is silence, not a fault — the same rule the agentick
    // wire route applies. A resolver that THREW is a real failure and propagates.
    if (cause instanceof CompletionNotFound) return undefined;
    throw cause;
  }
}

/**
 * `CompletionResult` uses readonly arrays; the SDK wire type wants mutable —
 * copy into a fresh array at the boundary.
 */
function toWire(result: CompletionResult): CompleteResult {
  return {
    completion: {
      values: [...result.values],
      ...omitUndefined({ total: result.total, hasMore: result.hasMore }),
    },
  };
}

function resolveHandler(
  options: CompletionsProjectionOptions,
  ref: CompleteRequest["params"]["ref"],
  argumentName: string,
): CompletionHandler | undefined {
  if (ref.type === "ref/prompt") {
    return options.prompts[ref.name]?.[argumentName];
  }
  // ref/resource — the `ref.uri` is the template uri; look the argument
  // handler up under it. Unknown template / arg → undefined (empty result).
  return options.resources?.[ref.uri]?.[argumentName];
}
