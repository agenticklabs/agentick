/**
 * `<Transcript>` — conversational-surface alias for {@link Timeline}.
 *
 * IDENTICAL component and props. The name reads right for chat / agent
 * UIs while the primitive stays honestly general: the timeline is an
 * ordered log (ADR 53 — turn boundaries, offsets, provenance are log
 * vocabulary, not conversation vocabulary). Pick by domain —
 * `<Transcript>` for a conversation, `<Timeline>` for any other event
 * log rendered to the model. Sugar only: the harness, store, protocol,
 * verbs, and hooks stay `timeline`-named (aliasing further would start
 * the rename creep the "primitive stays general" decision rejects).
 */

import { Timeline, type TimelineProps } from "./timeline.js";

export const Transcript = Timeline;
export type TranscriptProps = TimelineProps;
