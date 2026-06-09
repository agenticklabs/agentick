/**
 * Conformance suite for `OperationJournal` implementations.
 *
 * Validates the invariants in `docs/proposals/v2/blueprint/19-foundation.md`
 * §The OperationJournal contract. Run from any vitest test file:
 *
 * ```ts
 * import { describe } from "vitest";
 * import { runJournalConformance } from "@agentick/spec-conformance-next";
 * import { MemoryJournal } from "@agentick/runtime-next";
 *
 * describe("MemoryJournal", () => runJournalConformance(() => new MemoryJournal()));
 * ```
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Fiber, Stream } from "effect";
import type { EventScope, OperationJournal, ProtocolEvent } from "@agentick/spec-next";

export function runJournalConformance(factory: () => OperationJournal): void {
  describe("OperationJournal — append/read invariants", () => {
    it("read({}, beginning) reflects appended events in order", async () => {
      const j = factory();
      const a = mkEvent({ id: "e1", opId: "op-1", phase: "requested" });
      const b = mkEvent({ id: "e2", opId: "op-1", phase: "terminal", outcome: "succeeded" });
      await Effect.runPromise(j.append(a));
      await Effect.runPromise(j.append(b));
      const out = await collect(j.readByQuery({}, "beginning"));
      expect(out.map((e) => e.id)).toEqual(["e1", "e2"]);
    });

    it("read with surface filter narrows to matching events", async () => {
      const j = factory();
      await Effect.runPromise(
        j.appendBatch([
          mkEvent({ id: "a", surface: "session", phase: "requested" }),
          mkEvent({ id: "b", surface: "tool", phase: "requested" }),
          mkEvent({ id: "c", surface: "session", phase: "terminal", outcome: "succeeded" }),
        ]),
      );
      const out = await collect(j.readByQuery({ surface: "session" }, "beginning"));
      expect(out.map((e) => e.id)).toEqual(["a", "c"]);
    });

    it("read with name.prefix matches hierarchically", async () => {
      const j = factory();
      await Effect.runPromise(
        j.appendBatch([
          mkEvent({ id: "1", name: "tool:dispatch:invoke", phase: "requested" }),
          mkEvent({ id: "2", name: "session:lifecycle:mount", phase: "requested" }),
        ]),
      );
      const out = await collect(j.readByQuery({ name: { prefix: "tool:" } }, "beginning"));
      expect(out.map((e) => e.id)).toEqual(["1"]);
    });

    it("read with scope matches by-key", async () => {
      const j = factory();
      await Effect.runPromise(
        j.appendBatch([
          mkEvent({ id: "1", scope: { sessionId: "s_1" } }),
          mkEvent({ id: "2", scope: { sessionId: "s_2" } }),
        ]),
      );
      const out = await collect(j.readByQuery({ scope: { sessionId: "s_1" } }, "beginning"));
      expect(out.map((e) => e.id)).toEqual(["1"]);
    });
  });

  describe("OperationJournal — idempotency", () => {
    it("appending the same (opId, phase) twice is a no-op", async () => {
      const j = factory();
      const a = mkEvent({ id: "x", opId: "op-1", phase: "requested" });
      await Effect.runPromise(j.append(a));
      await Effect.runPromise(j.append({ ...a, id: "x-dup" }));
      const out = await collect(j.readByQuery({}, "beginning"));
      expect(out).toHaveLength(1);
      expect(out[0]!.id).toBe("x");
    });

    it("lookupTerminal returns Some after terminal append", async () => {
      const j = factory();
      await Effect.runPromise(j.append(mkEvent({ id: "e1", opId: "op-42", phase: "requested" })));
      let look = await Effect.runPromise(j.lookupTerminal("op-42"));
      expect(look.some).toBe(false);
      await Effect.runPromise(
        j.append(
          mkEvent({
            id: "e2",
            opId: "op-42",
            phase: "terminal",
            outcome: "succeeded",
            payload: { result: 7 },
          }),
        ),
      );
      look = await Effect.runPromise(j.lookupTerminal("op-42"));
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
      const look = await Effect.runPromise(j.lookupTerminal("never"));
      expect(look.some).toBe(false);
    });
  });

  describe("OperationJournal — tail subscription", () => {
    it("tail yields events appended after subscription", async () => {
      const j = factory();
      const fiber = Effect.runFork(Stream.runHead(j.tail({})).pipe(Effect.map((o) => o)));
      // Microtask flush to ensure the tail listener is registered.
      await new Promise((r) => setImmediate(r));
      const ev = mkEvent({ id: "live", opId: "op-1", phase: "requested" });
      await Effect.runPromise(j.append(ev));
      const result = await Effect.runPromise(Fiber.join(fiber));
      // Stream.runHead returns Option<T>; cast safely.
      expect((result as unknown as { _tag: string; value?: ProtocolEvent })._tag).toBe("Some");
      const found = result as unknown as { value?: ProtocolEvent };
      expect(found.value?.id).toBe("live");
    });

    it("tail respects query filter", async () => {
      const j = factory();
      const fiber = Effect.runFork(Stream.runHead(j.tail({ surface: "tool" })));
      await new Promise((r) => setImmediate(r));
      await Effect.runPromise(j.append(mkEvent({ id: "s", surface: "session" })));
      await Effect.runPromise(j.append(mkEvent({ id: "t", surface: "tool" })));
      const result = await Effect.runPromise(Fiber.join(fiber));
      const found = result as unknown as { value?: ProtocolEvent };
      expect(found.value?.id).toBe("t");
    });
  });

  describe("OperationJournal — crash recovery", () => {
    it("findOrphaned returns ops with requested but no terminal", async () => {
      const j = factory();
      await Effect.runPromise(j.append(mkEvent({ id: "a1", opId: "op-A", phase: "requested" })));
      await Effect.runPromise(j.append(mkEvent({ id: "b1", opId: "op-B", phase: "requested" })));
      await Effect.runPromise(
        j.append(mkEvent({ id: "b2", opId: "op-B", phase: "terminal", outcome: "succeeded" })),
      );
      const orphans = await Effect.runPromise(j.findOrphaned());
      expect(orphans.map((o) => o.opId)).toEqual(["op-A"]);
    });

    it("findOrphaned filters by olderThan (excludes recent entries)", async () => {
      const j = factory();
      await Effect.runPromise(
        j.append(mkEvent({ id: "fresh", opId: "op-fresh", phase: "requested" })),
      );
      // Only orphans older than 1M ms ago. The fresh entry is brand new,
      // so it must be excluded.
      const orphans = await Effect.runPromise(j.findOrphaned({ olderThan: 1_000_000 }));
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

async function collect(
  stream: Stream.Stream<ProtocolEvent, unknown, never>,
): Promise<ProtocolEvent[]> {
  const chunk = await Effect.runPromise(Stream.runCollect(stream));
  return Array.from(Chunk.toReadonlyArray(chunk));
}
