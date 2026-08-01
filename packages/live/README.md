# @agentick/live

**The framework ships the pipes, not the voice agent.** A live voice or video agent needs to stream microphone audio up to the server continuously and stream media back down. The existing wire has request, subscribe, and progress — but no sustained client-to-server uplink. This package adds the missing plumbing: a media-plane transport capability, a session-scoped media stream keyed by `(sessionId, streamId)`, and the `session.live` handle on both sides.

It stops there deliberately. Speech-to-text and text-to-speech orchestration, turn detection, barge-in policy, realtime-provider integration — none of that is here, because all of it is either an existing agentick primitive (`session.send`, `guard`, steering, tasks, channels) or an app decision. Once frames flow, "what is a turn" is a question about your product, not about the framework.

`live` is **optional** — installed separately, not bundled into the `agentick` metapackage.

## Install

```bash
npm install @agentick/live
```

Subpaths: `/client` (the browser-side handle), `/testing` (the in-process media plane).

## Two planes

Control and media travel separately, and knowing which is which explains most of the API.

| Plane             | Carries                                                            | How                                                                              |
| ----------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Control/event** | `live/start`, `live/stop`, `live/interrupt`; transcripts and state | Ordinary wire methods and channels. Nothing new.                                 |
| **Media**         | Opaque framed media keyed by `(sessionId, streamId)`               | A capability a transport **optionally** implements, feature-detected at runtime. |

The media plane is not a method on the shared client transport. It is a `MediaTransport` capability, and a handle checks `transport.capabilities.media` before opening anything — so a transport without a media lane fails at `start()` with a clear error instead of silently dropping frames.

## Quick start

### Server

```tsx
import { createApp } from "agentick";
import { createGateway } from "@agentick/gateway";
import { withLive, liveWireExtension } from "@agentick/live";

const app = await createApp(<VoiceAgent />, {
  compiler,
  model,
  extensions: [
    withLive({
      onStream(stream) {
        // A new (sessionId, streamId) opened. Your STT goes here — the
        // framework has no STT interface, by design.
        const stt = myStt.open();
        stream.onFrame((f) => stt.write(f));

        stt.onTranscript((t) => {
          stream.emitTranscript(t);
          if (t.final) {
            // An existing primitive: one user turn is one send.
            const exec = stream.session.send({ messages: [assemble(t.text)] });
            pipeReplyToTts(exec, stream.downlink); // your glue: reply → TTS → downlink
          }
        });

        // Barge-in is composed from the interrupt signal, not implemented here.
        // `playedMs` is optional — a client that can't measure playback omits it.
        stream.onInterrupt((playedMs) => bargeIn(playedMs ?? 0));
      },
    }),
  ],
});

// The live/* control methods ride the ordinary wire. Because live is optional,
// it is NOT pre-registered — hand it to the gateway yourself.
const gateway = await createGateway({ wireExtensions: [liveWireExtension] });
```

### Client

```ts
import "@agentick/live/client"; // contributes session.live

const live = await client.session(id).live.start(); // auto-bound (sessionId, streamId)

// UPLINK — mic to frames, continuous. Compose your own transforms.
micStream.pipeThrough(pcm16Worklet).pipeThrough(encodeFrames).pipeTo(live.uplink);
// or headless: await live.sendFrame(frame)

// DOWNLINK — provider audio to the speaker.
live.downlink.pipeTo(playbackSink); // or live.onFrame(cb)

live.onTranscript((t) => render(t));
live.onState((s) => ui.setState(s)); // idle | listening | thinking | speaking | closed

await live.interrupt(player.playedMs()); // within-stream barge-in
await live.stop(); // graceful end
```

## Four design decisions worth knowing

**The callback is the contract; streams are a projection.** `sendFrame` and `onFrame` are the portable surface — identical in Node and the browser, with no stream-type dependency in the shapes package. `uplink` and `downlink` are `WritableStream`/`ReadableStream` projections layered on top at runtime, for when you want `pipeThrough`. They are equivalent, and tests pin that equivalence in both directions.

**A stream is continuous by default.** One span from `start` to `stop` — the microphone does not close between utterances. Utterance boundaries are yours to find; the stream does not have an opinion about where a turn ends.

**Backpressure is load-bearing.** _Awaiting_ `sendFrame` **is** the backpressure signal. The `WritableStream` projection maps it onto the writer's `ready`, so a slow consumer propagates naturally rather than accumulating an unbounded queue of audio.

**Barge-in is not framework logic.** `interrupt` is only the client-to-server signal, carrying an optional played-audio offset. What to do about it — abort the execution, steer the loop, discard queued TTS — you compose in `onInterrupt` from primitives that already exist.

## Teardown is an operation

`stop` and `close` run as operations, so an in-process hangup — a turn arbiter deciding the call is over, a tool handler ending a stream — is guardable, hookable, and audited exactly like a remote one arriving over the wire.

| Operation            | Scope                     | Input                          | Journaled            | Hooks                                    |
| -------------------- | ------------------------- | ------------------------------ | -------------------- | ---------------------------------------- |
| `live:command:stop`  | `{ sessionId, streamId }` | `{ streamId, hard?, reason? }` | requested + terminal | `onBeforeLiveStop` / `onAfterLiveStop`   |
| `live:command:close` | `{ sessionId }`           | `{}`                           | **bus-only**         | `onBeforeLiveClose` / `onAfterLiveClose` |

```ts
// "Don't hang up while we're recording."
session.live.guard<{ streamId: string }>((input) =>
  isRecording(input.streamId) ? { kind: "veto", reason: "recording-in-progress" } : undefined,
);
```

A vetoed `stop` leaves the stream live: nothing announces `closed`, and the uplink still routes to its listeners. `stop` is idempotent — two operations, one `closed` state frame.

`close` is bus-only rather than journaled, which is the same rule the app and gateway close operations follow: the body reaches `super.close()`, so a terminal record appended afterwards could target a journal that an `onClose` handler already tore down. Its nested per-stream `stop` records **do** journal, and the override is per-operation-name rather than a blanket suppression — so closing over two live streams produces three records, one per real layer.

> [!IMPORTANT]
> **`start` is deliberately not an operation.** It returns a `MediaSessionRef` synchronously, and a synchronous return cannot host the async interceptor fold. Stream birth is therefore guardable at the wire (`live/start`) but not in process — a blanket in-process veto does not stop it. If you need to gate stream creation, gate the wire method or gate inside `onStream`.

## Running the whole plane in one process

The in-process media transport carries frames without a network, which is how the full plane is tested and the easiest way to develop against it:

```ts
import { inProcessTransport } from "@agentick/transport-in-process";
import { inProcessLiveMedia } from "@agentick/live/testing";

const transport = inProcessTransport({ gateway, media: inProcessLiveMedia(gateway) });
```

The control transport stays generic — it merely exposes the `MediaTransport` it was handed — and the live-aware routing lives in `inProcessLiveMedia`. Frames genuinely round-trip through a real gateway in both directions, and two concurrent streams do not cross.

## API

### `@agentick/live`

| Export                                           | Purpose                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `withLive({ onStream?, downlinkSink? })`         | Session extension. Constructs the per-session harness and registers it.     |
| `liveWireExtension`                              | The `live/*` wire extension. Register it at the gateway yourself.           |
| `LiveHarness`                                    | The stream registry and routing: `start` / `push` / `interrupt` / `stop`.   |
| `session.live`                                   | The server-side surface the wire handlers drive.                            |
| `LIVE_TRANSCRIPT_CHANNEL` / `LIVE_STATE_CHANNEL` | Channel names transcripts and state ride, plus their fully-qualified forms. |

`LiveStream` is what `onStream` receives: `onFrame`, `uplink`, `sendFrame`, `downlink`, `emitTranscript`, `emitState`, `onInterrupt`, and `session` — the owning session, resolved lazily so it is live by the time a stream opens.

### `@agentick/live/client`

| Export                              | Purpose                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `session.live.start(streamId?)`     | Opens a stream; returns a handle auto-bound to `(sessionId, streamId)`.                                   |
| `liveSessionHandle(deps)`           | The headless factory the facet is built on.                                                               |
| `LiveSessionHandle`                 | `sendFrame` · `onFrame` · `onTranscript` · `onState` · `interrupt` · `stop` · `abort` · `status` · `ref`. |
| `handle.uplink` / `handle.downlink` | The stream projections over that callback surface — runtime only, not on the portable contract.           |

Importing the subpath registers `session.live` on the client. It depends on the generic client core rather than the harness runtime, so pulling it into a browser bundle drags no server code in. The control-plane channel names (`LIVE_TRANSCRIPT_CHANNEL` / `LIVE_STATE_CHANNEL` and their `_FQN` twins) and frame types (`LiveTranscriptFrame`, `LiveStateFrame`, and the two name types) are re-exported here for the same reason — a consumer that subscribes itself would otherwise have to import the root barrel.

### `@agentick/live/testing`

| Export                        | Purpose                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `inProcessLiveMedia(gateway)` | In-memory `MediaTransport` carrying frames without a wire. |

### Shapes

Re-exported from [@agentick/spec](../spec) so one dependency gives you both the contract and the implementation: `MediaSessionRef`, `MediaFrame`, `MediaEnvelope`, `MediaTransport`, `MediaUplink`, `MediaDownlink`, `LiveState`, `LiveStream`, `LiveSessionHandle`, `TranscriptDelta`.

## Patterns

**Sending a turn.** `stream.session` is the owning session, so a final transcript becomes an ordinary `send`. Steering works as it does everywhere else: a second `send` mid-execution joins the running one, which is what makes mid-utterance corrections work without special-casing.

**Transports.** [@agentick/transport-in-process](../transport-in-process) is the only transport with a media lane today. [@agentick/transport](../transport) declares the `media` capability flag every transport reports.

**The gateway.** [@agentick/gateway](../gateway) hosts `liveWireExtension` and is where a deployment-wide guard on `live/stop` belongs.

**Channels.** Transcripts and state ride ordinary channels, so anything that consumes a channel consumes these.

## Roadmap & known gaps

- **No network media lane.** The in-process plane works end to end; over the network does not exist yet. When it lands it will be a **native capability of [@agentick/transport-websocket](../transport-websocket)** — binary frames on the shared control socket plus a frame codec — not a separate package, because media should ride the same wire as control. Only out-of-band transports that bring their own connection (WebRTC, SIP) would warrant their own package.
- **No engine packaging.** There is no `SttEngine` or `TtsEngine` seam and no pipeline engine; `onStream` is the extension point and the glue is yours.
- **No turn arbiter.** A verdict seam for turn triggering and barge-in — a specialization of the existing `guard` — is not built.
- **No realtime-model archetype.** Pipeline-style and realtime-style providers (OpenAI Realtime, Gemini Live) are not yet behind one surface, so integrating a realtime provider means driving the frames yourself.
- **No driven execution source.** Full duplex needs a loop triggered by its input source rather than by an external `send`. Every execution here still starts from a `send`.
- **`onBeforeLiveStart` does not exist.** `stop` and `close` have their lifecycle hooks; `start` cannot until the synchronous-return seam is resolved. The grain stays lifecycle either way — there is **no per-frame hook by design**, and `withLive({ onStream })` remains the stream-birth extension point.
- **No React surface.** There are no hooks or components for driving a live session from a component tree; the client handle is plain TypeScript.

## Verified by

- `src/__tests__/in-process-media-e2e.spec.ts` — the full stack against a real gateway and the in-process media transport: `start()` opening a server stream auto-bound to `(sessionId, streamId)`, a client `sendFrame` reaching the server stream's `onFrame`, a server `sendFrame` reaching the client handle's `onFrame`, and two concurrent streams routing by `streamId` without crossing.
- `src/__tests__/harness.spec.ts` — `(sessionId, streamId)` routing to the right `onStream` context, `sendFrame`/`onFrame` against `uplink`/`downlink` projection equivalence, interrupt reaching `onInterrupt`, lifecycle cleanup on `stop` and `close`, and the session resolver.
- `src/__tests__/wire.spec.ts` — `live/start`, `live/stop`, and `live/interrupt` routing to `session.live`, session resolution across apps, and the unresolved-session throw.
- `src/__tests__/teardown-operations.spec.ts` — `stop` emitting its operation with the `{ sessionId, streamId }` scope, journaling `requested` and `terminal` with the teardown reason, and staying idempotent (two operations, one `closed` frame). A guard veto leaving the stream live with the uplink still routing, and an input-reading guard vetoing one stream while a sibling proceeds. `close` emitting its own operation plus a nested `stop` record per live stream, absent from the journal while those `stop` records are present. And `start` emitting no operation, unaffected by a blanket veto.
- `src/client/__tests__/live-session-handle.spec.ts` — `sendFrame` issuing the uplink send, `onFrame` firing, projection equivalence, control commands issuing the right `live/*` calls, `start()` auto-binding ids, and the media-capability guard rejecting a transport without a media lane.
