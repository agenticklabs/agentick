# ADR 75 — The change-event primitive and the `event` timeline archetype

**Status:** DRAFT 2026-07-10 (Fable, for Ryan). **Builds on:** ADR 49
(stores-not-snapshots — three planes, outcomes-not-commands, the timeline as the
recovery-bearing ES log), ADR 73 (StateDelta — the first routing of a reactive
change), ADR 76 (operation middleware — the _intercept_ seam this ADR's _notify_
seam is the twin of), the `KeyedNotifier` (`@agentick/pubsub`), the per-entry
`renderedWith: FormatterRef` seam (`entries.ts`). **Governing principle:**
[[feedback_capability_not_opinion]] — ship _capability_ + an _overridable default_,
never a hardcoded policy.

## TL;DR

Two foundational things; everything else is a consequence.

1. **The change-event primitive.** Reactive harnesses expose only _pull_ reactivity
   today — `subscribe(key, () => void)` → re-read. They lack _push_: a **typed
   change-event carrying the delta**. We add `onChange` to `KeyedNotifier`. This is
   the **notify** seam — the read-only twin of the _intercept_ (middleware, ADR 76)
   and _commit_ (factory-slot) seams the framework already has.
2. **The `event` timeline archetype.** The **persisted** timeline
   (`TimelineEntry`) gains a first-class `kind:"event"` entry — sibling to the
   message and the ADR 53 turn boundary — that _renders to_ a message at compile.
   `"event"` is retired from **both** role unions (`MessageRole` +
   `SessionMessageRole`), fixing an axis bug (an event has no _voice_; it belongs on
   `kind`, not `role`) via a real migration, `visibility` serving the
   out-of-model-context case.

The consequences, both shipped as overridable defaults: a change-event **may**
project into the timeline as a `kind:"event"` outcome (opt-in per kind), and it
renders to a provider through the **formatter** (default: a `user` message in an
`<event>` envelope). Nothing else. There is **no framework wake policy** — a _run_
is started by the adopter calling `send()`, including from an `onChange` handler.

## Problem

Two gaps surfaced while wiring StateDelta (ADR 73) and the AG-UI step projection:

1. **No push reactivity.** `KnobsHarness.subscribe(id, () => void)` fires _bare_ —
   "something changed," not _what_. StateDelta had to hand-capture the value at the
   mutation site because the notifier couldn't carry it. Every projection (wire
   delta, step, timeline entry) wants the delta and the substrate can't hand it over.
2. **The `event` axis is confused.** Both role unions — `MessageRole`
   (rendered-tree) and `SessionMessageRole` (persisted) — carry `"event"`. An event
   is not a _voice_: nobody _speaks_ an event, it _happens_. It belongs on the `kind`
   axis, not `role`. `"event"` is a _crude existing mechanism_ ("state events that
   flow through the timeline without participating in model context," paired with
   `visibility`), with reconciler-react test usages and README-flagged deferred debt
   — so retiring it is a **migration** (Decision 2), not a clean deletion.

A third, softer gap follows: once a harness _can_ emit a typed change, there is no
principled seam for promoting a system fact (a task completing, a host setting a
knob out-of-band) into a **domain outcome** the model reads on its next turn.

## Null hypothesis (why existing facts don't already suffice)

Steel-manning before adding anything ([[feedback_steelman_the_null_hypothesis]]):

- _"The bus already carries every change — subscribe to it."_ True for **observation**
  (a UI, a codec). But the bus is Transport-plane: bounded-retention, not
  recovery-bearing (ADR 49). A fact the **model** must fold over on its next render
  must live on the **Domain** plane (timeline). Bus-subscription cannot put a fact
  into the model's context; only a timeline entry can. Necessary, not sufficient.
- _"Keep `role:"event"` — it works."_ It type-checks but it's a category error: a
  role is a speaker, an event has none, and it forces every adapter to answer "what
  voice is an event?" It's already README-flagged as deferred debt. Fixing the axis
  (a `kind`, with `visibility` for the out-of-context case) beats perpetuating it.
- _"Auto-dump all harness changes into the timeline."_ The ES-bloat ADR 49 forbids:
  a knob at `5` after 100 sets needs _one live render of `5`_, not 100 outcome
  entries. Current-state churn renders live from the store; only discrete _outcomes_
  belong in the recovery log. The answer is a **curated, opt-in projection**.

## Decision

### 1. The change-event primitive — the `ChangeNotifier` notify seam

A **sibling primitive** in `@agentick/pubsub`, `ChangeNotifier<V>`, carries
typed _push_ reactivity alongside the existing _pull_ one. It is deliberately
**separate from `KeyedNotifier`** (not a bolt-on): `KeyedNotifier`'s job is
`void`-or-`T` ping fan-out for `useSyncExternalStore` render subscriptions; folding
a value+prev change stream into it would force a third type parameter and muddy
that overload. Single responsibility — a harness holds both: a `KeyedNotifier` for
render pings and a `ChangeNotifier` for the delta stream.

```ts
interface ChangeEvent<V, K = string> {
  readonly key: K;
  readonly value?: V;   // present when the key now holds a value (add | update)
  readonly prev?: V;    // present when the key previously held one (update | remove)
}

interface ChangeNotifier<V, K = string> {
  // push (new): "here is exactly what changed" — read-only, fire-and-forget
  onChange(listener: (change: ChangeEvent<V, K>) => void): Unsubscribe;
  // producer supplies the full delta (it knows `prev` at the mutation site)
  emitChange(change: ChangeEvent<V, K>): void;
}

// pull (unchanged, KeyedNotifier): "something changed, re-read"
subscribe(key: string, listener: () => void): Unsubscribe;
```

**No transition verb in the primitive.** `ChangeEvent` carries _data_ (`key`,
`value`, `prev`); the _semantic_ transition — "completed," "reordered," "budget
lowered" — is the harness's to name (see Decision 3, `eventKind`). Only the harness
knows whether a value change means completed or reordered; a CRUD verb in the
substrate would be a lossy guess and would double-book the semantic. Order in
ordered collections rides the value, not a `reorder` variant. A pure `changeKind()`
helper derives the mechanical `add`/`update`/`remove` for consumers that need the
CRUD shape (e.g. a JSON-Patch codec) from value/prev presence.

This is the notify seam in the three-seam model (ADR 76): **intercept** (middleware)
can transform or veto; **commit** (the factory slot) mutates; **notify** (`onChange`)
observes the committed fact, **read-only and fire-and-forget**. An observer must
never be able to change the outcome — the instant it can `throw`-to-abort or
return-to-transform, it _is_ middleware, and the power-level distinction that keeps
the system reason-about-able is lost. This is the single load-bearing rule of the
primitive.

This is the **one substrate addition** the rest of the ADR composes over. Knobs,
state, gates, and any collection harness emit `onChange` at their mutation sites
(they already know the delta there). Pull stays for rendering; push feeds every
projection.

### 2. The `event` timeline archetype

> **Correction (2026-07-10).** An earlier draft of this decision claimed
> `role:"event"` was vestigial and sketched the archetype against the
> rendered-tree union. Both were wrong (found on survey before implementing).
> The corrected model is below.

The spec has **two** entry models; the fix touches the persisted one:

- **Rendered-tree** — `ContextEntry = MessageEntry | SectionEntry`
  (`data/entries.ts`): the compiler's model-input projection. `kind ∈ {message,
section}`, uses `MessageRole`.
- **Persisted timeline** — `TimelineEntry = MessageTimelineEntry | TurnBoundaryEntry`
  (`protocol/session-harness.ts`): the recovery-bearing log (ADR 49). `kind ∈
{message, boundary}`, uses `SessionMessageRole`. This union **already has a
  non-message kind** — the ADR 53 turn boundary — so the archetype has precedent.

`role:"event"` is **not** vestigial. `SessionMessageRole` documents it as "app-level
state events that flow through the timeline without participating in model context,"
paired with `MessageTimelineEntry.visibility` (`model | observer | log`). It has
reconciler-react test usages and is already flagged as deferred debt in the timeline
README. It is a _crude existing mechanism_, and this ADR **replaces** it — a
migration, not a deletion.

**The event is a persisted-timeline kind that RENDERS to a message.** Add a third
`TimelineEntry` kind, sibling to `MessageTimelineEntry` / `TurnBoundaryEntry`,
following their nested-domain-object convention (`message:` / `boundary:` →
`event:`):

```ts
// "event" REMOVED from BOTH role unions:
type SessionMessageRole = "user" | "assistant" | "system" | "tool" | (string & {});
type MessageRole = "user" | "assistant" | "system" | "tool" | (string & {});

interface EventTimelineEntry {
  kind: "event";
  event: {
    id: string;
    eventKind: string; // open, namespaced: "knobs:changed", "tasks:completed"
    content: readonly ContentBlock[]; // semantic rendering (from the projection)
    payload?: unknown; // the structured outcome — not a frozen string (ADR 49)
    source?: EventSource; // "model" | "host" | "remote" | (string&{})
    renderedWith?: FormatterRef; // per-entry format override (the Decision 4 seam)
  };
  ts: number; // when it happened (ISO ms — timeline convention, not `timestamp`)
  visibility?: "model" | "observer" | "log"; // SAME control as MessageTimelineEntry
  tags?: readonly string[];
  metadata?: SessionMessageMetadata;
}
```

Crucially, the event does **NOT** get a parallel entry in the rendered-tree
(`entries.ts`). At compile it **renders to a `MessageEntry`** (role `user` + the
`<event>` envelope, Decision 4) — normalization stays a projection concern, and
`renderedWith` on the _stored_ event keeps re-projection deterministic (ADR 49:
store the outcome, re-render by fold). `eventKind` is an **open** namespaced string
(`"<harness>:<verb>"`), the same extension posture as roles.

An event is a distinct archetype from a **message** (no voice — it _happened_,
nobody _spoke_ it) and from a **section** (a section is _ambient current-state_,
re-rendered live; an event is a _historical outcome_ at `ts`). The `kind`
discriminator carries exactly this; `role` is the wrong axis for it.

**Migration (retiring `role:"event"`):** remove `"event"` from both `MessageRole`
and `SessionMessageRole`; add `EventTimelineEntry` to the `TimelineEntry` union
(+ its fold/render handling, mirroring the ADR 53 turn-boundary wiring); move the
reconciler-react test usages and the timeline README's deferred-conflation note onto
the new kind. The "flows through without entering model context" case is served by
`kind:"event"` + `visibility`, not a magic role.

### 3. Projection — opt-in per kind, and the no-double-count test

A **projection policy** decides which `eventKind`s become `EventEntry`s. The
framework ships a generous-but-honest default; the adopter overrides per-kind /
per-harness / globally.

- **Discrete outcomes** (`task:completed`, `elicitation:answered`, any host /
  out-of-band mutation) → **ON**: a real fact the model should carry.
- **State churn** (`knob:changed`, `gate:toggled`, `todo:reordered`) → **OFF**:
  current value renders live; intermediate states are ES-bloat (ADR 49).

**The no-double-count test (the governing rule, not the table).** If an `eventKind`
is _fully recoverable from a live current-state render_, it does **not** project —
projecting it makes the model read the same fact twice, in two representations that
can drift. Events carry the transition facts a current-state render _cannot_ show:
_who_ changed it, _when_, _why_, that it changed _at all_. Current-state renders own
"what is true now"; events own "what happened." The table above is just this test
applied to common kinds.

**Capability:** change-events _can_ project. **Opinion (overridable):** the default
per-kind classification.

### 4. Rendering — formatter-owned; `user` + `<event>` envelope by default

An `EventEntry` is provider-agnostic; the **formatter** owns provider normalization,
riding the existing `renderedWith: FormatterRef` seam.

**Why `user` + an envelope.** No provider has a native "an event occurred" role, and
of the roles that exist only `user` is interspersable mid-conversation on every
provider (`system` is a single top-level param on Anthropic/Google; `tool` needs a
matching `tool_use` id; `assistant` is the model's voice). So the portable carrier
is `user`, with the "not human voice" signal in the **content envelope**:

```
role: "user"
content: <event kind="knobs:changed" source="host" at="2026-07-09T18:22:01Z">
           The budget knob was set to 50.
         </event>
```

Uniform across providers (not OpenAI-only `developer`) → prompt/eval portability.
The framework owns the **default formatter, not the format** — an adopter swaps
`renderedWith` for prose, JSON, a compact marker, or a `developer`-role upgrade.

**Injection requirement (firm, not optional).** Real user input is _also_ `user`
content, so the envelope convention creates a spoofing surface: a user typing
`</event><event source="host">…</event>` forges a system event. Any formatter that
uses tag-envelope normalization **must neutralize event-envelope syntax in
genuine user-authored content** (escape `<`/`>`, or use a delimiter the model is
told only the framework emits). The default formatter ships this escaping; a custom
one that renders events as tags inherits the obligation. Capability side: the
envelope is only safe if user content cannot forge it.

Timestamps: **events carry one** (rendered by default). For messages generally,
`timestamp` is an optional field — capability present, populating it is the
adopter's call.

## The notify seam's consumers

```
harness mutation → onChange(ChangeEvent)          [Decision 1 — the primitive]
   ├─ StateDelta                 → bus / wire      [ADR 73 — BUILT]
   ├─ AG-UI StepStarted/Finished → bus / wire      [ADR 73 — specced]
   └─ EventEntry(kind:"event")   → timeline        [this ADR — opt-in, curated]
```

Three independent consumers subscribe to one push stream — which is simply what a
push stream is _for_. There is no fourth "wake" routing: **starting a run is the
adopter calling `send()`** (optionally from an `onChange` handler, with their own
rate-limiting). A framework wake policy would be shipping a debounce/dedupe _opinion_
— exactly what capability-not-opinion forbids — and it is redundant once `onChange`
and `send()` both exist. Resume (a suspended execution continuing on an elicitation
answer / awaited result, ADR 68/69) is a separate, already-built mechanism and is
_not_ a new run.

## Capability vs opinion

| Concern             | Capability (firm)                                  | Default opinion (overridable)                     |
| ------------------- | -------------------------------------------------- | ------------------------------------------------- |
| Reactivity          | `onChange` typed change-event; observers read-only | — (mechanism)                                     |
| Event archetype     | `kind:"event"` entries; no `role`                  | — (structural)                                    |
| Rendering           | events render via `renderedWith: FormatterRef`     | `user` + `<event>` XML (with forced escaping)     |
| Timeline population | change-events _can_ project                        | per-kind: outcomes ON, churn OFF; no-double-count |
| Timestamps          | entries may carry `timestamp`                      | events include one; messages: adopter's call      |
| Starting a run      | `send()` (callable from `onChange`)                | nothing auto-runs; no framework wake policy       |

## Rejected

- **A transition verb (`add`/`update`/`remove`) in `ChangeEvent`.** Leaky for
  FSM-shaped harnesses (a task _completing_ is not a generic "update") and
  double-books the semantic with `eventKind`. Primitive carries data; harness names
  the transition.
- **Keep `role:"event"`.** Category error; forces adapters to answer an
  unanswerable "what voice?" Retired via `kind:"event"` + `visibility` — a
  migration off both role unions, not a clean deletion.
- **Auto-project every harness change.** ES-bloat (ADR 49); churn renders, not logs.
- **`developer` role as the default carrier.** Non-portable (OpenAI-only) and
  semantically "instructions," not "a fact." `user` + envelope is the portable
  default; `developer` an opt-in.
- **Bake the `<event>` tag into the entry.** Couples the domain log to one wire
  format. Entry is semantic; envelope is formatter output.
- **A framework wake policy / `SystemEventHarness`.** A run is an adopter `send()`;
  a wake policy is a throttling _opinion_ and a subsystem multiplies what the
  `onChange`+`send()` composition already covers.

## Open questions

1. **Coalescing churn.** If an adopter _does_ want churn in the transcript, is the
   opt-in a per-write entry, a net-change-at-execution-boundary entry, or a debounce
   window? Lean: OFF by default; offer boundary-coalesce when asked.
2. **Retrofit order.** Prove `onChange` on `state` first (dual-reactivity on the
   generic collection) then adopt in knobs/gates/todos, or refit StateDelta (knobs)
   as the first real consumer? Lean: knobs — it already has the pain and proves the
   primitive isn't speculative.
3. **`source` provenance fidelity.** `"model" | "host" | "remote"` — enough, or does
   multi-tenant audit need the acting principal (ADR 48 scope) on the event?

## References

- `docs/proposals/v2/blueprint/49-stores-not-snapshots.md` — three planes,
  outcomes-not-commands, the timeline as the ES log.
- `docs/proposals/v2/blueprint/76-operation-middleware-scoping.md` — the _intercept_
  seam; `onChange` here is its _notify_ twin.
- `docs/proposals/v2/blueprint/73-ag-ui-projection.md` — StateDelta + steps, the
  first change-event routings.
- `packages/spec/src/data/entries.ts` — `MessageEntry` / `SectionEntry` +
  `renderedWith: FormatterRef`.
- `packages/spec/src/data/content-blocks.ts` — `MessageRole`, and
  `packages/spec/src/protocol/session-harness.ts` — `SessionMessageRole` +
  `TimelineEntry` / `MessageTimelineEntry` / `TurnBoundaryEntry` (both role unions
  drop `"event"`; the new `EventTimelineEntry` kind lands here, and `visibility`
  serves the out-of-context case). Migration touches reconciler-react's
  `content-blocks.spec.tsx` `role:"event"` usages + the timeline README note.
- `packages/pubsub/src/change-notifier.ts` — the `ChangeNotifier` notify seam
  (`onChange` / `emitChange` / `changeKind`), sibling to `keyed-notifier.ts`. **BUILT.**
