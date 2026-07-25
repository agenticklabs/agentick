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

import type {
  CompactStrategy,
  SessionExtension,
  SessionInstaller,
  TimelineEntry,
  TimelineStore,
} from "@agentick/spec-next";
import { TimelineHarness } from "./harness.js";

export interface WithTimelineOptions {
  /**
   * Initial persisted entries seeded at construction. Ignored when a
   * `store` is supplied — the durable log is the authority and is
   * hydrated instead (ADR 49 open-or-rehydrate).
   */
  readonly initial?: readonly TimelineEntry[];
  /** Durable append-log adapter for the persisted tier (ADR 49). */
  readonly store?: TimelineStore;
  /** `"behind"` (default; write-behind pump + flush barrier) | `"through"`. */
  readonly writePolicy?: "behind" | "through";
  /**
   * Construction-bound default compaction strategy (ADR 51 signal
   * form) — `timeline.compact()` with no argument, including a bare
   * `timeline:compact` verb over the inbox, runs it.
   */
  readonly compact?: CompactStrategy;
}

// TODO(tools-sweep / three-audiences-plan §D): a `src/tools.ts` shipping
// model-facing `timeline_*` tools (e.g. `timeline_compact`) would slot in
// here behind a `registerModelTools` option, same shape as
// `resources/src/tools.ts` + `skills/src/tools.ts`. DEFERRED: a
// model-invocable `compact` is a policy question (the guard/attestation
// story must be told first), so the convention does not launch it as
// filler. When added: register via `installer.registerToolHandler` +
// `registerExtensionTool`, reach the harness through a `ctx.timeline` slot
// (NOT `ctx.session`), and add the `ToolHandlerCtxExtensions` augmentation.
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
        {
          ...(options.store !== undefined ? { store: options.store } : {}),
          ...(options.writePolicy !== undefined ? { writePolicy: options.writePolicy } : {}),
          ...(options.compact !== undefined ? { compact: options.compact } : {}),
        },
      );
      await harness.ready;

      if (options.store !== undefined) {
        // Open-or-rehydrate (ADR 49): the durable log is the authority.
        await harness.hydrate();
      } else if (options.initial && options.initial.length > 0) {
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
