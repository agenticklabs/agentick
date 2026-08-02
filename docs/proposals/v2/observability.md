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
It is `opId`-keyed, so it is model-only; spanning ⓪–⑤ means re-keying on
`tickId`.

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

## 7. Devtools, and the one thing hooks cannot reach

Devtools is a **hook consumer**, not new instrumentation — with one sharp
exception.

- **Operation granularity** — what crossed which seam, in what order, carrying
  what. Entirely hooks. The recorder is already the substrate for it.
- **Component granularity** — WHICH `<Section>` produced this node, why a
  component re-rendered, what a `useKnob` holds. **Not reachable from any hook.**
  `compiler:render-tree` yields render's OUTPUT, never the render itself.

That second row is the only place a real React-devtools backend for
`compiler-react` would earn its keep, and it is a genuinely separate build rather
than a layer on the same substrate. Unscoped.
