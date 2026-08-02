# agentick — observability & the verbatim invariant

**Status:** design, ready to cut a branch against.
**Motivation:** a single garbled model response has now survived FIVE rounds of
investigation, because every question about it has to be answered by reading
source instead of reading a log.

---

## 1. The invariant this is really about

> **An assistant message persisted to the timeline must be byte-for-byte what the
> provider emitted.**

Not a quality goal — a correctness one, because the timeline is fed back to the
model on the next tick. A message we corrupt becomes an **exemplar the model
imitates**. One splice is a bug; one splice that persists is a bug that teaches
the model to reproduce it, and the corruption compounds tick over tick.

The live symptom is consistent with exactly that: in the 7-tick run of
`exec:06FW7X7CDMHRNEAZMGQEG69YAD`, tick 1's text is clean, and ticks 2/3/5/7 each
open with a list-tail fragment (`", openai-api"`, `", and chat."`,
`", skills"`). The corrupted text is present in the `timeline:command:append`
payload, so it IS being fed back.

**This invariant is assertable, not merely loggable.** Reconstruct the message
from the raw provider chunks; compare to what is persisted; they must be equal.
That is a test, a boot-time check, and a production assertion behind a flag —
and it converts "why is the model babbling" from an investigation into a failing
assertion that names the seam.

## 2. The command registry IS the instrumentation layer

There is no tracing subsystem to build. **Every seam already mints hooks.** A
`commandStream` additionally mints `on<Verb>Chunk`, and an unregistered hook is
not wrapped at all — zero overhead when off. ~50 commands are declared today.

| #   | hook                                           | what it holds                              |
| --- | ---------------------------------------------- | ------------------------------------------ |
| ⓪   | `onAfterCompilerRenderTree`                    | the `RenderedTree` — what the JSX produced |
| ①   | `onBeforeModelProject` / `onAfterModelProject` | tree → canonical `LanguageModelInput`      |
| ②   | `onBeforeModelProviderRequest`                 | the provider-native request, last-mile     |
| ③   | `onModelProviderRequestChunk`                  | RAW provider chunks, PRE-`mapChunk`        |
| ④   | `onModelGenerateStreamChunk`                   | canonical `AdapterDelta`, POST-transform   |
| ⑤   | `onBeforeTimelineAppend`                       | **what actually lands in the timeline**    |
|     | `onBefore/AfterLoopTick`                       | the bracket around all of it               |
|     | `onBefore/AfterToolDispatch`                   | every tool round trip                      |

**③ and ④ bracket the whole normalization pipeline** — `mapChunk`,
`adapterTransforms`, `customBlockTransform` all run between them. A splice has to
live there, and both sides are on record.

**⑤ is the real terminus.** Asserting against the terminal `message` delta only
proves the accumulator was honest; asserting against `timeline:append` proves the
PERSISTED message is what the provider sent — which is the invariant as stated,
because the timeline is what feeds back.

Correlation is free: `ctx` carries `sessionId` / `executionId` / `tickId` /
`opId` / `parentOpId`. Within the model call, `parentOpId` threads
`model:provider-request` to its parent `model:generate[_stream]`. **Across
harnesses** (compiler, model, timeline are siblings under a tick, not
parent/child) the shared key is `tickId`.

Built: `roundTripRecorder` in `@agentick/model-executor` — a plain `CommandHooks`
bag covering ①–④ plus the terminal message, with `verbatimViolations()` over it.
It is `opId`-keyed, so it is model-only.

**Spanning ⓪–⑤ from a hooks bag is blocked**, and not by effort: the recorder
lives in `@agentick/model-executor`, whose compilation sees only the `model:*`
augmentations, so it CANNOT NAME `onAfterCompilerRenderTree` or
`onBeforeTimelineAppend` — those keys do not exist in its type universe. A
cross-harness bag must be authored where every augmentation is loaded, and today
nothing quite is (`@agentick/app` carries `compiler-react` as a dev/peer
dependency only; there is no metapackage directory yet). See §7 — the answer is
probably that the cross-harness view is a bus subscriber, not a hooks bag.

---

## 3. The dead end, recorded so it is not re-proposed

The first draft of this document specified **`@agentick/debug`**: a namespace
registry (`agentick:model:delta`, `agentick:tool:dispatch`, …), three cost tiers,
`.with()` correlation binding, `.lazy()` evaluation guards, and a registry to
stop namespaces drifting.

**Delete it.** Every piece was already solved:

| the proposal                          | what exists                           |
| ------------------------------------- | ------------------------------------- |
| `agentick:model:delta`                | `onModelGenerateStreamChunk`          |
| `agentick:compiler:compiled`          | `onAfterCompilerRenderTree`           |
| `agentick:tool:dispatch`              | `onBefore/AfterToolDispatch`          |
| `.with(ids)`                          | `ctx` carries them                    |
| `.lazy()` — args evaluate when off    | an unregistered hook is not wrapped   |
| a registry so namespaces do not drift | `CommandRegistry`, and it is TYPED    |
| redaction                             | the sink's concern, already delegated |

It would have been a parallel instrumentation mechanism duplicating the operation
system, with a hand-maintained registry guaranteed to drift from the real one.

What actually survives is **a sink**: a hooks bag that writes to stderr when a
`DEBUG=`-style filter matches. Twenty lines, not a package.

The same error was made twice in one session — a decorator over
`LanguageModelAdapter` for the recorder, then this. **Both proposed a new
mechanism before opening the command registry.** The rule that would have caught
both: grep for the primitive before designing its replacement.

### `session.preview()` shrinks with it

Justified on three grounds; two are void. `compiler:render-tree` is a command, so
render output is observable today — the observability and devtools arguments are
gone. Only the ON-DEMAND use survives: compiling without a tick, for the episodic
memory turn. Still real, much smaller, and no longer a prerequisite for anything
here.

---

## 4. Investigation state (carry this forward)

**Verified, do not re-derive:**

- `@agentick/model@1.0.0-next.63` is installed and correct — `sourceBlockIndex`
  threaded, zero hardcoded `blockIndex: 0`.
- The `includeThoughts: true` change works: reasoning arrives as its own block.
- Sequences 143→159 contiguous. No gaps, no dupes, block indices consistent.
- The fragments are semantically **system-prompt-shaped list tails**, including a
  rendered MCP status line — `- local [connected] — local v0.0.1 — capabilities:
filesystem, python`.
- **That string exists in NEITHER codebase.** Grepped agentick `packages/` and
  nx-knowify `libs/` + `apps/`. Same negative for `ai-binding`, `agent-admin`.
- `reasoningTokens: 77` across 7 ticks (a single tick earlier produced 538).
  After a tool result Gemini largely stops emitting thought parts and writes its
  reasoning into the **text** channel. Related or coincidental: unknown.

**Ruled out by reading source (5 hypotheses, all discarded):** accumulator
backpressure, queue drops, cross-tick block-index collision, final-assembly
injection, adapter ignoring `thought` parts.

**The one unanswered question:** is there a `content-delta` carrying `", skills"`,
and what block index does it have? Needs the deltas at the START of a tick, which
no capture currently holds. **Stop hypothesizing until tap 3+4 exist** — two
confident wrong calls have already been made on this symptom.

---

## 5. Three audiences

|             | **`ctx.log`**                     | **operational**     | **debug tracing** |
| ----------- | --------------------------------- | ------------------- | ----------------- |
| whose       | the ADOPTER's                     | agentick's          | agentick's        |
| emitted by  | tool handlers, middleware, guards | the runtime         | the internals     |
| audience    | the app's operators               | the app's operators | developers        |
| default     | on                                | on                  | **off**           |
| selection   | level (RFC 5424)                  | level               | **namespace**     |
| destination | the app's sink                    | the app's sink      | stderr            |
| API surface | **public**                        | public              | **private**       |

**Only the third column is agentick's internal concern.**

The first column is a PUBLIC API — an adopter writing a tool calls `ctx.log` to
say what their handler did. It belongs to them. Agentick's internal tracing must
not share its interface:

- coupling them means an internal tracing change pressures a public API
- the adopter's logs and our traces would land in one stream, and neither
  audience wants the other's noise
- namespace filtering is meaningless to an adopter, and log levels are the wrong
  axis for "show me every delta"

If the two ergonomics happen to rhyme, fine — but that is not a design goal, and
internal tracing shares no types with the adopter-facing log.

---

## 6. Silent failures need assertions, not traces

The three that cost time today would not have been caught by any amount of
tracing, because nothing was _happening_ — the wrong bytes were simply on disk.

| failure                             | check                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| stale `.d.ts` shadowing source      | build-time: fail if `src/**/*.d.ts` exists in a package that emits declarations |
| stale `dist/` consumed by a sibling | build-time: fail if `dist` is older than `src`                                  |
| stale install vs published          | boot-time: log resolved `@agentick/*` versions; assert they agree               |

The last one is the cheapest and the most valuable. **"Am I running what I
built" should never be a question answered with `grep`** — it should be the
first line of the boot log.

---

## 7. Devtools rides the BUS, not the hooks

**Hooks transform. The bus observes.** A dashboard has no business in the call
path, so `@agentick/devtools` subscribes to `ProtocolEvent`s rather than
registering interceptors.

That is not only cleaner, it is the only thing that TYPECHECKS. `CommandRegistry`
is spec-SEEDED but harness-AUGMENTED: spec owns `WireCommandMap`, which derives
the `wire:*` gateway commands from `WireMethods` — genuinely spec-only — while
`model:generate_stream`, `compiler:render-tree` and `timeline:append` are
augmented in by their own packages. Those keys DO NOT EXIST in a spec-only
compilation, so a hooks-based devtools could not name them without depending on
every harness it observes. `ProtocolEvent` is spec-owned, so a subscriber needs
none of them.

The spine is already on the bus, already correlated, already reaching the wire —
verified against a live gateway trace, not assumed:

```jsonc
{ "surface": "session",  "name": "session:execution:event", "phase": "started",
  "scope": { "sessionId": "…" },
  "payload": { "type": "content-delta", "blockIndex": 0, "delta": "…", "tick": 7 } }

{ "surface": "timeline", "name": "timeline:command:append", "phase": "requested",
  "scope": { "sessionId": "…", "origin": "host" },
  "payload": { "entries": [{ "kind": "message", "message": { … } }] } }
```

Every envelope carries `surface` / `name` / `phase` / `scope` / `payload` and is
cursor-ordered. A gateway-down dashboard is a SUBSCRIBER, not new
instrumentation.

### Two consumers, one substrate, different depths

|           | **devtools**                  | **the round-trip recorder**                                 |
| --------- | ----------------------------- | ----------------------------------------------------------- |
| mechanism | bus subscriber                | `CommandHooks` bag                                          |
| deps      | spec (or close)               | the harness it taps                                         |
| audience  | a live dashboard              | one investigation                                           |
| default   | on, cheap                     | off                                                         |
| reaches   | the spine, gateway → timeline | pre-normalization payloads (② native request, ③ raw chunks) |

Not a duplication. The recorder deliberately taps payloads that should NOT ride
the bus by default — a raw provider chunk per token is a diagnostic, not
telemetry.

### The open question that sizes the whole thing

**Do `model:provider-request`'s raw chunks and `compiler:render-tree`'s output
publish bus envelopes when something is subscribed?** The executor has a lazy
path that skips envelope construction with no subscriber, which SUGGESTS they do
— unverified.

- If yes: devtools gets the full ⓪–⑤ span with zero harness deps, and the
  recorder collapses into a thin convenience over the same stream.
- If no: the split above stands as written.

Answer this first; it decides whether devtools is one package or two.

### Component granularity, and why it is no longer an exception

An earlier draft claimed WHICH `<Section>` produced a node — and why a component
re-rendered, and what a `useKnob` holds — was unreachable, needing a real
React-devtools backend. It is not: **`compiler-react` can EMIT that itself in dev
mode**, as ordinary events. Self-reporting beats a devtools backend on every
axis — it works headless, over the wire, in tests, and in prod behind a flag,
and it needs no second mechanism. `compiler:render-tree` yields render's OUTPUT;
dev-mode emission yields the render.
