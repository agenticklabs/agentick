# Arena — the multiplayer layer, and the core seams that make it native

**Status: WORKSHOP DRAFT v2** — 2026-07-31, Ryan + Fable. Supersedes
the first pass (rooms.md), which designed multiplayer INTO the session
model. This pass inverts it per Ryan's correction: **agentick's current
model is preserved untouched; multiplayer is a layer on top —
`agentick-arena` — and core's only job is to be structured so that
layer is natively supported.** ⁇ marks open questions.

## 1. The conservation principle, and the two-layer thesis

The current model is good and stays: a session is one principal's
agentic conversation; send wakes the loop; harnesses compose per ADR 27. Nothing below changes that. The thesis:

> **Arena is an ordinary extension.** Membership, participation,
> presence, inbox — all of it ships as `@agentick/arena` (or a family),
> following the same per-harness pattern as sandbox or mcp: harness +
> augment + extension + wire extension + client surface + conformance.
> Core gains no room concept. A 1:1 session never executes a line of
> arena code.

This makes arena the **stress test of ADR 27**: if built-ins are truly
bundled-not-privileged, an entire communication layer must be buildable
as an extension — and every place it cannot be is, by definition, a
missing seam in core. The deliverable of this doc is therefore two
lists: the SMALL set of core seams arena needs (each justified
standalone, none mentioning arena in its contract), and the arena layer
that composes them.

## 2. What arena needs that core cannot currently express

Worked as the null hypothesis — for each, why existing facts don't
suffice:

1. **Who is acting, inside an operation.** The principal lives at the
   gateway boundary (boundary facets); operations deep in the spine
   don't reliably carry the acting principal. Arena's membership authz
   and per-entry attribution need "who" at the point of act.
2. **Per-operation session authorization.** The gateway's implicit
   rule is owner-only. There is no seam where a policy can say "this
   principal may send/subscribe/list on this session" — arena's
   membership IS such a policy, but core has nowhere to plug it.
3. **Append that never wakes the loop, over the wire.** In-process
   `timeline.append` exists; the wire conflates "add to conversation"
   with "run the agent" (`session/send`).
4. **Run a turn without new input.** The loop starts only from `send`
   (append + run, fused). Arena's participation logic needs "the agent
   takes a turn over the timeline as it stands" — no fused append.

Everything else arena needs, core already has: extensible per-entry
provenance (`MessageSource` keyed bag — arena augments
`source.arena = { memberId }` with zero core change), channels for
presence/typing, session meta + store queries, spawn/destroy lifecycle,
elicitation with the escalation address seam, journaling dispositions
for chatter, idle eviction for many-mostly-dormant sessions.

## 3. The core enablers (small, standalone, arena-blind)

Each of these is worth landing on its own merits; none names arena.

### 3.1 Principal on the operation context

The acting principal becomes a first-class ctx facet threaded the
whole spine (`ctx.principal`), populated at the wire boundary and
propagated like `ctx.log`/`ctx.trace` (the interceptor-facet pattern
already landed). Standalone justification: audit, telemetry, per-actor
guards, and multi-tenant attribution for ANY extension. This is the
existing "thread ctx into methods" design thread given its forcing
tenant. ⁇ shape: facet on `OperationCtx` vs `RuntimeContext`; whether
in-process (no wire) ops carry an app-declared system principal.

### 3.2 The session-operation guard

A verdict seam at the gateway's session routing:

```ts
// AppOptions / gateway config — seam over setting, guard vocabulary
authorizeSessionOp?: (ctx: {
  principal: Principal;
  sessionId: string;
  verb: string;            // "session/send", "sub/subscribe", ...
  record?: SessionRecord;  // when resolvable without opening
}) => Verdict;             // proceed | veto(reason)
```

Default = current behavior exactly (owner-only), so shipping it changes
nothing. Standalone justification: admin/support access, service
principals, read-only auditors — all pre-arena wants. Arena's
membership check is just one implementation of this callback. It is a
GUARD in the house vocabulary (operation admission), landing where
guards live.

### 3.3 `session/append` on the wire

The timeline harness's wire extension exposes append (authz through
3.2, journaled as a real command, `source` stamped with the acting
principal per 3.1). Standalone justification: importing history,
system/audit annotations, human-notes-on-a-session — append-without-
inference is a capability multiple non-arena consumers want. The
in-process verb exists; this is projection, not mechanism.

### 3.4 `session.run()` — a turn without new input

Split the fusion inside `send` (append, then run) and expose the second
half: execute one turn over the timeline as it stands. Standalone
justification: **regenerate** (the retry button re-running the last
turn honestly), **continue** (model stopped mid-thought), scheduled
turns (cron-shaped agents). Arena's participation orchestrator is just
another caller. ⁇ contract details: concurrency with an in-flight
execution (draft: refuse — one execution per session at a time, the
existing rule), and whether `run` accepts per-turn overrides the way
`send` does.

**That is the whole core ask: one ctx facet, one guard seam, one wire
projection, one verb split.** Each is small; none disturbs the 1:1
model; all four are independently schedulable.

## 4. The arena layer (`agentick-arena`)

An extension family in the standard per-harness layout, on top of the
four seams:

- **Membership harness** — `Member { principalId, role, display?,
joinedAt }`; add/remove/list; `session:channel:membership` topology
  notifications; its own store/index ("rooms for principal X" is
  arena's query, answered by arena's index — core's session store is
  not asked to learn it ⁇ or session-meta projection, decide at build).
  Supplies the `authorizeSessionOp` implementation: principal ∈
  members.
- **Participation orchestrator** — subscribes to timeline appends
  (existing subscription surface), evaluates each agent member's
  `Participation` verdict callback (`onMention` / `onAddress` /
  `always` / `never` shipped as flippable defaults; today's assistant
  ≡ a 2-member arena session on `always`), debounces bursts, and calls
  `session.run()`. The gate/stopWhen twin: gate = does the loop
  continue; participation = does the loop begin. Anti-loop floor: an
  agent's own appends never trigger another agent unless explicitly
  @mentioned.
- **Wire + client** — `arena/*` verbs via the standard wire-extension
  lane (members add/remove/list); presence/typing/receipt channels
  (bus-only disposition); per-member read cursors for the inbox
  (arena's store; served alongside the rooms list so unread counts are
  one query). Client surface derives from WireMethods rows as ever.
- **Compile-side default** — a timeline renderer labeling entries by
  member display name, provided by arena through the existing
  `<Timeline>` filter/render seam. A default, not a mechanism.

The proof obligation ships with it: arena's conformance suite runs the
UNMODIFIED 1:1 assistant composition and asserts byte-identical
behavior with arena installed-but-unused — the conservation principle
as a test, not a promise.

## 4b. v3 refinement — rooms are loop-less; agents participate through bridges

**(Ryan's connector insight, 2026-07-31 — supersedes §3.4/§4's
participation-orchestrator-in-the-room and the arena use of
`session.run()`.)**

The room is a **loop-less** conversation object — shared ground truth
(timeline + membership + channels), no model ever runs _in_ it. An
agent participant is an **ordinary, unchanged 1:1 session** whose
counterparty is the room, bound by a **bridge that is a connector**:
room events flow in as that session's input; replies flow back as
attributed room appends. `@agentick/connector` already means "external
event source feeding a session," and a room is such a source — which
makes SMS/email bridge members and agent members the SAME shape.
Everything is a connector into and out of the room.

What this fixes structurally rather than by rule:

1. **Compaction dissolves.** Room transcript and agent working memory
   are DIFFERENT timelines. The agent compacts/system-prompts/
   tool-calls in its own session; the room stays the humans' untouched
   record. Whose-context-wins stops being a question.
2. **Join-horizon privacy becomes auditable fact.** What the agent
   read is exactly what its bridge forwarded; the horizon is when
   forwarding started. Per-agent, inspectable.
3. **The send fusion becomes CORRECT.** The bridge _sends_ to the
   agent session — room activity genuinely is that session's input.
   Participation collapses into the bridge's **delivery policy** (when
   to forward a batch is when the agent speaks; debounce is natively
   batching). `session.run()` exits the arena path (it remains E1-
   worthy standalone: regenerate/continue).
4. **Multi-agent gets cheap.** Each agent is a full session — own
   model/tools/knobs/eviction; agents don't know each other;
   arbitration lives in bridges.

The unification: a room is IMPLEMENTED as a membership-session with no
loop configured — the "separate-but-equal derivative" and the "session
profile" are one object seen from two ends. E1 therefore reduces to
seams 3.1–3.3 (principal, guard, wire append) — still required for the
HUMAN half. The client needs no wrapper: the wire-extension model
already makes every client a superset per installed extension (arena
adds an `arena/*` namespace to the same derived client, as knobs and
completions did); agent sessions are headless — their "client" IS the
bridge.

Costs to price honestly: **transcript duplication** (room speech is
copied into each agent session as forwarded input — token/storage
cost; mitigated by the agent's own compaction, and arguably the point:
that copy is its working memory) and **echo suppression** (a bridge
never forwards an agent its own words — must be a pinned invariant or
two agents resonate). ⁇ how a bridge attributes multi-human batches in
the agent session's input (draft: one forwarded message per batch,
speaker-labeled inline, source.arena carrying the room ref).

## 5. Adjacent wire work this rides on

`app/destroy_session` + `gateway/destroy_session` (**landed 2026-07-31** —
transitive: aborts the live spawn subtree, reaps detached tasks,
deletes the record; the gateway twin resolves the owning app so a
session id needs no app id beside it);
`gateway/list_sessions` / `app/list_sessions` — cursor-paginated,
principal-scoped, records carrying meta — which the Knowify
conversations panel wants regardless of arena, and which arena's rooms
list rides with its membership/unread projections layered on.

## 6. Pathways

- **E1 (core): the four enablers**, each its own slice with its own
  standalone tests: principal facet → session-op guard → wire append →
  `session.run()`. E1 is worth landing even if arena never ships —
  that is what "standalone justification" means, and it is the test of
  whether this doc is honest.
- **A1 (arena): plural writers.** Membership harness + guard impl +
  append + stamping. Conformance is the customer; zero UI.
- **A2: the agent joins.** Participation + debounce + `run()`.
  Regression: the 1:1 assistant re-expressed as arena, byte-identical
  transcripts.
- **A3: liveness.** Presence/typing/receipts + read cursors + unread
  projection on the rooms list.
- **A4: the Knowify panel becomes rooms.** Rosters, human @mentions
  (pills exist), member-addressed dock asks.
- **A5: job rooms** and the product map (§8).

## 7. Roadblocks & speedbumps (carried from pass 1, arena-scoped)

- **Privacy vs compilable timeline** — the layer's biggest landmine:
  agent membership must be visible in-room, joining is an event, and
  the draft rule is a join-time compile horizon (an agent reads
  nothing from before it joined) — flippable per room, loud default.
- **Multi-agent arbitration** — the anti-loop floor above; anything
  richer waits for a tenant.
- **Compaction** — serves the agent's context only, never rewrites the
  durable timeline; humans always scroll real history. (Already true
  mechanically; restated as an arena invariant.)
- **Elicitation addressing** — asks gain a member address; generalizes
  ADR 69's ownership chain from "the user" to "a member ref". Touches
  dock/tasks/MCP projection; scheduled with A2/A3, not before.
- **Cost** — an `always` agent in a busy room burns tokens; debounce
  is the mechanism, per-room budget knobs are the policy surface.
- Naming ("channel" is taken; framework says session + membership,
  products say room); entry roles stay protocol roles with identity in
  `source`; message edit/delete as tombstone entries (⁇ timeline edit
  semantics, needed by A4); typing throttled client-side; rate limits
  via the existing per-verb guard seam; cluster ordering via the
  existing session-affinity rule.

## 8. Opportunities the layering makes cheap

Unchanged in substance from pass 1, but now each lands as arena-or-app
code with core untouched: **job rooms** (a room per Knowify job — PM,
foreman, subs, Ernesto; entity pills, slash commands, dock forms, and
agent writes as native speech — the chat product Slack structurally
cannot be); **approvals as room speech** (member-addressed elicitation
IS an approval flow, provenance-stamped); **listener agents**
(`never` + subscription: summarizers, compliance, memory writers);
**scheduled coworkers** (participation verdicts on cron shapes;
standups); **broadcast rooms** (a role policy); **bridge members** (an
SMS/email bridge is a member whose client is a connector — a sub
without the app answers the foreman by text); **cross-room memory**
(recall scoped by principal, not session); and the composer/grammar
stack amortized across every room forever.

And one meta-opportunity: **E1 improves the framework for everyone
regardless of arena.** `ctx.principal` hardens audit and guards;
`authorizeSessionOp` unlocks admin/support access; `session/append`
unlocks import and annotation; `session.run()` unlocks regenerate and
continue. If arena never ships, E1 still pays rent — which is exactly
the shape a layer-enabling core change should have.

## 9. Verification posture

E1: each enabler with standalone tests + the default-behavior
regression (guard defaults to owner-only; send still append+run).
A1/A2: the conservation suite (unmodified 1:1 composition,
byte-identical with arena installed-but-unused; the assistant
re-expressed as arena with identical transcripts), non-member refusal
across every verb, the participation matrix, the two-agent no-loop
rule as a test. §8 stays out of prose until each tenant exists.
