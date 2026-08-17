/**
 * ADR 87 — the client sub-handle registry: `registerSessionHandleExtension`
 * contributes a factory; `applySessionHandleExtensions` spreads each as a LAZY,
 * cached getter that never shadows a real handle member.
 */

import { describe, expect, it } from "vitest";
import type { ClientProtocol } from "@agentick/spec";

import {
  registerSessionHandleExtension,
  applySessionHandleExtensions,
  registeredSessionHandleExtensions,
} from "../session-handle-extensions.js";

const fakeClient = {} as ClientProtocol;

describe("session handle extension registry (ADR 87)", () => {
  it("spreads a registered sub-handle as a lazy, cached getter with (client, id)", () => {
    let calls = 0;
    registerSessionHandleExtension("__test_lazy__", (client, id) => {
      calls++;
      return { gotClient: client, gotId: id, marker: "sub" };
    });
    expect(registeredSessionHandleExtensions()).toContain("__test_lazy__");

    const handle: Record<string, unknown> = { id: "s1" };
    applySessionHandleExtensions(handle, fakeClient, "s1");

    expect(calls).toBe(0); // lazy — factory NOT run at spread time
    const sub = handle.__test_lazy__ as { gotClient: unknown; gotId: string; marker: string };
    expect(calls).toBe(1); // …built on first access
    expect(sub.marker).toBe("sub");
    expect(sub.gotId).toBe("s1");
    expect(sub.gotClient).toBe(fakeClient);

    void handle.__test_lazy__;
    expect(calls).toBe(1); // cached — not rebuilt on subsequent access
  });

  it("never shadows an existing handle member", () => {
    registerSessionHandleExtension("__test_shadow__", () => "SHOULD_NOT_WIN");
    const handle: Record<string, unknown> = { __test_shadow__: "real" };
    applySessionHandleExtensions(handle, fakeClient, "s1");
    expect(handle.__test_shadow__).toBe("real");
  });

  it("a closed slot revives: the next access builds a fresh, working instance", () => {
    let builds = 0;
    registerSessionHandleExtension("__test_revive__", () => {
      const build = ++builds;
      let closed = false;
      return {
        build,
        isClosed: () => closed,
        close: () => {
          closed = true;
        },
      };
    });
    const handle: Record<string, unknown> = { id: "s1" };
    applySessionHandleExtensions(handle, fakeClient, "s1");

    type Slot = { build: number; isClosed: () => boolean; close: () => void };
    const first = handle.__test_revive__ as Slot;
    first.close();
    expect(first.isClosed()).toBe(true);

    // Session handles are memoized per client, so this is what a LATER visit
    // to the same session receives — it must not inherit the corpse.
    const second = handle.__test_revive__ as Slot;
    expect(builds).toBe(2);
    expect(second.build).toBe(2);
    expect(second.isClosed()).toBe(false);
  });

  it("handle teardown closes both the closed-and-revived and the live instance", () => {
    const closes: number[] = [];
    let builds = 0;
    registerSessionHandleExtension("__test_revive_teardown__", () => {
      const build = ++builds;
      return { build, close: () => closes.push(build) };
    });
    const handle: Record<string, unknown> = { id: "s1" };
    const teardown = applySessionHandleExtensions(handle, fakeClient, "s1");

    (handle.__test_revive_teardown__ as { close: () => void }).close();
    void handle.__test_revive_teardown__;
    expect(closes).toEqual([1]);

    expect(teardown()).toEqual([]);
    // Build 1 closes twice (adopter, then teardown) — sub-handle closes are
    // idempotent by contract; the invariant here is build 2 is not orphaned.
    expect(closes).toEqual([1, 1, 2]);
  });
});
