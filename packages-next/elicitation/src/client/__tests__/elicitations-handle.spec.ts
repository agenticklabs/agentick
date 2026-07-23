/**
 * `elicitationsHandle` — focused behavior: the SNAPSHOT frame seeds the pending
 * set (a client connecting mid-ask sees it), live REQUEST deltas add asks,
 * answering (by item verb or by id) removes the ask from `list()`, and the item
 * handle is built the SAME way from both sources.
 */

import { describe, expect, it } from "vitest";
import type {
  Cursor,
  EventFrame,
  EventQuery,
  ProtocolEvent,
  SubscriptionScope,
  SubscriptionStream,
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec-next";
import { channelEventName } from "@agentick/spec-next";
import { waitFor } from "@agentick/utils-next/testing";

import { elicitationsHandle } from "../elicitations.js";
import { ELICITATION_CHANNEL } from "../../channel.js";

/** A push stream a test emits channel frames onto — payload + optional metadata. */
function pushStream(): SubscriptionStream & {
  emit(payload: unknown, metadata?: Record<string, unknown>): void;
} {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let n = 0;
  return {
    subscriptionId: "sub-test",
    emit(payload, metadata): void {
      const f: EventFrame = {
        cursor: { value: ++n } as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "session",
          name: channelEventName(ELICITATION_CHANNEL),
          phase: "delta",
          timestamp: 0,
          scope: { sessionId: "s1" },
          payload,
          ...(metadata ? { metadata } : {}),
        } as ProtocolEvent,
      };
      const w = waiters.shift();
      if (w) w({ value: f, done: false });
      else buffer.push(f);
    },
    [Symbol.asyncIterator](): AsyncIterator<EventFrame> {
      return {
        next(): Promise<IteratorResult<EventFrame>> {
          if (buffer.length) return Promise.resolve({ value: buffer.shift()!, done: false });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {},
  };
}

function fakeClient(
  stream: SubscriptionStream,
  captured: { requests: { method: WireMethod; params: unknown }[] } = { requests: [] },
) {
  return {
    transport: {
      subscribe(_scope: SubscriptionScope, _query?: EventQuery): SubscriptionStream {
        return stream;
      },
      async request<M extends WireMethod>(
        method: M,
        params: WireParams<M>,
      ): Promise<WireResult<M>> {
        captured.requests.push({ method, params });
        return null as WireResult<M>;
      },
    },
  };
}

describe("elicitationsHandle", () => {
  it("the SNAPSHOT frame seeds list() (connect mid-ask); item carries verbs", async () => {
    const stream = pushStream();
    const handle = elicitationsHandle(fakeClient(stream), "s1");

    stream.emit({
      kind: "snapshot",
      requests: [{ correlationId: "c1", replyTo: "r1", payload: { message: "approve?" } }],
    });
    await waitFor(() => handle.list().length > 0);

    expect(handle.list()).toMatchObject([{ correlationId: "c1", message: "approve?" }]);
    expect(typeof handle.get("c1")?.accept).toBe("function");
  });

  it("a listed item's accept() routes to the wire and removes the ask", async () => {
    const stream = pushStream();
    const captured = { requests: [] as { method: WireMethod; params: unknown }[] };
    const handle = elicitationsHandle(fakeClient(stream, captured), "s1");

    stream.emit({
      kind: "snapshot",
      requests: [{ correlationId: "c1", replyTo: "r1", payload: { message: "approve?" } }],
    });
    await waitFor(() => handle.list().length > 0);

    await handle.list()[0].accept({ approved: true });
    expect(captured.requests[0]).toMatchObject({
      method: "session/respond_to_elicitation",
      params: { sessionId: "s1", correlationId: "c1", outcome: "accepted" },
    });
    expect(handle.list()).toHaveLength(0); // answered → dropped from pending
    expect(handle.get("c1")).toBeUndefined();
  });

  it("a live REQUEST delta (metadata) adds an ask via the same constructor", async () => {
    const stream = pushStream();
    const handle = elicitationsHandle(fakeClient(stream), "s1");

    stream.emit(
      { mode: "form", message: "live ask" },
      { requestType: "request", correlationId: "c2", replyTo: "r2" },
    );
    await waitFor(() => handle.list().length > 0);
    expect(handle.get("c2")).toMatchObject({ correlationId: "c2", message: "live ask" });
  });

  it("respond(id) rejects an unknown/answered id (the by-id escape hatch)", async () => {
    const stream = pushStream();
    const handle = elicitationsHandle(fakeClient(stream), "s1");
    await expect(handle.respond("nope", { outcome: "accepted" })).rejects.toBeDefined();
  });

  it("subscribe(cb) fires on change with NO arguments", async () => {
    const stream = pushStream();
    const handle = elicitationsHandle(fakeClient(stream), "s1");
    let fired = 0;
    let argCount = -1;
    handle.subscribe((...args: unknown[]) => {
      fired++;
      argCount = args.length;
    });
    stream.emit({
      kind: "snapshot",
      requests: [{ correlationId: "c1", replyTo: "r1", payload: { message: "x" } }],
    });
    await waitFor(() => fired > 0);
    expect(argCount).toBe(0);
  });
});
