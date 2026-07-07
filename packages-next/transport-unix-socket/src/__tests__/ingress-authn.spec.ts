/**
 * Ingress-authentication conformance (ADR 61 slice 1) against the REAL
 * unix-socket server. A unix socket is host-local trust: the crossing
 * always carries `credential.kind: "none"`. The `none` conformance
 * variant asserts local-pole-by-default, fail-closed when a configured
 * AuthSource rejects `none`, and admitted-with-no-principal under
 * `allowAnonymous`.
 *
 * Uses a raw `net` client speaking NDJSON. Fail-closed is observed by
 * racing the dispatch response against the socket closing — when the
 * server destroys the socket (rejected crossing) the close wins.
 */

import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "@agentick/gateway-next";
import {
  runIngressAuthnConformance,
  spyAuthorizer,
  type IngressAuthnFactory,
  type IngressAuthnServer,
} from "@agentick/transport-next/testing";

import { unixSocketServer } from "../server/index.js";

interface UnixConn {
  request(method: string, params: unknown): Promise<unknown>;
  /** Resolves the first time the socket closes or errors after connect. */
  readonly closed: Promise<void>;
  close(): void;
}

function connectUnix(path: string): Promise<UnixConn> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(path);
    const pending = new Map<number, (r: unknown) => void>();
    let buffer = "";
    let nextId = 0;
    let closedResolve!: () => void;
    const closed = new Promise<void>((r) => {
      closedResolve = r;
    });
    sock.on("data", (d: Buffer) => {
      buffer += d.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number") {
          const resolveFn = pending.get(msg.id);
          if (resolveFn) {
            pending.delete(msg.id);
            resolveFn(msg);
          }
        }
      }
    });
    sock.once("connect", () => {
      // Post-connect errors/closes feed the fail-closed race, not reject.
      sock.on("error", () => closedResolve());
      sock.on("close", () => closedResolve());
      resolve({
        closed,
        request(method, params) {
          return new Promise((res) => {
            const id = ++nextId;
            pending.set(id, res);
            sock.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
          });
        },
        close() {
          sock.end();
        },
      });
    });
    sock.once("error", reject);
  });
}

let sockSeq = 0;

const factory: IngressAuthnFactory = {
  kind: "unix",
  credentialModel: "none",
  crossingModel: "per-connection",
  async withServer(opts, body) {
    const spy = spyAuthorizer();
    const gateway = await createGateway({ authorizer: spy.authorizer });
    const path = join(tmpdir(), `agentick-ingress-${process.pid}-${++sockSeq}.sock`);
    const server = unixSocketServer({
      path,
      gateway,
      ...(opts.authSource ? { authSource: opts.authSource } : {}),
    });
    // net.Server.listen is async; give it a tick to bind.
    await new Promise<void>((r) => server.server.once("listening", () => r()));

    const server_iface: IngressAuthnServer = {
      async crossing() {
        const conn = await connectUnix(path);
        const before = spy.seen.length;
        const outcome = await Promise.race([
          conn.request("gateway/listApps", {}).then(() => "ok" as const),
          conn.closed.then(() => "refused" as const),
        ]);
        conn.close();
        if (outcome === "refused") throw new Error("unix crossing refused");
        return { principal: spy.seen[before] };
      },
      async twoCrossingsOneSession() {
        const conn = await connectUnix(path);
        const i = spy.seen.length;
        await conn.request("gateway/listApps", {});
        await conn.request("gateway/listApps", {});
        conn.close();
        return { first: spy.seen[i], second: spy.seen[i + 1] };
      },
    };

    try {
      return await body(server_iface);
    } finally {
      await server.close();
      await gateway.closeGateway();
    }
  },
};

runIngressAuthnConformance(factory);
