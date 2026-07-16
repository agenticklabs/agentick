/**
 * Canonical control-plane channels for the LiveHarness (ADR 88).
 *
 * The media plane is the {@link import("@agentick/spec-next").MediaTransport}
 * sidecar; the CONTROL/event plane rides the existing ADR 33 channels. Two
 * channels because a UI wants transcripts and state independently:
 *
 *   `session:channel:live-transcript` — interim + final transcript deltas.
 *                                       Payload: {@link LiveTranscriptFrame}.
 *   `session:channel:live-state`      — conversational-state transitions.
 *                                       Payload: {@link LiveStateFrame}.
 *
 * Each frame carries its `streamId` so a client with multiple concurrent
 * streams on one session filters to the one its handle is bound to.
 */

import type { LiveState, TranscriptDelta } from "@agentick/spec-next";

export const LIVE_TRANSCRIPT_CHANNEL = "live-transcript" as const;
export const LIVE_STATE_CHANNEL = "live-state" as const;

export type LiveTranscriptChannelName = typeof LIVE_TRANSCRIPT_CHANNEL;
export type LiveStateChannelName = typeof LIVE_STATE_CHANNEL;

/** Fully-qualified channel names as they appear on the bus envelope. */
export const LIVE_TRANSCRIPT_CHANNEL_FQN = "session:channel:live-transcript" as const;
export const LIVE_STATE_CHANNEL_FQN = "session:channel:live-state" as const;

/** A `live-transcript` frame — one transcript delta, tagged with its stream. */
export interface LiveTranscriptFrame {
  readonly streamId: string;
  readonly transcript: TranscriptDelta;
}

/** A `live-state` frame — one conversational-state transition, tagged with its stream. */
export interface LiveStateFrame {
  readonly streamId: string;
  readonly state: LiveState;
}
