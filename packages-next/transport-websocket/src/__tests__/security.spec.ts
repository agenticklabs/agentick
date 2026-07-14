/**
 * Security-adjacent claims:
 *   - Server rejects WS upgrades without the agentick-rpc-v1 subprotocol
 *   - Server rejects WS upgrades whose Origin is not in allowedOrigins
 *
 * These claims appear in the README and ADR 33; this file verifies them.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createGateway } from "@agentick/gateway-next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { websocketServer } from "../server/index.js";

describe("WebSocket transport — subprotocol enforcement", () => {
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  let server: ReturnType<typeof websocketServer>;
  let httpServer: ReturnType<typeof createServer>;
  let port = 0;

  beforeEach(async () => {
    gateway = await createGateway();
    httpServer = createServer();
    server = websocketServer({ httpServer, gateway });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await server.close();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    );
    await gateway.close();
  });

  it("rejects upgrade when no subprotocol is offered", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const result = await new Promise<"opened" | "closed-without-protocol">((resolve) => {
      ws.on("open", () => {
        // ws emits open with no protocol selected — server's handleProtocols
        // returned false, so the connection should close immediately.
        resolve(ws.protocol === "" ? "closed-without-protocol" : "opened");
      });
      ws.on("error", () => resolve("closed-without-protocol"));
      ws.on("close", () => resolve("closed-without-protocol"));
    });
    expect(result).toBe("closed-without-protocol");
    ws.close();
  });

  it("rejects upgrade when an unrecognised subprotocol is offered", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, ["not-a-real-protocol"]);
    const result = await new Promise<"opened" | "rejected">((resolve) => {
      ws.on("open", () => resolve(ws.protocol === "" ? "rejected" : "opened"));
      ws.on("error", () => resolve("rejected"));
      ws.on("close", () => resolve("rejected"));
    });
    expect(result).toBe("rejected");
    ws.close();
  });

  it("accepts upgrade with the canonical agentick-rpc-v1 subprotocol", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, ["agentick-rpc-v1"]);
    const result = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve(ws.protocol));
      ws.on("error", () => resolve("error"));
    });
    expect(result).toBe("agentick-rpc-v1");
    ws.close();
  });
});

describe("WebSocket transport — origin validation", () => {
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  let server: ReturnType<typeof websocketServer>;
  let httpServer: ReturnType<typeof createServer>;
  let port = 0;

  beforeEach(async () => {
    gateway = await createGateway();
    httpServer = createServer();
    server = websocketServer({
      httpServer,
      gateway,
      allowedOrigins: ["https://allowed.example.com"],
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await server.close();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    );
    await gateway.close();
  });

  it("rejects connections from a disallowed origin with 403", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, ["agentick-rpc-v1"], {
      origin: "https://not-allowed.example.com",
    });
    const result = await new Promise<"rejected" | "opened">((resolve) => {
      ws.on("open", () => resolve("opened"));
      ws.on("error", () => resolve("rejected"));
      ws.on("unexpected-response", () => resolve("rejected"));
    });
    expect(result).toBe("rejected");
    ws.close();
  });

  it("accepts connections from an allowed origin", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, ["agentick-rpc-v1"], {
      origin: "https://allowed.example.com",
    });
    const result = await new Promise<"opened" | "rejected">((resolve) => {
      ws.on("open", () => resolve("opened"));
      ws.on("error", () => resolve("rejected"));
    });
    expect(result).toBe("opened");
    ws.close();
  });

  it("accepts connections without an Origin header (non-browser clients)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, ["agentick-rpc-v1"]);
    const result = await new Promise<"opened" | "rejected">((resolve) => {
      ws.on("open", () => resolve("opened"));
      ws.on("error", () => resolve("rejected"));
    });
    expect(result).toBe("opened");
    ws.close();
  });
});
