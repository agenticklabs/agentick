/**
 * Argument-completion projection — the server side of MCP
 * `completion/complete`.
 *
 * The completion SUGAR (`completeFromList`, `completeFromEnum`,
 * `completeDependent`, ...) was ported to `../../protocol/completions.ts`
 * but never wired to a request handler. This module is that wiring:
 * it registers a `CompleteRequestSchema` handler on the per-connection
 * SDK Server and routes the request to the matching {@link CompletionHandler}.
 *
 *   - `ref/prompt` → looks up `options.prompts[promptName][argName]`.
 *   - `ref/resource` → looks up `options.resources[uriTemplate][argName]`
 *     (the `ref.uri` carries the template uri). An unknown template or
 *     argument resolves to an empty value list — clients probe freely
 *     without a protocol error.
 *
 * Unknown refs / arguments also resolve to `{ values: [] }` rather than
 * a protocol error — matches v1 + the MCP guidance that completion is a
 * best-effort discovery surface. The `context.arguments` field (sibling
 * arguments the user already filled) flows through as
 * {@link CompletionContext.resolvedArguments}.
 *
 * ## The 100-value cap lives HERE
 *
 * MCP caps a `completion/complete` response at 100 values. v1 baked that clamp
 * into every sugar builder, and v2's mcp package inherited it — so a builder
 * called from anywhere silently truncated, including from the native prompts
 * surface that has no such limit. Wire constraints live at the wire: the builders
 * (now in `@agentick/completions`) return everything they found, and
 * {@link clampToWireLimit} trims THIS wire's result to
 * {@link COMPLETION_MAX_VALUES}, setting `hasMore` when it does.
 */

import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { CompleteRequest, CompleteResult } from "@modelcontextprotocol/sdk/types.js";
import { CompleteRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Unsubscribe } from "@agentick/runtime";
import type { CompletionResult } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

import { normalizeCompletionResult, type CompletionHandler } from "../../protocol/completions.js";
import type { RunCrossing } from "./crossing.js";

/** Spec-mandated max values per `completion/complete` response. */
export const COMPLETION_MAX_VALUES = 100;

/**
 * Trim a completion result to this wire's advertised limit, stamping `hasMore`
 * on truncation. The ONE enforcement point for the MCP cap — no builder and no
 * primitive applies it.
 *
 * @verifiedBy packages/mcp/src/server/__tests__/projection-completions-logging.spec.ts
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
  /** Prompt-argument handlers, keyed by prompt name then argument name. */
  readonly prompts: Readonly<Record<string, Readonly<Record<string, CompletionHandler>>>>;
  /**
   * Resource-template argument handlers, keyed by template uri (the
   * `ref.uri` a `ref/resource` request carries) then argument name.
   * Defaults to empty — a server with prompt completions only omits it.
   */
  readonly resources?: Readonly<Record<string, Readonly<Record<string, CompletionHandler>>>>;
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
    async (request: CompleteRequest): Promise<CompleteResult> => {
      const { ref, argument } = request.params;
      const resolvedArguments = request.params.context?.arguments ?? {};

      return options.runCrossing({
        verb: "complete",
        operation: {
          type: "completion",
          name: ref.type === "ref/prompt" ? ref.name : ref.uri,
        },
        params: { ref: ref.type, argument: argument.name },
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
        run: async (_input, ctx): Promise<CompleteResult> => {
          const handler = resolveHandler(options, ref, argument.name);
          if (!handler) {
            return { completion: { values: [] } };
          }

          // TODO(adr91-brand): this spread erases the `Derived` brand and eagerly
          // FORCES the five lazy facet getters. Correct-but-eager today because
          // the projection holds no `ContextFacets` to re-mint with; the fix is
          // for `runCrossing` to expose a per-crossing `derive(extras)` seam so
          // the boundary's own field composes INTO the branded mint.
          const raw = await handler(argument.value, { ...ctx, resolvedArguments });
          // Normalize the sugar shape, THEN apply this wire's cap. The handler
          // itself no longer truncates.
          const result = clampToWireLimit(normalizeCompletionResult(raw));
          // CompletionResult uses readonly arrays; the SDK wire type wants
          // mutable — spread into a fresh array at the boundary.
          return {
            completion: {
              values: [...result.values],
              ...(result.total !== undefined ? { total: result.total } : {}),
              ...(result.hasMore !== undefined ? { hasMore: result.hasMore } : {}),
            },
          };
        },
      });
    },
  );

  return () => {
    /* no-op — SDK owns request-handler lifecycle per connection */
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
