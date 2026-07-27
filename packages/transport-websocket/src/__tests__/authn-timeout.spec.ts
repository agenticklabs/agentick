/**
 * The authn wall-clock ceiling at the WebSocket upgrade (ADR 61).
 *
 * A hung `AuthSource` is worse here than on HTTP: the upgrade never completes,
 * so the raw TCP socket is neither wired to a connection nor destroyed. It
 * leaks — one per probe, indefinitely. The ceiling lives at the shared ingress
 * seam (`@agentick/transport`); this pins that the upgrade path inherits it,
 * refuses with `401`, and releases the socket.
 *
 * A raw `ws` client (not the high-level client) so the test observes the
 * upgrade outcome itself, and every wait is raced against a test ceiling.
 */

import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket } from "ws";
import { createGateway } from "@agentick/gateway";
import type { AuthSource } from "@agentick/spec";
import { afterEach, describe, expect, it } from "vitest";

import { AGENTICK_SUBPROTOCOL } from "../shared/codec.js";
import { websocketServer } from "../server/index.js";

interface Started {
  readonly port: number;
  /** Sockets the Node server accepted, for the leak assertion. */
  readonly liveSockets: () => number;
  close(): Promise<void>;
}

const started: Started[] = [];

afterEach(async () => {
  while (started.length) await started.pop()!.close();
});

/** An `AuthSource` that accepts the credential and never answers. */
function hungAuthSource(): AuthSource {
  return { backend: "hung", authenticate: () => new Promise(() => {}) };
}

async function start(opts: {
  readonly authSource: AuthSource;
  readonly authnTimeoutMs?: number;
}): Promise<Started> {
  const gateway = await createGateway();
  const node = createServer();
  // Count raw sockets the server holds — an upgrade that never resolves leaves
  // its socket here, which is the leak the ceiling closes.
  const open = new Set<Socket>();
  node.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  const server = websocketServer({
    httpServer: node,
    gateway,
    authSource: opts.authSource,
    ...(opts.authnTimeoutMs !== undefined ? { authnTimeoutMs: opts.authnTimeoutMs } : {}),
  });
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", () => r()));
  const handle: Started = {
    port: (node.address() as AddressInfo).port,
    liveSockets: () => open.size,
    async close() {
      await server.close();
      await new Promise<void>((res, rej) => node.close((e) => (e ? rej(e) : res())));
      await gateway.close();
    },
  };
  started.push(handle);
  return handle;
}

type UpgradeOutcome = "open" | "refused" | "pending";

/** Attempt an upgrade, racing its outcome against a test ceiling. */
async function upgrade(port: number, testCeilingMs = 1_000): Promise<UpgradeOutcome> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, [AGENTICK_SUBPROTOCOL], {
    headers: { Authorization: "Bearer tok" },
  });
  const settled = new Promise<UpgradeOutcome>((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.once("unexpected-response", () => resolve("refused"));
    ws.once("close", () => resolve("refused"));
    ws.once("error", () => resolve("refused"));
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<UpgradeOutcome>([
      settled,
      new Promise<UpgradeOutcome>((resolve) => {
        timer = setTimeout(() => resolve("pending"), testCeilingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    ws.terminate();
  }
}

describe("WebSocket upgrade authn wall-clock ceiling", () => {
  it("a hung AuthSource REFUSES the upgrade instead of leaving it pending", async () => {
    const { port } = await start({ authSource: hungAuthSource(), authnTimeoutMs: 60 });
    expect(await upgrade(port)).toBe("refused");
  });

  it("the refused upgrade RELEASES its socket — no leak per probe", async () => {
    const s = await start({ authSource: hungAuthSource(), authnTimeoutMs: 60 });
    await upgrade(s.port);
    await upgrade(s.port);
    await upgrade(s.port);
    // Give the destroys a beat to land.
    await new Promise((r) => setTimeout(r, 100));
    expect(s.liveSockets()).toBe(0);
  });

  it("an AuthSource that answers inside the ceiling still upgrades", async () => {
    const slow: AuthSource = {
      backend: "slow",
      authenticate: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { principal: "alice" };
      },
    };
    const { port } = await start({ authSource: slow, authnTimeoutMs: 500 });
    expect(await upgrade(port)).toBe("open");
  });
});
