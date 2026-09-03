/**
 * BaseHarness durable-suspension capability (input-required, increment 2).
 *
 * Exercised at the BaseHarness level with a minimal test subclass — no App /
 * Session / MCP. Proves the store-driven upgrade to `request`/`resume`:
 *   - the `pendingStore` slot defaults to an in-memory `MemoryCollection`;
 *   - a `durable` request persists a `PendingRequestRecord` while in flight and
 *     evicts it on settle;
 *   - a transient request persists nothing (fast path only);
 *   - `resume` resolves a live parked fiber (same process);
 *   - the RECYCLE proof: a record persisted by one harness is resumed by a
 *     FRESH harness sharing the store (no live fiber) via the slow path, and a
 *     second resume is rejected as already-consumed;
 *   - an unknown id resolves to not-found.
 */

import { describe, expect, it } from "vitest";

import type {
  MessageEnvelope,
  MessageHandlerError,
  PendingRequestStore,
  StoreCtx,
} from "@agentick/spec";
import { Effect, Fiber } from "effect";

import { BaseHarness, type ResumeOutcome } from "../substrate/base-harness.js";
import { createInMemoryPendingRequestStore } from "../substrate/pending-request-store-memory.js";
import { createRequestStateCodec } from "../substrate/request-state-codec.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";

class DurableTestHarness extends BaseHarness<"tool"> {
  constructor(scopeId: string, options: ConstructorParameters<typeof BaseHarness>[5] = {}) {
    super("tool", scopeId, new MemoryJournal(), new LocalEventBus(), new LocalInbox(), options);
  }

  get _store(): PendingRequestStore {
    return this.pendingStore;
  }
  get _ctx(): StoreCtx {
    return this.storeCtx();
  }

  askDurable(question: string, ttlMs?: number): Effect.Effect<string, unknown, never> {
    return this.request<string, string>("elicit", question, {
      durable: {
        class: "elicit",
        lineage: [{ scopeId: "session:s", principal: "acme/u" }],
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      },
    });
  }
  askTransient(question: string): Effect.Effect<string, unknown, never> {
    return this.request<string, string>("elicit", question, {});
  }
  resumePublic(correlationId: string, response: unknown): Promise<ResumeOutcome> {
    return this.resume(correlationId, response);
  }
  mintPublic(correlationId: string): Promise<string | undefined> {
    return this.mintRequestState(correlationId);
  }
  resumeStatePublic(
    requestState: string,
    response: unknown,
    opts?: { readonly principal?: string },
  ): Promise<ResumeOutcome> {
    return this.resumeWithState(requestState, response, opts);
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.succeed(undefined);
  }
}

async function firstRecordId(store: PendingRequestStore, ctx: StoreCtx): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const all = await store.list(undefined, ctx);
    if (all.length > 0) return all[0]!.correlationId;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("durable record was never persisted");
}

describe("BaseHarness pendingStore slot", () => {
  it("defaults to an in-memory MemoryCollection", async () => {
    const h = new DurableTestHarness("d-default");
    await h.ready;
    expect(h._store.backend).toBe("memory");
    await h.close();
  });

  it("honors an injected store instance (the override path)", async () => {
    const injected = createInMemoryPendingRequestStore();
    const h = new DurableTestHarness("d-inject", { pendingStore: injected });
    await h.ready;
    expect(h._store).toBe(injected);
    await h.close();
  });
});

describe("BaseHarness durable request — persist + fast-path resume", () => {
  it("persists a record while in flight, resolves the live fiber, then evicts it", async () => {
    const h = new DurableTestHarness("d-fast");
    await h.ready;

    const fiber = Effect.runFork(h.askDurable("delete project 42?"));
    const id = await firstRecordId(h._store, h._ctx);

    const record = await h._store.get(id, h._ctx);
    expect(record?.surface).toBe("tool");
    expect(record?.payload.class).toBe("elicit");
    expect(record?.payload.request).toBe("delete project 42?");
    expect(record?.payload.lineage?.[0]?.principal).toBe("acme/u");
    expect(record?.round).toBe(0);

    const outcome = await h.resumePublic(id, "accept");
    expect(outcome.status).toBe("resolved-live");

    const answer = await Effect.runPromise(Fiber.join(fiber));
    expect(answer).toBe("accept");

    // Settled → the ensuring evicted the record.
    expect(await h._store.list(undefined, h._ctx)).toHaveLength(0);
    await h.close();
  });

  it("a transient request persists nothing", async () => {
    const h = new DurableTestHarness("d-transient");
    await h.ready;

    const fiber = Effect.runFork(h.askTransient("no persistence"));
    await new Promise((r) => setTimeout(r, 10));
    expect(await h._store.list(undefined, h._ctx)).toHaveLength(0);

    await Effect.runPromise(Fiber.interrupt(fiber));
    await h.close();
  });
});

describe("BaseHarness durable request — recycle (slow path)", () => {
  it("a fresh harness sharing the store resumes a record with no live fiber, then rejects a replay", async () => {
    const store = createInMemoryPendingRequestStore();

    // Harness A suspends a durable request; the record lands in the shared store.
    const a = new DurableTestHarness("d-recycle", { pendingStore: store });
    await a.ready;
    const aFiber = Effect.runFork(a.askDurable("survive the recycle?"));
    const id = await firstRecordId(store, a._ctx);

    // "Recycle": a brand-new harness (fresh registry, no live Deferred) backed
    // by the SAME durable store — models the request answered on another replica.
    const b = new DurableTestHarness("d-recycle", { pendingStore: store });
    await b.ready;

    const outcome = await b.resumePublic(id, "accept-after-restart");
    expect(outcome.status).toBe("hydrated");
    if (outcome.status === "hydrated") {
      expect(outcome.record.consumedAt).toBeGreaterThan(0);
      expect(outcome.record.responses?.[id]).toBe("accept-after-restart");
      expect(outcome.record.payload.request).toBe("survive the recycle?");
    }

    // Replay of a consumed record is rejected.
    expect((await b.resumePublic(id, "again")).status).toBe("consumed");

    await Effect.runPromise(Fiber.interrupt(aFiber));
    await a.close();
    await b.close();
  });

  it("resume of an unknown id is not-found", async () => {
    const h = new DurableTestHarness("d-unknown");
    await h.ready;
    expect((await h.resumePublic("req:nope", "x")).status).toBe("not-found");
    await h.close();
  });
});

describe("BaseHarness requestState handle (wire binding, increment 3)", () => {
  const codecConfig = { keys: [{ kid: "k1", secret: "0123456789abcdef0123456789abcdef" }] };

  it("mints a sealed handle for a durable record and resumes a fresh harness from it", async () => {
    const store = createInMemoryPendingRequestStore();
    const codec = createRequestStateCodec(codecConfig);

    const a = new DurableTestHarness("d-handle", { pendingStore: store, requestStateCodec: codec });
    await a.ready;
    const aFiber = Effect.runFork(a.askDurable("seal me?"));
    const id = await firstRecordId(store, a._ctx);

    const handle = await a.mintPublic(id);
    expect(typeof handle).toBe("string");
    // Opaque: the untrusted client cannot read the principal/correlationId.
    expect(handle).not.toContain("acme");
    expect(handle).not.toContain(id);

    // A fresh replica sharing the store + codec resumes purely from the echoed handle.
    const b = new DurableTestHarness("d-handle", { pendingStore: store, requestStateCodec: codec });
    await b.ready;
    const outcome = await b.resumeStatePublic(handle!, "accept", { principal: "acme/u" });
    expect(outcome.status).toBe("hydrated");

    await Effect.runPromise(Fiber.interrupt(aFiber));
    await a.close();
    await b.close();
  });

  it("rejects a tampered handle and a principal mismatch as invalid", async () => {
    const store = createInMemoryPendingRequestStore();
    const codec = createRequestStateCodec(codecConfig);
    const h = new DurableTestHarness("d-handle-bad", {
      pendingStore: store,
      requestStateCodec: codec,
    });
    await h.ready;
    const fiber = Effect.runFork(h.askDurable("seal me?"));
    const id = await firstRecordId(store, h._ctx);
    const handle = (await h.mintPublic(id))!;

    const tampered = handle.slice(0, -2) + (handle.slice(-2) === "AA" ? "AB" : "AA");
    expect((await h.resumeStatePublic(tampered, "x")).status).toBe("invalid");
    // Bound to acme/u; a different authenticated principal is refused.
    expect((await h.resumeStatePublic(handle, "x", { principal: "evil/u" })).status).toBe(
      "invalid",
    );
    // The record is untouched — the real principal still resumes.
    expect((await h.resumeStatePublic(handle, "ok", { principal: "acme/u" })).status).toBe(
      "resolved-live",
    );

    await Effect.runPromise(Fiber.interrupt(fiber));
    await h.close();
  });

  it("without a codec, no handle is minted and a handle resume is invalid", async () => {
    const h = new DurableTestHarness("d-no-codec");
    await h.ready;
    const fiber = Effect.runFork(h.askDurable("q"));
    const id = await firstRecordId(h._store, h._ctx);
    expect(await h.mintPublic(id)).toBeUndefined();
    expect((await h.resumeStatePublic("anything", "x")).status).toBe("invalid");
    await Effect.runPromise(Fiber.interrupt(fiber));
    await h.close();
  });
});
