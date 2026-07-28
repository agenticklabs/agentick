/**
 * The SQL the seq WINDOW generates — a white-box pin on `history`'s statement
 * shape, with a spy executor standing in for the driver.
 *
 * Deliberately NOT a conformance test (that one demands a real Postgres — see
 * `conformance.spec.ts`). The claim here is narrower and is about generated SQL,
 * which a spy can prove exactly: an upper bound becomes a `<=` predicate, and a
 * TAIL-anchored read (`limit` with no `fromSeq`) becomes the reverse slice
 * `ORDER BY seq DESC LIMIT n` whose rows are re-ascended before they leave the
 * adapter. Without this, the one query an adopter's brownfield table pays for
 * would ship untested wherever `TIMELINE_PG_URL` is unset.
 */

import { describe, expect, it } from "vitest";
import type { StoreCtx, TimelineEntry } from "@agentick/timeline";

import { postgresTimelineStore } from "../store.js";
import type { QueryExecutor } from "../store.js";

// `stubStoreCtx` lives in @agentick/store, which this adapter does not depend
// on (it targets the port, not the substrate); the ctx is one field.
const ctx: StoreCtx = { sessionId: "s1" };

interface Executed {
  readonly text: string;
  readonly values?: readonly unknown[];
}

const entry = (id: string): TimelineEntry => ({
  kind: "message",
  message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
});

/** A spy executor that replays `rows` for every statement and records them. */
function spyExecutor(rows: ReadonlyArray<Record<string, unknown>>): {
  executor: QueryExecutor;
  executed: Executed[];
} {
  const executed: Executed[] = [];
  return {
    executed,
    executor: {
      query: (text, values) => {
        executed.push({ text, values });
        return Promise.resolve({ rows });
      },
    },
  };
}

const row = (seq: number, id: string): Record<string, unknown> => ({
  seq: String(seq), // pg returns int8 as a string
  payload: entry(id),
  schema_ver: 1,
});

describe("postgresTimelineStore — the seq window", () => {
  it("turns toSeq into an inclusive upper-bound predicate", async () => {
    const { executor, executed } = spyExecutor([row(3, "c"), row(4, "d")]);
    const store = postgresTimelineStore({ executor });
    await store.history!("s1", { fromSeq: 3, toSeq: 4 }, ctx);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.text).toContain(`"seq" >= $2`);
    expect(executed[0]!.text).toContain(`"seq" <= $3`);
    expect(executed[0]!.values).toEqual(["s1", 3, 4]);
    // Forward anchor keeps the ascending ORDER BY.
    expect(executed[0]!.text).not.toContain("DESC");
  });

  it("a TAIL-anchored read is the reverse slice: ORDER BY DESC + LIMIT, rows re-ascended", async () => {
    // The driver returns DESC rows; the port promises ascending seq.
    const { executor, executed } = spyExecutor([row(9, "i"), row(8, "h")]);
    const store = postgresTimelineStore({ executor });
    const page = await store.history!("s1", { limit: 2 }, ctx);
    expect(executed[0]!.text).toContain(`ORDER BY "seq" DESC`);
    expect(executed[0]!.text).toContain("LIMIT $2");
    expect(executed[0]!.values).toEqual(["s1", 2]);
    expect(page.map((t) => t.seq)).toEqual([8, 9]);
  });

  it("backward paging bounds the reverse slice above", async () => {
    const { executor, executed } = spyExecutor([row(7, "g"), row(6, "f")]);
    const store = postgresTimelineStore({ executor });
    const page = await store.history!("s1", { toSeq: 7, limit: 2 }, ctx);
    expect(executed[0]!.text).toContain(`"seq" <= $2`);
    expect(executed[0]!.text).toContain(`ORDER BY "seq" DESC`);
    expect(executed[0]!.values).toEqual(["s1", 7, 2]);
    expect(page.map((t) => t.seq)).toEqual([6, 7]);
  });

  it("a forward page keeps ascending order and its LIMIT", async () => {
    const { executor, executed } = spyExecutor([row(0, "a"), row(1, "b")]);
    const store = postgresTimelineStore({ executor });
    const page = await store.history!("s1", { fromSeq: 0, limit: 2 }, ctx);
    expect(executed[0]!.text).toContain(`ORDER BY "seq"`);
    expect(executed[0]!.text).not.toContain("DESC");
    expect(executed[0]!.text).toContain("LIMIT $3");
    expect(page.map((t) => t.seq)).toEqual([0, 1]);
  });

  it("an unbounded read predicates on the session alone", async () => {
    const { executor, executed } = spyExecutor([]);
    const store = postgresTimelineStore({ executor });
    await store.history!("s1", undefined, ctx);
    expect(executed[0]!.values).toEqual(["s1"]);
    expect(executed[0]!.text).not.toContain(`"seq" >=`);
    expect(executed[0]!.text).not.toContain("LIMIT");
  });
});
