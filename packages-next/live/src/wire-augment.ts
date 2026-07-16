/**
 * Wire-method augmentation — adds the `live/*` control-plane rows to the spec
 * `WireMethods` seed. Split out from the server-bridge {@link ./augment.ts} so
 * the CLIENT subpath can type `live/start` / `live/stop` / `live/interrupt`
 * WITHOUT loading the server-bridge augmentations (the `session.live` handle
 * issues `client.transport.request("live/start", …)`).
 *
 * Pure type-only augmentation (zero runtime) — a browser bundle importing it as
 * a side effect pulls no server code. Mirrors `@agentick/tasks-next`'s
 * `wire-augment.ts`.
 *
 * The `export {}` is load-bearing: without a top-level import/export this file
 * is a SCRIPT, and `declare module "@agentick/spec-next"` would be read as an
 * ambient module declaration that SHADOWS the real spec module (every export
 * vanishes). The empty export makes it a module, so the block is a merging
 * augmentation instead.
 */

export {};

declare module "@agentick/spec-next" {
  interface WireMethods {
    /**
     * Open a new continuous media stream (control plane). Mints the `streamId`
     * server-side when omitted and returns the auto-bound ref. The media plane
     * itself rides the separate `MediaTransport` sidecar, not this RPC.
     */
    "live/start": {
      params: { sessionId: string; streamId?: string };
      result: { sessionId: string; streamId: string };
    };
    /**
     * End a media stream — `hard: true` a hard kill, else graceful. The
     * observable effect (a `closed` state transition) returns on the
     * `live-state` channel (CQRS — no state in the response).
     */
    "live/stop": {
      params: { sessionId: string; streamId: string; hard?: boolean; reason?: string };
      result: null;
    };
    /**
     * Within-stream barge-in signal carrying the played-audio offset (ms) the
     * client alone knows. Lands on the server as `LiveStream.onInterrupt`; the
     * stream stays OPEN. Barge-in policy is app-composed (ADR 88).
     */
    "live/interrupt": {
      params: { sessionId: string; streamId: string; playedMs?: number };
      result: null;
    };
  }
}
