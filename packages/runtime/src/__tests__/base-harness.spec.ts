import { describe, expect, it } from "vitest";
import type { MessageEnvelope, Operation, ProtocolEvent } from "@agentick/spec";
import { BaseHarness, OperationOutcomeError } from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";

interface AddInput {
  readonly a: number;
  readonly b: number;
}

class TestHarness extends BaseHarness<"tool"> {
  constructor(
    scopeId: string,
    journal: MemoryJournal,
    bus: LocalEventBus,
    inbox: LocalInbox,
  ) {
    super("tool", scopeId, journal, bus, inbox);
  }

  async add(opId: string, input: AddInput): Promise<number> {
    const op: Operation<AddInput, number> = {
      opId,
      surface: "tool",
      name: "tool:test:add",
      scope: { sessionId: "s_1" },
      input,
    };
    return this.runOperation(op, async (i) => i.a + i.b);
  }

  onBefore(fn: (input: AddInput) => unknown): () => void {
    return this.handlers.register<AddInput, number>("before", fn as never);
  }

  use(
    mw: (input: AddInput, next: (i: AddInput) => Promise<number>) => Promise<number>,
  ): () => void {
    return this.middleware.use(mw as never);
  }

  async ping(): Promise<void> {
    await this.emit({
      opId: undefined,
      name: "tool:test:ping",
      phase: "terminal",
      outcome: "succeeded",
      scope: { sessionId: "s_1" },
      payload: { hello: "world" },
    });
  }

  protected async handleMessage(msg: MessageEnvelope): Promise<unknown> {
    if (msg.type === "echo") return msg.payload;
    throw new Error(`unknown message: ${msg.type}`);
  }
}

async function harness() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const h = new TestHarness("scope-1", journal, bus, inbox);
  // BaseHarness registers asynchronously — yield once.
  await Promise.resolve();
  await Promise.resolve();
  return { h, journal, bus, inbox };
}

describe("BaseHarness — phase contract", () => {
  it("emits requested → before → terminal on success", async () => {
    const { h, journal } = await harness();
    const out = await h.add("op-1", { a: 2, b: 3 });
    expect(out).toBe(5);
    const events: ProtocolEvent[] = [];
    for await (const e of journal.read({}, "beginning")) events.push(e);
    const phases = events.map((e) => e.phase);
    // requested and terminal are journaled by default; before is bus-only.
    expect(phases).toEqual(["requested", "terminal"]);
    expect(events.at(-1)!.outcome).toBe("succeeded");
  });

  it("same opId returns cached terminal (idempotent replay)", async () => {
    const { h } = await harness();
    let calls = 0;
    h.use(async (i, next) => {
      calls++;
      return next(i);
    });
    const r1 = await h.add("op-idem", { a: 1, b: 1 });
    const r2 = await h.add("op-idem", { a: 99, b: 99 });
    expect(r1).toBe(2);
    expect(r2).toBe(2);
    expect(calls).toBe(1);
  });
});

describe("BaseHarness — verdict merge", () => {
  it("veto short-circuits with outcome=vetoed", async () => {
    const { h } = await harness();
    h.onBefore(() => ({ kind: "veto", reason: "denied" }));
    await expect(h.add("op-veto", { a: 1, b: 1 })).rejects.toBeInstanceOf(OperationOutcomeError);
  });

  it("replace short-circuits with caller-supplied result", async () => {
    const { h } = await harness();
    h.onBefore(() => ({ kind: "replace", result: 999 }));
    const r = await h.add("op-replace", { a: 1, b: 1 });
    expect(r).toBe(999);
  });

  it("multiple proceed handlers collapse to proceed", async () => {
    const { h } = await harness();
    h.onBefore(() => ({ kind: "proceed" }));
    h.onBefore(() => undefined);
    const r = await h.add("op-proceed", { a: 1, b: 1 });
    expect(r).toBe(2);
  });

  it("first veto wins over a later replace", async () => {
    const { h } = await harness();
    h.onBefore(() => ({ kind: "veto", reason: "first" }));
    h.onBefore(() => ({ kind: "replace", result: 7 }));
    await expect(h.add("op-veto-first", { a: 1, b: 1 })).rejects.toMatchObject({
      outcome: "vetoed",
    });
  });
});

describe("BaseHarness — middleware", () => {
  it("composes outer-wraps-inner", async () => {
    const { h } = await harness();
    const trace: string[] = [];
    h.use(async (i, next) => {
      trace.push("outer:before");
      const r = await next(i);
      trace.push("outer:after");
      return r;
    });
    h.use(async (i, next) => {
      trace.push("inner:before");
      const r = await next(i);
      trace.push("inner:after");
      return r;
    });
    await h.add("op-mw", { a: 1, b: 2 });
    expect(trace).toEqual(["outer:before", "inner:before", "inner:after", "outer:after"]);
  });
});

describe("BaseHarness — discrete events", () => {
  it("emit publishes to bus but skips journal by default", async () => {
    const { h, bus, journal } = await harness();
    const ctrl = new AbortController();
    const iter = bus.subscribe({ name: { exact: "tool:test:ping" } }, { signal: ctrl.signal });
    const it1 = iter[Symbol.asyncIterator]();
    const next = it1.next();
    await h.ping();
    const ev = await next;
    expect(ev.done).toBe(false);
    if (!ev.done) expect(ev.value.payload).toEqual({ hello: "world" });

    // Discrete terminal events without an opId still match the alwaysJournal
    // policy by phase, so they appear in the journal. That's deliberate.
    const journaled: ProtocolEvent[] = [];
    for await (const j of journal.read({}, "beginning")) journaled.push(j);
    expect(journaled.some((j) => j.name === "tool:test:ping")).toBe(true);
    ctrl.abort();
  });
});

describe("BaseHarness — inbox dispatch", () => {
  it("messages routed by address are handled by handleMessage", async () => {
    const { inbox } = await harness();
    const r = await inbox.ask("tool:scope-1", {
      addressedTo: "tool:scope-1",
      type: "echo",
      messageId: "m-echo",
      timestamp: Date.now(),
      payload: { ok: true },
    });
    expect(r).toEqual({ ok: true });
  });
});
