/**
 * Client tool-output projection — the wire-shape-aware half of ROADMAP A3.
 *
 * `dispatchRequest` is the ONE funnel every client-facing frame passes
 * through: RPC responses (via `success(...)`) and every notification
 * (progress / subscription / `ctx.publish`, via the connection's
 * `DispatchSink`). This module knows the (few) frame shapes that carry tool
 * output and bounds the tool-result content inside each, delegating the
 * per-block work to the pure {@link ToolOutputBounder}
 * (`@agentick/spec-next`). The model path and the durable store are BELOW
 * this boundary and are never touched.
 *
 * The four client-facing paths, and where each carries tool output
 * (enumerated so the no-straddle guarantee is auditable):
 *
 *   1. `session/send` progress stream → `notifications/progress` whose
 *      `envelope.payload` is a `tool-dispatch` StreamEvent (`.content`), or
 *      the terminal `result` StreamEvent (a `SendResult`).
 *   2. `session/send` RPC result → `{ result: SendResult }`
 *      (`result.output` + `result.toolResults[].content`).
 *   3. `session/dispatch` RPC result → `{ content }`.
 *   4. timeline append subscription → `notifications/subscription/event`
 *      whose `envelope.payload` is `{ entries }`; a `tool` message entry's
 *      `content` holds the `tool_result` block.
 *
 * Every projector returns its input by REFERENCE when nothing exceeded the
 * limit — a small/absent payload is a genuine no-op, and (critically) the
 * projector NEVER mutates its argument. The store keeps the object it
 * persisted; the client gets a bounded copy.
 *
 * @see docs/proposals/v2/STATUS.md ROADMAP A3
 * @verifiedBy packages-next/transport/src/__tests__/client-projection.spec.ts
 */

import {
  TIMELINE_APPEND_EVENT_NAME,
  type ContentBlock,
  type ToolOutputBounder,
} from "@agentick/spec-next";

/** Minimal structural view of a `SendResult` — only the content-bearing slots. */
interface SendResultLike {
  readonly output?: readonly ContentBlock[];
  readonly toolResults?: readonly { readonly content: readonly ContentBlock[] }[];
}

/** Bound the content-bearing slots of a `SendResult`. Identity when unchanged. */
function projectSendResult<T extends SendResultLike>(send: T, bounder: ToolOutputBounder): T {
  const output = send.output ? bounder.boundMessageContent(send.output) : send.output;
  const toolResults = send.toolResults
    ? mapChanged(send.toolResults, (tr) => {
        const content = bounder.boundOutputBlocks(tr.content);
        return content === tr.content ? tr : { ...tr, content };
      })
    : send.toolResults;
  if (output === send.output && toolResults === send.toolResults) return send;
  return { ...send, output, toolResults };
}

/**
 * Project an RPC response `result` (paths 2 + 3). Unknown methods pass
 * through — the switch is the exhaustive list of tool-output-bearing
 * results.
 */
export function projectClientResult(
  method: string,
  result: unknown,
  bounder: ToolOutputBounder,
): unknown {
  if (result === null || typeof result !== "object") return result;
  switch (method) {
    case "session/send": {
      const r = result as { readonly result?: SendResultLike };
      if (!r.result) return result;
      const projected = projectSendResult(r.result, bounder);
      return projected === r.result ? result : { ...r, result: projected };
    }
    case "session/dispatch": {
      const r = result as { readonly content?: readonly ContentBlock[] };
      if (!r.content) return result;
      const content = bounder.boundOutputBlocks(r.content);
      return content === r.content ? result : { ...r, content };
    }
    default:
      return result;
  }
}

/**
 * Project a notification's `params` (paths 1 + 4). Unknown notification
 * methods pass through.
 */
export function projectClientNotification(
  method: string,
  params: unknown,
  bounder: ToolOutputBounder,
): unknown {
  if (params === null || typeof params !== "object") return params;
  switch (method) {
    case "notifications/subscription/event": {
      // Path 4 — timeline append envelope: bound the tool_result content in
      // each message entry. Scoped to the append event; other subscription
      // events (channel snapshots, lifecycle) carry no tool output.
      const p = params as {
        readonly envelope?: { readonly name?: string; readonly payload?: unknown };
      };
      const env = p.envelope;
      if (!env || env.name !== TIMELINE_APPEND_EVENT_NAME) return params;
      const payload = env.payload as
        | { readonly entries?: readonly TimelineEntryLike[] }
        | undefined;
      if (!payload?.entries) return params;
      const entries = mapChanged(payload.entries, (e) => projectTimelineEntry(e, bounder));
      if (entries === payload.entries) return params;
      return { ...p, envelope: { ...env, payload: { ...payload, entries } } };
    }
    case "notifications/progress": {
      // Path 1 — progress-wrapped StreamEvent.
      const p = params as { readonly envelope?: { readonly payload?: unknown } };
      const env = p.envelope;
      const ev = env?.payload;
      if (!ev || typeof ev !== "object") return params;
      const bounded = projectStreamEvent(ev, bounder);
      if (bounded === ev) return params;
      return { ...p, envelope: { ...env, payload: bounded } };
    }
    default:
      return params;
  }
}

/** Structural view of a message timeline entry — only what the projector reads. */
interface TimelineEntryLike {
  readonly kind?: string;
  readonly message?: { readonly content?: readonly ContentBlock[] };
}

function projectTimelineEntry<T extends TimelineEntryLike>(
  entry: T,
  bounder: ToolOutputBounder,
): T {
  if (entry.kind !== "message" || !entry.message?.content) return entry;
  const content = bounder.boundMessageContent(entry.message.content);
  return content === entry.message.content
    ? entry
    : { ...entry, message: { ...entry.message, content } };
}

function projectStreamEvent(ev: object, bounder: ToolOutputBounder): object {
  const type = (ev as { readonly type?: string }).type;
  if (type === "tool-dispatch") {
    const e = ev as { readonly content?: readonly ContentBlock[] };
    if (!e.content) return ev;
    const content = bounder.boundOutputBlocks(e.content);
    return content === e.content ? ev : { ...ev, content };
  }
  if (type === "result") {
    const e = ev as { readonly result?: SendResultLike };
    if (!e.result || typeof e.result !== "object") return ev;
    const projected = projectSendResult(e.result, bounder);
    return projected === e.result ? ev : { ...ev, result: projected };
  }
  return ev;
}

function mapChanged<T>(arr: readonly T[], fn: (t: T) => T): readonly T[] {
  let changed = false;
  const out = arr.map((t) => {
    const n = fn(t);
    if (n !== t) changed = true;
    return n;
  });
  return changed ? out : arr;
}
