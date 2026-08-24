# Backlog — the nine work streams

**Status:** LIVE WORKING DOCUMENT (opened 2026-08-24 from Ryan's two-stream
wishlist). This is the canonical board for the post-session-doors era: each
stream carries its scope, the framework/knowify split, ratified decisions,
and a NEXT ACTION. Update statuses here as arcs open and land — memory files
point at this doc, not the reverse.

Priority order (Ryan, 2026-08-24): **A+C first ("tools are most pressing" —
arc 1)**, then by opportunity. Sequencing rationale inline per stream.

---

## A. Context architecture — "the lay of the land" ✅ ARC 1 LANDED BOTH SIDES (2026-08-24 — framework next.150; knowify b656dfa6e5)

The model knows what it can do WITHOUT searching; it searches only for
specifics. "Rules and conventions drive success."

- Tool `summary` (one sentence) + `group: readonly string[]` (a PATH — the
  tree is a set of paths, ScopeNodeRegistry-style; recursion exists only at
  authoring: `createToolGroup.tools` accepts groups, flatten prefixes
  segments, the runtime stays flat; client tree view derives from paths;
  a `groups` sibling enumeration on list_tools deferred until the dock
  builds that panel) as canonical typed fields (the
  channel EXISTS: ToolAnnotations -> ToolInfo already crosses the wire; this
  is naming, not machinery). `createToolGroup({name, summary, tools})` sugar
  that tags members and flattens into `tools: []`.
- The capabilities SECTION (grouped summaries, categories, NO schemas,
  always in context) is APP-SIDE JSX; a framework `<Toolboxes/>` reference
  component only post-absorption.
- Per-principal visibility: NO framework — sessions are per-principal and
  the app recipe composes the tool set at session build; guards enforce at
  dispatch. Provider per-request subsets = adapter capability, later.
  LAW (cache): within a session the tools block may only APPEND.
  A projection-predicate seam only if within-session dynamism shows a
  third consumer.
- Same treatment for resources, prompts, skills — kill enumeration bloat.
- Knowify-side: curation, keywords, embeddings of description/summary/
  few-shot questions per tool.

Split: ONE small framework PR (fields + sugar) / knowify-led everything
else.

KNOWIFY LANDED (b656dfa6e5, pins on next.150): the toolbox tree —
~949 cached tokens in <System>, group prose + tool names only,
requires-pruned so the prompt never names an undeclared tool; bloat
killed with stated causes of death; 45 per-tool summaries AUTHORED,
unrendered — TODO(canonical-summary) moves them onto declarations
(one line per tool). REMAINING in A: that move; the
resources/prompts/skills half; naming decisions for Ryan (debug*info ->
notify_team; project_plan_create/\_update read singular but are bulk;
get_node_map/get_node_content/dom_act are implementation vocabulary;
list_items*\* heading-rescued). Framework issue #314: ctx.emit publishes
nothing (channelPublisher never supplied; wiring is per-session) —
notify_user shipped via the AppExtension workaround, TODO(ctx-emit).

LANDED: `ToolDeclaration.summary` + `.group` as FIRST-CLASS fields (not
annotations — the declaration is what the tool IS; `annotations.summary` would
have collided with `displaySummary`/`ToolPresentation.summary`), carried on
`ToolInfo` so `list()` and the wire see them. `createToolGroup({name, tools})`
in `@agentick/tool` — a group IS a flat array, nesting is nested arrays,
nothing group-shaped survives. Group-level `summary` RESTORED at the judge pass (Ryan's refinement made
group prose primary; one authored literal serves registration AND the
section), flatten-ignored. [superseded note: it was first omitted because the
`groups` enumeration that would consume it is still deferred, so the field
would be dead surface (`TODO(tool-groups)` marks it).

NEXT: knowify-side curation / keywords / embeddings; the app-side capabilities
SECTION; the dock's tree panel (which is what unblocks a `groups`
enumeration).

## B. Explicit completion — the done tool ✅ FRAMEWORK SEAMS LANDED (2026-08-24, pending publish)

Ratified 2026-08-24; precedent recorded (Vercel answer-tool, Cline
attempt_completion, SWE-agent submit, AutoGPT finish, OpenAI Agents SDK
stop-at-tools).

- **Canonical mechanism: `gates: [stopOnTools("done", "handoff")]`** — a
  shipped gate factory (gate:loop :: guard:operation). `terminal: true` /
  `stopOn` config are deferred sugar over it (three-consumers rule). Batch
  semantics: a parallel batch completes, then the turn ends.
- **Cache posture: the tools block is sacred prefix; volatile shape never
  enters it.** Done has a STABLE envelope schema (`{ result: unknown }`);
  the per-send shape renders at context BOTTOM (`<OutputContract/>`-style
  component) and is enforced by validation + re-ask in the tool's own
  dispatch. Provider-native constraint only as a cache-neutral adapter
  optimization.
- **Framework surface, exhaustively:** the `stopOnTools` gate factory;
  ctx/tree exposure of the send's bound `responseFormat`; per-tick
  dispatched-tools on gate ctx (verify whether absent); done tool +
  OutputContract ship BUNDLED-NOT-PRIVILEGED (explicit app inclusion, ADR 27
  posture). Loop core untouched. Apps implement `done` themselves.
- Convergence (later rungs): `responseFormat` compiles into done (its
  current text-parse path is the legacy this deletes, no-compat);
  `skills.run` output shape ditto; app output logic collapses on it.

LANDED: `stopOnTools(...names)` as a THIRD gate species (`StopGateDescriptor`
— no backing knob, no instructions, model-invisible, so the "host may
stop-force, the model may not" provenance rule survives). A deliberate stop
now reports `stopReason: "halted"` with `stopCause: { kind: "halted", reason:
"gate:done" }` — the reason string used to be dropped. Bound-schema exposure
landed on both existing seams: `useResponseFormat()` (render, via a seeded
`RenderContext` slot) and `ctx.responseFormat` (dispatch, via
`DispatchContext`). Per-tick dispatched tools needed NO new gate ctx — the
gate predicate already receives the settled `TickResult`, whose `toolResults`
IS the dispatched-and-settled set, which is also what makes "a parallel batch
completes first" fall out for free.

NEXT: the app builds `done` + `<OutputContract/>` on these seams. Sugar rungs
(`terminal: true` / `stopOn`) only after app-side proof — three-consumers
rule.

## C. Session tools — the model holds its own handles ✅ ARC 1 LANDED BOTH SIDES (2026-08-24 — framework next.150; knowify b656dfa6e5)

- `ask_user`: DONE (app-side, already shipped).
- Toast: it IS just a notification channel — a channel name + dock renderer
  - a model-facing `notify_user` tool publishing to it. Zero framework.
    Also the delivery surface stream G's scheduler/heartbeats will need.
- **`_summary` on tool_dispatch**: required, injected into every tool schema
  by the tool-executor (stripped before the handler), tool-defined inner
  field wins over the injected outer. PARALLEL-BATCH UX (leaning, not
  final): UI groups a batch under the model's PRECEDING TEXT block as
  header; fallback stacks the per-call summaries; an explicit
  `announce`-style tool only if narration proves unreliable (absorption
  rule). Ryan still kicking the parallel story around.

LANDED (`_summary`): it turned out to be already built — injection lives at
the PROJECTOR (`buildTools`), stripping in the executor before validation,
resolving into `ToolPresentation.narration`, with the `narrate` cascade as the
off-switch. This arc made it REQUIRED in the wire schema (free: the strip is
pre-validation, so `required` cannot fail a dispatch — it only makes the model
fill it in, and keeps the schema legal under provider strict modes). No second
`injectCallSummary` flag was added; `narrate` is the one switch.

NEXT: `notify_user` + the toast channel (zero framework). The parallel-batch UX
grouping is still Ryan's open question.

## D. Memory / search plane ⏸ DESIGN SKETCHED

- Cross-session history search: hierarchy **compactions (summaries) >
  episodic lessons > verbatim messages**; queries AND responses embedded.
- **Seam (sketched, Ryan: "minimal and optional, client-first, worth
  discussing")**: `SearchCapable { search(query, ctx) → hits{sessionId,
seq?, tier, score, snippet} }` feature-detected on stores; wire verb
  `session/search`, app-scoped and residency-free (needs NO session — like
  `list_sessions`, simpler than unmounted-sessions); principal-scoped via
  the record gate. Dock's search box = consumer #1. pgvector, embeddings,
  ranking: all knowify-side. Model-facing search tools ride the same seam
  later.
- **Fast prefetch model**: a small model does agentic memory/knowledge
  retrieval on user input to pre-populate the main model's context.
  UNDESIGNED.

NEXT: seam design discussion → then knowify embedding pipeline.

## E. Files plane ⏸ QUEUED

- Large tool results → stored files (durable big brother of
  `truncateToolResults`), referenced from context, readable back.
- Files readable INTO the code-execution environment; parsers (xlsx / csv →
  structured data) so a program consumes a spreadsheet and creates jobs
  directly. Anchors: `stored_objects`, media port, `code`/`code-host`.

NEXT: after arc 1; the xlsx→jobs story is the flagship demo.

## F. Internal visibility ⏸ QUEUED

Executions / messages / blocks the client NEVER receives — undelivered, not
hidden. Framework: a disposition on timeline entries + wire-projection
filtering. Extends "audience is always model; visibility + exposure are the
mechanisms" to the client direction. Anchor: `session.run()` for input-less
internal turns.

## G. Connectors ⏸ QUEUED (Slack polish first)

1. Slack cleanup/polish — it is proving the connector design.
2. **Scheduler connector** (pgboss-shaped, not necessarily pgboss): "do X
   for me every day at 8am." The no-brainer tie-in.
3. Heartbeats — proactive agent work (further out).
4. SMS, email (further out).

## H. Governance ⏸ QUEUED

Usage allotments: restrict access after the cap for a period; rate
limiting. Enforcement point: gateway guard/authorizer seam; records already
carry usage rollups.

## I. Hygiene 🧹 FILLER (schedulable anytime)

- Auto-title untitled chats ("Untitled"/absent) in reflection — tiny.
- Message steering/queueing UI affordances (ADR 53 surface in the dock).
- Legacy cleanup for other contributors; reduce clutter.
- **Finish the MCP-server migration; drop the old stuff completely.**

---

## Parked decisions (Ryan's, not work)

- Dock send default: flip onBusy 'queue' -> 'steer' (steer = same behavior
  plus barging in). Ryan leans steer; AFTER the create-on-open cleanup.

- In-prompt self-name: "You are Ernesto" (`identity.tsx:132`) vs the
  "Knowify AI" display title — behavior-changing; full rename / internal
  persona / hybrid.
- `scope-nodes-app-bus` fail-loud construction guard — proposed, undecided.

## Dropped (do not resurrect)

- Core-domain `GroupId` v4 mints (scheduling/allocations) — Ryan, 2026-08-24.

## Standing context

2026-08-24 later — first-send production hardening (knowify `1798ebb322`):
(1) framework next.152 threads the session's principal into every bridge
harness (`sessionScoped` third fact; timeline TODO(D-phase) resolved) so
store adapters attribute writes without a session-row join — fixed
"cannot attribute an append" on a fresh chat. (2) That woke the timeline
FK stub, exposing a true-simultaneity upsert race: an `(id)`-target
arbiter doesn't cover `uq_sessions_origin_id` — targetless ON CONFLICT
DO NOTHING on the sessions+executions stubs, retry-once in
KnowifySessionStore.put; red/green pinned. (3) Reflection: title is
REQUIRED while a thread is unnamed (trivial exchanges included), and an
empty-response settle still runs the pass while the title debt is open.
(4) Thread list: a LIVE status frame for an unknown session fetches the
row (`ThreadListSource.get` → session/get) and inserts it on top;
reflection titles carry onto the row via retitle(). Suites: knowify-app
440, adapters 21+27, reflection 11. eslint OOM root cause recorded
(parserOptions.project = whole monorepo, zero typed rules enabled —
3-line deletion or oxlint, Ryan's call); assistant-api 18m suite still
suspect, unaddressed by Ryan's order.

2026-08-24 LANDED — knowify rip-out COMPLETE (knowify `3416927a25`,
pushed): draft model deleted wholesale (catalogs/conversationPalette/
openDraft/materialize + specs + DI token), sessionPalette folds the LIVE
session's catalogs, README rewritten to the new contract,
new-session-lifecycle-e2e.spec.ts pins it over the REAL gateway. The
contract spec caught a FOURTH eager layer: `toCreateSessionInput`
(ernesto-v2 app.ts) forced `eager: true` on every host+wire create —
deleted; CreateErnestoSessionArgs gained an explicit `eager?`
passthrough (imports/seeds). Suites: ernesto-v2 522/522,
ernesto-client 225/225, knowify-app 433/433. Traps hit: stale
`libs/*/dist` (nx resolves dist, rebuild before trusting a spec run);
pathspec `git stash push` on already-committed paths NO-OPS and the
later `pop` grabs someone else's stash. Pre-existing, not mine:
`developers-sdk` TS4114s; ernesto-client:lint OOMs because
eslint.config.js sets `parserOptions.project: ['./tsconfig.json']`
(whole monorepo as one program) while ZERO enabled rules are
type-aware — 3-line deletion or oxlint, Ryan's call.

2026-08-24 earlier — DESIGN CORRECTION: create early, persist late.
Ryan rejected the client-draft model AND its catalog-cache workaround.
Framework next.151: SessionRuntime.durable — the record is EARNED
(first running transition / eager / adoption); teardown of a
never-persisted session writes nothing (evict/shutdown/close). New chat
= create_session on open: live, fully capable, per-principal, no row
until first send; declarations run at open so the first-turn race is
DEAD without a framework door. Knowify rip-out in flight (delete
catalogs/conversationPalette/openDraft machinery; contract respec'd).
#312 SHRINKS to the per-thread re-declaration optimization only.
session-doors Part II rewritten as this design with the detour
footnoted as superseded.

2026-08-24 late (SUPERSEDED by the above): draft-palette interim LANDED (knowify f4a81f8f3c) —
per-app CatalogCache + conversationPalette in ernesto-client (drafts:
zero wire traffic, cache-fed palette, local completion decline,
CREATE-ON-RUN ratified: a palette run takes app/create_session once,
memoized — running is intent). Cold start/hard reload = honestly empty
until #312 lands app-scoped catalog verbs + connection declarations —
#312 is the RECOMMENDED next framework arc (Ryan's promotion call
pending). draft-lifecycle-e2e.spec.ts is the contract file and the
migration harness for #312.

Everything through agentick 1.0.0-next.149 + knowify `e40a59705f` is landed:
session doors, ADR 102 stages 1–3, shutdown-hibernates + heal migrations,
single-flight resumes, refused-send unwind (#313), InterceptorLayers,
ernesto-v2 refactor takeover ("Knowify AI" title). Open framework issues:
#312 (connection-scoped declarations — the draft-first-turn race). Deferred
with triggers: unmounted sessions (session-doors §12 + declarative store
binding), ADR 102 stage 4 (arena), tree-per-bus-root.
