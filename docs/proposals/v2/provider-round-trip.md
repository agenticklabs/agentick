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

### 1. Provenance on the assistant message

`message.metadata.model = { provider, modelId }` — the target we actually
called. The boundary entry already carries this; the message does not, and an
app cannot observe what it was never told.

### 2. `isReplayable(entry, target)` — three-valued

```ts
type Replayability = "replayable" | "foreign" | "unknown";
```

`unknown` (no provenance) is the **dangerous** state, not the benign one.
Gemini rejects _missing_ signatures, so an imported or brownfield timeline — the
one carrying no provenance at all — is the most likely to fail. Collapsing it
with `foreign` would hide that; collapsing it with `replayable` would break it.

### 3. `replayGroups(entries, target)` — the primitive

Returns the entries partitioned into replay units:

```ts
type ReplayGroup =
  | { readonly replayable: true; readonly entry: TimelineEntry }
  | {
      readonly replayable: false;
      readonly entries: readonly TimelineEntry[]; // the call AND its result
      readonly provenance?: { provider: string; modelId: string };
      readonly reason: "foreign" | "unknown";
    };
```

**The unit is the sequence, not the entry**, and that is the whole reason this
exists. A `tool_use` lives in one entry and its `tool_result` in the next, so a
per-entry predicate is a trap: it lets an adopter degrade one half and orphan
the other, which trades one rejection for a different one. Grouping makes the
pairing impossible to get wrong, and returns data the tree can map over.

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

### 4. `degradeForReplay(entries, target)` — the default

`replayGroups` plus the default collapse, for adopters who want it handled:

```ts
const safe = degradeForReplay(entries, target); // TimelineEntry[]
```

A degraded group becomes ONE `role: "event"` message per call/result pair,
carrying a `<system_event>` block. Never `role: "user"` — re-attributing the
assistant's own tool call to the user corrupts in-context learning, and the
model reads its own turns as exemplars. Never hand-written prose — `event`
collapses to `user` at the wire, and the _structure_ is what keeps it
distinguishable from speech. That is the argument ADR 94 already made for
`<Grounding>`, applied to a second kind of non-speech content.

### The transform, concretely

```
assistant [thinking, text, tool_use]   →  assistant(text) · event(call+result)
assistant [text, tool_use, text]       →  assistant(text) · event(call+result) · assistant(text)
assistant [tool_use]                   →  event(call+result)          ← message dropped, it emptied
tool      [tool_result]                →  folded into its partner's event
```

Four rules, each earned:

1. **In position, never hoisted.** The dominant shape is text-then-call ("Let me
   check that." + `tool_use`). Emitting the call before the assistant message
   says it called first and explained afterwards — backwards, and it teaches bad
   turn structure to a model reading its own history as exemplars.
2. **Thinking drops silently — no event.** Wrapping a dropped thinking block in
   an announcement is context-window noise for a fact nothing consumes.
3. **An emptied assistant message is dropped.** A bare `tool_use` with no
   preamble is extremely common; after extraction there is no content left, and
   an empty assistant message is meaningless at best.
4. **One event per call/result pair.** Two events would need a correlation
   scheme to replace the one just discarded.

**The `tool` message carries no provenance of its own** — we produced that
result, not the model, and there is no signature on it. It is condemned by
COUPLING: its partner cannot be replayed and an orphan result is its own
rejection. So it cannot be decided by looking at it, which is why the primitive
groups rather than filters. A per-message predicate would examine that message,
find nothing wrong, keep it, and orphan it.

The assistant message is the harder case for the opposite reason: it is MIXED —
some blocks replayable, some not, in one message, and the split must preserve
order and handle emptying. Hiding that asymmetry is the helper's whole job.

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
    replayGroups(entries, useTarget()).map((group) =>
      group.replayable ? (
        <Message key={group.entry.message.id} {...group.entry.message} />
      ) : (
        <CollapsedTurn key={keyOf(group)} group={group} />
      ),
    )
  }
</Timeline>
```

```tsx
function CollapsedTurn({ group }: { group: DegradedGroup }): React.ReactNode {
  const { name, input, result } = toolCallOf(group);
  return (
    <Event>
      <system_event
        event="tool_call"
        source="replay"
        data={{ name, input, result, producedBy: group.provenance?.modelId }}
      />
    </Event>
  );
}
```

Structure, so the formatter decides the wording, so it reads correctly in
markdown and XML from one tree.

### Level 3 — a different policy entirely

`replayGroups` is analysis; nothing obliges you to degrade. Drop foreign turns,
keep them and gamble, or degrade only the ones older than the last fold:

```tsx
const groups = replayGroups(entries, target);
const keep = groups.filter((g) => g.replayable || g.reason === "unknown");
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
- **One event per call/result pair**, not per turn. Parallel tool calls are
  common, and a stable 1:1 mapping is what keeps the rendering deterministic.

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
- **Quarantine-on-rejection as the primary path.** It mutates history
  mid-conversation: a turn replayed fine for ten turns, then gets refused and
  removed, rewriting the prompt in the middle. Keep it in the drawer as
  _recovery_ — for a legal timeline refused for a reason the adopter had no
  information to predict, which includes the brownfield `unknown` case. It
  composes cleanly on top: decide what to attempt, handle being refused anyway.

## Open before implementation

**Is the resolved `ExecutionTarget` readable at render?** Every example above
assumes `useTarget()`. The `<Model>` cascade resolves per tick and a per-call
override never reaches the tree. If it is not readable, that is the first commit
— and it is worth making regardless, because no target-conditional decision is
expressible from the tree without it, media handling included.

## Checklist

- [ ] Verify / add target-at-render
- [ ] Stamp `metadata.model` on the assistant message
- [ ] Per-dialect coupling rules declared by each adapter (google, anthropic, openai)
- [ ] `isReplayable` (per BLOCK), `replayGroups`, `degradeForReplay`
- [ ] Reasoning blocks: drop, not degrade — verify against Anthropic's actual
      validation semantics before relying on the wording above
- [ ] Tests: the pair rule, determinism across ticks, `unknown` ≠ `foreign`
- [ ] Adopter docs, with Ernesto's timeline as the worked example
