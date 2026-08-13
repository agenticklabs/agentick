/**
 * Create-or-resume must never collide with the session id it is reusing.
 *
 * The production regression: resuming a session threw
 *
 *     RoutingFailed: inbox routing failed:
 *     Error: address already registered: tasks:<sessionId>:tasks
 *
 * A prior per-session harness for that id had claimed the inbox address and
 * never released it, so the fresh `TasksHarness` the create-or-resume path
 * builds could not register. Two independent producers, both pinned here:
 *
 *   1. **teardown that fails partway.** Every per-session sub-harness detaches
 *      from the inbox inside `BaseHarness.close`, which subclasses used to
 *      reach only at the END of their own failable work. An adopter's
 *      `TaskExecutor.cancel` rejecting during the close cancel cascade skipped
 *      the detach — and every caller above swallows close errors
 *      (`SessionHarness` closes each bridge with `.catch()`,
 *      `AppHarness.disposeSession` try/catches after it has already dropped
 *      the registry entry), so the leak was silent until the next resume.
 *   2. **creation that fails partway.** The sub-harnesses are constructed long
 *      before `registry.set`, so a create that threw in between (a session
 *      extension whose install rejects, a hydrator that throws) orphaned live
 *      harnesses holding addresses that nothing could ever close.
 *
 * Both make the FIRST failure permanent for that session id: every later
 * attempt reports the collision instead of the real problem.
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { InProcessTaskExecutor } from "@agentick/tasks";
import type {
  ExecutionTarget,
  MessageInbox,
  SessionExtension,
  SessionHarnessProtocol,
  TaskExecution,
} from "@agentick/spec";

import { waitFor } from "@agentick/utils/testing";

import { createApp } from "../react.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function PlainAgent() {
  return React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    "You are a helpful agent.",
  );
}

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}

/**
 * The adopter executor from the field: its `cancel` rejects. A child-process
 * executor whose worker already exited (EPIPE on the IPC write) is the real
 * shape; this is the one-line stand-in.
 */
class RejectingCancelExecutor extends InProcessTaskExecutor {
  override cancel(_execution: TaskExecution, _reason?: string): Promise<void> {
    return Promise.reject(new Error("executor cancel blew up"));
  }
}

/** Cancel BLOCKS on a gate the test resolves — so a disposal can be held mid-close. */
class GatedCancelExecutor extends InProcessTaskExecutor {
  readonly gate = deferred<void>();
  override cancel(_execution: TaskExecution, _reason?: string): Promise<void> {
    return this.gate.promise;
  }
}

async function mkApp(
  opts: {
    sessions?: { maxActive?: number };
    extensions?: readonly SessionExtension[];
    taskExecutor?: InProcessTaskExecutor;
  } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("addr-exec", journal, bus, inbox, {
    scripted: [],
  });
  await executor.ready;
  const app = await createApp(React.createElement(PlainAgent), {
    modelExecutor: executor,
    target: mkTarget(),
    journal,
    bus,
    inbox,
    tasks: { executors: [opts.taskExecutor ?? new RejectingCancelExecutor()] },
    ...(opts.sessions !== undefined ? { sessions: opts.sessions } : {}),
    ...(opts.extensions !== undefined ? { extensions: opts.extensions } : {}),
  });
  return { app, inbox };
}

const asSession = (x: unknown): SessionHarnessProtocol => x as SessionHarnessProtocol;

/** Park a non-detached task on the session, so close has work that fails. */
function parkTask(session: SessionHarnessProtocol): void {
  const handle = (
    session as unknown as {
      tasks: { submit: (w: () => Promise<string>) => { result: Promise<unknown> } };
    }
  ).tasks.submit(() => new Promise<string>(() => {}));
  void handle.result.catch(() => {});
}

/** True when `address` is FREE — nothing is registered on it. */
async function addressFree(inbox: MessageInbox, address: string): Promise<boolean> {
  const probe = await Effect.runPromise(
    Effect.either(inbox.register(address, () => Effect.succeed(undefined))),
  );
  if (probe._tag === "Right") {
    probe.right();
    return true;
  }
  return false;
}

/** Every inbox address a per-session harness claims at construction. */
const sessionAddresses = (id: string): readonly string[] => [
  `tasks:${id}:tasks`,
  `elicitation:${id}:elicitation`,
  `resources:${id}:resources`,
];

async function expectAllFree(inbox: MessageInbox, id: string): Promise<void> {
  for (const address of sessionAddresses(id)) {
    expect([address, await addressFree(inbox, address)]).toEqual([address, true]);
  }
}

// ---------------------------------------------------------------------------
// 1 — every disposal path releases the addresses, even with a failing teardown
// ---------------------------------------------------------------------------

describe("session disposal releases every per-session inbox address", () => {
  it("app.destroySession", async () => {
    const { app, inbox } = await mkApp();
    parkTask(asSession(await app.createSession({ sessionId: "d1" })));
    await app.destroySession("d1");
    await expectAllFree(inbox, "d1");
  });

  it("app.disposeChildSession", async () => {
    const { app, inbox } = await mkApp();
    parkTask(asSession(await app.createSession({ sessionId: "d2" })));
    await app.disposeChildSession("d2");
    await expectAllFree(inbox, "d2");
  });

  it("app.closeApp", async () => {
    const { app, inbox } = await mkApp();
    parkTask(asSession(await app.createSession({ sessionId: "d3" })));
    await app.closeApp();
    await expectAllFree(inbox, "d3");
  });

  it("idle/LRU eviction (paging out)", async () => {
    const { app, inbox } = await mkApp({ sessions: { maxActive: 1 } });
    parkTask(asSession(await app.createSession({ sessionId: "d4" })));
    // maxActive: 1 — creating the second session pages the first one out.
    await app.createSession({ sessionId: "d5" });
    expect(app.getSession("d4")).toBeUndefined();
    await expectAllFree(inbox, "d4");
  });

  it("direct session.close()", async () => {
    const { app, inbox } = await mkApp();
    const s = asSession(await app.createSession({ sessionId: "d6" }));
    parkTask(s);
    await s.close();
    await expectAllFree(inbox, "d6");
  });
});

// ---------------------------------------------------------------------------
// 2 — the resume cycle itself
// ---------------------------------------------------------------------------

describe("create → dispose → create the SAME id", () => {
  it("resumes after eviction without an address collision", async () => {
    const { app } = await mkApp({ sessions: { maxActive: 1 } });
    parkTask(asSession(await app.createSession({ sessionId: "r1" })));
    await app.createSession({ sessionId: "filler" }); // pages r1 out

    // The resume: a FRESH set of per-session harnesses for the same id.
    const resumed = asSession(await app.createSession({ sessionId: "r1" }));
    await expect(
      (resumed as unknown as { tasks: { hydrated: Promise<void> } }).tasks.hydrated,
    ).resolves.toBeUndefined();
  });

  it("resumes after destroySession without an address collision", async () => {
    const { app } = await mkApp();
    parkTask(asSession(await app.createSession({ sessionId: "r2" })));
    await app.destroySession("r2");

    const resumed = asSession(await app.createSession({ sessionId: "r2" }));
    await expect(
      (resumed as unknown as { tasks: { hydrated: Promise<void> } }).tasks.hydrated,
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3 — creation that fails partway
// ---------------------------------------------------------------------------

describe("a create that fails partway claims nothing", () => {
  const failOnce = (): { extension: SessionExtension; disarm: () => void } => {
    let armed = true;
    return {
      extension: {
        name: "explodes-once",
        target: "session",
        install: () => {
          if (armed) throw new Error("extension install blew up");
        },
      },
      disarm: () => {
        armed = false;
      },
    };
  };

  it("releases the addresses its aborted construction claimed", async () => {
    const { extension } = failOnce();
    const { app, inbox } = await mkApp({ extensions: [extension] });

    await expect(app.createSession({ sessionId: "c1" })).rejects.toThrow(
      /extension install blew up/,
    );

    await expectAllFree(inbox, "c1");
  });

  it("a retry with the same id succeeds — the first failure is not permanent", async () => {
    const { extension, disarm } = failOnce();
    const { app } = await mkApp({ extensions: [extension] });

    // The real failure the adopter must see…
    await expect(app.createSession({ sessionId: "c2" })).rejects.toThrow(
      /extension install blew up/,
    );
    disarm();
    // …and not a collision about an address on the retry. Asserted through
    // `tasks.hydrated` rather than the create alone: a colliding registration
    // does NOT reject `createSession` — it rejects the harness's own `ready`,
    // which surfaces out of band as an unhandled `RoutingFailed` and hands the
    // caller a session whose tasks harness is unaddressable.
    const retried = asSession(await app.createSession({ sessionId: "c2" }));
    expect(retried.id).toBe("c2");
    await expect(
      (retried as unknown as { tasks: { hydrated: Promise<void> } }).tasks.hydrated,
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4 — a resume that RACES an in-flight disposal (not awaited first)
// ---------------------------------------------------------------------------

describe("create → dispose IN FLIGHT → create the SAME id", () => {
  it("waits for the disposal to release the addresses before rebuilding", async () => {
    const executor = new GatedCancelExecutor();
    const { app } = await mkApp({ taskExecutor: executor });
    parkTask(asSession(await app.createSession({ sessionId: "race" })));

    // Dispose, NOT awaited: it deletes the registry entry, then blocks in close
    // on the gated task cancel — the inbox addresses are still held.
    const disposing = app.destroySession("race");
    await waitFor(() => app.getSession("race") === undefined, {
      description: "registry entry deleted",
    });

    // Resume DURING that window. The registry is empty but the addresses are
    // held: without the barrier this rebuilds and collides; with it, it waits.
    const resuming = app.createSession({ sessionId: "race" });

    // Release the disposal, then let both settle.
    executor.gate.resolve();
    await disposing;
    const resumed = asSession(await resuming);
    expect(resumed.id).toBe("race");
    // The tell of a collision is a rejected harness `ready`, out of band from the
    // create — so assert the fresh tasks harness actually addressed itself.
    await expect(
      (resumed as unknown as { tasks: { hydrated: Promise<void> } }).tasks.hydrated,
    ).resolves.toBeUndefined();
  });
});
