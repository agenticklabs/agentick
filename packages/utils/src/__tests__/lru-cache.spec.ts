/**
 * The two bounds, and the one that used to be the caller's job.
 *
 * `expiresAt` rode on the entry while the store ignored it — its single caller
 * compared it by hand. That is safe with one consumer and a footgun with two,
 * so `get` reaps now and staleness cannot leak through a caller who forgot.
 */

import { describe, expect, it } from "vitest";

import { LruCacheStore } from "../lru-cache.js";

const NEVER = Number.POSITIVE_INFINITY;

describe("LruCacheStore", () => {
  it("evicts least-recently-used over capacity, and a HIT counts as use", () => {
    const c = new LruCacheStore<string>(2);
    c.set("a", { value: "A", expiresAt: NEVER });
    c.set("b", { value: "B", expiresAt: NEVER });
    c.get("a"); // 'a' is now most-recent, so 'b' is the eviction candidate
    c.set("c", { value: "C", expiresAt: NEVER });

    expect(c.get("a")?.value).toBe("A");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")?.value).toBe("C");
  });

  it("reaps an expired entry on read rather than returning it", () => {
    let now = 1_000;
    const c = new LruCacheStore<string>(10, () => now);
    c.set("k", { value: "V", expiresAt: 2_000 });

    expect(c.get("k")?.value).toBe("V");
    now = 2_000; // expiry is exclusive — AT the deadline it is gone
    expect(c.get("k")).toBeUndefined();
    expect(c.size()).toBe(0); // and the slot is released, not merely hidden
  });

  it("expiry is PER ENTRY — the point of the shape", () => {
    // A uniform constructor-level TTL cannot express this, and it is the case
    // that matters: the deadline comes from whoever issued the value (a file
    // handle's `expirationTime`, a token's `exp`), not from the cache.
    let now = 0;
    const c = new LruCacheStore<string>(10, () => now);
    c.set("short", { value: "S", expiresAt: 100 });
    c.set("long", { value: "L", expiresAt: 10_000 });

    now = 500;
    expect(c.get("short")).toBeUndefined();
    expect(c.get("long")?.value).toBe("L");
  });

  it("size counts what is HELD — an untouched expiry still occupies a slot", () => {
    // There is no sweeper on purpose. `size` measures memory, and memory is
    // what maxSize bounds; reaping is a read-path concern.
    let now = 0;
    const c = new LruCacheStore<string>(10, () => now);
    c.set("k", { value: "V", expiresAt: 1 });
    now = 5;
    expect(c.size()).toBe(1);
    c.get("k");
    expect(c.size()).toBe(0);
  });

  it("refuses a capacity it cannot honour", () => {
    expect(() => new LruCacheStore(0)).toThrow(/maxSize/);
  });
});
