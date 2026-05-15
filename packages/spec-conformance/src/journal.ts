/**
 * Conformance suite for `OperationJournal` implementations.
 *
 * Validates the invariants in `docs/proposals/v2/blueprint/19-foundation.md`
 * §The OperationJournal contract. Run from any vitest test file:
 *
 * ```ts
 * import { describe } from "vitest";
 * import { runJournalConformance } from "@agentick/spec-conformance";
 * import { MemoryJournal } from "@agentick/runtime";
 *
 * describe("MemoryJournal", () => runJournalConformance(() => new MemoryJournal()));
 * ```
 */

import { describe, expect, it } from "vitest";
import type { EventScope, OperationJournal, ProtocolEvent } from "@agentick/spec";

export function runJournalConformance(factory: () => OperationJournal): void {
  describe("OperationJournal — append/read invariants", () => {
    it("read({}, beginning) reflects appended events in order", async () => {
      const j = factory();
      const a = mkEvent({ id: "e1", opId: "op-1", phase: "requested" });
      const b = mkEvent({ id: "e2", opId: "op-1", phase: "terminal", outcome: "succeeded" });
      await j.append(a);
      await j.append(b);
      const out = await collect(j.read({}, "beginning"));
      expect(out.map((e) => e.id)).toEqual(["e1", "e2"]);
    });

    it("read with surface filter narrows to matching events", async () => {
      const j = factory();
      await j.appendBatch([
        mkEvent({ id: "a", surface: "session", phase: "requested" }),
        mkEvent({ id: "b", surface: "tool", phase: "requested" }),
        mkEvent({ id: "c", surface: "session", phase: "terminal", outcome: "succeeded" }),
      ]);
      const out = await collect(j.read({ surface: "session" }, "beginning"));
      expect(out.map((e) => e.id)).toEqual(["a", "c"]);
    });

    it("read with name.prefix matches hierarchically", async () => {
      const j = factory();
      await j.appendBatch([
        mkEvent({ id: "1", name: "tool:dispatch:invoke", phase: "requested" }),
        mkEvent({ id: "2", name: "session:lifecycle:mount", phase: "requested" }),
      ]);
      const out = await collect(j.read({ name: { prefix: "tool:" } }, "beginning"));
      expect(out.map((e) => e.id)).toEqual(["1"]);
    });

    it("read with scope matches by-key", async () => {
      const j = factory();
      await j.appendBatch([
        mkEvent({ id: "1", scope: { sessionId: "s_1" } }),
        mkEvent({ id: "2", scope: { sessionId: "s_2" } }),
      ]);
      const out = await collect(j.read({ scope: { sessionId: "s_1" } }, "beginning"));
      expect(out.map((e) => e.id)).toEqual(["1"]);
    });
  });

  describe("OperationJournal — idempotency", () => {
    it("appending the same (opId, phase) twice is a no-op", async () => {
      const j = factory();
      const a = mkEvent({ id: "x", opId: "op-1", phase: "requested" });
      await j.append(a);
      await j.append({ ...a, id: "x-dup" });
      const out = await collect(j.read({}, "beginning"));
      expect(out).toHaveLength(1);
      expect(out[0]!.id).toBe("x");
    });

    it("lookupTerminal returns Some after terminal append", async () => {
      const j = factory();
      await j.append(mkEvent({ id: "e1", opId: "op-42", phase: "requested" }));
      let look = await j.lookupTerminal("op-42");
      expect(look.some).toBe(false);
      await j.append(
        mkEvent({
          id: "e2",
          opId: "op-42",
          phase: "terminal",
          outcome: "succeeded",
          payload: { result: 7 },
        }),
      );
      look = await j.lookupTerminal("op-42");
      expect(look.some).toBe(true);
      if (look.some) {
        expect(look.value.outcome).toBe("succeeded");
        if (look.value.outcome === "succeeded") {
          expect(look.value.result).toBe(7);
        }
      }
    });

    it("lookupTerminal returns Some=false for unknown opId", async () => {
      const j = factory();
      const look = await j.lookupTerminal("never");
      expect(look.some).toBe(false);
    });
  });

  describe("OperationJournal — tail subscription", () => {
    it("tail yields events appended after subscription", async () => {
      const j = factory();
      const iter = j.tail({})[Symbol.asyncIterator]();
      const ev = mkEvent({ id: "live", opId: "op-1", phase: "requested" });
      const next = iter.next();
      await j.append(ev);
      const result = await next;
      expect(result.done).toBe(false);
      if (!result.done) expect(result.value.id).toBe("live");
      await iter.return?.();
    });

    it("tail respects query filter", async () => {
      const j = factory();
      const ctrl = new AbortController();
      const iter = j.tail({ surface: "tool" }, ctrl.signal)[Symbol.asyncIterator]();
      const next = iter.next();
      await j.append(mkEvent({ id: "s", surface: "session" }));
      await j.append(mkEvent({ id: "t", surface: "tool" }));
      const result = await next;
      expect(result.done).toBe(false);
      if (!result.done) expect(result.value.id).toBe("t");
      ctrl.abort();
      const end = await iter.next();
      expect(end.done).toBe(true);
    });
  });

  describe("OperationJournal — crash recovery", () => {
    it("findOrphaned returns ops with requested but no terminal", async () => {
      const j = factory();
      await j.append(mkEvent({ id: "a1", opId: "op-A", phase: "requested" }));
      await j.append(mkEvent({ id: "b1", opId: "op-B", phase: "requested" }));
      await j.append(
        mkEvent({ id: "b2", opId: "op-B", phase: "terminal", outcome: "succeeded" }),
      );
      const orphans = await j.findOrphaned();
      expect(orphans.map((o) => o.opId)).toEqual(["op-A"]);
    });

    it("findOrphaned filters by olderThan (excludes recent entries)", async () => {
      const j = factory();
      await j.append(mkEvent({ id: "fresh", opId: "op-fresh", phase: "requested" }));
      // Only orphans older than 1M ms ago. The fresh entry is brand new,
      // so it must be excluded.
      const orphans = await j.findOrphaned({ olderThan: 1_000_000 });
      expect(orphans).toHaveLength(0);
    });
  });
}

// ============================================================================
// helpers
// ============================================================================

interface MkEvent {
  readonly id: string;
  readonly opId?: string;
  readonly surface?: ProtocolEvent["surface"];
  readonly name?: string;
  readonly phase?: ProtocolEvent["phase"];
  readonly outcome?: ProtocolEvent["outcome"];
  readonly payload?: unknown;
  readonly scope?: EventScope;
  readonly timestamp?: number;
}

function mkEvent(input: MkEvent): ProtocolEvent {
  return {
    id: input.id,
    opId: input.opId,
    surface: input.surface ?? "session",
    name: input.name ?? "session:test",
    phase: input.phase ?? "requested",
    outcome: input.outcome,
    timestamp: input.timestamp ?? Date.now(),
    scope: input.scope ?? {},
    payload: input.payload,
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}
