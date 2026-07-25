/**
 * `liveSessionHandle` — the client-side {@link LiveSessionHandle} impl (ADR 88).
 *
 * The portable spec surface is imperative + callback (`sendFrame` / `onFrame` /
 * `onTranscript` / `onState`); this module ADDS the first-class RUNTIME
 * projections (`uplink: WritableStream` / `downlink: ReadableStream`) built over
 * that surface, for `pipeThrough` composition — the projections and the
 * callbacks are EQUIVALENT views of the same media plane.
 *
 * Auto-bound to `(sessionId, streamId)`: the caller never threads ids. The media
 * plane rides the {@link MediaTransport} sidecar (uplink `send` = backpressured
 * push; downlink `onFrame` = receive); control commands
 * (`interrupt`/`stop`/`abort`) ride the `live/*` wire; transcripts + state ride
 * the `live-transcript` / `live-state` channels.
 *
 * @verifiedBy packages/live/src/client/__tests__/live-session-handle.spec.ts
 */

import { channelView, type ChannelView } from "@agentick/client-core";
import type {
  ClientTransport,
  LiveSessionHandle,
  LiveState,
  MediaDownlink,
  MediaFrame,
  MediaSessionRef,
  MediaTransport,
  MediaUplink,
  SubscriptionScope,
  TranscriptDelta,
  Unsubscribe,
} from "@agentick/spec";

import {
  LIVE_STATE_CHANNEL,
  LIVE_TRANSCRIPT_CHANNEL,
  type LiveStateFrame,
  type LiveTranscriptFrame,
} from "../channel.js";

/** The wire surface the handle needs — control commands (`request`) + channels (`subscribe`). */
export interface LiveCommandClient {
  readonly transport: Pick<ClientTransport, "subscribe" | "request">;
}

/**
 * The client handle = the portable {@link LiveSessionHandle} spec surface PLUS
 * the first-class RUNTIME stream projections (ADR 88 §"RUNTIME/CLIENT"). The
 * projections are deliberately OFF the spec (Node === browser portability); the
 * client package, which owns the `WritableStream`/`ReadableStream` runtime, adds
 * them here for `pipeThrough` composition.
 */
export interface RuntimeLiveSessionHandle extends LiveSessionHandle {
  /** `WritableStream<MediaFrame>` — `sink.write` = `sendFrame`; `ready` ⇒ backpressure. */
  readonly uplink: WritableStream<MediaFrame>;
  /** `ReadableStream<MediaFrame>` — enqueues from `onFrame`. */
  readonly downlink: ReadableStream<MediaFrame>;
}

export interface LiveSessionHandleDeps {
  readonly client: LiveCommandClient;
  /** The media-plane capability, feature-detected off the transport by the facet. */
  readonly media: MediaTransport;
  readonly ref: MediaSessionRef;
}

/**
 * Build a live handle over an already-`start`ed `(sessionId, streamId)`. Opens
 * the media uplink/downlink and the control-plane channel views; `close`-ish
 * teardown happens on `stop` / `abort`.
 */
export function liveSessionHandle(deps: LiveSessionHandleDeps): RuntimeLiveSessionHandle {
  const { client, media, ref } = deps;
  const scope: SubscriptionScope = { kind: "session", id: ref.sessionId };

  const uplinkChannel: MediaUplink = media.openUplink(ref);
  const downlinkChannel: MediaDownlink = media.openDownlink(ref);

  // ── downlink observe (client receives) ──
  const frameListeners = new Set<(f: MediaFrame) => void>();
  const offDownlink = downlinkChannel.onFrame((f) => {
    for (const cb of [...frameListeners]) cb(f);
  });

  // ── control-plane channels (transcripts + state) ──
  const transcriptListeners = new Set<(t: TranscriptDelta) => void>();
  const stateListeners = new Set<(s: LiveState) => void>();
  let status: LiveState = "idle";

  // State view is eager so `status` stays live (a UI reads it to drive playback).
  const stateView: ChannelView<unknown, LiveStateFrame> = channelView<unknown, LiveStateFrame>(
    client,
    scope,
    LIVE_STATE_CHANNEL,
    {
      initial: undefined,
      reduce: (_prev, frame) => {
        if (frame.streamId !== ref.streamId) return _prev;
        status = frame.state;
        for (const cb of [...stateListeners]) cb(frame.state);
        return frame.state;
      },
    },
  );

  // Transcript view is lazy — opened on the first `onTranscript` (a headless
  // server-to-server client may never render transcripts).
  let transcriptView: ChannelView<unknown, LiveTranscriptFrame> | undefined;
  const ensureTranscriptView = (): void => {
    if (transcriptView !== undefined) return;
    transcriptView = channelView<unknown, LiveTranscriptFrame>(
      client,
      scope,
      LIVE_TRANSCRIPT_CHANNEL,
      {
        initial: undefined,
        reduce: (_prev, frame) => {
          if (frame.streamId !== ref.streamId) return _prev;
          for (const cb of [...transcriptListeners]) cb(frame.transcript);
          return frame.transcript;
        },
      },
    );
  };

  const sendFrame = (frame: MediaFrame): Promise<void> => uplinkChannel.send(frame);

  const onFrame = (cb: (f: MediaFrame) => void): Unsubscribe => {
    frameListeners.add(cb);
    return () => {
      frameListeners.delete(cb);
    };
  };

  // ── runtime stream projections over the imperative surface ──
  const uplink = new WritableStream<MediaFrame>({
    write: (frame) => sendFrame(frame),
  });
  const downlink = new ReadableStream<MediaFrame>({
    start: (controller) => {
      onFrame((f) => controller.enqueue(f));
    },
  });

  const teardown = (): void => {
    offDownlink();
    frameListeners.clear();
    transcriptListeners.clear();
    stateListeners.clear();
    stateView.close();
    transcriptView?.close();
    void uplinkChannel.close();
    void downlinkChannel.close();
  };

  const handle: RuntimeLiveSessionHandle = {
    ref,
    get status(): LiveState {
      return status;
    },
    sendFrame,
    onFrame,
    onTranscript: (cb) => {
      ensureTranscriptView();
      transcriptListeners.add(cb);
      return () => {
        transcriptListeners.delete(cb);
      };
    },
    onState: (cb) => {
      stateListeners.add(cb);
      return () => {
        stateListeners.delete(cb);
      };
    },
    interrupt: async (playedMs) => {
      await client.transport.request("live/interrupt", {
        sessionId: ref.sessionId,
        streamId: ref.streamId,
        ...(playedMs !== undefined ? { playedMs } : {}),
      });
    },
    stop: async () => {
      await client.transport.request("live/stop", {
        sessionId: ref.sessionId,
        streamId: ref.streamId,
      });
      teardown();
    },
    abort: async (reason) => {
      await client.transport.request("live/stop", {
        sessionId: ref.sessionId,
        streamId: ref.streamId,
        hard: true,
        ...(reason !== undefined ? { reason } : {}),
      });
      teardown();
    },
    // RUNTIME projections (ADR 88) — not on the portable spec surface.
    uplink,
    downlink,
  };

  return handle;
}
