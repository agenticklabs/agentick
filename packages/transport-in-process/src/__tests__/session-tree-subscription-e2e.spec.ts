/**
 * `sub/subscribe` over the `session-tree` scope — a client attached to a root
 * session sees its LIVING SUBTREE's channels.
 *
 * ## What was blind
 *
 * A channel event is scoped to the session that emitted it, and a sub-agent is
 * its own session. So a client watching `session:channel:task-status` on a root
 * saw nothing from the sub-agents that root spawned — and that is exactly the
 * work worth watching, because a detached task or a cross-turn sub-agent
 * outlives the turn that started it and has no turn stream to ride.
 *
 * ## What the scope does
 *
 * `{ kind: "session-tree", id }` opens the same producers `{ kind: "session" }`
 * does, widened to the owning app and narrowed on arrival by
 * `app.sessionTreeContains(root, emitter)` — the live `parentSessionId` climb.
 * Membership is LINEAGE, not turn: a descendant belongs whichever turn spawned
 * it, and keeps belonging after that turn settles. Frames keep their envelopes,
 * so attribution rides `scope.sessionId` with nothing added.
 *
 * The turn-scoped rung below it is `session/send`'s `fanIn` (one turn's
 * progress, widened to that turn's descendants) — see
 * `progress-fan-in-e2e.spec.ts`. Turn interiors there; living subtree here.
 *
 * Real gateway, real app, real sessions, real `spawn`, real task harness — the
 * exclusions are the half that matters, so nothing here is stubbed.
 */

import "@agentick/tasks";

import { describe, expect, it } from "vitest";

import { fakeCompiler } from "@agentick/compiler/testing";
import { createGateway } from "@agentick/gateway";
import type {
  EventFrame,
  EventQuery,
  SessionHarnessProtocol,
  SubscriptionStream,
} from "@agentick/spec";
import type { TaskStatusSnapshotFrame } from "@agentick/tasks";
import { waitFor } from "@agentick/utils/testing";

import { inProcessTransport } from "../index.js";

/** The channel query `sub/subscribe` recognises as "exactly one session channel". */
function channelQuery(channel: string): EventQuery {
  return { surface: "session", name: { exact: `session:channel:${channel}` } };
}

/**
 * A gateway with one app and a root session, plus a connected transport.
 * `otherApp` exists so the "foreign session" case can be made on BOTH axes —
 * another root in this app, and a session on a different app entirely.
 */
async function makeStack() {
  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "tree-app",
    rootElement: null,
    options: { compiler: fakeCompiler() },
  });
  const otherApp = await gateway.createApp({
    appId: "other-app",
    rootElement: null,
    options: { compiler: fakeCompiler() },
  });
  const root = await app.createSession({ sessionId: "root" });
  const transport = inProcessTransport({ gateway });
  await transport.connect();
  return {
    gateway,
    app,
    otherApp,
    root: root as unknown as SessionHarnessProtocol,
    transport,
    cleanup: async () => {
      await transport.close();
      await gateway.close();
    },
  };
}

/** Spawn an UNBOUND child — a live session with no execution of its own. */
async function spawnChild(
  parent: SessionHarnessProtocol,
  sessionId: string,
): Promise<SessionHarnessProtocol> {
  return (await parent.spawn({ sessionId })) as SessionHarnessProtocol;
}

/**
 * Subscribe, drain in the background, and wait for the subscription to be LIVE
 * on the bus before returning. `transport.subscribe` hands back a stream while
 * its `sub/subscribe` RPC is still in flight, so a publish issued immediately
 * after can beat the server-side bus subscription — which would make every
 * assertion below a race rather than a statement about filtering.
 */
async function open(stream: SubscriptionStream) {
  const sink = collect(stream);
  await sink.settle();
  return sink;
}

/** Drain a subscription in the background, collecting frames. */
function collect(stream: SubscriptionStream) {
  const frames: EventFrame[] = [];
  const drain = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  return {
    frames,
    /** Which session emitted each frame, in arrival order. */
    emitters: () => frames.map((f) => f.envelope.scope.sessionId),
    async settle() {
      await new Promise((r) => setTimeout(r, 30));
    },
    async close() {
      await stream.close();
      await drain;
    },
  };
}

/** A parked task — `working` and staying that way, so it shows up in a snapshot. */
function parkTask(session: SessionHarnessProtocol): string {
  const sess = session as unknown as {
    tasks: {
      submit(fn: (a: { signal: AbortSignal }) => Promise<string>): {
        taskId: string;
        result: Promise<unknown>;
      };
      status(id: string): string;
      cancel(id: string, reason?: string): Promise<void>;
    };
  };
  const handle = sess.tasks.submit(
    async ({ signal }) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  handle.result.catch(() => {});
  return handle.taskId;
}

describe("sub/subscribe — the session-tree scope", () => {
  it("carries a DESCENDANT's channel frames, attributed to the descendant", async () => {
    const { root, transport, cleanup } = await makeStack();
    const kid = await spawnChild(root, "kid");
    const grandkid = await spawnChild(kid, "grandkid");

    const sink = await open(
      transport.subscribe({ kind: "session-tree", id: "root" }, channelQuery("demo")),
    );

    await root.channel("demo").publish({ from: "root" });
    await kid.channel("demo").publish({ from: "kid" });
    await grandkid.channel("demo").publish({ from: "grandkid" });
    await waitFor(() => sink.frames.length === 3, { description: "three tree frames" });

    // Membership is the lineage, not one hop — and the ROOT is a member of its
    // own tree (unlike an execution's origin session, which is not a member of
    // that turn).
    expect(sink.emitters()).toEqual(["root", "kid", "grandkid"]);
    // Attribution rides the envelope scope, unchanged. Nothing was added to the
    // frame to make the tree scope work.
    expect(sink.frames[1]!.envelope.payload).toEqual({ from: "kid" });

    await sink.close();
    await cleanup();
  });

  it("a PLAIN session subscription still sees only the session itself", async () => {
    // The pin on what did NOT change: the narrow scope is still narrow, and the
    // tree scope is opt-in.
    const { root, transport, cleanup } = await makeStack();
    const kid = await spawnChild(root, "kid");

    const sink = await open(
      transport.subscribe({ kind: "session", id: "root" }, channelQuery("demo")),
    );

    await kid.channel("demo").publish({ from: "kid" });
    await root.channel("demo").publish({ from: "root" });
    await sink.settle();

    expect(sink.emitters()).toEqual(["root"]);

    await sink.close();
    await cleanup();
  });

  it("splices EACH live member's channel snapshot at subscribe, root first", async () => {
    // The late-joiner case, one rung up: a client attaching now has exactly one
    // chance to learn what a descendant's board already holds, because a
    // snapshot is sent once and the live tail replays nothing.
    const { root, transport, cleanup } = await makeStack();
    const kid = await spawnChild(root, "kid");

    const rootTask = parkTask(root);
    const kidTask = parkTask(kid);
    await waitFor(
      () =>
        (root as unknown as { tasks: { status(id: string): string } }).tasks.status(rootTask) ===
          "working" &&
        (kid as unknown as { tasks: { status(id: string): string } }).tasks.status(kidTask) ===
          "working",
      { description: "both tasks working" },
    );

    const sink = collect(
      transport.subscribe({ kind: "session-tree", id: "root" }, channelQuery("task-status")),
    );
    await waitFor(() => sink.frames.length >= 2, { description: "both snapshots" });

    // Root first, then breadth-first — a late joiner paints the root's board
    // before its descendants'.
    expect(sink.emitters().slice(0, 2)).toEqual(["root", "kid"]);
    const kidSnapshot = sink.frames[1]!.envelope.payload as TaskStatusSnapshotFrame;
    expect(kidSnapshot.kind).toBe("snapshot");
    expect(kidSnapshot.tasks.map((t) => t.taskId)).toEqual([kidTask]);

    await sink.close();
    await cleanup();
  });

  it("a session spawned AFTER subscribe joins the stream with no retro-splice", async () => {
    // Nothing re-enumerates the tree: the new member's channel emits as it
    // populates, and the arrival filter is a live registry read, so the frame
    // is admitted the moment it exists.
    const { root, transport, cleanup } = await makeStack();

    const sink = await open(
      transport.subscribe({ kind: "session-tree", id: "root" }, channelQuery("demo")),
    );
    expect(sink.frames).toHaveLength(0);

    const late = await spawnChild(root, "late");
    await late.channel("demo").publish({ from: "late" });
    await waitFor(() => sink.frames.length === 1, { description: "the late member's frame" });

    expect(sink.emitters()).toEqual(["late"]);

    await sink.close();
    await cleanup();
  });

  it("a FOREIGN session sharing the gateway is excluded — same app or not", async () => {
    const { app, otherApp, root, transport, cleanup } = await makeStack();
    const kid = await spawnChild(root, "kid");
    // A second root in the SAME app: same bus, no lineage to `root`.
    const sibling = (await app.createSession({
      sessionId: "stranger",
    })) as unknown as SessionHarnessProtocol;
    // And a session on a different app on the same gateway.
    const foreign = (await otherApp.createSession({
      sessionId: "foreign",
    })) as unknown as SessionHarnessProtocol;

    const sink = await open(
      transport.subscribe({ kind: "session-tree", id: "root" }, channelQuery("demo")),
    );

    await sibling.channel("demo").publish({ from: "stranger" });
    await foreign.channel("demo").publish({ from: "foreign" });
    await kid.channel("demo").publish({ from: "kid" });
    await waitFor(() => sink.frames.length === 1, { description: "the descendant's frame" });
    await sink.settle();

    // Only the descendant. Both strangers published FIRST, so their absence is
    // the filter working, not a race the assertion won.
    expect(sink.emitters()).toEqual(["kid"]);

    await sink.close();
    await cleanup();
  });

  it("unsubscribe tears the whole thing down", async () => {
    // The tree subscription holds an app-wide bus subscription behind an
    // arrival filter; if `close()` left it open, a descendant emitting later
    // would keep feeding a stream nobody is reading.
    const { root, transport, cleanup } = await makeStack();
    const kid = await spawnChild(root, "kid");

    const stream = transport.subscribe({ kind: "session-tree", id: "root" }, channelQuery("demo"));
    const sink = await open(stream);
    await kid.channel("demo").publish({ from: "kid" });
    await waitFor(() => sink.frames.length === 1, { description: "the first frame" });

    await sink.close();
    const afterClose = sink.frames.length;

    await kid.channel("demo").publish({ from: "kid, after close" });
    await root.channel("demo").publish({ from: "root, after close" });
    await new Promise((r) => setTimeout(r, 30));

    expect(sink.frames.length).toBe(afterClose);

    await cleanup();
  });
});
