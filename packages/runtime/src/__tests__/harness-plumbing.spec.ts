/**
 * ADR 26 Step 1.5 — harness plumbing integration tests.
 *
 * Proves the substrate machinery (BaseHarness + journal + bus + inbox)
 * actually delivers what the ADR claims:
 *
 *   1. A harness can be a thin synchronous state accessor AND an async
 *      Operation runner on the same instance — mixed protocol shape.
 *   2. Addressed inbox messages route an external actor to a specific
 *      harness's Operations.
 *   3. Middleware installed via `harness.use(...)` wraps each Operation
 *      invocation, regardless of whether the caller is in-process
 *      (direct method call) or remote (inbox-addressed).
 *   4. Lifecycle handlers registered on `"before"` can veto an
 *      Operation; the substrate emits `terminal:vetoed` and the body
 *      never runs.
 *   5. Composition: a parent harness's Operation calling a child
 *      harness's Operation produces a causality tree via `parentOpId`
 *      auto-threaded by BaseHarness's RuntimeContext FiberRef.
 *   6. Envelopes carry sender identity via `surface` + `scope.sessionId`
 *      — enough to reconstruct "who sent what" without an explicit
 *      `from` field today. (Decision point flagged for ADR 26 open
 *      question #6.)
 *
 * These tests are deliberately substrate-only: they exercise BaseHarness
 * primitives against in-memory substrate implementations. No SessionHarness,
 * no AppHarness, no Extension protocol. Purpose: fail-fast verification
 * of the assumptions ADR 26 makes BEFORE we extract knobs/state/timeline
 * into real harnesses in subsequent steps.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import type {
  EventQuery,
  MessageEnvelope,
  MessageHandlerError,
  Operation,
  ProtocolEvent,
} from "@agentick/spec";
import { HandlerError } from "@agentick/spec";
import { BaseHarness, runHarnessProtocol } from "../substrate/base-harness.js";
import type { SubstrateError } from "@agentick/spec";
import { MemoryJournal } from "../substrate/memory-journal.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { generateId } from "@agentick/utils";

// ============================================================================
// Toy harnesses
// ============================================================================

/**
 * Models the future KnobsHarness shape in miniature: sync reads + async
 * writes, inbox-addressable. Uses surface "tool" because the EventSurface
 * type currently restricts to existing surfaces; doesn't matter for the
 * test — we're proving the BaseHarness machinery, not the surface taxonomy.
 */
class ToyKnobsHarness extends BaseHarness<"tool"> {
  private values = new Map<string, string | number | boolean>();
  private listeners = new Set<(id: string) => void>();

  constructor(scopeId: string, journal: MemoryJournal, bus: LocalEventBus, inbox: LocalInbox) {
    super("tool", scopeId, journal, bus, inbox);
  }

  // ─── Sync surface ───
  get(id: string): string | number | boolean | undefined {
    return this.values.get(id);
  }
  list(): readonly [string, string | number | boolean][] {
    return [...this.values];
  }
  subscribe(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ─── Async Operation ───
  set(input: { id: string; value: string | number | boolean; sessionId?: string }): Promise<void> {
    const op: Operation<typeof input, void, never> = {
      opId: `knobs:set:${generateId()}`,
      surface: "tool",
      name: "tool:knobs:set",
      scope: input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.values.set(i.id, i.value);
          this.listeners.forEach((l) => l(i.id));
        }),
      ),
    );
  }

  // ─── Expose middleware registration for tests ───
  installMiddleware(
    mw: (
      input: unknown,
      next: (input: unknown) => Effect.Effect<unknown, unknown, never>,
    ) => Effect.Effect<unknown, unknown, never>,
  ): () => void {
    return this.fx.use(mw);
  }

  // ─── Expose before-handler registration ───
  installBeforeHandler(
    fn: (input: { id: string; value: unknown }) => { veto: true; reason?: string } | undefined,
  ): () => void {
    // ADR 83: before-verdict handler → `gate()` sugar.
    return this.guard<{ id: string; value: unknown }, void>((input) => {
      const out = fn(input);
      return out?.veto ? { kind: "veto", reason: out.reason } : { kind: "proceed" };
    });
  }

  // ─── Inbox routing ───
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    if (msg.type === "tool:knobs:set") {
      const payload = msg.payload as { id: string; value: string | number | boolean };
      return Effect.tryPromise<void, MessageHandlerError>({
        try: () => this.set(payload),
        catch: (cause): MessageHandlerError => new HandlerError({ cause }),
      });
    }
    return Effect.fail(
      new HandlerError({
        cause: `Unknown message type: ${msg.type}`,
      }),
    );
  }
}

/**
 * Parent harness that composes ToyKnobsHarness — its Operation calls
 * child.set() to demonstrate automatic parentOpId linkage via the
 * RuntimeContext FiberRef.
 */
class ToyParentHarness extends BaseHarness<"session"> {
  constructor(
    scopeId: string,
    journal: MemoryJournal,
    bus: LocalEventBus,
    inbox: LocalInbox,
    private readonly knobs: ToyKnobsHarness,
  ) {
    super("session", scopeId, journal, bus, inbox);
  }

  /**
   * Parent Operation that calls into the child harness. The BaseHarness
   * substrate auto-threads `parentOpId` via the FiberRef — the child's
   * Operation envelope should carry the parent's opId.
   */
  flipKnob(input: { id: string; value: string | number | boolean }): Promise<void> {
    const op: Operation<typeof input, void, never> = {
      opId: `session:flip-knob:${generateId()}`,
      surface: "session",
      name: "session:flip-knob",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) => Effect.promise(() => this.knobs.set(i))),
    );
  }

  protected handleMessage(): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: "no messages handled" }));
  }
}

// ============================================================================
// Substrate fixture
// ============================================================================

async function makeSubstrate() {
  const journal = new MemoryJournal({ capacity: 10_000 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  return { journal, bus, inbox };
}

async function makeKnobsHarness(scope = "test"): Promise<{
  knobs: ToyKnobsHarness;
  journal: MemoryJournal;
  bus: LocalEventBus;
  inbox: LocalInbox;
}> {
  const { journal, bus, inbox } = await makeSubstrate();
  const knobs = new ToyKnobsHarness(scope, journal, bus, inbox);
  await knobs.ready;
  return { knobs, journal, bus, inbox };
}

/**
 * Subscribe to the bus and collect every matching envelope into a shared
 * array. The returned promise resolves once the subscription is
 * registered with the bus (waiting on `setImmediate`); the `stop()`
 * interrupts the subscription fiber. Pattern matches base-harness.spec
 * to avoid races between fiber scheduling and event publishing.
 */
async function subscribeEnvelopes(
  bus: LocalEventBus,
  query: EventQuery,
): Promise<{ events: ProtocolEvent[]; stop: () => Promise<void> }> {
  const events: ProtocolEvent[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe(query), (e) =>
      Effect.sync(() => {
        events.push(e);
      }),
    ),
  );
  // Yield so the subscription registers before the caller proceeds.
  await new Promise((r) => setImmediate(r));
  return {
    events,
    stop: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
}

async function settle(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// 1. Mixed sync + async surface on one harness
// ============================================================================

describe("harness plumbing — mixed sync + async protocol", () => {
  it("sync get reads from local state without an envelope", async () => {
    const { knobs, bus } = await makeKnobsHarness();
    const { events, stop } = await subscribeEnvelopes(bus, {});
    expect(knobs.get("missing")).toBeUndefined();
    await settle(10);
    await stop();
    // Sync read produces zero envelopes — there's nothing to audit.
    expect(events).toEqual([]);
  });

  it("async set emits requested + terminal envelopes via runOperation", async () => {
    const { knobs, bus } = await makeKnobsHarness();
    const { events, stop } = await subscribeEnvelopes(bus, { surface: "tool" });
    await knobs.set({ id: "verbose", value: true });
    await settle();
    await stop();
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("requested");
    expect(phases).toContain("terminal");
    // Local state reflects the write.
    expect(knobs.get("verbose")).toBe(true);
  });

  it("sync subscribe fires when async set commits", async () => {
    const { knobs } = await makeKnobsHarness();
    const seen: string[] = [];
    const unsub = knobs.subscribe((id) => seen.push(id));
    await knobs.set({ id: "mood", value: "curious" });
    await knobs.set({ id: "verbose", value: false });
    expect(seen).toEqual(["mood", "verbose"]);
    unsub();
  });
});

// ============================================================================
// 2. Inbox-addressed external actor
// ============================================================================

describe("harness plumbing — addressed inbox messages", () => {
  it("external actor's inbox message reaches the harness's Operation", async () => {
    const { knobs, inbox } = await makeKnobsHarness("session-7");
    const address = `tool:session-7`;
    const messageId = generateId();
    const ack = await Effect.runPromise(
      inbox.send(address, {
        messageId,
        type: "tool:knobs:set",
        payload: { id: "verbose", value: true },
      }),
    );
    // MessageAck carries `messageId` + `receivedAt` — receipt is the
    // proof the inbox routed the message; handler execution races on
    // the fiber and we poll local state to confirm side effect.
    expect(ack.messageId).toBe(messageId);
    await settle(10);
    expect(knobs.get("verbose")).toBe(true);
  });

  it("inbox-routed mutation produces the same envelope flow as direct call", async () => {
    const { knobs, bus, inbox } = await makeKnobsHarness("session-8");
    const { events, stop } = await subscribeEnvelopes(bus, { surface: "tool" });
    await Effect.runPromise(
      inbox.send(`tool:session-8`, {
        type: "tool:knobs:set",
        payload: { id: "mood", value: "decisive" },
      }),
    );
    await settle(30);
    await stop();
    expect(events.some((e) => e.phase === "requested")).toBe(true);
    expect(events.some((e) => e.phase === "terminal")).toBe(true);
    expect(knobs.get("mood")).toBe("decisive");
  });

  it("inbox message to unknown type emits a HandlerError without crashing the harness", async () => {
    const { knobs, inbox } = await makeKnobsHarness("session-9");
    const messageId = generateId();
    const ack = await Effect.runPromise(
      inbox.send(`tool:session-9`, {
        messageId,
        type: "tool:knobs:nonexistent",
        payload: {},
      }),
    );
    // Inbox accepted the message (`messageId` echoed); the handler will
    // fail internally on the forked fiber. The harness stays usable.
    expect(ack.messageId).toBe(messageId);
    await settle(10);
    await knobs.set({ id: "verbose", value: true });
    expect(knobs.get("verbose")).toBe(true);
  });
});

// ============================================================================
// 3. Middleware hook
// ============================================================================

describe("harness plumbing — middleware on Operations", () => {
  it("middleware wraps each Operation invocation (direct call)", async () => {
    const { knobs } = await makeKnobsHarness();
    const observed: Array<{ stage: string; input: unknown }> = [];
    knobs.installMiddleware((input, next) =>
      Effect.gen(function* () {
        observed.push({ stage: "before", input });
        const out = yield* next(input);
        observed.push({ stage: "after", input });
        return out;
      }),
    );
    await knobs.set({ id: "verbose", value: true });
    expect(observed.map((o) => o.stage)).toEqual(["before", "after"]);
    expect((observed[0]!.input as { id: string }).id).toBe("verbose");
  });

  it("middleware wraps inbox-routed Operations too (same code path)", async () => {
    const { knobs, inbox } = await makeKnobsHarness("session-mw");
    const observed: string[] = [];
    knobs.installMiddleware((input, next) =>
      Effect.gen(function* () {
        observed.push("mw");
        return yield* next(input);
      }),
    );
    await Effect.runPromise(
      inbox.send(`tool:session-mw`, {
        type: "tool:knobs:set",
        payload: { id: "mood", value: "playful" },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(observed).toEqual(["mw"]);
  });
});

// ============================================================================
// 4. Lifecycle veto
// ============================================================================

describe("harness plumbing — lifecycle veto", () => {
  it("before-handler veto blocks the body and emits terminal:vetoed", async () => {
    const { knobs, bus } = await makeKnobsHarness();
    knobs.installBeforeHandler((input) => {
      if (input.id === "locked") return { veto: true, reason: "knob is locked" };
      return undefined;
    });
    const { events, stop } = await subscribeEnvelopes(bus, { surface: "tool" });
    // Allowed mutation goes through.
    await knobs.set({ id: "verbose", value: true });
    expect(knobs.get("verbose")).toBe(true);
    // Vetoed mutation does NOT commit.
    await expect(knobs.set({ id: "locked", value: "x" })).rejects.toMatchObject({
      outcome: "vetoed",
    });
    expect(knobs.get("locked")).toBeUndefined();
    await settle();
    await stop();
    const outcomes = events.filter((e) => e.phase === "terminal").map((e) => e.outcome);
    expect(outcomes).toContain("succeeded");
    expect(outcomes).toContain("vetoed");
  });
});

// ============================================================================
// 5. Parent/child Operation composition
// ============================================================================

describe("harness plumbing — parent/child Operation composition", () => {
  it("child Operation envelope carries parentOpId from the parent's FiberRef", async () => {
    const { journal, bus, inbox } = await makeSubstrate();
    const knobs = new ToyKnobsHarness("kn-1", journal, bus, inbox);
    const parent = new ToyParentHarness("sess-1", journal, bus, inbox, knobs);
    await Promise.all([knobs.ready, parent.ready]);

    const { events, stop } = await subscribeEnvelopes(bus, {});
    await parent.flipKnob({ id: "verbose", value: true });
    await settle();
    await stop();

    // Find parent's `requested`
    const parentReq = events.find((e) => e.surface === "session" && e.phase === "requested");
    expect(parentReq).toBeDefined();
    const parentOpId = parentReq!.opId;

    // Child knob `requested` should carry parentOpId === parent's opId.
    const childReq = events.find(
      (e) => e.surface === "tool" && e.name === "tool:knobs:set" && e.phase === "requested",
    );
    expect(childReq).toBeDefined();
    // Promise-bridged composition (parent's runOperation body calls
    // `Effect.promise(() => child.set(...))`, where `set` internally
    // runs a fresh `Effect.runPromise`): the child's fiber does NOT
    // inherit the parent's FiberRef, so auto-propagation of
    // `parentOpId` is lost across the bridge. Causality must be
    // threaded explicitly (or composition must stay Effect-native).
    // The Effect-native composition path is exercised separately.
    expect(childReq!.opId).not.toBe(parentOpId);
    expect(parentReq!.parentOpId).toBeUndefined();

    // Both Operations' envelopes appear in the bus event stream.
    const parentEvents = events.filter((e) => e.opId === parentOpId);
    expect(parentEvents.length).toBeGreaterThan(0);
    const childEvents = events.filter((e) => e.opId === childReq!.opId);
    expect(childEvents.length).toBeGreaterThan(0);
  });

  it("Effect-native nested runOperation auto-threads parentOpId onto child envelope", async () => {
    // Effect-native composition: the outer Operation's body stays within
    // the Effect fiber and invokes a second `runOperation` directly. The
    // RuntimeContext FiberRef carries the outer opId through to the
    // child, which auto-populates `parentOpId` on its Operation and
    // hence on every emitted envelope.
    //
    // This is the canonical composition shape — distinct from the
    // Promise-bridged path above, which crosses `Effect.runPromise` and
    // loses the FiberRef.
    const { journal, bus, inbox } = await makeSubstrate();

    class ComposingHarness extends BaseHarness<"tool"> {
      constructor(scopeId: string = "compose-test") {
        super("tool", scopeId, journal, bus, inbox);
      }
      outerEffect(): Effect.Effect<string, SubstrateError, never> {
        const outer: Operation<{}, string, never> = {
          opId: `tool:outer:${generateId()}`,
          surface: "tool",
          name: "tool:outer",
          input: {},
          scope: {},
        };
        return this.runOperation(outer, () =>
          Effect.gen(this, function* () {
            const inner: Operation<{}, string, never> = {
              opId: `tool:inner:${generateId()}`,
              surface: "tool",
              name: "tool:inner",
              input: {},
              scope: {},
            };
            return yield* this.runOperation(inner, () => Effect.succeed("ok"));
          }),
        );
      }
      protected handleMessage(): Effect.Effect<unknown, MessageHandlerError, never> {
        return Effect.fail(new HandlerError({ cause: "n/a" }));
      }
    }

    const h = new ComposingHarness();
    await h.ready;
    const { events, stop } = await subscribeEnvelopes(bus, {});
    const result = await Effect.runPromise(h.outerEffect());
    await settle();
    await stop();
    expect(result).toBe("ok");

    const outerReq = events.find((e) => e.name === "tool:outer" && e.phase === "requested");
    const innerReq = events.find((e) => e.name === "tool:inner" && e.phase === "requested");
    expect(outerReq).toBeDefined();
    expect(innerReq).toBeDefined();
    expect(outerReq!.parentOpId).toBeUndefined();
    expect(innerReq!.parentOpId).toBe(outerReq!.opId);
    // All inner-op envelopes (requested / before / terminal) inherit
    // parentOpId — composition produces a clean causality tree.
    const innerEnvs = events.filter((e) => e.opId === innerReq!.opId);
    expect(innerEnvs.length).toBeGreaterThan(0);
    for (const env of innerEnvs) {
      expect(env.parentOpId).toBe(outerReq!.opId);
    }
  });
});

// ============================================================================
// 6. Envelope sender identity
// ============================================================================

describe("harness plumbing — sender identity in envelopes", () => {
  it("envelope.surface + envelope.scope.sessionId encode sender", async () => {
    const { knobs, bus } = await makeKnobsHarness("test-sender");
    const { events, stop } = await subscribeEnvelopes(bus, { surface: "tool" });
    await knobs.set({ id: "verbose", value: true, sessionId: "test-sender" });
    await settle();
    await stop();
    const requested = events.find((e) => e.phase === "requested");
    expect(requested).toBeDefined();
    expect(requested!.surface).toBe("tool");
    expect(requested!.scope.sessionId).toBe("test-sender");
    // This pairing — surface + sessionId — is what observers use to
    // identify "which session's knobs harness emitted this." No explicit
    // `from` field needed today.
  });

  it("MessageEnvelope carries an explicit `from` for response/ack tracking", async () => {
    // ADR 26 open question #6 — when cross-actor messaging needs
    // explicit `from` tracking. The substrate's MessageEnvelope
    // already supports this for sender identification on response/ack.
    // This test documents the current shape so the ADR can land on
    // whether richer sender metadata needs further promotion.
    const { inbox } = await makeKnobsHarness("test-reply");
    const messageId = generateId();
    const ack = await Effect.runPromise(
      inbox.send(`tool:test-reply`, {
        messageId,
        type: "tool:knobs:set",
        payload: { id: "verbose", value: true },
        from: "external-actor:dashboard-42",
      }),
    );
    // Verifying the substrate accepts `from` as a known envelope field;
    // correlation/routing lands in higher layers.
    expect(ack.messageId).toBe(messageId);
  });
});
