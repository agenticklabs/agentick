/**
 * `@agentick/live-next/testing` — in-process / test-composition helpers.
 *
 * `inProcessLiveMedia(gateway)` is the in-memory `MediaTransport` (ADR 88) that
 * carries frames client↔server without a network — compose it with the generic
 * control transport (`inProcessTransport({ gateway, media: inProcessLiveMedia(gateway) })`)
 * to run a full live media plane in one process.
 */

export { inProcessLiveMedia } from "./in-process-media.js";
