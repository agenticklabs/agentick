/**
 * `TasksHarness.close()` teardown isolation — the inbox address is released
 * UNCONDITIONALLY.
 *
 * The regression this pins: `close()` does failable work (the cancel cascade
 * reaches an ADOPTER-supplied `TaskExecutor.cancel`, the terminal transition
 * write-throughs reach an ADOPTER-supplied `TaskStore`, and each surviving
 * task's event bus is drained) BEFORE `super.close()` — and `super.close()` is
 * where the harness detaches from its inbox address. A single rejection
 * anywhere in that prelude skipped the detach, so the address stayed claimed
 * for the process lifetime.
 *
 * Nothing above ever saw the failure: `SessionHarness.closeBody` closes every
 * bridge with `.catch(() => undefined)` and `AppHarness.disposeSession`
 * swallows close errors after it has ALREADY dropped the registry entry. The
 * leak only surfaced on the next create-or-resume of the SAME session id,
 * whose fresh `TasksHarness` failed to register with
 * `RoutingFailed: address already registered: tasks:<sessionId>:tasks` — an
 * error about the wrong thing, at the wrong time, permanently.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  MessageInbox,
  TaskExecution,
  TaskExecutor,
  TaskRecord,
  TaskStore,
} from "@agentick/spec";
import { drainRejection } from "@agentick/utils/testing";

import { InMemoryTaskStore } from "../store.js";
import { InProcessTaskExecutor } from "../executor.js";
import { TasksHarness } from "../harness.js";

// ---------------------------------------------------------------------------
// Fixtures — each one fails at a DIFFERENT step of the close cascade
// ---------------------------------------------------------------------------

/** In-process executor whose `cancel` rejects — the close cancel cascade. */
class RejectingCancelExecutor extends InProcessTaskExecutor {
  override cancel(_execution: TaskExecution, _reason?: string): Promise<void> {
    return Promise.reject(new Error("executor cancel blew up"));
  }
}

/** Store whose terminal write-through rejects — the transition inside cancel. */
class RejectingPutStore extends InMemoryTaskStore {
  armed = false;
  override put(record: TaskRecord, ctx: Parameters<TaskStore["put"]>[1]): Promise<void> {
    if (this.armed && record.status === "cancelled") {
      return Promise.reject(new Error("store put blew up"));
    }
    return super.put(record, ctx);
  }
}

function mkHarness(
  scopeId: string,
  inbox: MessageInbox,
  opts: { store?: TaskStore; executors?: readonly TaskExecutor[] } = {},
): TasksHarness {
  return new TasksHarness(scopeId, new MemoryJournal(), new LocalEventBus(), inbox, {
    parentScope: { sessionId: scopeId },
    store: opts.store ?? new InMemoryTaskStore(),
    ...(opts.executors !== undefined ? { executors: opts.executors } : {}),
  });
}

/** True when `address` is FREE — nothing is registered on it. */
async function addressFree(inbox: MessageInbox, address: string): Promise<boolean> {
  const probe = await Effect.runPromise(
    Effect.either(inbox.register(address, () => Effect.succeed(undefined))),
  );
  if (probe._tag === "Right") {
    probe.right(); // release the probe registration
    return true;
  }
  return false;
}

const forever = (): Promise<string> => new Promise<string>(() => {});

// ---------------------------------------------------------------------------

describe("TasksHarness.close — the inbox address is released unconditionally", () => {
  it("releases the address when the executor's cancel rejects", async () => {
    const inbox = new LocalInbox();
    const harness = mkHarness("s-exec:tasks", inbox, {
      executors: [new RejectingCancelExecutor()],
    });
    await harness.hydrated;
    // Claims the address for `tasks:s-exec:tasks`.
    expect(await addressFree(inbox, harness.address)).toBe(false);

    const handle = harness.submit(forever);
    void drainRejection(handle.result);

    // The close still REPORTS the executor failure (pinned below); what this
    // asserts is that reporting it did not cost the detach.
    await harness.close().catch(() => {});

    expect(await addressFree(inbox, "tasks:s-exec:tasks")).toBe(true);
  });

  it("releases the address when the store's terminal write-through rejects", async () => {
    const inbox = new LocalInbox();
    const store = new RejectingPutStore();
    const harness = mkHarness("s-store:tasks", inbox, { store });
    await harness.hydrated;

    const handle = harness.submit(forever);
    void drainRejection(handle.result);
    store.armed = true;

    await harness.close();

    expect(await addressFree(inbox, "tasks:s-store:tasks")).toBe(true);
  });

  it("a throwing step does not skip the REST of the teardown", async () => {
    // The other half of isolation: the failing step is contained, and the
    // steps that follow it still run. Pinned through the ttl sweep — a
    // non-detached task's reaper must be disarmed even though the cancel
    // cascade ahead of it rejected, or a timer fires later against a harness
    // nobody serves.
    const inbox = new LocalInbox();
    const harness = mkHarness("s-rest:tasks", inbox, {
      executors: [new RejectingCancelExecutor()],
    });
    await harness.hydrated;

    const handle = harness.submit(forever, { ttl: 20 });
    const outcome = drainRejection(handle.result);

    await harness.close().catch(() => {});

    // The task still reached its terminal (the cancel cascade's transition
    // lands BEFORE the executor call that rejects)…
    await expect(outcome).resolves.toMatchObject({ status: "cancelled" });
    // …the address is free…
    expect(await addressFree(inbox, "tasks:s-rest:tasks")).toBe(true);
    // …and the disarmed reaper never rewrites the outcome as a timeout.
    await new Promise((r) => setTimeout(r, 60));
    expect(harness.get(handle.taskId)?.status).toBe("cancelled");
  });

  it("close() reports the teardown failures it isolated rather than swallowing them", async () => {
    const inbox = new LocalInbox();
    const harness = mkHarness("s-report:tasks", inbox, {
      executors: [new RejectingCancelExecutor()],
    });
    await harness.hydrated;
    const handle = harness.submit(forever);
    void drainRejection(handle.result);

    // Isolation is not silence. A close that hit a failing step still
    // completes every other step, and still rejects so the caller can log it
    // — the callers that choose to swallow (session bridge fan-out, app
    // dispose) do so explicitly, at their level.
    await expect(harness.close()).rejects.toThrow(/executor cancel blew up/);
    expect(await addressFree(inbox, "tasks:s-report:tasks")).toBe(true);
  });

  it("a second close is a no-op — the address stays free, no double-unregister", async () => {
    const inbox = new LocalInbox();
    const harness = mkHarness("s-twice:tasks", inbox);
    await harness.hydrated;

    await harness.close();
    await harness.close();

    expect(await addressFree(inbox, "tasks:s-twice:tasks")).toBe(true);
  });
});

describe("TasksHarness.close — close before `ready` settles", () => {
  it("releases the address even when close races construction", async () => {
    // `BaseHarness` assigns `inboxUnsubscribe` in a `.then()` off the
    // registration Effect. A close that lands before that microtask must not
    // lose the handle — the harness would otherwise hold the address with
    // nothing left alive to release it.
    const inbox = new LocalInbox();
    const harness = mkHarness("s-race:tasks", inbox);
    // Deliberately NOT awaiting `ready` / `hydrated`.
    await harness.close();

    expect(await addressFree(inbox, "tasks:s-race:tasks")).toBe(true);
  });
});
