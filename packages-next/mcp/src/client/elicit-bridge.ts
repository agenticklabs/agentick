/**
 * ElicitationBridge — translates inbound MCP `elicitation/create`
 * requests into agentick's substrate-level
 * {@link ElicitationHarnessProtocol} primitive, and translates the
 * resulting {@link ElicitationResult} back into MCP's `ElicitResult`
 * wire shape.
 *
 * The MCP SDK's `Client.setRequestHandler(ElicitRequestSchema, …)`
 * installs the handler returned by {@link makeElicitRequestHandler}.
 * Routing the elicit to the right session's harness is the caller's
 * job: the handler reads a per-call resolver slot the
 * {@link McpClientHarness} maintains. `withMCP`'s tool-handler closure
 * looks up `installer.app.getSession(ctx.sessionId)?.elicitation` and
 * threads it through `callTool(..., { elicitResolver })`. When the
 * server fires elicit during that call window, the slot is populated
 * and the request routes to the session's user.
 *
 * **v0 concurrency caveat.** Each `McpClientHarness` carries a single
 * resolver slot; concurrent tool calls from different sessions through
 * the same MCP server WILL race on the resolver. In practice MCP tool
 * calls per server-connection are mostly serial (one user, one session,
 * one in-flight call). Closing the race requires per-request-id
 * correlation through `_meta` — deferred until the MCP spec ships a
 * stable `relatedRequestId` field on inbound server-initiated requests.
 *
 * No URL-mode handling here. MCP `2025-11-25` declares form mode only
 * on elicitation/create; URL mode arrives with the draft spec and the
 * agentick harness's URL-mode wiring (#134a). When that lands this
 * file extends with a `mode === "url"` branch.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md
 */

import { jsonSchema } from "@agentick/spec-next";
import type { ElicitationHarnessProtocol, ElicitationResult } from "@agentick/spec-next";

import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// Resolver slot
// ============================================================================

/**
 * Per-call elicit resolver — the in-flight session's elicitation
 * harness, surfaced to the MCP SDK's inbound elicit handler. Read by
 * the handler at the moment the server fires `elicitation/create`.
 */
export interface ElicitResolverSlot {
  current(): ElicitationHarnessProtocol | undefined;
}

// ============================================================================
// Request translation
// ============================================================================

/**
 * Build the request-handler closure to register with
 * `client.setRequestHandler(ElicitRequestSchema, …)`. The closure
 * reads from the supplied {@link ElicitResolverSlot} on each call —
 * use a slot bound to a single harness instance.
 *
 * When the slot is empty the handler returns
 * `{ action: "cancel" }` so the server sees a clean "no answer" rather
 * than a protocol-level error. This is the correct posture for an
 * unrouted elicit (the user-facing UI isn't bound to this server right
 * now); declining differs semantically ("user said no") and would
 * misrepresent the situation.
 */
export function makeElicitRequestHandler(
  slot: ElicitResolverSlot,
): (request: ElicitRequest, extra: { readonly signal: AbortSignal }) => Promise<ElicitResult> {
  return async (request, extra) => {
    const resolver = slot.current();
    if (!resolver) {
      return { action: "cancel" };
    }
    // ElicitRequest's params are a union of form-mode + url-mode
    // shapes. URL mode lands with #134a; for now we only forward form
    // mode and cancel anything else so the server sees a clean
    // termination rather than a protocol error.
    const params = request.params as ElicitRequestParams;
    if (params.mode === "url") {
      return { action: "cancel" };
    }
    const result = await resolver.elicit(
      {
        mode: "form",
        message: params.message,
        // MCP's `requestedSchema` is a JSON Schema object — wrap it
        // through the framework's `jsonSchema()` helper so the
        // ElicitationHarness's StandardSchema-typed contract is
        // satisfied without re-parsing.
        schema: jsonSchema(params.requestedSchema as Readonly<Record<string, unknown>>),
      },
      { signal: extra.signal },
    );
    return elicitationResultToMcp(result);
  };
}

/**
 * Narrow projection of the form-mode arm of `ElicitRequest.params`. The
 * MCP SDK's generated union type makes `requestedSchema` unreachable
 * without first narrowing on `mode`; this alias documents the form-mode
 * fields the bridge actually consumes.
 */
type ElicitRequestParams =
  | {
      readonly mode?: "form";
      readonly message: string;
      readonly requestedSchema: Readonly<Record<string, unknown>>;
    }
  | {
      readonly mode: "url";
      readonly message: string;
      readonly url: string;
    };

// ============================================================================
// Result translation
// ============================================================================

/**
 * Map agentick's discriminated {@link ElicitationResult} onto MCP's
 * three-action {@link ElicitResult}.
 *
 *   accepted → accept + content
 *   declined → decline
 *   cancelled → cancel
 *   failed    → cancel (logged on stderr; MCP's wire surface doesn't
 *               distinguish failure modes — the alternative is throwing,
 *               which the SDK would surface as a JSON-RPC error to the
 *               server, breaking the "elicit always terminates cleanly"
 *               invariant).
 */
export function elicitationResultToMcp(result: ElicitationResult<unknown>): ElicitResult {
  switch (result.outcome) {
    case "accepted":
      return {
        action: "accept",
        // MCP restricts content to a flat object of primitives + string
        // arrays. We pass `result.value` through; adopters who exceed
        // that subset are responsible for honoring MCP's schema bound
        // (see FormElicitationRequest schema docs).
        content: result.value as Readonly<Record<string, string | number | boolean | string[]>>,
      };
    case "declined":
      return { action: "decline" };
    case "cancelled":
      return { action: "cancel" };
    case "failed":
      // No-op log so adopters tailing stderr see why an elicit went to
      // cancel; programmatic dispatch lives on the harness side.
      console.warn(
        `[mcp] elicitation failed (${result.failure.kind}): ${result.failure.reason ?? "no reason"}`,
      );
      return { action: "cancel" };
  }
}
