/**
 * Phase 4e verification — pin the WebSocket-specific claims that
 * conformance alone doesn't exercise:
 *
 *   - Subprotocol negotiation rejects mismatched clients
 *   - Mount-on-httpServer mode coexists with other handlers
 *   - allowedOrigins rejects unauthorized origins
 *   - path option scopes upgrade routing
 *   - createWsConnector connect-timeout fires on unreachable URLs
 */

import { describe, expect, it } from "vitest";

import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";

import { WebSocket as WSConnection } from "ws";

import { type ClusterCodec } from "@agentick/cluster-broker-next";

import { createWsConnector } from "../ws-connector.js";
import { wsBroker } from "../ws-cluster.js";
import { AGENTICK_CLUSTER_SUBPROTOCOL } from "../ws-shared.js";

function jsonCodec(): ClusterCodec {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    encode: (v) => enc.encode(JSON.stringify(v)),
    decode: (raw) => JSON.parse(dec.decode(raw)),
  };
}

async function allocatePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        probe.close(() => resolve(port));
      } else {
        probe.close(() => reject(new Error("port alloc failed")));
      }
    });
  });
}

describe("WebSocket — subprotocol negotiation", () => {
  it("rejects clients that don't request the agentick-cluster-v1 subprotocol", async () => {
    const port = await allocatePort();
    const running = await wsBroker({ host: "127.0.0.1", port, codec: jsonCodec() });
    try {
      // Connect with a different subprotocol → broker's
      // handleProtocols returns false → upgrade fails.
      await new Promise<void>((resolve, reject) => {
        const ws = new WSConnection(`ws://127.0.0.1:${port}/cluster`, ["some-other-protocol"]);
        ws.once("open", () => {
          ws.close();
          reject(new Error("expected upgrade rejection"));
        });
        ws.once("error", () => resolve());
        // Fallback timeout — some ws versions emit unexpected-response
        // instead of error for this case.
        ws.once("unexpected-response", () => {
          ws.terminate();
          resolve();
        });
      });
    } finally {
      await running.close();
    }
  });

  it("accepts the canonical subprotocol", async () => {
    const port = await allocatePort();
    const running = await wsBroker({ host: "127.0.0.1", port, codec: jsonCodec() });
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WSConnection(`ws://127.0.0.1:${port}/cluster`, [
          AGENTICK_CLUSTER_SUBPROTOCOL,
        ]);
        ws.once("open", () => {
          expect(ws.protocol).toBe(AGENTICK_CLUSTER_SUBPROTOCOL);
          ws.close();
          resolve();
        });
        ws.once("error", reject);
      });
    } finally {
      await running.close();
    }
  });
});

describe("WebSocket — mount on adopter's http.Server", () => {
  it("coexists with another route handler on the same server", async () => {
    const port = await allocatePort();
    const httpServer = createHttpServer((req, res) => {
      // The adopter's normal HTTP handler — independent of our
      // upgrade handler.
      if (req.url === "/api/ping") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("pong");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
    try {
      const running = await wsBroker({ httpServer, path: "/cluster", codec: jsonCodec() });
      try {
        // The HTTP route still works.
        const response = await fetch(`http://127.0.0.1:${port}/api/ping`);
        const body = await response.text();
        expect(body).toBe("pong");

        // The cluster upgrade also works.
        await new Promise<void>((resolve, reject) => {
          const ws = new WSConnection(`ws://127.0.0.1:${port}/cluster`, [
            AGENTICK_CLUSTER_SUBPROTOCOL,
          ]);
          ws.once("open", () => {
            ws.close();
            resolve();
          });
          ws.once("error", reject);
        });
      } finally {
        await running.close();
      }
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("upgrade requests to a different path are NOT claimed (passed through)", async () => {
    const port = await allocatePort();
    const httpServer = createHttpServer();
    // Another upgrade handler the adopter registered. To make the
    // test deterministic, this handler closes the socket on its
    // own path — proves we (cluster-ws) didn't claim it.
    let otherHandlerSawUpgrade = false;
    httpServer.on("upgrade", (req, socket) => {
      if (req.url === "/other-ws") {
        otherHandlerSawUpgrade = true;
        socket.write("HTTP/1.1 501 Not Implemented\r\n\r\n");
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
    try {
      const running = await wsBroker({ httpServer, path: "/cluster", codec: jsonCodec() });
      try {
        const ws = new WSConnection(`ws://127.0.0.1:${port}/other-ws`);
        // We expect a quick error (501 sent by the adopter handler).
        await new Promise<void>((resolve) => {
          ws.once("error", () => resolve());
          ws.once("close", () => resolve());
          ws.once("unexpected-response", () => {
            ws.terminate();
            resolve();
          });
          setTimeout(() => resolve(), 500);
        });
        ws.terminate();
        expect(otherHandlerSawUpgrade).toBe(true);
      } finally {
        await running.close();
      }
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});

describe("WebSocket — origin policy", () => {
  it("allowedOrigins rejects upgrade requests with disallowed Origin header", async () => {
    const port = await allocatePort();
    const running = await wsBroker({
      host: "127.0.0.1",
      port,
      codec: jsonCodec(),
      allowedOrigins: ["https://allowed.example"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WSConnection(
          `ws://127.0.0.1:${port}/cluster`,
          [AGENTICK_CLUSTER_SUBPROTOCOL],
          {
            origin: "https://evil.example",
          },
        );
        ws.once("open", () => {
          ws.close();
          reject(new Error("expected origin rejection"));
        });
        ws.once("error", () => resolve());
        ws.once("unexpected-response", () => {
          ws.terminate();
          resolve();
        });
      });
    } finally {
      await running.close();
    }
  });
});

describe("createWsConnector — connectTimeoutMs", () => {
  it("rejects with timeout error when broker doesn't accept within timeoutMs", async () => {
    // 192.0.2.x is RFC 5737 TEST-NET-1 — guaranteed unreachable.
    const connector = createWsConnector({
      url: "ws://192.0.2.1:9999/cluster",
      connectTimeoutMs: 100,
    });
    const start = Date.now();
    await expect(connector.connect()).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1_000);
  });
});
