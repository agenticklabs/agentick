import { describe, expect, expectTypeOf, it } from "vitest";
import {
  relation,
  type SessionFrom,
  type SessionFromInput,
  type SessionRecord,
  type SessionRelation,
} from "../index.js";

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "s1",
  createdAt: 0,
  updatedAt: 0,
  status: "idle",
  executionCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ...over,
});

const from = (over: Partial<SessionFrom> = {}): SessionFrom => ({
  sessionId: "source",
  entryId: "e7",
  seq: 7,
  inherited: true,
  anchored: false,
  ...over,
});

describe("relation() — the ADR 100 truth table", () => {
  it("root session → conversation", () => {
    expect(relation(record())).toBe("conversation");
  });

  it("fork(e?) — inherited, not anchored → fork", () => {
    expect(relation(record({ from: from({ inherited: true, anchored: false }) }))).toBe("fork");
  });

  it("reply(e) — inherited and anchored → reply", () => {
    expect(relation(record({ from: from({ inherited: true, anchored: true }) }))).toBe("reply");
  });

  it("spawn(agent) — internal, not inherited → worker", () => {
    expect(
      relation(record({ internal: true, from: from({ inherited: false, anchored: false }) })),
    ).toBe("worker");
  });

  it("spawn(agent, { branch }) — internal and inherited → forked-worker", () => {
    expect(
      relation(record({ internal: true, from: from({ inherited: true, anchored: false }) })),
    ).toBe("forked-worker");
  });

  it("a host-created internal session with no origin is still a worker", () => {
    expect(relation(record({ internal: true }))).toBe("worker");
  });

  it("internal outranks the conversation dispositions — plumbing renders nowhere", () => {
    expect(
      relation(record({ internal: true, from: from({ inherited: true, anchored: true }) })),
    ).toBe("forked-worker");
  });

  it("reads only internal + from", () => {
    expectTypeOf(relation).returns.toEqualTypeOf<SessionRelation>();
  });
});

describe("the from bag", () => {
  it("the record carries seq; the create door does not", () => {
    expectTypeOf<SessionFromInput>().toEqualTypeOf<Omit<SessionFrom, "seq">>();
    const door: SessionFromInput = {
      sessionId: "source",
      entryId: "e7",
      inherited: true,
      anchored: true,
      // @ts-expect-error — genesis resolves seq from entryId; a door caller cannot assert it.
      seq: 7,
    };
    expect(door.entryId).toBe("e7");
  });

  it("the dead shape is inexpressible", () => {
    // @ts-expect-error — `parentSessionId` died with ADR 100; `from` replaces it.
    const withParent: SessionRecord = { ...record(), parentSessionId: "source" };
    expect(withParent.id).toBe("s1");
  });
});
