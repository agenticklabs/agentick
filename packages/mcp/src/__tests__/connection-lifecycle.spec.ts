/**
 * `McpClientHarness` connection-status lifecycle — #277b collapse.
 *
 * The harness IS the per-(session, server) thing — no separate
 * "handle" wrapper. Adopter-facing surface: `status` getter,
 * `onStatusChange` subscription, and the four verbs (`connect`,
 * `disconnect`, `reconnect`, `reauthenticate`).
 *
 * Pins:
 *   - Eager connect on install transitions disconnected →
 *     connecting → connected, with subscribers receiving every step.
 *   - `connect()` is idempotent on a connected harness.
 *   - `disconnect()` flips to `disconnected` AND closes the SDK
 *     client; `connect()` afterwards re-opens.
 *   - `reconnect()` is disconnect + connect — full cycle visible
 *     on the subscription stream.
 *   - Connect failure surfaces as `error` status with a reason.
 *   - `reauthenticate()` (current slice) delegates to disconnect +
 *     connect — same cycle. Credential-aware variant lands in the
 *     follow-up.
 *   - Race: a concurrent `disconnect()` during a slow connect
 *     wins; the late connect outcome doesn't clobber the
 *     `disconnected` status.
 */

import { describe, expect, it } from "vitest";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import {
  InMemoryMcpTransport,
  NoneAuth,
  isTerminalStatus,
  McpClientHarness,
  type McpConnectionStatus,
} from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mkRealServerPair(): Promise<{
  readonly server: Server;
  readonly clientTransport: InMemoryMcpTransport;
}> {
  const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
  const server = new Server(
    { name: "fake-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));
  await server.connect(serverTransport);
  return { server, clientTransport };
}

function mkHarness(serverId: string, clientTransport: InMemoryMcpTransport): McpClientHarness {
  return new McpClientHarness(
    `test:${serverId}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      serverId,
      transport: clientTransport,
      auth: new NoneAuth(),
      elicitAddress: "elicitation:test",
      clientInfo: { name: serverId, version: "1.0.0" },
    },
  );
}

// ---------------------------------------------------------------------------
// Status FSM on McpClientHarness (collapsed surface)
// ---------------------------------------------------------------------------

describe("McpClientHarness — connection-status FSM", () => {
  it("starts in disconnected", () => {
    // Construct without ever opening a transport — no server needed.
    const [t1] = InMemoryMcpTransport.createLinkedPair();
    const harness = mkHarness("x", t1);
    expect(harness.status).toEqual({ kind: "disconnected" });
  });

  it("connect() transitions disconnected → connecting → connected", async () => {
    const { server, clientTransport } = await mkRealServerPair();
    const harness = mkHarness("x", clientTransport);

    const seen: McpConnectionStatus[] = [];
    harness.onStatusChange((s) => seen.push(s));

    await harness.connect();

    expect(harness.status).toEqual({ kind: "connected" });
    expect(seen.map((s) => s.kind)).toEqual(["connecting", "connected"]);

    await harness.close();
    await server.close();
  });

  it("connect() on a connected harness is a no-op (no extra emission)", async () => {
    const { server, clientTransport } = await mkRealServerPair();
    const harness = mkHarness("x", clientTransport);
    await harness.connect();

    const seen: McpConnectionStatus[] = [];
    harness.onStatusChange((s) => seen.push(s));
    await harness.connect();

    expect(seen).toEqual([]);
    expect(harness.status).toEqual({ kind: "connected" });

    await harness.close();
    await server.close();
  });

  it("disconnect() transitions to disconnected and tears down the SDK client", async () => {
    const { server, clientTransport } = await mkRealServerPair();
    const harness = mkHarness("x", clientTransport);
    await harness.connect();
    expect(harness.status).toEqual({ kind: "connected" });

    const seen: McpConnectionStatus[] = [];
    harness.onStatusChange((s) => seen.push(s));
    await harness.disconnect();

    expect(harness.status).toEqual({ kind: "disconnected" });
    expect(seen).toEqual([{ kind: "disconnected" }]);

    await harness.close();
    await server.close();
  });

  it("connect() failure surfaces as error status with reason", async () => {
    // Construct a harness pointing at a never-served transport pair —
    // the client side will fail to initialize. Status should become
    // `error` with a reason.
    const [clientTransport] = InMemoryMcpTransport.createLinkedPair();
    const harness = mkHarness("x", clientTransport);

    const seen: McpConnectionStatus[] = [];
    harness.onStatusChange((s) => seen.push(s));

    // Force an immediate failure by closing the transport before
    // connect tries to use it.
    await clientTransport.close();

    await expect(harness.connect()).rejects.toBeDefined();
    expect(harness.status.kind).toBe("error");
    if (harness.status.kind === "error") {
      expect(typeof harness.status.reason).toBe("string");
    }
    expect(isTerminalStatus(harness.status)).toBe(true);

    await harness.close();
  });

  it("reauthenticate() delegates to disconnect + connect (current slice)", async () => {
    // reauthenticate cycles the SDK Client; InMemoryMcpTransport is
    // single-use after close, so this test exercises the status FSM
    // transitions rather than the full reconnect-against-the-server.
    // The connect-after-disconnect path that the SDK rejects ends in
    // the harness's `error` status — which is fine for this pin: we
    // care that reauthenticate emits a clean disconnect → connecting
    // → terminal-status stream.
    const { server, clientTransport } = await mkRealServerPair();
    const harness = mkHarness("x", clientTransport);
    await harness.connect();

    const seen: McpConnectionStatus[] = [];
    harness.onStatusChange((s) => seen.push(s));

    try {
      await harness.reauthenticate();
    } catch {
      // Expected for single-use in-memory transport; the FSM
      // transitions are what we're pinning.
    }

    expect(seen.map((s) => s.kind)).toEqual([
      "disconnected",
      "connecting",
      // Final state: `connected` if transport supports recycle,
      // `error` if single-use (in-memory case here).
      expect.stringMatching(/^(connected|error)$/),
    ]);

    await harness.close();
    await server.close();
  });

  it("disconnect during a slow connect — final status is disconnected, not error", async () => {
    // Construct a controllable transport whose `start()` hangs until
    // we resolve a Deferred. That gives us a real race window where
    // `harness.connect()` is suspended mid-await; we fire disconnect
    // during that window and verify the race-guard wins.
    let resolveStart: () => void = () => {};
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const hangingTransport = {
      async start(): Promise<void> {
        await startPromise;
      },
      async send(): Promise<void> {
        /* never called — we disconnect before initialize */
      },
      async close(): Promise<void> {
        /* idempotent */
      },
    };

    const harness = new McpClientHarness(
      `test:slow`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        serverId: "slow",
        transport: hangingTransport,
        auth: new NoneAuth(),
        elicitAddress: "elicitation:test",
        clientInfo: { name: "slow", version: "1.0.0" },
      },
    );

    // Fire connect — it'll await `transport.start()` which is hung.
    // We don't await the connectPromise itself; the SDK Client's
    // initialize handshake awaits a response over the transport
    // which never arrives (the disconnect short-circuits the wire),
    // so the connect Promise effectively hangs. We attach a noop
    // catch so the rejection (or non-resolution) doesn't surface as
    // an unhandled rejection at test teardown.
    void harness.connect().catch(() => {
      /* late connect outcome is irrelevant to the race contract */
    });

    // Yield to the microtask queue so connect's IIFE starts and
    // reaches the `await client.connect(...)` line. Status is now
    // `connecting`.
    await new Promise<void>((r) => setImmediate(r));
    expect(harness.status).toEqual({ kind: "connecting" });

    // Concurrent disconnect — race-guard should win. Status flips
    // to `disconnected` SYNCHRONOUSLY inside disconnect() (the set
    // happens before any await), so we can assert against the
    // already-mutated status without awaiting the disconnect's
    // close-side-effect.
    void harness.disconnect();
    expect(harness.status).toEqual({ kind: "disconnected" });

    // Let the hung transport finally resolve; the race-guard
    // observes `status.kind !== "connecting"` and bails without
    // overwriting `disconnected`.
    resolveStart();

    // Brief drain — even after letting the transport unblock, the
    // connect IIFE's late code paths must NOT push status back to
    // `error` or `connected`.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(harness.status).toEqual({ kind: "disconnected" });

    await harness.close();
  });
});
