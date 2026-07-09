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
import { omitUndefined } from "@agentick/utils-next";
import type { TaskElicitFactory, TaskExecutor, TaskStore } from "@agentick/spec-next";

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
  /** Extra {@link TaskExecutor}s merged over the bundled in-process default (ADR 68 Build B). */
  readonly executors?: readonly TaskExecutor[];
  /** Durable store override (ADR 68) — defaults to a fresh `InMemoryTaskStore`. */
  readonly store?: TaskStore;
  /**
   * Elicit-sugar factory (ADR 69) — pass `buildElicitSugar` to wire task
   * `ctx.elicit` escalation. When set (with a `sessionId`), a task's
   * `ctx.elicit.*` escalates to `session:{sessionId}` via `inbox.ask`; a
   * test registers a terminal handler there to answer. Omitted → the
   * bundled bare harness whose `ctx.elicit` throws "not configured".
   */
  readonly buildElicit?: TaskElicitFactory;
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
    omitUndefined({
      parentScope: options.sessionId !== undefined ? { sessionId: options.sessionId } : undefined,
      executors: options.executors,
      store: options.store,
      buildElicit: options.buildElicit,
    }),
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
