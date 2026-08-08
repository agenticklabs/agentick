/**
 * Conformance suite for a replacement {@link IdGenerator}.
 *
 * `setIdGenerator` accepts any thunk returning a string, which is a wider door
 * than the contract. The journal orders entries by id and cursored reads page
 * by it — neither re-checks — so a generator that guarantees only uniqueness
 * corrupts both without ever raising an error. Run this against a candidate
 * before installing it.
 */

import { describe, expect, it } from "vitest";

import type { IdGenerator } from "../id.js";

export interface IdGeneratorConformanceOptions {
  /**
   * Ids minted per ordering check. The default exercises same-millisecond
   * bursts, which is the case that breaks a time-only generator.
   */
  readonly burst?: number;
}

/**
 * Assert a generator is usable as the process-wide id source.
 *
 * @example
 * ```ts
 * import { runIdGeneratorConformance } from "@agentick/utils/testing";
 *
 * runIdGeneratorConformance("uuidv7", () => uuidv7());
 * ```
 */
export function runIdGeneratorConformance(
  name: string,
  generator: IdGenerator,
  options: IdGeneratorConformanceOptions = {},
): void {
  const burst = options.burst ?? 1_000;

  describe(`IdGenerator conformance — ${name}`, () => {
    it("returns a non-empty string every time", () => {
      for (let i = 0; i < 100; i++) {
        const id = generator();
        expect(typeof id).toBe("string");
        expect(id.length).toBeGreaterThan(0);
      }
    });

    it("never repeats across a tight burst", () => {
      const ids = Array.from({ length: burst }, () => generator());
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("is MONOTONIC — each id sorts strictly after the one before", () => {
      // The load-bearing one. A same-millisecond burst is the normal case, and
      // a generator keyed only on the clock emits equal — or worse, unordered
      // — ids here.
      const ids = Array.from({ length: burst }, () => generator());
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]! > ids[i - 1]!).toBe(true);
      }
    });

    it("is LEXICOGRAPHICALLY sortable — sort() recovers generation order", () => {
      // Distinct from monotonicity: ids could increase pairwise yet still sort
      // wrong in bulk if their length varies (an unpadded counter does this —
      // "9" sorts after "10").
      const ids = Array.from({ length: burst }, () => generator());
      expect([...ids].reverse().sort()).toEqual(ids);
    });

    it("emits a FIXED-WIDTH id, so string comparison is not length-sensitive", () => {
      const widths = new Set(Array.from({ length: burst }, () => generator().length));
      expect(widths.size).toBe(1);
    });
  });
}
