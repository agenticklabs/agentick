/**
 * ElicitationBridge — translates inbound MCP `elicitation/create`
 * requests into agentick's substrate-level
 * {@link ElicitationHarnessProtocol} primitive, and translates the
 * resulting {@link ElicitationResult} back into MCP's `ElicitResult`
 * wire shape.
 *
 * Routing goes through the substrate's inbox (not an object reference,
 * not a slot):
 *
 *   ┌──────────────────────┐                ┌────────────────────────┐
 *   │  McpClientHarness    │                │  ElicitationHarness    │
 *   │  (per-session, per-  │                │  (per-session)         │
 *   │   server — #151)     │                │                        │
 *   ├──────────────────────┤                ├────────────────────────┤
 *   │  SDK elicit handler  │ inbox.send →   │  handleMessage         │
 *   │   ↓ build payload    │  elicit-request│   ↓ this.elicit(...)   │
 *   │   register Deferred  │                │   ↓ publish on bus     │
 *   │   await reply        │                │   ↓ await user reply   │
 *   │   ← request-response │ ← inbox.send   │   send back to replyTo │
 *   └──────────────────────┘                └────────────────────────┘
 *
 * Per-session McpClientHarness construction (#151) means each
 * connection serves exactly one session. The handler's
 * `elicitAddress` is fixed at construction. Cross-session routing
 * doesn't exist as a concept here — concurrency is solved by
 * construction, no slot to race on.
 *
 * Concurrent elicits FROM THE SAME SESSION work natively via the
 * RequestResponseRegistry's per-correlationId Deferreds.
 *
 * ## FUTURE OPTIMIZATION — connection pool keyed by auth principal
 *
 * Per-session fan-out is N×M for N sessions × M servers. Acceptable
 * for HTTP-remote streams; wasteful for stateless local stdio
 * servers and for huge multi-tenant deployments. The follow-up sits
 * BENEATH `McpClientHarness` as a `connection: McpConnectionRef`
 * indirection — sessions check connections out for the duration of
 * a tick / a callTool and check them back in. Same auth principal →
 * connection sharing (cheap); different principals → connection
 * isolation (wire-correct). Defer until production load demands.
 * Tracked in `packages/mcp/README.md` "Connection lifecycle"
 * and `blueprint/23-mcp-as-harness.md`.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md
 * @see ./harness.ts McpClientHarness fixed-address construction
 */

import { Effect } from "effect";
import { jsonSchema } from "@agentick/spec";
import type {
  ElicitationRequest,
  ElicitationResult,
  EventBus,
  MessageInbox,
  StandardSchemaV1,
} from "@agentick/spec";
import { ELICIT_REQUEST_MESSAGE_TYPE } from "@agentick/elicitation";
import { generateId } from "@agentick/runtime";
import type { RequestResponseRegistry } from "@agentick/runtime";

import type {
  ElicitRequest,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";

import { RELATED_TASK_META_KEY } from "../wire/task-codec.js";

// ============================================================================
// Inbox dispatch — the cluster-friendly seam
// ============================================================================

/**
 * Inputs the bridge needs at handler time. These come from the
 * McpClientHarness, which closes over them when it registers the SDK
 * handler.
 */
export interface ElicitDispatchDeps {
  /**
   * Fixed elicit-harness inbox address. `undefined` when the harness
   * wasn't constructed with an elicit address (no session-extension
   * wired the route) — inbound elicits then cancel cleanly and emit
   * `mcp:warning:routing-dropped`.
   */
  readonly elicitAddress: string | undefined;
  readonly inbox: MessageInbox;
  readonly bus: EventBus;
  readonly replyToAddress: string;
  readonly requests: RequestResponseRegistry<ElicitationResult<unknown>>;
  readonly serverId: string;
  readonly defaultTimeoutMs: number;
}

/**
 * Build the request-handler closure to register with
 * `client.setRequestHandler(ElicitRequestSchema, …)`.
 *
 *   1. Read the fixed elicit address.
 *   2. Send an `elicit-request` inbox envelope.
 *   3. Register a Deferred keyed by correlationId; the reply lands as
 *      a `request-response` envelope and `BaseHarness.dispatchMessage`
 *      auto-resolves it.
 *   4. Await the result, translate to MCP wire format.
 *
 * Unrouted elicits (no `elicitAddress`) return
 * `{ action: "cancel" }` AND emit `mcp:warning:routing-dropped` on
 * the bus.
 */
export function makeElicitRequestHandler(
  deps: ElicitDispatchDeps,
): (request: ElicitRequest, extra: { readonly signal: AbortSignal }) => Promise<ElicitResult> {
  return async (request, extra) => {
    if (deps.elicitAddress === undefined) {
      emitRoutingWarning(deps, "no-elicit-address", request);
      return { action: "cancel" };
    }

    const harnessRequest = translateMcpToHarness(request);
    if (harnessRequest === undefined) {
      return { action: "cancel" };
    }

    const correlationId = `req:${generateId()}`;
    const registered = deps.requests.register({
      correlationId,
      timeoutMs: deps.defaultTimeoutMs,
      signal: extra.signal,
    });

    try {
      await Effect.runPromise(
        deps.inbox.send(deps.elicitAddress, {
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
      // Timeouts / aborts surface as cancel — the harness-side failure
      // outcome carries the detail; the MCP wire only has the three
      // actions.
      console.warn(`[mcp:${deps.serverId}] elicit dispatch failed: ${stringifyError(err)}`);
      return { action: "cancel" };
    }
  };
}

function translateMcpToHarness(
  request: ElicitRequest,
): ElicitationRequest<StandardSchemaV1> | undefined {
  const params = request.params as ElicitRequestFormParams | ElicitRequestURLParams;
  // Inbound `params._meta["io.modelcontextprotocol/related-task"].taskId`
  // associates the elicit with a local task (#173). Per-task UI
  // surfaces filter on this field. The MCP request envelope places
  // `_meta` on `params` only (no top-level `_meta` on the request),
  // so a single lookup suffices.
  const relatedTaskId = readRelatedTaskMeta(params._meta);
  if (params.mode === "url") {
    return {
      mode: "url",
      message: params.message,
      url: params.url,
      elicitationId: params.elicitationId,
      ...(relatedTaskId !== undefined ? { relatedTaskId } : {}),
    };
  }
  return {
    mode: "form",
    message: params.message,
    // MCP `requestedSchema` is a JSON Schema object — wrap as
    // Standard-Schema. Functions are not serializable; this is what
    // the harness keeps for re-validation server-side.
    schema: jsonSchema(params.requestedSchema as Readonly<Record<string, unknown>>),
    ...(relatedTaskId !== undefined ? { relatedTaskId } : {}),
  };
}

function readRelatedTaskMeta(envelope: unknown): string | undefined {
  if (typeof envelope !== "object" || envelope === null) return undefined;
  const related = (envelope as Record<string, unknown>)[RELATED_TASK_META_KEY];
  if (typeof related !== "object" || related === null) return undefined;
  const taskId = (related as { taskId?: unknown }).taskId;
  return typeof taskId === "string" ? taskId : undefined;
}

function emitRoutingWarning(
  deps: ElicitDispatchDeps,
  reason: "no-elicit-address",
  request: ElicitRequest,
): void {
  // Fire-and-forget bus emit. Observability picks it up; the elicit
  // itself returns `{ action: "cancel" }` so the wire surface stays
  // clean.
  void Effect.runPromise(
    deps.bus.append({
      id: generateId(),
      surface: "mcp",
      name: `mcp:warning:routing-dropped`,
      phase: "delta",
      timestamp: Date.now(),
      scope: {},
      payload: {
        serverId: deps.serverId,
        reason,
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
