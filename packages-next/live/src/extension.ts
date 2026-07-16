/**
 * `withLive({ onStream })` — the `SessionExtension` that installs the live
 * media surface (ADR 88).
 *
 * `live` is an OPTIONAL extension (like sandbox / mcp), so — unlike the bundled
 * built-ins (tasks / knobs, whose per-session harness the AppHarness constructs
 * at `buildSessionBridges`) — `withLive` CONSTRUCTS its own `LiveHarness`
 * against the installer substrate and registers it under the `"live"` namespace,
 * exactly like `withSandbox` registers its bridge. That single instance backs
 * `session.live`, `bridges.live`, and the tool-handler `ctx`.
 *
 * The CONTROL-plane wire methods (`live/*`) are a SEPARATE concern: the adopter
 * registers the exported {@link import("./wire.js").liveWireExtension} at the
 * gateway (`createGateway({ wireExtensions: [liveWireExtension] })`). It is NOT
 * a bundled wire-extension (`app-next`'s `builtinWireExtensions`) because live
 * is optional — the same split every optional package follows.
 *
 * Flat options (no `config` wrapper), per the v2 `withX` convention.
 *
 * @see packages-next/tasks/src/extension.ts
 * @see packages-next/sandbox/src/extension.ts
 * @see docs/proposals/v2/blueprint/88-live-media-sessions.md
 */

import type {
  LiveStream,
  MediaFrame,
  MediaSessionRef,
  SessionExtension,
  SessionInstaller,
} from "@agentick/spec-next";

import { LiveHarness } from "./harness.js";

export const EXTENSION_NAME = "@agentick/live-next" as const;

export interface WithLiveOptions {
  /**
   * The per-stream birth hook — invoked with a fresh {@link LiveStream} each
   * time a client opens a new `(sessionId, streamId)`. Where the app wires its
   * STT/TTS and turn glue over existing primitives. Omit for a bare substrate
   * (routing works; nobody observes uplink).
   */
  readonly onStream?: (stream: LiveStream) => void;
  /**
   * The downlink sink — where `stream.sendFrame` delivers server→client frames.
   * Injected by the media-transport server half. Omit in v0 core (frames are
   * dropped until the reference transport lands — an ADR 88 Future direction).
   */
  readonly downlinkSink?: (ref: MediaSessionRef, frame: MediaFrame) => void | Promise<void>;
}

export function withLive(options: WithLiveOptions = {}): SessionExtension {
  return {
    name: EXTENSION_NAME,
    target: "session",
    install: (installer: SessionInstaller): void => {
      const harness = new LiveHarness(
        installer.sessionId,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        {
          // Resolve the owning session lazily — it is not registered in
          // `app.getSession` at install time; it is by the time a stream opens.
          session: () => installer.app.getSession?.(installer.sessionId),
          ...(options.onStream !== undefined ? { onStream: options.onStream } : {}),
          ...(options.downlinkSink !== undefined ? { downlinkSink: options.downlinkSink } : {}),
        },
      );
      installer.registerNamespace("live", harness);
    },
  };
}
