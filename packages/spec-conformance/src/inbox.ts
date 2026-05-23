/**
 * Conformance suite for `MessageInbox` implementations.
 *
 * Validates the invariants in `docs/proposals/v2/blueprint/19-foundation.md`
 * §The MessageInbox.
 */

import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import type { MessageEnvelopeInput, MessageInbox } from "@agentick/spec";

export function runInboxConformance(factory: () => MessageInbox): void {
  describe("MessageInbox — registration", () => {
    it("rejects duplicate registration at the same address", async () => {
      const inbox = factory();
      await Effect.runPromise(inbox.register("loop:exec-1", () => Effect.void));
      const exit = await Effect.runPromiseExit(inbox.register("loop:exec-1", () => Effect.void));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
        expect(err).toMatchObject({ _tag: "RoutingFailed" });
      }
    });

    it("unsubscribe frees the address for re-registration", async () => {
      const inbox = factory();
      const unsub = await Effect.runPromise(inbox.register("loop:exec-1", () => Effect.void));
      unsub();
      const out = await Effect.runPromise(inbox.register("loop:exec-1", () => Effect.void));
      expect(typeof out).toBe("function");
    });
  });

  describe("MessageInbox — send (tell)", () => {
    it("delivers messages to the registered handler", async () => {
      const inbox = factory();
      let seen: unknown;
      await Effect.runPromise(
        inbox.register<{ x: number }>("loop:exec-1", (msg) =>
          Effect.sync(() => {
            seen = msg.payload;
          }),
        ),
      );
      const ack = await Effect.runPromise(
        inbox.send("loop:exec-1", mkMsg("loop:exec-1", "ping", { x: 42 })),
      );
      expect(ack.messageId).toBe("m_1");
      // Allow microtask flush so the handler runs (tell is fire-and-forget).
      await new Promise((r) => setImmediate(r));
      expect(seen).toEqual({ x: 42 });
    });

    it("AddressNotFound for unknown address", async () => {
      const inbox = factory();
      const exit = await Effect.runPromiseExit(inbox.send("nobody:x", mkMsg("nobody:x", "ping")));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toMatchObject({ _tag: "AddressNotFound" });
      }
    });
  });

  describe("MessageInbox — ask (rpc)", () => {
    it("returns the handler's value", async () => {
      const inbox = factory();
      await Effect.runPromise(
        inbox.register<{ x: number }, number>("calc:1", (msg) =>
          Effect.succeed((msg.payload?.x ?? 0) * 2),
        ),
      );
      const r = await Effect.runPromise(
        inbox.ask<{ x: number }, number>("calc:1", mkMsg("calc:1", "double", { x: 21 })),
      );
      expect(r).toBe(42);
    });

    it("AskTimeout fires when handler never resolves", async () => {
      const inbox = factory();
      await Effect.runPromise(
        inbox.register("slow:1", () => Effect.never as Effect.Effect<never, never, never>),
      );
      const exit = await Effect.runPromiseExit(
        inbox.ask("slow:1", mkMsg("slow:1", "wait", undefined, "m_timeout"), {
          timeoutMs: 20,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toMatchObject({ _tag: "AskTimeout" });
      }
    });

    it("HandlerError surfaces handler failures", async () => {
      const inbox = factory();
      await Effect.runPromise(
        inbox.register("boom:1", () =>
          Effect.fail({ _tag: "HandlerError", cause: new Error("nope") } as const),
        ),
      );
      const exit = await Effect.runPromiseExit(
        inbox.ask("boom:1", mkMsg("boom:1", "explode", undefined, "m_err")),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toMatchObject({ _tag: "HandlerError" });
      }
    });
  });

  describe("MessageInbox — idempotency", () => {
    it("same messageId twice runs the handler exactly once (ask)", async () => {
      const inbox = factory();
      let calls = 0;
      await Effect.runPromise(
        inbox.register<undefined, number>("once:1", () =>
          Effect.sync(() => {
            calls++;
            return calls;
          }),
        ),
      );
      const msg = mkMsg("once:1", "tick", undefined, "m_dedupe");
      const r1 = await Effect.runPromise(inbox.ask<undefined, number>("once:1", msg));
      const r2 = await Effect.runPromise(inbox.ask<undefined, number>("once:1", msg));
      expect(r1).toBe(1);
      expect(r2).toBe(1);
      expect(calls).toBe(1);
    });

    it("same messageId twice returns the cached ack (send)", async () => {
      const inbox = factory();
      let calls = 0;
      await Effect.runPromise(
        inbox.register("once-tell:1", () =>
          Effect.sync(() => {
            calls++;
          }),
        ),
      );
      const msg = mkMsg("once-tell:1", "tick", undefined, "m_dedupe2");
      const a1 = await Effect.runPromise(inbox.send("once-tell:1", msg));
      const a2 = await Effect.runPromise(inbox.send("once-tell:1", msg));
      expect(a1.messageId).toBe(a2.messageId);
      expect(a1.receivedAt).toBe(a2.receivedAt);
      await new Promise((r) => setImmediate(r));
      expect(calls).toBe(1);
    });
  });
}

function mkMsg<T = unknown>(
  _addressedTo: string,
  type: string,
  payload?: T,
  messageId = "m_1",
): MessageEnvelopeInput<T> {
  return {
    type,
    messageId,
    ...(payload !== undefined ? { payload } : {}),
  };
}
