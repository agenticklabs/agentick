/**
 * `matchesScope` — the canonical scope-containment predicate shared by the
 * event-query matcher and every store's scope-filtered `list`.
 */

import { describe, expect, it } from "vitest";

import { matchesScope, compileScopeMatcher } from "../match-filter.js";

interface Scope {
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly principal?: string;
}

describe("matchesScope", () => {
  it("an empty filter matches every scope", () => {
    expect(matchesScope<Scope>({}, { sessionId: "s1" })).toBe(true);
    expect(matchesScope<Scope>({}, {})).toBe(true);
  });

  it("every present dimension must strictly equal the scope's", () => {
    const scope: Scope = { sessionId: "s1", executionId: "e9" };
    expect(matchesScope({ sessionId: "s1" }, scope)).toBe(true);
    expect(matchesScope({ sessionId: "s1", executionId: "e9" }, scope)).toBe(true);
    expect(matchesScope({ sessionId: "s2" }, scope)).toBe(false);
    expect(matchesScope({ executionId: "e0" }, scope)).toBe(false);
  });

  it("a narrower filter than the scope fails when a required key is absent", () => {
    expect(matchesScope<Scope>({ executionId: "e9" }, { sessionId: "s1" })).toBe(false);
  });

  it("an explicit `undefined` filter value is not a constraint", () => {
    // Parity with matchesQuery/scopeMatches: undefined values are skipped.
    expect(matchesScope<Scope>({ sessionId: undefined }, { sessionId: "s1" })).toBe(true);
    expect(matchesScope<Scope>({ sessionId: undefined }, {})).toBe(true);
  });

  it("uses strict equality (no coercion)", () => {
    const scope = { count: 1 } as Record<string, unknown>;
    expect(matchesScope({ count: 1 }, scope)).toBe(true);
    expect(matchesScope({ count: "1" }, scope)).toBe(false);
  });
});

describe("compileScopeMatcher (compiled hot-path form)", () => {
  it("is semantically identical to matchesScope across filters", () => {
    const scope: Scope = { sessionId: "s1", executionId: "e9" };
    const filters: Array<Partial<Scope>> = [
      {},
      { sessionId: "s1" },
      { sessionId: "s1", executionId: "e9" },
      { sessionId: "s2" },
      { executionId: "e0" },
      { principal: "acme/user-42" },
      { sessionId: undefined },
    ];
    for (const filter of filters) {
      expect(compileScopeMatcher(filter)(scope)).toBe(matchesScope(filter, scope));
    }
  });

  it("an empty / all-undefined filter compiles to a constant-true matcher", () => {
    expect(compileScopeMatcher<Scope>({})({ sessionId: "s1" })).toBe(true);
    expect(compileScopeMatcher<Scope>({ sessionId: undefined })({})).toBe(true);
  });

  it("the compiled matcher is reusable across many scopes (pre-extracted once)", () => {
    const match = compileScopeMatcher<Scope>({ sessionId: "s1" });
    expect(match({ sessionId: "s1", executionId: "e1" })).toBe(true);
    expect(match({ sessionId: "s1", executionId: "e2" })).toBe(true);
    expect(match({ sessionId: "s2" })).toBe(false);
    expect(match({})).toBe(false);
  });
});
