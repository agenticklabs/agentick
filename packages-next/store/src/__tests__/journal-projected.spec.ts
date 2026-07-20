/**
 * `JournalProjectedStore` — the reference event-sourced store.
 *
 * Proves: a store CAN be a pure projection of the operation journal (holds no
 * `Map`), its reads fold the journal, `asOf` time-travels to an earlier state,
 * and its writes are no-ops (the journal — not the store — is the write path).
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { MemoryJournal } from "@agentick/runtime-next";
import type { ProtocolEvent } from "@agentick/spec-next";

import { JournalProjectedStore } from "../journal-projected.js";
import { stubStoreCtx } from "../stub-store-ctx.js";

interface Cell {
  readonly id: string;
  readonly value: number;
}

/** Last-write-wins fold: each `kv:put` event sets its cell. */
function lastWriteWins(events: readonly ProtocolEvent[]): readonly Cell[] {
  const cells = new Map<string, number>();
  for (const e of events) {
    const p = e.payload as { id: string; value: number };
    cells.set(p.id, p.value);
  }
  return [...cells].map(([id, value]) => ({ id, value }));
}

function kvPut(id: string, value: number): ProtocolEvent {
  return {
    id: `evt-${id}-${value}-${Math.random().toString(36).slice(2)}`,
    surface: "session",
    name: "kv:put",
    phase: "delta",
    timestamp: Date.now(),
    scope: { sessionId: "s1" },
    payload: { id, value },
  };
}

function makeStore(): JournalProjectedStore<Cell, undefined> {
  return new JournalProjectedStore<Cell, undefined>({
    keyOf: (c) => c.id,
    scopeQuery: () => ({ name: { prefix: "kv:" } }),
    fold: lastWriteWins,
  });
}

async function seed(journal: MemoryJournal, events: readonly ProtocolEvent[]): Promise<void> {
  for (const e of events) await Effect.runPromise(journal.append(e));
}

describe("JournalProjectedStore — a projection of the journal", () => {
  it("list() folds the journal into the current state (holds no Map itself)", async () => {
    const journal = new MemoryJournal();
    await seed(journal, [kvPut("a", 1), kvPut("a", 2), kvPut("b", 9)]);
    const store = makeStore();

    const state = await store.list(undefined, stubStoreCtx({ journalReader: journal }));

    // a was overwritten (last-write-wins), b is present.
    expect(new Map(state.map((c) => [c.id, c.value]))).toEqual(
      new Map([
        ["a", 2],
        ["b", 9],
      ]),
    );
  });

  it("get() picks one folded record by key", async () => {
    const journal = new MemoryJournal();
    await seed(journal, [kvPut("a", 1), kvPut("a", 2), kvPut("b", 9)]);
    const store = makeStore();
    const ctx = stubStoreCtx({ journalReader: journal });

    expect(await store.get("a", ctx)).toEqual({ id: "a", value: 2 });
    expect(await store.get("b", ctx)).toEqual({ id: "b", value: 9 });
    expect(await store.get("missing", ctx)).toBeUndefined();
  });

  it("asOf time-travels: an earlier cursor yields the earlier state", async () => {
    const journal = new MemoryJournal();
    // Three appends → journal offsets 0,1,2.
    await seed(journal, [kvPut("a", 1), kvPut("a", 2), kvPut("b", 9)]);
    const store = makeStore();

    // No asOf → current state.
    const now = await store.list(undefined, stubStoreCtx({ journalReader: journal }));
    expect(new Map(now.map((c) => [c.id, c.value]))).toEqual(
      new Map([
        ["a", 2],
        ["b", 9],
      ]),
    );

    // asOf offset 1 → only the FIRST event folded → a=1, no b, no overwrite yet.
    const asOf1 = await store.list(
      undefined,
      stubStoreCtx({ journalReader: journal, asOf: { offset: 1 } }),
    );
    expect(new Map(asOf1.map((c) => [c.id, c.value]))).toEqual(new Map([["a", 1]]));

    // asOf offset 2 → first two events → a overwritten to 2, still no b.
    const asOf2 = await store.list(
      undefined,
      stubStoreCtx({ journalReader: journal, asOf: { offset: 2 } }),
    );
    expect(new Map(asOf2.map((c) => [c.id, c.value]))).toEqual(new Map([["a", 2]]));

    // The full (current) read is unchanged by the time-travel reads — the store
    // is stateless; asOf is per-read.
    const again = await store.list(undefined, stubStoreCtx({ journalReader: journal }));
    expect(again.length).toBe(2);
  });

  it("get() honors asOf too", async () => {
    const journal = new MemoryJournal();
    await seed(journal, [kvPut("a", 1), kvPut("a", 2)]);
    const store = makeStore();

    expect(await store.get("a", stubStoreCtx({ journalReader: journal }))).toEqual({
      id: "a",
      value: 2,
    });
    expect(
      await store.get("a", stubStoreCtx({ journalReader: journal, asOf: { offset: 1 } })),
    ).toEqual({ id: "a", value: 1 });
  });

  it("writes are no-ops — the journal is the write path, not the store", async () => {
    const journal = new MemoryJournal();
    await seed(journal, [kvPut("a", 1)]);
    const store = makeStore();
    const ctx = stubStoreCtx({ journalReader: journal });

    await store.put({ id: "z", value: 99 }, ctx);
    expect(await store.delete("a", ctx)).toBe(false);

    // Neither call mutated the projection — the state still reflects the journal.
    const state = await store.list(undefined, ctx);
    expect(new Map(state.map((c) => [c.id, c.value]))).toEqual(new Map([["a", 1]]));
  });

  it("list() throws when no journalReader is threaded", async () => {
    const store = makeStore();
    await expect(store.list(undefined, stubStoreCtx())).rejects.toThrow(/journalReader/);
  });
});
