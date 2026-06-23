/**
 * `fakeTasks()` — construct a real {@link TasksHarness} on a fresh
 * in-memory substrate. Returns the harness, the substrate primitives
 * (so tests can subscribe to the bus, assert journal entries, etc.),
 * and a `close()` that's idempotent.
 *
 * Per the test-doubles convention: `fake*` for working impls (this
 * is the harness backed by real substrate); `stub*` for canned-
 * answer stubs ({@link stubTasks}); never `test*`.
 */

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { TasksHarness } from "../harness.js";

export interface FakeTasksBundle {
  readonly harness: TasksHarness;
  readonly journal: MemoryJournal;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  close(): Promise<void>;
}

export interface FakeTasksOptions {
  readonly harnessId?: string;
  readonly sessionId?: string;
}

export async function fakeTasks(options: FakeTasksOptions = {}): Promise<FakeTasksBundle> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new TasksHarness(
    options.harnessId ?? "fake-tasks",
    journal,
    bus,
    inbox,
    options.sessionId !== undefined ? { parentScope: { sessionId: options.sessionId } } : {},
  );
  await harness.ready;

  let closed = false;
  return {
    harness,
    journal,
    bus,
    inbox,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await harness.close();
    },
  };
}
