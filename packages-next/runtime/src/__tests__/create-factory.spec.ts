/**
 * `createFactory` static helpers on the in-memory substrate built-ins
 * — ADR 31 Phase 1'.
 *
 * Each helper produces a typed factory that:
 *   1. Constructs a fresh instance per call (per child in the hierarchy).
 *   2. Takes the parent harness as a single argument: `(parent) => R`.
 *   3. Auto-registers `instance.close()` on the parent's `onClose`
 *      so close cascades naturally.
 *   4. For bus + journal: when the parent has a corresponding
 *      substrate field, the factory wraps it (fan-in writes / isolated
 *      reads). Inbox does NOT compose with a parent inbox (addressing
 *      semantics make fan-in actively wrong).
 */

import { Effect, Stream, Chunk } from "effect";
import { describe, expect, it } from "vitest";

import type {
  EventBus,
  EventBusFactory,
  MessageInbox,
  OperationJournal,
  ProtocolEvent,
} from "@agentick/spec-next";

import { drainRejection } from "@agentick/utils-next/testing";

import { LocalEventBus, LocalInbox, MemoryJournal } from "../index.js";
import { omitUndefined } from "@agentick/utils-next";

interface MockParent {
  readonly id: string;
  readonly bus?: EventBus;
  readonly inbox?: MessageInbox;
  readonly journal?: OperationJournal;
  onClose(handler: () => void | Promise<void>): void;
}

function mockParent(overrides: Partial<MockParent> = {}): {
  parent: MockParent;
  close: () => Promise<void>;
  handlers: Array<() => void | Promise<void>>;
} {
  const handlers: Array<() => void | Promise<void>> = [];
  const parent: MockParent = {
    id: overrides.id ?? "parent_test",
    ...omitUndefined({ bus: overrides.bus, inbox: overrides.inbox, journal: overrides.journal }),
    onClose: (h) => handlers.push(h),
  };
  const close = async (): Promise<void> => {
    // LIFO unwind (matches the eventual Scope-backed impl).
    while (handlers.length > 0) {
      const h = handlers.pop()!;
      await h();
    }
  };
  return { parent, close, handlers };
}

function mkEvent(overrides: Partial<ProtocolEvent> = {}): ProtocolEvent {
  return {
    id: "ev_1",
    surface: "tool",
    phase: "delta",
    name: "tool:bench",
    timestamp: 1,
    scope: {},
    ...overrides,
  } as ProtocolEvent;
}

// ============================================================================
// LocalEventBus.createFactory
// ============================================================================

describe("LocalEventBus.createFactory", () => {
  it("is callable with (parent) and returns a fresh bus per call", async () => {
    const factory = LocalEventBus.createFactory();
    const { parent: p1 } = mockParent();
    const { parent: p2 } = mockParent();
    const b1 = await factory(p1);
    const b2 = await factory(p2);
    expect(b1).not.toBe(b2);
    expect(b1).toBeInstanceOf(LocalEventBus);
  });

  it("passes parent to configFn", async () => {
    const seen: MockParent[] = [];
    const factory = LocalEventBus.createFactory<MockParent>((parent) => {
      seen.push(parent);
      return {};
    });
    const { parent } = mockParent({ id: "unique_parent" });
    await factory(parent);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe("unique_parent");
  });

  it("auto-registers close on the parent's onClose", async () => {
    const factory = LocalEventBus.createFactory();
    const { parent, close, handlers } = mockParent();
    const bus = (await factory(parent)) as EventBus;
    expect(handlers).toHaveLength(1);
    await close();
    expect((bus as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("default factory wires parent.bus as upstream (fan-in writes)", async () => {
    const upstream = new LocalEventBus();
    const factory = LocalEventBus.createFactory();
    const { parent } = mockParent({ bus: upstream });
    const localBus = (await factory(parent)) as EventBus;

    // Subscribe to upstream — should see local publishes via fan-in.
    const upstreamFiber = Effect.runFork(
      Stream.runCollect(Stream.take(upstream.subscribe({ surface: "tool" }), 1)),
    );
    await new Promise((r) => setImmediate(r));

    await Effect.runPromise(localBus.append(mkEvent()));

    const seenChunk = await Effect.runPromise(
      Effect.timeout(
        Effect.flatMap(Effect.scoped(Effect.succeed(undefined)), () =>
          Effect.fromFiber(upstreamFiber),
        ),
        "1 seconds",
      ),
    );
    expect(Chunk.toReadonlyArray(seenChunk).length).toBe(1);
  });

  it("local subscribers see only local events (isolated reads — not parent writes)", async () => {
    const upstream = new LocalEventBus();
    const factory = LocalEventBus.createFactory();
    const { parent } = mockParent({ bus: upstream });
    const localBus = (await factory(parent)) as EventBus;

    // Subscribe locally + publish on upstream — local subscriber must NOT see it.
    const localSeen: ProtocolEvent[] = [];
    const localFiber = Effect.runFork(
      Stream.runForEach(localBus.subscribe({ surface: "tool" }), (e) =>
        Effect.sync(() => {
          localSeen.push(e);
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));

    await Effect.runPromise(upstream.append(mkEvent({ id: "from_upstream" })));
    // Yield to give subscribers a chance.
    await new Promise((r) => setImmediate(r));

    expect(localSeen).toHaveLength(0);

    await drainRejection(
      Effect.runPromise(
        Effect.runPromise(Effect.exit(Effect.fromFiber(localFiber)))
          .then(() => Promise.resolve())
          .catch(() => Promise.resolve()) as unknown as Effect.Effect<unknown, never, never>,
      ),
    );
    // best-effort cleanup; test is async
  });

  it("explicit { parent: undefined } in configFn produces a leaf bus (no fan-in)", async () => {
    const upstream = new LocalEventBus();
    const factory = LocalEventBus.createFactory<MockParent>(() => ({ parent: undefined }));
    const { parent } = mockParent({ bus: upstream });
    const localBus = (await factory(parent)) as EventBus;

    // Publish locally; upstream MUST NOT see it.
    const upstreamSeen: ProtocolEvent[] = [];
    const upstreamFiber = Effect.runFork(
      Stream.runForEach(upstream.subscribe({ surface: "tool" }), (e) =>
        Effect.sync(() => {
          upstreamSeen.push(e);
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));

    await Effect.runPromise(localBus.append(mkEvent()));
    await new Promise((r) => setImmediate(r));

    expect(upstreamSeen).toHaveLength(0);
    void upstreamFiber;
  });
});

// ============================================================================
// LocalInbox.createFactory
// ============================================================================

describe("LocalInbox.createFactory", () => {
  it("returns a factory that constructs a fresh LocalInbox per call", async () => {
    const factory = LocalInbox.createFactory();
    const { parent: p1 } = mockParent();
    const { parent: p2 } = mockParent();
    const i1 = await factory(p1);
    const i2 = await factory(p2);
    expect(i1).not.toBe(i2);
    expect(i1).toBeInstanceOf(LocalInbox);
  });

  it("configFn receives parent + returns LocalInboxOptions", async () => {
    let seenParentId = "";
    const factory = LocalInbox.createFactory<MockParent>((parent) => {
      seenParentId = parent.id;
      return { idempotencyTtlMs: 1_000 };
    });
    const { parent } = mockParent({ id: "p_test" });
    await factory(parent);
    expect(seenParentId).toBe("p_test");
  });

  it("auto-registers close on the parent's onClose", async () => {
    const factory = LocalInbox.createFactory();
    const { parent, close } = mockParent();
    const inbox = (await factory(parent)) as MessageInbox;
    await close();
    expect((inbox as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("does NOT compose with parent.inbox — fully isolated", async () => {
    // Even when parent has an inbox, the factory does not wire any
    // upstream relationship. Inboxes are addressable; fan-in would
    // misroute messages.
    const parentInbox = new LocalInbox();
    const factory = LocalInbox.createFactory();
    const { parent } = mockParent({ inbox: parentInbox });
    const inbox = (await factory(parent)) as MessageInbox;
    // The new inbox is its own thing — register, send, observe.
    let handlerHit = 0;
    await Effect.runPromise(
      inbox.register("local:addr", () =>
        Effect.sync(() => {
          handlerHit++;
        }),
      ),
    );
    await Effect.runPromise(inbox.send("local:addr", { type: "ping", messageId: "m1" }));
    expect(handlerHit).toBe(1);

    // Parent inbox should NOT have received anything.
    let parentHit = 0;
    await Effect.runPromise(
      parentInbox.register("local:addr", () =>
        Effect.sync(() => {
          parentHit++;
        }),
      ),
    );
    await Effect.runPromise(inbox.send("local:addr", { type: "ping", messageId: "m2" }));
    expect(parentHit).toBe(0);
    expect(handlerHit).toBe(2);
  });
});

// ============================================================================
// MemoryJournal.createFactory
// ============================================================================

describe("MemoryJournal.createFactory", () => {
  it("returns a factory that constructs a fresh MemoryJournal per call", async () => {
    const factory = MemoryJournal.createFactory();
    const { parent: p1 } = mockParent();
    const { parent: p2 } = mockParent();
    const j1 = await factory(p1);
    const j2 = await factory(p2);
    expect(j1).not.toBe(j2);
    expect(j1).toBeInstanceOf(MemoryJournal);
  });

  it("configFn receives parent + returns MemoryJournalOptions", async () => {
    const factory = MemoryJournal.createFactory<MockParent>((parent) => ({
      capacity: parent.id === "big" ? 100_000 : 100,
    }));
    const { parent: pBig } = mockParent({ id: "big" });
    const { parent: pSmall } = mockParent({ id: "small" });
    const j1 = await factory(pBig);
    const j2 = await factory(pSmall);
    expect(j1).not.toBe(j2);
  });

  it("auto-registers close on the parent's onClose", async () => {
    const factory = MemoryJournal.createFactory();
    const { parent, close } = mockParent();
    const journal = (await factory(parent)) as OperationJournal;
    await close();
    expect((journal as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("default factory wires parent.journal as upstream (fan-in appends)", async () => {
    const upstream = new MemoryJournal({ capacity: 100 });
    const factory = MemoryJournal.createFactory();
    const { parent } = mockParent({ journal: upstream });
    const localJournal = (await factory(parent)) as OperationJournal;

    const event = mkEvent({ opId: "op-1", phase: "requested" });
    await Effect.runPromise(localJournal.append(event));

    // Upstream should see the event too.
    const upstreamEvents = await Effect.runPromise(
      Stream.runCollect(upstream.readByQuery({}, "beginning")),
    );
    expect(Chunk.toReadonlyArray(upstreamEvents).length).toBe(1);

    // Local journal also has it.
    const localEvents = await Effect.runPromise(
      Stream.runCollect(localJournal.readByQuery({}, "beginning")),
    );
    expect(Chunk.toReadonlyArray(localEvents).length).toBe(1);
  });

  it("explicit { parent: undefined } produces a leaf journal", async () => {
    const upstream = new MemoryJournal();
    const factory = MemoryJournal.createFactory<MockParent>(() => ({ parent: undefined }));
    const { parent } = mockParent({ journal: upstream });
    const localJournal = (await factory(parent)) as OperationJournal;

    await Effect.runPromise(localJournal.append(mkEvent({ opId: "op-x", phase: "requested" })));

    const upstreamEvents = await Effect.runPromise(
      Stream.runCollect(upstream.readByQuery({}, "beginning")),
    );
    expect(Chunk.toReadonlyArray(upstreamEvents).length).toBe(0);
  });
});

// ============================================================================
// Hand-rolled factories (without the static helper) — verify the
// adopter-facing factory shape still works the same way.
// ============================================================================

describe("Hand-rolled factories", () => {
  it("adopter can write a factory by hand using (parent) => R", async () => {
    const factory: EventBusFactory<MockParent> = (parent) => {
      const bus = new LocalEventBus({ parent: parent.bus });
      parent.onClose(() => bus.close());
      return bus;
    };
    const { parent, close } = mockParent();
    const bus = (await factory(parent)) as EventBus;
    expect(bus).toBeInstanceOf(LocalEventBus);
    await close();
    expect((bus as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("shared-instance pattern: factory returns the same instance, no close registered", async () => {
    const sharedBus = new LocalEventBus();
    const factory: EventBusFactory<MockParent> = () => sharedBus;
    const { parent: p1, close: close1 } = mockParent();
    const { parent: p2, close: close2 } = mockParent();
    const b1 = await factory(p1);
    const b2 = await factory(p2);
    expect(b1).toBe(sharedBus);
    expect(b2).toBe(sharedBus);
    await close1();
    await close2();
    expect((sharedBus as unknown as { closed: boolean }).closed).toBe(false);
    sharedBus.close();
  });

  it("ref-counted shared resource pattern via factory closure", async () => {
    let refcount = 0;
    const sharedBus = new LocalEventBus();
    const factory: EventBusFactory<MockParent> = (parent) => {
      refcount++;
      parent.onClose(() => {
        if (--refcount === 0) sharedBus.close();
      });
      return sharedBus;
    };
    const { parent: p1, close: close1 } = mockParent();
    const { parent: p2, close: close2 } = mockParent();
    await factory(p1);
    await factory(p2);
    expect(refcount).toBe(2);
    await close1();
    expect(refcount).toBe(1);
    expect((sharedBus as unknown as { closed: boolean }).closed).toBe(false);
    await close2();
    expect(refcount).toBe(0);
    expect((sharedBus as unknown as { closed: boolean }).closed).toBe(true);
  });

  it('typeof slot === "function" cleanly distinguishes instance from factory', () => {
    const instance = new LocalEventBus();
    const factory: EventBusFactory<MockParent> = () => new LocalEventBus();
    expect(typeof instance).toBe("object");
    expect(typeof factory).toBe("function");
  });
});

// ============================================================================
// Factory type signature accepts Effect-typed factories too
// ============================================================================

describe("Factory<R, P> accepts Effect returns", () => {
  it("compiles when factory returns Effect", () => {
    // Compile-time only — verify the type accepts an Effect return.
    const factory: EventBusFactory<MockParent> = (parent) =>
      Effect.gen(function* () {
        const bus = new LocalEventBus();
        parent.onClose(() => bus.close());
        return bus;
      });
    expect(typeof factory).toBe("function");
  });
});
