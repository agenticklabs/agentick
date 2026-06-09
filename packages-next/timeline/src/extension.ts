/**
 * `withTimeline()` — `SessionExtension` factory for the TimelineHarness.
 *
 * Constructs a `TimelineHarness` per-session at session install time,
 * wired to the session's substrate. The session's required-set contract
 * guarantees this slot exists; adopters who want a custom implementation
 * (e.g., durable journaled persistence) pass their own `withTimeline({...})`.
 *
 * **Wiring status (ADR 26 Step 8 — pending).** SessionInstaller exists
 * in the spec; SessionHarness doesn't drive session-targeted extensions
 * through it yet. Today the SessionHarness constructs TimelineHarness
 * directly in `session-bridges.ts`. When Step 8 lands, that direct
 * construction is replaced by an array of default `SessionExtension`s —
 * `[withTimeline(), withKnobs(), withState()]` — that the installer
 * resolves at session construction, and adopters override any of them
 * by passing a configured variant in `AppHarnessOptions.extensions`.
 */

import type { SessionExtension, SessionInstaller, TimelineEntry } from "@agentick/spec-next";
import { TimelineHarness } from "./harness.js";

export interface WithTimelineOptions {
  /** Initial persisted entries seeded at construction. */
  readonly initial?: readonly TimelineEntry[];
}

export function withTimeline(options: WithTimelineOptions = {}): SessionExtension {
  return {
    name: "@agentick/timeline-next",
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
