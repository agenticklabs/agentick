/**
 * Cross-harness inbox protocol — the cluster-friendly seam.
 *
 * One harness lives at address `tasks:A`, another at `tasks:B`, both
 * sharing a `LocalInbox`. Harness B sends `tasks-cancel` / `tasks-get`
 * messages to address `tasks:A`; the target harness handles them via
 * its `handleMessage` switch. Same protocol routes in-memory
 * (LocalInbox) and across cluster nodes (ClusterInbox, when it
 * ships); the address string is the cluster-portable seam.
 *
 * `tasks-cancel` is fire-and-forget — no reply. We verify the target
 * task's state changes.
 *
 * `tasks-get` and `tasks-result` reply via `request-response`
 * envelopes; the sender's `BaseHarness.requests` registry resolves
 * the correlated Deferred. We construct the request by hand here
 * (mirroring what a Phase B MCP wire codec would do).
 */

import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";

import { TasksHarness } from "../harness.js";
import { TASKS_CANCEL_MESSAGE_TYPE, TASKS_GET_MESSAGE_TYPE } from "../inbox-protocol.js";

describe("TasksHarness — cluster-friendly inbox protocol", () => {
  it("tasks-cancel inbox message cancels the target task by address", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();

    // Two harnesses sharing the same substrate so inbox routing
    // works in-process.
    const harnessA = new TasksHarness("A", journal, bus, inbox);
    const harnessB = new TasksHarness("B", journal, bus, inbox);
    await Promise.all([harnessA.ready, harnessB.ready]);

    try {
      // Submit on A. Work blocks on the signal.
      const handle = harnessA.submit(async ({ signal }) => {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return "should-not-reach";
      });

      // B sends a `tasks-cancel` to A's address. From the test's
      // perspective this is "what a Phase B MCP codec would do" —
      // a foreign harness dispatching by string address.
      await Effect.runPromise(
        inbox.send(harnessA.address, {
          type: TASKS_CANCEL_MESSAGE_TYPE,
          payload: { taskId: handle.taskId, reason: "remote-test" },
        }),
      );

      await expect(handle.result).rejects.toMatchObject({
        _tag: "TaskRejection",
        status: "cancelled",
      });
      const info = harnessA.get(handle.taskId);
      expect(info?.failure?.reason).toBe("remote-test");
    } finally {
      await harnessA.close();
      await harnessB.close();
    }
  });

  it("tasks-cancel for an Effect-typed task triggers Fiber.interrupt via the inbox path (#170)", async () => {
    // Pins the cross-product: cluster routing × Effect work overload.
    // The inbox handler must end up at the same `cancelInternal` that
    // single-process cancel reaches, so Fiber.interrupt fires for the
    // Effect path's tracked fiber. Without this test the cluster +
    // Effect-fiber combination is untested.
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const harnessA = new TasksHarness("A-effect-cluster", journal, bus, inbox);
    const harnessB = new TasksHarness("B-effect-cluster", journal, bus, inbox);
    await Promise.all([harnessA.ready, harnessB.ready]);

    try {
      // 60-second Effect sleep — if Fiber.interrupt doesn't fire via
      // the inbox path, vitest's test-level timeout (default 5s) trips
      // before this resolves.
      const handle = harnessA.submit(() =>
        Effect.sleep("60 seconds").pipe(Effect.as("unreachable")),
      );

      // Give the work a tick to schedule the sleep.
      await new Promise((r) => setTimeout(r, 5));

      // B addresses A's tasks harness — this is the "cluster" path
      // (here in-process, but cluster-portable via address string).
      const cancelStart = performance.now();
      await Effect.runPromise(
        inbox.send(harnessA.address, {
          type: TASKS_CANCEL_MESSAGE_TYPE,
          payload: { taskId: handle.taskId, reason: "remote-effect-cancel" },
        }),
      );

      await expect(handle.result).rejects.toMatchObject({
        _tag: "TaskRejection",
        status: "cancelled",
        failure: { kind: "aborted", reason: "remote-effect-cancel" },
      });
      const elapsed = performance.now() - cancelStart;
      // Cancel + Fiber.interrupt completes in well under the 60s
      // sleep — proves the fiber was actually interrupted, not waited
      // out.
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      await harnessA.close();
      await harnessB.close();
    }
  });

  it("tasks-cancel via inbox is settled — Effect finalizers run before the inbox send resolves (#170)", async () => {
    // The settled-cancel guarantee that cancelInternal() awaits
    // Fiber.interrupt must hold via the inbox path too. We use a
    // 20ms release effect; after the inbox send resolves, the
    // finalizer counter must read 1 (fire-and-forget would observe 0).
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const harnessA = new TasksHarness("A-effect-settled", journal, bus, inbox);
    await harnessA.ready;

    try {
      const finalizerCalls = Effect.runSync(Ref.make(0));
      const handle = harnessA.submit(() =>
        Effect.acquireUseRelease(
          Effect.void,
          () => Effect.sleep("60 seconds"),
          () =>
            Ref.update(finalizerCalls, (n) => n + 1).pipe(
              Effect.zipRight(Effect.sleep("20 millis")),
            ),
        ),
      );
      // Pre-drain the rejection so vitest doesn't flag unhandled.
      const drained = handle.result.catch((e: unknown) => e);

      await new Promise((r) => setTimeout(r, 10));

      // Inbox-routed cancel awaits the handler's cancelInternal,
      // which awaits Fiber.interrupt, which awaits the release.
      await Effect.runPromise(
        inbox.send(harnessA.address, {
          type: TASKS_CANCEL_MESSAGE_TYPE,
          payload: { taskId: handle.taskId, reason: "cluster-settled" },
        }),
      );

      expect(Effect.runSync(Ref.get(finalizerCalls))).toBe(1);
      void drained;
    } finally {
      await harnessA.close();
    }
  });

  it("tasks-cancel for unknown id is a silent no-op (no reply, no throw)", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const harness = new TasksHarness("only", journal, bus, inbox);
    await harness.ready;

    try {
      // The send resolves with a MessageAck; the handler is a no-op
      // for unknown ids — verify the call doesn't throw.
      await expect(
        Effect.runPromise(
          inbox.send(harness.address, {
            type: TASKS_CANCEL_MESSAGE_TYPE,
            payload: { taskId: "task:does-not-exist" },
          }),
        ),
      ).resolves.not.toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("tasks-get inbox message replies with TaskInfo via request-response", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();

    const harnessA = new TasksHarness("A2", journal, bus, inbox);
    await harnessA.ready;

    // Construct a "client" mailbox to receive the reply. We could
    // use a second harness, but a bare inbox subscription is the
    // simplest demonstration that the reply lands at `replyTo`.
    const replyAddress = `test:client:${ulid()}`;
    const correlationId = `req:${ulid()}`;
    let receivedReply: unknown;
    const unsubscribe = Effect.runSync(
      inbox.register(replyAddress, (msg) => {
        // Capture the reply payload (the `request-response`'s wrapped
        // response field, mirroring BaseHarness's auto-intercept
        // shape).
        receivedReply = (msg.payload as { response: unknown } | undefined)?.response;
        return Effect.void;
      }),
    );

    try {
      const handle = harnessA.submit(async () => "value-x");
      await handle.result;

      await Effect.runPromise(
        inbox.send(harnessA.address, {
          type: TASKS_GET_MESSAGE_TYPE,
          payload: {
            taskId: handle.taskId,
            replyTo: replyAddress,
            correlationId,
          },
        }),
      );

      // Allow the inbox handler to run + reply.
      await new Promise((r) => setTimeout(r, 10));
      expect(receivedReply).toMatchObject({
        taskId: handle.taskId,
        status: "completed",
      });
    } finally {
      unsubscribe();
      await harnessA.close();
    }
  });

  it("tasks-get for unknown id replies with undefined", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const harness = new TasksHarness("A3", journal, bus, inbox);
    await harness.ready;

    const replyAddress = `test:client:${ulid()}`;
    let received: unknown = Symbol("not-set");
    const unsubscribe = Effect.runSync(
      inbox.register(replyAddress, (msg) => {
        received = (msg.payload as { response: unknown } | undefined)?.response;
        return Effect.void;
      }),
    );

    try {
      await Effect.runPromise(
        inbox.send(harness.address, {
          type: TASKS_GET_MESSAGE_TYPE,
          payload: {
            taskId: "task:nope",
            replyTo: replyAddress,
            correlationId: `req:${ulid()}`,
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(received).toBeUndefined();
    } finally {
      unsubscribe();
      await harness.close();
    }
  });
});
