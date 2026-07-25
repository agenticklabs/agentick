/**
 * `session.live` — the thin client facet (factory + registry) over a session's
 * live media streams (ADR 88).
 *
 * `session.live.start()` mints a `MediaSession` `(sessionId, streamId)`, issues
 * the `live/start` control command, and returns a {@link LiveSessionHandle}
 * auto-bound to that ref. Multiple concurrent `streamId`s per conversation fall
 * out for free (mic uplink + screen-share = two streams), tracked in `active`.
 *
 * The media plane is a transport CAPABILITY (ADR 88 §Two planes) — feature-
 * detected here off `transport.capabilities.media` + a structural check.
 * `start()` throws loud if the connected transport has no media path, rather
 * than silently returning a handle whose `sendFrame` goes nowhere.
 *
 * @verifiedBy packages/live/src/client/__tests__/live-session-handle.spec.ts
 */

import { ulid } from "@agentick/utils";
import type { ClientTransport, MediaTransport } from "@agentick/spec";

import {
  liveSessionHandle,
  type LiveCommandClient,
  type RuntimeLiveSessionHandle,
} from "./live-session-handle.js";

/** The client surface the facet needs — the full transport (capabilities + media). */
export interface LiveFacetClient {
  readonly transport: ClientTransport;
}

/** The `session.live` facet. */
export interface SessionLive {
  /**
   * Open a new continuous media stream. Mints the `streamId` when omitted,
   * issues `live/start`, and returns the auto-bound handle. Throws if the
   * transport has no media capability.
   */
  start(streamId?: string): Promise<RuntimeLiveSessionHandle>;
  /** Every currently-open handle on this session, in open order. */
  readonly active: readonly RuntimeLiveSessionHandle[];
}

/**
 * Structural + flag feature-detect of the media-plane capability on a transport.
 * Both must hold: the transport advertises `capabilities.media` AND exposes the
 * {@link MediaTransport} methods.
 */
function asMediaTransport(transport: ClientTransport): MediaTransport | undefined {
  if (!transport.capabilities.media) return undefined;
  const candidate = transport as unknown as Partial<MediaTransport>;
  if (typeof candidate.openUplink !== "function" || typeof candidate.openDownlink !== "function") {
    return undefined;
  }
  return candidate as MediaTransport;
}

export function sessionLive(client: LiveFacetClient, sessionId: string): SessionLive {
  const active = new Map<string, RuntimeLiveSessionHandle>();

  return {
    start: async (streamId?: string): Promise<RuntimeLiveSessionHandle> => {
      const media = asMediaTransport(client.transport);
      if (media === undefined) {
        throw new Error(
          "session.live.start(): the connected transport has no media capability (transport.capabilities.media is false / MediaTransport not implemented). Use a media-capable transport — the WS media lane (@agentick/transport-websocket) over the network, or inProcessTransport({ gateway, media: inProcessLiveMedia(gateway) }) in-process.",
        );
      }

      const requestedId = streamId ?? `live:${ulid()}`;
      const commandClient: LiveCommandClient = { transport: client.transport };
      // The server may mint / normalize the id — bind to what it returns.
      const opened = await client.transport.request("live/start", {
        sessionId,
        streamId: requestedId,
      });
      const ref = { sessionId: opened.sessionId, streamId: opened.streamId };

      const handle = liveSessionHandle({ client: commandClient, media, ref });
      active.set(ref.streamId, handle);
      return handle;
    },
    get active(): readonly RuntimeLiveSessionHandle[] {
      return [...active.values()];
    },
  };
}
