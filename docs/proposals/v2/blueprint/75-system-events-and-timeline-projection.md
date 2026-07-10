# ADR 75 — System events: the change-event primitive, the `event` timeline archetype, and opt-in projection

**Status:** DRAFT 2026-07-09 (Fable, for Ryan). **Builds on:** ADR 49
(stores-not-snapshots — three planes, outcomes-not-commands, the timeline as the
recovery-bearing ES log), ADR 63 (default-projection registry — the surfacing
seam), ADR 68/69 (persistent tasks + escalation — `input_required` resume vs a
*new* run), ADR 73 (StateDelta — the first bus/wire routing of a reactive
change), the `KeyedNotifier` (`@agentick/pubsub-next`), the per-entry
`renderedWith: FormatterRef` seam (`entries.ts`). **Governing principle:**
[[feedback_capability_not_opinion]] — agentick builds agent harnesses; it ships
*capability* + a good *overridable default*, never a hardcoded policy.

## TL;DR

Three things, one spine. **(1)** Reactive harnesses today expose only *pull*
reactivity — `subscribe(key, () => void)` → re-read. They lack *push* — a **typed
change-event** that carries the delta. We add it as one small substrate primitive
on `KeyedNotifier`. **(2)** A change-event can be routed to four sinks; two exist
or are specced (StateDelta wire, AG-UI steps), two are new here: a **timeline
`event` entry** and a **loop-wake**. **(3)** The timeline gains a first-class
`kind:"event"` archetype (sibling to `message`) — fixing the current axis bug
where `"event"` is a stray *role*. A harness op can *optionally* project into the
timeline as an outcome the model reads; normalization to a provider is a formatter
concern with a portable default (a `user` message in an `<event>` XML envelope).
Nothing is imposed: every routing, format, and policy is an overridable default.

## Problem

Three gaps surfaced together while wiring StateDelta (ADR 73) and the AG-UI step
projection:

1. **No push reactivity.** `KnobsHarness.subscribe(id, () => void)` fires *bare* —
   "something changed," not *what*. Building StateDelta forced value-capture at the
   mutation site because the notifier couldn't carry the new value. Every
   projection (wire delta, step, timeline entry, webhook) wants the delta, and the
   substrate can't hand it over.
2. **The `event` axis is confused.** `MessageRole` is `"user" | "assistant" |
   "system" | "tool" | "event" | (string&{})`. `"event"` is not a *voice* — nobody
   *speaks* an event, it *happens*. It belongs on the `kind` axis (`"message" |
   "section"` today), not the `role` axis. The stray role value is vestigial
   (nothing produces it — verified), so this is a clean fix, not a migration.
3. **No seam for harness ops to reach the timeline.** A background task completing,
   an elicitation being answered, or a *host* setting a knob out-of-band are facts
   the model should learn on its next turn. Today they hit the bus (telemetry) and
   the journal (audit) but never the timeline (the model's world). There is no
   principled way to promote a system fact to a domain outcome — nor to decide
   which facts, in what shape, or whether any should *wake* the agent.

## Null hypothesis (why existing facts don't already suffice)

Steel-manning before adding anything ([[feedback_steelman_the_null_hypothesis]]):

- *"The bus already carries every change — just subscribe."* True for **observation**
  (a UI, a codec). But the bus is Transport-plane: bounded-retention, not
  recovery-bearing (ADR 49). A fact the **model** must fold over on its next render
  has to live on the **Domain** plane (timeline). Bus-subscription cannot put a fact
  into the model's context; only a timeline entry can. The bus is necessary, not
  sufficient.
- *"Keep `role:"event"` — it works."* It type-checks but it's a category error: a
  role is a speaker, an event has none. It also forces every provider adapter to
  answer "what voice is an event?" with no good answer (see Decision 4). Fixing the
  axis is cheaper than perpetuating the confusion.
- *"Auto-dump all harness changes into the timeline."* This is the ES-bloat ADR 49
  explicitly forbids: a knob at `5` after 100 sets needs *one render of `5`*, not
  100 outcome entries. Current-state churn is rendered live from the store; only
  discrete *outcomes* belong in the recovery log. So the answer is not "dump" — it's
  a **curated, opt-in projection**.
- *"Todos/steps/wake each need their own subsystem."* No — they are all **routings
  of one change-event**. The primitive is the change-event; the routings are
  policies over it. Compose, don't multiply ([[feedback_compose_primitives_not_subsystems]]).

## Decision

### 1. The change-event primitive — push reactivity on `KeyedNotifier`

`KeyedNotifier` gains a typed, payload-carrying variant alongside the existing bare
one (which stays — it is correct for `useSyncExternalStore` render subscriptions):

```ts
interface ChangeEvent<T> {
  readonly type: "add" | "update" | "remove";
  readonly key: string;
  readonly value?: T;      // present for add/update
  readonly prev?: T;       // present for update/remove
}

// pull (exists): "something changed, re-read"
subscribe(key: string, listener: () => void): Unsubscribe;
// push (new): "here is exactly what changed"
onChange(listener: (change: ChangeEvent<T>) => void): Unsubscribe;
```

This is the **single substrate addition** everything else composes over. Knobs,
state, gates, todos, tasks emit `onChange` at their mutation sites (they already
know the delta there). Pull stays for rendering; push feeds every projection.

### 2. The `event` timeline archetype

Split the two axes cleanly:

```ts
type MessageRole = "user" | "assistant" | "system" | "tool" | (string & {}); // "event" REMOVED

interface MessageEntry { kind: "message"; role: MessageRole; content; … }        // has a voice
interface EventEntry {                                                            // has NO voice
  kind: "event";
  eventKind: string;                       // open, namespaced: "knobs:changed", "tasks:completed"
  content: readonly ContentBlock[];        // semantic rendering (from the projection)
  payload?: unknown;                        // the structured ChangeEvent — outcome, not string (ADR 49)
  source?: EventSource;                     // "model" | "host" | "remote" | (string&{})
  timestamp: number;                        // an event is intrinsically "a thing that happened at T"
  renderedWith?: FormatterRef;              // per-entry format override (existing seam)
  id?: string;
  metadata?: MessageMetadata;
}
interface SectionEntry { kind: "section"; … }
```

`eventKind` is an **open** namespaced string (`"<harness>:<verb>"`) — extension and
custom harnesses mint their own, same posture as roles. The entry stores the
**structured outcome** (`payload`), not a frozen string, so the ES fold stays a
deterministic re-render and an old event can be re-projected differently later.

### 3. Timeline projection — opt-in per kind, generous but not indiscriminate

A **projection policy** decides which `eventKind`s become `EventEntry`s. The
framework ships defaults; the adopter overrides per-kind / per-harness / globally.
The default is *generous but honest* — it adds the facts worth remembering and
leaves churn to live rendering:

| Class | Examples | Default |
| --- | --- | --- |
| **Discrete outcomes** | `task:completed`, `elicitation:answered`, `todo:added`/`completed`, any **host/out-of-band** mutation | **ON** — a real fact the model should carry |
| **State churn** | `knob:changed`, `gate:toggled`, `todo:reordered` | **OFF / coalesced** — current value renders live; intermediate states are ES-bloat |

"Coalesced" = an optional net-change-at-execution-boundary entry rather than one per
write. An adopter who wants every knob write in the transcript flips `knob:changed`
ON; one who finds task-completion noisy flips it OFF. **Capability:** change-events
*can* project. **Opinion (overridable):** this per-kind default table.

### 4. Normalization + rendering — a `user` message in an `<event>` envelope (default)

An `EventEntry` is provider-agnostic. The **formatter** owns provider
normalization, riding the existing `renderedWith: FormatterRef` seam. The default
event formatter's decision, and why:

**No provider has a native "an event occurred" role.** And of the roles that exist,
only `user` is **interspersable mid-conversation on every provider** — Anthropic and
Google take `system`/`systemInstruction` only as a single top-level param (no
mid-stream system turn); `tool` needs a matching `tool_use` id; `assistant` is the
model's own voice. So the portable carrier is `user`, with the "not human voice"
signal in the **content envelope**, not the role:

```
role: "user"
content: <event kind="knobs:changed" source="host" at="2026-07-09T18:22:01Z">
           The budget knob was set to 50.
         </event>
```

- **Uniform across providers** (not OpenAI `developer`): what the model sees is
  identical everywhere — prompt/eval portability beats a marginally cleaner
  OpenAI-only channel. `developer`-upgrade stays a per-adapter opt-in, never default.
- **Envelope + role both live in the formatter**, not baked into the entry — both are
  provider normalization, so they belong in one seam. The entry's `content` is clean.
- **The framework owns the default formatter, not the format.** XML is the default
  because models (Claude especially) honor tags reliably; an adopter swaps
  `renderedWith` for prose, JSON, a compact marker, or nothing.

Timestamps: **events carry one** (rendered in the envelope by default). For messages
generally, `timestamp` is an optional field — capability present, populating it is
the adopter's call.

### 5. The wake seam — some events trigger the loop (gated, distinct from resume)

"Should some events trigger a run?" splits in two:

- **Resume** — an elicitation answer / awaited task result feeding a *suspended*
  execution. Already built (ADR 68 `input_required` → resume, ADR 69 escalation).
  Not a new run; continues a waiting one.
- **Wake** — a system event starting a *new* execution on an idle agent (task done →
  react; webhook → act). The event-driven-agent model. **Never automatic** — that is
  an unbounded-cost, runaway-loop footgun. A **wake policy** the adopter declares
  per `eventKind`, **gated** (debounce / dedupe / rate-limit), enqueuing a `send`.

**Capability:** a change-event *can* enqueue an execution. **Opinion:** nothing wakes
by default; the adopter opts specific kinds in with a rate guard.

## The unification — four routings of one change-event

```
harness mutation → onChange(ChangeEvent)          [Decision 1 — the primitive]
   ├─ StateDelta        → bus / wire               [ADR 73 — BUILT]
   ├─ AG-UI StepStarted/Finished → bus / wire      [ADR 73 — specced]
   ├─ EventEntry(kind:"event") → timeline (Domain) [this ADR — opt-in, curated]
   └─ wake policy       → enqueue send             [this ADR — opt-in, gated]
```

One primitive; four policies. The timeline projection and wake are not new
subsystems — they are sinks on the same push stream that already powers the wire
projections.

## Capability vs opinion (the whole posture in one table)

| Concern | Capability (firm) | Default opinion (overridable) |
| --- | --- | --- |
| Reactivity | `onChange` typed change-event exists | — (mechanism) |
| Event archetype | `kind:"event"` entries; no `role` | — (structural) |
| Rendering | events render via `renderedWith: FormatterRef` | `<event kind source at>` XML → `user` role |
| Timestamps | entries may carry `timestamp` | events include one; messages: adopter's call |
| Timeline population | change-events *can* project | per-kind: outcomes ON, churn OFF/coalesced |
| Loop triggering | a change-event *can* enqueue a run | nothing wakes by default; per-kind + gated |

## Rejected

- **Keep `role:"event"`.** Category error (a role is a speaker); forces adapters to
  answer an unanswerable "what voice?" Fixed by the `kind` axis.
- **Auto-project every harness change into the timeline.** ES-bloat (ADR 49);
  current-state churn is rendered, not logged. Curated opt-in instead.
- **`developer` role as the default event carrier.** Non-portable (OpenAI-only;
  Anthropic/Google can't intersperse it) and semantically "instructions," not "a
  fact." `user` + envelope is the portable default; `developer` an opt-in nicety.
- **Bake the `<event>` tag into the entry.** Couples the domain log to one wire
  format. The entry is semantic; the envelope is formatter output.
- **Freeze rendered strings in the entry.** ADR 49 wants outcomes, not rendered
  text — store `payload`, render via projection, keep re-projection open.
- **A `SystemEventHarness` / subsystem.** Events are routings of the change-event
  primitive; a subsystem would multiply what composition already covers.
- **Auto-wake on events.** Runaway-cost footgun; wake is explicit + gated.

## Open questions

1. **Coalescing shape for churn.** Net-change-at-execution-boundary vs a debounce
   window vs simply OFF. Lean: OFF by default, offer a boundary-coalesce opt-in;
   revisit when an adopter wants churn in the transcript.
2. **`ChangeEvent` for ordered collections.** Todos have order; does `ChangeEvent`
   need a `reorder`/index variant, or is order a value-shape detail? Lean: keep the
   three verbs; carry order in the value.
3. **Wake policy home.** Is the gated wake policy an `agentick.config.ts` concern
   (ADR 71), a per-harness option, or a dedicated `withWake({...})` extension? Lean:
   config-level with per-kind entries.
4. **Retrofit order.** Prove `onChange` on `state` first (dual-reactivity on the
   generic collection) then adopt in knobs/gates/todos, or land it on the new
   `TodosHarness` as the reference instance? Ties to the todos primitive decision.
5. **`source` provenance fidelity.** `"model" | "host" | "remote"` — enough, or do
   we need the acting principal (ADR 48 scope) on the event for multi-tenant audit?
6. **Compaction interplay.** Event outcomes compact like any entry; do any
   `eventKind`s deserve a "sticky / never-compact" hint (e.g. a safety-relevant
   host mutation)? Defer until a concrete need.

## References

- `docs/proposals/v2/blueprint/49-stores-not-snapshots.md` — three planes,
  outcomes-not-commands, the timeline as the ES log.
- `docs/proposals/v2/blueprint/73-ag-ui-projection.md` — StateDelta + steps, the
  first change-event routings.
- `packages-next/spec/src/data/entries.ts` — `MessageEntry` / `SectionEntry` +
  `renderedWith: FormatterRef` (the formatter seam this rides).
- `packages-next/spec/src/data/content-blocks.ts` — `MessageRole` (the `"event"`
  value this ADR removes).
- `packages-next/pubsub/src/keyed-notifier.ts` — the notifier gaining `onChange`.
