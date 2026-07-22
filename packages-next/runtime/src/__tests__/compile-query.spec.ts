/**
 * `compileQuery` correctness — the compiled matcher must agree with
 * `matchesQuery` for every shape in the query union. Anything that
 * passes for one MUST pass for the other on the same event.
 */

import { describe, expect, it } from "vitest";

import type { EventQuery, ProtocolEvent } from "@agentick/spec-next";

import { compileQuery, matchesQuery } from "../substrate/query.js";

function mk(overrides: Partial<ProtocolEvent>): ProtocolEvent {
  return {
    id: "ev_1",
    surface: "executor",
    phase: "delta",
    name: "executor:command:run",
    timestamp: 1,
    scope: {},
    ...overrides,
  } as ProtocolEvent;
}

function assertAgrees(query: EventQuery, events: ReadonlyArray<ProtocolEvent>): void {
  const matcher = compileQuery(query);
  for (const event of events) {
    expect(matcher(event)).toBe(matchesQuery(event, query));
  }
}

describe("compileQuery — agrees with matchesQuery on every shape", () => {
  const events = [
    mk({}),
    mk({ surface: "tool", phase: "requested", name: "tool:command:dispatch" }),
    mk({ surface: "session", phase: "terminal", name: "session:send", outcome: "succeeded" }),
    mk({ surface: "compiler", phase: "before", name: "compiler:render" }),
    mk({
      surface: "executor",
      phase: "delta",
      name: "executor:command:run",
      tags: ["streaming", "high-priority"],
    }),
    mk({
      surface: "executor",
      phase: "delta",
      name: "executor:command:run",
      scope: { sessionId: "s1", executionId: "e1", tickId: "t1" },
    }),
  ];

  it("empty query matches everything", () => {
    assertAgrees({}, events);
  });

  it("single surface scalar", () => {
    assertAgrees({ surface: "executor" }, events);
  });

  it("surface array (any-of)", () => {
    assertAgrees({ surface: ["executor", "tool"] }, events);
  });

  it("single phase scalar", () => {
    assertAgrees({ phase: "delta" }, events);
  });

  it("phase array", () => {
    assertAgrees({ phase: ["requested", "terminal"] }, events);
  });

  it("name exact", () => {
    assertAgrees({ name: { exact: "executor:command:run" } }, events);
  });

  it("name prefix", () => {
    assertAgrees({ name: { prefix: "executor:" } }, events);
  });

  it("name segments", () => {
    assertAgrees({ name: { segments: ["executor", "command"] } }, events);
  });

  it("name wildcard with *", () => {
    assertAgrees({ name: { wildcard: "executor:*:run" } }, events);
  });

  it("name wildcard with **", () => {
    assertAgrees({ name: { wildcard: "executor:**" } }, events);
  });

  it("outcome scalar", () => {
    assertAgrees({ outcome: "succeeded" }, events);
  });

  it("outcome array", () => {
    assertAgrees({ outcome: ["succeeded", "failed"] }, events);
  });

  it("tagsAny", () => {
    assertAgrees({ tagsAny: ["streaming"] }, events);
  });

  it("tagsAny multiple", () => {
    assertAgrees({ tagsAny: ["high-priority", "low-priority"] }, events);
  });

  it("scope (every present key must match)", () => {
    assertAgrees({ scope: { sessionId: "s1", executionId: "e1" } }, events);
  });

  it("scope with undefined values is ignored", () => {
    assertAgrees({ scope: { sessionId: "s1", executionId: undefined } }, events);
  });

  it("composite — surface + phase + name", () => {
    assertAgrees(
      {
        surface: "executor",
        phase: "delta",
        name: { prefix: "executor:" },
      },
      events,
    );
  });

  it("composite — all fields populated", () => {
    assertAgrees(
      {
        surface: ["executor", "tool"],
        phase: "delta",
        name: { exact: "executor:command:run" },
        tagsAny: ["streaming"],
        scope: { sessionId: "s1" },
      },
      events,
    );
  });
});

describe("compileQuery — specialisation cases", () => {
  it("returns an always-true closure for empty query", () => {
    const matcher = compileQuery({});
    expect(matcher(mk({}))).toBe(true);
    expect(matcher(mk({ surface: "tool" }))).toBe(true);
  });

  it("returns the single check directly for one-field queries", () => {
    const matcher = compileQuery({ surface: "executor" });
    expect(matcher(mk({ surface: "executor" }))).toBe(true);
    expect(matcher(mk({ surface: "tool" }))).toBe(false);
  });

  it("two-field queries short-circuit on the first false", () => {
    const matcher = compileQuery({ surface: "executor", phase: "delta" });
    expect(matcher(mk({ surface: "executor", phase: "delta" }))).toBe(true);
    expect(matcher(mk({ surface: "tool", phase: "delta" }))).toBe(false);
    expect(matcher(mk({ surface: "executor", phase: "requested" }))).toBe(false);
  });

  it("scope-only query with no entries treats as match-all", () => {
    const matcher = compileQuery({ scope: {} });
    expect(matcher(mk({}))).toBe(true);
  });

  it("name wildcard handles ** as remainder match", () => {
    const matcher = compileQuery({ name: { wildcard: "executor:**" } });
    expect(matcher(mk({ name: "executor:command:run" }))).toBe(true);
    expect(matcher(mk({ name: "executor" }))).toBe(false);
    expect(matcher(mk({ name: "tool:command:dispatch" }))).toBe(false);
  });

  it("name segments must be a prefix of the event name segments", () => {
    const matcher = compileQuery({ name: { segments: ["executor", "command"] } });
    expect(matcher(mk({ name: "executor:command:run" }))).toBe(true);
    expect(matcher(mk({ name: "executor:other" }))).toBe(false);
    expect(matcher(mk({ name: "executor" }))).toBe(false);
  });
});
