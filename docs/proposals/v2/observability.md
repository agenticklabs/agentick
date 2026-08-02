# agentick — observability & the verbatim invariant

**Status:** design, ready to cut a branch against.
**Motivation:** a single garbled model response has now survived FIVE rounds of
investigation, because every question about it has to be answered by reading
source instead of reading a log.

---

## −1. The invariant this is really about

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

## −0.5. The round trip — four taps, because the bug is between two of them

Logging one seam cannot find a splice; a splice is a _difference between two
seams_. The unit of capture is the whole round trip for one tick:

| #   | tap              | what it holds                                                              | where it lives                                                         |
| --- | ---------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | **compiled**     | the CompiledStructure — messages, tools, system                            | `CompilerFx.renderTree()`, not adopter-reachable → `session.preview()` |
| 2   | **request**      | the actual provider payload (post-`buildParams`, post-`transformCompiled`) | inside each adapter, e.g. `google-adapter.ts`                          |
| 3   | **response raw** | provider chunks as received, pre-adapter                                   | the SDK stream, before the chunk mapper                                |
| 4   | **output**       | `AdapterDelta[]` post-adapter AND post-`DeltaTransform`                    | `tag-transforms.ts`, `StreamAccumulator`                               |

The diffs are the product, not the logs:

- **1→2** — did we send what we compiled? (prompt-shape, cache-prefix questions)
- **3→4** — did we return what the provider sent? **This is the verbatim
  invariant, and it is where tonight's bug must live if it is ours.**
- **4→persisted** — did the accumulator assemble the deltas faithfully?

Tap 4 already found one real defect this way by accident: `handleTagEvent`
hardcoded `blockIndex: 0`, collapsing distinct text blocks. Fixed in
`next.63` — necessary, but NOT the cause of the fragments.

**Smallest thing that answers all four:** a round-trip recorder — one env var,
one JSON artifact per tick holding all four taps plus the persisted message.
Diffable, assertable, and a strictly smaller build than the namespace taxonomy
below. The taxonomy generalizes it afterwards; it is not a prerequisite.

## −0.4. Investigation state (carry this forward)

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

## 0. What today actually proved

Worth writing down precisely, because it determines what to build.

**The pipeline was fine.** Five hypotheses, five verified-and-discarded:

| hypothesis                                  | verdict                               | how it was settled           |
| ------------------------------------------- | ------------------------------------- | ---------------------------- |
| accumulator drops deltas under backpressure | no — fed first, synchronously         | read the Effect pipeline     |
| queue drops chunks                          | no — `Queue.offer` blocks             | read a constant + comment    |
| block indices collide across ticks          | no — counter lives on the accumulator | read `getGoogleState`        |
| final assembly injects text                 | no — built from accumulated deltas    | read `defaultFinalizeStream` |
| adapter ignores `thought` parts             | no — routes correctly                 | read the chunk mapper        |

Every answer came from **reading code**. None came from data. That is the
problem: five correct deductions and still no diagnosis, because the one fact
that mattered — what was in delta 14–21 — was never captured anywhere.

**Three failures were silent.** Not mis-logged; _unlogged_:

1. 21 stale `.d.ts` files shadowing their sources, so builds read stale types
2. a stale `dist/`, so a rebuilt lib was invisible to its consumer
3. a stale install, so the version under test was not the version changed

None produced a signal. Two of them cost a debugging detour each.

**The lesson splits in two, and so does this plan:**

- Missing _observability_ → debug tracing (§2–§6)
- Missing _assertions_ → invariant checks (§7)

They are different mechanisms and conflating them is why "add some logging"
never fixes this class of problem.

---

## 1. Three audiences, and this plan is only one of them

|             | **`ctx.log`**                     | **operational**     | **debug tracing** |
| ----------- | --------------------------------- | ------------------- | ----------------- |
| whose       | the ADOPTER's                     | agentick's          | agentick's        |
| emitted by  | tool handlers, middleware, guards | the runtime         | the internals     |
| audience    | the app's operators               | the app's operators | developers        |
| default     | on                                | on                  | **off**           |
| selection   | level (RFC 5424)                  | level               | **namespace**     |
| destination | the app's sink                    | the app's sink      | stderr            |
| API surface | **public**                        | public              | **private**       |

**This plan is the third column only.**

The first column is a PUBLIC API — an adopter writing a tool calls `ctx.log` to
say what their handler did. It belongs to them. Agentick's internal tracing must
not share its interface:

- coupling them means an internal tracing change pressures a public API
- the adopter's logs and our traces would land in one stream, and neither
  audience wants the other's noise
- namespace filtering is meaningless to an adopter, and log levels are the wrong
  axis for "show me every delta"

If the two ergonomics happen to rhyme, fine — but that is not a design goal, and
`@agentick/debug` shares no types with the adopter-facing log.

Nothing in `packages/` depends on `debug` today.

---

## 2. Namespaces mirror the package graph

The taxonomy is not invented — it is the architecture, so a namespace is
guessable from a package name and `DEBUG=agentick:model:*` means what it looks
like.

```
agentick:<package>:<concern>
```

```
agentick:compiler:render        fiber render, per component
agentick:compiler:compiled      the COMPILED STRUCTURE — what the model is about to see
agentick:model:request          outbound provider request (post-transform)
agentick:model:delta            every AdapterDelta, in order
agentick:model:raw              raw provider chunks, pre-adapter
agentick:model:transform        each DeltaTransform's in → out
agentick:loop:tick              tick boundaries, stop reasons, continue decisions
agentick:tool:dispatch          call → handler → result
agentick:timeline:append        entries appended, with kind
agentick:session:lifecycle      create / resume / destroy
agentick:wire:rpc               JSON-RPC in/out
agentick:store:query            store reads + writes, with the compiled query
```

**The four that would have ended today in one run:** `model:compiled`,
`model:delta`, `model:raw`, `model:transform`.

`model:transform` deserves special mention — `thinkTagTransform` and
`customBlockTransform` _rewrite the text stream_, re-emitting `content-delta` on
block 0. A transform that mis-splits a tag boundary produces exactly the
symptom we chased, and there is currently no way to see a transform's effect
except by inference.

---

## 3. Tiers, so enabling one thing does not drown you

| tier               | cost       | example                                                     |
| ------------------ | ---------- | ----------------------------------------------------------- |
| **1 — boundaries** | negligible | tick start/end, dispatch, rpc, lifecycle                    |
| **2 — decisions**  | small      | gate verdict + reason, guard replace, cache hit/miss, retry |
| **3 — payloads**   | large      | compiled input, every delta, raw chunks                     |

Tier 3 is what you actually need for a bug like today's, and also what makes a
log unreadable if it is on by default. Separate namespaces (`:delta`, `:raw`,
`:compiled`) rather than a verbosity dial, so you can take exactly the one you
need.

---

## 4. Correlation is the make-or-break requirement

A delta log without ids is useless the moment two sessions interleave — which
is always, in a gateway.

**Every line carries** `sessionId`, `executionId`, `tickId`, and `opId` where
one exists. Not as a formatting convention: as a bound context, so it cannot be
forgotten at a call site.

```ts
const log = trace("agentick:model:delta").with({ executionId, tickId });
log("%s block=%d %o", delta.type, delta.blockIndex, delta);
```

`.with` is chosen because binding beats remembering, not because `ctx.log` has
one — see §1. These are different surfaces with different audiences and they
share no types.

---

## 5. Two gotchas that make naive `debug` usage worse than nothing

**Arguments evaluate even when the namespace is off.** `debug()` returns a
no-op, but `log("%o", expensiveSnapshot())` still calls
`expensiveSnapshot()` on every delta in production. Every tier-3 site must
guard:

```ts
if (log.enabled) log("%o", snapshot());
```

A lint rule or a `log.lazy(() => …)` helper is worth more than the convention,
because the convention will be forgotten.

**Debug logs are a credential leak vector.** The standing rule — token material
never crosses the wire, shape only — has to hold here too, and a debug log is
exactly where someone will `%o` a whole request object containing an
`Authorization` header. The package ships a redactor and the request/response
namespaces use it by default: log key names, value lengths, and claim names —
never values.

---

## 6. Package shape

A thin `@agentick/debug` wrapping the `debug` package, so the conventions above
are structural rather than documented:

```
namespace(pkg, concern)   → "agentick:model:delta", validated against the registry
.with(ids)                → bound correlation context
.lazy(() => payload)      → evaluation only when enabled
redact(obj)               → shape, never secrets
NAMESPACES                → the registry, so DEBUG=… is discoverable and typo-proof
```

A registry matters more than it sounds: without it, namespaces drift, nobody
knows what can be enabled, and `DEBUG=agentick:*` becomes the only usable
setting — which is the same as having none.

**Test capture.** The same tap should be assertable in tests, so "this guard
vetoed for this reason" becomes a test rather than a manual read. The existing
`recordingModelExecutor` proves the appetite; this generalises it.

---

## 7. Silent failures need assertions, not traces

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

## 8. Rollout order

Ordered by pain already felt, not by package graph tidiness.

1. **`@agentick/debug`** — the primitive, the registry, redaction, lazy.
2. **`model:delta` + `model:raw` + `model:transform`** — today's blind spot, and
   the highest-traffic seam in the system.
3. **`model:compiled`** — what the model actually sees. Currently only reachable
   through a test double.
4. **Version assertion at boot** (§7) — smallest, and prevents an entire class of
   wasted session.
5. **`loop:tick`, `tool:dispatch`, `wire:rpc`** — the boundaries, cheap and
   broadly useful.
6. **Everything else**, as each package is next touched. Not a big-bang sweep:
   a namespace added while working in a package is accurate; a namespace added
   during a sweep is a guess.

---

## 9. What this does NOT solve

Debug logging is for _developers reading stderr_. It is not devtools.

The separate need — inspecting a live session's compiled input, timeline, and
tool surface from a UI — remains open, and `model:compiled` is its prerequisite
rather than its replacement. Worth scoping separately, and worth noting that
once the payload namespaces exist, a devtools surface is largely a consumer of
them rather than new instrumentation.
