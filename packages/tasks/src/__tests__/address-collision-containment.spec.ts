/**
 * #315 regression — a TasksHarness address collision is a rejected `ready`,
 * never a process-fatal unhandled rejection.
 *
 * The incident: two same-scopeId harnesses on one inbox. The second's
 * registration fails (`address already registered`), and the old
 * hand-derived sibling barrier (`hydrated = ready.then(...)`) floated that
 * rejection unobserved — Node's unhandled-rejection default killed the
 * whole server. Hydration now chains INTO `ready` via `afterReady`, whose
 * fence the base class owns. Vitest fails any test that leaks an unhandled
 * rejection, so constructing the collision at all is the assertion's teeth.
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { TasksHarness } from "../harness.js";

describe("TasksHarness — address collision containment (#315)", () => {
  it("second same-address harness rejects `ready` (and `hydrated`) — no unhandled rejection", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();

    const first = new TasksHarness("collide", journal, bus, inbox);
    await first.ready;

    const second = new TasksHarness("collide", journal, bus, inbox);
    // Effect wraps the typed failure in a FiberFailure at the runPromise
    // boundary (exactly what the production stack showed) — match the cause.
    await expect(second.ready).rejects.toThrow("address already registered");
    // One readiness truth: `hydrated` is an alias of `ready`, not a sibling.
    expect(second.hydrated).toBe(second.ready);

    // Give a floating rejection a macrotask to surface if one existed —
    // vitest turns it into a test failure.
    await new Promise((r) => setTimeout(r, 10));

    await first.close();
    await second.close().catch(() => {});
  });

  it("hydration failure lands on `ready`, not on a floating promise", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();

    const harness = new TasksHarness("hydrate-fail", journal, bus, inbox, {
      store: {
        list: () => Promise.reject(new Error("store down")),
        get: () => Promise.resolve(undefined),
        put: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      } as never,
    });

    await expect(harness.ready).rejects.toThrow("store down");
    await new Promise((r) => setTimeout(r, 10));
    await harness.close().catch(() => {});
  });
});
