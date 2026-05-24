/**
 * `withTimeline()` — `SessionExtension` factory for the TimelineHarness.
 *
 * Constructs a `TimelineHarness` per-session at session install time,
 * wired to the session's substrate. The session's required-set contract
 * guarantees this slot exists; adopters who want a custom implementation
 * (e.g., durable journaled persistence) pass their own `withTimeline({...})`.
 *
 * Note: SessionInstaller is defined in ADR 26 Step 1 but not yet wired
 * into SessionHarness (Step 8). For now this factory compiles and is not
 * yet invoked at session construction — the SessionHarness internally
 * constructs the TimelineHarness directly.
 */

import type { SessionExtension, SessionInstaller, TimelineEntry } from "@agentick/spec";
import { TimelineHarness } from "./harness.js";

export interface WithTimelineOptions {
  /** Initial persisted entries seeded at construction. */
  readonly initial?: readonly TimelineEntry[];
}

export function withTimeline(options: WithTimelineOptions = {}): SessionExtension {
  return {
    name: "@agentick/timeline",
    target: "session",
    install: async (installer: SessionInstaller) => {
      const harness = new TimelineHarness(
        `${installer.hostId}:timeline`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
      );
      await harness.ready;

      if (options.initial && options.initial.length > 0) {
        await harness.importSnapshot(
          {
            persisted: options.initial,
            projection: options.initial,
            persistedVersion: options.initial.length,
            projectionVersion: options.initial.length,
          },
          { mode: "as-is" },
        );
      }

      installer.registerNamespace("timeline", harness);
      installer.onClose(() => harness.close());
    },
  };
}
