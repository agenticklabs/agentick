/**
 * Full-stack `tasks/cancel` round-trip — sanity net over the real wire.
 *
 * `tasks/cancel` is a structural twin of `knobs/set` (a plain request/response
 * wire method), so its links are pinned by units: the handler routing
 * (`tasks/src/__tests__/wire.spec.ts`), the client request shape + CQRS re-fold
 * (`tasks/src/client/__tests__/tasks-handle.spec.ts`), and gateway registration
 * (`gateway/…/wire-framework-extensions.spec.ts`). This test closes the loop
 * through the REAL `GatewayHarness` + `inProcessTransport` (no stub JSON-RPC
 * handler) so the generic dispatch path is exercised end to end:
 *
 *   1. Server submits a hanging task via `session.tasks.submit(...)`.
 *   2. Client subscribes to `session.tasks` (the task-status ChannelView).
 *   3. Client calls `session.tasks.cancel(taskId, reason)`. The handle issues
 *      `tasks/cancel`, which `dispatchRequest` routes (via `tasksWireExtension`,
 *      registered by `builtinWireExtensions`) to `session.tasks.cancel(...)`.
 *   4. The server task transitions to `cancelled`; that transition returns as a
 *      `task-status` delta and re-folds the client view (CQRS — state flows one
 *      way, through the channel).
 *
 * Side-effect import of `@agentick/tasks-next` types/registers the server-side
 * `SessionHarnessProtocol.tasks` slot; `/client` registers `session.tasks`.
 */

import "@agentick/tasks-next";
import "@agentick/tasks-next/client";

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core-next";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { createGateway } from "@agentick/gateway-next";
import { fakeReconciler } from "@agentick/reconciler-next/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { waitFor } from "@agentick/utils-next/testing";
import type { ContentBlock } from "@agentick/spec-next";

import { inProcessTransport } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("e2e-tasks-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end",
        },
      },
    ],
  });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "tasks-app",
    rootElement: null,
    options: { executor, reconciler: fakeReconciler() },
  });
  // `session.tasks` is added by the tasks-next module augmentation (loaded above)
  // and constructed unconditionally per session (ADR 26 built-in bridge).
  const session = await app.createSession({ sessionId: "tasks-session" });

  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();

  return {
    client,
    session,
    sessionId: session.id,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

/**
 * The bus subscribe-fiber registers asynchronously (see the elicitation e2e's
 * note); a small barrier lets the client's task-status subscription land before
 * the server publishes the `cancelled` transition.
 */
const SUBSCRIBE_BARRIER_MS = 20;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, SUBSCRIBE_BARRIER_MS));

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("tasks/cancel end-to-end — client ↔ gateway ↔ session", () => {
  it("client tasks.cancel(taskId) transitions the server task to cancelled", async () => {
    const { client, session, sessionId, cleanup } = await makeStack();

    // Server submits a task that hangs until its signal aborts.
    const handle = session.tasks.submit(async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return "should-not-reach";
    });

    // Client opens the task-status view FIRST so the bus subscriber is live
    // before the cancel's transition publishes.
    const tasks = client.session(sessionId).tasks;
    await settle();

    // Client cancels through the wire — issues `tasks/cancel`, routed to
    // `session.tasks.cancel(taskId, reason)`.
    await tasks.cancel(handle.taskId, "user-aborted");

    // Server side: the task reached the terminal cancelled state with the reason.
    const info = session.tasks.get(handle.taskId);
    expect(info?.status).toBe("cancelled");
    expect(info?.failure?.reason).toBe("user-aborted");

    // The task's result promise rejects with the cancelled rejection.
    await expect(handle.result).rejects.toMatchObject({ status: "cancelled" });

    // Client side: the cancelled transition returns as a task-status delta and
    // re-folds the view (CQRS — no local hand-patch).
    await waitFor(() => tasks.get()[handle.taskId]?.status === "cancelled");
    expect(tasks.get()[handle.taskId]?.status).toBe("cancelled");

    tasks.close();
    await cleanup();
  });

  it("cancelling an unknown taskId surfaces the harness error over the wire", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    await expect(
      client.session(sessionId).tasks.cancel("task:does-not-exist"),
    ).rejects.toBeDefined();

    await cleanup();
  });
});
