/**
 * `withTasks()` — `SessionExtension` factory.
 *
 * Constructs a {@link TasksHarness} per-session at session install
 * time, wired to the session's substrate. The required-set contract
 * guarantees this slot exists; adopters who want a custom
 * implementation pass a configured `withTasks({ ... })`.
 *
 * **Cleanup-on-failure.** The harness's `ready` promise can reject
 * (inbox registration failure across a cluster substrate). To avoid
 * leaking the harness's daemon fibers + partial inbox subscription,
 * `harness.close()` is registered with the installer BEFORE the
 * `ready` await — so a rejection still routes through the
 * installer's teardown path.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import type { SessionExtension, SessionInstaller } from "@agentick/spec-next";
import { TasksHarness } from "./harness.js";

export interface WithTasksOptions {
  // TODO(#120-followup): real configuration fields:
  //   - `defaultTtlMs` — default TTL applied when `submit()` opts
  //     omit it.
  //   - `maxInFlight` — cap on concurrent tasks; new submits return
  //     a rejected handle when at cap.
  //   - `retentionMs` — how long to keep terminal task records
  //     reachable via `get(taskId)` before GC.
  // Empty today — present so adopters can install via `withTasks()`
  // without parens-vs-options ambiguity later.
  readonly _placeholder?: never;
}

export function withTasks(_options: WithTasksOptions = {}): SessionExtension {
  return {
    name: "@agentick/tasks-next",
    target: "session",
    install: async (installer: SessionInstaller) => {
      const harness = new TasksHarness(
        `${installer.hostId}:tasks`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        {
          // Stamp the session id on every published task envelope so
          // session-scoped subscriptions filter correctly. Mirrors
          // ElicitationHarness's parentScope wiring.
          parentScope: { sessionId: installer.hostId },
        },
      );

      // Register close BEFORE awaiting ready. If `ready` rejects, the
      // installer's teardown path still calls close() and the
      // already-constructed harness gets disposed cleanly.
      installer.onClose(() => harness.close());

      await harness.ready;
      installer.registerNamespace("tasks", harness);
    },
  };
}
