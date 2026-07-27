/**
 * A failed bind is a rejected promise, never a dead process.
 *
 * `unixSocketServer` called `server.listen(path)` and returned. A `net.Server`
 * reports a bind failure by EMITTING `error` — and an unhandled `error` on an
 * EventEmitter is a thrown exception at the top of the event loop. So the single
 * most likely operational failure for this transport, a stale socket file left
 * by an unclean shutdown (`EADDRINUSE`), took the whole process down from a
 * callback the adopter had no way to catch.
 *
 * The observable is a rejection an adopter can actually handle. `listening()`
 * is the promise the bind resolves; the wrapping `ServerTransport.listen()`
 * awaits the same thing, so the raw factory and the gateway-owned path share
 * one failure story.
 */

import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "@agentick/gateway";
import { afterEach, describe, expect, it } from "vitest";

import { unixSocketServer, unixSocketServerTransport } from "../server/index.js";

const dirs: string[] = [];
const squatters: Server[] = [];

afterEach(async () => {
  while (squatters.length) {
    const server = squatters.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentick-uds-listen-"));
  dirs.push(dir);
  return join(dir, "test.sock");
}

/** Occupy `path` with a foreign listener — the stale-socket-file condition. */
async function occupy(path: string): Promise<void> {
  const server = createServer();
  squatters.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
}

describe("unix socket server — bind failure", () => {
  it("REJECTS on an occupied path instead of throwing at the top of the event loop", async () => {
    const path = socketPath();
    await occupy(path);

    const gateway = await createGateway();
    const handle = unixSocketServer({ path, gateway });

    await expect(handle.listening()).rejects.toBeDefined();

    await handle.close().catch(() => {});
    await gateway.close();
  });

  it("the bind failure is a typed Error carrying the EADDRINUSE code", async () => {
    const path = socketPath();
    await occupy(path);

    const gateway = await createGateway();
    const handle = unixSocketServer({ path, gateway });

    const error = await handle.listening().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("EADDRINUSE");

    await handle.close().catch(() => {});
    await gateway.close();
  });

  it("the bind failure never escapes as an uncaught exception", async () => {
    // An `error` emitted on a `net.Server` with NO listener is a thrown
    // exception at the top of the event loop. Recording process-level
    // `uncaughtException` is what distinguishes "reported to the adopter" from
    // "took the process with it".
    const uncaught: unknown[] = [];
    const record = (e: unknown): void => void uncaught.push(e);
    process.on("uncaughtException", record);
    try {
      const path = socketPath();
      await occupy(path);

      const gateway = await createGateway();
      const handle = unixSocketServer({ path, gateway });
      // Deliberately NOT awaited: this test asks what happens to an adopter who
      // ignores the bind outcome entirely. The rejection is read only to keep it
      // from resurfacing as an unhandled rejection.
      void handle.listening().catch(() => {});
      // Give the event loop a turn for an unhandled emit to surface.
      await new Promise((r) => setTimeout(r, 100));

      expect(uncaught).toEqual([]);

      await handle.close().catch(() => {});
      await gateway.close();
    } finally {
      process.off("uncaughtException", record);
    }
  });

  it("a clean path RESOLVES — the success path is unchanged", async () => {
    const path = socketPath();
    const gateway = await createGateway();
    const handle = unixSocketServer({ path, gateway });

    await expect(handle.listening()).resolves.toBeUndefined();

    await handle.close();
    await gateway.close();
  });

  it("gateway.listen() surfaces the bind failure through the ServerTransport", async () => {
    const path = socketPath();
    await occupy(path);

    const gateway = await createGateway({ transports: [unixSocketServerTransport({ path })] });
    await expect(gateway.listen()).rejects.toBeDefined();
    await gateway.close().catch(() => {});
  });
});
