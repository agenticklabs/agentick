import { Effect } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AddressNotFound,
  AskTimeout,
  DEFAULT_JOURNALING_POLICY,
  HandlerError,
  InboxError,
  JournalError,
  MessageHandlerError,
  OffsetOutOfRange,
  ReadFailed,
  SPEC_VERSION,
  WriteFailed,
  type CommandOutcome,
  type DiscreteEvent,
  type EventEnvelope,
  type EventPhase,
  type EventQuery,
  type EventSurface,
  type HandlerVerdict,
  type JournalingPolicy,
  type MessageAck,
  type MessageEnvelope,
  type MessageHandler,
  type Operation,
  type ProtocolEvent,
  type StandardSchemaV1,
  type TerminalEvent,
} from "../index.js";

describe("@agentick/spec-next — structural smoke tests", () => {
  describe("SPEC_VERSION", () => {
    it("is a date string in YYYY-MM-DD format", () => {
      expect(SPEC_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("EventEnvelope", () => {
    it("accepts a minimal valid envelope", () => {
      const e: EventEnvelope = {
        id: "evt_01",
        surface: "session",
        name: "session:lifecycle:mount",
        phase: "terminal",
        outcome: "succeeded",
        timestamp: Date.now(),
        scope: { sessionId: "s_1" },
      };
      expect(e.phase).toBe("terminal");
    });

    it("ProtocolEvent is an alias of EventEnvelope", () => {
      expectTypeOf<ProtocolEvent>().toEqualTypeOf<EventEnvelope>();
    });
  });

  describe("CommandOutcome", () => {
    it("includes all six values", () => {
      const outcomes: CommandOutcome[] = [
        "succeeded",
        "failed",
        "canceled",
        "vetoed",
        "replaced",
        "deferred",
      ];
      expect(outcomes).toHaveLength(6);
    });
  });

  describe("EventPhase", () => {
    it("includes all four phases", () => {
      const phases: EventPhase[] = ["requested", "before", "delta", "terminal"];
      expect(phases).toHaveLength(4);
    });
  });

  describe("EventSurface", () => {
    it("includes all seven core surfaces + cluster/gateway wrappers", () => {
      const surfaces: EventSurface[] = [
        "app",
        "session",
        "loop",
        "compiler",
        "formatter",
        "executor",
        "tool",
        "cluster",
        "gateway",
      ];
      expect(surfaces).toHaveLength(9);
    });
  });

  describe("HandlerVerdict", () => {
    it("discriminates on kind", () => {
      const proceed: HandlerVerdict = { kind: "proceed" };
      const veto: HandlerVerdict = { kind: "veto", reason: "no" };
      const replace: HandlerVerdict<number> = { kind: "replace", result: 42 };
      const defer: HandlerVerdict = { kind: "defer", retryAfter: 1000 };
      expect(proceed.kind).toBe("proceed");
      expect(veto.kind).toBe("veto");
      expect(replace.kind).toBe("replace");
      expect(defer.kind).toBe("defer");
    });
  });

  describe("TerminalEvent", () => {
    it("succeeded carries a result", () => {
      const t: TerminalEvent<string> = { outcome: "succeeded", result: "ok" };
      if (t.outcome === "succeeded") {
        expectTypeOf(t.result).toEqualTypeOf<string>();
      }
    });

    it("failed carries an error", () => {
      const t: TerminalEvent<string, { code: "X" }> = {
        outcome: "failed",
        error: { code: "X" },
      };
      if (t.outcome === "failed") {
        expectTypeOf(t.error).toEqualTypeOf<{ code: "X" }>();
      }
    });
  });

  describe("Operation", () => {
    it("is generic over input/result/error", () => {
      const op: Operation<{ x: number }, string, { code: "BAD" }> = {
        opId: "op_1",
        surface: "tool",
        name: "tool:dispatch:invoke",
        scope: { sessionId: "s_1" },
        input: { x: 42 },
      };
      expect(op.input.x).toBe(42);
    });
  });

  describe("DiscreteEvent + ChannelEvent", () => {
    it("DiscreteEvent has no opId requirement", () => {
      const d: DiscreteEvent = {
        id: "d_1",
        surface: "compiler",
        name: "compiler:async:resolved",
        scope: {},
        timestamp: Date.now(),
      };
      expect(d.name).toMatch(/^compiler:/);
    });
  });

  describe("EventQuery", () => {
    it("accepts NameQuery variants", () => {
      const q1: EventQuery = { name: { exact: "session:lifecycle:mount" } };
      const q2: EventQuery = { name: { prefix: "tool:dispatch" } };
      const q3: EventQuery = { name: { wildcard: "executor:*:terminal" } };
      const q4: EventQuery = { name: { segments: ["session", "tick"] } };
      expect([q1, q2, q3, q4]).toHaveLength(4);
    });

    it("can combine multiple filters", () => {
      const q: EventQuery = {
        surface: "tool",
        phase: "terminal",
        outcome: ["failed", "vetoed"],
        scope: { sessionId: "s_1" },
      };
      expect(q.outcome).toEqual(["failed", "vetoed"]);
    });
  });

  describe("MessageEnvelope", () => {
    it("is wire-safe (JSON-serializable shape)", () => {
      const m: MessageEnvelope<{ reason: string }> = {
        addressedTo: "loop:exec-1",
        type: "halt",
        messageId: "msg_1",
        timestamp: Date.now(),
        payload: { reason: "user-requested" },
      };
      const round = JSON.parse(JSON.stringify(m)) as MessageEnvelope;
      expect(round.addressedTo).toBe(m.addressedTo);
      expect(round.messageId).toBe(m.messageId);
    });

    it("MessageHandler returns an Effect with typed handler-error channel", () => {
      const handler: MessageHandler<{ x: number }, string> = (msg) =>
        Effect.succeed(`got ${msg.payload?.x ?? 0}`);
      expectTypeOf(handler).toBeFunction();
    });
  });

  describe("MessageAck", () => {
    it("has messageId and receivedAt", () => {
      const ack: MessageAck = { messageId: "msg_1", receivedAt: 100 };
      expect(ack.messageId).toBe("msg_1");
    });
  });

  describe("error taxonomies", () => {
    it("JournalError concrete classes discriminate by _tag and share the abstract parent", () => {
      const e1 = new WriteFailed({ cause: new Error() });
      const e2 = new ReadFailed({ cause: "x" });
      const e3 = new OffsetOutOfRange({ requested: 5, oldest: 10 });
      expect(e1._tag).toBe("WriteFailed");
      expect(e2._tag).toBe("ReadFailed");
      expect(e3._tag).toBe("OffsetOutOfRange");
      expect(e1).toBeInstanceOf(JournalError);
      expect(e2).toBeInstanceOf(JournalError);
      expect(e3).toBeInstanceOf(JournalError);
    });

    it("InboxError concrete classes discriminate by _tag and share the abstract parent", () => {
      const e1 = new AddressNotFound({ address: "x" });
      const e2 = new AskTimeout({ timeoutMs: 5000 });
      expect(e1._tag).toBe("AddressNotFound");
      expect(e2._tag).toBe("AskTimeout");
      expect(e1).toBeInstanceOf(InboxError);
      expect(e2).toBeInstanceOf(InboxError);
    });

    it("MessageHandlerError concrete classes discriminate by _tag", () => {
      const e = new HandlerError({ cause: "x" });
      expect(e._tag).toBe("HandlerError");
      expect(e).toBeInstanceOf(MessageHandlerError);
    });
  });

  describe("DEFAULT_JOURNALING_POLICY", () => {
    it("alwaysJournal includes requested + terminal", () => {
      expect(DEFAULT_JOURNALING_POLICY.alwaysJournal).toEqual(["requested", "terminal"]);
    });

    it("busOnly includes before + delta", () => {
      expect(DEFAULT_JOURNALING_POLICY.busOnly).toEqual(["before", "delta"]);
    });

    it("overflow defaults to sliding", () => {
      expect(DEFAULT_JOURNALING_POLICY.overflow).toBe("sliding");
    });

    it("is a valid JournalingPolicy", () => {
      const p: JournalingPolicy = DEFAULT_JOURNALING_POLICY;
      expect(p.queueCapacity).toBeGreaterThan(0);
    });
  });

  describe("JournalingPolicy.batch / retention — ADR 29 Phase B", () => {
    it("accepts a policy with per-surface batch + retention", () => {
      const p: JournalingPolicy = {
        ...DEFAULT_JOURNALING_POLICY,
        batch: {
          "executor:delta": { flushAfterMs: 8, flushAfterCount: 4 },
          "session:metric": { flushAfterMs: 500 },
        },
        retention: {
          "executor:delta": { maxEvents: 1024 },
          "executor:*": { maxAge: 60_000 },
        },
      };
      expect(p.batch?.["executor:delta"]?.flushAfterMs).toBe(8);
      expect(p.batch?.["executor:delta"]?.flushAfterCount).toBe(4);
      expect(p.batch?.["session:metric"]?.flushAfterMs).toBe(500);
      expect(p.retention?.["executor:delta"]?.maxEvents).toBe(1024);
      expect(p.retention?.["executor:*"]?.maxAge).toBe(60_000);
    });

    it("batch + retention are optional (omitted = no batching, default retention)", () => {
      const p: JournalingPolicy = DEFAULT_JOURNALING_POLICY;
      expect(p.batch).toBeUndefined();
      expect(p.retention).toBeUndefined();
    });

    it("a batch entry may set only one trigger", () => {
      const p: JournalingPolicy = {
        ...DEFAULT_JOURNALING_POLICY,
        batch: {
          "executor:delta": { flushAfterCount: 8 },
          "session:metric": { flushAfterMs: 250 },
        },
      };
      expect(p.batch?.["executor:delta"]?.flushAfterMs).toBeUndefined();
      expect(p.batch?.["session:metric"]?.flushAfterCount).toBeUndefined();
    });
  });

  describe("StandardSchemaV1", () => {
    it("structurally accepts a Zod-shaped validator", () => {
      // Build a minimal fake validator that conforms to the Standard
      // Schema v1 shape. This is what real validators export under
      // their ~standard property.
      const fakeSchema: StandardSchemaV1<unknown, { ok: true }> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (_value: unknown) => ({ value: { ok: true as const } }),
        },
      };
      expect(fakeSchema["~standard"].version).toBe(1);
    });
  });
});
