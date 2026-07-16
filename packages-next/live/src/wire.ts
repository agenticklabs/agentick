/**
 * `liveWireExtension` — the `live/*` control-plane `WireExtension` (ADR 88).
 *
 * The client→server control commands of a live session ride the existing
 * Agentick wire (ADR 46): `live/start` opens a stream, `live/stop` ends it,
 * `live/interrupt` signals barge-in. Server→client events (transcripts, state)
 * ride ADR 33 channels; the media plane rides the separate `MediaTransport`
 * sidecar. Mirror of `tasksWireExtension`.
 *
 * Session resolution mirrors `tasksWireExtension`: iterate the gateway's apps,
 * take the first whose `getSession(sessionId)` resolves.
 *
 * **Registration is OPTIONAL, not built-in.** `live` is an optional extension
 * (like sandbox / mcp), so this is NOT added to `builtinWireExtensions`. The
 * adopter registers it via `withLive()`'s `ExtensionBundle.wire` (distributed to
 * the ADR 46 registry by `createGateway({ extensions })`) or by passing it in
 * `wireExtensions` directly.
 *
 * @see packages-next/tasks/src/wire.ts
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 * @verifiedBy packages-next/live/src/__tests__/wire.spec.ts
 */

import {
  AppNotFoundError,
  defineWireExtension,
  type AppHarnessProtocol,
  type SessionHarnessProtocol,
  type WireExtension,
} from "@agentick/spec-next";

import "./wire-augment.js"; // types `live/*` on WireMethods

function resolveSession(
  apps: readonly AppHarnessProtocol[],
  sessionId: string,
): SessionHarnessProtocol {
  for (const app of apps) {
    const sess = app.getSession(sessionId);
    if (sess) return sess;
  }
  throw new AppNotFoundError({ appId: sessionId });
}

function liveOf(session: SessionHarnessProtocol): NonNullable<SessionHarnessProtocol["live"]> {
  const live = session.live;
  if (!live) {
    throw new Error(
      `session "${session.id}" has no live harness — install withLive() to enable the live/* wire methods.`,
    );
  }
  return live;
}

export const liveWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/live-next#wire",
  namespace: "live",
  version: "1.0.0",
  methods: {
    "live/start": async (params, ctx) => {
      const session = resolveSession(
        ctx.gateway.apps() as readonly AppHarnessProtocol[],
        params.sessionId,
      );
      const ref = liveOf(session).start(params.streamId);
      return { sessionId: ref.sessionId, streamId: ref.streamId };
    },
    "live/stop": async (params, ctx) => {
      const session = resolveSession(
        ctx.gateway.apps() as readonly AppHarnessProtocol[],
        params.sessionId,
      );
      await liveOf(session).stop(params.streamId, {
        ...(params.hard !== undefined ? { hard: params.hard } : {}),
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
      });
      return null;
    },
    "live/interrupt": async (params, ctx) => {
      const session = resolveSession(
        ctx.gateway.apps() as readonly AppHarnessProtocol[],
        params.sessionId,
      );
      liveOf(session).interrupt(params.streamId, params.playedMs);
      return null;
    },
  },
});
