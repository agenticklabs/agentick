/**
 * Smoke tests for the new "pipes" bridges shipped alongside ADR 22
 * Tier-1 follow-up:
 *
 *   - SandboxBridge — register/get/list/subscribe
 *   - MCPBridge — register/list/subscribe + notifyMutation
 *   - SubscriptionBridge — declare/dispatch/snapshot/restore
 */

import { describe, expect, it, vi } from "vitest";

import type {
  MCPConnection,
  SandboxHandle,
  SubscriptionIntent,
} from "@agentick/spec";

import { inMemoryMCPBridge } from "../bridges/in-memory-mcp-bridge.js";
import { inMemorySandboxBridge } from "../bridges/in-memory-sandbox-bridge.js";
import { inMemorySubscriptionBridge } from "../bridges/in-memory-subscription-bridge.js";

// ────────────────────────────── helpers ──────────────────────────────

function makeHandle(id: string, workspacePath = `/tmp/${id}`): SandboxHandle {
  return {
    id,
    workspacePath,
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0, signaled: false, durationMs: 0 };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
    async destroy() {},
  };
}

function makeConnection(id: string, status: MCPConnection["status"] = "ready"): MCPConnection {
  return {
    declaration: {
      id,
      serverName: id,
      transport: "stdio",
      config: {},
    },
    status,
    tools: [],
    resources: [],
    async request() {
      return {};
    },
    async close() {},
  };
}

// ────────────────────────────── SandboxBridge ──────────────────────────────

describe("inMemorySandboxBridge", () => {
  it("register / get / list round-trip", () => {
    const bridge = inMemorySandboxBridge();
    const h = makeHandle("sb-1");
    bridge.register("sb-1", h);
    expect(bridge.get("sb-1")).toBe(h);
    expect(bridge.list()).toEqual([{ id: "sb-1", workspacePath: "/tmp/sb-1" }]);
  });

  it("unsubscribe via the returned function clears the entry", () => {
    const bridge = inMemorySandboxBridge();
    const unsub = bridge.register("sb-2", makeHandle("sb-2"));
    expect(bridge.get("sb-2")).toBeDefined();
    unsub();
    expect(bridge.get("sb-2")).toBeUndefined();
  });

  it("subscribe(id, …) fires on register / unregister", () => {
    const bridge = inMemorySandboxBridge();
    const listener = vi.fn();
    bridge.subscribe("sb-3", listener);
    bridge.register("sb-3", makeHandle("sb-3"));
    expect(listener).toHaveBeenCalledTimes(1);
    bridge.unregister("sb-3");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

// ────────────────────────────── MCPBridge ──────────────────────────────

describe("inMemoryMCPBridge", () => {
  it("register / get / list", () => {
    const bridge = inMemoryMCPBridge();
    const c = makeConnection("m-1");
    bridge.register(c);
    expect(bridge.get("m-1")).toBe(c);
    expect(bridge.list()).toEqual([c]);
  });

  it("subscribe fires on register, unregister, and notifyMutation", () => {
    const bridge = inMemoryMCPBridge();
    const listener = vi.fn();
    bridge.subscribe(listener);
    bridge.register(makeConnection("m-2"));
    expect(listener).toHaveBeenCalledTimes(1);
    bridge.notifyMutation("m-2");
    expect(listener).toHaveBeenCalledTimes(2);
    bridge.unregister("m-2");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("unsubscribe via the returned function removes the connection", () => {
    const bridge = inMemoryMCPBridge();
    const unsub = bridge.register(makeConnection("m-3"));
    unsub();
    expect(bridge.get("m-3")).toBeUndefined();
  });
});

// ────────────────────────────── SubscriptionBridge ──────────────────────────────

describe("inMemorySubscriptionBridge", () => {
  it("declare adds an intent to list()", () => {
    const bridge = inMemorySubscriptionBridge({ sessionId: () => "s1" });
    const intent: SubscriptionIntent = {
      id: "cron.daily",
      kind: "cron",
      config: { expr: "0 0 * * *" },
    };
    bridge.declare(intent, async () => {});
    expect(bridge.list()).toEqual([intent]);
  });

  it("dispatch invokes the bound handler with ctx", async () => {
    const bridge = inMemorySubscriptionBridge({ sessionId: () => "s2" });
    const handler = vi.fn(async () => {});
    bridge.declare(
      { id: "cron.x", kind: "cron", config: { expr: "* * * * *" } },
      handler,
    );
    await bridge.dispatch("cron.x", { now: 123 });
    expect(handler).toHaveBeenCalledTimes(1);
    const [event, ctx] = handler.mock.calls[0]!;
    expect(event).toEqual({ now: 123 });
    expect(ctx.id).toBe("cron.x");
    expect(ctx.sessionId).toBe("s2");
    expect(ctx.signal.aborted).toBe(false);
  });

  it("re-declaring the same id aborts the prior controller", async () => {
    const bridge = inMemorySubscriptionBridge();
    let firstSignal: AbortSignal | null = null;
    bridge.declare(
      { id: "wh.x", kind: "webhook", config: { path: "/x" } },
      async (_event, ctx) => {
        firstSignal = ctx.signal;
      },
    );
    await bridge.dispatch("wh.x", null);
    expect(firstSignal!.aborted).toBe(false);

    bridge.declare(
      { id: "wh.x", kind: "webhook", config: { path: "/x" } },
      async () => {},
    );
    expect(firstSignal!.aborted).toBe(true);
  });

  it("unsubscribe via declare's return removes the intent", () => {
    const bridge = inMemorySubscriptionBridge();
    const unsub = bridge.declare(
      { id: "wh.y", kind: "webhook", config: {} },
      async () => {},
    );
    expect(bridge.list()).toHaveLength(1);
    unsub();
    expect(bridge.list()).toHaveLength(0);
  });

  it("dispatch on an unknown id throws", async () => {
    const bridge = inMemorySubscriptionBridge();
    await expect(bridge.dispatch("missing", null)).rejects.toThrow(/no handler/);
  });

  it("snapshot round-trips intents", () => {
    const bridge = inMemorySubscriptionBridge();
    const intents: SubscriptionIntent[] = [
      { id: "cron.a", kind: "cron", config: { expr: "@daily" } },
      { id: "wh.b", kind: "webhook", config: { path: "/b" } },
    ];
    for (const i of intents) bridge.declare(i, async () => {});
    const snap = bridge.exportSnapshot();
    expect(snap.map((s) => s.id).sort()).toEqual(["cron.a", "wh.b"]);

    const next = inMemorySubscriptionBridge();
    next.importSnapshot(snap);
    expect(next.list().map((i) => i.id).sort()).toEqual(["cron.a", "wh.b"]);
    // Pending intents (no handler yet) — dispatch should still throw
    return expect(next.dispatch("cron.a", null)).rejects.toThrow();
  });

  it("re-declaring an imported intent promotes pending → live", async () => {
    const bridge = inMemorySubscriptionBridge();
    bridge.importSnapshot([{ id: "cron.live", kind: "cron", config: {} }]);
    expect(bridge.list()).toHaveLength(1);
    await expect(bridge.dispatch("cron.live", null)).rejects.toThrow();

    const handler = vi.fn(async () => {});
    bridge.declare({ id: "cron.live", kind: "cron", config: {} }, handler);
    await bridge.dispatch("cron.live", { tick: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
