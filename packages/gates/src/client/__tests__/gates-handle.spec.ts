/**
 * `gatesHandle` — the client-side gates resource handle on the `ClientHandle`
 * contract (ADR 87). RPC-backed (no `gates-state` channel yet — see the handle
 * doc), so the read side is a poll: an eager `gates/list` seeds the snapshot and
 * every mutation re-polls. These tests pin the wire request shapes per verb and
 * the poll-then-refold read behavior.
 */

import { describe, expect, it } from "vitest";
import type { WireMethod, WireParams } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { gatesHandle } from "../gates-handle.js";
import type { GateInfo } from "../../controller.js";

interface Captured {
  method: WireMethod;
  params: unknown;
}

/** Fake command client: records every request; `gates/list` returns the scripted rows. */
function fakeCommandClient(captured: Captured[], rows: () => readonly GateInfo[]) {
  return {
    transport: {
      async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
        captured.push({ method, params });
        if (method === "gates/list") return rows();
        return null;
      },
    },
  };
}

const GATES: readonly GateInfo[] = [
  { name: "review", value: "active", verified: false, description: "Await review" },
  { name: "inv", value: "inactive", verified: true, description: "Invariant" },
];

describe("gatesHandle", () => {
  it("list()/get() reflect the eager gates/list poll", async () => {
    const captured: Captured[] = [];
    const handle = gatesHandle(
      fakeCommandClient(captured, () => GATES),
      "s1",
    );

    await waitFor(() => handle.list().length > 0);

    expect(handle.list()).toEqual(GATES);
    expect(handle.get("inv")).toMatchObject({ name: "inv", verified: true, value: "inactive" });
    expect(handle.get("nope")).toBeUndefined();
    expect(captured[0]).toEqual({ method: "gates/list", params: { sessionId: "s1" } });
  });

  it("clear(name) issues gates/clear { sessionId, name } then re-polls", async () => {
    const captured: Captured[] = [];
    const handle = gatesHandle(
      fakeCommandClient(captured, () => GATES),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    await handle.clear("review");

    expect(captured[0]).toEqual({
      method: "gates/clear",
      params: { sessionId: "s1", name: "review" },
    });
    // Fire-and-refetch: a `gates/list` follows the mutation.
    expect(captured.some((c) => c.method === "gates/list")).toBe(true);
  });

  it("defer(name, reason) issues gates/defer with the reason", async () => {
    const captured: Captured[] = [];
    const handle = gatesHandle(
      fakeCommandClient(captured, () => GATES),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    await handle.defer("review", "later");

    expect(captured[0]).toEqual({
      method: "gates/defer",
      params: { sessionId: "s1", name: "review", reason: "later" },
    });
  });

  it("override(name, value, reason) issues gates/override with the full params", async () => {
    const captured: Captured[] = [];
    const handle = gatesHandle(
      fakeCommandClient(captured, () => GATES),
      "s1",
    );
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    await handle.override("inv", "inactive", "manual unblock");

    expect(captured[0]).toEqual({
      method: "gates/override",
      params: { sessionId: "s1", name: "inv", value: "inactive", reason: "manual unblock" },
    });
  });

  it("subscribe(cb) fires when the snapshot changes; cb receives NO arguments", async () => {
    const captured: Captured[] = [];
    const handle = gatesHandle(
      fakeCommandClient(captured, () => GATES),
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
