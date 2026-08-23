/**
 * A gateway-scope subscription is ONE TENANT's slice, and it is one BY
 * TOPOLOGY (ADR 102 stage 2).
 *
 * The leak this closes was live, not theoretical: a thread list subscribes at
 * `{ kind: "gateway" }` by design — that is how a row for a session you hold no
 * handle for goes busy — and `openScopeEvents` handed back `gateway.events()`
 * unfiltered. Holding the `sub:subscribe` verb was therefore enough to receive
 * every other principal's session traffic, because scope-target resolution keys
 * on `params.sessionId` and a subscription's target rides `params.scope.id`.
 * `{ kind: "app" }` is the same hole wearing a narrower name: apps inherit the
 * gateway's bus by default, so an app subscription is gateway-wide underneath.
 *
 * #299 closed it with an arrival filter, which was only ever as good as every
 * emitter's stamping discipline (#304 found four that had forgotten). What
 * closes it now is that the frames never meet: each principal's sessions live
 * on that principal's scope node, a subscriber attaches to the nodes they are
 * entitled to, and no edge of the bus tree carries a sibling's traffic. The
 * grants below are identical and TOTAL on both sides, so a grant can never be
 * what separates these principals — only the topology can.
 */

import { describe, expect, it } from "vitest";

import { fakeCompiler } from "@agentick/compiler/testing";
import { createGateway, staticAuthorizer } from "@agentick/gateway";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  channelEventQuery,
  sessionStatusEventQuery,
  type EventBus,
  type EventEnvelope,
  type EventFrame,
  type EventQuery,
  type IngressIdentity,
  type SessionStatusFrame,
  type SubscriptionScope,
} from "@agentick/spec";
import { dispatchRequest, type DispatchHost, type DispatchSink } from "@agentick/transport";
import { omitUndefined } from "@agentick/utils";
import { waitFor } from "@agentick/utils/testing";

import { inProcessTransport } from "../index.js";

/** A transport whose every request arrives stamped with `identity`. */
function identifiedTransport(gateway: DispatchHost, identity: IngressIdentity) {
  const subscriptions = new Map<string, () => Promise<void>>();
  return inProcessTransport({
    handler: (request, sendNotification) => {
      const sink: DispatchSink = {
        sendNotification: (n) => sendNotification(n),
        registerSubscription: (id, unsubscribe) => subscriptions.set(id, unsubscribe),
        unregisterSubscription: (id) => subscriptions.delete(id),
        registerInFlight: () => {},
        unregisterInFlight: () => {},
      };
      return dispatchRequest(gateway, request, sink, { identity });
    },
  });
}

/**
 * Open a subscription on `scope` and collect its envelopes. The trailing RPC is
 * a barrier — the subscription is registered server-side once it resolves, so
 * anything emitted after it cannot be missed by the drain.
 */
async function watch(
  gateway: DispatchHost,
  identity: IngressIdentity,
  scope: SubscriptionScope,
  query: EventQuery,
) {
  const transport = identifiedTransport(gateway, identity);
  await transport.connect();
  const seen: EventEnvelope[] = [];
  const stream = transport.subscribe(scope, query);
  void (async () => {
    for await (const frame of stream as AsyncIterable<EventFrame>) seen.push(frame.envelope);
  })();
  await transport.request("gateway/list_apps", {});
  return {
    seen,
    sessionIds: () => seen.map((e) => e.scope.sessionId),
    close: async () => {
      await stream.close();
      await transport.close();
    },
  };
}

const busOf = (harness: unknown): EventBus => (harness as { bus: EventBus }).bus;

/** {@link watch} over the session-status channel, read as its frame payloads. */
async function watchStatus(
  gateway: DispatchHost,
  identity: IngressIdentity,
  scope: SubscriptionScope,
) {
  const w = await watch(gateway, identity, scope, sessionStatusEventQuery());
  return {
    ...w,
    ids: () => w.seen.map((e) => (e.payload as SessionStatusFrame).sessionId),
  };
}

/**
 * `authorized: false` builds the local pole: no authenticator, so no identity,
 * so both `sessionNodeFor` and `attachableNodesFor` resolve to `[]` — the root
 * — and everything is visible, as the in-process default must be.
 */
async function makeGateway(
  authorized = true,
  withModel = false,
  sessions?: { readonly maxActive: number },
) {
  // The gateway's bus is created here rather than inside `createGateway` so a
  // scripted executor can be built on the SAME bus — its deltas are only
  // observable to a subscriber if both sides share one.
  const bus = new LocalEventBus();
  const gateway = await createGateway({
    bus,
    ...(authorized
      ? { authorizer: staticAuthorizer({ grants: { alice: ["*"], bob: ["*"] } }) }
      : {}),
  });
  await gateway.listen();
  const modelExecutor = withModel ? await scriptedExecutor(bus) : undefined;
  const app = await gateway.createApp({
    appId: "iso-app",
    rootElement: null,
    options: { compiler: fakeCompiler(), ...omitUndefined({ modelExecutor, sessions }) },
  });
  return { gateway, app };
}

const ALICE: IngressIdentity = { principal: "alice", scopes: ["*"] };
const BOB: IngressIdentity = { principal: "bob", scopes: ["*"] };

/** Deliver one turn over the wire as `identity` — the door that creates or resumes. */
async function send(gateway: DispatchHost, identity: IngressIdentity, sessionId: string) {
  const transport = identifiedTransport(gateway, identity);
  await transport.connect();
  await transport.request("session/send", {
    sessionId,
    messages: [{ role: "user", content: "hi" }],
  });
  await transport.close();
}

async function scriptedExecutor(bus: LocalEventBus) {
  const executor = new FakeLanguageModelExecutor(
    "iso-exec",
    new MemoryJournal(),
    bus,
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "hello" }],
            stopReason: "end",
          },
        },
      ],
    },
  );
  await executor.ready;
  return executor;
}

describe("the two principals are on disjoint buses", () => {
  it("each principal's sessions run on that principal's node, and the nodes are distinct", async () => {
    const { gateway, app } = await makeGateway();
    const alices = await app.createSession({ sessionId: "alice-bus", principal: "alice" });
    const bobs = await app.createSession({ sessionId: "bob-bus", principal: "bob" });

    // The gateway derives the app's session placement from its OWN resolver
    // against its OWN registry, so this is the same node the wire attaches to.
    const aliceNode = gateway.attachScopeNode(gateway.sessionNodeFor({ principal: "alice" }));
    const bobNode = gateway.attachScopeNode(gateway.sessionNodeFor({ principal: "bob" }));

    expect(busOf(alices)).toBe(aliceNode.bus);
    expect(busOf(bobs)).toBe(bobNode.bus);
    expect(aliceNode.bus).not.toBe(bobNode.bus);

    aliceNode.release();
    bobNode.release();
    await gateway.close();
  });
});

describe("gateway-scope subscriptions are carved by principal", () => {
  it("alice never receives bob's session frames", async () => {
    const { gateway, app } = await makeGateway();
    const alicesSession = await app.createSession({
      sessionId: "alice-session",
      principal: "alice",
    });
    const bobsSession = await app.createSession({ sessionId: "bob-session", principal: "bob" });

    const alice = await watchStatus(
      gateway,
      { principal: "alice", scopes: ["*"] },
      {
        kind: "gateway",
      },
    );
    const bob = await watchStatus(
      gateway,
      { principal: "bob", scopes: ["*"] },
      { kind: "gateway" },
    );

    // `close()` is a status TRANSITION, so each session publishes one frame
    // stamped with its owner's principal.
    await alicesSession.close();
    await bobsSession.close();

    await waitFor(() => alice.ids().length > 0 && bob.ids().length > 0, {
      description: "each principal's own frame",
    });

    expect(alice.ids()).toEqual(["alice-session"]);
    expect(bob.ids()).toEqual(["bob-session"]);
    // The leak, stated as the assertion it is. Bob's frame does not reach
    // alice because no edge of the tree runs from bob's node to hers.
    expect(alice.ids()).not.toContain("bob-session");

    await alice.close();
    await bob.close();
    await gateway.close();
  });

  it("app scope is carved the same way — it is gateway-wide underneath", async () => {
    const { gateway, app } = await makeGateway();
    const alicesSession = await app.createSession({ sessionId: "a-2", principal: "alice" });
    const bobsSession = await app.createSession({ sessionId: "b-2", principal: "bob" });

    const alice = await watchStatus(
      gateway,
      { principal: "alice", scopes: ["*"] },
      {
        kind: "app",
        id: "iso-app",
      },
    );

    await bobsSession.close();
    await alicesSession.close();

    await waitFor(() => alice.ids().length > 0, { description: "alice's own frame" });
    expect(alice.ids()).toEqual(["a-2"]);

    await alice.close();
    await gateway.close();
  });
});

describe("what a node attachment does and does not reach", () => {
  it("an authenticated caller does NOT receive an unowned session's frames", async () => {
    const { gateway, app } = await makeGateway();
    const unowned = await app.createSession({ sessionId: "unowned" });
    const owned = await app.createSession({ sessionId: "owned", principal: "alice" });

    const alice = await watchStatus(
      gateway,
      { principal: "alice", scopes: ["*"] },
      {
        kind: "gateway",
      },
    );

    await unowned.close();
    await owned.close();

    // The owned frame is the barrier: it is published second, so once it has
    // arrived the unowned one has had its chance.
    await waitFor(() => alice.ids().includes("owned"), { description: "alice's own frame" });
    // A principal-less session resolves to the ROOT node; alice is attached to
    // hers, and fan-in runs upward only, so the frame has no edge to travel.
    // Under the arrival filter this depended on the emitter having stamped;
    // now the stamp is provenance and the placement is the guarantee.
    expect(alice.ids()).not.toContain("unowned");

    await alice.close();
    await gateway.close();
  });

  it("control-plane events still reach an authenticated caller", async () => {
    // Fan-in runs upward, so a root-level fact would never reach a node
    // attachment on its own. The carve-out is the SECOND attachment in the set
    // — the root, restricted to the host-owned control-plane allowlist — and
    // it is topic selection, never a look at whose frame arrived.
    const { gateway } = await makeGateway();
    const transport = identifiedTransport(gateway, { principal: "alice", scopes: ["*"] });
    await transport.connect();
    const seen: string[] = [];
    const stream = transport.subscribe({ kind: "gateway" }, { surface: "gateway" });
    void (async () => {
      for await (const frame of stream as AsyncIterable<EventFrame>) seen.push(frame.envelope.name);
    })();
    await transport.request("gateway/list_apps", {});

    await waitFor(
      () => {
        gateway.emitCapabilitiesChanged();
        return seen.length > 0;
      },
      { description: "the control-plane frame" },
    );

    await stream.close();
    await transport.close();
    await gateway.close();
  });

  it("a principal-LESS deployment is unaffected — nothing stamped, nobody authenticated", async () => {
    const { gateway, app } = await makeGateway(false);
    const one = await app.createSession({ sessionId: "local-1" });
    const two = await app.createSession({ sessionId: "local-2" });

    const local = await watchStatus(gateway, {}, { kind: "gateway" });

    await one.close();
    await two.close();

    await waitFor(() => local.ids().length === 2, { description: "both frames" });
    expect(local.ids().sort()).toEqual(["local-1", "local-2"]);

    await local.close();
    await gateway.close();
  });
});

/**
 * Every frame a session produces rides that session's bus, whoever built the
 * envelope — a userland channel publish, a snapshot the wire splices in, or a
 * model delta from the executor the whole app shares. The #304 stamps stay on
 * those envelopes as provenance (journal reads, cluster relays, debugging);
 * nothing about DELIVERY depends on them any more.
 */
describe("everything a session emits rides its own bus", () => {
  it("a userland channel publish reaches its owner and nobody else", async () => {
    const { gateway, app } = await makeGateway();
    const alices = await app.createSession({ sessionId: "alice-chan", principal: "alice" });
    const bobs = await app.createSession({ sessionId: "bob-chan", principal: "bob" });

    const board = channelEventQuery("board");
    const alice = await watch(
      gateway,
      { principal: "alice", scopes: ["*"] },
      { kind: "gateway" },
      board,
    );
    const bob = await watch(
      gateway,
      { principal: "bob", scopes: ["*"] },
      { kind: "gateway" },
      board,
    );

    await alices.channel("board").publish({ from: "alice" });
    await bobs.channel("board").publish({ from: "bob" });

    await waitFor(() => alice.seen.length > 0 && bob.seen.length > 0, {
      description: "each principal's own frame",
    });

    expect(alice.sessionIds()).toEqual(["alice-chan"]);
    expect(bob.sessionIds()).toEqual(["bob-chan"]);
    expect(alice.seen[0]!.payload).toEqual({ from: "alice" });

    await alice.close();
    await bob.close();
    await gateway.close();
  });

  it("a model delta reaches its owner and nobody else", async () => {
    const { gateway, app } = await makeGateway(true, true);
    const alices = await app.createSession({ sessionId: "alice-run", principal: "alice" });

    const modelEvents: EventQuery = { surface: "model" };
    const alice = await watch(
      gateway,
      { principal: "alice", scopes: ["*"] },
      { kind: "gateway" },
      modelEvents,
    );
    const bob = await watch(
      gateway,
      { principal: "bob", scopes: ["*"] },
      { kind: "gateway" },
      modelEvents,
    );

    const handle = await alices.send({ messages: [{ role: "user", content: "hi" }] });
    await handle.result;

    await waitFor(() => alice.seen.some((e) => e.phase === "delta"), {
      description: "alice's model deltas",
    });
    // The model executor is ONE instance on the app's bus, driving every
    // session — so the deltas reach alice's node only because the execution
    // scopes its emission target to her session's bus (ADR 102 stage 2).
    expect(new Set(alice.sessionIds())).toEqual(new Set(["alice-run"]));
    expect(bob.seen).toEqual([]);

    await alice.close();
    await bob.close();
    await gateway.close();
  });

  it("a channel snapshot carries its owner too", async () => {
    // The splice rides the SESSION scope, which the arrival filter does not
    // touch — so this pins the stamp at the emitter rather than a drop the
    // filter would make. The moment session scopes are carved by principal, an
    // unstamped opening frame is a blank board on reconnect.
    const { gateway, app } = await makeGateway();
    await app.createSession({ sessionId: "snap", principal: "alice" });

    const transport = identifiedTransport(gateway, { principal: "alice", scopes: ["*"] });
    await transport.connect();
    const stream = transport.subscribe({ kind: "session", id: "snap" }, sessionStatusEventQuery());

    const first = await (stream as AsyncIterable<EventFrame>)[Symbol.asyncIterator]().next();
    expect(first.value.envelope.scope).toEqual({ sessionId: "snap", principal: "alice" });

    await stream.close();
    await transport.close();
    await gateway.close();
  });
});

describe("the attachment set is one stream", () => {
  it("one subscription carries both the caller's node frames and the control plane", async () => {
    const { gateway, app } = await makeGateway();
    const alices = await app.createSession({ sessionId: "merged", principal: "alice" });

    // No `name` constraint, so the control-plane attachment is admitted
    // alongside the node one and both drain onto the same stream.
    const alice = await watch(
      gateway,
      { principal: "alice", scopes: ["*"] },
      { kind: "gateway" },
      {},
    );

    // `watch`'s trailing RPC already settled the subscription, so both of these
    // land after it is registered — no emit-until-seen loop to spin on.
    await alices.channel("board").publish({ from: "alice" });
    gateway.emitCapabilitiesChanged();
    await waitFor(
      () =>
        alice.seen.some((e) => e.name === "session:channel:board") &&
        alice.seen.some((e) => e.name === "gateway:capabilities:changed"),
      { description: "one frame from each attachment" },
    );

    await alice.close();
    await gateway.close();
  });
});

describe("the bounded scopes are untouched", () => {
  it("a session-scope subscription still opens on its snapshot", async () => {
    const { gateway, app } = await makeGateway();
    await app.createSession({ sessionId: "bounded", principal: "alice" });

    const transport = identifiedTransport(gateway, { principal: "alice", scopes: ["*"] });
    await transport.connect();
    const stream = transport.subscribe(
      { kind: "session", id: "bounded" },
      sessionStatusEventQuery(),
    );

    const first = await (stream as AsyncIterable<EventFrame>)[Symbol.asyncIterator]().next();
    expect((first.value.envelope.payload as SessionStatusFrame).sessionId).toBe("bounded");

    await stream.close();
    await transport.close();
    await gateway.close();
  });

  it("a session-scope subscription still receives LIVE frames from a node-resident session", async () => {
    // Since stage 3 this is the node attachment itself, narrowed to one id by
    // topic — the session alice subscribes to is on the node she attaches to.
    const { gateway, app } = await makeGateway();
    const alices = await app.createSession({ sessionId: "live-node", principal: "alice" });

    const alice = await watch(
      gateway,
      { principal: "alice", scopes: ["*"] },
      { kind: "session", id: "live-node" },
      channelEventQuery("board"),
    );

    await alices.channel("board").publish({ from: "alice" });
    await waitFor(() => alice.seen.length > 0, { description: "the live frame" });
    expect(alice.sessionIds()).toEqual(["live-node"]);

    await alice.close();
    await gateway.close();
  });
});

/**
 * A `session` subscription is an own-node attachment narrowed to one id by
 * topic (ADR 102 stage 3), so it resolves nothing: live, evicted, and
 * never-created ids are ONE shape. That is what makes the doors arc's draft
 * flow race-free — mint, subscribe, then send — and it is what retires
 * id-as-capability, since an id that materializes under another principal's
 * node never transits yours.
 */
describe("a session subscription filters your own subtree instead of naming a session", () => {
  it("carries a client-minted id from silence through the send that creates it", async () => {
    const { gateway, app } = await makeGateway(true, true);
    const draft = "draft-01";

    const alice = await watchStatus(gateway, ALICE, { kind: "session", id: draft });

    // Nothing under that id, and subscribing neither created one nor 404'd.
    expect(app.getSession(draft)).toBeUndefined();
    expect(alice.ids()).toEqual([]);

    await send(gateway, ALICE, draft);

    // The pipe was open BEFORE the create door fired, so the session's first
    // status transitions land on the subscription that was already waiting.
    await waitFor(() => alice.ids().length > 0, { description: "the draft's frames" });
    expect(new Set(alice.ids())).toEqual(new Set([draft]));

    await alice.close();
    await gateway.close();
  });

  it("stays silent on another principal's EXISTING session, which its owner hears", async () => {
    const { gateway, app } = await makeGateway();
    const bobs = await app.createSession({ sessionId: "bobs-thread", principal: "bob" });

    const alice = await watchStatus(gateway, ALICE, { kind: "session", id: "bobs-thread" });
    const bob = await watchStatus(gateway, BOB, { kind: "session", id: "bobs-thread" });

    await bobs.close();

    await waitFor(() => bob.ids().length > 1, { description: "bob's snapshot and close" });
    expect(new Set(bob.ids())).toEqual(new Set(["bobs-thread"]));
    // Alice named a real id she does not own. The arm this replaces read the
    // root ring, so holding `sub:subscribe` and knowing the id was enough — and
    // the opening snapshot handed over the channel's contents besides.
    expect(alice.ids()).toEqual([]);
    expect(alice.seen).toEqual([]);

    await alice.close();
    await bob.close();
    await gateway.close();
  });

  it("is quiet on an EVICTED session and flows again when a send remounts it", async () => {
    const { gateway, app } = await makeGateway(true, true, { maxActive: 1 });
    await send(gateway, ALICE, "paged");
    await app.createSession({ sessionId: "filler", principal: "alice" });
    expect(app.getSession("paged")).toBeUndefined();

    const alice = await watchStatus(gateway, ALICE, { kind: "session", id: "paged" });
    // Observation does not remount, so there is nothing to hear yet.
    expect(app.getSession("paged")).toBeUndefined();
    expect(alice.ids()).toEqual([]);

    await send(gateway, ALICE, "paged");

    // The resume door puts it back on the SAME node — placement is a function
    // of the principal, not of when the session was built.
    await waitFor(() => alice.ids().includes("paged"), { description: "the remounted frames" });

    await alice.close();
    await gateway.close();
  });

  it("reads a session scope off the ROOT for an unauthenticated caller", async () => {
    const { gateway, app } = await makeGateway(false);
    const local = await app.createSession({ sessionId: "local-sess" });

    const watcher = await watchStatus(gateway, {}, { kind: "session", id: "local-sess" });
    await local.close();

    await waitFor(() => watcher.ids().length > 1, { description: "the local frames" });
    expect(new Set(watcher.ids())).toEqual(new Set(["local-sess"]));

    await watcher.close();
    await gateway.close();
  });
});
