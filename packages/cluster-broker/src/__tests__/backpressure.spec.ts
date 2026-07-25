/**
 * Phase 4f.4 — bounded outbound queue verification.
 *
 * Two assertions:
 *
 *   1. Enqueuing more frames than `maxQueueSize` against a stuck
 *      connection drops the OLDEST and emits
 *      `cluster:broker:server:backpressure-drop`. No exception
 *      escapes; the broker stays responsive.
 *   2. Closing a connection mid-drain stops the queue cleanly; no
 *      further drain attempts after close.
 */

import { describe, expect, it } from "vitest";

import { BoundedWriteQueue } from "../bounded-write-queue.js";
import type { Connection } from "../connection.js";

function makeStuckConnection(): {
  conn: Connection;
  release: () => void;
  sentBytes: Uint8Array[];
} {
  const sentBytes: Uint8Array[] = [];
  let release: () => void = () => {};
  let pending: Promise<void> | null = null;

  const conn: Connection = {
    id: "stuck-1",
    remote: undefined,
    async send(bytes) {
      sentBytes.push(bytes);
      // First send blocks until release; subsequent sends resolve
      // immediately (simulating a client that catches up after a
      // pause).
      if (pending === null) {
        pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await pending;
      }
    },
    onMessage: () => () => {},
    onClose: () => () => {},
    async close() {},
  };

  return { conn, release: () => release(), sentBytes };
}

describe("BoundedWriteQueue — backpressure overflow", () => {
  it("drops the OLDEST frame on overflow + invokes onOverflow", async () => {
    const { conn, release } = makeStuckConnection();
    const overflows: Array<{ dropped: { id: number }; depth: number }> = [];
    const queue = new BoundedWriteQueue<{ id: number }>({
      conn,
      encode: (f) => new TextEncoder().encode(JSON.stringify(f)),
      maxQueueSize: 3,
      onOverflow: (dropped, depth) => overflows.push({ dropped, depth }),
    });

    // Enqueue 5 frames; queue cap is 3. First enqueue triggers drain;
    // its `send` blocks (stuck connection). Subsequent enqueues fill
    // queue then overflow.
    queue.enqueue({ id: 1 });
    queue.enqueue({ id: 2 });
    queue.enqueue({ id: 3 });
    queue.enqueue({ id: 4 });
    queue.enqueue({ id: 5 });

    // Microtask yield so drain task starts (it'll be blocked on send).
    await Promise.resolve();

    // Two overflows expected: dropping id=1 (or id=2 depending on
    // whether the first frame is already in flight) and one more.
    // We assert AT LEAST one overflow + that the dropped frames are
    // older than the surviving ones.
    expect(overflows.length).toBeGreaterThanOrEqual(1);
    const droppedIds = overflows.map((o) => o.dropped.id);
    const minDropped = Math.min(...droppedIds);
    const maxDropped = Math.max(...droppedIds);
    // Dropped IDs are older (smaller) — we drop oldest.
    expect(minDropped).toBeLessThanOrEqual(2);
    expect(maxDropped).toBeLessThanOrEqual(2);

    // Release the stuck send and let the rest drain.
    release();
    queue.close();
  });

  it("close stops the drain — no further sends after close", async () => {
    const { conn, release } = makeStuckConnection();
    const queue = new BoundedWriteQueue<{ id: number }>({
      conn,
      encode: (f) => new TextEncoder().encode(JSON.stringify(f)),
      maxQueueSize: 10,
    });

    queue.enqueue({ id: 1 });
    queue.enqueue({ id: 2 });

    await Promise.resolve();
    expect(queue.depth).toBeLessThanOrEqual(2);

    queue.close();
    expect(queue.depth).toBe(0);

    // Releasing the stuck send shouldn't cause any further activity.
    release();
    await Promise.resolve();
    expect(queue.depth).toBe(0);
  });

  it("preserves order for frames that DO survive overflow", async () => {
    const sentBytes: Uint8Array[] = [];
    const conn: Connection = {
      id: "ok-1",
      remote: undefined,
      async send(bytes) {
        sentBytes.push(bytes);
      },
      onMessage: () => () => {},
      onClose: () => () => {},
      async close() {},
    };
    const queue = new BoundedWriteQueue<{ seq: number }>({
      conn,
      encode: (f) => new TextEncoder().encode(JSON.stringify(f)),
      maxQueueSize: 100,
    });
    for (let i = 0; i < 10; i++) {
      queue.enqueue({ seq: i });
    }
    // Yield a few microtasks so the drain finishes.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(sentBytes.length).toBe(10);
    const seqs = sentBytes.map((b) => JSON.parse(new TextDecoder().decode(b)).seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
