/**
 * `skillsHandle` — the client-side skills resource handle on the `ClientHandle`
 * contract (ADR 87). RPC-backed (no `skills-state` channel — see the handle
 * doc), so the read side is a poll: an eager `skills/list` seeds the snapshot and
 * every mutation re-polls. These tests pin the wire request shapes per verb and
 * the poll-then-refold read behavior.
 */

import { describe, expect, it } from "vitest";
import type { Skill, WireMethod, WireParams } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { skillsHandle } from "../skills-handle.js";

interface Captured {
  method: WireMethod;
  params: unknown;
}

const SKILLS: readonly Skill[] = [
  {
    name: "review",
    description: "Review a change",
    content: "# Review\n…",
    tags: ["code"],
    updatedAt: 2,
    createdAt: 1,
  },
  {
    name: "summarize",
    description: "Summarize text",
    content: "# Summarize\n…",
    updatedAt: 4,
    createdAt: 3,
  },
];

/** Fake command client: records every request; scripts `skills/list` + `skills/search`. */
function fakeCommandClient(captured: Captured[], rows: () => readonly Skill[]) {
  return {
    transport: {
      async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
        captured.push({ method, params });
        if (method === "skills/list") return rows();
        if (method === "skills/search") return [rows()[0]];
        return null;
      },
    },
  };
}

describe("skillsHandle", () => {
  it("list()/get() reflect the eager skills/list poll", async () => {
    const captured: Captured[] = [];
    const handle = skillsHandle(
      fakeCommandClient(captured, () => SKILLS),
      "s1",
    );

    await waitFor(() => handle.list().length > 0);

    expect(handle.list()).toEqual(SKILLS);
    expect(handle.get("summarize")).toMatchObject({
      name: "summarize",
      description: "Summarize text",
    });
    expect(handle.get("nope")).toBeUndefined();
    expect(captured[0]).toEqual({ method: "skills/list", params: { sessionId: "s1" } });
  });

  it("register(input) issues skills/register {sessionId, ...input} then re-polls", async () => {
    const captured: Captured[] = [];
    const handle = skillsHandle(
      fakeCommandClient(captured, () => SKILLS),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    await handle.register({ name: "x", description: "d", content: "c" });

    expect(captured[0]).toEqual({
      method: "skills/register",
      params: { sessionId: "s1", name: "x", description: "d", content: "c" },
    });
    // Fire-and-refetch: a `skills/list` follows the mutation.
    expect(captured.some((c) => c.method === "skills/list")).toBe(true);
  });

  it("update(input) issues skills/update then re-polls", async () => {
    const captured: Captured[] = [];
    const handle = skillsHandle(
      fakeCommandClient(captured, () => SKILLS),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    await handle.update({ name: "review", description: "d2" });

    expect(captured[0]).toEqual({
      method: "skills/update",
      params: { sessionId: "s1", name: "review", description: "d2" },
    });
    expect(captured.some((c) => c.method === "skills/list")).toBe(true);
  });

  it("remove(input) issues skills/remove {sessionId, name} then re-polls", async () => {
    const captured: Captured[] = [];
    const handle = skillsHandle(
      fakeCommandClient(captured, () => SKILLS),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    await handle.remove({ name: "review" });

    expect(captured[0]).toEqual({
      method: "skills/remove",
      params: { sessionId: "s1", name: "review" },
    });
    expect(captured.some((c) => c.method === "skills/list")).toBe(true);
  });

  it("search(input) rides skills/search and does NOT mutate the snapshot", async () => {
    const captured: Captured[] = [];
    const handle = skillsHandle(
      fakeCommandClient(captured, () => SKILLS),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    const hits = await handle.search({ query: "rev" });

    expect(captured[0]).toEqual({
      method: "skills/search",
      params: { sessionId: "s1", query: "rev" },
    });
    expect(hits).toEqual([SKILLS[0]]);
    // No re-poll — search is a query, not a mutation.
    expect(captured.some((c) => c.method === "skills/list")).toBe(false);
    // Snapshot unchanged.
    expect(handle.list()).toEqual(SKILLS);
  });

  it("subscribe(cb) fires when the snapshot changes; cb receives NO arguments", async () => {
    const captured: Captured[] = [];
    const handle = skillsHandle(
      fakeCommandClient(captured, () => SKILLS),
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
