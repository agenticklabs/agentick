import { describe, expect, it } from "vitest";

import { RequestResponseRegistry } from "../substrate/request-response-registry.js";

describe("RequestResponseRegistry — happy path", () => {
  it("register → resolve fires the promise with the response payload", async () => {
    const r = new RequestResponseRegistry<{ ok: boolean }>();
    const { correlationId, promise } = r.register({ correlationId: "c1" });
    expect(r.size()).toBe(1);
    expect(r.resolve(correlationId, { ok: true })).toBe(true);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(r.size()).toBe(0);
  });

  it("resolve on unknown id is a no-op returning false", () => {
    const r = new RequestResponseRegistry();
    expect(r.resolve("nope", {})).toBe(false);
  });
});

describe("RequestResponseRegistry — timeout", () => {
  it("rejects with RequestTimeoutError after the configured duration", async () => {
    const r = new RequestResponseRegistry();
    const { promise } = r.register({ correlationId: "c-timeout", timeoutMs: 25 });
    await expect(promise).rejects.toMatchObject({
      _tag: "RequestTimeoutError",
      correlationId: "c-timeout",
    });
    expect(r.size()).toBe(0);
  });

  it("clears the timeout when resolve fires first", async () => {
    const r = new RequestResponseRegistry<string>();
    const { promise } = r.register({ correlationId: "c-race", timeoutMs: 100 });
    r.resolve("c-race", "fast");
    await expect(promise).resolves.toBe("fast");
    // Wait beyond the timeout to ensure no stray rejection fires.
    await new Promise((res) => setTimeout(res, 150));
    expect(r.size()).toBe(0);
  });
});

describe("RequestResponseRegistry — signal abort", () => {
  it("rejects with RequestAbortedError when signal fires", async () => {
    const r = new RequestResponseRegistry();
    const ctrl = new AbortController();
    const { promise } = r.register({
      correlationId: "c-abort",
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort("user cancel"), 10);
    await expect(promise).rejects.toMatchObject({
      _tag: "RequestAbortedError",
      correlationId: "c-abort",
    });
  });

  it("rejects immediately when signal is already aborted", async () => {
    const r = new RequestResponseRegistry();
    const ctrl = new AbortController();
    ctrl.abort("preemptive");
    const { promise } = r.register({
      correlationId: "c-pre",
      signal: ctrl.signal,
    });
    await expect(promise).rejects.toMatchObject({
      _tag: "RequestAbortedError",
    });
  });
});

describe("RequestResponseRegistry — cancel + cancelAll", () => {
  it("cancel rejects with RequestCancelledError", async () => {
    const r = new RequestResponseRegistry();
    const { promise } = r.register({ correlationId: "c-cancel" });
    expect(r.cancel("c-cancel", "shutting down")).toBe(true);
    await expect(promise).rejects.toMatchObject({
      _tag: "RequestCancelledError",
      reason: "shutting down",
    });
  });

  it("cancelAll drains every pending entry", async () => {
    const r = new RequestResponseRegistry();
    const a = r.register({ correlationId: "a" }).promise;
    const b = r.register({ correlationId: "b" }).promise;
    expect(r.size()).toBe(2);
    r.cancelAll("close");
    await expect(a).rejects.toMatchObject({ _tag: "RequestCancelledError" });
    await expect(b).rejects.toMatchObject({ _tag: "RequestCancelledError" });
    expect(r.size()).toBe(0);
  });
});
