# ADR 88a — Live worked example: continuous voice over a session-required STT (Google Speech)

**Status:** DRAFT 2026-07-15 (Fable, with Ryan)
**Companion to:** [ADR 88 — Live media sessions](./88-live-media-sessions.md).
**Scope note (rev 3):** ADR 88 was retargeted to a minimal core (transport +
handle + routing + `onStream` hook). This document illustrates the **deferred
engine packaging** from ADR 88's *Future directions* — the `pipelineEngine` +
session-oriented `SttEngine`/`TtsEngine` seams — **not** the v0 core. It stays
here as the validation that those future seams hold against the hardest realistic
case (a *session-required* streaming STT driving a *continuous, multi-turn*
conversation), and as the reference for how an adopter wires the same thing today
by hand over the v0 `onStream` hook. If the seams survive this, they survive the
easy cases.

The load-bearing claims it demonstrates: (1) a session-oriented provider is the
**natural** shape of the STT seam, not the awkward one; (2) provider-session
rotation is **engine-internal** and invisible above the seam; (3) **one** provider
session spans **many** turns; (4) conversational memory is the **Timeline**, not
the recognizer; (5) the whole thing is agentick's **normal** multi-tick loop with
audio bolted on at the edges.

## 1. The seams are sessions (so "session-required" is the default)

```ts
// @agentick/live-next — STT seam. Session-oriented on purpose: open → write* → close
// IS Google streamingRecognize's lifecycle, so it maps 1:1. A stateless/batch
// provider is the one that adapts (buffer in write, transcribe in close) — the
// LiveKit StreamAdapter pattern.
interface SttEngine { open(config: SttConfig): SttSession; }
interface SttSession {
  write(frame: AudioFrame): Promise<void>;                       // awaiting = backpressure
  onTranscript(cb: (t: TranscriptDelta) => void): Unsubscribe;   // interim + final
  close(): Promise<void>;                                        // end-of-input; flush final
}

// TTS is the mirror image — also a session (progressive text in, audio chunks out).
interface TtsEngine { open(config: TtsConfig): TtsSession; }
interface TtsSession {
  say(textDelta: string): Promise<void>;                         // stream reply tokens in
  onAudio(cb: (f: AudioFrame) => void): Unsubscribe;
  flush(): Promise<void>;                                        // finish the utterance
  cancel(): Promise<void>;                                       // barge-in: stop mid-sentence
}
```

## 2. The Google adapter — with correct rotation

The subtlety: a `streamingRecognize` stream with `single_utterance: false` emits a
**series** of `isFinal` results (one per user utterance) and keeps listening. It is
recreated **only** on the ~5-min / 305-second streaming cap or on error — and
rotation must land at a **turn boundary** (post-final silence), never mid-utterance,
or it clips speech. So: **arm** on elapsed time, **execute** on the next `isFinal`.

```ts
// app-side (or @agentick/stt-google-next). NOT framework code.
function googleStt(opts: GoogleSttOpts): SttEngine {
  return {
    open(config) {
      const client = new SpeechClient({ /* regional endpoint for chirp_2 */ });
      const listeners = new Set<(t: TranscriptDelta) => void>();
      let stream = openRecognizeStream(client, config);   // duplex; single_utterance:false, interim on
      let openedAt = Date.now(), rotateArmed = false;

      const wire = (s: DuplexStream) =>
        s.on("data", async (res) => {
          const r = res.results?.[0]; const alt = r?.alternatives?.[0];
          if (!alt) return;
          const final = !!r.isFinal;
          for (const cb of listeners) cb({ role: "user", text: alt.transcript, final });

          // Rotation executes HERE — on the final, in the silence after an utterance.
          // This is the ONLY place a new Google session is born mid-call.
          if (final && rotateArmed) {
            const next = openRecognizeStream(client, config);
            wire(next); stream.end();                     // drain the old at the boundary
            stream = next; openedAt = Date.now(); rotateArmed = false;
          }
        });
      wire(stream);

      return {
        async write(frame) {
          if (Date.now() - openedAt > FOUR_MIN) rotateArmed = true;   // arm, don't swap
          const ok = stream.write(toPcm16(frame.payload));           // float32→PCM16LE @16k
          if (!ok) await once(stream, "drain");                      // backpressure → propagates up
        },
        onTranscript(cb) { listeners.add(cb); return () => listeners.delete(cb); },
        async close() { stream.end(); await once(stream, "end"); },  // 5s timeout in prod
      };
    },
  };
}
```

Rotation is entirely inside the adapter; the engine never learns the gRPC stream
was swapped — precisely ADR 88's "provider spans are engine-internal."

## 3. The `pipelineEngine` — the framework mediator

```ts
// @agentick/live-next
function pipelineEngine(stages: { stt: SttEngine; tts: TtsEngine }): LiveEngine {
  return {
    capabilities: { audioOutput: true, turnDetection: false,   // app/STT own turns
                    userTranscription: true, toolCalling: false, video: false },

    attach(media: MediaSessionServer): LiveEngineRun {
      const stt = stages.stt.open({ language: "en-US" });   // ONE session for the whole call
      const tts = stages.tts.open({ voice: "…" });
      let generating: SessionExecutionHandle | null = null;

      tts.onAudio((f) => media.downlink().write(f));        // TTS audio → client speaker

      stt.onTranscript(async (t) => {
        media.emitTranscript(t);                            // interim + final → client
        if (!t.final) return;                               // one turn = one final

        if (generating) {                                   // barge-in: final mid-agent-turn
          await generating.abort("barge-in");               // ADR 53 preemptive steer
          await tts.cancel();                               // stop the mouth
          media.truncateAssistant(playheadMs());            // trim Timeline to what was heard
        }

        media.emitState("thinking");                        // one turn → one execution
        generating = media.session.send({
          messages: [{ role: "user", content: assemble(t.text /*, images/docs */) }],
        });

        media.emitState("speaking");                        // stream reply → TTS → downlink
        for await (const ev of generating)
          if (ev.kind === "text-delta") await tts.say(ev.delta);
        await tts.flush();
        generating = null;
        media.emitState("listening");
      });

      const pump = (async () => {                           // continuous uplink → STT
        media.emitState("listening");
        for await (const frame of media.frames) await stt.write(frame);  // backpressured
        await stt.close();
      })();

      return { done: pump, dispose: async () => { await stt.close(); await tts.cancel(); } };
    },
  };
}
```

## 4. The app just composes it

```ts
const app = createApp(<VoiceAgent />, {
  model,
  extensions: [
    withLive({ engine: pipelineEngine({ stt: googleStt(opts), tts: cartesiaTts(opts) }) }),
  ],
});

// inside LiveHarness: a media-plane frame is routed to the right continuous
// MediaSession by its (sessionId, streamId); the engine is already draining .frames.
onMediaFrame(({ sessionId, streamId, frame }) =>
  liveHarness.session(sessionId).stream(streamId).push(frame));
```

## 5. Client — continuous capture

The defining trait of *continuous* (vs push-to-talk): the mic pipe **opens once and
never closes until `stop()`**; turns and barge-in happen *inside* the open stream.

```ts
const live = await client.session(id).live.start();   // auto-bound to (sessionId, streamId)

// UPLINK — mic → frames → sink, continuous. echoCancellation is load-bearing:
// open mic + assistant playback = feedback / false barge-in unless AEC is on.
const mic = await navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
});
new MediaStreamTrackProcessor({ track: mic.getAudioTracks()[0] }).readable
  .pipeThrough(resampleTo16kPcm16())   // AudioData → PCM16 @16k (a TransformStream you own)
  .pipeThrough(toMediaFrames("audio")) // → MediaFrame { kind:"audio", envelope, payload }
  // .pipeThrough(sileroVad())          // OPTIONAL — only for client-side barge-in playhead
  .pipeTo(live.uplink);                // resolves only when the stream ends

// DOWNLINK — provider audio → speaker, with a playhead for accurate barge-in.
const player = createPcmPlayer(new AudioContext({ sampleRate: 24000 })); // provider out = 24k
live.downlink.pipeTo(new WritableStream({ write: (f) => player.enqueue(f.payload) }));

// STATE + TRANSCRIPTS
live.onState((s) => { ui.setState(s); if (s !== "speaking") player.stop(); }); // emergent barge-in
live.onTranscript(({ role, text, final }) => ui.renderTranscript(role, text, final));

// ...later:
await live.stop();
```

Optional client-side VAD, only to get the **exact** playhead the server can't know:

```ts
sileroVad({ onSpeechStart: () => {
  if (live.status === "speaking") live.interrupt(player.playedMs());  // preemptive + exact truncate
}});
```

## 6. Multi-turn — when a new Google session is created

**One recognizer serves many turns.** A new Google session is born only on rotation
(the ~5-min cap) or error — during the silence between a user finishing and the
assistant answering. Not per turn, not per assistant reply.

```
MediaSession opens → googleStt.open() → Google stream #1
  turn 1:  user speaks → interim… → isFinal → session.send → agent → TTS   (Google #1)
  turn 2:  user speaks → interim… → isFinal → session.send → agent → TTS   (Google #1)
  turn 3:  …                                                                (Google #1)
  ── ~4 min elapsed; write() sets rotateArmed = true ──
  turn 4:  user speaks → isFinal ─┬─ [rotate: #1.end(), #2 opens] → session.send → agent → TTS
                                  └─ subsequent audio flows into Google #2
  turn 5:  user speaks → isFinal → …                                        (Google #2)
MediaSession stops → googleStt.close() → Google stream ends
```

## 7. Where the multi-turn memory lives

The Google session holds **no conversational memory** — it is ears, stateless w.r.t.
meaning, stateful only w.r.t. the acoustic stream inside its ~5-min window. The
back-and-forth context lives entirely in **agentick's Timeline**, grown by each
`session.send`. That is why rotating the recognizer mid-conversation is harmless:
you swap the ears, not the memory. The agent's turn loop
(`session.send` → execution → reply) is agentick's *ordinary* multi-tick loop —
voice merely feeds it one `user` message per `isFinal` and pipes the reply to TTS.
Nothing about multi-turn is voice-specific.

## 8. The one continuous subtlety: the recognizer during the assistant's turn

Because the mic never closes, Google keeps receiving audio while the assistant
speaks — which is what makes barge-in *emergent* (a new `isFinal` mid-turn = the
user interrupted). Two app-owned knobs keep it sane:

- **AEC** (`echoCancellation: true`) so the recognizer doesn't transcribe the
  assistant's own voice back as a "user turn."
- **A barge-in gate** — suppress a mid-assistant `isFinal` unless it clears a
  threshold (`minWords`/`minDuration`, the LiveKit/Pipecat false-interruption knob)
  so a cough or "mm-hm" doesn't cut the agent off.

Neither touches the framework — a `getUserMedia` constraint and an engine policy knob.

## 9. Framework vs app, made concrete

| Piece | Owner |
|---|---|
| `MediaSession`, `MediaTransport`, `LiveHarness`, `pipelineEngine` skeleton, `SttEngine`/`TtsEngine` seams, `media.session.send` bridge, barge-in mechanics, `(sessionId, streamId)` routing | **framework** (`@agentick/live-next`) |
| `googleStt()` incl. rotation/keepalive, `cartesiaTts()`, `assemble()` (multimodal policy), `resampleTo16kPcm16`/`createPcmPlayer`, AEC, barge-in gate, `language`/`voice` | **app** (or optional adapter pkgs) |

The framework never mentions Google, PCM16, `chirp_2`, a 5-minute cap, `MediaStream`,
or an `AudioContext`.

## 10. What this validates about ADR 88

- The **session-oriented STT seam** makes the session-required provider the *natural*
  case; rotation/keepalive hide inside the adapter exactly where ADR 88 puts provider
  spans.
- The **continuous `MediaSession`** carries multi-turn with no segment lifecycle — one
  recognizer, many turns, the Timeline as memory.
- **Backpressure** is one signal end to end: Google `drain` → engine `for await` →
  `media.frames` → `MediaTransport` → browser `WritableStream.ready`.
- **Barge-in** is `abort` + `tts.cancel` + `truncateAssistant` — ADR 53 preemptive
  steering, nothing new.
- The **client contract** (callback spec + stream projections, `uplink`/`downlink`,
  `onState`/`onTranscript`/`interrupt`/`stop`) is all the browser needs; capture,
  resample, VAD, AEC, playback stay app-owned `TransformStream`s.

**Still open (does not touch any of the above):** realtime mode as an
`ExecutionRunner` vs a `LiveEngine` (ADR 88 §Open questions #1) — the same
`pipelineEngine` shape, but the provider owns the loop.
