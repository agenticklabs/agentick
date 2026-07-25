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
});
