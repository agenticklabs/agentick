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
import { EXTENSION_NAME } from "./extension-name.js";
import { buildSessionTasksTools } from "./tools.js";

export interface WithTasksOptions {
  /**
   * Skip auto-registering the model-facing `session_tasks_*` tools.
   * Defaults to `false` — by default `withTasks()` registers four
   * tools that let the model list / get / cancel / await framework
   * background tasks (required for Pattern B `taskSupport: "required"`
   * tools to be usable).
   *
   * Set to `true` if the adopter wants the harness substrate without
   * the model surface — e.g., headless servers driving tasks
   * exclusively from adopter code with no LLM in the loop.
   */
  readonly registerModelTools?: boolean;

  // TODO(#120-followup): real configuration fields:
  //   - `defaultTtlMs` — default TTL applied when `submit()` opts
  //     omit it.
  //   - `maxInFlight` — cap on concurrent tasks; new submits return
  //     a rejected handle when at cap.
  //   - `retentionMs` — how long to keep terminal task records
  //     reachable via `get(taskId)` before GC.
}

export function withTasks(options: WithTasksOptions = {}): SessionExtension {
  const registerModelTools = options.registerModelTools !== false;
  return {
    name: EXTENSION_NAME,
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

      if (registerModelTools) {
        // Auto-register the four model-facing `session_tasks_*` tools
        // so Pattern B (`taskSupport: "required"`) is usable end-to-end
        // out of the box. Handlers reach the harness via `ctx.tasks` —
        // same instance just registered above.
        const bundle = buildSessionTasksTools(installer.sessionId);
        for (const { handlerRef, handler } of bundle.handlers) {
          installer.registerToolHandler(handlerRef, handler);
        }
        for (const registration of bundle.registrations) {
          installer.registerExtensionTool(registration);
        }
      }
    },
  };
}
