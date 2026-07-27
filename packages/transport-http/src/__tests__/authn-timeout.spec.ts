/**
 * The authn wall-clock ceiling at the HTTP edge (ADR 61).
 *
 * A hung `AuthSource` — a JWKS endpoint that accepts the connection and never
 * answers — used to hold the request open indefinitely. The ceiling lives at
 * the shared ingress seam (`@agentick/transport`); this pins that the edge
 * inherits it, maps the refusal to `401`, and honours its own override.
 *
 * Every request below is raced against a test ceiling, so an unbounded edge
 * fails an assertion instead of timing the runner out.
 */

import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway } from "@agentick/gateway";
import type { AuthSource } from "@agentick/spec";
import { afterEach, describe, expect, it } from "vitest";

import { httpServer } from "../server/index.js";

interface Started {
  readonly port: number;
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
  await gateway.listen();
  const node = createServer();
  const server = httpServer({
    httpServer: node,
    gateway,
    csrf: false,
    authSource: opts.authSource,
    ...(opts.authnTimeoutMs !== undefined ? { authnTimeoutMs: opts.authnTimeoutMs } : {}),
  });
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", () => r()));
  const handle: Started = {
    port: (node.address() as AddressInfo).port,
    async close() {
      await server.close();
      await new Promise<void>((res, rej) => node.close((e) => (e ? rej(e) : res())));
      await gateway.close();
    },
  };
  started.push(handle);
  return handle;
}

/** Issue a request, racing its response against a test ceiling. */
async function statusOrHang(
  port: number,
  method: string,
  testCeilingMs = 1_000,
): Promise<number | "hung"> {
  const headers: Record<string, string> = { Authorization: "Bearer tok" };
  if (method === "POST") headers["Content-Type"] = "application/json";
  if (method === "GET") headers.Accept = "text/event-stream";

  const req = httpRequest({ host: "127.0.0.1", port, path: "/", method, headers });
  const answered = new Promise<number>((resolve, reject) => {
    req.on("response", (res) => {
      res.on("data", () => {});
      res.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
  });
  if (method === "POST") req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  else req.end();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<number | "hung">([
      answered,
      new Promise<"hung">((resolve) => {
        timer = setTimeout(() => resolve("hung"), testCeilingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    req.destroy();
  }
}

describe("HTTP authn wall-clock ceiling", () => {
  it("a hung AuthSource REFUSES the POST with 401 instead of hanging it", async () => {
    const { port } = await start({ authSource: hungAuthSource(), authnTimeoutMs: 60 });
    expect(await statusOrHang(port, "POST")).toBe(401);
  });

  it("a hung AuthSource REFUSES the GET stream open with 401", async () => {
    const { port } = await start({ authSource: hungAuthSource(), authnTimeoutMs: 60 });
    expect(await statusOrHang(port, "GET")).toBe(401);
  });

  it("a hung AuthSource REFUSES the DELETE with 401", async () => {
    const { port } = await start({ authSource: hungAuthSource(), authnTimeoutMs: 60 });
    expect(await statusOrHang(port, "DELETE")).toBe(401);
  });

  it("an AuthSource that answers inside the ceiling is admitted", async () => {
    const slow: AuthSource = {
      backend: "slow",
      authenticate: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { principal: "alice" };
      },
    };
    const { port } = await start({ authSource: slow, authnTimeoutMs: 500 });
    expect(await statusOrHang(port, "POST")).toBe(200);
  });
});
