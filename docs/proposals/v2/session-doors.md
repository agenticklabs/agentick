# Session doors — existence is commanded, residency is taken

**Status:** PROPOSED (2026-08-23; revised same day). The first draft built a
parallel "cold read plane"; review judged it tacked-on and the brainstorm that
followed found the smaller true design: fix the _doors_, defer the residency
optimization until it has a consumer. The unmounted-session design survives as
deferred work (§12) with its prerequisite named. Companion to
[`checkpointing.md`](./checkpointing.md), whose eviction/rebuild machinery
this routing finally exercises as designed.

**Thesis — existence follows intent; residency is the framework's business.**
Nothing should exist durably because someone _looked_ or _drafted_: creation
happens on the first send. And nothing about residency (mounted vs evicted)
is client vocabulary: the client speaks existence and interaction verbs
(`get`, `history`, `subscribe`, `send`); **create and resume are doors the
framework walks through** because a verb required it — hooked, traced,
attributed — never called over the wire. Doors are taken, not called.

> **The residency invariant (aspirational end-state):** a live session tree
> exists iff a turn is running or recently ran. This build gets existence
> right and routes all traffic through honest doors; §12 is the deferred step
> that later makes _reads_ residency-free without any client-visible change.

## 0. The production evidence

- The dock materializes a session per thread **view** (`app/create_session`
  ensure-on-open — 14 views mounted 14 live trees in one browsing session;
  residency logs 2026-08-23 01:56–01:58).
- `resumeSession` is **unreachable in production**: ensure-create wins every
  race, so the resume door — where interruption detection and resume
  telemetry live — never fires. Create telemetry counts views, not
  creations (a dashboard trap).
- New chats create sessions (and, via title/meta writes, durable rows)
  before anything is sent — blank rows in `assistant.sessions`, defeating
  the runtime's own lazy-persist design (session-state.ts: "a 'new chat'
  that never sends stays off the durable registry"). The client hacks
  around the read surface, not choosing this.

Measured costs: evict 49–92ms, rebuild 60–150ms (cold pg read + mount),
live-hit 1–16ms. Rebuild-per-view is affordable; _lying telemetry and blank
rows are not_.

**The key discovery:** the runtime already distinguishes _existence_ from
_creation_. A mounted session with no durable record is real in every way —
registry, bus, harnesses, eviction — and the record is written lazily on the
first real status transition of a real turn. Evicting a never-interacted
session is a no-op persist plus dispose: it leaves no trace. The only thing
defeating this semantics is the client's ensure-create hack.

---

## Part I — The doors

### 1. Client vocabulary: four verbs, no residency

| Verb               | Meaning                                            | Residency effect                   |
| ------------------ | -------------------------------------------------- | ---------------------------------- |
| `session/get`      | read the durable record                            | NONE — never mounts or creates     |
| `timeline/history` | read a page of the log                             | resume door if cold; never creates |
| `sub/subscribe`    | observe session events                             | NONE — admitted by record (§4)     |
| `session/send`     | deliver input; **the one existence-creating verb** | live / resume door / create door   |

There is **no client-callable `resume`**. A verb whose meaning is
"no-op-or-not depending on server state the client cannot see" is not a
command, it is a hint — and a wire-callable resume would freeze residency
into the public API (clients would prefetch/keepalive with it, and reads
could never later become residency-free without breaking them). Programmatic
resume remains an in-process app API for hosts (`app.resumeSession`), e.g.
eager interrupted-session recovery at boot.

### 2. `session/get` — pure

A record read from the session store: id, title/meta, status, updatedAt.
Null (typed miss) for nonexistent. Already residency-free today; it gains no
side effects, ever. The dock renders thread headers and list state from it.

### 3. Door resolution — atomic, framework-owned

The door is resolved at the moment of need, atomically, inside the verb —
never as a client pre-step (a client `get → resume/create` dance is a TOCTOU
race by construction: the reaper or another device can interleave, so the
framework must resolve the door anyway; the dance would add round-trips and
remove nothing).

- **`session/send`**: live → deliver. Record exists → **resume door**
  (`app:resume-session` — interruption detection, hooks, telemetry) →
  deliver. Nothing → **create door** (`app:create-session`, §7) → deliver.
  The API is `openSession(ctx, sessionId, { create, appId, principal })` —
  `open(2)` semantics, `create` being `O_CREAT`. The ack carries
  `created: boolean` (cf. HTTP 201): the one existence fact a client may
  act on. Live-vs-remounted is residency and deliberately NOT on the wire
  — it lives on the `app:resume-session` span. ("Door" is this document's
  metaphor; identifiers name the concepts: open, create, resume.)
- **`timeline/history`**: live → serve. Record → resume door → serve.
  Nothing → 404. Reads never create; sends never 404.
- **Evict** stays framework-owned (sweep/LRU/manual through
  `app:evict-session`, unchanged).

**Tracing:** the door op is a child span of the verb that forced it —
`session/send → app:resume-session` vs `timeline/history →
app:resume-session`. The ledger distinguishes _looking_ from _talking_ from
day one, with zero new hook machinery: `onAppCreateSession` /
`onAppResumeSession` / `onAppEvictSession` are already minted declared-command
hooks; this build's job is routing production traffic through them and
deleting the path that bypasses them.

### 4. Subscriptions accept non-live AND nonexistent sessions

`sub/subscribe` currently 404s on anything not in the registry. Admission is
re-founded on the bus hierarchy — **authorize the attachment once (to the
scope); addresses within your scope may be speculative**:

- **Own scope, any address** — including evicted sessions and ids that do
  not exist yet (client-minted drafts): admitted. This is REQUIRED by the
  draft flow, not a convenience: the race-free client ordering is mint →
  subscribe (quiet) → send, with the pipe open before the create door emits
  tick-one events. Safety is topological, not checked: a session's events
  fan in through the bus of the principal it belongs to, so a speculative
  subscription either becomes yours when YOU materialize the id, or hears
  silence forever if someone else does. No admission re-check at
  materialization, no per-event filters (the bus-hierarchy rule).
- **Another principal's session** (shared visibility): the durable-record
  gate (`findRecordPrincipal`), as before.

**The receipt mechanism exists** — `onlyOwnedBy`
(`gateway/src/wire/subscriptions-extension.ts`): envelopes naming a
sessionId must carry a matching `scope.principal` stamp or are dropped at
delivery, and UNSTAMPED session envelopes fail closed (emitter stamping
landed in #304). It is documented as the #297 interim whose structural
end-state is bus-topology attachment. Two gaps this slice closes:

- The `session`/`session-tree` scope paths currently bypass `onlyOwnedBy`
  ("bounded by an id the caller named" — id-as-capability). Client-minted
  speculative ids invalidate that assumption, so the wrapper extends to
  those paths — which also hardens the existing path against id leakage.
- A nonexistent id names no app (`ownerApp` → null → 404 today).
  Speculative subscription resolves the app by the SAME rule as
  send-create-on-miss (§7): single-app default, explicit appId for
  multi-app, loud typed ambiguity error.

A subscription to a quiet or nonexistent session costs a map entry on the
wire connection — nothing session-side, nothing durable — and dies with the
connection or an explicit unsubscribe. Guard: a per-connection subscription
quota (speculative addresses are free to hold, not free in unbounded
number).

### 5. What dies

- The dock's ensure-create-on-view, and with it: blank rows, create-counts-
  views telemetry, and the dead resume door.
- `app/create_session` remains for hosts that genuinely want eager creation
  (imports, migrations, programmatic setup). It stops being a view path.

### 6. Known cost accepted (until §12)

Viewing still mounts (via history's resume door) and still genesis-hydrates
the full projection; the reaper collects it in the idle window. Two flags:

- **Reconnect stampede**: mount-on-read makes remount automatic — a server
  restart means every client's visible threads remount at once (hydration
  burst against pg). Bounded by visible-threads-per-client, self-healing
  within the idle window, and no worse than today's ensure-create.
- **Fat-thread open latency**: full hydration to serve one page. When this
  measurably hurts, it is the consumer that funds §12.

---

## Part II — Deferred materialization (no row until first send)

### 7. Drafts are client-side; send creates

A "new chat" is a client-local draft: the client mints the sessionId
(already legal — ids are client-suppliable) and renders an empty timeline
with NO server call. `list_sessions` elsewhere does not show it — correct:
it does not exist yet.

The first `send` to the nonexistent id takes the **create door** with that
id. The record is then written by lazy-persist on the first real status
transition — no blank-row window exists at all. The `session added`
enumeration notification fans out to every device (including the sender;
the ack's `created: true` confirms materialization without waiting on it).

App resolution for the miss case (a nonexistent id names no app):
(a) `SendParams.appId?` — the explicit form; the dock already knows its app
id (it names it in `app/create_session` today).
(b) Single-app-gateway default (ernesto's topology) — miss resolves to the
only app.
**Decision: both** — (b) zero-config, (a) explicit; ambiguous miss on a
multi-app gateway is a loud typed error, never a guess.

Authz: creation-by-send stamps the caller's principal exactly as
`app/create_session` does (same door-side identity plumbing).

---

## 8. Rollout

**Framework (slices, each gated on the full root suite):**

1. Door routing: `session/send` live/resume/create resolution (+ `appId` +
   single-app default + typed ambiguity error + `created` on the ack);
   `timeline/history` resume-on-record; `session/get` typed miss.
2. Subscription admission by record.

**knowify (after the framework publish):**

3. ernesto-client: thread-open drops ensure-create (get + history +
   subscribe); new-chat becomes a local draft; first send carries appId.
4. Delete the ensure-create hack + verify: `create` telemetry only on real
   creations, `resume` events appear with verb attribution, blank rows stop.

**Follow-through:** re-run the residency-debug observation session; then the
create-door unification (#311 `SessionRuntime.hydrate` capture) — sequenced
after, since this build decides which doors production uses.

## 9. Testing (every claim pinned)

- `get` on live / evicted / nonexistent: correct record or typed miss;
  registry unchanged in all three (never mounts, never creates).
- Send door matrix: live → `created:false`, no lifecycle op; evicted-with-
  record → resume fires (hook observed, span child of send) + `created:false`;
  nonexistent → create door fires + record written ONCE, no blank row
  before the turn; single-app default; multi-app ambiguity error.
- `history` on evicted-with-record: resume door fires attributed to
  history; on nonexistent: 404, registry unchanged. Reads never create;
  sends never 404.
- Subscribe on evicted: admitted, quiet, flows after a send mounts.
- Draft-flow race pin (end-to-end): subscribe to a minted nonexistent id →
  silence → send → create door → events arrive on the PRE-EXISTING
  subscription with no gap. Cross-principal pin: a speculative subscription
  in scope A receives nothing when the id materializes under scope B.
- Regression: a never-sent draft leaves NOTHING server-side (no record, no
  registry entry, no store scopes).

## 10. Open questions (decide at build, not silently)

1. Draft-id collision: client-minted id already existing (another device's
   session) — first send RESUMES it. With ULIDs the accidental case is
   negligible and the adversarial case is authz-denied (record principal
   gate). If a consumer ever needs create-intent, its canonical shape is
   `open(2)`'s `O_EXCL`: `openSession(..., { create: true, exclusive: true })`
   → typed conflict when the id exists. Not built until demonstrated.
2. Should `get`'s typed miss be `null` payload or a typed NOT_FOUND error?
   Decide with the wire dialect (client ergonomics: null composes better
   with "render draft on miss").

---

## §12 (deferred) — Unmounted sessions: the residency-free read plane

Preserved from the brainstorm; **not built until a consumer arrives**
(measured browsing churn or fat-thread open latency — §6). The doors design
above is deliberately future-proof for it: residency never entered the wire
API, so this lands later as a pure internal optimization — `history` simply
stops taking the resume door, and `resume` telemetry purifies to
"conversation continued" with no client-visible change.

The design, condensed:

- **Residency is a grade, not a plane**: mounted (registry) / unmounted
  (record only — the same session minus the tree) / nonexistent. One
  implementation of every read verb — the declared command body — served by
  constructing the harness detached: every harness signs
  `(scopeId, journal, bus, inbox, options)`, all app substrate; compile,
  tree, loop, genesis are _mount_ costs. Per-request value, not a resident:
  no registry entry, no reaper — the only state worth caching between reads
  is a projection, and a retained projection IS residency (the rejected
  hibernate tier).
- **Three-way harness taxonomy**: store-backed session-scoped (timeline,
  state, knobs-values) get the grade; config-backed (prompts, skills,
  static resources) are app-answerable without any session; turn/loop/
  connection-backed (gates, elicitation, live, tool-executor's list, MCP
  dynamics) are mounted-only by nature. Declared per verb:
  `residency: "mounted" | "any"`, default mounted.
- **Emit yes, addressable no**: the facade gets an ephemeral fan-in child
  bus over the app bus (existing `LocalEventBus` parent mechanics — reads
  observable identically across grades, close-cascade cleanup) and a
  private throwaway inbox (nothing may _send to_ an unmounted session —
  receiving is conversing).
- **The unmounted surface is the declaratively-reachable surface**:
  namespaces reachable through the slot + app-scope store arm (which
  checkpointing already requires for durability) qualify — built-ins and
  extensions identically (ADR 27). Imperative-only installs don't.
- **PREREQUISITE — declarative store binding.** The found landmine: an
  imperative store override (`withX({store})`) makes the facade serve wrong
  data silently — the recipe is the only authority on which store a
  namespace uses, and the facade must never run the recipe. Resolution:
  store binding becomes a pure factory over session coordinates
  (`store: Store | ((coords: {sessionId, principal, metadata}) => Store)`)
  at the slot — tenant/geo routing preserved (the legitimate use), both
  grades resolve identically by purity; `withX`-as-extension stops carrying
  a store; the BYO live-instance hatch declares `overridesNamespace`
  statically on the extension object so the app marks that namespace
  mounted-only at construction — fail closed, wrong data unreachable.
  This reform (durable coordinates must be resolvable from outside the
  session) is independently good and lands with, or ahead of, this section.
