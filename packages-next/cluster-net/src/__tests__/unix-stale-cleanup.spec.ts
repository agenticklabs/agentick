/**
 * Phase 4d — Unix-socket stale-cleanup behavior. Verifies the
 * operational claim that the listener can recover from a crashed
 * predecessor that left a stale socket file behind.
 */

import { describe, expect, it } from "vitest";

import { writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ClusterCodec } from "@agentick/cluster-broker-next";

import { tryBindOrConnectUnix } from "../auto-elect.js";
import { unixBroker } from "../unix-cluster.js";

function jsonCodec(): ClusterCodec {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    encode: (v) => enc.encode(JSON.stringify(v)),
    decode: (raw) => JSON.parse(dec.decode(raw)),
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cluster-net-stale-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Unix socket — stale-socket cleanup", () => {
  it("unixBroker auto-unlinks a stale socket file before binding", async () => {
    await withTempDir(async (dir) => {
      const socketPath = join(dir, "broker.sock");
      // Simulate a crashed predecessor: drop a regular file at the
      // socket path. (A real stale socket would be the same — a
      // filesystem entry that no process is listening on.)
      await writeFile(socketPath, "");
      // Cleanup default is true → broker should unlink + bind.
      const running = await unixBroker({ socketPath, codec: jsonCodec() });
      // Socket file should now be a live socket; stat succeeds.
      const stats = await stat(socketPath);
      expect(stats.isSocket()).toBe(true);
      await running.close();
    });
  });

  it("unixBroker with cleanupStaleSocket: false refuses to bind over an existing file", async () => {
    await withTempDir(async (dir) => {
      const socketPath = join(dir, "broker.sock");
      await writeFile(socketPath, "");
      await expect(
        unixBroker({ socketPath, codec: jsonCodec(), cleanupStaleSocket: false }),
      ).rejects.toThrow(/.*/);
    });
  });

  it("tryBindOrConnectUnix: auto wins via cleanup when stale file exists", async () => {
    await withTempDir(async (dir) => {
      const socketPath = join(dir, "elected.sock");
      await writeFile(socketPath, "");
      const result = await tryBindOrConnectUnix({ socketPath, mode: "auto" });
      expect(result.role).toBe("broker");
      expect(result.server).toBeDefined();
      await new Promise<void>((resolve) => result.server!.close(() => resolve()));
    });
  });

  it("tryBindOrConnectUnix: a live socket → role=client (no takeover)", async () => {
    await withTempDir(async (dir) => {
      const socketPath = join(dir, "occupied.sock");
      // Stand up a real listener so the auto-elect probe sees a
      // live peer.
      const running = await unixBroker({ socketPath, codec: jsonCodec() });
      try {
        const result = await tryBindOrConnectUnix({ socketPath, mode: "auto" });
        expect(result.role).toBe("client");
        expect(result.server).toBeUndefined();
      } finally {
        await running.close();
      }
    });
  });
});
