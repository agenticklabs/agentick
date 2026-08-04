# Provider round-trip data across a model change

**Status:** design agreed 2026-08-04, unbuilt. Ryan + Claude.

## The problem

Providers attach opaque blobs to assistant turns that must come back on replay:
Gemini `thoughtSignature` on `functionCall` parts, Anthropic `signature` on
thinking blocks, OpenAI encrypted reasoning items. Gemini 3.x **rejects** a
multi-step replay whose first function call lacks one — a 400, not a degradation.

The timeline is durable and the model is not. Every long-lived conversation
eventually replays blobs produced by a model it is no longer talking to. This is
not an edge case; it is a certainty with a date on it.

Observed: `gemini-2.5-flash` → `gemini-3.5-flash` carried signatures fine. So
compatibility follows the _format_, which providers do not publish, and not the
model id.

## The split

**Framework ships facts and wire grammar. It decides no policy.**

- **Facts** — what we observed. The provenance of a turn is not a claim about
  compatibility; it is a record of which target produced it.
- **Grammar** — a request malformed by construction. A `tool_result` whose
  `tool_use` was removed is its own rejection. This is not a matter of opinion
  and no adopter should learn it from a 400.
- **Meaning** — whether losing reasoning continuity is an acceptable price for
  this conversation. A product judgment. Never the framework's.

## What the framework provides

### 1. Provenance on every message an execution produces

`message.metadata.model = { provider, modelId }` — the target we actually
called. The boundary entry already carries this; the message does not, and an
app cannot observe what it was never told.

**Not only assistant messages.** A `tool` message carries no provenance of its
own — we produced that result, not the model — so a per-message rule reads it as
`unknown` and degrades it even when the turn it belongs to was fine. We know the
target when the result is appended, so we stamp it. That one line is what makes
the transform local: both halves of a call carry the same stamp, the coupling is
guaranteed rather than reconstructed, and nothing needs to look ahead.

### 2. `isReplayable(entry, target)` — three-valued

```ts
type Replayability = "replayable" | "foreign" | "unknown";
```

`unknown` (no provenance) is the **dangerous** state, not the benign one.
Gemini rejects _missing_ signatures, so an imported or brownfield timeline — the
one carrying no provenance at all — is the most likely to fail. Collapsing it
with `foreign` would hide that; collapsing it with `replayable` would break it.

### 3. `degradeMessage(entry, target)` — the primitive

One entry in, N entries out:

```ts
function degradeMessage(entry: TimelineEntry, target: ExecutionTarget): TimelineEntry[];
```

Give every block a disposition — `keep`, `drop`, `degrade` — then collapse
contiguous **keeper** runs into one message of the original role and emit each
degraded block as its own `event`, in place. Order comes from block positions,
not from a fixed layout.

Make the disposition **data-driven, not type-driven**: a block is at risk if it
carries foreign `providerMetadata`, not if it is of some enumerated type. Block
kinds added later then work without touching this.

`degradeForReplay(entries, target)` is `entries.flatMap((e) => degradeMessage(e, target))`.

### Tool calls are NOT the only failure mode

The check is per **block**, not per entry — `providerMetadata` already lives on
the block, and promoting the check to the entry is what made an earlier draft of
this design look tool-specific when the problem is not.

- **Reasoning blocks carry signatures too.** Anthropic `thinking` blocks carry a
  validated `signature` and are expected on the replay of a turn that made a
  tool call; Gemini 3.x signs thought parts, not only `functionCall` parts;
  OpenAI reasoning items carry `encrypted_content`. Claude + extended thinking +
  tools is the default shape of a coding agent, so a design covering only
  `tool_use`/`tool_result` covers about half the surface.
- **The coupling rule is per-dialect and belongs to the adapter.**
  `tool_use`↔`tool_result` is one wire's grammar; `thinking`↔`tool_use`-in-the-
  same-turn is another's. Adapters declare the coupling; the framework enforces
  it. Same split as `capabilities.media`.
- **Disposition differs by kind**, and the question that separates them is
  whether the block's absence is recoverable from what remains:
  - **reasoning → drop.** The assistant's text survives and nothing downstream
    needs to know a thinking block was there. No event, no collapse.
  - **tool call → degrade.** Dropping it loses a fact the model needs — that a
    tool ran, and what came back.

**Out of scope: request-level pointers.** OpenAI's `previous_response_id` names
server-side state rather than a block. There is nothing to strip or group; it
lives in `providerOptions` and degrades by being omitted. No helper here touches
it.

### 4. What a degraded block becomes

A `role: "event"` message carrying a `<system_event>` block. Never `role:
"user"` — re-attributing the assistant's own tool call to the user corrupts
in-context learning, and the model reads its own turns as exemplars. Never
hand-written prose — `event` collapses to `user` at the wire, and the
_structure_ is what keeps it distinguishable from speech. That is the argument
ADR 94 already made for `<Grounding>`, applied to a second kind of non-speech
content.

Every degraded entry carries `metadata.degradedFrom = { messageId, provenance,
reason }` — the id and the provenance, **never the original content**. A pointer
records; a copy doubles the memory for every degraded turn and puts the original
one careless renderer away from the prompt. It makes the transform auditable,
gives hooks and adapters something to key on, and is the honest statement that
this entry is derived rather than authored.

### The transform, concretely

```
assistant [thinking, text, tool_use]   →  event(call) · assistant(text)     ← order follows the blocks
assistant [text, tool_use, text]       →  assistant(text) · event(call) · assistant(text)
assistant [text, image, tool_use]      →  assistant(text, image) · event(call)
assistant [tool_use]                   →  event(call)                       ← nothing left to place
tool      [tool_result]                →  event(result)                     ← converts wholesale
```

Four rules, each earned:

1. **In position, never hoisted.** Order comes from the block positions. The
   dominant shape is text-then-call ("Let me check that." + `tool_use`), and
   emitting the call first says it called and then explained itself — backwards,
   and it teaches bad turn structure to a model reading its own history.
2. **Thinking drops silently — no event.** Wrapping a dropped thinking block in
   an announcement is context-window noise for a fact nothing consumes.
3. **An emptied message is dropped.** A bare `tool_use` with no preamble is
   extremely common; nothing remains to place.
4. **Adjacency is the correlation.** A call event and its result event sit next
   to each other exactly as they did on the wire, and `degradedFrom` carries the
   tool id for anything that needs certainty. An earlier draft folded the pair
   into one event to "preserve the correlation" — it was already preserved.

**Non-text blocks stay.** Images, code, JSON and audio the model produced carry
no signature and are replayable, so the keeper run is _everything not
provenance-bound_, not "text only".

**The `tool` message converts wholesale.** Its entire content is the result of a
call that cannot be replayed, there is nothing in it worth keeping separately,
and it has no voice to preserve. The assistant message is the harder case for
the opposite reason: it is MIXED, and the split must preserve order and handle
emptying. Hiding that asymmetry is the helper's whole job.

**Why not convert the assistant message wholesale too?** Most assistant messages
carry no round-trip data at all — a text answer has no signature and replays
against anything. A message-level rule degrades every one of them on a model
switch, leaving `user · event · user · event` for the entire pre-switch history
with no exemplar of the model's own voice anywhere in it. Summarising an
assistant turn is the most expensive mistake this codebase has made; converting
every one of them is a gentler version of it, applied all at once.

## Ergonomics

### Level 1 — handled

```tsx
<Timeline>
  {(entries) =>
    degradeForReplay(entries, useTarget()).map((entry) => (
      <Message key={entry.message.id} {...entry.message} />
    ))
  }
</Timeline>
```

### Level 2 — your own rendering of a degraded turn

```tsx
<Timeline>
  {(entries) =>
    entries.flatMap((entry) =>
      degradeMessage(entry, useTarget()).map((out) =>
        out.message.metadata?.degradedFrom ? (
          <CollapsedTurn key={out.message.id} entry={out} />
        ) : (
          <Message key={out.message.id} {...out.message} />
        ),
      ),
    )
  }
</Timeline>
```

```tsx
function CollapsedTurn({ entry }: { entry: TimelineEntry }): React.ReactNode {
  const { degradedFrom } = entry.message.metadata;
  return (
    <Event>
      <system_event
        event="tool_call"
        source="replay"
        data={{ ...toolCallOf(entry), producedBy: degradedFrom.provenance?.modelId }}
      />
    </Event>
  );
}
```

Structure, so the formatter decides the wording, so it reads correctly in
markdown and XML from one tree.

### Level 3 — a different policy entirely

`isReplayable` is analysis; nothing obliges you to degrade. Drop foreign turns,
keep them and gamble, or degrade only the ones older than the last fold:

```tsx
entries.flatMap((entry) =>
  isReplayable(entry, target) === "replayable" || withinLastFold(entry)
    ? [entry]
    : degradeMessage(entry, target),
);
```

## Rules an adopter must not have to discover

- **Degradation is non-destructive.** It shapes the projection, never the
  timeline. Switch back to a compatible model and the fast path returns with
  nothing to restore. Rewriting history to fix a model change is a one-way door
  paid before you know the switch stuck.
- **It must be deterministic.** The same collapsed turn renders byte-identically
  on every tick. A wobble rewrites the middle of the prompt and invalidates the
  prefix cache from that point down — the same failure the execution-anchored
  recency boundary exists to prevent.
- **One event per degraded block.** Parallel tool calls are common, and a stable
  1:1 mapping is what keeps the rendering deterministic. Derive the event's id
  from the source message id plus the block index, never from a counter.

## Rejected, with reasons

- **A compatibility-token registry in the catalog.** Hand-maintained claims
  about blobs nobody versions publicly. Wrong means confident replay and a
  silent outage on every old thread — the exact failure it was built to prevent,
  with a config file making it look handled. The ecosystem (ai-sdk, LangChain)
  declines to model this, and that is not an oversight.
- **`strip` as an outcome.** Removing a signature while keeping the
  `functionCall` part _is_ the 400. It was either a no-op or the bug.
- **A projection-level policy seam.** One consumer, which already has a
  tree-level seam in `compact`. Absorb it after it is worn in.
- **A preemptive framework-wide pass on every tick.** There is no correct
  always-on default: degrade on any mismatch and the MODAL model change
  (`gemini-2.5-flash` → `3.5-flash`, signatures carried fine) is degraded for
  nothing; never degrade and the pass does nothing. Anything between needs the
  compatibility fact nobody publishes. The native default is the recovery path
  below, not a second pass.
- **Quarantine-on-rejection as the primary path.** It mutates history
  mid-conversation: a turn replayed fine for ten turns, then gets refused and
  removed, rewriting the prompt in the middle. Keep it in the drawer as
  _recovery_ — for a legal timeline refused for a reason the adopter had no
  information to predict, which includes the brownfield `unknown` case. It
  composes cleanly on top: decide what to attempt, handle being refused anyway.

  **It IS the native default, as recovery.** Send it, and on refusal locate the
  part, degrade it with the same `degradeMessage`, retry, and persist the
  quarantine record. Optimal (nothing degrades that did not have to), safe (the
  400 never reaches the user), self-healing, and it needs no compatibility
  knowledge because the provider is the oracle. The prefix-cache objection above
  does not apply in the case it fires for: a model change has already discarded
  the provider's cache. It stands for a same-model rejection — a stale
  `fileUri` — which is why this is recovery and not the routine path.

  Both paths call the same `degradeMessage`. One implementation, two triggers;
  an adopter who degrades in the tree never trips the recovery.

## Open before implementation

**Is the resolved `ExecutionTarget` readable at render?** Every example above
assumes `useTarget()`. The `<Model>` cascade resolves per tick and a per-call
override never reaches the tree. If it is not readable, that is the first commit
— and it is worth making regardless, because no target-conditional decision is
expressible from the tree without it, media handling included.

## A separate, unconditional pass: orphan detection

Distinct from everything above and worth building first. An orphaned
`tool_result` — a result whose `tool_use` is not in the projection — is illegal
regardless of provenance, and degradation is not the only thing that creates
one:

- a `<Timeline>` `filter` that drops the assistant turn but keeps the tool message
- token-budget eviction cutting between a call and its result
- `preserveRoles: ["system", "user"]` evicting the assistant turn out from under
  its own result

None involve a model switch; adopters can hit all three today, on one model,
with no provenance in the picture. Unlike provenance degradation this has a
correct always-on answer, it is grammar rather than meaning, and it fires for
the common case rather than the rare one — so it runs at collect,
unconditionally.

| pass               | when            | decides                                 |
| ------------------ | --------------- | --------------------------------------- |
| orphan check       | collect, always | grammar — never emit an illegal request |
| provenance degrade | tree, opt-in    | meaning — is losing continuity worth it |
| quarantine         | on rejection    | recovery for what nobody could predict  |

## Checklist

- [ ] Orphan detection at collect (independent of everything else — ship first)
- [ ] Verify / add target-at-render
- [ ] Stamp `metadata.model` on EVERY message an execution produces (tool
      results included — this is what makes the transform local)
- [ ] Per-dialect coupling rules declared by each adapter (google, anthropic, openai)
- [ ] `isReplayable` (per BLOCK), `degradeMessage` (one in, N out),
      `degradeForReplay` (the flatMap over it), `degradedFrom` on every output
- [ ] Reasoning blocks: drop, not degrade — verify against Anthropic's actual
      validation semantics before relying on the wording above
- [ ] Tests: the pair rule, determinism across ticks, `unknown` ≠ `foreign`
- [ ] Adopter docs, with Ernesto's timeline as the worked example
