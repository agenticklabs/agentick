/**
 * `inProcessLiveMedia` — the live-aware in-process `MediaTransport` (ADR 88).
 *
 * The in-process counterpart of the deferred `@agentick/transport-ws-media-next`:
 * a media plane that carries frames client↔server entirely in-memory, routing to
 * the owning session's `LiveHarness` through the gateway. Compose it with the
 * generic control transport:
 *
 * ```ts
 * const transport = inProcessTransport({ gateway, media: inProcessLiveMedia(gateway) });
 * ```
 *
 * The coupling to `live` lives HERE (this package knows about both the media
 * capability and the harness), NOT in `@agentick/transport-in-process-next`,
 * which stays a generic control transport that merely exposes whatever
 * `MediaTransport` it is handed.
 *
 * - **Uplink** (`send`): resolve the session's `LiveHarness` via the gateway and
 *   call `push(ref, frame)` — the frame lands on the matching stream's `onFrame`.
 * - **Downlink** (`openDownlink`): subscribe to the harness's `onDownlink` egress,
 *   filter by `streamId`, and fan out to this ref's `onFrame` observers.
 *
 * @see docs/proposals/v2/blueprint/88-live-media-sessions.md
 */

import "../augment.js"; // types `session.live` (the SessionHarnessProtocol slot)

import type {
  AppHarnessProtocol,
  GatewayHarnessProtocol,
  LiveHarnessProtocol,
  MediaDownlink,
  MediaFrame,
  MediaSessionRef,
  MediaTransport,
  MediaUplink,
} from "@agentick/spec-next";

/** Resolve a session's live harness across the gateway's apps (mirrors `liveWireExtension`). */
function resolveLive(
  gateway: GatewayHarnessProtocol,
  sessionId: string,
): LiveHarnessProtocol | undefined {
  for (const app of gateway.apps() as readonly AppHarnessProtocol[]) {
    const session = app.getSession(sessionId);
    if (session?.live) return session.live;
  }
  return undefined;
}

/**
 * Build an in-process `MediaTransport` bound to `gateway`. Pass it as
 * `inProcessTransport({ gateway, media: inProcessLiveMedia(gateway) })`.
 */
export function inProcessLiveMedia(gateway: GatewayHarnessProtocol): MediaTransport {
  return {
    openUplink(ref: MediaSessionRef): MediaUplink {
      return {
        async send(frame: MediaFrame): Promise<void> {
          resolveLive(gateway, ref.sessionId)?.push(ref, frame);
        },
        async close(): Promise<void> {
          /* no-op — the harness owns stream lifecycle (live/stop) */
        },
      };
    },
    openDownlink(ref: MediaSessionRef): MediaDownlink {
      const listeners = new Set<(f: MediaFrame) => void>();
      const off = resolveLive(gateway, ref.sessionId)?.onDownlink((r, frame) => {
        if (r.streamId === ref.streamId) for (const cb of listeners) cb(frame);
      });
      return {
        onFrame(cb: (frame: MediaFrame) => void): () => void {
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
          };
        },
        async close(): Promise<void> {
          off?.();
          listeners.clear();
        },
      };
    },
  };
}
