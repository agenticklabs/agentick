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

CLIENT-HALF projection ✅ LANDED (2026-08-24): a client tool's `summary`/`group`
now cross the wire. The gap was deeper than a stripping projection — the client
authoring type `Tool` (`tool-executor/src/client/create-tool.ts`) was a hand-written
PARALLEL of the wire contract that lacked the two fields entirely, and `toDeclaration`
was an allowlist that silently under-filled (optional fields → no compile error). Fix
made `ClientToolDeclaration` the single source of truth: `Tool` now
`extends Omit<ClientToolDeclaration, "inputSchema">` (inherits every serializable
field + any future one for free), and `toDeclaration` is STRUCTURAL
(destructure-out handler/inputSchema/annotations, spread the rest) so it is
exhaustive-by-construction. Server fold `toClientToolRegistration`
(`spec/protocol/tool-executor.ts:514-515`) already read both onto the internal
`ToolDeclaration` → `ToolInfo`, so it is now end-to-end for the CLIENT tools in the
45 (navigate*to, get_node_map, get_node_content, dom_act, render*\*). Regression pin
in `create-tool.spec.ts`. STILL PENDING: authoring the summaries/groups onto the
client declarations (the actual `TODO(canonical-summary)` content move) — the channel
is now open for it.

PROGRESSIVE-DISCLOSURE SPEC (Ryan, 2026-08-24) — the unifying principle across
catalogs is "structure in context, detail behind search," but the treatment
differs per catalog:

- TOOLS: names + GROUP-level summaries in context (capabilities known UPFRONT —
  tools matter most); descriptions + input/output schemas discovered lazily via
  tool_search/tool_docs. Names are ALWAYS complete — never hide that a capability
  exists, only its schema.
- RESOURCES: the tree, TOP 1-2 LEVELS + folder summaries in context; deeper
  levels + leaf detail lazily. (Iterating ALL resources is the bloat to kill.)
- SKILLS: flat NAME enumeration in context (skills are ~flat); descriptions lazy.
- PROMPTS: OUT of scope — invoked by another means, not model-catalog-surfaced.
- Each section must SIGNAL that the model should actively search for more.
  Shared mechanism = a tree-presenter (render to a depth/token budget, summaries at
  folders, names/counts at leaves) + a lazy-expand tool (search / list(path) /
  read), instantiated for tools, resources, skills — same shape as dom-map's
  node-map. This is Arc alpha; NEXT after Arc beta (capability-surfacing).

NEXT: knowify-side curation / keywords / embeddings; the app-side capabilities
SECTION; the dock's tree panel (which is what unblocks a `groups`
enumeration).

## Arc beta — surface existing ctx/harness capabilities as model-facing tools (Ryan, 2026-08-24)

Ryan's insight: "so many capabilities we can provide by just letting the model
access things on the tool-handler ctx / session harnesses." Items 3+4 of the
2026-08-24 wishlist MERGE into one arc — each is "wrap a capability that already
exists on ctx/harness as a model tool," not new machinery. Members, spawn/fork
first (Ryan: "not having a spawn/fork tool is a big loss"):

- SPAWN tool — new sub-agent session (machinery exists: SpawnInput, spawnPath,
  depth guard). Delegate multi-call work so the parent context stays clean.
- FORK tool — clone the CURRENT session's context into a child. THE design
  decision of this arc: what a fork clones (timeline? tools? memory scope? just
  system + task?). Likely greenfield vs spawn — confirm.
- message_session tool — deliver a message to another session by id (works for
  sub-agents too); the inter-session channel we use ourselves.
- timeline_search + list_sessions tools — ride D's session/search seam + the
  SessionStore list/query (status/root/parentSessionId filters).
- Big tool-results -> files (stream E) rides alongside: offload keeps context lean.
  Pairs with stream F (internal visibility): a sub-agent's intermediate blocks stay
  UNDELIVERED so delegation doesn't leak chatter into parent OR client context.
  Seam for all: the server tool-handler ctx (ADR-27 ToolHandlerCtxExtensions
  augmentation) + bundled-not-privileged tools (ADR 27). NEXT ACTION: map the
  existing ctx/harness surface, then design the tool shapes; fork semantics is the
  open decision.

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

## F. Internal visibility 🔨 STAMPING BUILT (uncommitted) · FILTERING DESIGNED (2026-08-25)

Executions / messages / blocks the client NEVER receives — undelivered, not
hidden. Full design: [`internal-visibility.md`](./internal-visibility.md).

STATE (2026-08-25):

- **Stamping phase — BUILT, uncommitted, reviewed.** Pure additive, ZERO behavior
  change (content carries `internal`; nothing acts on it yet). Doors: `createSession`
  / `send` / `spawn` / `fork` / tool (`annotations.internal`) / turn boundary /
  per-message — all fold `parent || own` and stamp at production (§§1–4). Runtime
  rail (`isInternal` / `currentExecutionInternal`), `SessionRecord.internal`,
  `TurnBoundaryEntry.internal`, `LoopToolResult.internal`. 6 e2e tests green (durable
  spine) + 4 todo (spawn/fork integration, streaming sink-wrap, tool_use block).
  Bus/journal stay whole. ~130 LOC across spec/session/loop-executor/app.
- **Filtering phase — DESIGNED, not built** (internal-visibility.md §5). Capability
  `PrincipalCapabilities { includeInternal }` resolved at `AuthSource` (layered:
  trusted-pole default true / explicit caps / `internal:read` scope sugar / else
  false) → pull doors (`history`/`list`/`get`/`search` take `includeInternal`) +
  push funnel redaction (`dispatchRequest` sink, per-connection). Undelivered, not
  hidden. Tests in §5.4 land with the build.

KNOWIFY-SIDE (split):

- **Author internal (produce):** use the knobs in `ernesto-v2` — mark the delegation
  injected-result `internal` (and/or `spawn({internal})` for machinery sub-agents),
  the debug/notify-team tool `internal`, background/system injections
  `send({internal})`. knowify decides what's machinery.
- **Grant visibility (deliver):** internal is KNOWIFY's machinery — hidden from ALL
  customers, INCLUDING `tenant-admin` (a privileged customer, NOT an internal
  viewer). Default hides from everyone (agentick default `includeInternal:false` for
  authed connections); knowify OVERRIDES only for KNOWIFY-INTERNAL viewers —
  `system-user` / support / an explicit debug session — via one role→`includeInternal`
  line in `assistant-api`'s `AuthSource`, or the `internal:read` scope issued to
  those. NOT tenant-admin. TODO(confirm assistant-api uses a real AuthSource vs the
  trusted/local pole — that's where the grant goes).

Key realization: `visibility` is already the `{ model × client }` 2×2 in enum
disguise (model / observer / log / **internal**=model-yes-client-no); `exposure`
is a separate reachability axis and stays separate. Split into two increments:

- **F-preliminary — STAMP THE SPINE (decision B, Ryan 2026-08-25):** a uniform
  `internal?: boolean` declaration knob at every spine level (createSession /
  send / tool / message / block), propagated by the invariant _each layer stamps
  its products_ (`effectiveInternal = inherited || own`; denormalize down; leaves
  self-describing; rides the `currentExecutionId` rail as `currentExecutionInternal`).
  ONE new persisted field (`SessionRecord.internal?`); everything else on existing
  carriers (message `visibility:"internal"`, block `metadata.internal`), no
  migration. Bus + journal stay WHOLE (truthful); interim delivery = client hides
  what it's told is internal (revert the exploratory server-side filters). The
  `visibility`→`audience` rename is deferred (uniform `internal` makes it mechanical).
- **F-edge — PRINCIPAL-GATED DELIVERY (deferred):** admin sees everything, normal
  client never receives internals. A finite capability bag resolved at the
  Authorizer → `{ includeInternal }` on store reads (pull) + per-connection funnel
  redaction (push). Lands on the stamp foundation with NO re-stamp. Anchor:
  `session.run()` for input-less internal turns.

First consumer: the delegation tools (async-delivery marks the injected completion
message `internal`).

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

- ~~Dock send default: flip onBusy 'queue' -> 'steer'~~ DONE 2026-08-24
  (knowify `4407fe6fa2`): steer is the panel default; the fold prefers the
  executionId-stamped copy so a steered message renders between the answers
  it interrupted (the echo-position wire race is dead). Header-per-message
  kept after design discussion (speaker-turn grammar beats execution
  grammar); Ryan may revisit the header wholesale later.

- In-prompt self-name: "You are Ernesto" (`identity.tsx:132`) vs the
  "Knowify AI" display title — behavior-changing; full rename / internal
  persona / hybrid.
- `scope-nodes-app-bus` fail-loud construction guard — proposed, undecided.

## Dropped (do not resurrect)

- Core-domain `GroupId` v4 mints (scheduling/allocations) — Ryan, 2026-08-24.

## Standing context

2026-08-25 — RATIFIED: conversation branches (ADR 100,
blueprint/100-conversation-branches.md). `branchOf {sessionId, messageId,
kind: reply|fork}` — explicit discriminator, never field combos; session
tree stays pure delegation; root = no parent AND not reply; reply
identity = replySessionId() derivation + create-or-resume (one thread
per message); fork mints fresh ids; client sugar session.reply()/fork();
timeline contract is the INVARIANT (prefix++own), adapters choose
copy-vs-stitch; same-principal source guard is load-bearing; naming law:
fork=conversation, spawn=work. Build sequenced after the clean next.155
cut. Knowify alignment: branch_kind column + ancestry audit (stitch only
when kind set). Spawns-as-tasks stays EXPLORATORY — both ledgers, not
ratified, falsifiable trigger recorded.

2026-08-25 — DEFERRED ARC (Ryan): CLIENT-SIDE HOOK SURFACE. Clients get
`hook({ onAfterSessionPersist })` with the SAME minted names as the server
— two species by origin: (a) server-originated ops project as
OBSERVER-ONLY hooks client-side (event-emitter style, no transforms — the
client is not a participant in the op); (b) CLIENT-INITIATED actions get a
full transforming hook cascade (a client send/append can be reshaped
before the wire). The op-event subscription is the interim mechanism; a
`sessionPersistEventQuery()` spec helper rides the next publish for name
parity. Trigger to build: a second client consumer wanting hook-shaped
observation (three-consumers rule).

2026-08-24 latest — persist-is-a-command + steer default landed:
(1) agentick next.153: `session:persist` declared command — the earn
moment (first running / eager genesis) is journaled, hookable
(onBeforeSessionPersist veto = ephemeral-by-policy), terminal event
carries the record. SessionRuntime sheds the eager flag; public
session.persist(). Ratified over the rejected onRecordPersisted
callback: commands are the discoverable hook surface, no outliers.
(2) knowify `4407fe6fa2`: onBusy steer default + steer-safe fold (see
parked list). (3) `70f041c582`: client-tool declarations re-issue per
handshake epoch (reconnect had silently dropped ALL client tools).
OPEN NEXT: thread list consumes session:persist terminal events at
gateway scope (insert from payload, delete the get()+retry proxy);
TODO(window-id-dedup) — one entry id can appear twice in the client
window; assistant-api 18m suite + eslint OOM (diagnosed) still queued.

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
