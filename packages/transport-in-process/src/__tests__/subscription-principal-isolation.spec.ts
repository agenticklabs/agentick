/**
 * A gateway-scope subscription is ONE TENANT's slice, not the gateway (#297).
 *
 * The leak this closes was live, not theoretical: a thread list subscribes at
 * `{ kind: "gateway" }` by design — that is how a row for a session you hold no
 * handle for goes busy — and `openScopeEvents` handed back `gateway.events()`
 * unfiltered. Holding the `sub:subscribe` verb was therefore enough to receive
 * every other principal's session traffic, because scope-target resolution keys
 * on `params.sessionId` and a subscription's target rides `params.scope.id`.
 *
 * `{ kind: "app" }` is the same hole wearing a narrower name: apps inherit the
 * gateway's bus by default and `app.events()` injects no `appId`, so an app
 * subscription is gateway-wide in practice.
 */

import { describe, expect, it } from "vitest";

import { fakeCompiler } from "@agentick/compiler/testing";
import { createGateway, staticAuthorizer } from "@agentick/gateway";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  channelEventQuery,
  sessionStatusEventQuery,
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
 * Grants are identical and TOTAL on both sides, so a grant can never be what
 * separates these principals — the only thing that can is the arrival filter.
 * `authorized: false` builds the local pole instead: no authenticator, so no
 * identity and nothing to carve by.
 */
async function makeGateway(authorized = true, withModel = false) {
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
    options: { compiler: fakeCompiler(), ...omitUndefined({ modelExecutor }) },
  });
  return { gateway, app };
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
    // The leak, stated as the assertion it is.
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

describe("the unstamped envelope fails closed", () => {
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
    // Fail CLOSED. A SESSION envelope that forgot to stamp itself must not
    // become the way around the filter — the fix for one belongs at its emitter.
    expect(alice.ids()).not.toContain("unowned");

    await alice.close();
    await gateway.close();
  });

  it("control-plane events still reach an authenticated caller", async () => {
    // The carve-out, pinned as a claim rather than left as a side effect: an
    // envelope that names no session is not tenant data, and filtering it would
    // break capability reactivity for every authenticated deployment while
    // protecting nothing. `gateway:capabilities:changed` carries `gatewayId`
    // and an empty payload.
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
 * The filter fails closed, so an emitter that hand-builds its own envelope has
 * to stamp its own owner — the status channel was the only one that did, which
 * made every other session-named frame invisible to the two unbounded scopes.
 */
describe("a session stamps what it publishes outside the operation runner", () => {
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
    // The model executor is app-level and stamps no principal of its own — the
    // scope the loop hands it is the only thing carrying the session's owner.
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
});
