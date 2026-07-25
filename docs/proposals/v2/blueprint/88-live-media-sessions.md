# ADR 88 — Live media sessions (the uplink/downlink plane + `session.live`)

**Status:** DRAFT 2026-07-15 (Fable, with Ryan) · rev 3 (**retargeted to the minimal core**: transport capability + handle + stream routing. Engine / arbiter / realtime / full-duplex demoted to Future directions.)
**Depends on:** ADR 26 (everything is a harness), ADR 27 (modular built-ins / augmentation law), ADR 33 (client + channels), ADR 46 (wire extensions), ADR 53 (steering), ADR 87 (client sub-handles mirror server bridges).
**Nature:** OPTIONAL extension (like `sandbox`/`mcp`), NOT a bundled built-in. Ships as `@agentick/live`, installed separately.

## Problem

Agentick has no real-time media path. A live voice/video agent needs to stream
mic audio (and video frames) **up** to the server continuously and stream media
**down**. The wire (`ClientTransport`) has `request` (client→server, one-shot),
`subscribe` (server→client stream), `progress` (server→client, RPC-bound) —
**no sustained client→server uplink**. `capabilities.binaryFrames` is a `false`
placeholder.

This ADR defines the **minimal core** that makes live media real: a media-plane
transport capability, a session-scoped `MediaSession` keyed by
`(sessionId, streamId)`, and the `session.live` handle. It deliberately stops
there. Everything above the pipes — STT/TTS orchestration, turn detection,
barge-in policy, realtime-provider integration, full-duplex — is either an
existing agentick primitive or **explicitly deferred** (see Future directions),
because we do not yet know its logic well enough to formalize it. The framework
ships the pipes; the adopter composes the rest from primitives that already exist
(`session.send`, `guard`, steering, tasks, channels).

### Design decisions carried in from the design thread

- **Continuous by default.** A `MediaSession` is a continuous bidirectional span
  from `start` to `stop`; the mic is never closed mid-conversation. Utterance
  boundaries, if any, are the app's concern, not a framework lifecycle.
- **Callback/imperative is the spec; streams are the projection.** The portable
  spec surface is `sendFrame`/`onFrame` (+ typed `onTranscript`/`onState`) — no
  stream-type dependency in `@agentick/spec` (Node === browser). The
  `WritableStream`/`ReadableStream` faces are first-class runtime projections over
  it, for `pipeThrough` composition.
- **Grounded** in the common denominator of OpenAI Realtime, Gemini Live, the AI
  SDK, LiveKit, and Pipecat, with parity to the shipped Knowify v1 as the floor.

## Two planes

- **Control/event plane** rides the existing agentick wire: client→server commands
  (`live/start`, `live/stop`, `live/interrupt` — the last a distinct within-stream
  barge-in signal carrying `playedMs`, not folded into `stop`) are ADR 46 wire
  methods; server→client events
  (transcripts, state) are ADR 33 channels. Already exists.
- **Media plane** is the new primitive: opaque framed media keyed by
  `(sessionId, streamId)`. It is a **capability a transport optionally implements**,
  not a method on core `ClientTransport` (which the whole system shares — cf.
  "wire constraints live at the wire"). In-band transports (WebSocket) implement it
  with binary frames on the same socket; out-of-band transports (WebRTC) negotiate a
  media track and hand back an opaque sink/source. The `MediaSession` id
  `(sessionId, streamId)` is the correlation key that lets the media plane be a
  sidecar the control plane never has to carry.

```ts
// spec: feature-detected, NOT on core ClientTransport.
interface TransportCapabilities { /* … */ readonly media: boolean; }

interface MediaTransport {
  openUplink(ref: MediaSessionRef): MediaUplink;     // client → server
  openDownlink(ref: MediaSessionRef): MediaDownlink; // server → client
}
interface MediaUplink {
  send(frame: MediaFrame): Promise<void>;            // awaiting = backpressure
  close(reason?: string): Promise<void>;
}
```

Backpressure is load-bearing (Knowify's Google `write(): boolean` + pause):
*awaiting* `send` is the signal; the `WritableStream` projection maps it to the
writer's `ready`.

## `MediaSession` and `MediaFrame`

`session.live.start()` mints a `MediaSession` identified by `(sessionId, streamId)`
— `sessionId` binds to the agentick conversation, `streamId` scopes one continuous
media stream within it. Multiple concurrent `streamId`s per conversation fall out
for free (mic uplink + screen-share video = two streams).

```ts
interface MediaSessionRef { readonly sessionId: string; readonly streamId: string; }

// General media, NOT audio-specific — video/image/screen ride the same session.
interface MediaFrame {
  readonly kind: "audio" | "video" | "image" | (string & {});
  readonly envelope: MediaEnvelope;
  readonly payload: Uint8Array;
}
interface MediaEnvelope {
  readonly format: string;      // "audio/pcm" | "audio/pcmu" | "image/jpeg" | …
  readonly sampleRate?: number; // never hardcode a rate — carry it
  readonly channels?: number;
  readonly timestamp: number;   // ms, monotonic within the session
  readonly seq: number;         // ordering
}
```

## The client handle — `session.live` + `LiveSessionHandle`

`session.live` is a thin facet (factory + registry); `session.live.start()` returns
a `LiveSessionHandle` **auto-bound to `(sessionId, streamId)`** — the caller never
threads ids again. The media surface is **imperative (spec) + stream (projection)**,
and it is asymmetric by direction: the client *sends* uplink and *receives*
downlink.

```ts
// ─── SPEC (portable; imperative + callback; Node === browser) ───
interface LiveSessionHandle {
  readonly ref: MediaSessionRef;                     // { sessionId, streamId } — auto-bound
  readonly status: LiveState;                        // idle|listening|thinking|speaking|closed

  sendFrame(frame: MediaFrame): Promise<void>;       // UPLINK push; await = backpressure
  onFrame(cb: (f: MediaFrame) => void): Unsubscribe; // DOWNLINK observe (client receives)
  onTranscript(cb: (t: TranscriptDelta) => void): Unsubscribe;
  onState(cb: (s: LiveState) => void): Unsubscribe;

  interrupt(playedMs?: number): Promise<void>;       // manual barge-in signal (see note)
  stop(): Promise<void>;                             // graceful end of the continuous stream
  abort(reason?: string): Promise<void>;            // hard kill
}
```

```ts
// ─── RUNTIME/CLIENT (first-class projections over the spec) ───
handle.uplink                   // WritableStream<MediaFrame> — sink.write = sendFrame; ready ⇒ backpressure
handle.downlink                 // ReadableStream<MediaFrame> — enqueues from onFrame
```

`sendFrame` (not `send`) deliberately avoids collision with `session.send`
(message send). There is **no** client-side downlink *send*; the client *receives*
downlink via `onFrame`/`downlink`. The mirror `sendFrame`-for-downlink lives on the
server (below). Producing/consuming frames — capture, resample, VAD, encode,
playback — is the app's business, composed as `TransformStream`s:

```ts
const live = await client.session(id).live.start();
micStream.pipeThrough(pcm16Worklet).pipeThrough(encodeFrames).pipeTo(live.uplink); // compose
live.downlink.pipeTo(playbackSink);                                                 // or onFrame(cb)
live.onTranscript((t) => render(t));
// a Node (server-to-server) client with no MediaStream just: for (…) await live.sendFrame(frame)
```

`interrupt`/`stop`/`abort` touch the stream differently: `stop` ends it
gracefully, `abort` hard-kills it, `interrupt` is a within-stream barge-in that
keeps it open. Barge-in itself is **not framework logic** — the app composes it
from existing primitives (`execution.abort()` + steering `send`); `interrupt` is
just the client→server signal that carries the played-audio offset.

## The server surface — `withLive({ onStream })` + routing

The server contribution is **stream routing + a per-stream hook**, nothing more —
no engine, no arbiter. A frame tagged `(sessionId, streamId)` is routed to the
right per-stream context; the app wires everything else with existing primitives.

```ts
// server stream context — the mirror of the client handle
interface LiveStream {
  readonly ref: MediaSessionRef;
  readonly session: SessionHarnessProtocol;          // .send(), dispatch, timeline — EXISTING

  onFrame(cb: (f: MediaFrame) => void): Unsubscribe;  // UPLINK observe (server receives)
  readonly uplink: ReadableStream<MediaFrame>;        // projection
  sendFrame(frame: MediaFrame): Promise<void>;        // DOWNLINK push (server sends)
  readonly downlink: WritableStream<MediaFrame>;      // projection

  emitTranscript(t: TranscriptDelta): void;           // → control channel → client.onTranscript
  emitState(s: LiveState): void;
}

withLive({
  onStream(stream: LiveStream) {                       // a new (sessionId, streamId) opened
    const stt = myStt.open();                          // APP's STT — no framework interface
    stream.onFrame((f) => stt.write(f));
    stt.onTranscript((t) => {
      stream.emitTranscript(t);
      if (t.final) {
        const exec = stream.session.send({ messages: [assemble(t.text)] }); // EXISTING primitive
        pipeReplyToTts(exec, stream.downlink);         // app glue: reply → app's TTS → downlink
      }
    });
  },
});
```

Cleanup on `stop`/disconnect is the routing layer's job (the registry drops the
stream and closes its transport half).

### Hooks & interception (harness for free, but not symmetric)

`live` is a harness, so it inherits `BaseHarness.runOperation` + `HookBridges` —
the before/after hook *machinery* is free. But two rules hold:

- **Server hooks are lifecycle-grained and opt-in by declaration.** You get
  `onBeforeLive<Op>`/`onAfterLive<Op>` only for operations declared as hookable
  verbs and augmented onto `HookBridges` (like `onBeforeElicitationElicit`). The
  right grain is **lifecycle** (`start`/`stop`) — **never per-frame** (frames are
  30–50/sec; hooking each is the wrong grain and a perf sink). Frame interception
  is `onFrame` (observe), not a hook.
- **The client is a projection, not a harness — no before/after op hooks.** The
  `LiveSessionHandle` issues wire commands and consumes channels; it doesn't
  execute the ops, so hooks don't fire there. The client gets **event callbacks**
  (`onFrame`/`onTranscript`/`onState`) and, if genuine call interception is needed,
  **Procedure middleware** (`proc.use(...)`) — the general mechanism, not harness
  hooks.

**v0 declares no per-op hooks.** `withLive({ onStream })` is the extension point,
and `onStream` hands you the stream at birth — where setup belongs. The machinery
is there; exposing `onBeforeLiveStart` later is a two-line augmentation, so it stays
out until a real need appears.

## What the app owns (existing primitives — no new framework code)

STT · TTS · VAD · multimodal assembly (`ContentBlock[]`, already expressible) ·
triggering a turn (`session.send`) · **barge-in** (`execution.abort()` + steering
`send`) · actionability gating (the existing `guard` seam) · background work while
talking (the Tasks harness) · which transcription vendor. The framework contributed
only the pipe + routing + a hook.

## Explicitly NOT in scope

VAD/STT/TTS implementations (seams live in *app* or optional adapter pkgs; Silero
is a separate pkg) · WebRTC/SIP/jitter/AEC (adapter interface + reference
WS-binary) · message-assembly policy · turn-detection models · a barge-in
subsystem (app-composed) · **the entire engine layer** — `pipelineEngine`,
`SttEngine`/`TtsEngine` formal seams, `TurnArbiter`, capability record,
`RealtimeModel` archetype, driven-loop/full-duplex, 2-track reflex tier. All
deferred (Future directions).

## Package shape

**Landed (v0 core + in-process media plane):**

- **`@agentick/live`** (optional, public install) — `MediaSession` +
  `LiveHarnessProtocol` (incl. the `onDownlink` egress seam), the `session.live`
  server handle + `live/*` wire extension, the stream **routing** +
  `withLive({ onStream })` hook.
- **`@agentick/live/client`** — the `LiveSessionHandle` (`sendFrame`/`onFrame`
  spec + `uplink`/`downlink` projections).
- **`@agentick/live/testing`** — `inProcessLiveMedia(gateway)`, the in-memory
  `MediaTransport`, composed via `inProcessTransport({ gateway, media })`.
- **`@agentick/transport-in-process`** — gained a generic
  `media?: MediaTransport` option (stays live-agnostic; just exposes what it is
  handed).
- **`@agentick/spec`** — `session-next` exposes optional-extension bridges as
  `session.<name>` getters (the server twin of the ADR-87 client sub-handles), so
  an optional extension's wire method can reach its harness (`session.live`).

**Media transport is a CAPABILITY, not a package — the in-band rule.**
`MediaTransport` is implemented BY a transport that already owns a connection;
media rides the *same wire* as control. So there is deliberately **no
`transport-ws-media-next` package**: the network media plane is a **native
capability of `@agentick/transport-websocket`** (flip `binaryFrames`/`media` to
`true`; add a `MediaFrame` binary codec beside the existing JSON codec +
`openUplink`/`openDownlink` on the shared socket — a text-vs-binary discriminator
distinguishes the planes), plus a ~40-line WS server router in `live-next` (the WS
analog of `inProcessLiveMedia`). This is symmetric with how
`transport-in-process` gained a native `media` option rather than a `-media`
package.

**The rule — in-band vs out-of-band** (the dividing line is "does it bring its own
connection?", not "is it media?"):

- **In-band** (shares the control connection: WebSocket, in-process) → a
  *capability added to that transport*. No new package.
- **Out-of-band** (brings its OWN connection: WebRTC / SIP — SDP/ICE, media
  tracks, independent lifecycle) → a *new transport package*
  (`transport-webrtc-next`). This is the only case a media package is justified.

Every transport DECLARES `capabilities.media` (a required flag); only
media-capable ones implement the optional `MediaTransport` methods (which are NOT
on the base `ClientTransport`). `session.live.start()` feature-detects and throws
loud on a media-less transport (HTTP sets `media: false` — you cannot run a
continuous bidirectional stream over stateless request/response, so it fails
loud, correctly).

**WebRTC — adopt, don't build; and the plane split.** When it lands,
`transport-webrtc-next` is a **provider-adapter shape, not an SFU we implement**:
because `MediaTransport` is just `openUplink`/`openDownlink` of opaque
`MediaFrame`s, a LiveKit / Daily / Twilio / OpenAI-Realtime *room* is *itself* a
`MediaTransport` — the adapter plugs a provider's WebRTC media plane into the seam
and agentick gets UDP/Opus/jitter-buffer/PLC/AEC/NAT-traversal/video for free
(the wins WS-binary can't match: no TCP head-of-line stall, ~10× less bandwidth via
Opus+DTX, native video tracks). It earns its complexity specifically for
**browser/mobile clients on real networks doing full-duplex conversation** — not
server-to-server glue, where WS-binary is simpler and fine.

Crucially, **the media plane and the control plane may ride DIFFERENT transports.**
`MediaTransport` is a *separately injectable* capability, not fused to the control
transport's methods — `inProcessTransport({ gateway, media })` already proved the
shape. So the canonical realtime split — **JSON-RPC control on WebSocket, media
frames on WebRTC** (`webSocketTransport({ …, media: webrtcMedia(…) })`) — is
admitted with no new machinery. It's exactly what OpenAI Realtime does (WebRTC
media + a paired control channel). The two planes were designed independent so
they can ride independent wires; nothing above the transport (`session.live`, the
handle, `onStream`, barge-in, app code) changes when they do.

## Future directions (explored, deliberately deferred)

These were designed in depth in the thread that produced this ADR; the reasoning is
preserved so the trailheads aren't lost, but none is v0 contract. Build each only
once enough live agents exist to reveal the real shape.

- **The engine packaging** — `pipelineEngine` + session-oriented `SttEngine`/
  `TtsEngine` seams (validated against Google streaming-STT in ADR 88a). Packages
  the `onStream` glue once it's written a few times.
- **`TurnArbiter`** — a verdict seam (proceed/veto/defer/replace/interrupt) for
  turn-triggering + barge-in. It is a *specialization of the existing `guard`*, so
  it does not need its own abstraction yet; inline/guard suffices.
- **Capability record + `RealtimeModel` archetype** — pipeline-vs-realtime behind
  one surface; OpenAI Realtime / Gemini Live as `LoopExecutorFactory`s. Note: even
  in true S2S, the provider supplies both input and output transcripts in-band, so
  the Timeline stays fully populated (assistant text faithful; user text an
  approximation — the fidelity asymmetry vs. the prosody the model actually heard).
- **Driven execution source (full-duplex)** — a loop triggered by its input source
  rather than by external `send`, so an agent can act proactively and be fed by
  connectors/schedulers. Its consumers: S2S voice, full-duplex text, AI-SDK
  ceded-loop interop, autonomous agents. Reactive full-duplex is mostly the
  existing `guard` (admission verdicts) + ADR 53 (facts) + coalescing; only
  *proactive self-trigger* is genuinely new.
- **The 2-track reflex tier** — a fast arbiter model that defends the real-time
  deadline (barge-in, reflexes) while the deliberative model thinks, engaging only
  under contention. Research-grade; lives in the `TurnArbiter`/`guard` slot when it
  earns its keep.

## Verified-by (to accompany implementation)

`MediaTransport` backpressure; `(sessionId, streamId)` routing to the right
`onStream` context; `sendFrame`/`onFrame` ↔ `uplink`/`downlink` projection
equivalence; lifecycle cleanup on stop/disconnect; an end-to-end that a frame sent
on the client `uplink` reaches the server `onStream` handler and a server
`sendFrame` reaches the client `onFrame`.
