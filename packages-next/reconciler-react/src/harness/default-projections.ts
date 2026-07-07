/**
 * Reconciler default surfacing projections (ADR 63).
 *
 * The `tools` default is compiler-agnostic and lives in
 * `@agentick/reconciler-next` (`builtInToolsProjection`). The `timeline`
 * default needs a live timeline harness, so it is contributed here by the
 * reconciler binding.
 *
 * Per ADR 27, `@agentick/reconciler-react-next` has NO dependency on
 * `@agentick/timeline-next`. The timeline harness is read STRUCTURALLY
 * from `HookBridges.timeline` — the same duck-typed feature-detection
 * posture the bridge snapshot iteration uses. This keeps the timeline
 * default here (a reconciler concern: "fold the conversation into IR")
 * without importing the harness package.
 *
 * The fold mirrors what `<Timeline/>` (no props) produces today: every
 * `message`-kind entry that is not `visibility: "log"`, mapped to a
 * `MessageEntry`. When no `<Timeline>` overrides the `timeline`
 * projection, this default runs and the conversation still surfaces —
 * the ADR-63 default-on behavior. When a `<Timeline>` IS present, it
 * emits a `projection-override` and this default never runs (lazy).
 *
 * TODO(#237-4b): resources / mcp-server-info default projections join
 * this list, read structurally from their bridges the same way. When the
 * session installer drives extension-registered projections (ADR 26 Step
 * 8), harness packages will contribute their own defaults instead of the
 * reconciler binding reaching into bridges — until then, structural
 * duck-typing is the seam.
 *
 * @see docs/proposals/v2/blueprint/63-compiler-surfacing.md
 */

import type { HookBridges, MessageEntry } from "@agentick/spec-next";
import type { DefaultProjection } from "@agentick/reconciler-next";

/** Minimal structural view of a message-kind timeline entry. */
interface StructuralMessageEntry {
  readonly kind?: string;
  readonly visibility?: string;
  readonly message?: {
    readonly id?: string;
    readonly role?: string;
    readonly content?: readonly unknown[];
    readonly metadata?: Record<string, unknown>;
  };
}

/**
 * Read the session timeline projection structurally. Returns `undefined`
 * when no timeline bridge is present (system-only mounts) — the default
 * then contributes nothing.
 */
function readTimelineEntries(bridges: HookBridges): readonly StructuralMessageEntry[] | undefined {
  const timeline = (bridges as { timeline?: unknown }).timeline;
  if (timeline === null || timeline === undefined) return undefined;
  const read = (timeline as { read?: () => unknown }).read;
  if (typeof read !== "function") return undefined;
  const snapshot = read.call(timeline) as
    | { entries?: readonly StructuralMessageEntry[] }
    | undefined;
  const entries = snapshot?.entries;
  return Array.isArray(entries) ? entries : undefined;
}

/**
 * Build the `timeline` default projection bound to a mount's bridges.
 * Folds message entries into `MessageEntry` context entries — the same
 * fold `<Timeline/>` performs, minus compaction/filtering (those are
 * override-only concerns).
 */
export function timelineDefaultProjection(bridges: HookBridges): DefaultProjection {
  return {
    key: "timeline",
    project: () => {
      const raw = readTimelineEntries(bridges);
      if (!raw) return {};
      const entries: MessageEntry[] = [];
      for (const e of raw) {
        if (e?.kind !== "message") continue;
        if (e.visibility === "log") continue;
        const m = e.message;
        if (!m || typeof m.role !== "string") continue;
        entries.push({
          kind: "message",
          role: m.role,
          content: (m.content ?? []) as MessageEntry["content"],
          ...(m.id !== undefined ? { id: m.id } : {}),
          ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
        });
      }
      return entries.length > 0 ? { entries } : {};
    },
  };
}
