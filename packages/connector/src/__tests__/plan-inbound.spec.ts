/**
 * `planInbound` — the spec's standing policy layered under the event's
 * specifics: sessionId fallback chain, event-wins-per-key with one-level
 * metadata merge, tools concatenation, and per-inbound (per-principal)
 * resolution through the sync resolver forms.
 */

import { describe, expect, it } from "vitest";

import type { ConnectorSpec, ToolDeclaration } from "@agentick/spec";

import { planInbound } from "../harness.js";

const noopStart: ConnectorSpec["start"] = () => undefined;

function spec(overrides: Partial<ConnectorSpec>): ConnectorSpec {
  return { name: "test", start: noopStart, ...overrides };
}

const tool = (name: string): ToolDeclaration =>
  ({ name, handler: () => "ok" }) as unknown as ToolDeclaration;

describe("planInbound — sessionId", () => {
  it("falls back event → spec id → connector:<name>", () => {
    expect(planInbound(spec({}), { messages: "m" }).sessionId).toBe("connector:test");
    expect(planInbound(spec({ session: "lobby" }), { messages: "m" }).sessionId).toBe("lobby");
    expect(
      planInbound(spec({ session: "lobby" }), { messages: "m", sessionId: "s-9" }).sessionId,
    ).toBe("s-9");
  });

  it("an id from the object/resolver form participates in the chain", () => {
    expect(planInbound(spec({ session: { id: "fixed" } }), { messages: "m" }).sessionId).toBe(
      "fixed",
    );
    expect(
      planInbound(spec({ session: (msg) => ({ id: `by:${msg.source ? "src" : "none"}` }) }), {
        messages: "m",
      }).sessionId,
    ).toBe("by:none");
  });
});

describe("planInbound — session init", () => {
  it("event wins per key; metadata merges one level", () => {
    const plan = planInbound(
      spec({ session: { title: "Channel default", metadata: { channel: "sms", a: 1 } } }),
      { messages: "m", session: { title: "This thread", metadata: { conversationId: 7 } } },
    );
    expect(plan.sessionInit.title).toBe("This thread");
    expect(plan.sessionInit.metadata).toEqual({ channel: "sms", a: 1, conversationId: 7 });
  });

  it("the resolver sees the event — per-principal policy is expressible", () => {
    const plan = planInbound(
      spec({ session: (msg) => ({ title: `Chat as ${msg.identity?.principal ?? "host"}` }) }),
      { messages: "m", identity: { principal: "7:42", scopes: [] } },
    );
    expect(plan.sessionInit.title).toBe("Chat as 7:42");
  });
});

describe("planInbound — send", () => {
  it("event wins per key over the spec's standing policy", () => {
    const plan = planInbound(spec({ send: { onBusy: "queue", maxTicks: 5 } }), {
      messages: "m",
      send: { maxTicks: 2 },
    });
    expect(plan.send).toMatchObject({ onBusy: "queue", maxTicks: 2 });
  });

  it("tools concatenate — channel tools first, event extras after", () => {
    const plan = planInbound(spec({ send: { tools: [tool("react")] } }), {
      messages: "m",
      send: { tools: [tool("extra")] },
    });
    expect(plan.send.tools?.map((t) => t.name)).toEqual(["react", "extra"]);
  });

  it("a send resolver resolves per inbound", () => {
    const s = spec({ send: (msg) => ({ maxTicks: msg.identity ? 10 : 1 }) });
    expect(planInbound(s, { messages: "m" }).send.maxTicks).toBe(1);
    expect(
      planInbound(s, { messages: "m", identity: { principal: "p", scopes: [] } }).send.maxTicks,
    ).toBe(10);
  });
});
