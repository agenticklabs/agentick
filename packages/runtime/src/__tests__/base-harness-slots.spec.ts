/**
 * BaseHarness substrate slot pattern — ADR 31.
 *
 * Substrate-slot resolution (instance | factory for bus/inbox/journal)
 * lives on BaseHarness itself. AppHarness, SessionHarness, and future
 * GatewayHarness all inherit the capability for free; subclasses
 * supply the positional substrate args as defaults and `options.*`
 * overrides apply via the standard resolver.
 *
 * These tests exercise the pattern at the BaseHarness level using a
 * minimal test subclass — they don't depend on App or Session.
 */

import { describe, expect, it } from "vitest";

import type {
  EventBus,
  EventBusFactory,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
} from "@agentick/spec";
import { Effect, Stream } from "effect";

import {
  BaseHarness,
  type HarnessShell,
} from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";

class SlotTestHarness extends BaseHarness<"tool"> {
  constructor(
    scopeId: string,
    defaultJournal: OperationJournal,
    defaultBus: EventBus,
    defaultInbox: MessageInbox,
    options: ConstructorParameters<typeof BaseHarness>[5] = {},
  ) {
    super("tool", scopeId, defaultJournal, defaultBus, defaultInbox, options);
  }

  /** Test accessors so we can verify resolution. */
  get _journal(): OperationJournal {
    return this.journal;
  }
  get _bus(): EventBus {
    return this.bus;
  }
  get _inbox(): MessageInbox {
    return this.inbox;
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.succeed(undefined);
  }
}

describe("BaseHarness substrate slots — default behavior", () => {
  it("uses positional defaults when no slot overrides are supplied", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const h = new SlotTestHarness("slot-test-1", journal, bus, inbox);
    await h.ready;

    expect(h._journal).toBe(journal);
    expect(h._bus).toBe(bus);
    expect(h._inbox).toBe(inbox);

    await h.close();
  });
});

describe("BaseHarness substrate slots — instance overrides", () => {
  it("uses options.{bus,inbox,journal} when they're instances", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();

    const altJournal = new MemoryJournal();
    const altBus = new LocalEventBus();
    const altInbox = new LocalInbox();

    const h = new SlotTestHarness("slot-test-2", journal, bus, inbox, {
      journal: altJournal,
      bus: altBus,
      inbox: altInbox,
    });
    await h.ready;

    // Instance overrides win over positional defaults.
    expect(h._journal).toBe(altJournal);
    expect(h._bus).toBe(altBus);
    expect(h._inbox).toBe(altInbox);
    expect(h._journal).not.toBe(journal);

    await h.close();
  });
});

describe("BaseHarness substrate slots — factory overrides", () => {
  it("calls factory with a HarnessShell exposing the positional defaults", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();

    let seenShell: HarnessShell | undefined;
    const factory: EventBusFactory<HarnessShell> = (parent) => {
      seenShell = parent;
      return new LocalEventBus({ parent: parent.bus });
    };

    const h = new SlotTestHarness("slot-test-3", journal, bus, inbox, {
      metadata: { tag: "ph-3.5" },
      bus: factory,
    });
    await h.ready;

    // Factory saw a shell whose .bus is the positional default.
    expect(seenShell).toBeDefined();
    expect(seenShell!.id).toBe("slot-test-3");
    expect(seenShell!.bus).toBe(bus);
    expect(seenShell!.metadata).toEqual({ tag: "ph-3.5" });
    // Resolved bus is the wrapper (not the original default).
    expect(h._bus).not.toBe(bus);
    expect(h._bus).toBeInstanceOf(LocalEventBus);

    await h.close();
  });

  it("auto-replays factory-registered onClose onto the harness's own close path", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();

    let factoryClosedRan = false;
    const factory: EventBusFactory<HarnessShell> = (parent) => {
      const ownBus = new LocalEventBus();
      parent.onClose(() => {
        factoryClosedRan = true;
        ownBus.close();
      });
      return ownBus;
    };

    const h = new SlotTestHarness("slot-test-4", journal, bus, inbox, {
      bus: factory,
    });
    await h.ready;

    expect(factoryClosedRan).toBe(false);
    await h.close();
    expect(factoryClosedRan).toBe(true);
  });

  it("LocalEventBus.factory() default fan-in to positional default bus", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();

    const h = new SlotTestHarness("slot-test-5", journal, bus, inbox, {
      bus: LocalEventBus.factory(),
    });
    await h.ready;

    // The harness's bus is a fresh LocalEventBus wrapping the positional default.
    expect(h._bus).not.toBe(bus);
    expect(h._bus).toBeInstanceOf(LocalEventBus);

    // Publish on harness's bus → flows up to the positional default.
    const upstreamSeen: string[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(bus.subscribe({ surface: "tool" }), (e) =>
        Effect.sync(() => {
          upstreamSeen.push(e.name);
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));

    await Effect.runPromise(
      h._bus.publish({
        id: "ev_1",
        surface: "tool",
        phase: "delta",
        name: "tool:slot-test",
        timestamp: Date.now(),
        scope: {},
      } as never),
    );
    await new Promise((r) => setImmediate(r));

    expect(upstreamSeen).toContain("tool:slot-test");
    void fiber;
    await h.close();
  });

  it("throws when a factory returns a Promise (async at this slot)", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();

    expect(() => {
      new SlotTestHarness("slot-test-6", journal, bus, inbox, {
        bus: ((async () => new LocalEventBus()) as unknown) as EventBusFactory<HarnessShell>,
      });
    }).toThrow(/synchronous/);
  });
});
