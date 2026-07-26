/**
 * `sub/subscribe` opens a session-channel subscription WITH a snapshot
 * (slice 2). When the query targets exactly one `session:channel:<name>`,
 * the handler resolves the owning session, reads its `channelSnapshot`, and
 * prepends that envelope so the FIRST frame the subscriber receives is the
 * current state — live deltas then follow on the same stream (K8s
 * `sendInitialEvents` / watch-list model).
 *
 * Proven at the gateway seam with stub gateway/app/session (the session's
 * real snapshot behavior is proven in `@agentick/session`): the handler's
 * channel-detection + prepend ordering are what slice 2 adds here. A
 * non-channel subscription must be behavior-preserving (no snapshot frame).
 */

import { describe, expect, it } from "vitest";
import { waitFor } from "@agentick/utils/testing";
import type {
  AppHarnessProtocol,
  EventEnvelope,
  GatewayHarnessProtocol,
  SessionHarnessProtocol,
  SubscribeParams,
  SubscriptionHandle,
  WireExtensionContext,
} from "@agentick/spec";

import { subscriptionsWireExtension } from "../subscriptions-extension.js";

const SESSION_ID = "sess-1";

/** Empty live stream — the drain publishes the prepended snapshot, then ends. */
async function* emptyLive(): AsyncGenerator<EventEnvelope> {
  // no live events
}

/** Snapshot envelope the stub session hands back for `knobs-state`. */
const KNOBS_SNAPSHOT: EventEnvelope = {
  id: "snap-1",
  surface: "session",
  name: "session:channel:knobs-state",
  phase: "delta",
  timestamp: 0,
  scope: { sessionId: SESSION_ID },
  payload: { kind: "snapshot", version: 3, values: { temperature: 0.7 } },
};

function stubSession(): SessionHarnessProtocol {
  return {
    id: SESSION_ID,
    channelSnapshot: async (channel: string) =>
      channel === "knobs-state" ? KNOBS_SNAPSHOT : undefined,
  } as unknown as SessionHarnessProtocol;
}

function stubGateway(session: SessionHarnessProtocol): GatewayHarnessProtocol {
  const app = {
    getSession: (id: string) => (id === SESSION_ID ? session : undefined),
    events: () => emptyLive(),
  } as unknown as AppHarnessProtocol;
  return {
    apps: () => [app],
    app: () => app,
    events: () => emptyLive(),
  } as unknown as GatewayHarnessProtocol;
}

/** Wire ctx with a transport that records every published envelope. */
function stubCtx(gateway: GatewayHarnessProtocol) {
  const published: EventEnvelope[] = [];
  const handle: SubscriptionHandle = {
    id: "wire-sub-1",
    publish: (env) => {
      published.push(env as EventEnvelope);
    },
    close: () => {},
  };
  const ctx = {
    gateway,
    wire: {
      registerSubscription: () => handle,
      closeSubscription: () => {},
    },
  } as unknown as WireExtensionContext;
  return { ctx, published };
}

const subscribe = subscriptionsWireExtension.methods["sub/subscribe"]!;

describe("sub/subscribe — channel opens with a snapshot (slice 2)", () => {
  it("prepends the channel snapshot as the FIRST delivered frame", async () => {
    const { ctx, published } = stubCtx(stubGateway(stubSession()));
    const params: SubscribeParams = {
      scope: { kind: "session", id: SESSION_ID },
      query: { surface: "session", name: { exact: "session:channel:knobs-state" } },
    };

    const res = await subscribe(params, ctx);
    expect(res.subscriptionId).toBe("wire-sub-1");

    await waitFor(() => published.length >= 1);
    expect(published[0]).toBe(KNOBS_SNAPSHOT);
    expect(published[0]!.name).toBe("session:channel:knobs-state");
  });

  it("does NOT prepend a snapshot for a non-channel subscription (behavior-preserving)", async () => {
    const { ctx, published } = stubCtx(stubGateway(stubSession()));
    const params: SubscribeParams = {
      scope: { kind: "session", id: SESSION_ID },
      // A non-channel query — must not trigger a snapshot prepend.
      query: { surface: "session", name: { prefix: "session:tick" } },
    };

    await subscribe(params, ctx);
    // Give the background drain a tick to run; the empty live stream ends
    // with nothing published.
    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(0);
  });

  it("does NOT prepend for an exact channel the session does not own", async () => {
    const { ctx, published } = stubCtx(stubGateway(stubSession()));
    const params: SubscribeParams = {
      scope: { kind: "session", id: SESSION_ID },
      query: { surface: "session", name: { exact: "session:channel:no-such" } },
    };

    await subscribe(params, ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(0);
  });
});
