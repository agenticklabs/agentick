/**
 * Reconnect e2e over a REAL Unix socket — the server actually goes away, and
 * stays away across several backoff cycles.
 *
 * The failure this suite exists for (#262): `onError` used to call
 * `socket.removeAllListeners()`, which took the `close` listener with it. One
 * failed redial therefore reported nothing to `handleConnectionDrop`, no
 * further attempt was ever scheduled, and the transport parked in `connecting`
 * forever — a client that looks like it is trying and never dials again. Every
 * case below holds the socket down long enough that at least one redial MUST
 * fail before recovery is possible, which is what makes them fail on the old
 * code and pass on the new.
 *
 * Mirrors `transport-websocket/src/__tests__/reconnect-e2e.spec.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "@agentick/gateway";
import { createClient } from "@agentick/client-core";
import { isTransportError, type ClientState } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";
import { afterEach, describe, expect, it } from "vitest";

import { unixSocket } from "../client/index.js";
import { unixSocketServer } from "../server/index.js";

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

/** A directory that outlives the socket bound inside it. */
function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentick-uds-reconnect-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "agentick.sock");
}

interface Standing {
  stop(): Promise<void>;
}

/** Stand a real gateway-backed Unix-socket server on `path`. */
async function standServer(path: string): Promise<Standing> {
  const gateway = await createGateway();
  await gateway.listen();
  const server = unixSocketServer({ path, gateway });
  await new Promise<void>((resolve) => server.server.once("listening", () => resolve()));
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await server.close();
    await gateway.close();
  };
  cleanups.push(stop);
  return { stop };
}

function label(s: ClientState): string {
  return typeof s === "string" ? s : `failed:${s.kind}`;
}

describe("Unix socket reconnect e2e — the socket actually goes away", () => {
  it("keeps redialing across FAILED attempts and recovers when the socket returns", async () => {
    const path = socketPath();
    const first = await standServer(path);

    const states: string[] = [];
    const client = await createClient({
      transport: unixSocket({ path, reconnect: { initialDelayMs: 20, maxDelayMs: 40 } }),
      onStateChange: (s) => states.push(label(s)),
    });
    cleanups.push(() => client.close());

    await client.connect();
    expect(await client.request("ping", {})).toEqual({});

    // Kill it and KEEP it dead. Every dial during this window fails with
    // ENOENT — the case that used to wedge the loop after the FIRST one.
    await first.stop();
    rmSync(path, { force: true });
    await waitFor(() => states.includes("reconnecting"), {
      description: "transport entered reconnecting",
    });
    await new Promise((r) => setTimeout(r, 250));

    // Nothing terminal while the socket is gone: the loop must still be live.
    expect(states).not.toContain("closed");
    expect(states.some((s) => s.startsWith("failed:"))).toBe(false);
    // And it must be actually DIALING, not parked — several `connecting`
    // transitions after the first drop is the observable proof.
    const afterDrop = states.slice(states.indexOf("reconnecting"));
    expect(afterDrop.filter((s) => s === "connecting").length).toBeGreaterThan(1);

    // Same path, brand-new server.
    await standServer(path);

    await waitFor(() => client.state === "open", {
      timeoutMs: 5_000,
      description: "client re-opened after the outage",
    });
    await client.whenReady();

    expect(client.serverInfo).toBeDefined();
    expect(await client.request("ping", {})).toEqual({});
  });

  it("initial connect against a socket that does not exist yet comes up on its own", async () => {
    const path = socketPath();

    const states: string[] = [];
    const client = await createClient({
      transport: unixSocket({ path, reconnect: { initialDelayMs: 20, maxDelayMs: 40 } }),
      onStateChange: (s) => states.push(label(s)),
    });
    cleanups.push(() => client.close());

    // Nothing is bound. `connect()` rejects on its own failed dial — but
    // rejecting is not giving up, and the message has to say so.
    const outcome = await client.connect().then(
      () => "resolved" as const,
      (e: unknown) => e,
    );
    expect(outcome).not.toBe("resolved");
    expect(isTransportError(outcome)).toBe(true);
    expect((outcome as { kind: string }).kind).toBe("connection");
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/reconnect is armed/);

    // Server arrives late — several backoff cycles in.
    await new Promise((r) => setTimeout(r, 100));
    await standServer(path);

    await waitFor(() => client.state === "open", {
      timeoutMs: 5_000,
      description: "client reached open after a late server",
    });
    expect(states.filter((s) => s === "reconnecting").length).toBeGreaterThan(1);

    await client.whenReady();
    expect(client.serverInfo).toBeDefined();
    expect(await client.request("ping", {})).toEqual({});
  });

  it("deliberate close() never reconnects, even mid-backoff", async () => {
    const path = socketPath();
    const first = await standServer(path);

    const states: string[] = [];
    const client = await createClient({
      transport: unixSocket({ path, reconnect: { initialDelayMs: 30, maxDelayMs: 60 } }),
      onStateChange: (s) => states.push(label(s)),
    });
    await client.connect();

    await first.stop();
    rmSync(path, { force: true });
    await waitFor(() => states.includes("reconnecting"), {
      description: "loop armed before deliberate close",
    });
    await client.close();

    const seen = states.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(states[states.length - 1]).toBe("closed");
    expect(states.length).toBe(seen);
  });

  it("a finite reconnect budget ends in `failed`, not in silence", async () => {
    // `maxAttempts` defaults to Infinity — "never stop trying". An adopter who
    // asks for a finite budget must be able to SEE it run out; a transport
    // that quietly stops dialing is indistinguishable from one still trying.
    const path = socketPath();

    const states: ClientState[] = [];
    const transport = unixSocket({
      path,
      reconnect: { initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 },
    });
    cleanups.push(() => transport.close());
    transport.onStateChange((s) => states.push(s));

    await transport.connect().catch(() => {});

    await waitFor(() => states.some((s) => typeof s === "object" && s.kind === "failed"), {
      timeoutMs: 3_000,
      description: "transport reported the exhausted budget",
    });
    const failed = states.find((s) => typeof s === "object" && s.kind === "failed") as {
      kind: "failed";
      error: { kind: string; message: string };
    };
    expect(failed.error.kind).toBe("connection");
    expect(failed.error.message).toMatch(/exhausted/);
    // The message names the budget, so the reason is readable without
    // cross-referencing the construction site.
    expect(failed.error.message).toMatch(/maxAttempts = 2/);
  });
});
