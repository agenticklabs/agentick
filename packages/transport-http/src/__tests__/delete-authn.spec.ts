/**
 * `DELETE` is an authenticated crossing (ADR 61).
 *
 * `DELETE <path>` releases a session's whole server-side fan-out state — its
 * subscriptions, its in-flight registry, its notification stream. That is a
 * mutation with a real blast radius, so a configured `AuthSource` must govern
 * it exactly like `POST` and the `GET` stream open. Before this, whoever
 * learned a session id could tear it down anonymously.
 *
 * The observable: an authenticated `GET` stream is open on the session; an
 * unauthenticated `DELETE` must NOT end it, must answer `401`, and must leave
 * an admission-failure trace. The authenticated `DELETE` then does end it —
 * proving the gate rejects the caller, not the verb.
 *
 * Raw `node:http` (not the high-level client) so the test controls the bearer
 * header and the session id directly. `csrf: false` isolates the authn axis;
 * CSRF has its own coverage in `security.spec.ts`.
 */

import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway } from "@agentick/gateway";
import {
  collectAdmissionFailures,
  ingressAuthnAuthSource,
  INGRESS_AUTHN_TOKENS,
  spyAuthorizer,
} from "@agentick/transport/testing";
import type { IngressAdmissionFailure } from "@agentick/spec";
import { afterEach, describe, expect, it } from "vitest";

import { httpServer } from "../server/index.js";

const { alice } = INGRESS_AUTHN_TOKENS;

interface Started {
  readonly port: number;
  readonly admissionFailures: () => Promise<readonly IngressAdmissionFailure[]>;
  close(): Promise<void>;
}

const started: Started[] = [];

afterEach(async () => {
  while (started.length) await started.pop()!.close();
});

async function start(): Promise<Started> {
  const spy = spyAuthorizer();
  const gateway = await createGateway({ authorizer: spy.authorizer });
  const admission = collectAdmissionFailures(gateway);
  const node = createServer();
  const server = httpServer({
    httpServer: node,
    gateway,
    csrf: false,
    authSource: ingressAuthnAuthSource(),
  });
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", () => r()));
  const handle: Started = {
    port: (node.address() as AddressInfo).port,
    admissionFailures: admission.admissionFailures,
    async close() {
      admission.stop();
      await server.close();
      await new Promise<void>((res, rej) => node.close((e) => (e ? rej(e) : res())));
      await gateway.close();
    },
  };
  started.push(handle);
  return handle;
}

/** A live `GET` SSE stream: its session id, plus whether the server ended it. */
interface Stream {
  readonly status: number;
  readonly sessionId: string;
  /** True once the server ended the response (what `DELETE` teardown does). */
  ended: () => boolean;
  destroy: () => void;
}

function openStream(port: number, token: string | undefined): Promise<Stream> {
  return new Promise<Stream>((resolve, reject) => {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/", method: "GET", headers },
      (res) => {
        let ended = false;
        res.on("data", () => {});
        res.on("end", () => (ended = true));
        res.on("close", () => (ended = true));
        resolve({
          status: res.statusCode ?? 0,
          sessionId: (res.headers["mcp-session-id"] as string | undefined) ?? "",
          ended: () => ended,
          destroy: () => {
            res.destroy();
            req.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function del(port: number, sessionId: string, token: string | undefined): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const headers: Record<string, string> = { "Mcp-Session-Id": sessionId };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/", method: "DELETE", headers },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Give the server a beat to act (or not act) on the DELETE. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100));

describe("DELETE ingress authentication", () => {
  it("REFUSES an unauthenticated DELETE — 401, session untouched", async () => {
    const { port } = await start();
    const stream = await openStream(port, alice);
    expect(stream.status).toBe(200);
    expect(stream.sessionId).not.toBe("");

    const status = await del(port, stream.sessionId, undefined);
    await settle();

    expect(status).toBe(401);
    // The session's fan-out state must survive a refused teardown.
    expect(stream.ended()).toBe(false);
    stream.destroy();
  });

  it("REFUSES an invalid bearer on DELETE — 401", async () => {
    const { port } = await start();
    const stream = await openStream(port, alice);
    const status = await del(port, stream.sessionId, "not-a-real-token");
    await settle();
    expect(status).toBe(401);
    expect(stream.ended()).toBe(false);
    stream.destroy();
  });

  it("a refused DELETE leaves an admission-failure trace", async () => {
    const s = await start();
    const stream = await openStream(s.port, alice);
    await del(s.port, stream.sessionId, "not-a-real-token");

    const failures = await s.admissionFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.failureClass).toBe("authenticate");
    expect(failures[0]!.transportKind).toBe("http");
    stream.destroy();
  });

  it("ADMITS an authenticated DELETE — the session's stream is torn down", async () => {
    const { port } = await start();
    const stream = await openStream(port, alice);
    const status = await del(port, stream.sessionId, alice);
    await settle();

    expect(status).toBe(204);
    expect(stream.ended()).toBe(true);
    stream.destroy();
  });
});
