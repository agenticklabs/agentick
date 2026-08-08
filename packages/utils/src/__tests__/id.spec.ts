/**
 * `generateId()` — the id generator every journal / envelope / mount id rides.
 *
 * The three properties the rest of the framework leans on, none of which were
 * pinned before this file: the ENCODING is a fixed-width Crockford base32
 * string, ids are MONOTONIC within a single millisecond (the journal orders
 * entries by id, and same-ms bursts are the normal case), and the encoding is
 * LEXICOGRAPHICALLY sortable across milliseconds (so `sort()` on ids equals
 * generation order — what cursored reads assume).
 *
 * `generateId()` carries module-level state (`lastTime` / `lastRandom`), so these
 * tests only ever compare ids WITHIN their own sequence.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { generateId } from "../id.js";
import { assertIdGeneratorConformance } from "../testing/id-generator-conformance.js";

/** Crockford base32 — the digits plus letters minus I, L, O, U. */
const CROCKFORD = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]+$/;

/** 48 bits of time → 10 chars; 80 bits of randomness → 16 chars. */
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const TOTAL_CHARS = TIME_CHARS + RANDOM_CHARS;

/** Crockford base32, the alphabet `generateId()` encodes with. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The random suffix as an integer, so "advanced by one" is exact across a carry. */
function decodeSuffix(id: string): bigint {
  let n = 0n;
  for (const ch of id.slice(TIME_CHARS)) n = n * 32n + BigInt(ALPHABET.indexOf(ch));
  return n;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("generateId — encoding", () => {
  it("is 26 chars: a 10-char time prefix + a 16-char random suffix", () => {
    for (let i = 0; i < 100; i++) {
      const id = generateId();
      expect(id).toHaveLength(TOTAL_CHARS);
    }
  });

  it("uses only the Crockford base32 alphabet (no I, L, O, U)", () => {
    const ids = Array.from({ length: 200 }, () => generateId());
    for (const id of ids) {
      expect(id).toMatch(CROCKFORD);
    }
    expect(ids.join("")).not.toMatch(/[ILOU]/);
  });

  it("never collides across a tight burst", () => {
    const ids = Array.from({ length: 5_000 }, () => generateId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("generateId — monotonicity within one millisecond", () => {
  it("ids from a frozen clock share the time prefix and strictly increase", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));

    // The FIRST id after a clock change reseeds the random suffix; from the
    // second on, the suffix is bumped, which is what makes the burst ordered.
    generateId();
    const ids = Array.from({ length: 500 }, () => generateId());

    const prefixes = new Set(ids.map((id) => id.slice(0, TIME_CHARS)));
    expect(prefixes.size).toBe(1);

    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  it("the random suffix advances by exactly one, carrying when it must", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:01.000Z"));

    generateId();
    const a = generateId();
    const b = generateId();
    // Same time prefix, and the suffix is the IMMEDIATE successor — an
    // increment, not a reseed.
    //
    // Asserting instead that only the final char changes is wrong 1 run in 32:
    // when the suffix ends in `Z` (the top of the alphabet) the increment
    // carries into the next position, which is precisely what it should do.
    // Decoding is exact and carry-safe. BigInt because 16 base32 chars is
    // 80 bits, well past Number.MAX_SAFE_INTEGER.
    expect(b.slice(0, TIME_CHARS)).toBe(a.slice(0, TIME_CHARS));
    expect(decodeSuffix(b) - decodeSuffix(a)).toBe(1n);
    expect(b > a).toBe(true);
    expect(a.slice(TIME_CHARS)).toHaveLength(RANDOM_CHARS);
  });
});

describe("generateId — a clock that steps backward", () => {
  it("never emits a smaller id when the clock is corrected BACKWARD", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:05.000Z"));
    const before = generateId();

    // NTP correction, VM migration, leap-second smear — all real, all silent.
    // Taking Date.now() verbatim here emitted a smaller time prefix, so the id
    // sorted BEFORE one already handed out; `lastTime` is a monotonic floor.
    vi.setSystemTime(new Date("2026-07-27T00:00:03.000Z"));
    const after = generateId();

    expect(after > before).toBe(true);
  });

  it("keeps the sequence ordered across a backward step and the recovery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:05.000Z"));
    const ids = [generateId(), generateId()];

    vi.setSystemTime(new Date("2026-07-27T00:00:04.000Z"));
    ids.push(generateId(), generateId());

    // Clock recovers past the floor — normal reseeding resumes.
    vi.setSystemTime(new Date("2026-07-27T00:00:09.000Z"));
    ids.push(generateId(), generateId());

    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
    expect([...ids].sort()).toEqual(ids);
  });
});

describe("generateId — lexicographic ordering across milliseconds", () => {
  it("a later millisecond always produces a greater id", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));

    const ids: string[] = [];
    for (let ms = 0; ms < 50; ms++) {
      ids.push(generateId());
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
      ids.push(generateId(), generateId());
      vi.advanceTimersByTime(1);
    }

    const shuffled = [...ids].reverse();
    expect([...shuffled].sort()).toEqual(ids);
  });

  it("the time prefix survives a large timestamp (48-bit range, not 32)", () => {
    vi.useFakeTimers();
    // Ascending, because `lastTime` is a monotonic floor: generating the
    // far-future id FIRST would pin the floor there, and the 2026 id would
    // inherit that prefix rather than a smaller one. That is the ordering
    // guarantee working, not the encoder failing — so the encoder is tested
    // going forward, which is the only direction a clock is supposed to go.
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    const near = generateId();

    // Year 2286 — past the 32-bit seconds epoch rollover; the encoder walks 6
    // bytes, so this must still be a plain 10-char prefix.
    vi.setSystemTime(new Date("2286-11-20T17:46:40.000Z"));
    const far = generateId();

    expect(far).toMatch(CROCKFORD);
    expect(far).toHaveLength(TOTAL_CHARS);
    expect(far.slice(0, TIME_CHARS) > near.slice(0, TIME_CHARS)).toBe(true);
  });
});

describe("the built-in generator satisfies the published contract", () => {
  it("passes assertIdGeneratorConformance", () => {
    // The bar we hold adopters to is the bar we hold ourselves to. If this ever
    // diverges, the suite is wrong — it is what adopters check their own
    // generator against, so it has to be the real contract and not a weaker
    // cousin of it.
    expect(() =>
      assertIdGeneratorConformance("built-in", generateId, { burst: 500 }),
    ).not.toThrow();
  });
});

describe("assertIdGeneratorConformance — it has to REJECT the real mistakes", () => {
  it("rejects a random-uuid generator (unique, but unordered)", () => {
    // The mistake the seam invites: uuidv4 is unique and looks like an id, and
    // it destroys journal ordering the moment it is installed.
    let n = 0;
    const uuidLike = (): string =>
      `${(n = n + 7919) % 9973}`.padStart(4, "0") + "-0000-4000-8000-000000000000";
    expect(() => assertIdGeneratorConformance("uuid-ish", uuidLike, { burst: 200 })).toThrow(
      /sorts strictly after/,
    );
  });

  it("rejects an UNPADDED counter — increasing as numbers, not as strings", () => {
    // The classic. Monotonic by `>` on NUMBERS, and broken under the string
    // sort a cursor actually uses: "9" sorts after "10". The monotonic check
    // compares as strings, so it catches this at the 9 -> 10 rollover.
    let n = 0;
    const counter = (): string => String(++n);
    expect(() => assertIdGeneratorConformance("counter", counter, { burst: 20 })).toThrow(
      /sorts strictly after/,
    );
  });

  it("rejects a VARYING-WIDTH generator that is otherwise well-ordered", () => {
    // Isolates the fixed-width claim: these are strictly increasing as strings
    // AND sort() recovers their order, so only the width check rejects them.
    // Width matters because a cursor compares against ids it has never seen.
    let id = "";
    const growing = (): string => (id += "a");
    expect(() => assertIdGeneratorConformance("growing", growing, { burst: 10 })).toThrow(
      /fixed-width/,
    );
  });

  it("rejects a generator that repeats", () => {
    expect(() => assertIdGeneratorConformance("constant", () => "same", { burst: 5 })).toThrow(
      /collision/,
    );
  });

  it("rejects a clock-only generator across a same-millisecond burst", () => {
    // No suffix to bump, so a burst inside one tick emits equal ids.
    const clockOnly = (): string => String(1_700_000_000_000).padStart(20, "0");
    expect(() => assertIdGeneratorConformance("clock-only", clockOnly, { burst: 10 })).toThrow(
      /collision/,
    );
  });
});
