# Provider round-trip data across a model change

**Status:** **PARKED 2026-08-05.** Two pieces landed (`4dca94a8`, `41034325`).
The rest is unbuilt and should stay that way until someone hits the failure —
read the next section before building anything from the checklist.

## Parked: `foreign` is a phantom

Everything below that needed a "which dialect produced this" verdict was solving
a problem the architecture already prevents. Two facts, both from the code:

**Every adapter reads only its own namespace, by key.**

```js
// google-adapter.ts — the tool_use input path
const signature = part.providerOptions?.["google"]?.["thoughtSignature"];
```

An explicit two-level index. Not a splat, not a merge. Anthropic does the same
for `anthropic`. So a block carrying `providerMetadata.anthropic.signature` sent
to Google is never read, never projected, and cannot cause a 400. It is inert.
Namespacing already makes cross-dialect blobs harmless — that is what it is for.

**The provider already reports the one real case.** Google's
`MISSING_THOUGHT_SIGNATURE` is mapped to the canonical `malformed_tool_call`
stop reason today, and an adopter can act on it now.

### What that collapses

- **`foreign` as a state.** No mechanism needs to detect someone else's blob,
  because nobody consumes it.
- **The "one blocking prerequisite" below.** The `providerMetadata` overload only
  bit a "namespace differs from my dialect" test, and that test should not exist.
  An adopter's `cacheControl` reaching Google is ignored like anything else
  foreign. **Do not split the block or add key declarations for this reason.**
- **The four-valued `RoundTripState`.** `none` and `foreign` both mean "nothing
  to do". What survives is one question: does my target's required key exist on
  this block?

### The lesson

The design escalated — four-valued enum, adapter declarations, a registry union —
each step answering "is this right?" by adding structure instead of re-checking
the premise. The premise was never verified against the adapters' actual read
paths. Ten minutes of grep would have removed most of this document.

Being blocked on an unanswerable sub-question was the signal. A prerequisite
nobody can decide usually means the thing it is a prerequisite FOR should not be
built yet.

### Correction to the record

An earlier revision said the framework "hands an Anthropic thinking signature to
Google". Literally true — the bare field was on the projected part for every
adapter — but Google never read it, and it drops replayed reasoning parts
entirely. That was a **latent mis-modeling, not an active break**. Fixing it in
`41034325` is what makes cross-dialect contamination structurally impossible
rather than merely unobserved, and it is worth having. It did not repair an
outage.

Contrast `4dca94a8`, which repaired a **proven live defect**. Token-budget
eviction dropped an assistant turn and kept the `tool_result` that answered its
call, which every provider rejects.

### When to come back

When someone actually hits a cross-provider replay failure. Ernesto's observed
switch was `gemini-2.5-flash` → `gemini-3.5-flash` — same dialect, signatures
carried, nothing to do. Until a real failure exists, the recovery path below
(send it, let the provider be the oracle, degrade on refusal) is the whole answer
and needs none of the prediction apparatus.

The transform design (`degradeMessage`, the event-role output, the four rules,
the ergonomics) is still good and still what you want when the time comes. It is
the **classification** machinery in front of it that was invented.

## The problem

Providers attach opaque blobs to assistant turns that must come back on replay:
Gemini `thoughtSignature` on `functionCall` parts, Anthropic `signature` on
thinking blocks, OpenAI encrypted reasoning items. Gemini 3.x **rejects** a
multi-step replay whose first function call lacks one — a 400, not a degradation.

The timeline is durable and the model is not. Every long-lived conversation
eventually replays blobs produced by a model it is no longer talking to. This is
not an edge case; it is a certainty with a date on it.

Observed: `gemini-2.5-flash` → `gemini-3.5-flash` carried signatures fine.
Compatibility follows the **format**, not the model id.

## The split

**Framework ships facts and wire grammar. It decides no policy.**

- **Facts** — what we observed. The provenance of a turn is not a claim about
  compatibility; it is a record of which target produced it.
- **Grammar** — a request malformed by construction. This is not a matter of
  opinion and no adopter should learn it from a 400.
- **Meaning** — whether losing reasoning continuity is an acceptable price for
  this conversation. A product judgment. Never the framework's.

## The axis: dialect, not model

An earlier draft built every decision on `provider` + `modelId`, having just
argued that compatibility follows a format providers do not publish. That was
incoherent, and it produced a design whose own worked example came out wrong.

**The format is published — by the adapter that wrote it.** Per-block
`providerMetadata` is `Record<namespace, Record<key, unknown>>`, and the
namespace is already the dialect: `providerMetadata.google.thoughtSignature`,
`providerMetadata.anthropic.redactedData`. The block carries its own provenance,
at block granularity, in the timeline, today.

So the question is not "which model produced this message." It is **does this
block carry the round-trip state this dialect requires**:

```ts
type RoundTripState = "none" | "present" | "foreign" | "missing";
```

- **none** — no round-trip state, none required. Text, images, most assistant
  turns. The overwhelming majority, and the fast path.
- **present** — under this dialect's namespace. Replay verbatim.
- **foreign** — under another dialect's namespace. Degrade.
- **missing** — required by this dialect for this block kind, absent. The
  dangerous one, and now detected precisely rather than inferred from an absent
  message stamp.

Four consequences, each of which the old axis got wrong:

**The modal case comes out correct by construction.** `gemini-2.5-flash` →
`gemini-3.5-flash` is `google` → `google` with the key present, so `present`, so
no degradation. That is the case actually observed. The old axis called it a
mismatch and degraded it for nothing.

**The namespace must be the wire DIALECT, not the vendor account.** A Bedrock
adapter serving Claude writes `providerMetadata.anthropic`, and an
Anthropic-direct timeline replays into it for free. Writing
`providerMetadata.bedrock` invents an incompatibility that does not exist. The
old axis had nowhere to state this rule; this one forces it.

**No provenance stamp is needed for the decision.** `SessionMessageMetadata.model`
already exists in spec and is already stamped (`lifecycle-projection.ts:166`),
so an earlier section demanding it was asking for something built. It stays as a
human-facing record and as the `degradedFrom` payload — not as the load-bearing
input.

**It exposes a defect we would otherwise ship into.** See below.

## The one blocking prerequisite

`BaseContentBlock.providerMetadata` is **overloaded**. Its own docblock names two
uses: model-produced opaque data to resend verbatim, and adopter-stamped knobs
like Anthropic's `cacheControl: { type: "ephemeral" }`. Namespace-matching alone
would therefore degrade a block on a switch to Google because the adopter marked
it a cache breakpoint for Anthropic.

The wire layer already draws this line correctly — `LanguageModelMessagePart`
splits `providerOptions` (what you send) from `providerMetadata` (what the
provider returned), per ADR 57 §2. The canonical block never got the split.

**Adapters must declare which keys are round-trip state.** Three lines per
adapter, and it is the same shape as `capabilities.media`: the wire's own
constraints, declared at the wire.

There is a second, worse instance. `ReasoningBlock.signature` is a **canonical,
un-namespaced field** carrying dialect-specific opaque state, and
`canonical-projection.ts:354` projects it to every adapter unconditionally — so
the framework currently hands an Anthropic thinking signature to Google.
`redactedData` already takes the namespaced path; `signature` is the lone
holdout. Delete the canonical field; have Anthropic stamp
`providerMetadata.anthropic.signature`. One channel, uniformly keyed by dialect,
so `roundTripState` has a single place to look.

## What the framework provides

### `degradeMessage(entry, target)` — the primitive

One entry in, N out:

```ts
function degradeMessage(entry: TimelineEntry, target: ExecutionTarget): TimelineEntry[];
```

Give every block a disposition — `keep`, `drop`, `degrade` — then collapse
contiguous **keeper** runs into one message of the original role and emit each
degraded block as its own `event`, in place. Order comes from block positions,
not from a fixed layout.

The disposition is **data-driven, not type-driven**: a block is at risk when its
`roundTripState` says so, never because it is of some enumerated type. Block
kinds added later then work without touching this.

`degradeForReplay(entries, target)` is
`entries.flatMap((e) => degradeMessage(e, target))`.

**Do not counterfeit timeline entries.** A `MessageTimelineEntry` is documented
as a persistence-shaped record in the conversation log, and these were never in
the log. Return messages; the tree only needs messages.

### Tool calls are not the only failure mode

The check is per **block**, because `providerMetadata` lives on the block.
Promoting it to the entry is what made an earlier draft look tool-specific when
the problem is not.

- **Reasoning blocks carry signatures too.** Anthropic `thinking` blocks carry a
  validated signature and are expected on the replay of a turn that made a tool
  call; Gemini 3.x signs thought parts, not only `functionCall` parts; OpenAI
  reasoning items carry `encrypted_content`. Claude plus extended thinking plus
  tools is the default shape of a coding agent, so a design covering only
  `tool_use` and `tool_result` covers about half the surface.
- **Disposition differs by kind**, and the question separating them is whether
  the block's absence is recoverable from what remains:
  - **reasoning → drop.** The assistant's text survives and nothing downstream
    needs to know a thinking block was there. No event, no collapse.
  - **tool call → degrade.** Dropping it loses a fact the model needs — that a
    tool ran, and what came back.

**Out of scope: request-level pointers.** OpenAI's `previous_response_id` names
server-side state rather than a block. There is nothing to strip or group; it
lives in `providerOptions` and degrades by being omitted.

### What a degraded block becomes

An event-role message carrying a `<system_event>` block. Never the user role —
re-attributing the assistant's own tool call to the user corrupts in-context
learning, and the model reads its own turns as exemplars. Never hand-written
prose: `event` collapses to `user` at the wire, and the **structure** is what
keeps it distinguishable from speech. That is the argument ADR 94 already made
for `<Grounding>`, applied to a second kind of non-speech content.

Every degraded entry carries `metadata.degradedFrom` — `messageId`,
`provenance`, `reason`. The id and the provenance, **never the original
content**. A pointer records; a copy doubles memory for every degraded turn and
puts the original one careless renderer away from the prompt.

### The transform, concretely

```
assistant [thinking, text, tool_use]   →  event(call) · assistant(text)
assistant [text, tool_use, text]       →  assistant(text) · event(call) · assistant(text)
assistant [text, image, tool_use]      →  assistant(text, image) · event(call)
assistant [tool_use]                   →  event(call)
tool      [tool_result]                →  event(result)
```

Four rules, each earned:

1. **In position, never hoisted.** The dominant shape is text-then-call ("Let me
   check that." plus `tool_use`), and emitting the call first says it called and
   then explained itself — backwards, and it teaches bad turn structure to a
   model reading its own history.
2. **Thinking drops silently — no event.** Wrapping a dropped thinking block in
   an announcement is context-window noise for a fact nothing consumes.
3. **An emptied message is dropped.** A bare `tool_use` with no preamble is
   extremely common; nothing remains to place.
4. **Adjacency is the correlation.** A call event and its result event sit next
   to each other exactly as they did on the wire, and `degradedFrom` carries the
   tool id for anything needing certainty. An earlier draft folded the pair into
   one event to "preserve the correlation" — it was already preserved.

**Non-text blocks stay.** Images, code, JSON and audio the model produced carry
no signature and are replayable, so the keeper run is everything not
round-trip-bound, not "text only".

**The `tool` message converts wholesale.** Its entire content is the result of a
call that cannot be replayed, and it has no voice to preserve.

**Why not convert the assistant message wholesale too?** Most assistant messages
carry no round-trip data at all. A message-level rule degrades every one of them
on a model switch, leaving `user · event · user · event` for the entire
pre-switch history with no exemplar of the model's own voice anywhere in it.
Summarising an assistant turn is the most expensive mistake this codebase has
made; converting every one of them is a gentler version of it, applied at once.

## Ergonomics

`useActiveModel()` already exists — ADR 55, resolved session-side and threaded
through the loop, carrying provider, modelId and capabilities. It returns
`undefined` on a free-root render outside a run.

**Hoist it.** It is a hook, so it is called once per render, never inside the
`.map` or `.flatMap` callback. An earlier draft of these examples called it
per-entry, which is a hook in a loop.

### Level 1 — handled

```tsx
function History() {
  const target = useActiveModel();
  return (
    <Timeline>
      {(entries) => degradeForReplay(entries, target).map((m) => <Message key={m.id} {...m} />)}
    </Timeline>
  );
}
```

### Level 2 — your own rendering of a degraded turn

```tsx
function History() {
  const target = useActiveModel();
  return (
    <Timeline>
      {(entries) =>
        entries.flatMap((entry) =>
          degradeMessage(entry, target).map((m) =>
            m.metadata?.degradedFrom ? (
              <CollapsedTurn key={m.id} message={m} />
            ) : (
              <Message key={m.id} {...m} />
            ),
          ),
        )
      }
    </Timeline>
  );
}
```

```tsx
function CollapsedTurn({ message }: { message: SessionMessage }): React.ReactNode {
  const from = message.metadata.degradedFrom;
  return (
    <Event>
      <system_event
        event="tool_call"
        source="replay"
        data={{ ...toolCallOf(message), producedBy: from.provenance?.modelId }}
      />
    </Event>
  );
}
```

Structure, so the formatter decides the wording, so it reads correctly in
markdown and XML from one tree.

### Level 3 — a different policy entirely

`roundTripState` is analysis; nothing obliges you to degrade. Drop foreign turns,
keep them and gamble, or degrade only the ones older than the last fold.

## Rules an adopter must not have to discover

- **Degradation is non-destructive.** It shapes the projection, never the
  timeline. Switch back to a compatible model and the fast path returns with
  nothing to restore.
- **It must be deterministic.** The same collapsed turn renders byte-identically
  on every tick. A wobble rewrites the middle of the prompt and invalidates the
  prefix cache from that point down — the failure the execution-anchored recency
  boundary exists to prevent.
- **One event per degraded block.** Parallel tool calls are common, and a stable
  1:1 mapping is what keeps the rendering deterministic. Derive the event's id
  from the source message id plus the block index, never from a counter.

## Recovery on rejection — the native default

Send it; on refusal, locate the part, degrade it with the same
`degradeMessage`, retry, and persist the quarantine record.

Optimal (nothing degrades that did not have to), safe (the 400 never reaches the
user), self-healing, and it needs no compatibility knowledge **because the
provider is the oracle**. The prefix-cache objection does not apply in the case
it fires for: a model change has already discarded the provider's cache.

An earlier draft filed this under "Rejected" while describing it in exactly those
terms. It is the best mechanism in this document and it belongs first.

**Remember the oracle's answers.** A successful replay that actually carried
`foreign` round-trip blocks is an **observation**, not a hand-maintained claim —
the property whose absence killed the compatibility registry below. Cache it per
`(source dialect → target)` for the process lifetime and the second thread on
that pair skips the retry. The discipline that keeps it honest: only record when
the request genuinely carried a round-trip-bearing block, or you are recording
that an all-text conversation replayed fine and generalising from nothing.

Tree-level degradation is then the **escape hatch**, for adopters who want
determinism and no retry latency. Both paths call the same `degradeMessage`.

## Rejected, with reasons

- **A compatibility-token registry in the catalog.** Hand-maintained claims about
  blobs nobody versions publicly. Wrong means confident replay and a silent
  outage on every old thread — the exact failure it was built to prevent, with a
  config file making it look handled. The ecosystem declines to model this, and
  that is not an oversight.
- **`strip` as an outcome.** Removing a signature while keeping the
  `functionCall` part _is_ the 400. It was either a no-op or the bug.
- **A projection-level policy seam.** One consumer, which already has a
  tree-level seam in `compact`. Absorb it after it is worn in.
- **Building on `provider` + `modelId`.** See "The axis" — it degrades the modal
  case for nothing.

## Landed: the tool-span grammar

`4dca94a8`. Distinct from everything above and shipped first, because it needs no
model switch and no provenance: a tool call **opens** a span and its result
**closes** it, and a conversation may be divided only where no span is open.

Reachable on one model with no provenance in the picture — a `<Timeline>` filter
dropping the assistant turn, token-budget eviction cutting mid-span,
`preserveRoles` evicting the assistant turn out from under its own result. The
second was live: neither built-in eviction strategy yields a contiguous window.

`toolSpanEnd` and `danglingToolIds` in `@agentick/spec` are the shared predicate;
each site keeps its own repair. Unlike provenance degradation this has a correct
always-on answer — it is grammar rather than meaning.

| pass               | when         | decides                                 |
| ------------------ | ------------ | --------------------------------------- |
| tool spans         | wire, always | grammar — never emit an illegal request |
| round-trip degrade | tree, opt-in | meaning — is losing continuity worth it |
| recovery on 400    | on rejection | the default; the provider is the oracle |

Under the dialect axis the middle row could also become always-on: its false
positives are gone, so it is closer to grammar than the old draft could claim.
Ship it opt-in, watch it, then decide.

## Checklist

**Read "Parked: `foreign` is a phantom" before starting anything here.** Three
items are struck because the verdict they serve does not need computing.

- [x] Tool-span grammar at the wire, shared predicate in spec (`4dca94a8`)
- [x] Target readable at render — `useActiveModel()`, ADR 55
- [x] Provenance on execution-produced messages — `metadata.model`
- [x] Round-trip state namespaced by dialect — `ReasoningBlock.signature` deleted,
      Anthropic stamps `providerMetadata.anthropic.signature` (`41034325`)
- [x] ~~Split the canonical block's `providerMetadata`~~ — **moot.** Adapters read
      only their own namespace by key, so an adopter's `cacheControl` is never
      mistaken for round-trip state. It is never read at all.
- [x] ~~`roundTripState` — the four-valued check~~ — **moot.** `none` and `foreign`
      both mean "nothing to do"; the survivor is "does my target's required key
      exist", which the provider already answers.
- [x] ~~Adapter round-trip key declarations~~ — **moot.** They existed to identify
      `foreign`.

Still open, and only worth doing when a real failure arrives:

- [ ] Recovery on rejection: the provider is the oracle, and it already says
      `malformed_tool_call`. Degrade the offending message, retry.
- [ ] `degradeMessage` (one in, N out), `degradeForReplay`, `degradedFrom` on
      every output. Returns messages, not counterfeit entries. The transform
      design above is sound — it is the classification in front of it that was
      invented.
- [ ] Reasoning blocks: drop, not degrade — verify against Anthropic's actual
      validation semantics before relying on the wording above
- [ ] Adopter docs, with Ernesto's timeline as the worked example
