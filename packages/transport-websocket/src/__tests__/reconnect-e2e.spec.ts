/**
 * Reconnect e2e — the REAL websocket wire, a real `GatewayHarness`, and a
 * server that actually goes away.
 *
 * The sibling `reconnect.spec.ts` bounces the server and stands it back up
 * before the first backoff timer fires, so it only ever proves that ONE
 * redial into an already-listening server succeeds. These cases hold the
 * server DOWN across several backoff cycles, dial a port with nothing on it
 * at all, and drive a full request round-trip afterwards — the questions an
 * adopter actually asks of a reconnecting client.
 *
 * Covered:
 *   (a) request round-trips on a fresh connection
 *   (b) server dies abruptly (socket terminate, no close frame → 1006)
 *   (c) server restarts on the same port after a real outage
 *   (d) client re-handshakes and a NEW request round-trips
 *   (e) INITIAL connect against a down server that comes up moments later
 *   (f) server-initiated GRACEFUL close (1000/1001) vs abrupt death
 *   + deliberate `client.close()` must never reconnect
 *   + in-flight requests reject with a typed, reason-carrying error
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway } from "@agentick/gateway";
import { createClient } from "@agentick/client-core";
import { isTransportError, type ClientState } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { websocket } from "../client/index.js";
import { websocketServer } from "../server/index.js";
import { AGENTICK_SUBPROTOCOL } from "../shared/codec.js";

/** Reservoir of teardown thunks, drained LIFO in `afterEach`. */
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      /* teardown is best-effort */
    }
  }
});

/** Grab an ephemeral port by listening on :0 and immediately releasing it. */
async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface Standing {
  readonly port: number;
  stop(): Promise<void>;
}

/** Stand a real gateway-backed WS server on `port` (0 = ephemeral). */
async function standServer(port = 0): Promise<Standing> {
  const gateway = await createGateway();
  const httpServer: HttpServer = createServer();
  const server = websocketServer({ httpServer, gateway });
  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", () => resolve()));
  const bound = (httpServer.address() as AddressInfo).port;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await server.close();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await gateway.close();
  };
  cleanups.push(stop);
  return { port: bound, stop };
}

function label(s: ClientState): string {
  return typeof s === "string" ? s : `failed:${s.kind}`;
}

describe("WebSocket reconnect e2e — real wire, server actually goes away", () => {
  it("(a–d) reconnects after a REAL outage and round-trips a new request", async () => {
    const first = await standServer();
    const { port } = first;

    const states: string[] = [];
    const client = await createClient({
      transport: websocket({
        url: `ws://127.0.0.1:${port}`,
        reconnect: { initialDelayMs: 20, maxDelayMs: 60 },
      }),
      onStateChange: (s) => states.push(label(s)),
    });
    cleanups.push(() => client.close());

    await client.connect();
    expect(await client.request("ping", {})).toEqual({});

    // Kill it and KEEP it dead across several backoff cycles.
    await first.stop();
    await waitFor(() => states.includes("reconnecting"), {
      description: "transport entered reconnecting",
    });
    await new Promise((r) => setTimeout(r, 300));

    // Nothing terminal while the server is down: the loop must still be live.
    expect(states).not.toContain("closed");
    expect(states.some((s) => s.startsWith("failed:"))).toBe(false);

    // Same port, brand-new server.
    await standServer(port);

    await waitFor(() => client.state === "open", {
      timeoutMs: 5_000,
      description: "client re-opened after outage",
    });
    await client.whenReady();

    // The handshake must have re-run against whoever we came back to.
    expect(client.serverInfo).toBeDefined();
    expect(await client.request("ping", {})).toEqual({});
  });

  it("(e) initial connect against a DOWN server that comes up moments later", async () => {
    const port = await reservePort();

    const states: string[] = [];
    const client = await createClient({
      transport: websocket({
        url: `ws://127.0.0.1:${port}`,
        reconnect: { initialDelayMs: 20, maxDelayMs: 60 },
      }),
      onStateChange: (s) => states.push(label(s)),
    });
    cleanups.push(() => client.close());

    // Nothing is listening. THE VERDICT (documented on `ReconnectPolicy`):
    // `connect()` rejects on its own failed dial rather than blocking on a
    // loop whose default `maxAttempts` is Infinity — but rejecting is not
    // giving up, and the error has to say so or adopters read it as terminal.
    const outcome = await client.connect().then(
      () => "resolved" as const,
      (e: unknown) => e,
    );
    expect(outcome).not.toBe("resolved");
    expect(isTransportError(outcome)).toBe(true);
    expect((outcome as { kind: string }).kind).toBe("connection");
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/reconnect is armed/);

    // Server arrives 100ms late — several backoff cycles in.
    await new Promise((r) => setTimeout(r, 100));
    await standServer(port);

    // The policy covers the FIRST dial, so the client comes up on its own.
    await waitFor(() => client.state === "open", {
      timeoutMs: 3_000,
      description: "client reached open after a late server",
    });
    expect(states.filter((s) => s === "reconnecting").length).toBeGreaterThan(1);

    // And it is genuinely usable: the handshake ran on the recovered wire.
    await client.whenReady();
    expect(client.serverInfo).toBeDefined();
    expect(await client.request("ping", {})).toEqual({});
  });

  it("(f) server-initiated GRACEFUL close (1001) is retried like an abrupt drop", async () => {
    const port = await reservePort();
    // A bare `ws` server that accepts the subprotocol and immediately says
    // "going away" — the graceful-shutdown path a rolling deploy produces.
    const wss = new WebSocketServer({
      port,
      host: "127.0.0.1",
      handleProtocols: (protocols) =>
        protocols.has(AGENTICK_SUBPROTOCOL) ? AGENTICK_SUBPROTOCOL : false,
    });
    let accepted = 0;
    wss.on("connection", (ws) => {
      accepted++;
      ws.close(1001, "going away");
    });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));

    const states: string[] = [];
    const transport = websocket({
      url: `ws://127.0.0.1:${port}`,
      reconnect: { initialDelayMs: 20, maxDelayMs: 40 },
    });
    cleanups.push(() => transport.close());
    transport.onStateChange((s) => states.push(label(s)));

    await transport.connect().catch(() => {});

    // A graceful 1001 must re-arm the loop, not latch closed.
    await waitFor(() => accepted >= 3, {
      timeoutMs: 3_000,
      description: "client redialed after graceful 1001 closes",
    });
    expect(states).toContain("reconnecting");
    expect(states).not.toContain("closed");
  });

  it("deliberate client.close() never reconnects, even mid-backoff", async () => {
    const first = await standServer();
    const states: string[] = [];
    const client = await createClient({
      transport: websocket({
        url: `ws://127.0.0.1:${first.port}`,
        reconnect: { initialDelayMs: 30, maxDelayMs: 60 },
      }),
      onStateChange: (s) => states.push(label(s)),
    });
    await client.connect();

    // Drop the wire, let the loop arm, THEN close deliberately.
    await first.stop();
    await waitFor(() => states.includes("reconnecting"), {
      description: "loop armed before deliberate close",
    });
    await client.close();

    const seen = states.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(states[states.length - 1]).toBe("closed");
    expect(states.length).toBe(seen);
  });

  it("in-flight requests reject with a typed, reason-carrying error on drop", async () => {
    const first = await standServer();
    const client = await createClient({
      transport: websocket({ url: `ws://127.0.0.1:${first.port}`, reconnect: { enabled: false } }),
    });
    cleanups.push(() => client.close());
    await client.connect();

    // An RPC against a session that does not exist: whatever the gateway would
    // have answered, the wire dies under it first.
    const inflight = client.request("session/model_info", { sessionId: "no-such-session" }).then(
      () => "resolved" as const,
      (e: unknown) => e,
    );
    await first.stop();
    const err = await inflight;

    expect(err).not.toBe("resolved");
    expect(isTransportError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe("closed");
    expect(err).toBeInstanceOf(Error);
  });
});

/**
 * Half-open death — the failure mode a `close` event never reports.
 *
 * A WS drop the client can SEE (FIN, RST, close frame) is the easy case, and
 * the suite above shows it recovers. The case that produces "the client
 * doesn't reconnect" in the field is the one where the path dies SILENTLY:
 * laptop sleep, NAT/conntrack eviction, cellular handoff, a load balancer
 * that stops forwarding without resetting. No frame ever arrives, so the
 * socket sits in `readyState === OPEN` and the client's only reconnect
 * trigger — the `close` listener — never fires.
 *
 * Simulated with a TCP forwarder that stops forwarding both directions and
 * holds both sockets open, which is exactly what the network does.
 */
describe("WebSocket reconnect e2e — silent half-open death", () => {
  interface Blackhole {
    readonly port: number;
    /** Stop forwarding both directions, holding both sockets open (no FIN/RST). */
    blackhole(): void;
  }

  /** TCP forwarder: client → proxy → `targetPort`, with a blackhole switch. */
  async function standProxy(targetPort: number): Promise<Blackhole> {
    const { createConnection, createServer: createTcpServer } = await import("node:net");
    let dropping = false;
    const sockets: Array<{ destroy(): void }> = [];
    const proxy = createTcpServer((down) => {
      const up = createConnection({ port: targetPort, host: "127.0.0.1" });
      sockets.push(down, up);
      down.on("data", (c) => {
        if (!dropping) up.write(c);
      });
      up.on("data", (c) => {
        if (!dropping) down.write(c);
      });
      // Swallow: a blackholed pair is torn down only at teardown.
      down.on("error", () => {});
      up.on("error", () => {});
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const { port } = proxy.address() as AddressInfo;
    cleanups.push(async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });
    return {
      port,
      blackhole: () => {
        dropping = true;
      },
    };
  }

  it("detects a silently dead wire and reconnects", async () => {
    const origin = await standServer();
    const proxy = await standProxy(origin.port);

    const states: string[] = [];
    const client = await createClient({
      transport: websocket({
        url: `ws://127.0.0.1:${proxy.port}`,
        reconnect: { initialDelayMs: 20, maxDelayMs: 60 },
        // Aggressive so the test is fast; the DEFAULT (30s/10s) must stay finite.
        keepalive: { intervalMs: 60, timeoutMs: 120 },
      }),
      onStateChange: (s) => states.push(label(s)),
    });
    cleanups.push(() => client.close());

    await client.connect();
    expect(await client.request("ping", {})).toEqual({});

    // The path dies without telling anyone.
    proxy.blackhole();

    // The client must NOTICE — nothing else will tell it.
    await waitFor(() => states.includes("reconnecting"), {
      timeoutMs: 4_000,
      description: "client detected the silently dead wire",
    });
  });

  it("a request on a silently dead wire fails instead of hanging forever", async () => {
    const origin = await standServer();
    const proxy = await standProxy(origin.port);

    const client = await createClient({
      transport: websocket({
        url: `ws://127.0.0.1:${proxy.port}`,
        reconnect: { initialDelayMs: 20, maxDelayMs: 60 },
        keepalive: { intervalMs: 60, timeoutMs: 120 },
      }),
    });
    cleanups.push(() => client.close());
    await client.connect();

    proxy.blackhole();

    const settled = await Promise.race([
      client.request("ping", {}).then(
        () => "resolved" as const,
        (e: unknown) => e,
      ),
      new Promise((r) => setTimeout(() => r("HUNG"), 3_000)),
    ]);
    expect(settled).not.toBe("HUNG");
  });
});
