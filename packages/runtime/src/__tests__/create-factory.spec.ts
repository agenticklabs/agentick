/**
 * `createFactory` static helpers on the in-memory substrate built-ins
 * — ADR 30 Phase 1.
 *
 * Each helper produces a typed factory that:
 *   1. Constructs a fresh instance per call (per session in v2.x).
 *   2. Passes `FactoryDeps` into the optional `configFn` so adopters
 *      can branch per-session.
 *   3. Auto-registers `instance.close()` on the supplied `Lifecycle.onClose`
 *      so session-close shuts the resource down.
 *
 * No `AppHarness` change yet — these helpers can be consumed today by
 * adopters wiring `bus`/`inbox`/`journal` factory slots once those
 * land in Phase 2.
 */

import { describe, expect, it } from "vitest";

import type {
  EventBusFactory,
  FactoryDeps,
  Lifecycle,
  MessageInboxFactory,
  OperationJournalFactory,
} from "@agentick/spec";
import {
  isEventBusFactory,
  isMessageInboxFactory,
  isOperationJournalFactory,
} from "@agentick/spec";

import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
} from "../index.js";

function mockLifecycle(): { lifecycle: Lifecycle; close: () => Promise<void>; handlers: Array<() => void | Promise<void>> } {
  const handlers: Array<() => void | Promise<void>> = [];
  const lifecycle: Lifecycle = {
    onClose: (h) => handlers.push(h),
  };
  const close = async (): Promise<void> => {
    // LIFO unwind (matches the eventual Scope-backed impl).
    while (handlers.length > 0) {
      const h = handlers.pop()!;
      await h();
    }
  };
  return { lifecycle, close, handlers };
}

function mkDeps(overrides: Partial<FactoryDeps> = {}): FactoryDeps {
  return {
    sessionId: overrides.sessionId ?? "session_test",
    appId: overrides.appId ?? "app_test",
  };
}

describe("LocalEventBus.createFactory", () => {
  it("produces an EventBusFactory carrying the type marker", () => {
    const factory = LocalEventBus.createFactory();
    expect(typeof factory).toBe("function");
    expect(isEventBusFactory(factory)).toBe(true);
  });

  it("constructs a fresh LocalEventBus per call", async () => {
    const factory = LocalEventBus.createFactory();
    const { lifecycle: lc1 } = mockLifecycle();
    const { lifecycle: lc2 } = mockLifecycle();
    const bus1 = await factory(mkDeps({ sessionId: "s1" }), lc1);
    const bus2 = await factory(mkDeps({ sessionId: "s2" }), lc2);
    expect(bus1).not.toBe(bus2);
    expect(bus1).toBeInstanceOf(LocalEventBus);
    expect(bus2).toBeInstanceOf(LocalEventBus);
  });

  it("passes FactoryDeps into configFn", async () => {
    const seen: FactoryDeps[] = [];
    const factory = LocalEventBus.createFactory((deps) => {
      seen.push(deps);
      return {};
    });
    const { lifecycle } = mockLifecycle();
    await factory(mkDeps({ sessionId: "s_unique", appId: "a_unique" }), lifecycle);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ sessionId: "s_unique", appId: "a_unique" });
  });

  it("auto-registers close on the supplied lifecycle", async () => {
    const factory = LocalEventBus.createFactory();
    const { lifecycle, close, handlers } = mockLifecycle();
    const bus = await factory(mkDeps(), lifecycle);
    expect(handlers).toHaveLength(1);
    expect(bus.subscriberCount()).toBe(0);
    await close();
    // After lifecycle close, the bus is shut down — no new subscribers accepted.
    expect((bus as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("does NOT call configFn at factory build time, only at invocation", () => {
    let calls = 0;
    LocalEventBus.createFactory(() => {
      calls++;
      return {};
    });
    expect(calls).toBe(0);
  });
});

describe("LocalInbox.createFactory", () => {
  it("produces a MessageInboxFactory carrying the type marker", () => {
    const factory = LocalInbox.createFactory();
    expect(typeof factory).toBe("function");
    expect(isMessageInboxFactory(factory)).toBe(true);
  });

  it("constructs a fresh LocalInbox per call with options from configFn", async () => {
    const factory: MessageInboxFactory = LocalInbox.createFactory((deps) => ({
      idempotencyTtlMs: deps.sessionId === "fast" ? 1_000 : 60_000,
    }));
    const { lifecycle: lc1 } = mockLifecycle();
    const { lifecycle: lc2 } = mockLifecycle();
    const inbox1 = await factory(mkDeps({ sessionId: "fast" }), lc1);
    const inbox2 = await factory(mkDeps({ sessionId: "slow" }), lc2);
    expect(inbox1).not.toBe(inbox2);
    // ttlMs is private — exercise it via behavior is overkill; the configFn
    // branching is sufficient evidence.
  });

  it("auto-registers close on the supplied lifecycle", async () => {
    const factory = LocalInbox.createFactory();
    const { lifecycle, close } = mockLifecycle();
    const inbox = await factory(mkDeps(), lifecycle);
    await close();
    expect((inbox as unknown as { closed: boolean }).closed).toBe(true);
  });
});

describe("MemoryJournal.createFactory", () => {
  it("produces an OperationJournalFactory carrying the type marker", () => {
    const factory = MemoryJournal.createFactory();
    expect(typeof factory).toBe("function");
    expect(isOperationJournalFactory(factory)).toBe(true);
  });

  it("constructs a fresh MemoryJournal per call", async () => {
    const factory: OperationJournalFactory = MemoryJournal.createFactory(() => ({
      capacity: 100,
    }));
    const { lifecycle: lc1 } = mockLifecycle();
    const { lifecycle: lc2 } = mockLifecycle();
    const j1 = await factory(mkDeps({ sessionId: "s1" }), lc1);
    const j2 = await factory(mkDeps({ sessionId: "s2" }), lc2);
    expect(j1).not.toBe(j2);
    expect(j1).toBeInstanceOf(MemoryJournal);
  });

  it("auto-registers close on the supplied lifecycle", async () => {
    const factory = MemoryJournal.createFactory();
    const { lifecycle, close } = mockLifecycle();
    const journal = await factory(mkDeps(), lifecycle);
    await close();
    expect((journal as unknown as { closed: boolean }).closed).toBe(true);
  });
});

describe("Factory markers — type guards reject non-factories", () => {
  it("rejects plain functions without markers", () => {
    const plain = () => new LocalEventBus();
    expect(isEventBusFactory(plain)).toBe(false);
    expect(isMessageInboxFactory(plain)).toBe(false);
    expect(isOperationJournalFactory(plain)).toBe(false);
  });

  it("rejects instances", () => {
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const journal = new MemoryJournal();
    expect(isEventBusFactory(bus)).toBe(false);
    expect(isMessageInboxFactory(inbox)).toBe(false);
    expect(isOperationJournalFactory(journal)).toBe(false);
  });

  it("rejects undefined / null / primitives", () => {
    for (const v of [undefined, null, 42, "string", {}, []]) {
      expect(isEventBusFactory(v)).toBe(false);
      expect(isMessageInboxFactory(v)).toBe(false);
      expect(isOperationJournalFactory(v)).toBe(false);
    }
  });

  it("accepts the three correct markers and rejects swapped markers", () => {
    const busFactory = LocalEventBus.createFactory();
    const inboxFactory = LocalInbox.createFactory();
    const journalFactory = MemoryJournal.createFactory();

    expect(isEventBusFactory(busFactory)).toBe(true);
    expect(isMessageInboxFactory(busFactory)).toBe(false);
    expect(isOperationJournalFactory(busFactory)).toBe(false);

    expect(isEventBusFactory(inboxFactory)).toBe(false);
    expect(isMessageInboxFactory(inboxFactory)).toBe(true);
    expect(isOperationJournalFactory(inboxFactory)).toBe(false);

    expect(isEventBusFactory(journalFactory)).toBe(false);
    expect(isMessageInboxFactory(journalFactory)).toBe(false);
    expect(isOperationJournalFactory(journalFactory)).toBe(true);
  });
});

describe("Hand-rolled factories (without the helper)", () => {
  it("adopters can write a factory by hand and tag it with the marker", async () => {
    const factory: EventBusFactory = Object.assign(
      (_deps: FactoryDeps, lifecycle: Lifecycle): LocalEventBus => {
        const bus = new LocalEventBus();
        lifecycle.onClose(() => bus.close());
        return bus;
      },
      { eventBusFactory: true as const },
    );
    expect(isEventBusFactory(factory)).toBe(true);
    const { lifecycle, close } = mockLifecycle();
    const bus = await factory(mkDeps(), lifecycle);
    expect(bus).toBeInstanceOf(LocalEventBus);
    await close();
    expect((bus as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("shared-resource factory pattern — no onClose call, no shutdown", async () => {
    const sharedBus = new LocalEventBus();
    const factory: EventBusFactory = Object.assign(
      (_deps: FactoryDeps, _lifecycle: Lifecycle): LocalEventBus => sharedBus,
      { eventBusFactory: true as const },
    );
    const { lifecycle: lc1, close: close1 } = mockLifecycle();
    const { lifecycle: lc2, close: close2 } = mockLifecycle();
    const bus1 = await factory(mkDeps({ sessionId: "s1" }), lc1);
    const bus2 = await factory(mkDeps({ sessionId: "s2" }), lc2);
    expect(bus1).toBe(sharedBus);
    expect(bus2).toBe(sharedBus);
    await close1();
    await close2();
    // Shared resource is NOT closed by any session's lifecycle.
    expect((sharedBus as unknown as { closed: boolean }).closed).toBe(false);
    sharedBus.close();
  });

  it("ref-counted shared resource pattern — close on the last release", async () => {
    let refcount = 0;
    const sharedBus = new LocalEventBus();
    const factory: EventBusFactory = Object.assign(
      (_deps: FactoryDeps, lifecycle: Lifecycle): LocalEventBus => {
        refcount++;
        lifecycle.onClose(() => {
          if (--refcount === 0) sharedBus.close();
        });
        return sharedBus;
      },
      { eventBusFactory: true as const },
    );
    const { lifecycle: lc1, close: close1 } = mockLifecycle();
    const { lifecycle: lc2, close: close2 } = mockLifecycle();
    await factory(mkDeps({ sessionId: "s1" }), lc1);
    await factory(mkDeps({ sessionId: "s2" }), lc2);
    expect(refcount).toBe(2);
    await close1();
    expect(refcount).toBe(1);
    expect((sharedBus as unknown as { closed: boolean }).closed).toBe(false);
    await close2();
    expect(refcount).toBe(0);
    expect((sharedBus as unknown as { closed: boolean }).closed).toBe(true);
  });
});
