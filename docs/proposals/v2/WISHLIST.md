# Wishlist — working docket

**Internal working doc.** Not an ADR, not a proposal, not published. This is the
running list of what we want next, in Ryan's words made precise. Items get added
as we go; nothing is removed, only moved to **Done** with the commit that did it.

**Numbering is creation order, not reading order.** `W<n>` is a stable handle —
new items keep the next number and get filed under whichever track they belong to,
so the numbers run out of sequence within a track. That is deliberate: a wishlist
item's id should never change because something was inserted above it. Read the
tracks; cite the numbers.

Each item states: **Want** (the intent, faithfully), **Why**, **Current state**
(what is actually true in the tree today, verified — not assumed), **Done when**,
and **Open** (the questions Ryan explicitly left open, preserved rather than
resolved by me).

Two repos are in play:

- **agentick** — `~/Documents/agentick`, branch `feat/v2`. The framework.
- **ernesto** — `~/Documents/work/knowify/nx-knowify`, branch `assistant-memory`.
  `libs/ernesto-v2` is the v2 harness. The app.

Every item is tagged **[framework]**, **[app]**, or **[both]**. The default is
**app** — per the React-style absorption rule, a pattern earns its way into the
framework by being well-worn in the application first.

---

## Track A — modality and context shape (near-term, buildable now)

### W1 · Image input modality on Gemini · [both]

**Want.** Image input works end-to-end on the Gemini path. If enabling it turns
out to be anything more than a `providerOptions` / declaration-level change, that
is itself the finding — it means we have built something wrong and the shape needs
fixing rather than working around.

**Why.** Users send screenshots. A harness that cannot read them is not a
harness for this product.

**Current state.** The capability is _declared_: `google-adapter.ts:262` sets
`media.image: ["base64", "url"]` with `urlSchemes: ["https","http","data","gs"]`,
and all four modalities route through the single `googlePartFromSource` path
(`:1065`). Ernesto resolves `{ type: "reference" }` sources to a provider-
appropriate form in `libs/ernesto-v2/src/apps/ernesto/media.ts` — `gs://`
passthrough for Google, base64 pull for others. So the declaration and the
projection both exist. **What is unverified is the live path**: whether an image
a user actually attaches survives upload → reference → projection → wire.

**Done when.** A real image sent through the running app reaches Gemini and is
described back correctly, and a round-trip capture shows the `inlineData` /
`fileData` part on the wire. Not a unit test — the adopter's entry point.

**Open.** Whether the blocker (if any) is in agentick, in `media.ts`, or upstream
in how the client attaches files. Measure before touching.

---

### W2 · Ernesto's own timeline component, with `<message-metadata>` · [app]

**Want.** A custom timeline component in `libs/ernesto-v2`, in the spirit of v1's
`libs/ernesto/src/context/timeline.tsx`. Its hard requirement: **every user
message carries a `<message-metadata>` content block as its FIRST content
block** — timestamp, device, possibly location, the page (application state) the
user is currently on, and whatever else earns a slot.

**Why.** The model is answering questions about a screen it cannot see. "What's
the status of this?" only resolves if the harness says which page _this_ is. And
temporal awareness ("yesterday", "last week") is unanswerable without a
timestamp on the turn.

**Current state.** v2's timeline is currently the framework default —
`<Timeline />` rendered twice in `apps/ernesto/agent/agent.tsx:162,171`, split
around the trailing user run. The app-level `timeline.ts` slot
(`apps/ernesto/timeline.ts`) supplies a store and a compaction fold, not a
rendering. So there is **no** per-message metadata today.

v1 had this and it is the reference implementation: `UserMessageMetadata` in
`libs/ernesto/src/context/timeline.tsx:183` rendered `<user-metadata>` on first
occurrence and `<user-metadata-updates>` with only the _changed_ fields
thereafter — a diff, to keep repeated metadata from flooding context. Worth
carrying forward; worth deciding deliberately, because a diff-based block and a
per-message-verbatim block have different cache behavior.

Also carry forward from v1, since both were learned the hard way:

- **assistant messages are always verbatim** — summarizing them corrupts
  in-context learning (the model starts emitting metadata strings where tool
  calls belong);
- **event messages are verbatim** — they are short, model-critical corrective
  signals, and collapsing one to `[system_event]` strips the instruction.

**Done when.** Every user message in the compiled context opens with a
`<message-metadata>` block; a test asserts it for the first _and_ subsequent user
turns; the page/state field reflects the live client state.

**Metadata-updates diff — consider, not required.** v1's changed-fields-only form
is a **token-bloat reduction** for metadata that has not moved since the previous
user message, and that is the only reason to want it. Worth considering; not a
requirement of this item. The full block on every user message is an acceptable
shipping state, and the diff can be layered on once we can see what the repetition
actually costs.

**Open.** Tag name (`<message-metadata>` as stated, vs v1's `<user-metadata>`).
Whether location is in scope at all.

---

### W3 · RAG context moves below the user's message, in XML · [app]

**Want.** Retrieved context stops sitting _above_ the timeline and moves to
**immediately following the user message that produced the query** — the message
whose text was used to search the corpus. It must be **XML-formatted with
unambiguous tag boundaries**, so the model can tell at a glance that this is
system-produced material offered as _potentially relevant information_, not
something the human said.

**Why.** Two problems with the current position. Provenance: a grounding turn
adjacent to a user turn can read as the user having said it. And association: if
several user messages arrive in a batch, "the context for your question" is only
unambiguous when it is attached to _that_ question.

**Current state.** `<RagContext />` renders between the two `<Timeline>` halves
(`agent/agent.tsx:163-170`) — i.e. after history, **before** this turn's user
messages. That position was chosen deliberately and the reasoning is worth
respecting rather than overwriting (`agent.tsx:138-161`):

1. **Prefix-cache stability** — grounding placed before the trailing user run
   does not move as the execution grows (tool call, tool result, per tick), so
   each tick's prompt is a strict extension of the last.
2. **Question-last** — the model reads what it knows, then what was asked.

Moving RAG below the user message trades (2) away, and possibly (1). That is a
real cost and the item should be built with eyes open — measure whether
instruction-following degrades.

There is already a trailhead for the mechanism: `rag-context.tsx` carries a
`TODO(adr-94)` noting the compiler now folds a nested `<Section>` into its
message, so the component could render _inside_ a `<User>` carrier and make the
association **explicit rather than positional**. That is exactly this item, and
`__tests__/grounding-placement.spec.tsx` already pins that the nested form works.
The nested form is probably the right build: it also removes the coupling where
`agent.tsx`'s child order silently decides correctness.

**Done when.** RAG hits render inside/immediately after the specific user message
they were retrieved for, wrapped in explicit XML tags with a stated contract
("this is retrieved reference material, may be irrelevant, was not said by the
user"), and a test pins both the position and the tagging.

**Open.** Whether the block goes _inside_ the user message (one turn carrying
question + evidence) or as a distinct turn immediately after it. Ryan's phrasing
("immediately following") permits either; the nested form is the cleaner
mechanism. Cache impact of the move — worth measuring, not assuming.

---

## Track B — context economics

### W4 · Long tool results live outside the context, behind a pointer · [both]

**Want.** Large tool results stop being pasted into the conversation. In their
place the model sees an **informative metadata block** — what the result is, how
big, what it contains — that **points at where the real content lives**: a file
or a database row the model can query. File is likely the better substrate. The
full content must be **reachable by tool**, and **properly searchable** without
loading the whole thing into context. KV-cache preservation is a first-class
constraint of the design, not an afterthought.

**Why.** One 200KB query result poisons every subsequent tick of the execution —
it is re-sent, re-charged, and re-read, forever. And it displaces the things that
actually matter.

**Current state.** v1 had the beginnings of this: blocks carried
`extractedToFile: true` and `originalSizeBytes`, and v1's timeline rendered them
as `[image: image/png, 1.2MB]` / `[toolname]: <edges> [full: 800KB]`
(`libs/ernesto/src/context/timeline.tsx:66-136`). So the _summary_ side existed.
What did not exist is the retrieval side — a tool to read back what was
extracted, and any way to search inside it.

**Done when.** A tool result over a threshold is written to a store, replaced in
context by a metadata block naming its handle, and the model can (a) fetch a
slice of it and (b) search within it, without the full body ever entering the
prompt. Cache behavior measured before and after.

**Open.** File vs database row (Ryan leans file). Where files live for a
multi-tenant hosted deployment. Whether the extraction threshold is per-tool,
per-model, or global. What "properly searchable" means concretely — grep, a
chunked embedding index, or both.

---

### W5 · Per-model preliminary compaction at cache expiry · [both] · _research_

**Want.** A per-model strategy for **preliminary context compaction**: when the
provider's cache window has **expired** — such that the next request would incur a
full cache _write_ anyway — take that already-paid-for moment to replace expensive
context (multimodal content in user and assistant messages, large tool results,
etc.) with summarized blocks.

**Why.** This is the observation that makes it interesting: rewriting context
normally costs you the cache. But once the cache has lapsed, the rewrite is
**free** — you are paying for a fresh write regardless. So the moment of expiry is
the one moment where aggressive compaction has no cache penalty. Compaction
policy should be scheduled against cache TTL rather than against token pressure
alone.

**Current state.** Ernesto compacts on a summarization fold
(`apps/ernesto/timeline.ts`), and it is not automatically triggered at all —
there is a live `TODO(ernesto-port)` noting that v1 self-fired at 0.7 utilization
with a 4-message floor, and that v2's `timeline.compact()` is host-invoked, so
**nothing fires today**. Cache TTL is not modelled anywhere.

**Done when.** We can state, per model, what the cache TTL is and how to observe
it; compaction can be triggered by cache-expiry rather than only by pressure; and
we have a measurement showing the token/cost delta. Explicitly experimental.

**Open.** Whether cache expiry is even observable per-provider (Anthropic
publishes a TTL; Google's implicit caching is less legible). Whether this
composes with W4 or subsumes part of it.

---

### W13 · Compaction has to actually RUN in Ernesto — pick the strategy · [app]

**Want.** Compaction is not firing in Ernesto and it has to. Settle the strategy:
**what triggers it, where the summary lives, and whether the fact of it becoming
visible to the model as an `event`-role message** ("conversation compacted, at
this time").

**Why.** This is the item under W5. Cache-expiry-scheduled compaction is an
optimization _of a thing that does not run at all right now_. Every long thread is
carrying its full history until the window fills.

The `event` message is worth building deliberately rather than skipping. Without
it, compaction is a silent amnesia — the model's own history changes shape between
turns with no marker explaining why, and it cannot reason about the gap ("I
summarized earlier context at 10:42; details before that are lossy"). With it, the
elision is a _fact in the transcript_ the model can cite and work around.

**Current state.**

- **The fold exists, the trigger does not.** `apps/ernesto/timeline.ts` supplies a
  `compact` fold — v1's prompt verbatim, a 4-message floor, best-effort failure
  handling — but it is invoked by `timeline.compact()`, which is host-driven. The
  file carries an explicit `TODO(ernesto-port)`: _"nothing fires automatically
  today."_ v1's threshold was **0.7 utilization with a 4-message floor**, self-fired
  from `useOnTickStart`.
- **Where it lives — Ryan's guess is right.** `SummaryEntity`
  (`apps/assistant-api/src/assistant/storage/entities/summary.entity.ts`) is the
  v1 home: `text`, `thread_id`, `until_interaction_id`, `starting_at`,
  `ending_at`, indexed `['thread_id','ending_at']`. It is already a _ranged_
  record — it knows which span it summarizes — which is exactly what a
  restart-safe compaction needs. `ThreadCompactionService` is the v2 accessor
  (`lib/thread-compaction.ts`, 67 lines) and `timeline.ts` already calls
  `threadCompaction.get/append`.
- **`until_interaction_id` is the friction.** It is an FK to `InteractionEntity`,
  a v1 domain object the agentick timeline has no equivalent of. The v2 path will
  need that column nullable, or a parallel cursor keyed on the agentick message
  seq. Worth resolving now rather than at write time.
- **The durable log is never rewritten.** `compact` returns a _projection_; the
  timeline rows stay intact. That is the right design (v1 replaced messages in
  context and kept its own summaries table) and it is what makes the `event`
  marker necessary — the projection is the only place the elision is visible.

**Does the message table support agentick roles, including `event`? — YES, and
it already stores them.** `messages.role` is `varchar(16)`, **not a Postgres
enum**, so no migration is needed for a new role value. And this is not
theoretical: `KnowifyTimelineStore` (`apps/assistant-api/src/v2/stores/
knowify-timeline-store.ts:88`) already writes `{ role: "event", source: "system",
isInternal: true }`. The one stale thing is the **TypeScript** enum —
`MessageRole` in `core/dto/v2/block-types.ts:116` is still `USER | ASSISTANT |
TOOL`, so it does not describe what the column actually holds. Widen the enum (or
stop typing the column with it); that is the whole of the work.

**Done when.** Compaction fires on a stated trigger without a human asking; the
summary persists to `summaries` and survives a process restart; an `event`
message records that it happened and when; and a long thread demonstrably stops
growing its prompt.

**Open.** The trigger — token utilization (v1's 0.7), cache expiry (W5), message
count, or a combination. Whether the `event` message is persisted to the timeline
or exists only in the projection (persisted is more honest, and it is what the
store already supports). What the event says: bare fact + timestamp, or a
one-line gist of what was folded. `until_interaction_id` resolution.

---

### W14 · Media service: optimize AND summarize on ingest · [app]

**Want.** Extend the media service beyond rescaling images: **LLM-optimize PDFs
too, if we can**, and — the more valuable half — **generate good summaries of the
content of images and documents at ingest**, stored alongside the asset. Those
summaries serve search, but the primary motivation is **preliminary compaction**:
when the original has to leave the context, the summary is what stands in for it.
**See:** https://github.com/firecrawl/pdf-inspector (useful?)

**Why.** This is the supply side of W5 and W4. Compaction can only replace a 4MB
image with something useful if something useful was written when the image
arrived — and ingest is the one moment when the full asset is in hand, the user
is not waiting on a token stream, and the work can be done once instead of on
every eviction. Summarize late and you are paying a vision call during a
latency-sensitive turn to describe an image you are about to drop.

It also makes images **searchable**, which they are not today at any price.

**Current state.** `apps/ernesto/media.ts` (311 lines) is a _projection_ layer —
it resolves `{ type: "reference" }` sources to provider-appropriate forms
(`gs://` passthrough for Google, base64 pull elsewhere) as an
`onModelGenerate` middleware, and deliberately never rewrites the timeline entry.
There is a `MediaEntity` in v1 storage. Nothing generates or stores a summary,
and nothing rescales on the v2 path as far as I have looked.

Note v1's timeline already _rendered_ the placeholder shape this would fill —
`[image: image/png, 1.2MB]` from `extractedToFile` / `originalSizeBytes`
(`libs/ernesto/src/context/timeline.tsx:66`). Today that placeholder says only how
big the thing was. With W14 it says what it _is_.

**Done when.** An uploaded image or PDF gets a stored summary at ingest; the
summary is retrievable by the asset's reference; compaction can substitute it for
the asset; and it participates in search.

**Open.** Which model does the summarizing (cheap vision model, presumably) and
what the prompt asks for — a description, an OCR transcript, extracted entities,
or all three. Whether "LLM-optimize PDFs" means downsampling embedded images,
text extraction, or page selection. Sync-at-upload vs queued. Cost per asset.

---

## Track C — the learning loop

### W6 · Episodic memory, written by the same model with the same eyes · [both]

**Want.** At the end of a run, **the model decides** whether anything is worth
persisting. Crucially, the _same model_ makes that call with the _same context_
that would have been rendered for **one more tick of the loop for that same
agent**. So the mechanism is: at execution completion, render the full context as
if for another tick, append **episodic-memory instructions at the bottom**, and
send it to the same model. Appending at the bottom is deliberate — it **preserves
the KV cache**, so the reflection pass is nearly free. The whole thing runs
**async, in the background**.

**Why.** Memory extraction done by a separate small model on a transcript is
working from a shadow of what happened — it never saw the grounding, the tool
results, the state. The agent that lived the execution is the only thing that
knows what mattered. And the "render one more tick" framing means we get that for
the price of a cache-hit continuation instead of a new prompt.

**Current state.** `libs/ernesto-v2/src/lib/memory.ts` is 39 lines; there is a
`remember` tool (`src/tools/remember.ts`) and a `recall` tool — i.e. memory today
is **deliberate**, model-initiated mid-run. There is no end-of-run reflection
pass. `lib/knowledge.ts` + `lib/embedding.ts` + `lib/vector-search.ts` are the
storage/retrieval substrate this would write into.

**Done when.** Execution completion triggers a background tick whose prompt is
the next-tick context plus a trailing instruction block; the model returns either
"nothing worth keeping" or one or more memories; they are persisted; and a
capture proves the request hit the prefix cache.

**Open.** Whether this is a framework primitive (an execution-complete hook that
can re-render and re-tick) or app code. It smells like a framework capability with
an app-authored instruction block — capability, not opinion. What "run" means
here: per execution, or per session-idle.

---

### W7 · Post-mortem judgement folded into the reflection pass · [app] · _research_

**Want.** Riding along with W6 — likely as part of the same episodic-memory
instruction block — a pass that judges **what went wrong, if anything**, and
**what change to the prompts / harness / memory / tooling would prevent it next
time**. A workflow, run as part of memory gathering.

**Why.** We are currently the only feedback loop the harness has: a failure
becomes an improvement only if Ryan notices it and files it. This makes the agent
its own reviewer, on the full context of the failure, at the moment it is
freshest.

**Current state.** Nothing. This is net-new and explicitly research.

**Done when.** Reflection output includes a structured critique with a proposed
change, routed somewhere a human reads it. Value is judged on whether the
suggestions are actionable, not on whether the pipeline runs.

**Open.** Whether critiques auto-file anywhere (W9's escalation channel is the
obvious target). Whether a bad self-critique can poison memory — likely wants a
separate store from episodic memory.

---

### W8 · Memory dedup by substance, and reinforcement-weighted ranking · [app]

**Want.** Two coupled mechanisms.

1. **Dedup before write.** A new or updated memory is first used as a **query
   against the existing memory/knowledge corpus** to determine whether it is a
   duplicate — **not merely verbatim, but in substance**. When it is, do not write
   a second copy: use a **reinforcement mechanism to boost the rank** of the
   existing memory, so repeated corroboration makes it weigh more heavily in
   retrieval.

2. **Retrieval scoring, closing the loop.** As part of the episodic-memory
   instructions, give the model a way to **score the RAG context it was given** in
   that interaction — rating the quality/usefulness of what was retrieved. Those
   scores feed the same weighting, so information that repeatedly proves useful
   rises and information that repeatedly proves noise sinks.

**Why.** Both halves attack the same failure: a memory corpus that grows
monotonically and ranks by embedding distance alone degrades. Duplicates crowd
out variety; nothing ever demotes a bad memory. Corroboration and usefulness are
the two signals we can actually harvest for free, and they are exactly the two
signals classical relevance feedback uses.

**Current state.** `lib/knowledge.ts` is the single collection (RAG deliberately
collapsed to one query and one ranking); `rag-context.tsx` fuses rankers with
reciprocal-rank fusion, `RRF_K = 60`. `lib/rag-analyzer.ts` (455 lines) exists
and should be read before designing this — it may already hold half the
machinery. There is no write-time dedup and no persisted per-item weight.

**Done when.** Writing a substantively-duplicate memory increments a weight
instead of creating a row; that weight participates in ranking; and the model can
emit per-hit quality scores that move it.

**Open.** What "substance duplicate" means operationally — a cosine threshold, a
model-judged call, or both. Whether the weight is a simple counter, a decayed
score, or something closer to real relevance feedback. Whether negative scores
can bury a memory permanently (they probably should not — decay, not delete).

---

## Track D — product surface

### W9 · `debug_info` — an escalation TOOL, routed by department · [app]

**Want.** `debug-info` becomes a **tool** in this system — not a content block
drained by the loop. The model calls it to escalate a problem it or the user hit
to human experts at Knowify. It escalates to a **department**, chosen from a
**fixed list** we define; a single call **may name more than one department**.
Each department routes to its own **Slack channel**.

**Why.** Right now a failure is silent unless the user complains. The agent knows
when it is stuck; it should be able to say so to someone who can fix it — and to
the _right_ someone, since "the assistant misread a job costing report" and "the
assistant crashed" belong to different teams.

Making it a tool rather than a block is the substantive change: a tool has a
declared schema, so the department enum is **enforced at the call site** rather
than parsed out of prose, and the model gets an explicit affordance it can be
instructed about. It is also testable and dispatchable.

**Current state.** The v1 precedent is
`apps/assistant-api/src/assistant/core/agent/v2/agent.base.ts:390` — the model
emitted a `DEBUG_INFO` block, and the loop drained those blocks into
`context.assistant.slackServices.debug.sendDebugMessage(...)`, stamped with env,
agent id, execution id, root execution id, user, and tenant. **That envelope is
right and should be carried over verbatim**; only the trigger changes.

**Shape.** Roughly: `departments: Department[]` (enum, min 1), a summary, a
severity, and free-text detail. The envelope is added by the harness, never by
the model — provenance the model can author is provenance you cannot trust.

**Done when.** The tool exists with an enumerated multi-select department arg, is
declared with guidance on when to use it, delivers to per-department Slack
channels, and carries the v1 identifying envelope.

**Open.** The department list itself. Rate limiting — an agent in a failure loop
must not page four teams fifty times. Whether the user is told an escalation
happened. Whether W7's self-critique output can call this tool (probably yes, and
that is most of W7's delivery mechanism).

---

### W10 · Tools annotatable as invisible to end users · [both]

**Want.** A way to annotate a tool as **not visible to end users**, with those
tools filtered out **on the front end, during the fold**. Accounts with
`@knowify.com` usernames may see them anyway. Who exactly gets to see them is a
decision for later — the mechanism comes first.

**Why.** Internal, diagnostic, and staff-only tools should not surface in a
customer's UI. This is a display concern, not a model concern — the model still
calls them.

**Current state.** Not investigated yet. Needs a look at how the client folds
tool calls for display (`libs/ui/src/components/chat/chat-tool-call`) and where a
per-tool annotation would ride. Note: the annotation must reach the client, which
means it rides the wire — so it is at least partly a framework question.

**Done when.** A tool can be marked, the mark reaches the client, and the default
fold hides it; staff accounts see it.

**Open.** Where the annotation lives (tool definition metadata? a client-side
allowlist?). The visibility policy itself — deliberately deferred. Whether
"invisible" also means the _result_ is hidden, or only the call.

---

### W11 · Search chat history · [app]

**Want.** A tool the model can use to **search chat history**. This implies all
user text message content is **vectorized/embedded** and that embedding stored
somewhere searchable.

**Why.** "What did we decide about the Henderson job?" is a question about the
conversation, and today the only history the model has is whatever survived
compaction.

**Current state.** Embedding infrastructure exists (`lib/embedding.ts`,
`lib/vector-search.ts`, `lib/knowledge.ts`), and the timeline is persisted in
Postgres via `KnowifyTimelineStore`. Nothing embeds message content today.

**Done when.** User messages are embedded on write, and a tool returns ranked
historical messages with enough handle to fetch the surrounding context (W12).

**Open.** **Where the embeddings live** — Ryan's own open question, verbatim.
Candidates: alongside the timeline rows, or as another projection into the
existing knowledge collection. The latter is tempting (one corpus, one ranking,
consistent with the RAG collapse) but conflates "things I know" with "things that
were said". Assistant messages too, or user only? Cross-session, or within a
thread?

---

### W12 · Fetch chat history · [app]

**Want.** A tool for **fetching** chat history: a single message by id, a
contiguous chunk of messages, messages in a time range, and so on.

**Why.** Search returns a hit; the hit is meaningless without its neighbours.
W11 and W12 are one capability split across two verbs — find, then read.

**Current state.** The timeline store has the data. No tool exposes it.

**Done when.** The tool supports by-id, by-range, and by-time-window, with a
bounded page size, and composes with W11's hits.

**Open.** Whether this should route through W4's out-of-context-content mechanism
so a large fetch does not blow the window it was meant to protect. Probably yes.

---

### W16 · Drop the CoT DOCK tenant from k-assistant-v3 · [app]

**Want.** Remove the chain-of-thought **dock-hosted** component **for now** — it
needs reworking and should not ship in its current form.

**Explicitly NOT in scope: reasoning blocks in the chat transcript.** Those stay.
`libs/ui/src/components/chat/chat-reasoning-block/` and its `chat-block-renderer`
mapping are wanted and are not touched by this item.

**Current state.** The dock (`k-assistant-dock`, `k-assistant-v3.component.ts:453`)
hosts four tenants:

| tenant                       | band              | what it is                                     |
| ---------------------------- | ----------------- | ---------------------------------------------- |
| `k-chat-tool-confirmation`   | ask, prec 20      | approve a tool call                            |
| `k-pending-dock`             | ask, prec 10      | pending asks / prompt args                     |
| **`k-execution-graph-dock`** | **ambient**       | **"what the agent is doing while it does it"** |
| `k-tasks-dock`               | ambient, prec −10 | background jobs still running                  |

The CoT tenant is **`k-execution-graph-dock`**
(`k-assistant-v3/execution-graph/`) — it is the only one of the four that
displays the agent's own process rather than an ask or a job board. Its own
docblock calls it _"the turn's machinery while it runs"_: a status line plus a
short list of calls, content-gated on `isExecuting`.

Removing it is a **one-tenant deletion from the template** — the dock is a
generic host that ranks whatever tenants are declared inside it, so dropping the
`<ng-template kaDockTenant [band]="band.ambient">` block removes it cleanly, and
the ambient band simply falls through to `k-tasks-dock`. The component directory
can stay for the rework.

One consequence worth naming: with the graph gone, the gap between send and first
token has **nothing** in the dock — its docblock argues that gap is exactly when a
person most wants a sign of life. Whatever replaces it needs to cover that, or the
composer does.

**Done when.** The ambient execution-graph tenant no longer renders; reasoning
blocks in the transcript are untouched; the dock still ranks correctly with three
tenants.

**What replaces it is W23**, and it is a different thing — see there.

---

### W23 · A REAL execution graph in the dock: sub-agents + long-running work · [app] · **needs discussion**

**Want.** An execution graph is **not** a chain-of-thought display, and the
current dock tenant conflates them. The thing worth a dock slot shows
**sub-executions (sub-agents)** and **long-running tasks** — the shape of the work
in flight, not the model's narration of it.

**Why the distinction is the whole item.** They answer different questions and
they belong in different places:

|          | chain of thought                      | execution graph                                              |
| -------- | ------------------------------------- | ------------------------------------------------------------ |
| answers  | _what is the model reasoning about_   | _what work exists, and where is it_                          |
| shape    | linear prose, per phase               | a **tree** — parent execution, spawned children, their tools |
| lifetime | the current tick                      | outlives the turn (a background task keeps running)          |
| home     | the **transcript**, in document order | the **dock**, because it is ambient and persistent           |

Reasoning is already correctly placed: `chat-reasoning-block`'s own docblock
argues the chain of thought **is the block order** — think, act, think, answer,
rendered in document order — so it needs no widget. That argument is right, and it
is precisely why it does not justify a dock tenant. What today's
`k-execution-graph-dock` actually draws is a status line plus a flat list of the
current turn's calls, gated on `isExecuting` and emptied when the turn settles.
That is a narration of one tick, in the slot where the _structure of the work_
should live.

**Current state.** Two ambient tenants exist and they split this space oddly:
`k-execution-graph-dock` (current turn's calls, dies with the turn) and
`k-tasks-dock` (background jobs, gated on a _running_ job). Ryan's ask puts
sub-agents and long-running tasks in **one** component — which suggests these two
should probably merge rather than sit as separate tenants ranked against each
other. There is also `k-chat-execution-graph`, a **transcript** component that
already draws the real tree — agent hierarchy, collapsible nodes, task
descriptions, nested children — as a post-hoc view of a finished interaction. Its
docblock explicitly says there is _"nothing to reuse between them but the
vocabulary."_ If the dock now wants the tree too, that claim needs re-testing:
the live and post-hoc views may want one model and two densities rather than two
components.

Framework-side, the data exists — spawned sessions and the tasks harness both
publish — but whether the client receives a _parent/child_ relationship it can
draw a tree from is unverified and is the first thing to check.

**DO NOT BUILD YET — this needs a design conversation.** Recorded so it is not
lost; W16 is still safe to do independently, since removing the current tenant
does not prejudge what replaces it.

**Open.**

- Do the execution graph and the tasks board **merge into one tenant**, or stay
  two? (Ryan's phrasing — sub-agents _and_ long-running tasks _in a component_ —
  reads as one.)
- Does the client already get parent→child execution relationships, or is that a
  framework gap?
- Does the live dock view share a model with `k-chat-execution-graph`'s transcript
  tree, or is the earlier "nothing to reuse" call still right?
- What survives a turn settling — a finished sub-agent, a completed task?
- A strip above the composer is a few dozen pixels. A tree does not obviously fit.
  Expandable? Overlay? A summary line that opens the full tree?

---

### W20 · A tool for executing model-written JavaScript · [app]

**Want.** A tool the model can call to run JavaScript it wrote.

**Why.** The general escape hatch. Anything the model can express as a
computation stops needing a bespoke tool — filtering, reshaping, arithmetic over
a result set, date math, ad-hoc joins across two query results. It converts a
long tail of "we should add a tool for X" into zero work. It also composes hard
with W4: if a large tool result lives outside the context behind a handle, code
is the natural way to _reduce_ it without pulling it back in.

**Current state.** Nothing. Note the framework has a `<Sandbox>` primitive and a
`sandbox` slot on the tool handler `ctx` (`ctx.sandbox?.get("primary")`), but
Ernesto declares `hasSandbox={false}` in `agent/agent.tsx:104` with a comment that
**no sandbox provider seam exists** — `glob`/`grep`/`read_file` are never
declared for that reason. So the framework-side affordance is real and the
provider behind it is not.

**This is the sharpest security item on the list and it should be treated that
way.** Executing model-authored code in a multi-tenant product is a
remote-code-execution surface by construction. The question is not "can we run
JS" — it is "what does the runtime have access to, and what happens when a
prompt-injected instruction inside a tool result writes the code." Non-negotiable:
no ambient network, no filesystem, no credentials, no tenant data except what is
explicitly passed in, hard CPU/memory/wall-clock caps, and the same authorization
boundary every other tool runs behind.

**Done when.** The model can run a bounded JS snippet against explicitly-passed
inputs and get a value back, inside an isolate with no ambient capability, with
limits enforced and a test that a malicious snippet cannot reach the host.

**Open.** Runtime: `node:vm`/isolated-vm in-process, a separate worker, or an
external sandbox service. Whether it implements agentick's `Sandbox` provider seam
(so `<Sandbox>` and `ctx.sandbox` light up) or is a plain tool — the seam is more
work and more reuse. What, if anything, is pre-bound in scope (probably: the
inputs, and nothing else). Whether results can be persisted for reuse across
calls.

---

### W21 · Put query-api's `AGENTS.md` primer into the model's context · [app]

**Want.** `apps/query-api/src/guides/AGENTS.md` — the query-api agent primer —
reaches the model's context.

**Why.** It is 181 lines of exactly the knowledge that makes the difference
between a correct answer and a confident wrong one, and it is knowledge the model
cannot derive. It is a domain dictionary written from real failures — "job →
`Projects`, always", "todo → `ListItems`, not `Tasks`", `Assets.LastServiced` is
unmaintained, prevailing-wage rates are in **dollars** while `HourlyRate` is in
cents. Nearly every line carries an HTML-comment provenance note naming the QA
session and the specific wrong answer that caused it. That is a corpus of
paid-for lessons sitting outside the prompt.

**Current state.** It exists and is maintained; it is not in Ernesto's context.

**Size is the whole problem.** 181 dense lines is a large, permanent addition to
every prompt. Three shapes, and I do not think it is obvious:

1. **Verbatim in the system prompt.** Simplest, and it is stable content so it
   sits inside the cached prefix — the marginal per-turn cost is a cache read, not
   a write. Cost is context _window_, not tokens billed at full rate.
2. **As a skill**, loaded when the model is about to query. Pays only when
   relevant; risks the model not knowing it needs it (the same "cannot ask for
   what you don't know you've forgotten" problem `rag-context.tsx` names as the
   reason retrieval exists alongside `recall`).
3. **Chunked into the knowledge corpus** and retrieved by W3's RAG. Wrong, I
   think: retrieval returns top-N, and this document's value is _coverage_ — the
   trap you did not retrieve is the one that bites.

My read: **(1)**, precisely because it is stable and therefore cache-friendly.
The primer's whole point is being present before the mistake.

**Done when.** The primer is in context, sourced from the file rather than copied
(it is actively maintained — a copy goes stale silently), and a query-shaped
regression that the primer covers now answers correctly.

**Open.** Which shape. Whether it belongs in the system prompt or as a grounding
section (system prompt: it is standing instruction, not a fact about the world).
How the file gets from `apps/query-api` to the Ernesto lib without a bad
dependency — build-time embed, a shared asset, or served by query-api. Whether
`libs/developers-sdk/AGENTS.md` and the root `AGENTS.md` deserve the same
treatment.

---

### W22 · Reconcile MCP server instructions with Ernesto's own context · [app]

**Want.** Make sure the Knowify MCP server's instructions and tool descriptions —
when connected **in-process** — do not **conflict with or duplicate** what Ernesto
already puts in context.

**Why.** Two authorities describing the same world to one model. Where they merely
duplicate, we pay tokens twice. Where they _disagree_, the model gets to pick, and
neither of us knows which it picked.

**Current state — the overlap is real and I can name it.**
`libs/mcp-v2/src/instructions.ts` builds `InitializeResult.instructions` as three
parts: `MCP_BASE_INSTRUCTIONS`, optional additional instructions, then
`userAndCompanyInfoText(user)`. Against Ernesto's tree:

| MCP instructions say                                        | Ernesto already renders                |
| ----------------------------------------------------------- | -------------------------------------- |
| user + company context block                                | `<UserContext />` — "# Current User"   |
| "Knowify is a project management platform for contractors…" | `<ErnestoIdentity />` in `<System>`    |
| lists `knowify://me`, `knowify://company`                   | `<Resources />` — the resource catalog |
| tenant scoping, UTC dates, beta/support note                | partly identity, partly nowhere        |

So the **user identity is stated twice from two sources**, the platform
description twice, and the resource list twice.

**This became newly visible, and that is why it is worth doing now.** MCP server
instructions were being _dropped_ until the recent fix that populates
`McpServerInfo.instructions` from `getInstructions()` and renders them under
`### <alias> — server instructions` via `<McpServers />`. Before that, the
duplication existed in principle and cost nothing because half of it never
reached the prompt. Now it does.

**The in-process case is what makes this tractable.** For a third-party MCP
server, its instructions are its own and we take them as given. For our own server
connected in-process we control both sides, so the fix is a real choice: one owner
per fact. My read is that **Ernesto owns identity and platform framing** (it has
richer sources and renders them anyway) and the **server owns only what is true of
the server** — its resource URIs, its tenant-scoping and date-handling contract,
its tool semantics. `buildInstructions` already takes an `additionalInstructions`
parameter and the user block is conditional, so this is likely configuration
rather than surgery.

**Done when.** A compiled context for an in-process connection states each fact
once, with a named owner; a test pins that the user identity appears exactly once.

**Open.** Whether the MCP server should emit _different_ instructions for
in-process vs remote connections (it is per-connection already, so it can). Tool
_descriptions_ — I have only checked instructions; the description overlap needs
its own read. Whether any of this should be an agentick-level concern (a
"suppress this server's instructions" knob on `<McpServers />`) or stays app
config.

---

### W17 · Model-proposed knowledge, at every scope, into human review · [app]

**Want.** The model can **propose knowledge** beyond a single user's memory:
knowledge for the **whole tenant**, and **global / platform / industry-wide**
knowledge. Those proposals do not take effect on write — they enter **human
review**. Eventually an agent does the preliminary review pass for us, and a human
confirms.

**Why.** The most valuable thing the assistant learns is almost never
user-specific. "This tenant always bills T&M on service work", "in this industry
retainage is 10%" — that is knowledge with leverage across every user who touches
it. But leverage cuts the other way too: a wrong global fact is wrong for
everyone, which is precisely why the write cannot be direct. Review is the price
of scope.

**Current state.** The tier model **already exists in storage** and is proven —
`SkillEntity` documents it explicitly: one table, three visibility tiers keyed by
nullable `tenant_id` / `user_id` (`(null,null)` = knowify-global,
`(tenant,null)` = tenant-wide, `(tenant,user)` = personal), most-specific-wins
shadowing resolved on read, a `scopes` jsonb filtering against kAuth claims.
`KnowledgeEntity` is indexed `['tenant_id','user_id']`, so it has the same bones.
What does **not** exist anywhere is a **proposal / review state** — nothing in
these tables distinguishes "written" from "proposed, pending approval".

**Done when.** A memory can be written at tenant/platform scope only via a
proposal; proposals are queryable by a reviewer; approval promotes the row to
live; rejection records why.

**Open — and this is Ryan's own question, unanswered: _where do the proposals
live?_** Three shapes, and I do not think it is obvious:

1. **A status column on the existing table** (`status: proposed | approved |
rejected`, reads filter to `approved`). Cheapest; no new entity; approval is an
   UPDATE. Risk: every read path must remember to filter, and one that forgets
   leaks unreviewed content.
2. **A separate `proposals` table**, promoted into the real table on approval.
   Safest — unreviewed content is _structurally_ unable to be retrieved, because
   it is not in the corpus. Costs a second entity and a promotion path.
3. **Weight zero** (composes with W8): proposals are written to the corpus with a
   weight that excludes them from ranking, and approval raises it. Elegant, and
   badly wrong if a weight is ever mis-read as "low quality" rather than
   "unapproved".

My read: **(2)**. The failure mode of (1) and (3) is _silent leakage of unreviewed
platform-wide content_, and that is the one failure that makes the whole feature
unshippable. But this is Ryan's call and the industry/global tier may change it.

Also open: whether "industry" is a fourth tier or a `scopes` value on the global
tier (the `scopes` jsonb suggests the latter and it would avoid a schema change).
Who reviews what — tenant admin for tenant scope, Knowify for platform.

---

### W25 · Global knowledge WITHOUT escalation, where the output space is closed · [app]

**Want.** Some verticals are narrow enough that the model can write **global**
(`tenantId = null`) knowledge with no human review. Navigation aliases are the
first: when the agent learns that "the jobs list" means `projects-client-manage`,
that fact is identical for every user in every tenant and should be written once,
globally.

**The test — and this is the point, because it generalises.** W17 requires review
because _arbitrary_ model-authored global facts have unbounded content and
unbounded blast radius. A navigation alias is not arbitrary: its target must be
one of the 126 state names we own, and we can validate it at write time. The
model cannot write anything harmful because it cannot write anything we did not
already define.

> **Safety comes from the bounded output space, not from human review.** A memory
> may be written global without escalation **iff** its content is a mapping into a
> closed set the harness owns, AND the harness validates the target at write time.

That names a family rather than a special case — **term → identifier mappings over
a closed identifier set**:

| vertical          | free side                  | closed side (validated) |
| ----------------- | -------------------------- | ----------------------- |
| navigation        | "the jobs list"            | the 126 sitemap states  |
| entity vocabulary | "todos", "tasks"           | known model names       |
| field aliases     | "the due date"             | schema columns          |
| report selection  | "how are we doing on jobs" | the ~10 report models   |

Everything the query-api primer (W21) is made of has this shape. What does NOT:
_"AfMan prefers EFT"_, _"retainage is 10%"_ — unbounded content, claims about the
world, no target to validate. Those stay behind W17's review.

**Current state.** The substrate is ready and the tool is the only wall.
`libs/knowledge/src/types.ts`: `tenantId?: string` — _"`undefined` means it
belongs to none — curated platform content every tenant can read"_ — and the
read prefilter is _"its `tenantId` is null (platform) OR equals the reader's"_, so
a platform doc reaches every tenant with no fan-out. What refuses is
`tools/remember.ts`, deliberately: _"Global scope is deliberately unreachable
here: platform knowledge is curated."_ Its default is narrower still — **`scope:
"user"`**, so today a learned fact lands in ONE person's private memory in ONE
tenant, and every other user rediscovers it independently.

Observed in a real trace: the memory _"'todos' and 'tasks' mean ListItems"_ — a
platform-wide vocabulary fact — stored per-user.

**Done when.** A harness-owned writer can persist a validated mapping at global
scope without going through `remember`; the navigation resolver both reads and
writes it; and a test proves an invalid target is rejected rather than stored.

**Open.** Whether this is a second tool (`learn_alias`, target-validated) or a
`scope: "global"` on `remember` gated by a validator the caller supplies —
the latter is one mechanism instead of two, but it puts the validator in the
adopter's hands. Whether global writes still get logged for after-the-fact human
audit (probably yes — cheap, and it is the only way to notice a validator that is
too loose). How a wrong-but-valid alias is retracted.

---

### W26 · Feedback controls on the last assistant message of every turn · [app]

**Want.** Bring the legacy feedback affordance forward into the v3 assistant:
thumbs / rating + an optional comment, shown on the **last assistant message of
every turn**.

**Why.** It is the only signal we have that is authored by the person who knows
whether the answer was right. Everything else on this list is the system
observing itself — W7 has the agent grade its own homework, and W8 infers quality
from whether retrieval got used. A human saying _"this was wrong"_ is
ground truth, and it is cheap to collect at the moment they notice.

It also feeds the rest of the learning track rather than sitting on its own:
a NEGATIVE rating is the trigger W7's post-mortem should actually run on (rather
than reflecting on every turn indiscriminately), and it is the honest scoring
signal W8's ranking wants.

**Current state.** Prior art is
`apps/knowify-app/app/src/ui/components/k-assistant/components/chat/feedback/`,
split into `feedback-controls` (the inline affordance) and `feedback-detail`
(the elaboration). The storage already exists and is richer than a thumb:
`FeedbackEntity` (`assistant-api/.../entities/feedback.entity.ts`) carries
`rating` (smallint), `comment` (text), `feedback_type`
(`POSITIVE | NEGATIVE | NEUTRAL | OTHER`) and `feedback_subtype`
(`CORRECT | INCORRECT | OTHER`), with nullable FKs to **block**, **message** AND
**interaction** — so it can attach at three granularities.

Nothing in `k-assistant-v3` renders it, and nothing on the v2 wire writes it.

**Done when.** The last assistant message of a settled turn carries the control;
a rating persists against that message; a comment is optional and does not block
the rating; and the row is queryable by message and by interaction.

**Open.** Which granularity v3 uses — the entity supports block / message /
interaction, and "last assistant message of the turn" suggests message, but a
turn with several assistant rows may want the interaction. Whether the ratings
project to the client for display ("you marked this unhelpful"). Whether a
NEGATIVE rating should _immediately_ trigger W7's post-mortem while the context
is still warm, which is the strongest argument for building W26 before W7.

---

### W18 · The AI portal · [app]

**Want.** The admin portal for Knowify's AI surface.

**Why.** W17 and W19 both terminate in "a human reviews this", and W9 terminates
in "a team sees this". None of those have a home. The portal is the home — it is
the _consumer_ of the review queues, not a separate feature.

**Current state.** `apps/ai-portal` **exists** in the workspace (alongside
`admin-portal`, `portal`, etc.) with a full Angular app scaffold. I have not read
what is in it.

**Done when.** Scoped separately — this is a track, not an item. First cut is
whatever W17/W19's review queue minimally needs.

**Open.** Everything. What is already built in `apps/ai-portal`. Whether it is
Knowify-staff-facing only, or tenant admins use it too (W19 implies tenant admins
approve tenant-scoped skills, which means either they get in here or there is a
second surface in the main app).

---

### W19 · Tools to author skills and prompts, scoped, with approval · [app]

**Want.** The agent gets tools to **create new skills and prompts**, scoped to a
**user**, a **tenant**, or the **platform** itself. Same review posture as
knowledge (W17): a skill authored **for a tenant** must be approved by an **admin
of that tenant**; a skill **for the platform** must be reviewed by a **Knowify
admin**. A skill for the authoring user needs no approval.

**Why.** This is the agent improving its own harness — the same instinct as W7,
with a durable artifact at the end instead of a suggestion. If the assistant works
out the right procedure for a recurring task, that procedure should become a skill
rather than being re-derived every time.

**Current state.** The **storage tier model is already built and documented** —
`SkillEntity`'s three tiers are exactly the three scopes wanted here, including
the `(tenant, user)` personal tier written by "session-originated
`skills:register`". So the personal-scope write path may already exist. There is a
`PromptEntity` and a `KnowifyPromptStore` / `KnowifySkillStore` pair in
`apps/assistant-api/src/v2/stores/`. Missing: the **authoring tools** exposed to
the model, and — as with W17 — **any notion of approval state**.

**Done when.** The model can author a skill or prompt at a named scope; personal
scope takes effect immediately; tenant and platform scope enter the appropriate
review queue; approval publishes.

**Open.** Whether skills/prompts/knowledge share ONE proposal mechanism or three.
They almost certainly should share one — same tiers, same reviewers, same
lifecycle — which argues for solving W17's "where do proposals live" **generically
across all three entity types** rather than per-entity. Worth deciding before
either is built. Also: can the agent _edit_ an existing approved skill, and does
that re-enter review?

---

## Track E — framework capabilities

### W15 · Custom stop sequences · [framework] · _deferred_

**Want.** agentick supports custom stop sequences.

**Why.** Every major provider exposes them and we do not surface them. They are
the cheapest possible control over generation shape — a structured-output or
sectioned-response pattern that would otherwise need parsing and retries.

**Current state.** Not investigated.

**Done when.** Stop sequences can be declared on the model/target and reach every
adapter that supports them, with the usual "declared but unsupported" handling
rather than a silent drop.

**Open.** Where they ride — model config, per-execution, or both. Explicitly
deferred; recorded so it is not lost.

---

## Sequencing

Rough order, cheapest-and-most-certain first:

1. **W16** (drop the CoT dock tenant) — minutes; one template block.
2. **W1** (image modality) — likely small, and it is blocking real usage.
3. **W22** (MCP vs Ernesto context overlap) — cheap, and it is _paying rent right
   now_ on every turn. Likely config, not surgery.
4. **W21** (AGENTS.md primer) — the highest answer-quality-per-token item here.
   Mostly a placement decision.
5. **W2** (timeline + `<message-metadata>`) — foundational; W3 lands on top of it,
   and the metadata block is what every later item wants.
6. **W13** (compaction actually runs) — threads grow unbounded _today_. Strictly
   before W5, which is an optimization of this.
7. **W3** (RAG placement + XML) — mechanism already proven by
   `grounding-placement.spec.tsx`; a positioning decision plus a wrapper.
8. **W9, W10, W12, W11** — product-surface tools, independently shippable. W9
   first: it is also the delivery channel for W7.
9. **W14** (media summaries at ingest) — the supply side for W4 and W5.
10. **W4** (tool results out of context) — needs design; touches the framework.
11. **W20** (JS execution) — deliberately _after_ W4, which is its best use case,
    and it needs a real security design rather than a quick isolate.
12. **W17 + W19 together**, with **W18** as their surface — do _not_ build these
    separately. They are one proposal/review mechanism over three entity types
    plus one portal that consumes it; solving them one at a time guarantees three
    incompatible review flows.
13. **W6 → W8 → W7** — the learning loop, in that order (a reflection pass has to
    exist before dedup or critique can attach to it).
14. **W5** — research, and it wants W13's trigger and W14's summaries first.
15. **W15** — deferred.

**Not sequenced — blocked on a conversation, not on effort:** **W23** (the real
execution graph). W16 clears the slot without prejudging what fills it, so the
discussion is not urgent, but nothing should be built into that slot until it
happens.

---

## Parked (still on the docket, not being worked now)

Carried from the previous session; unchanged in priority, deliberately
deferred behind this list:

- **Cluster (Redis) for the gateway** — deploy blocker when we deploy. Design is
  substantially built (ADR 35 substrate-wrapper model, ADR 38 DECIDED,
  `createGateway({ cluster })` real, cluster-redis brokerless). What is missing is
  a real two-process smoke test against real Redis; elicitation across instances
  is the sharpest case. First deliverable is the smoke test, **not** code. Open
  product question: rung (b) means sessions die with their node — what happens to
  an in-flight execution when an instance recycles?
- **Interceptor cascade audit** across every `*FactoryDeps` — four holes fixed;
  session's is **latent** (proved by `app-hooks-reach-session.spec.tsx` — the
  `createApp` path constructs `SessionHarness` directly and is fine). Structural
  fix outstanding.
- **Effect-to-the-edge audit** of remaining Promise roots on internal paths.
- **Dispatch-scope threading** into `ctx.elicitation` (raw), the
  `session:channel:task-status` publish, and `ctx.resource` (never measured).
- **`HarnessEdge<F>` adoption** across the protocols still declaring only the
  Promise facade; category 2 (raw-Operation harnesses) measured and needs a
  different fix than `fxProxy`.
- **ADR 95 remainder** — drop the three positional defaults, add the
  warn-don't-fill diagnostic, audit `skills`/`prompts`/`connectors`, project MCP
  prompts.
