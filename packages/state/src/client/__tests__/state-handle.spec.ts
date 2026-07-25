/**
 * `stateHandle` — the client-side state resource handle on the `ClientHandle`
 * contract (ADR 87). RPC-backed (no `state-state` channel — see the handle
 * doc), so the read side is a poll: an eager `state/list` seeds the snapshot and
 * every mutation re-polls. These tests pin the wire request shapes per verb and
 * the poll-then-refold read behavior.
 */

import { describe, expect, it } from "vitest";
import type { StateListEntry, WireMethod, WireParams } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { stateHandle } from "../state-handle.js";

interface Captured {
  method: WireMethod;
  params: unknown;
}

/** Fake command client: records every request; `state/list` returns the scripted rows. */
function fakeCommandClient(captured: Captured[], rows: () => readonly StateListEntry[]) {
  return {
    transport: {
      async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
        captured.push({ method, params });
        if (method === "state/list") return rows();
        return null;
      },
    },
  };
}

const ENTRIES: readonly StateListEntry[] = [
  { key: "cursor", value: 3 },
  { key: "draft", value: "hello" },
];

describe("stateHandle", () => {
  it("list()/get() reflect the eager state/list poll", async () => {
    const captured: Captured[] = [];
    const handle = stateHandle(
      fakeCommandClient(captured, () => ENTRIES),
      "s1",
    );

    await waitFor(() => handle.list().length > 0);

    expect(handle.list()).toEqual(ENTRIES);
    expect(handle.get("cursor")).toEqual({ key: "cursor", value: 3 });
    expect(handle.get("nope")).toBeUndefined();
    expect(captured[0]).toEqual({ method: "state/list", params: { sessionId: "s1" } });
  });

  it("set(key, value) issues state/set { sessionId, key, value } then re-polls", async () => {
    const captured: Captured[] = [];
    const handle = stateHandle(
      fakeCommandClient(captured, () => ENTRIES),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    await handle.set("cursor", 4);

    expect(captured[0]).toEqual({
      method: "state/set",
      params: { sessionId: "s1", key: "cursor", value: 4 },
    });
    // Fire-and-refetch: a `state/list` follows the mutation.
    expect(captured.some((c) => c.method === "state/list")).toBe(true);
  });

  it("delete(key) issues state/delete { sessionId, key } then re-polls", async () => {
    const captured: Captured[] = [];
    const handle = stateHandle(
      fakeCommandClient(captured, () => ENTRIES),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    await handle.delete("draft");

    expect(captured[0]).toEqual({
      method: "state/delete",
      params: { sessionId: "s1", key: "draft" },
    });
    expect(captured.some((c) => c.method === "state/list")).toBe(true);
  });

  it("refresh() forces a state/list re-poll and resolves the fresh snapshot", async () => {
    const captured: Captured[] = [];
    const handle = stateHandle(
      fakeCommandClient(captured, () => ENTRIES),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    const rows = await handle.refresh();

    expect(rows).toEqual(ENTRIES);
    expect(captured[0]).toEqual({ method: "state/list", params: { sessionId: "s1" } });
  });

  it("subscribe(cb) fires when the snapshot changes; cb receives NO arguments", async () => {
    const captured: Captured[] = [];
    const handle = stateHandle(
      fakeCommandClient(captured, () => ENTRIES),
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
