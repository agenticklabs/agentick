/**
 * `@agentick/session/testing` — test doubles + acceptance suites for
 * the reference SessionHarness.
 *
 * `runKillResumeAcceptance` is the parameterized ADR 49 "open-or-rehydrate"
 * acceptance suite — the end-to-end proof that a completed turn survives a
 * process kill and is visible (to the timeline AND the model) on a fresh
 * open over the same durable {@link TimelineStore} backing. Adapter
 * packages (memory / fs / postgres) run it against their store; see
 * `session-next/src/__tests__/kill-resume.spec.ts`.
 *
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 */

export {
  runKillResumeAcceptance,
  type KillResumeAcceptanceOptions,
} from "./kill-resume-acceptance.js";

// ────────── Conformance suite (imports vitest — testing-only) ──────────
export {
  runSessionStoreConformance,
  type SessionStoreConformanceOptions,
} from "../session-store-conformance.js";
