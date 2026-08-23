/**
 * BaseHarness principal — the identity axis of construction identity
 * (ADR 48), the twin of `scopeId`. One optional field, bound at
 * construction, stamped authoritatively onto emitted event scopes.
 *
 * Proves:
 *   1. `this.principal` is readable by harness implementations (the
 *      hook identity-scoping harnesses use to namespace their stores).
 *   2. A principal-bound harness stamps its principal onto every event
 *      it emits.
 *   3. AUTHORITATIVE — an operation carrying a different
 *      `scope.principal` cannot override the harness's; no per-op
 *      identity spoofing (ADR 45).
 *   4. A principal-less harness relays the op scope untouched (no
 *      identity to assert; zero-cost passthrough on the hot path).
 *
 * @see docs/proposals/v2/blueprint/48-layered-isolation.md
 */

import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type {
  EventScope,
  MessageEnvelope,
  MessageHandlerError,
  Operation,
  ProtocolEvent,
} from "@agentick/spec";
import { BaseHarness } from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";

const OP_NAME = "tool:test:run";
const CHANNEL = "elicitation";
const CHANNEL_EVENT = `session:channel:${CHANNEL}`;

class PrincipalTestHarness extends BaseHarness<"tool"> {
  constructor(
    scopeId: string,
    journal: MemoryJournal,
    bus: LocalEventBus,
    inbox: LocalInbox,
    principal?: string,
  ) {
    super("tool", scopeId, journal, bus, inbox, principal !== undefined ? { principal } : {});
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.succeed(undefined);
  }

  /** Expose the protected field so we can assert impls can read it. */
  readPrincipal(): string | undefined {
    return this.principal;
  }

  /** Publish a request frame. The reply never comes; the short bound frees it. */
  async ask(scope?: EventScope): Promise<void> {
    const effect = this.request(CHANNEL, { q: 1 }, { timeoutMs: 5, ...(scope ? { scope } : {}) });
    await Effect.runPromise(Effect.either(effect));
  }

  /** Publish a notify frame — the fire-and-forget twin of {@link ask}. */
  async tell(scope?: EventScope): Promise<void> {
    await Effect.runPromise(this.notifyChannel(CHANNEL, { n: 1 }, scope ? { scope } : {}));
  }

  /** Run a trivial op whose scope optionally carries its OWN principal. */
  async run(opId: string, opScopePrincipal?: string): Promise<void> {
    const op: Operation<undefined, void> = {
      opId,
      surface: "tool",
      name: OP_NAME,
      scope:
        opScopePrincipal !== undefined
          ? { sessionId: "s1", principal: opScopePrincipal }
          : { sessionId: "s1" },
      input: undefined,
    };
    await Effect.runPromise(this.runOperation(op, () => Effect.succeed(undefined)));
  }
}

/** Collect events named OP_NAME from the ring (replay from cursor 0). */
async function principalsOnEvents(bus: LocalEventBus): Promise<(string | undefined)[]> {
  const events = await Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({ name: { exact: OP_NAME } }, { fromCursor: { value: 0 } }),
        // requested + before + terminal for a successful op
        3,
      ),
    ),
  );
  return [...events].map((e: ProtocolEvent) => e.scope.principal);
}

/** Collect the channel frames published on {@link CHANNEL} (replay from cursor 0). */
async function channelFrames(bus: LocalEventBus, count: number): Promise<ProtocolEvent[]> {
  const events = await Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({ name: { exact: CHANNEL_EVENT } }, { fromCursor: { value: 0 } }),
        count,
      ),
    ),
  );
  return [...events];
}

describe("BaseHarness — principal (ADR 48)", () => {
  it("is readable by harness implementations via this.principal", () => {
    const h = new PrincipalTestHarness(
      "h1",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      "acme/user-42",
    );
    expect(h.readPrincipal()).toBe("acme/user-42");
  });

  it("defaults to undefined when unset", () => {
    const h = new PrincipalTestHarness(
      "h2",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    expect(h.readPrincipal()).toBeUndefined();
  });

  it("stamps the harness principal onto every emitted event scope", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const h = new PrincipalTestHarness(
      "h3",
      new MemoryJournal(),
      bus,
      new LocalInbox(),
      "acme/user-42",
    );

    await h.run("op-1");
    const principals = await principalsOnEvents(bus);

    expect(principals.length).toBeGreaterThan(0);
    expect(principals.every((p) => p === "acme/user-42")).toBe(true);
  });

  it("is AUTHORITATIVE — an op cannot override the harness principal", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const h = new PrincipalTestHarness(
      "h4",
      new MemoryJournal(),
      bus,
      new LocalInbox(),
      "harness-principal",
    );

    // The op tries to claim a different principal in its scope.
    await h.run("op-2", "spoofed-principal");
    const principals = await principalsOnEvents(bus);

    expect(principals.length).toBeGreaterThan(0);
    // Harness wins on every event — the op's claim is discarded.
    expect(principals.every((p) => p === "harness-principal")).toBe(true);
    expect(principals).not.toContain("spoofed-principal");
  });

  it("stamps the harness principal onto channel request + notify frames", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const h = new PrincipalTestHarness("h6", new MemoryJournal(), bus, new LocalInbox(), "acme/u1");

    await h.ask({ sessionId: "s1" });
    await h.tell({ sessionId: "s1" });
    const frames = await channelFrames(bus, 2);

    // `ask` then `tell` — the request frame and its fire-and-forget twin.
    expect(frames.map((e) => e.payload)).toEqual([{ q: 1 }, { n: 1 }]);
    expect(frames.map((e) => e.scope)).toEqual([
      { sessionId: "s1", principal: "acme/u1" },
      { sessionId: "s1", principal: "acme/u1" },
    ]);
  });

  it("principal-less harness leaves channel frames unstamped", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const h = new PrincipalTestHarness("h7", new MemoryJournal(), bus, new LocalInbox());

    await h.ask({ sessionId: "s1" });
    const [frame] = await channelFrames(bus, 1);

    expect(frame!.scope).toEqual({ sessionId: "s1" });
  });

  it("principal-less harness relays the op scope untouched", async () => {
    const bus = new LocalEventBus({ batch: {} });
    const h = new PrincipalTestHarness("h5", new MemoryJournal(), bus, new LocalInbox());

    // No harness principal → whatever the op carries passes through.
    await h.run("op-3", "from-op");
    const principals = await principalsOnEvents(bus);

    expect(principals.length).toBeGreaterThan(0);
    expect(principals.every((p) => p === "from-op")).toBe(true);
  });
});
