/**
 * Conformance suite for `MessageInbox` implementations.
 *
 * Validates the invariants in `docs/proposals/v2/blueprint/19-foundation.md`
 * §The MessageInbox.
 */

import { describe, expect, it } from "vitest";
import type { MessageEnvelope, MessageInbox } from "@agentick/spec";

export function runInboxConformance(factory: () => MessageInbox): void {
  describe("MessageInbox — registration", () => {
    it("rejects duplicate registration at the same address", async () => {
      const inbox = factory();
      await inbox.register("loop:exec-1", async () => undefined);
      await expect(
        inbox.register("loop:exec-1", async () => undefined),
      ).rejects.toMatchObject({ _tag: "RoutingFailed" });
    });

    it("unsubscribe frees the address for re-registration", async () => {
      const inbox = factory();
      const unsub = await inbox.register("loop:exec-1", async () => undefined);
      unsub();
      await expect(
        inbox.register("loop:exec-1", async () => undefined),
      ).resolves.toBeTypeOf("function");
    });
  });

  describe("MessageInbox — send (tell)", () => {
    it("delivers messages to the registered handler", async () => {
      const inbox = factory();
      let seen: unknown;
      await inbox.register<{ x: number }>("loop:exec-1", async (msg) => {
        seen = msg.payload;
      });
      const ack = await inbox.send(
        "loop:exec-1",
        mkMsg("loop:exec-1", "ping", { x: 42 }),
      );
      expect(ack.messageId).toBe("m_1");
      // Allow microtask flush so the handler runs.
      await Promise.resolve();
      await Promise.resolve();
      expect(seen).toEqual({ x: 42 });
    });

    it("AddressNotFound for unknown address", async () => {
      const inbox = factory();
      await expect(
        inbox.send("nobody:x", mkMsg("nobody:x", "ping")),
      ).rejects.toMatchObject({ _tag: "AddressNotFound" });
    });
  });

  describe("MessageInbox — ask (rpc)", () => {
    it("returns the handler's value", async () => {
      const inbox = factory();
      await inbox.register<{ x: number }, number>("calc:1", async (msg) => {
        return (msg.payload?.x ?? 0) * 2;
      });
      const r = await inbox.ask<{ x: number }, number>(
        "calc:1",
        mkMsg("calc:1", "double", { x: 21 }),
      );
      expect(r).toBe(42);
    });

    it("AskTimeout fires when handler never resolves", async () => {
      const inbox = factory();
      await inbox.register("slow:1", () => new Promise(() => {}));
      await expect(
        inbox.ask("slow:1", mkMsg("slow:1", "wait", undefined, "m_timeout"), {
          timeoutMs: 20,
        }),
      ).rejects.toMatchObject({ _tag: "AskTimeout" });
    });

    it("HandlerError wraps thrown handler exceptions", async () => {
      const inbox = factory();
      await inbox.register("boom:1", async () => {
        throw new Error("nope");
      });
      await expect(
        inbox.ask("boom:1", mkMsg("boom:1", "explode", undefined, "m_err")),
      ).rejects.toMatchObject({ _tag: "HandlerError" });
    });
  });

  describe("MessageInbox — idempotency", () => {
    it("same messageId twice runs the handler exactly once (ask)", async () => {
      const inbox = factory();
      let calls = 0;
      await inbox.register<undefined, number>("once:1", async () => {
        calls++;
        return calls;
      });
      const msg = mkMsg("once:1", "tick", undefined, "m_dedupe");
      const r1 = await inbox.ask<undefined, number>("once:1", msg);
      const r2 = await inbox.ask<undefined, number>("once:1", msg);
      expect(r1).toBe(1);
      expect(r2).toBe(1);
      expect(calls).toBe(1);
    });

    it("same messageId twice returns the cached ack (send)", async () => {
      const inbox = factory();
      let calls = 0;
      await inbox.register("once-tell:1", async () => {
        calls++;
      });
      const msg = mkMsg("once-tell:1", "tick", undefined, "m_dedupe2");
      const a1 = await inbox.send("once-tell:1", msg);
      const a2 = await inbox.send("once-tell:1", msg);
      expect(a1.messageId).toBe(a2.messageId);
      expect(a1.receivedAt).toBe(a2.receivedAt);
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(1);
    });
  });
}

function mkMsg<T = unknown>(
  addressedTo: string,
  type: string,
  payload?: T,
  messageId = "m_1",
): MessageEnvelope<T> {
  return {
    addressedTo,
    type,
    messageId,
    timestamp: Date.now(),
    payload,
  };
}
