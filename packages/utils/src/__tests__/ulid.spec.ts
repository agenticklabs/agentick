/**
 * `ulid()` — the id generator every journal / envelope / mount id rides.
 *
 * The three properties the rest of the framework leans on, none of which were
 * pinned before this file: the ENCODING is a fixed-width Crockford base32
 * string, ids are MONOTONIC within a single millisecond (the journal orders
 * entries by id, and same-ms bursts are the normal case), and the encoding is
 * LEXICOGRAPHICALLY sortable across milliseconds (so `sort()` on ids equals
 * generation order — what cursored reads assume).
 *
 * `ulid()` carries module-level state (`lastTime` / `lastRandom`), so these
 * tests only ever compare ids WITHIN their own sequence.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ulid } from "../ulid.js";

/** Crockford base32 — the digits plus letters minus I, L, O, U. */
const CROCKFORD = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]+$/;

/** 48 bits of time → 10 chars; 80 bits of randomness → 16 chars. */
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const TOTAL_CHARS = TIME_CHARS + RANDOM_CHARS;

afterEach(() => {
  vi.useRealTimers();
});

describe("ulid — encoding", () => {
  it("is 26 chars: a 10-char time prefix + a 16-char random suffix", () => {
    for (let i = 0; i < 100; i++) {
      const id = ulid();
      expect(id).toHaveLength(TOTAL_CHARS);
    }
  });

  it("uses only the Crockford base32 alphabet (no I, L, O, U)", () => {
    const ids = Array.from({ length: 200 }, () => ulid());
    for (const id of ids) {
      expect(id).toMatch(CROCKFORD);
    }
    expect(ids.join("")).not.toMatch(/[ILOU]/);
  });

  it("never collides across a tight burst", () => {
    const ids = Array.from({ length: 5_000 }, () => ulid());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("ulid — monotonicity within one millisecond", () => {
  it("ids from a frozen clock share the time prefix and strictly increase", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));

    // The FIRST id after a clock change reseeds the random suffix; from the
    // second on, the suffix is bumped, which is what makes the burst ordered.
    ulid();
    const ids = Array.from({ length: 500 }, () => ulid());

    const prefixes = new Set(ids.map((id) => id.slice(0, TIME_CHARS)));
    expect(prefixes.size).toBe(1);

    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  it("the random suffix advances by the smallest step (only the tail changes)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:01.000Z"));

    ulid();
    const a = ulid();
    const b = ulid();
    // Same time prefix, and the suffixes differ only in their final chars —
    // an increment, not a reseed.
    expect(b.slice(0, TIME_CHARS)).toBe(a.slice(0, TIME_CHARS));
    expect(b.slice(TIME_CHARS, TOTAL_CHARS - 1)).toBe(a.slice(TIME_CHARS, TOTAL_CHARS - 1));
    expect(b).not.toBe(a);
    expect(b > a).toBe(true);
    expect(a.slice(TIME_CHARS)).toHaveLength(RANDOM_CHARS);
  });
});

describe("ulid — lexicographic ordering across milliseconds", () => {
  it("a later millisecond always produces a greater id", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));

    const ids: string[] = [];
    for (let ms = 0; ms < 50; ms++) {
      ids.push(ulid());
      vi.advanceTimersByTime(1);
    }

    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  it("sorting a shuffled sequence recovers generation order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));

    const ids: string[] = [];
    for (let ms = 0; ms < 40; ms++) {
      // Two per millisecond — exercises BOTH the time prefix and the
      // same-ms suffix bump in one ordering claim.
      ids.push(ulid(), ulid());
      vi.advanceTimersByTime(1);
    }

    const shuffled = [...ids].reverse();
    expect([...shuffled].sort()).toEqual(ids);
  });

  it("the time prefix survives a large timestamp (48-bit range, not 32)", () => {
    vi.useFakeTimers();
    // Year 2286 — past the 32-bit seconds epoch rollover; the encoder walks 6
    // bytes, so this must still be a plain 10-char prefix.
    vi.setSystemTime(new Date("2286-11-20T17:46:40.000Z"));
    const far = ulid();

    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    const near = ulid();

    expect(far).toMatch(CROCKFORD);
    expect(far).toHaveLength(TOTAL_CHARS);
    expect(far.slice(0, TIME_CHARS) > near.slice(0, TIME_CHARS)).toBe(true);
  });
});
