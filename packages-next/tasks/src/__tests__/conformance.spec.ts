/**
 * Run the published `TasksHarnessProtocol` conformance suite against
 * the in-package {@link TasksHarness} implementation.
 *
 * The shell factory wires the harness to a fresh `MemoryJournal +
 * LocalEventBus + LocalInbox` substrate. `close()` is idempotent —
 * the suite's `close()` may run after a specific test (e.g., the
 * "close() cancels in-flight" case) has already closed the harness.
 */

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { runTasksHarnessConformance, type TasksConformanceShell } from "../conformance.js";
import { TasksHarness } from "../harness.js";

runTasksHarnessConformance(async ({ harnessId }) => {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new TasksHarness(harnessId, journal, bus, inbox);
  await harness.ready;

  let closed = false;
  const shell: TasksConformanceShell = {
    harness,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await harness.close();
    },
  };
  return shell;
});
