# @agentick/live-next

**LiveHarness — the real-time media plane (ADR 88).**

A live voice/video agent needs to stream mic audio (and video frames) **up** to
the server continuously and stream media **down**. The existing wire has
`request` / `subscribe` / `progress` but no sustained client→server uplink. This
package adds the missing pipes: a media-plane transport capability, a
session-scoped `MediaSession` keyed by `(sessionId, streamId)`, and the
`session.live` handle.

It deliberately stops at the pipes. Everything above them — STT/TTS
orchestration, turn detection, barge-in policy, realtime-provider integration,
full-duplex — is either an existing agentick primitive (`session.send`, `guard`,
steering, tasks, channels) or an **ADR 88 Future direction**. The framework
ships the pipes; the adopter composes the rest.

`live` is an **OPTIONAL** extension (like `sandbox` / `mcp`), NOT a bundled
built-in. Install it separately.

## Two planes

- **Control/event plane** rides the existing wire: `live/start` / `live/stop` /
  `live/interrupt` are ADR 46 wire methods; transcripts + state ride ADR 33
  channels (`live-transcript` / `live-state`).
- **Media plane** is the new primitive: opaque framed media keyed by
  `(sessionId, streamId)`. It is a **capability a transport optionally
  implements** (`MediaTransport`), feature-detected via
  `transport.capabilities.media` — not a method on the shared core
  `ClientTransport`.

## Quick start

### Server — `withLive({ onStream })`

```ts
import { createApp } from "agentick";
import { withLive, liveWireExtension } from "@agentick/live-next";

const app = createApp(<VoiceAgent />, {
  model,
  extensions: [
    withLive({
      onStream(stream) {
        // A new (sessionId, streamId) opened. Wire your STT/TTS here.
        const stt = myStt.open(); // the app's STT — no framework interface
        stream.onFrame((f) => stt.write(f));
        stt.onTranscript((t) => {
          stream.emitTranscript(t);
          if (t.final) {
            // EXISTING primitive — one user turn = one send.
            const exec = stream.session.send({ messages: [assemble(t.text)] });
            pipeReplyToTts(exec, stream.downlink); // app glue: reply → TTS → downlink
          }
        });
        // Barge-in is app-composed from the interrupt signal + existing primitives.
        stream.onInterrupt((playedMs) => bargeIn(playedMs));
      },
    }),
  ],
});

// The live/* CONTROL commands ride the Agentick wire — register at the gateway.
// live is OPTIONAL, so it is NOT in app-next's builtinWireExtensions.
const gateway = createGateway({ wireExtensions: [liveWireExtension] });
```

### Client — `session.live.start()`

```ts
import "@agentick/live-next/client"; // contributes session.live

const live = await client.session(id).live.start(); // auto-bound (sessionId, streamId)

// UPLINK — mic → frames → sink, continuous (compose your own TransformStreams).
micStream.pipeThrough(pcm16Worklet).pipeThrough(encodeFrames).pipeTo(live.uplink);
// or, headless: for (…) await live.sendFrame(frame)

// DOWNLINK — provider audio → speaker.
live.downlink.pipeTo(playbackSink); // or live.onFrame(cb)

live.onTranscript((t) => render(t));
live.onState((s) => ui.setState(s)); // idle|listening|thinking|speaking|closed

// ...later
await live.interrupt(player.playedMs()); // within-stream barge-in
await live.stop(); // graceful end
```

## API

### Server

| Export                                  | Purpose                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `withLive({ onStream, downlinkSink? })` | `SessionExtension` — constructs the per-session `LiveHarness` + registers it under `"live"`.                                                 |
| `liveWireExtension`                     | The `live/*` `WireExtension` (register at the gateway — optional, not built-in).                                                             |
| `LiveHarness`                           | The stream registry + routing (`start` / `push` / `interrupt` / `stop`).                                                                     |
| `session.live` (`LiveHarnessProtocol`)  | Server-side surface the wire handlers drive.                                                                                                 |
| `LiveStream`                            | Per-stream `onStream` context: `onFrame` / `uplink` / `sendFrame` / `downlink` / `emitTranscript` / `emitState` / `onInterrupt` / `session`. |

### Client (`@agentick/live-next/client`)

| Export                              | Purpose                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `session.live.start(streamId?)`     | Opens a stream, returns a `LiveSessionHandle` auto-bound to `(sessionId, streamId)`.                                       |
| `LiveSessionHandle`                 | `sendFrame` / `onFrame` / `onTranscript` / `onState` / `interrupt` / `stop` / `abort` / `status` / `ref`.                  |
| `handle.uplink` / `handle.downlink` | First-class `WritableStream` / `ReadableStream` projections over the callback surface (runtime, not on the portable spec). |

### Data / contracts (re-exported from `@agentick/spec-next`)

`MediaSessionRef` · `MediaFrame` · `MediaEnvelope` · `LiveState` ·
`TranscriptDelta` · `MediaTransport` · `MediaUplink` · `MediaDownlink`.

## Patterns

- **Callback is the spec; streams are the projection.** The portable surface is
  `sendFrame` / `onFrame` (Node === browser, no stream-type dependency in
  `spec-next`); `uplink` / `downlink` are first-class runtime projections for
  `pipeThrough`.
- **Continuous by default.** A `MediaSession` is one continuous span from `start`
  to `stop` — the mic never closes mid-conversation. Utterance boundaries are the
  app's concern.
- **Backpressure is load-bearing.** _Awaiting_ `sendFrame` IS the backpressure
  signal; the `WritableStream` projection maps it to the writer's `ready`.
- **Barge-in is not framework logic.** `interrupt` is just the client→server
  signal carrying the played-audio offset; the app composes barge-in on
  `onInterrupt` from `execution.abort()` + steering.

## Verified by

- `src/__tests__/wire.spec.ts` — `live/start` / `live/stop` / `live/interrupt`
  route to `session.live`; session resolution across apps; unresolved-session
  throw.
- `src/__tests__/harness.spec.ts` — `(sessionId, streamId)` routing to the right
  `onStream` context; `sendFrame`/`onFrame` ↔ `uplink`/`downlink` projection
  equivalence; interrupt → `onInterrupt`; lifecycle cleanup on `stop`/`close`;
  the `session` resolver.
- `src/client/__tests__/live-session-handle.spec.ts` — `sendFrame` issues the
  uplink `send`; `onFrame` fires; projection equivalence; control commands issue
  the right `live/*` calls; `start()` auto-binds ids; media-capability guard.

## Roadmap & known gaps (ADR 88 Future directions — deliberately deferred)

- **The network media plane — the WS media lane.** The in-process media plane
  **landed** (`@agentick/live-next/testing` `inProcessLiveMedia(gateway)`, composed
  via `inProcessTransport({ gateway, media })`) — frames flow client↔server in a
  full-stack e2e. The over-the-network lane is deferred, and it is a **native
  capability of `@agentick/transport-websocket`** (binary frames on the shared
  control socket + the `MediaFrame` codec), **NOT a separate package** — media
  rides the same wire as control. Only out-of-band transports (WebRTC/SIP, which
  bring their own connection) warrant a package.
- **The engine packaging** — `pipelineEngine` + session-oriented `SttEngine` /
  `TtsEngine` seams (validated against Google streaming-STT in ADR 88a).
- **`TurnArbiter`** — a verdict seam for turn-triggering + barge-in (a
  specialization of the existing `guard`).
- **Capability record + `RealtimeModel` archetype** — pipeline-vs-realtime behind
  one surface (OpenAI Realtime / Gemini Live).
- **Driven execution source (full-duplex)** — a loop triggered by its input
  source rather than by external `send`.
- **Per-op lifecycle hooks** (`onBeforeLiveStart`, …) — v0 declares none (ADR 88):
  the right grain is lifecycle, never per-frame, and `withLive({ onStream })` is
  the extension point. Adding one later is a two-line augmentation.

## Status

v0 minimal core: transport contract + handle + routing + wire + client, unit
tested with fake transports. Not yet integrated end-to-end (no real media
transport). Private workspace package.
