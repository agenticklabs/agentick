/**
 * `tasksWireExtension` — the `tasks/*` `WireExtension` that projects the tasks
 * WRITE command over the Agentick client↔gateway wire.
 *
 * Write half of the tasks resource (CQRS command). The client's read half is
 * the wired `task-status` channel (`taskStatusView` / `session.tasks`); the
 * write is a `tasks/cancel` RPC whose effect returns as a `cancelled` delta on
 * that channel and re-folds the view. No response payload carries state — state
 * flows one way, through the channel. Mirror of `knobsWireExtension`.
 *
 * Session resolution mirrors the `session` branch of the subscriptions
 * extension's `openScopeEvents`: iterate the gateway's apps, take the first
 * whose `getSession(sessionId)` resolves.
 *
 * @see packages-next/knobs/src/wire.ts
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 * @verifiedBy packages-next/tasks/src/__tests__/wire.spec.ts
 */

import {
  AppNotFoundError,
  defineWireExtension,
  type AppHarnessProtocol,
  type SessionHarnessProtocol,
  type WireExtension,
} from "@agentick/spec-next";

import "./wire-augment.js"; // types `tasks/cancel` on WireMethods

export const tasksWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/tasks-next#wire",
  namespace: "tasks",
  version: "1.0.0",
  methods: {
    "tasks/cancel": async (params, ctx) => {
      // Resolve the owning session — mirrors `knobsWireExtension`.
      let session: SessionHarnessProtocol | undefined;
      for (const app of ctx.gateway.apps() as readonly AppHarnessProtocol[]) {
        const sess = app.getSession(params.sessionId);
        if (sess) {
          session = sess;
          break;
        }
      }
      if (!session) {
        throw new AppNotFoundError({ appId: params.sessionId });
      }

      // The cancel's observable effect returns to the client as a `task-status`
      // `cancelled` delta (CQRS) — nothing is returned here.
      await session.tasks.cancel(params.taskId, params.reason);
      return null;
    },
  },
});
