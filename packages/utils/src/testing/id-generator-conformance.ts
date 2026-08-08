/**
 * The executable contract for a replacement {@link IdGenerator}.
 *
 * Imports NO test framework, deliberately. Two reasons, and the second is the
 * one that bites: a conformance suite that hardcodes `vitest` forces every
 * adopter onto vitest to check their own generator; and `@agentick/utils/testing`
 * is the home of `waitFor`, which half the repo imports — including code that
 * gets `require()`d outside a test run. One test-framework import in this barrel
 * makes every transitive consumer fail to load, several packages away from the
 * edit. So this throws a plain `Error` and the caller supplies the runner.
 *
 * ```ts
 * it("uuidv7 is fit to install", () => {
 *   assertIdGeneratorConformance("uuidv7", () => uuidv7());
 * });
 * ```
 */

import type { IdGenerator } from "../id.js";

export interface IdGeneratorConformanceOptions {
  /**
   * Ids minted per ordering check. The default exercises same-millisecond
   * bursts, which is the case a clock-only generator fails.
   */
  readonly burst?: number;
}

class IdGeneratorContractError extends Error {
  constructor(name: string, claim: string, detail: string) {
    super(`id generator "${name}" violates the contract: ${claim}\n  ${detail}`);
    this.name = "IdGeneratorContractError";
  }
}

/**
 * Throw unless `generator` is fit for `setIdGenerator`.
 *
 * The contract is not "returns a unique string". It is MONOTONIC — each id
 * sorts strictly after the one before — and LEXICOGRAPHICALLY SORTABLE, so
 * `sort()` recovers generation order. The journal orders entries by id and
 * cursored reads page by it, and neither re-checks, so a generator that
 * guarantees only uniqueness corrupts both in silence.
 *
 * Resolves nothing and returns nothing; a violation is an exception carrying
 * the offending pair.
 */
export function assertIdGeneratorConformance(
  name: string,
  generator: IdGenerator,
  options: IdGeneratorConformanceOptions = {},
): void {
  const burst = options.burst ?? 1_000;
  const fail = (claim: string, detail: string): never => {
    throw new IdGeneratorContractError(name, claim, detail);
  };

  const ids: string[] = [];
  for (let i = 0; i < burst; i++) {
    const id: unknown = generator();
    if (typeof id !== "string" || id.length === 0) {
      fail("every id is a non-empty string", `got ${JSON.stringify(id)} at index ${i}`);
    }
    ids.push(id as string);
  }

  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    fail("no collisions across a burst", `${ids.length - unique.size} duplicate(s) in ${burst}`);
  }

  // The load-bearing one. A same-millisecond burst is the normal case, and a
  // generator keyed only on the clock emits equal — or unordered — ids here.
  for (let i = 1; i < ids.length; i++) {
    if (!(ids[i]! > ids[i - 1]!)) {
      fail(
        "each id sorts strictly after the one before",
        `ids[${i - 1}]=${ids[i - 1]!} ids[${i}]=${ids[i]!}`,
      );
    }
  }

  // Distinct from monotonicity: ids can increase pairwise yet still sort wrong
  // in bulk when their width varies — an unpadded counter does exactly this,
  // because "9" sorts after "10".
  const widths = new Set(ids.map((id) => id.length));
  if (widths.size !== 1) {
    fail("ids are fixed-width", `saw widths ${[...widths].sort((a, b) => a - b).join(", ")}`);
  }

  const sorted = [...ids].reverse().sort();
  for (let i = 0; i < ids.length; i++) {
    if (sorted[i] !== ids[i]) {
      fail(
        "sort() recovers generation order",
        `position ${i}: expected ${ids[i]!}, sorted ${sorted[i]!}`,
      );
    }
  }
}
