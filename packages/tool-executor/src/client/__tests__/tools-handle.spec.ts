/**
 * `toolsHandle` — the client-side tools resource handle on the `ClientHandle`
 * contract (three-audiences-plan §F). RPC-backed (no `tools-state` channel), so
 * the read side is a poll: an eager `session/list_tools` seeds the snapshot;
 * `refresh()` re-polls. These tests pin the wire request shapes per verb.
 */

import { describe, expect, it } from "vitest";
import type { ToolInfo, WireMethod, WireParams, WireResult } from "@agentick/spec";
import { waitFor, waitForStable } from "@agentick/utils/testing";

import { toolsHandle } from "../tools-handle.js";

interface Captured {
  method: WireMethod;
  params: unknown;
}

const TOOLS: readonly ToolInfo[] = [
  {
    name: "resource_read",
    description: "Read a resource",
    exposure: ["model"],
    hasInputSchema: true,
  },
  { name: "echo", description: "Echo", exposure: ["model", "dispatch"], hasInputSchema: true },
];

/** Fake command client: records requests; scripts list_tools + dispatch. */
function fakeCommandClient(captured: Captured[]) {
  return {
    transport: {
      async request<M extends WireMethod>(
        method: M,
        params: WireParams<M>,
      ): Promise<WireResult<M>> {
        captured.push({ method, params });
        if (method === "session/list_tools") return { tools: TOOLS } as WireResult<M>;
        if (method === "session/dispatch")
          return { content: [{ type: "text", text: "ok" }] } as WireResult<M>;
        return null as WireResult<M>;
      },
    },
  };
}

/**
 * Fake whose FIRST request lands only after a MACROTASK — so a subscriber is
 * registered while the seed is still in flight — and, with `failFirst`, throws
 * instead of answering.
 */
function seedGatedClient(captured: Captured[], opts: { readonly failFirst?: boolean } = {}) {
  const ok = fakeCommandClient(captured);
  let calls = 0;
  return {
    transport: {
      async request<M extends WireMethod>(
        method: M,
        params: WireParams<M>,
      ): Promise<WireResult<M>> {
        const first = ++calls === 1;
        if (first) await new Promise((r) => setTimeout(r, 0));
        if (first && opts.failFirst) throw new Error("transport down");
        return ok.transport.request(method, params);
      },
    },
  };
}

describe("toolsHandle — the eager seed", () => {
  it("notifies subscribers when the seed lands — nothing to await at boot", async () => {
    const captured: Captured[] = [];
    const handle = toolsHandle(seedGatedClient(captured), "s1");
    let notified = 0;
    const stop = handle.subscribe(() => {
      notified += 1;
    });

    // Render what you have: the snapshot is empty while the seed is in flight…
    expect(handle.list()).toEqual([]);
    // …and re-render when it arrives. No boot `refresh()`, nothing awaited.
    await waitFor(() => notified > 0);

    expect(handle.list()).toEqual(TOOLS);
    // ONE poll — the seed. A boot-time `refresh()` would be a second.
    expect(captured).toHaveLength(1);
    stop();
  });

  it("a seed that fails settles the snapshot empty; refresh() recovers it", async () => {
    const captured: Captured[] = [];
    const handle = toolsHandle(seedGatedClient(captured, { failFirst: true }), "s1");

    // A failed seed throws nothing at the caller and leaves no half-filled
    // snapshot — it settles empty, which is what the read surface then reports.
    expect(await waitForStable(() => handle.list())).toEqual([]);

    await handle.refresh();
    expect(handle.list()).toEqual(TOOLS);
  });
});

describe("toolsHandle", () => {
  it("list()/get() reflect the eager session/list_tools poll", async () => {
    const captured: Captured[] = [];
    const handle = toolsHandle(fakeCommandClient(captured), "s1");

    await waitFor(() => handle.list().length > 0);

    expect(handle.list()).toEqual(TOOLS);
    expect(handle.get("echo")).toMatchObject({ name: "echo", exposure: ["model", "dispatch"] });
    expect(handle.get("nope")).toBeUndefined();
    expect(captured[0]).toEqual({ method: "session/list_tools", params: { sessionId: "s1" } });
  });

  it("refresh({ exposure }) threads the exposure filter", async () => {
    const captured: Captured[] = [];
    const handle = toolsHandle(fakeCommandClient(captured), "s1");
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    await handle.refresh({ exposure: "dispatch" });

    expect(captured[0]).toEqual({
      method: "session/list_tools",
      params: { sessionId: "s1", exposure: "dispatch" },
    });
  });

  it("dispatch(name, input) issues session/dispatch and returns the content blocks", async () => {
    const captured: Captured[] = [];
    const handle = toolsHandle(fakeCommandClient(captured), "s1");
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    const out = await handle.dispatch("echo", { x: 1 });

    expect(out).toEqual([{ type: "text", text: "ok" }]);
    expect(captured[0]).toEqual({
      method: "session/dispatch",
      params: { sessionId: "s1", tool: "echo", input: { x: 1 } },
    });
    // Dispatch does NOT re-poll — it doesn't mutate registry topology.
    expect(captured.some((c) => c.method === "session/list_tools")).toBe(false);
  });

  it("subscribe(cb) fires when the snapshot changes; cb receives NO arguments", async () => {
    const captured: Captured[] = [];
    const handle = toolsHandle(fakeCommandClient(captured), "s1");

    let notified = 0;
    let argCount = -1;
    handle.subscribe((...args: unknown[]) => {
      notified += 1;
      argCount = args.length;
    });

    await waitFor(() => notified > 0);
    expect(argCount).toBe(0);
  });
});
