# Backlog — the nine work streams

**Status:** LIVE WORKING DOCUMENT (opened 2026-08-24 from Ryan's two-stream
wishlist). This is the canonical board for the post-session-doors era: each
stream carries its scope, the framework/knowify split, ratified decisions,
and a NEXT ACTION. Update statuses here as arcs open and land — memory files
point at this doc, not the reverse.

Priority order (Ryan, 2026-08-24): **A+C first ("tools are most pressing" —
arc 1)**, then by opportunity. Sequencing rationale inline per stream.

---

## A. Context architecture — "the lay of the land" 🔜 ARC 1

The model knows what it can do WITHOUT searching; it searches only for
specifics. "Rules and conventions drive success."

- Tool `summary` (one sentence) as first-class declaration metadata.
- **Toolboxes** — the grouping concept over tools.
- Projection split: capabilities + summaries + categories ALWAYS in context;
  **schemas on demand** (generalize knowify's `tool-search`/`tool_docs` into
  the principled mechanism).
- Same treatment for resources, prompts, skills — kill enumeration bloat.
- Knowify-side: curation, keywords, embeddings of description/summary/
  few-shot questions per tool.

Split: framework (declaration metadata + projection tiers) / knowify
(curation + embeddings). NEXT: arc-1 brief.

## B. Explicit completion — the done tool ✅ DESIGN RATIFIED, BUILD PENDING

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

NEXT: the two seams (gate factory + exposure) fold into arc 1; sugar rungs
after app-side proof.

## C. Session tools — the model holds its own handles 🔜 ARC 1

- `ask_user`: framework-provided tool EXPOSED by the elicitation package,
  explicitly included by apps (bundled-not-privileged).
- Agent callout / toast: knowify channel + dock rendering.
- **`_summary` on tool_dispatch**: required, injected into every tool schema
  by the tool-executor (stripped before the handler), tool-defined inner
  field wins over the injected outer. PARALLEL-BATCH UX (leaning, not
  final): UI groups a batch under the model's PRECEDING TEXT block as
  header; fallback stacks the per-call summaries; an explicit
  `announce`-style tool only if narration proves unreliable (absorption
  rule). Ryan still kicking the parallel story around.

NEXT: arc-1 brief (with A).

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

- In-prompt self-name: "You are Ernesto" (`identity.tsx:132`) vs the
  "Knowify AI" display title — behavior-changing; full rename / internal
  persona / hybrid.
- `scope-nodes-app-bus` fail-loud construction guard — proposed, undecided.

## Dropped (do not resurrect)

- Core-domain `GroupId` v4 mints (scheduling/allocations) — Ryan, 2026-08-24.

## Standing context

Everything through agentick 1.0.0-next.149 + knowify `e40a59705f` is landed:
session doors, ADR 102 stages 1–3, shutdown-hibernates + heal migrations,
single-flight resumes, refused-send unwind (#313), InterceptorLayers,
ernesto-v2 refactor takeover ("Knowify AI" title). Open framework issues:
#312 (connection-scoped declarations — the draft-first-turn race). Deferred
with triggers: unmounted sessions (session-doors §12 + declarative store
binding), ADR 102 stage 4 (arena), tree-per-bus-root.
