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
import {
  sessionStatusEventQuery,
  type EventFrame,
  type IngressIdentity,
  type SessionStatusFrame,
  type SubscriptionScope,
} from "@agentick/spec";
import { dispatchRequest, type DispatchHost, type DispatchSink } from "@agentick/transport";
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
 * Open a status-channel subscription on `scope` and collect its frames.
 * The returned `barrier` is an RPC round-trip — the subscription is registered
 * server-side once it resolves, so a transition triggered after it cannot be
 * missed by the drain.
 */
async function watchStatus(
  gateway: DispatchHost,
  identity: IngressIdentity,
  scope: SubscriptionScope,
) {
  const transport = identifiedTransport(gateway, identity);
  await transport.connect();
  const seen: SessionStatusFrame[] = [];
  const stream = transport.subscribe(scope, sessionStatusEventQuery());
  void (async () => {
    for await (const frame of stream as AsyncIterable<EventFrame>) {
      seen.push(frame.envelope.payload as SessionStatusFrame);
    }
  })();
  await transport.request("gateway/list_apps", {});
  return {
    seen,
    ids: () => seen.map((f) => f.sessionId),
    close: async () => {
      await stream.close();
      await transport.close();
    },
  };
}

/**
 * Grants are identical and TOTAL on both sides, so a grant can never be what
 * separates these principals — the only thing that can is the arrival filter.
 * `authorized: false` builds the local pole instead: no authenticator, so no
 * identity and nothing to carve by.
 */
async function makeGateway(authorized = true) {
  const gateway = await createGateway(
    authorized ? { authorizer: staticAuthorizer({ grants: { alice: ["*"], bob: ["*"] } }) } : {},
  );
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "iso-app",
    rootElement: null,
    options: { compiler: fakeCompiler() },
  });
  return { gateway, app };
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
