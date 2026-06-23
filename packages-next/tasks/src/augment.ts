/**
 * Module augmentation — adds the `tasks` slot to TWO spec
 * interfaces:
 *
 *   1. `HookBridges.tasks`              → React/render-time access
 *                                          for in-tree harnesses
 *                                          calling `submit()`.
 *   2. `SessionHarnessProtocol.tasks`   → server-side access for
 *                                          host code (gateway,
 *                                          tool-handler ctx) that
 *                                          needs to inspect / cancel
 *                                          tasks.
 *
 * Per ADR 27 (modular built-ins): each harness package augments the
 * spec's empty seed with its own slot. The spec itself stays neutral.
 *
 * **Required slots.** Tasks is a substrate primitive — every session
 * gets one (even sessions that never `submit` a task — the harness
 * is cheap when idle).
 *
 * Loaded as a side effect when anything imports from
 * `@agentick/tasks-next`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { TasksHarnessProtocol } from "@agentick/spec-next";

declare module "@agentick/spec-next" {
  interface HookBridges {
    /**
     * Substrate-level long-running tool registry. Tool handlers,
     * skill providers, and any code that needs to spawn observable
     * managed work register tasks here.
     */
    readonly tasks: TasksHarnessProtocol;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's tasks harness. Same instance the per-session
     * tool executor + `bridges.tasks` use; clients reach it via
     * `session/cancelTask` to abort pending tasks.
     */
    readonly tasks: TasksHarnessProtocol;
  }
}
