/**
 * `PendingRequestStore` archetype fit — proves the generic `MemoryCollection`
 * satisfies the spec port (`@agentick/spec`) and round-trips a pending record,
 * including the escalation payload it embeds and the `expiresAt` GC cutoff. The
 * BaseHarness durable-suspend wiring that consumes this ships separately.
 */

import { describe, expect, it } from "vitest";

import type {
  PendingRequestQuery,
  PendingRequestRecord,
  PendingRequestStore,
} from "@agentick/spec";
import { matchPendingRequestQuery, pendingRequestExpired, pendingRequestKey } from "@agentick/spec";
import { stubStoreCtx } from "@agentick/store";

import { MemoryCollection } from "../memory-collection.js";

function store(): MemoryCollection<PendingRequestRecord, PendingRequestQuery, number> {
  return new MemoryCollection<PendingRequestRecord, PendingRequestQuery, number>({
    backend: "memory",
    keyOf: pendingRequestKey,
    matchQuery: matchPendingRequestQuery,
    prunePredicate: pendingRequestExpired,
  });
}

function record(overrides: Partial<PendingRequestRecord> = {}): PendingRequestRecord {
  return {
    correlationId: "req:1",
    surface: "mcp",
    payload: {
      class: "elicit",
      request: { message: "Confirm delete?" },
      lineage: [{ scopeId: "session:s-1", principal: "acme/u-1" }],
    },
    round: 0,
    createdAt: 1_000,
    ...overrides,
  };
}

describe("PendingRequestStore archetype", () => {
  it("MemoryCollection satisfies the spec port", () => {
    const fit: PendingRequestStore = store();
    expect(fit.backend).toBe("memory");
  });

  it("put/get round-trips the embedded escalation payload", async () => {
    const s = store();
    await s.put(record(), stubStoreCtx());
    const got = await s.get("req:1", stubStoreCtx());
    expect(got?.payload.class).toBe("elicit");
    expect(got?.payload.lineage?.[0]?.principal).toBe("acme/u-1");
  });

  it("put of the same correlationId replaces (a new round accumulates responses)", async () => {
    const s = store();
    await s.put(record({ round: 0 }), stubStoreCtx());
    await s.put(
      record({ round: 1, responses: { confirm_delete: { action: "accept" } } }),
      stubStoreCtx(),
    );
    const got = await s.get("req:1", stubStoreCtx());
    expect(got?.round).toBe(1);
    expect(got?.responses?.confirm_delete).toEqual({ action: "accept" });
    expect(await s.list(undefined, stubStoreCtx())).toHaveLength(1);
  });

  it("list filters by surface / class / principal (AND semantics)", async () => {
    const s = store();
    await s.put(record({ correlationId: "req:1", surface: "mcp" }), stubStoreCtx());
    await s.put(record({ correlationId: "req:2", surface: "app" }), stubStoreCtx());
    expect((await s.list({ surface: "mcp" }, stubStoreCtx())).map((r) => r.correlationId)).toEqual([
      "req:1",
    ]);
    expect(await s.list({ class: "elicit" }, stubStoreCtx())).toHaveLength(2);
    expect(await s.list({ principal: "acme/u-1" }, stubStoreCtx())).toHaveLength(2);
    expect(await s.list({ principal: "nobody" }, stubStoreCtx())).toHaveLength(0);
  });

  it("delete is idempotent", async () => {
    const s = store();
    await s.put(record(), stubStoreCtx());
    await s.delete("req:1", stubStoreCtx());
    expect(await s.get("req:1", stubStoreCtx())).toBeUndefined();
    await s.delete("req:1", stubStoreCtx());
  });

  it("prune GCs records past their expiresAt cutoff and keeps the rest", async () => {
    const s = store();
    await s.put(record({ correlationId: "old", expiresAt: 500 }), stubStoreCtx());
    await s.put(record({ correlationId: "fresh", expiresAt: 5_000 }), stubStoreCtx());
    await s.put(record({ correlationId: "eternal" }), stubStoreCtx());
    await s.prune!(1_000, stubStoreCtx());
    expect((await s.list(undefined, stubStoreCtx())).map((r) => r.correlationId).sort()).toEqual([
      "eternal",
      "fresh",
    ]);
  });

  it("pendingRequestKey keys on correlationId", () => {
    expect(pendingRequestKey(record({ correlationId: "req:x" }))).toBe("req:x");
  });
});
