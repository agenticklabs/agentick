/**
 * Timeline append-event domain + subscriber-side query helper.
 *
 * The client-side timeline is `fold(session event stream)` — NOT a bespoke
 * channel, NOT a read RPC. Every `timeline.append(...)` runs through the
 * harness command path (ADR 51): the declared verb `"timeline:append"` maps
 * to the emitted op-name `"timeline:command:append"` (the
 * `<surface>:command:<rest>` derivation — see `../protocol/command.ts` §op-name
 * root), and the `requested`-phase envelope of that lifecycle carries the
 * operation's INPUT as `envelope.payload` — the {@link TimelineAppendInput}
 * `{ entries }`. That is the ONE envelope that carries the appended entries
 * (the `terminal` phase carries only the void `result`), so the fold selects
 * exactly it.
 *
 * This module is the SUBSCRIBER side — the one query a client-side timeline
 * fold needs — mirroring `channelEventQuery()` (`./channels.ts`) and
 * `logEventQuery()` / `progressEventQuery()` (`./signals.ts`).
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 */

import type { EventQuery } from "./events.js";

/** The surface every timeline-harness event is emitted on. */
export const TIMELINE_SURFACE = "timeline" as const;

/**
 * The canonical verb for the append command (the inbox message `type`).
 * Distinct from the emitted event name below — the verb is the op-name
 * ROOT, transformed to `timeline:command:append` on the bus.
 */
export const TIMELINE_APPEND_VERB = "timeline:append" as const;

/**
 * The emitted op-name for the append command's lifecycle envelopes —
 * `<surface>:command:<rest>` of {@link TIMELINE_APPEND_VERB}. This is the
 * `name` carried by the `requested` / `before` / `terminal` envelopes on the
 * bus, and the value the fold's query matches exactly.
 */
export const TIMELINE_APPEND_EVENT_NAME = "timeline:command:append" as const;

/**
 * Subscriber-side query selecting the append events that carry entries for a
 * session. Narrows to the `requested` phase — the ONLY phase whose
 * `envelope.payload` is the {@link TimelineAppendInput} `{ entries }` (the
 * argument-bound phase, per the blueprint phase contract). Combine with a
 * `SubscriptionScope` (e.g. `{ kind: "session", id }`) at the
 * `transport.subscribe` call to narrow to one session.
 *
 * @verifiedBy packages-next/spec/src/__tests__/timeline.spec.ts
 */
export function timelineEventQuery(): EventQuery {
  return {
    surface: TIMELINE_SURFACE,
    name: { exact: TIMELINE_APPEND_EVENT_NAME },
    phase: "requested",
  };
}
