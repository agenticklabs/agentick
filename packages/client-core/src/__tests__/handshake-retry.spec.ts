/**
 * Handshake retry + `whenReady()` honesty (#263).
 *
 * The failure this suite exists for: a handshake that fails while the WIRE
 * STAYS UP. The wire-failure case always self-healed — the transport drops,
 * redials, and the `open` transition re-arms the handshake — so the mode that
 * reached users was the other one. A gateway that accepts a socket before it
 * can serve `initialize` left the client `open`, with empty capabilities, no
 * stated reason, every namespaced call failing as "capability missing", and
 * `whenReady()` resolving anyway. Nothing retried.
 *
 * What is pinned here:
 *   - a failed handshake retries under backoff for as long as the wire is up
 *   - `whenReady()` resolves ONLY on a success, and rejects only when nothing
 *     further can resolve it
 *   - `readiness` reports the dimension `state` cannot: wire up + handshake
 *     pending / failed / retrying
 *   - a wire drop mid-retry hands recovery to the transport (one loop, no
 *     orphan timer), and the drop path re-handshakes
 *   - a deliberate `close()` stops the loop
 */

import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  isHandshakeFailed,
  type ClientReadiness,
  type ClientState,
  type ClientTransport,
  type InitializeResult,
  type ExtensionsListResult,
  type ProgressStream,
  type SubscriptionStream,
  type TransportCapabilities,
  type WireMethod,
  type WireParams,
  type WireResult,
} from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { createClient } from "../client.js";

type Handler = <M extends WireMethod>(method: M, params: WireParams<M>) => Promise<WireResult<M>>;

/** Fake transport whose state is driven by the test, not by a wire. */
function fakeTransport(handler: Handler): ClientTransport & { setState(s: ClientState): void } {
  let state: ClientState = "idle";
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

const EXTENSIONS: ExtensionsListResult = {
  extensions: [
    {
      name: "@agentick/gateway#session",
      namespace: "session",
      version: "1.0.0",
      methods: ["session/send"],
      notifications: [],
    },
  ],
};

/**
 * A gateway that refuses `initialize` for its first `failures` attempts and
 * serves it thereafter — the "accepted the socket before it could serve the
 * handshake" server, reduced to its essentials.
 */
function bootingGateway(failures: number): {
  transport: ReturnType<typeof fakeTransport>;
  initCount: () => number;
} {
  let attempts = 0;
  const transport = fakeTransport(async (method) => {
    if (method === "initialize") {
      attempts++;
      if (attempts <= failures) {
        throw { kind: "rpc", error: { code: ErrorCode.InternalError, message: "still booting" } };
      }
      return initResult(`conn-${attempts}`) as never;
    }
    if (method === "_extensions/list") return EXTENSIONS as never;
    throw new Error(`unexpected method: ${method}`);
  });
  return { transport, initCount: () => attempts };
}

const FAST = { initialDelayMs: 1, maxDelayMs: 2 } as const;

describe("handshake retry on a live wire (#263)", () => {
  it("retries until the gateway can answer, then reports ready", async () => {
    const { transport, initCount } = bootingGateway(3);
    const seen: ClientReadiness[] = [];
    const client = await createClient({
      transport,
      handshakeRetry: FAST,
      onReadinessChange: (r) => seen.push(r),
    });

    // `connect()` still hands its caller the first failure — an answer, not a
    // verdict. The loop is already running underneath.
    await expect(client.connect()).rejects.toMatchObject({
      error: { code: ErrorCode.InternalError },
    });

    await client.whenReady();
    expect(client.readiness).toBe("ready");
    expect(initCount()).toBe(4);
    expect(client.capabilities.hasMethod("session/send")).toBe(true);

    // Every failure was reported, with a rising attempt count and `retrying`
    // set — "the client has stopped" is never something to infer from silence.
    const failures = seen.filter(isHandshakeFailed);
    expect(failures.map((f) => f.attempts)).toEqual([1, 2, 3]);
    expect(failures.every((f) => f.retrying)).toBe(true);

    await client.close();
  });

  it("reports wire-up-but-not-usable, which `state` alone cannot express", async () => {
    const { transport } = bootingGateway(Infinity);
    const client = await createClient({ transport, handshakeRetry: FAST });
    await client.connect().catch(() => {});

    // The whole of the reported bug: the wire says everything is fine.
    expect(client.state).toBe("open");
    // And the client says otherwise.
    expect(isHandshakeFailed(client.readiness)).toBe(true);
    expect(client.capabilities.hasMethod("session/send")).toBe(false);

    await client.close();
  });

  it("whenReady() does NOT resolve while the handshake keeps failing", async () => {
    const { transport } = bootingGateway(Infinity);
    const client = await createClient({ transport, handshakeRetry: FAST });
    await client.connect().catch(() => {});

    const settled = await Promise.race([
      client.whenReady().then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 120)),
    ]);
    expect(settled).toBe("pending");

    await client.close();
  });

  it("a deliberate close() cancels the retry loop and settles the waiters", async () => {
    const { transport, initCount } = bootingGateway(Infinity);
    const client = await createClient({ transport, handshakeRetry: FAST });
    await client.connect().catch(() => {});

    const waiter = client.whenReady().then(
      () => "resolved" as const,
      (e: unknown) => e,
    );
    await waitFor(() => initCount() >= 2, { description: "retry loop is running" });
    await client.close();

    // Parked callers are told, not left hanging forever.
    const outcome = await waiter;
    expect(outcome).not.toBe("resolved");
    expect((outcome as Error).message).toMatch(/closed/);

    // And nothing dials after the close.
    const after = initCount();
    await new Promise((r) => setTimeout(r, 60));
    expect(initCount()).toBe(after);
  });

  it("a wire drop mid-retry hands recovery to the transport — one loop, no orphan", async () => {
    let attempts = 0;
    let refuse = true;
    const transport = fakeTransport(async (method) => {
      if (method === "initialize") {
        attempts++;
        if (refuse) {
          throw { kind: "rpc", error: { code: ErrorCode.InternalError, message: "still booting" } };
        }
        return initResult(`conn-${attempts}`) as never;
      }
      if (method === "_extensions/list") return EXTENSIONS as never;
      throw new Error(`unexpected method: ${method}`);
    });

    const client = await createClient({
      transport,
      handshakeRetry: { initialDelayMs: 30, maxDelayMs: 30 },
    });
    await client.connect().catch(() => {});
    expect(isHandshakeFailed(client.readiness)).toBe(true);

    // The wire goes while a retry is pending. The transport owns recovery now.
    transport.setState("reconnecting");
    expect(client.readiness).toBe("idle");
    const atDrop = attempts;

    // Nothing may dial the handshake while the wire is down — a stale timer
    // firing here is the orphan this asserts against.
    await new Promise((r) => setTimeout(r, 80));
    expect(attempts).toBe(atDrop);

    // Back up, and healthy this time: the drop path re-handshakes on its own.
    refuse = false;
    transport.setState("open");
    await client.whenReady();
    expect(client.readiness).toBe("ready");
    expect(attempts).toBe(atDrop + 1);

    await client.close();
  });

  it("a spent retry budget is reported, not silent", async () => {
    // The default budget is Infinity. A finite one is an adopter asking for a
    // hard stop — which has to be visible, or it is indistinguishable from a
    // client still trying.
    const { transport, initCount } = bootingGateway(Infinity);
    const client = await createClient({
      transport,
      handshakeRetry: { ...FAST, maxAttempts: 2 },
    });
    await client.connect().catch(() => {});

    await waitFor(() => isHandshakeFailed(client.readiness) && !client.readiness.retrying, {
      description: "budget reported as spent",
    });
    const readiness = client.readiness;
    if (!isHandshakeFailed(readiness)) throw new Error("expected handshake-failed");
    expect(readiness.attempts).toBe(2);
    expect(readiness.retrying).toBe(false);

    const after = initCount();
    await new Promise((r) => setTimeout(r, 40));
    expect(initCount()).toBe(after);

    await client.close();
  });

  it("whenReady() rejects when the transport goes terminal — nothing else will settle it", async () => {
    const { transport } = bootingGateway(Infinity);
    const client = await createClient({ transport, handshakeRetry: FAST });
    await client.connect().catch(() => {});

    const waiter = client.whenReady().then(
      () => "resolved" as const,
      (e: unknown) => e,
    );
    // The transport spent its own reconnect budget.
    transport.setState({
      kind: "failed",
      error: { kind: "connection", message: "reconnect attempts exhausted" },
    });

    const outcome = await waiter;
    expect(outcome).not.toBe("resolved");
    expect((outcome as Error).message).toMatch(/terminal state/);

    // A later call says the same thing rather than parking forever.
    await expect(client.whenReady()).rejects.toThrow(/terminal state/);
  });

  it("does not commit capabilities from a handshake the wire outlived", async () => {
    // The stale-commit race: an `initialize` still in flight when the wire
    // drops must not publish `serverInfo` / capabilities describing a peer we
    // are no longer talking to.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const transport = fakeTransport(async (method) => {
      if (method === "initialize") {
        await gate;
        return initResult("conn-stale") as never;
      }
      if (method === "_extensions/list") return EXTENSIONS as never;
      throw new Error(`unexpected method: ${method}`);
    });

    const client = await createClient({ transport, handshakeRetry: FAST });
    const connecting = client.connect().catch(() => {});
    // The drop has to land while `initialize` is genuinely in flight.
    await waitFor(() => client.readiness === "handshaking", {
      description: "handshake in flight",
    });

    transport.setState("reconnecting");
    release?.();
    await connecting;

    expect(client.readiness).toBe("idle");
    expect(client.serverInfo).toBeUndefined();
    expect(client.capabilities.extensions).toEqual([]);
  });
});

describe("identity across a reconnect", () => {
  /**
   * A gateway that echoes back the claimed clientId — what a real one does when
   * it binds the claim — and mints a fresh connectionId per handshake.
   */
  function identityGateway() {
    const claims: (string | undefined)[] = [];
    let connections = 0;
    const handler = async (method: string, params: unknown): Promise<unknown> => {
      if (method === "initialize") {
        const claimed = (params as { clientId?: string }).clientId;
        claims.push(claimed);
        return {
          ...initResult(`conn-${++connections}`),
          clientId: claimed ?? "server-assigned",
        };
      }
      if (method === "_extensions/list") return EXTENSIONS;
      throw new Error(`unexpected ${method}`);
    };
    return { claims, handler };
  }

  it("re-claims the SAME clientId and is given a NEW connectionId", async () => {
    // The whole reason a tool call outstanding across a dropped socket is still
    // addressed to the tab that asked for it.
    const { claims, handler } = identityGateway();
    const transport = fakeTransport(handler as never);
    const client = await createClient({ transport });
    await client.connect();
    await waitFor(() => client.readiness === "ready");

    const firstClient = client.runtime.clientId;
    const firstConnection = client.runtime.connectionId;

    // The reconnect path — `closed` is terminal and owes no fresh handshake.
    transport.setState("reconnecting");
    transport.setState("open");
    await waitFor(() => claims.length === 2);
    await waitFor(() => client.readiness === "ready");

    expect(claims[0]).toBe(claims[1]); // the SAME claim, re-presented
    expect(client.runtime.clientId).toBe(firstClient);
    expect(client.runtime.connectionId).not.toBe(firstConnection);
    await client.close();
  });

  it("reports the id the server BOUND, not the one it claimed", async () => {
    // A server may refuse or replace a claim. A client still comparing against
    // its own would measure against a value nobody addresses it by.
    const handler = async (method: string): Promise<unknown> => {
      if (method === "initialize") {
        return { ...initResult("conn-1"), clientId: "client-ASSIGNED-BY-SERVER" };
      }
      if (method === "_extensions/list") return EXTENSIONS;
      throw new Error(`unexpected ${method}`);
    };
    const client = await createClient({ transport: fakeTransport(handler as never) });
    await client.connect();
    await waitFor(() => client.readiness === "ready");

    expect(client.runtime.clientId).toBe("client-ASSIGNED-BY-SERVER");
    await client.close();
  });
});
