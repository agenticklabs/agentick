/**
 * `waitFor` / `waitForStable` — the two async-settling primitives every
 * transport, cluster, and delivery test in the workspace depends on. Nothing
 * pinned their contracts before this file, so a regression here would surface as
 * mysterious flakiness spread across dozens of unrelated suites.
 *
 * Pinned here: the SYNCHRONOUS first check (a condition already true costs zero
 * timers), truthy-value passthrough, the timeout message shape, and — for
 * `waitForStable` — that it returns only after a QUIET PERIOD, compares
 * snapshots by VALUE (a fresh object with equal content is stable), survives an
 * unserializable snapshot, and rejects when the snapshot never settles.
 *
 * Real timers, small budgets: these test the real implementation, and fake
 * timers would stub out the very `setTimeout` polling under test.
 */

import { describe, expect, it } from "vitest";

import { waitFor, waitForStable } from "../testing/wait-for.js";

describe("waitFor", () => {
  it("returns the truthy value without polling when the condition is already true", async () => {
    let calls = 0;
    const value = await waitFor(() => {
      calls++;
      return "ready";
    });
    expect(value).toBe("ready");
    // The synchronous pre-check is the whole point — one call, no timer.
    expect(calls).toBe(1);
  });

  it("preserves object identity of the resolved value", async () => {
    const element = { id: "e_1" };
    const found = await waitFor(() => element);
    expect(found).toBe(element);
  });

  it("resolves once the condition becomes true", async () => {
    let flag = false;
    setTimeout(() => {
      flag = true;
    }, 15);
    const value = await waitFor(() => flag, { pollMs: 2, timeoutMs: 500 });
    expect(value).toBe(true);
  });

  it("keeps polling while the condition returns false / null / undefined", async () => {
    const returns: (false | null | undefined | string)[] = [false, null, undefined, "done"];
    let i = 0;
    const value = await waitFor(() => returns[i++], { pollMs: 1, timeoutMs: 500 });
    expect(value).toBe("done");
    expect(i).toBe(4);
  });

  it("rejects with the description and the budget when the condition never holds", async () => {
    await expect(
      waitFor(() => false, { timeoutMs: 20, pollMs: 5, description: "inbox drained" }),
    ).rejects.toThrow("waitFor: inbox drained did not become true within 20ms");
  });

  it("names the condition generically when no description is given", async () => {
    await expect(waitFor(() => false, { timeoutMs: 15, pollMs: 5 })).rejects.toThrow(
      "waitFor: condition did not become true within 15ms",
    );
  });

  it("respects the timeout budget (does not return early or hang)", async () => {
    const start = Date.now();
    await expect(waitFor(() => false, { timeoutMs: 40, pollMs: 5 })).rejects.toThrow(
      "did not become true within 40ms",
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(35);
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("waitForStable", () => {
  it("returns only after the snapshot has been quiet for stableMs", async () => {
    const received: string[] = [];
    setTimeout(() => received.push("a"), 5);
    setTimeout(() => received.push("b"), 25);

    const start = Date.now();
    const final = await waitForStable(() => [...received], {
      pollMs: 2,
      stableMs: 30,
      timeoutMs: 2_000,
    });
    const elapsed = Date.now() - start;

    expect(final).toEqual(["a", "b"]);
    // The last change landed at ~25ms, so a 30ms quiet period cannot have
    // elapsed before ~55ms — this is the claim that separates "stable" from
    // "one lucky poll".
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it("treats a fresh object with equal content as unchanged (compares by value)", async () => {
    // A snapshot that allocates a new object every poll would never look
    // stable under identity comparison.
    const handedOut: { readonly n: number }[] = [];
    const final = await waitForStable(
      () => {
        const snap = { n: 1 };
        handedOut.push(snap);
        return snap;
      },
      { pollMs: 2, stableMs: 15, timeoutMs: 1_000 },
    );
    expect(final).toEqual({ n: 1 });
    // The returned value is a FRESH snapshot taken after settling, not the
    // cached first one.
    expect(final).toBe(handedOut[handedOut.length - 1]);
    expect(final).not.toBe(handedOut[0]);
  });

  it("settles on an unserializable snapshot instead of throwing", async () => {
    interface Cyclic {
      self?: Cyclic;
    }
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    const final = await waitForStable(() => cyclic, {
      pollMs: 2,
      stableMs: 15,
      timeoutMs: 1_000,
    });
    expect(final).toBe(cyclic);
  });

  it("settles immediately-quiet primitives", async () => {
    const final = await waitForStable(() => 7, { pollMs: 2, stableMs: 10, timeoutMs: 1_000 });
    expect(final).toBe(7);
  });

  it("rejects when the snapshot never stops changing", async () => {
    let n = 0;
    await expect(
      waitForStable(() => n++, {
        pollMs: 2,
        stableMs: 25,
        timeoutMs: 60,
        description: "delivery count",
      }),
    ).rejects.toThrow("waitForStable: delivery count never stabilized within 60ms");
  });
});
