/**
 * `promptsHandle` — the client-side prompts resource handle on the
 * `ClientHandle` contract (ADR 87). RPC-backed (no `prompts-state` channel — see
 * the handle doc), so the read side is a poll: an eager `prompts/list` seeds the
 * snapshot and every mutation re-polls. These tests pin the wire request shapes
 * per verb and the poll-then-refold read behavior.
 */

import { describe, expect, it } from "vitest";
import type {
  PromptDeclarationRecord,
  PromptsGetResult,
  WireMethod,
  WireParams,
} from "@agentick/spec";
import { waitFor, waitForStable } from "@agentick/utils/testing";

import { promptsHandle } from "../prompts-handle.js";

interface Captured {
  method: WireMethod;
  params: unknown;
}

const PROMPTS: readonly PromptDeclarationRecord[] = [
  { name: "greet", description: "Say hello", arguments: [{ name: "who", required: true }] },
  { name: "farewell", description: "Say goodbye" },
];

const RENDERED: PromptsGetResult = { description: "Say hello", messages: [] };

/** Fake command client: records every request; scripts list/render/invoke. */
function fakeCommandClient(captured: Captured[], rows: () => readonly PromptDeclarationRecord[]) {
  return {
    transport: {
      async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
        captured.push({ method, params });
        if (method === "prompts/list") return rows();
        if (method === "prompts/render" || method === "prompts/invoke") return RENDERED;
        return null;
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
  const ok = fakeCommandClient(captured, () => PROMPTS);
  let calls = 0;
  return {
    transport: {
      async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
        const first = ++calls === 1;
        if (first) await new Promise((r) => setTimeout(r, 0));
        if (first && opts.failFirst) throw new Error("transport down");
        return ok.transport.request(method, params);
      },
    },
  };
}

describe("promptsHandle — the eager seed", () => {
  it("notifies subscribers when the seed lands — nothing to await at boot", async () => {
    const captured: Captured[] = [];
    const handle = promptsHandle(seedGatedClient(captured), "s1");
    let notified = 0;
    const stop = handle.subscribe(() => {
      notified += 1;
    });

    // Render what you have: the snapshot is empty while the seed is in flight…
    expect(handle.list()).toEqual([]);
    // …and re-render when it arrives. No boot `refresh()`, nothing awaited.
    await waitFor(() => notified > 0);

    expect(handle.list()).toEqual(PROMPTS);
    // ONE poll — the seed. A boot-time `refresh()` would be a second.
    expect(captured).toHaveLength(1);
    stop();
  });

  it("a seed that fails settles the snapshot empty; refresh() recovers it", async () => {
    const captured: Captured[] = [];
    const handle = promptsHandle(seedGatedClient(captured, { failFirst: true }), "s1");

    // A failed seed throws nothing at the caller and leaves no half-filled
    // snapshot — it settles empty, which is what the read surface then reports.
    expect(await waitForStable(() => handle.list())).toEqual([]);

    await handle.refresh();
    expect(handle.list()).toEqual(PROMPTS);
  });
});

describe("promptsHandle", () => {
  it("list()/get() reflect the eager prompts/list poll", async () => {
    const captured: Captured[] = [];
    const handle = promptsHandle(
      fakeCommandClient(captured, () => PROMPTS),
      "s1",
    );

    await waitFor(() => handle.list().length > 0);

    expect(handle.list()).toEqual(PROMPTS);
    expect(handle.get("greet")).toMatchObject({ name: "greet", description: "Say hello" });
    expect(handle.get("nope")).toBeUndefined();
    expect(captured[0]).toEqual({ method: "prompts/list", params: { sessionId: "s1" } });
  });

  it("render(input) rides prompts/render and does NOT re-poll", async () => {
    const captured: Captured[] = [];
    const handle = promptsHandle(
      fakeCommandClient(captured, () => PROMPTS),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    const out = await handle.render({ name: "greet", args: { who: "world" } });

    expect(captured[0]).toEqual({
      method: "prompts/render",
      params: { sessionId: "s1", name: "greet", args: { who: "world" } },
    });
    expect(out).toEqual(RENDERED);
    expect(captured.some((c) => c.method === "prompts/list")).toBe(false);
  });

  it("invoke(input) rides prompts/invoke", async () => {
    const captured: Captured[] = [];
    const handle = promptsHandle(
      fakeCommandClient(captured, () => PROMPTS),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    const out = await handle.invoke({ name: "greet", args: { who: "world" } });

    expect(captured[0]).toEqual({
      method: "prompts/invoke",
      params: { sessionId: "s1", name: "greet", args: { who: "world" } },
    });
    expect(out).toEqual(RENDERED);
  });

  it("register(input) issues prompts/register then re-polls", async () => {
    const captured: Captured[] = [];
    const handle = promptsHandle(
      fakeCommandClient(captured, () => PROMPTS),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    await handle.register({ declaration: { name: "n", description: "d" } });

    expect(captured[0]).toEqual({
      method: "prompts/register",
      params: { sessionId: "s1", declaration: { name: "n", description: "d" } },
    });
    expect(captured.some((c) => c.method === "prompts/list")).toBe(true);
  });

  it("remove(input) issues prompts/remove {sessionId, name} then re-polls", async () => {
    const captured: Captured[] = [];
    const handle = promptsHandle(
      fakeCommandClient(captured, () => PROMPTS),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    await handle.remove({ name: "greet" });

    expect(captured[0]).toEqual({
      method: "prompts/remove",
      params: { sessionId: "s1", name: "greet" },
    });
    expect(captured.some((c) => c.method === "prompts/list")).toBe(true);
  });

  it("subscribe(cb) fires when the snapshot changes; cb receives NO arguments", async () => {
    const captured: Captured[] = [];
    const handle = promptsHandle(
      fakeCommandClient(captured, () => PROMPTS),
      "s1",
    );

    let notified = 0;
    let argCount = -1;
    handle.subscribe((...args: unknown[]) => {
      notified += 1;
      argCount = args.length;
    });

    await waitFor(() => notified > 0);
    expect(notified).toBeGreaterThan(0);
    expect(argCount).toBe(0);
  });
});
