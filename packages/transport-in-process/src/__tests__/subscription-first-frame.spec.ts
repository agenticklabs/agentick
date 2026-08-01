/**
 * A LATE subscriber gets frame one.
 *
 * `sub/subscribe` splices a session channel's snapshot in front of the live
 * stream, so the first frame a fresh subscriber receives is the channel's
 * current state. That is the entire value of the snapshot — and it was
 * unreachable for the subscriber it was built for.
 *
 * The server published the opening frame before the client could know the
 * subscription's id. The handler registered the subscription, started a
 * background drain, and only THEN returned `{ subscriptionId }`; the drain's
 * first `publish` reached the client in a microtask or two while the response
 * was still unwinding `dispatchRequest`. Client-side, the stream sat under a
 * TENTATIVE id until the response callback re-keyed it, and
 * `routeNotification` drops an event whose `subscriptionId` has no stream:
 * `const stream = this.subscriptionStreams.get(subId); if (!stream) return;`.
 * Frame one arrived, matched nothing, and was gone — permanently, since a
 * snapshot is sent once.
 *
 * The fix is not a better ordering. Over `@agentick/transport-http` the RPC
 * response comes back on the POST body while notifications ride a separate
 * persistent SSE GET — two connections, no ordering relation, nothing to
 * arrange. So the CLIENT allocates the subscription id and the server adopts
 * it: the stream is registered under its final id before the request frame is
 * written, and no frame is unroutable on any transport.
 *
 * These cases subscribe AFTER the state exists — the shape a UI attaching to a
 * live session has — and assert on the FIRST frame off the raw transport
 * stream, not on a client view that would paper over a dropped one.
 */

import "@agentick/elicitation";
import "@agentick/tasks";

import { describe, expect, it } from "vitest";

import { fakeCompiler } from "@agentick/compiler/testing";
import { ElicitationHarness, type ElicitationSnapshotFrame } from "@agentick/elicitation";
import { createGateway } from "@agentick/gateway";
import {
  ErrorCode,
  jsonSchema,
  type EventQuery,
  type StandardSchemaV1,
  type SubscriptionScope,
} from "@agentick/spec";
import type { TaskStatusSnapshotFrame } from "@agentick/tasks";
import { waitFor } from "@agentick/utils/testing";

import { inProcessTransport } from "../index.js";

/** Accepts any object — the ask's shape is irrelevant to what's under test. */
function lenientObject(): StandardSchemaV1<unknown, Record<string, unknown>> {
  return jsonSchema<Record<string, unknown>>(
    { type: "object", additionalProperties: true },
    {
      validator: (raw) =>
        raw !== null && typeof raw === "object"
          ? { value: raw as Record<string, unknown> }
          : { issues: [{ message: "expected an object" }] },
    },
  );
}

async function makeStack(sessionId: string, initialKnobs?: Readonly<Record<string, unknown>>) {
  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: `first-frame-app-${sessionId}`,
    rootElement: null,
    options: { compiler: fakeCompiler() },
  });
  const session = await app.createSession({
    sessionId,
    ...(initialKnobs !== undefined ? { initialKnobs } : {}),
  });
  return { gateway, session };
}

/** The channel query `sub/subscribe` recognises as "exactly one session channel". */
function channelQuery(channel: string): EventQuery {
  return { surface: "session", name: { exact: `session:channel:${channel}` } };
}

describe("a late subscriber receives the channel snapshot as its FIRST frame", () => {
  it("session channel: the snapshot beats the subscribe response", async () => {
    // State exists BEFORE anyone subscribes — the whole point.
    const { gateway, session } = await makeStack("first-frame-knobs", {
      temperature: 0.7,
      verbose: true,
    });

    const transport = inProcessTransport({ gateway });
    await transport.connect();

    const scope: SubscriptionScope = { kind: "session", id: session.id };
    const stream = transport.subscribe(scope, channelQuery("knobs-state"));

    // FIRST frame — no barrier, no polling, no `waitFor` over a list that may
    // fill later. Either the opening frame routed or it was dropped.
    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    expect(first.value.envelope.name).toBe("session:channel:knobs-state");
    expect(first.value.envelope.payload).toMatchObject({
      kind: "snapshot",
      values: { temperature: 0.7, verbose: true },
    });

    await transport.close();
    await gateway.close();
  });

  it("elicitation channel: a MID-ASK subscriber sees the pending ask", async () => {
    const { gateway, session } = await makeStack("first-frame-elicit");

    // Raise an ask and leave it outstanding. A subscriber that joins now has
    // exactly one chance to learn about it: frame one.
    void session.elicitation.elicit({ message: "pick a fruit", schema: lenientObject() });
    const elicitation = session.elicitation as unknown as ElicitationHarness;
    await waitFor(() => elicitation.pendingCount() === 1, { description: "the ask to be raised" });

    const transport = inProcessTransport({ gateway });
    await transport.connect();
    const stream = transport.subscribe(
      { kind: "session", id: session.id },
      channelQuery("elicitation"),
    );

    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value.envelope.name).toBe("session:channel:elicitation");
    const frame = first.value.envelope.payload as ElicitationSnapshotFrame;
    expect(frame.kind).toBe("snapshot");
    expect(frame.requests).toHaveLength(1);
    expect((frame.requests[0]!.payload as { message: string }).message).toBe("pick a fruit");

    await transport.close();
    await gateway.close();
  });

  it("task-status channel: a subscriber joining mid-run sees the WORKING task", async () => {
    const { gateway, session } = await makeStack("first-frame-tasks");

    // A task that parks until its signal aborts — working, and staying that
    // way, while the subscription is opened.
    const handle = session.tasks.submit(async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return "unreached";
    });
    // The cancel below rejects this; nobody is awaiting it.
    handle.result.catch(() => {});
    await waitFor(() => session.tasks.status(handle.taskId) === "working", {
      description: "the task to start working",
    });

    const transport = inProcessTransport({ gateway });
    await transport.connect();
    const stream = transport.subscribe(
      { kind: "session", id: session.id },
      channelQuery("task-status"),
    );

    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value.envelope.name).toBe("session:channel:task-status");
    const frame = first.value.envelope.payload as TaskStatusSnapshotFrame;
    expect(frame.kind).toBe("snapshot");
    expect(frame.tasks.map((t) => [t.taskId, t.status])).toEqual([[handle.taskId, "working"]]);

    await session.tasks.cancel(handle.taskId, "test done");
    await transport.close();
    await gateway.close();
  });
});

describe("the client-allocated subscription id is the connection's to police", () => {
  it("a DUPLICATE subscriptionId on one connection is refused with InvalidParams", async () => {
    // Adopting it would re-point the live subscription's routing at a second
    // producer — the first subscription's frames would arrive at a stream fed
    // by something else. Refused, with the caller's own fault code.
    const { gateway } = await makeStack("first-frame-dup");
    const transport = inProcessTransport({ gateway });
    await transport.connect();

    const params = { subscriptionId: "dup-1", scope: { kind: "gateway" } } as const;
    await expect(transport.request("sub/subscribe", params)).resolves.toEqual({
      subscriptionId: "dup-1",
    });
    await expect(transport.request("sub/subscribe", params)).rejects.toMatchObject({
      kind: "rpc",
      error: { code: ErrorCode.InvalidParams },
    });

    // A DIFFERENT id on the same connection is fine — uniqueness, not a quota.
    await expect(
      transport.request("sub/subscribe", { ...params, subscriptionId: "dup-2" }),
    ).resolves.toEqual({ subscriptionId: "dup-2" });

    await transport.close();
    await gateway.close();
  });
});
