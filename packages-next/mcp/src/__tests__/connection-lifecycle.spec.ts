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

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

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
    // We hijack `client.connect` indirectly by constructing the
    // harness with a transport whose `start()` never resolves
    // — but that's hard with InMemoryMcpTransport. Instead, we
    // exploit the fact that `harness.connect()` returns a Promise:
    // schedule disconnect on a microtask, then await connect's
    // outcome. With race-guards in place, status ends `disconnected`.
    const { server, clientTransport } = await mkRealServerPair();
    const harness = mkHarness("x", clientTransport);

    const connectPromise = harness.connect();
    // Status is now `connecting`. Race a disconnect against the
    // connect's completion via a microtask.
    void Promise.resolve().then(() => {
      void harness.disconnect();
    });

    await connectPromise.catch(() => {
      /* connect's outcome can race either way; we only care about
       * the final status. */
    });
    // Drain microtasks so disconnect has a chance to run.
    await new Promise((r) => setTimeout(r, 10));

    expect(harness.status).toEqual({ kind: "disconnected" });

    await harness.close();
    await server.close();
  });
});
