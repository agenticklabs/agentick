/**
 * `MultiplexedStream<T>` backpressure policies — bounded buffer with
 * drop-oldest / drop-newest / close-on-overflow, plus the default
 * unbounded behavior.
 *
 * Verifies the 33.C hardening contract — fast producer / slow consumer
 * no longer OOMs unconditionally; adopters pick the tradeoff.
 */

import { describe, expect, it } from "vitest";
import { MultiplexedStream, type BackpressureError } from "../client/multiplexed-stream.js";

const noClose = async (): Promise<void> => {};

describe("MultiplexedStream backpressure", () => {
  describe("default — unbounded", () => {
    it("never drops; buffer grows with the producer", () => {
      const s = new MultiplexedStream<number>("s1", noClose);
      for (let i = 0; i < 10_000; i++) s.push(i);
      expect(s.dropped).toBe(0);
    });

    it("constructor rejects capacity for unbounded — no, leaves it alone", () => {
      // Unbounded ignores capacity; not an error.
      const s = new MultiplexedStream<number>("s1", noClose, { policy: "unbounded" });
      s.push(1);
      expect(s.dropped).toBe(0);
    });
  });

  describe("validation", () => {
    it("rejects missing capacity when policy is bounded", () => {
      expect(() => new MultiplexedStream<number>("s", noClose, { policy: "drop-oldest" })).toThrow(
        /capacity/,
      );
    });

    it("rejects zero / negative / non-finite capacity", () => {
      for (const cap of [0, -1, Infinity, NaN]) {
        expect(
          () =>
            new MultiplexedStream<number>("s", noClose, {
              policy: "drop-newest",
              capacity: cap,
            }),
        ).toThrow(/capacity/);
      }
    });
  });

  describe("drop-oldest", () => {
    it("evicts oldest values when full; preserves newest", async () => {
      const dropped: number[] = [];
      const s = new MultiplexedStream<number>("s", noClose, {
        policy: "drop-oldest",
        capacity: 3,
        onDrop: (v) => dropped.push(v),
      });
      s.push(1);
      s.push(2);
      s.push(3);
      s.push(4); // evicts 1
      s.push(5); // evicts 2
      expect(s.dropped).toBe(2);
      expect(dropped).toEqual([1, 2]);

      const iter = s[Symbol.asyncIterator]();
      expect((await iter.next()).value).toBe(3);
      expect((await iter.next()).value).toBe(4);
      expect((await iter.next()).value).toBe(5);
    });

    it("pending next() bypasses the buffer (delivered directly)", async () => {
      const s = new MultiplexedStream<number>("s", noClose, {
        policy: "drop-oldest",
        capacity: 2,
      });
      const iter = s[Symbol.asyncIterator]();
      const p = iter.next();
      // Consumer awaiting — push goes straight to resolver, never counted
      s.push(42);
      const r = await p;
      expect(r.value).toBe(42);
      expect(s.dropped).toBe(0);
    });
  });

  describe("drop-newest", () => {
    it("drops incoming values once full; preserves oldest", async () => {
      const dropped: number[] = [];
      const s = new MultiplexedStream<number>("s", noClose, {
        policy: "drop-newest",
        capacity: 2,
        onDrop: (v) => dropped.push(v),
      });
      s.push(1);
      s.push(2);
      s.push(3); // dropped
      s.push(4); // dropped
      expect(s.dropped).toBe(2);
      expect(dropped).toEqual([3, 4]);

      const iter = s[Symbol.asyncIterator]();
      expect((await iter.next()).value).toBe(1);
      expect((await iter.next()).value).toBe(2);
    });
  });

  describe("close-on-overflow", () => {
    it("terminates the stream with a backpressure error on overflow", async () => {
      let overflowed: number | undefined;
      const s = new MultiplexedStream<number>("sub-7", noClose, {
        policy: "close-on-overflow",
        capacity: 2,
        onOverflow: (v) => {
          overflowed = v;
        },
      });
      s.push(1);
      s.push(2);
      s.push(99); // triggers overflow

      expect(overflowed).toBe(99);

      const iter = s[Symbol.asyncIterator]();
      // Buffered values still deliverable before the error surfaces
      expect((await iter.next()).value).toBe(1);
      expect((await iter.next()).value).toBe(2);
      await expect(iter.next()).rejects.toMatchObject<BackpressureError>({
        kind: "backpressure",
        streamId: "sub-7",
        message: expect.stringContaining("overflowed") as unknown as string,
      });
    });

    it("subsequent push() after termination is a no-op", async () => {
      const s = new MultiplexedStream<number>("s", noClose, {
        policy: "close-on-overflow",
        capacity: 1,
      });
      s.push(1);
      s.push(2); // overflow → terminate
      s.push(3); // ignored

      const iter = s[Symbol.asyncIterator]();
      expect((await iter.next()).value).toBe(1);
      await expect(iter.next()).rejects.toMatchObject({ kind: "backpressure" });
    });
  });
});
