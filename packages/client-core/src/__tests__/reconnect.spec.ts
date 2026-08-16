/**
 * `client.reconnect()` — the user-initiated collapse of a backoff wait.
 *
 * Both recovery loops (the transport's dial loop, the client's handshake loop)
 * back off with full jitter up to 30s. That is right for an unattended client
 * and wrong for a person staring at a disconnected indicator: they know the VPN
 * came back, and before this verb there was no way for them to say so — the
 * click had nothing to call.
 *
 * Every case here pins "immediately" WITHOUT sleeping on a real backoff. The
 * retry curve is pinned to a floor far longer than the test's own lifetime, so
 * a second attempt inside the test can only have come from the manual kick.
 */

import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  isHandshakeFailed,
  type ClientState,
  type ClientTransport,
  type ExtensionsListResult,
  type InitializeResult,
  type ProgressStream,
  type SubscriptionStream,
  type TransportCapabilities,
  type WireMethod,
  type WireParams,
  type WireResult,
} from "@agentick/spec";

import { createClient } from "../client.js";

type Handler = <M extends WireMethod>(method: M, params: WireParams<M>) => Promise<WireResult<M>>;

interface FakeTransport extends ClientTransport {
  setState(s: ClientState): void;
  /** How many times `connect()` was called — the dial-now counter. */
  connects(): number;
  /** Refuse to come up, the way a dial against a dead peer does. */
  setReachable(reachable: boolean): void;
}

function fakeTransport(handler: Handler): FakeTransport {
  let state: ClientState = "idle";
  let connects = 0;
  let reachable = true;
  const listeners = new Set<(s: ClientState) => void>();
  const notify = (s: ClientState): void => {
    state = s;
    for (const l of listeners) l(s);
  };
  return {
    id: "fake",
    capabilities: {
      bidirectional: true,
      streamingRequest: true,
      reconnectable: true,
      binaryFrames: false,
      media: false,
    } satisfies TransportCapabilities,
    get state() {
      return state;
    },
    async connect() {
      connects++;
      if (!reachable) throw new Error("dial failed");
      notify("connecting");
      notify("open");
    },
    async close() {
      notify("closed");
    },
    request: handler as ClientTransport["request"],
    subscribe: (): SubscriptionStream => {
      throw new Error("subscribe not implemented in this fake");
    },
    progress: (): ProgressStream => {
      throw new Error("progress not implemented in this fake");
    },
    onStateChange(h) {
      listeners.add(h);
      return () => listeners.delete(h);
    },
    setState: notify,
    connects: () => connects,
    setReachable: (r) => {
      reachable = r;
    },
  };
}

function initResult(connectionId: string): InitializeResult {
  return {
    protocolVersion: "v1",
    capabilities: { cursorResume: true, subscriptions: true, progress: true, cancellation: true },
    serverInfo: { name: "@test/gateway", version: "1.0.0" },
    connectionId,
    clientId: "client-test",
  };
}

const EXTENSIONS: ExtensionsListResult = { extensions: [] };

/** A gateway whose `initialize` fails until the test says otherwise. */
function flakyGateway() {
  let answering = false;
  let attempts = 0;
  const transport = fakeTransport(async (method) => {
    if (method === "initialize") {
      attempts++;
      if (!answering) {
        throw { kind: "rpc", error: { code: ErrorCode.InternalError, message: "still booting" } };
      }
      return initResult(`conn-${attempts}`) as never;
    }
    if (method === "_extensions/list") return EXTENSIONS as never;
    throw new Error(`unexpected method: ${method}`);
  });
  return {
    transport,
    initCount: () => attempts,
    serveHandshake: () => {
      answering = true;
    },
  };
}

/**
 * A retry floor far beyond the test's lifetime. Any second attempt observed
 * below is therefore the manual kick, never the loop — which is the claim,
 * asserted by attempt count rather than by racing a timer.
 */
const NEVER_IN_TIME = { initialDelayMs: 10_000, maxDelayMs: 10_000 } as const;

describe("reconnect() collapses the handshake backoff", () => {
  it("re-arms a RETRYING handshake immediately", async () => {
    const { transport, initCount } = flakyGateway();
    const client = await createClient({ transport, handshakeRetry: NEVER_IN_TIME });
    await client.connect().catch(() => undefined);

    expect(initCount()).toBe(1);
    expect(isHandshakeFailed(client.readiness)).toBe(true);

    await client.reconnect();

    // The loop's next attempt was 10s away. This one was not.
    expect(initCount()).toBe(2);
    await client.close();
  });

  it("recovers a SPENT budget — the state nothing else recovers", async () => {
    const { transport, initCount, serveHandshake } = flakyGateway();
    const client = await createClient({
      transport,
      handshakeRetry: { ...NEVER_IN_TIME, maxAttempts: 1 },
    });
    await client.connect().catch(() => undefined);

    // Terminal: the client has stopped trying and says so.
    const stopped = client.readiness;
    expect(isHandshakeFailed(stopped) && stopped.retrying).toBe(false);
    expect(initCount()).toBe(1);

    serveHandshake();
    await client.reconnect();

    // A person asking is not the unattended budget — the manual attempt runs
    // on a fresh one, and the client comes all the way back.
    expect(client.readiness).toBe("ready");
    expect(initCount()).toBe(2);
    await client.close();
  });

  it("resolves on the SETTLE, not on success — a failed kick does not reject", async () => {
    const { transport, initCount } = flakyGateway();
    const client = await createClient({ transport, handshakeRetry: NEVER_IN_TIME });
    await client.connect().catch(() => undefined);

    // A click handler has nowhere to put a rejection; the failure is reported
    // on `readiness`, which is where the indicator already looks.
    await expect(client.reconnect()).resolves.toBeUndefined();
    expect(initCount()).toBe(2);
    expect(isHandshakeFailed(client.readiness)).toBe(true);
    await client.close();
  });
});

describe("reconnect() collapses the dial backoff", () => {
  it("dials NOW when the wire is down, then handshakes", async () => {
    const { transport, initCount, serveHandshake } = flakyGateway();
    serveHandshake();
    const client = await createClient({ transport, handshakeRetry: NEVER_IN_TIME });
    await client.connect();
    expect(client.readiness).toBe("ready");
    const dialsAfterConnect = transport.connects();

    // The wire drops and the transport's loop is mid-backoff.
    transport.setState("reconnecting");
    expect(client.state).toBe("reconnecting");

    await client.reconnect();

    expect(transport.connects()).toBe(dialsAfterConnect + 1);
    expect(client.state).toBe("open");
    expect(client.readiness).toBe("ready");
    expect(initCount()).toBeGreaterThan(1);
    await client.close();
  });

  it("a dial that fails is reported on state, not thrown at the caller", async () => {
    const { transport } = flakyGateway();
    const client = await createClient({ transport, handshakeRetry: NEVER_IN_TIME });
    transport.setState("reconnecting");
    transport.setReachable(false);

    await expect(client.reconnect()).resolves.toBeUndefined();
    // Still down, and no handshake was attempted against a dead wire.
    expect(client.state).toBe("reconnecting");
    await client.close();
  });
});

describe("reconnect() is idempotent, and closed is terminal", () => {
  it("no-ops on a ready client — clicking twice costs one handshake", async () => {
    const { transport, initCount, serveHandshake } = flakyGateway();
    serveHandshake();
    const client = await createClient({ transport, handshakeRetry: NEVER_IN_TIME });
    await client.connect();
    expect(initCount()).toBe(1);

    await client.reconnect();
    await client.reconnect();

    expect(initCount()).toBe(1);
    expect(transport.connects()).toBe(1);
    await client.close();
  });

  it("refuses to resurrect a CLOSED client", async () => {
    const { transport, serveHandshake } = flakyGateway();
    serveHandshake();
    const client = await createClient({ transport, handshakeRetry: NEVER_IN_TIME });
    await client.connect();
    await client.close();

    // `close()` is terminal; the way back is a fresh `connect()`, and saying so
    // beats half-reviving a client whose extensions have already torn down.
    await expect(client.reconnect()).rejects.toThrow(/closed/);
  });
});
