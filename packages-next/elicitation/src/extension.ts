/**
 * `withElicitation()` — `SessionExtension` factory.
 *
 * Constructs an {@link ElicitationHarness} per-session at session
 * install time, wired to the session's substrate. The required-set
 * contract guarantees this slot exists; adopters who want a custom
 * implementation pass a configured `withElicitation({ ... })`.
 *
 * **Cleanup-on-failure.** The harness's `ready` promise can reject
 * (inbox registration failure across a cluster substrate). To avoid
 * leaking the harness's daemon fibers + partial inbox subscription,
 * `harness.close()` is registered with the installer BEFORE the
 * `ready` await — so a rejection still routes through the installer's
 * teardown path.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import type { SessionExtension, SessionInstaller } from "@agentick/spec-next";
import { ElicitationHarness } from "./harness.js";

export interface WithElicitationOptions {
  /**
   * Default elicitation wait bound (ms). Forwarded to the harness's
   * `defaultTimeoutMs`. Defaults to 5 minutes inside the harness.
   */
  readonly defaultTimeoutMs?: number;
}

export function withElicitation(options: WithElicitationOptions = {}): SessionExtension {
  return {
    name: "@agentick/elicitation-next",
    target: "session",
    install: async (installer: SessionInstaller) => {
      const harness = new ElicitationHarness(
        `${installer.hostId}:elicitation`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        {
          ...(options.defaultTimeoutMs !== undefined
            ? { defaultTimeoutMs: options.defaultTimeoutMs }
            : {}),
          // The session-extension installer's hostId IS the sessionId.
          // Stamping it as parentScope ensures published request
          // envelopes carry `scope.sessionId` so client-side
          // `session.elicitations()` subscriptions actually match.
          parentScope: { sessionId: installer.hostId },
        },
      );

      // Register close BEFORE awaiting ready. If `ready` rejects, the
      // installer's teardown path still calls close() and the
      // already-constructed harness gets disposed cleanly. Registering
      // after the await would leak the harness on failure.
      installer.onClose(() => harness.close());

      await harness.ready;
      installer.registerNamespace("elicitation", harness);
    },
  };
}
