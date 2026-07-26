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
 * Output is capped at 100 values by {@link normalizeCompletionResult}
 * (spec-mandated), which the sugar builders also enforce.
 */

import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { CompleteRequest, CompleteResult } from "@modelcontextprotocol/sdk/types.js";
import { CompleteRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpRequestContext } from "@agentick/spec";
import type { Unsubscribe } from "@agentick/runtime";

import { normalizeCompletionResult, type CompletionHandler } from "../../protocol/completions.js";
import { evaluateRequestPipeline } from "../security/pipeline.js";
import type { ResolvedSecurity } from "../security/stages.js";

export interface CompletionsProjectionOptions {
  /** Prompt-argument handlers, keyed by prompt name then argument name. */
  readonly prompts: Readonly<Record<string, Readonly<Record<string, CompletionHandler>>>>;
  /**
   * Resource-template argument handlers, keyed by template uri (the
   * `ref.uri` a `ref/resource` request carries) then argument name.
   * Defaults to empty — a server with prompt completions only omits it.
   */
  readonly resources?: Readonly<Record<string, Readonly<Record<string, CompletionHandler>>>>;
  /** Security pipeline resolved for this server. */
  readonly security: ResolvedSecurity;
  /** Connection-scoped context base (cloned + augmented per-request). */
  readonly buildContext: () => McpRequestContext;
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

      const baseCtx = options.buildContext();
      // The pipeline may authenticate + augment identity — thread its returned
      // ctx (ADR 91 §2) so the completion handler sees the SAME trunk (the
      // request's `mcp.user` identity) + `log`/`trace`/`run` facets it reads
      // sibling arguments from. A DB-backed completion scopes its query to the
      // authenticated principal off this ctx; a prefix-match handler ignores
      // everything but `resolvedArguments`.
      const { ctx } = await evaluateRequestPipeline(options.security, baseCtx, {
        type: "completion",
        name: ref.type === "ref/prompt" ? ref.name : ref.uri,
      });

      const handler = resolveHandler(options, ref, argument.name);
      if (!handler) {
        return { completion: { values: [] } };
      }

      const raw = await handler(argument.value, { ...ctx, resolvedArguments });
      const result = normalizeCompletionResult(raw);
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
