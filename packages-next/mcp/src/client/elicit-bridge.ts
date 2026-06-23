/**
 * ElicitationBridge — translates inbound MCP `elicitation/create`
 * requests into agentick's substrate-level
 * {@link ElicitationHarnessProtocol} primitive, and translates the
 * resulting {@link ElicitationResult} back into MCP's `ElicitResult`
 * wire shape.
 *
 * Routing goes through the substrate's inbox (not an object reference):
 *
 *   ┌──────────────────────┐                ┌────────────────────────┐
 *   │  McpClientHarness    │                │  ElicitationHarness    │
 *   │  (per-server)        │                │  (per-session)         │
 *   ├──────────────────────┤                ├────────────────────────┤
 *   │  SDK elicit handler  │ inbox.send →   │  handleMessage         │
 *   │   ↓ build payload    │  elicit-request│   ↓ this.elicit(...)   │
 *   │   register Deferred  │                │   ↓ publish on bus     │
 *   │   await reply        │                │   ↓ await user reply   │
 *   │   ← request-response │ ← inbox.send   │   send back to replyTo │
 *   └──────────────────────┘                └────────────────────────┘
 *
 * Same protocol in-process (LocalInbox) and cluster (ClusterInbox). No
 * in-memory object reference crosses the seam — only the
 * sessionElicitAddress string, supplied at McpClientHarness
 * construction by `withMCP`'s session-extension wiring.
 *
 * ## v0 caveat: one McpClientHarness can serve N concurrent calls
 *
 * The harness today is **per server, app-level** (`withMCP` is an
 * AppExtension). Concurrent `callTool` invocations from different
 * sessions through the same server share the harness's elicit
 * resolver slot (a sessionId string, not an object). The slot races
 * on cross-session concurrent calls; documented `getActiveSessionId`
 * heuristics surface ambiguity as `mcp:warning:routing-ambiguous`
 * bus envelopes.
 *
 * **Architectural fix (#151)**: per-session McpClientHarness. Each
 * session gets its own harness with a fixed elicitAddress at
 * construction; the slot disappears entirely; cross-session
 * concurrency becomes impossible by construction. Requires
 * SessionExtension lifecycle wiring (#150). See `mcp/README.md`
 * "Connection lifecycle" for the full story.
 *
 * **FUTURE OPTIMIZATION (track in the coming weeks)**: per-session
 * connections fan out N×M for N sessions × M servers, which is
 * wasteful for stateless servers (local stdio mcp-everything-style
 * processes) and for high-tenant deployments. The follow-up is a
 * **connection pool keyed by authentication principal** — sessions
 * check connections OUT for the duration of a tick and back IN when
 * done. Same auth context → connection sharing; different auth
 * principals → connection isolation. Mcp-Session-Id (Streamable
 * HTTP) makes this cleanly resumable across check-outs. Defer until
 * production load demands it; the abstraction layer for that lives
 * BENEATH McpClientHarness (a `connection: McpConnectionRef`
 * indirection) and doesn't change anything above.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md
 * @see ./harness.ts McpClientHarness elicit slot management
 */

import { Effect } from "effect";
import { jsonSchema } from "@agentick/spec-next";
import type {
  ElicitationRequest,
  ElicitationResult,
  EventBus,
  MessageInbox,
  StandardSchemaV1,
} from "@agentick/spec-next";
import { ELICIT_REQUEST_MESSAGE_TYPE } from "@agentick/elicitation-next";
import { ulid } from "@agentick/runtime-next";
import type { RequestResponseRegistry } from "@agentick/runtime-next";

import type {
  ElicitRequest,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// Slot — current session's elicit address (or `undefined` when no
// callTool is in flight). Set+cleared around each `callTool` via
// Effect.acquireUseRelease.
// ============================================================================

export interface ElicitAddressSlot {
  current(): string | undefined;
}

// ============================================================================
// Inbox dispatch — the cluster-friendly seam
// ============================================================================

/**
 * Inputs the bridge needs at handler time. These come from the
 * McpClientHarness, which closes over them when it registers the SDK
 * handler.
 */
export interface ElicitDispatchDeps {
  readonly inbox: MessageInbox;
  readonly bus: EventBus;
  readonly replyToAddress: string;
  readonly requests: RequestResponseRegistry<ElicitationResult<unknown>>;
  readonly resolveElicitAddress: (sessionId: string) => string | undefined;
  readonly serverId: string;
  readonly defaultTimeoutMs: number;
}

/**
 * Build the request-handler closure to register with
 * `client.setRequestHandler(ElicitRequestSchema, …)`.
 *
 *   1. Read the active sessionId from the slot.
 *   2. Resolve that session's elicit-harness address.
 *   3. Send an `elicit-request` inbox message to that address.
 *   4. Register a Deferred keyed by correlationId; the reply lands as
 *      a `request-response` envelope and `BaseHarness.dispatchMessage`
 *      auto-resolves it.
 *   5. Await the result, translate to MCP wire format.
 *
 * Unrouted elicits (no active session, lookup miss) return
 * `{ action: "cancel" }` AND emit `mcp:warning:routing-dropped` on
 * the bus so observability surfaces the dropped elicit.
 */
export function makeElicitRequestHandler(
  slot: ElicitAddressSlot,
  deps: ElicitDispatchDeps,
): (request: ElicitRequest, extra: { readonly signal: AbortSignal }) => Promise<ElicitResult> {
  return async (request, extra) => {
    const sessionId = slot.current();
    if (sessionId === undefined) {
      emitRoutingWarning(deps, "no-active-session", request);
      return { action: "cancel" };
    }
    const elicitAddress = deps.resolveElicitAddress(sessionId);
    if (elicitAddress === undefined) {
      emitRoutingWarning(deps, "address-unresolved", request, sessionId);
      return { action: "cancel" };
    }

    const harnessRequest = translateMcpToHarness(request);
    if (harnessRequest === undefined) {
      return { action: "cancel" };
    }

    const correlationId = `req:${ulid()}`;
    const registered = deps.requests.register({
      correlationId,
      timeoutMs: deps.defaultTimeoutMs,
      signal: extra.signal,
    });

    try {
      await Effect.runPromise(
        deps.inbox.send(elicitAddress, {
          type: ELICIT_REQUEST_MESSAGE_TYPE,
          correlationId,
          payload: {
            request: harnessRequest,
            replyTo: deps.replyToAddress,
            correlationId,
          },
        }),
      );
      const result = (await registered.promise) as ElicitationResult<unknown>;
      return elicitationResultToMcp(result);
    } catch (err) {
      // Surface timeouts / aborts as cancel — the elicit's semantic
      // terminal already includes these via the failure outcome, but
      // the MCP wire only carries the three actions.
      console.warn(`[mcp:${deps.serverId}] elicit dispatch failed: ${stringifyError(err)}`);
      return { action: "cancel" };
    }
  };
}

function translateMcpToHarness(
  request: ElicitRequest,
): ElicitationRequest<StandardSchemaV1> | undefined {
  const params = request.params as ElicitRequestFormParams | ElicitRequestURLParams;
  if (params.mode === "url") {
    return {
      mode: "url",
      message: params.message,
      url: params.url,
      elicitationId: params.elicitationId,
    };
  }
  return {
    mode: "form",
    message: params.message,
    // MCP `requestedSchema` is a JSON Schema object — wrap as
    // Standard-Schema. Functions are not serializable; this is what
    // the harness keeps for re-validation server-side.
    schema: jsonSchema(params.requestedSchema as Readonly<Record<string, unknown>>),
  };
}

function emitRoutingWarning(
  deps: ElicitDispatchDeps,
  reason: "no-active-session" | "address-unresolved" | "routing-ambiguous",
  request: ElicitRequest,
  sessionId?: string,
): void {
  // Fire-and-forget bus emit. Observability picks it up; the elicit
  // itself returns `{ action: "cancel" }` so the wire surface stays
  // clean.
  void Effect.runPromise(
    deps.bus.append({
      id: ulid(),
      surface: "mcp",
      name: `mcp:warning:routing-dropped`,
      phase: "delta",
      timestamp: Date.now(),
      scope: {},
      payload: {
        serverId: deps.serverId,
        reason,
        ...(sessionId !== undefined ? { sessionId } : {}),
        message: (request.params as { message?: string }).message ?? "",
      },
    } as Parameters<typeof deps.bus.append>[0]),
  ).catch(() => {
    // Substrate emit failures are not actionable here.
  });
}

function stringifyError(err: unknown): string {
  if (err === null || err === undefined) return "unknown";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && "_tag" in err) {
    return String((err as { _tag: string })._tag);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ============================================================================
// Result translation
// ============================================================================

/**
 * Map agentick's discriminated {@link ElicitationResult} onto MCP's
 * three-action {@link ElicitResult}.
 *
 *   accepted → accept + content (URL mode: empty content, consent-only)
 *   declined → decline
 *   cancelled → cancel
 *   failed    → cancel (logged; MCP wire doesn't model failure modes)
 */
export function elicitationResultToMcp(result: ElicitationResult<unknown>): ElicitResult {
  switch (result.outcome) {
    case "accepted":
      // URL-mode accepted carries `value: undefined`; form-mode
      // accepted carries the validated reply. Either way, marshal as
      // the MCP content object (undefined for URL is omitted).
      if (result.value === undefined) {
        return { action: "accept" };
      }
      return {
        action: "accept",
        content: result.value as Readonly<Record<string, string | number | boolean | string[]>>,
      };
    case "declined":
      return { action: "decline" };
    case "cancelled":
      return { action: "cancel" };
    case "failed":
      console.warn(
        `[mcp] elicitation failed (${result.failure.kind}): ${result.failure.reason ?? "no reason"}`,
      );
      return { action: "cancel" };
  }
}
