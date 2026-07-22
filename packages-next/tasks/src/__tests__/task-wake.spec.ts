/**
 * TASK-WAKE seam — the tasks-harness fire side + consume-on-observe dedup.
 *
 * A backgrounded (Pattern B) task that reaches a terminal state UNOBSERVED
 * synthesizes exactly ONE follow-up send into its owning session (a fire-and-
 * forget `inbox.send` to `session:{sessionId}` carrying bounded completion
 * metadata — NO raw output). The wake is CONSUMED (never fires) when the
 * completion is seen in-band first (`result`/`await`, or a terminal `get`/
 * `status`), or when the task is cancelled / the harness is closing.
 *
 * These tests exercise the tasks-side machinery in isolation: they register a
 * capture handler at the session inbox address and assert exactly-once between
 * the in-band and out-of-band paths. The end-to-end proof that the wake rides
 * the REAL `session.send` path (journaled execution + provenance + steering
 * when an execution is running) lives in
 * `@agentick/session-next` (cross-harness integration).
 */

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionTaskWakePayload } from "@agentick/runtime-next";
import type { TaskWakePolicy } from "@agentick/spec-next";
import { waitFor, waitForStable } from "@agentick/utils-next/testing";

import { fakeTasks, type FakeTasksBundle } from "../testing/fake-tasks.js";

const SESSION_ID = "s-wake";
const SESSION_ADDR = `session:${SESSION_ID}`;

interface WakeHarness {
  readonly bundle: FakeTasksBundle;
  /** Every wake envelope the session address received. */
  readonly wakes: SessionTaskWakePayload[];
}

/** fakeTasks scoped to a session, with a capture handler on the session inbox. */
async function mkWakeHarness(
  opts: { defaultWake?: TaskWakePolicy; register?: boolean } = {},
): Promise<WakeHarness> {
  const bundle = await fakeTasks({
    sessionId: SESSION_ID,
    ...(opts.defaultWake !== undefined ? { defaultWake: opts.defaultWake } : {}),
  });
  const wakes: SessionTaskWakePayload[] = [];
  if (opts.register !== false) {
    await Effect.runPromise(
      bundle.inbox.register(SESSION_ADDR, (msg) => {
        wakes.push(msg.payload as SessionTaskWakePayload);
        return Effect.succeed(undefined);
      }),
    );
  }
  return { bundle, wakes };
}

/** Yield past the `setImmediate` deferral so an un-consumed wake can fire. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("TASK-WAKE — unobserved completion fires exactly one wake", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("an unobserved completed task synthesizes exactly one wake with bounded metadata (no raw output)", async () => {
    const { bundle, wakes } = await mkWakeHarness();
    close = bundle.close;

    const handle = bundle.harness.submit(async () => [{ type: "text", text: "SECRET-OUTPUT" }], {
      wake: true,
    });
    // The originator's `handle.result` await does NOT consume the wake — only
    // the by-id in-band reads do. So awaiting it still leaves the wake armed.
    await handle.result;

    const found = await waitFor(() => (wakes.length >= 1 ? wakes : false), {
      description: "one wake delivered",
    });
    // Stays at exactly one — no duplicate fire.
    await waitForStable(() => wakes.length, { stableMs: 30 });

    expect(found).toHaveLength(1);
    const wake = found[0]!;
    expect(wake.taskId).toBe(handle.taskId);
    expect(wake.outcome).toMatchObject({ taskId: handle.taskId, status: "completed" });
    expect(wake.outcome.durationMs).toBeGreaterThanOrEqual(0);
    // Bounded: the wake NEVER carries the raw result blocks.
    const serialized = JSON.stringify(wake);
    expect(serialized).not.toContain("SECRET-OUTPUT");
    // Provenance + the default bounded-metadata message.
    expect(wake.send.metadata).toMatchObject({ source: "task-wake", taskId: handle.taskId });
    const msg = wake.send.messages?.[0];
    expect(msg?.role).toBe("user");
    expect(String(msg?.content)).toContain(handle.taskId);
    expect(msg?.metadata).toMatchObject({ source: "task-wake", taskId: handle.taskId });
  });

  it("a failed task wakes too (bounded failure metadata, still no raw output)", async () => {
    const { bundle, wakes } = await mkWakeHarness();
    close = bundle.close;

    const handle = bundle.harness.submit(
      async () => {
        throw new Error("kaboom-detail");
      },
      { wake: true },
    );
    await handle.result.catch(() => undefined);

    const found = await waitFor(() => (wakes.length >= 1 ? wakes : false));
    await waitForStable(() => wakes.length, { stableMs: 30 });
    expect(found).toHaveLength(1);
    expect(found[0]!.outcome.status).toBe("failed");
  });
});

describe("TASK-WAKE — consume-on-observe (observed-first → NO wake)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("await (result-by-id) before completion consumes the wake — the in-band path delivers it", async () => {
    const { bundle, wakes } = await mkWakeHarness();
    close = bundle.close;

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handle = bundle.harness.submit(
      async () => {
        await gate;
        return [{ type: "text", text: "x" }];
      },
      { wake: true },
    );
    // Register the in-band observer WHILE the task is still working — this
    // pre-empts the terminal transition, so `settle` never schedules a wake.
    const awaited = bundle.harness.result(handle.taskId);
    release();
    await awaited;

    await waitForStable(() => wakes.length, { stableMs: 40 });
    expect(wakes).toHaveLength(0);
  });

  it("a terminal get() in the deferral window consumes the wake (the get-first race resolution)", async () => {
    const { bundle, wakes } = await mkWakeHarness();
    close = bundle.close;

    const handle = bundle.harness.submit(async () => [{ type: "text", text: "x" }], { wake: true });
    // `await handle.result` resolves on a microtask; the deferred fire is a
    // macrotask (setImmediate). So a synchronous get() here runs BEFORE the
    // fire and observes the terminal snapshot → consumes.
    await handle.result;
    const info = bundle.harness.get(handle.taskId);
    expect(info?.status).toBe("completed");

    await waitForStable(() => wakes.length, { stableMs: 40 });
    expect(wakes).toHaveLength(0);
  });

  it("a terminal status() read likewise consumes the wake", async () => {
    const { bundle, wakes } = await mkWakeHarness();
    close = bundle.close;

    const handle = bundle.harness.submit(async () => "x", { wake: true });
    await handle.result;
    expect(bundle.harness.status(handle.taskId)).toBe("completed");

    await waitForStable(() => wakes.length, { stableMs: 40 });
    expect(wakes).toHaveLength(0);
  });

  it("an explicit cancel consumes the wake (the canceller is already aware)", async () => {
    const { bundle, wakes } = await mkWakeHarness();
    close = bundle.close;

    const handle = bundle.harness.submit(
      async ({ signal }) => {
        await new Promise<void>((_res, rej) =>
          signal.addEventListener("abort", () => rej(new Error("aborted"))),
        );
        return "x";
      },
      { wake: true },
    );
    await new Promise((r) => setTimeout(r, 0));
    await bundle.harness.cancel(handle.taskId, "user-cancel");
    await handle.result.catch(() => undefined);

    await waitForStable(() => wakes.length, { stableMs: 40 });
    expect(wakes).toHaveLength(0);
  });
});

describe("TASK-WAKE — the race collapses to exactly one outcome", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("observe-before-fire → zero wakes; let-fire-then-observe → exactly one wake", async () => {
    // Ordering A — observe wins (get in the deferral window).
    {
      const { bundle, wakes } = await mkWakeHarness();
      const handle = bundle.harness.submit(async () => "x", { wake: true });
      await handle.result;
      bundle.harness.get(handle.taskId); // consume before the deferred fire
      await waitForStable(() => wakes.length, { stableMs: 30 });
      expect(wakes).toHaveLength(0);
      await bundle.close();
    }
    // Ordering B — fire wins (yield past the deferral, THEN observe).
    {
      const { bundle, wakes } = await mkWakeHarness();
      close = bundle.close;
      const handle = bundle.harness.submit(async () => "x", { wake: true });
      await handle.result;
      await nextTurn(); // let the deferred fire run
      const observedAfter = bundle.harness.get(handle.taskId); // no-op — already fired
      expect(observedAfter?.status).toBe("completed");
      await waitForStable(() => wakes.length, { stableMs: 30 });
      expect(wakes).toHaveLength(1);
    }
  });
});

describe("TASK-WAKE — callable policy shapes / suppresses", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("a callable policy shapes the wake send", async () => {
    const { bundle, wakes } = await mkWakeHarness();
    close = bundle.close;

    const handle = bundle.harness.submit(async () => "x", {
      wake: (outcome) => ({
        messages: [{ role: "user", content: `shaped:${outcome.status}:${outcome.taskId}` }],
        maxTicks: 3,
      }),
    });
    await handle.result;

    const found = await waitFor(() => (wakes.length >= 1 ? wakes : false));
    await waitForStable(() => wakes.length, { stableMs: 30 });
    expect(found).toHaveLength(1);
    expect(String(found[0]!.send.messages?.[0]?.content)).toBe(`shaped:completed:${handle.taskId}`);
    expect(found[0]!.send.maxTicks).toBe(3);
  });

  it("a callable policy returning null suppresses the wake entirely", async () => {
    const { bundle, wakes } = await mkWakeHarness();
    close = bundle.close;

    const handle = bundle.harness.submit(async () => "x", { wake: () => null });
    await handle.result;
    await nextTurn();
    await waitForStable(() => wakes.length, { stableMs: 30 });
    expect(wakes).toHaveLength(0);
  });
});

describe("TASK-WAKE — session-level default policy", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("defaultWake:true wakes a task that did not opt in per-submit", async () => {
    const { bundle, wakes } = await mkWakeHarness({ defaultWake: true });
    close = bundle.close;

    const handle = bundle.harness.submit(async () => "x"); // no per-submit wake
    await handle.result;

    const found = await waitFor(() => (wakes.length >= 1 ? wakes : false));
    await waitForStable(() => wakes.length, { stableMs: 30 });
    expect(found).toHaveLength(1);
  });

  it("per-submit wake:false overrides a truthy default", async () => {
    const { bundle, wakes } = await mkWakeHarness({ defaultWake: true });
    close = bundle.close;

    const handle = bundle.harness.submit(async () => "x", { wake: false });
    await handle.result;
    await nextTurn();
    await waitForStable(() => wakes.length, { stableMs: 30 });
    expect(wakes).toHaveLength(0);
  });
});

describe("TASK-WAKE — close cancels pending wakes (no zombie sends)", () => {
  it("closing before the deferred fire drops the pending wake", async () => {
    const { bundle, wakes } = await mkWakeHarness();
    const handle = bundle.harness.submit(async () => "x", { wake: true });
    await handle.result; // settle scheduled the deferred fire
    await bundle.close(); // clears the pending wake timer BEFORE it fires
    await waitForStable(() => wakes.length, { stableMs: 40 });
    expect(wakes).toHaveLength(0);
    void handle;
  });

  it("close-cancelled in-flight tasks never wake", async () => {
    const { bundle, wakes } = await mkWakeHarness();
    const handle = bundle.harness.submit(
      async ({ signal }) => {
        await new Promise<void>((_res, rej) =>
          signal.addEventListener("abort", () => rej(new Error("aborted"))),
        );
        return "x";
      },
      { wake: true },
    );
    handle.result.catch(() => undefined); // drain the close-driven cancel rejection
    await new Promise((r) => setTimeout(r, 0));
    await bundle.close(); // cancels the in-flight task (→ cancelled → observed)
    await waitForStable(() => wakes.length, { stableMs: 40 });
    expect(wakes).toHaveLength(0);
  });
});

describe("TASK-WAKE — eviction / missing session address is a benign drop", () => {
  it("a wake to an unregistered session address does not throw and leaves the harness usable", async () => {
    // register:false — nothing is listening at session:{id} (an evicted /
    // torn-down session). The wake's inbox.send fails AddressNotFound and the
    // harness swallows it.
    const { bundle } = await mkWakeHarness({ register: false });
    try {
      const handle = bundle.harness.submit(async () => "x", { wake: true });
      await handle.result;
      await nextTurn();
      // Harness still works after the dropped wake.
      const again = bundle.harness.submit(async () => "y");
      expect(await again.result).toBe("y");
    } finally {
      await bundle.close();
    }
  });
});
