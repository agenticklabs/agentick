# ADR 100 — Session branching: `from` + `internal` (rev 2)

**Status:** Ratified · 2026-08-27 (workshopped across three sessions, Ryan) ·
supersedes rev 1, its provenance amendment, and the "Open revision" draft in
full — the two-edge taxonomy (`branchOf`/`parentSessionId`/`kind`), derived
reply ids, and the `thread`/`peer`/`class` enums are all dead; the ledger at
the bottom records why.
**Builds on:** Backlog F (internal visibility — `docs/proposals/v2/internal-visibility.md`),
C2 fork machinery (checkpointing §5 — snapshot + branch fan-out + restore),
ADR 48 (principal descent), ADR 49 (create-or-resume), ADR 51 (invocation),
ADR 92 §4 (`session:spawn`), `session:persist` (create early, persist late)
**Sequencing:** Phase 0 now (reconcile + this bake); Phase 1 builds after
Backlog F completes and the clean next.155 cut — ships as next.156.

## The model

Sessions relate through **one edge** and **one disposition**. Everything else
— "conversation", "worker", "thread", "fork", "reply" — is README vocabulary,
derived, stored nowhere.

```ts
// the floor — the complete stored delta of this feature is the `from` bag
internal: boolean        // Backlog F's axis — true: plumbing, false: principal-facing

from?: {                 // absent ⇒ root
  sessionId: string      // spawned from
  entryId: string        // at this timeline entry
  seq: number            // the entry's position — resolved once at genesis
  inherited: boolean     // took the state (C2 branch fan-out — timeline, knobs, state)
  anchored: boolean      // stays at the entry it came from
}

// creator = origin stamps (originExecutionId / originCallId), present iff an
// execution made it. Existing; unchanged.
```

`inherited` and `anchored` are the same category of descriptor — birth-declared,
immutable adjectives about the branch's standing relationship to its origin:
what it carried away, and whether it left.

## Every case

|                                                                  | `internal` | `inherited` | `anchored` | origin stamps      |
| ---------------------------------------------------------------- | ---------- | ----------- | ---------- | ------------------ |
| root session                                                     | false      | —           | —          | —                  |
| `fork(e?)` — new direction                                       | false      | true        | false      | user: — / agent: ✓ |
| `reply(e)` — side-thread on an entry                             | false      | true        | **true**   | user: — / agent: ✓ |
| `spawn(agent)` — worker                                          | **true**   | false       | false      | ✓                  |
| `spawn(agent, { branch: e })` — worker continuing the transcript | **true**   | true        | false      | ✓                  |

Two late-arriving requirements fold in with zero new fields: user-vs-agent
creation is origin-stamp presence; "a message has one reply chain but many
branches" is a _button convention_ (chip present → open, absent → create),
exactly as Slack ships it — never a structural constraint, never a derived id.

## Verbs — symmetric on both poles

```ts
// SessionHarness (server: hosts, connectors, agents mid-turn) and the client
// handle carry the SAME verbs. The agent-side path stamps origin; the wire
// path cannot.
session.reply(entryId)              → create({ from: { sessionId: this.id, entryId, inherited: true,  anchored: true  } })
session.fork(entryId?)              → create({ from: { sessionId: this.id, entryId: entryId ?? tip, inherited: true, anchored: false } })
session.spawn(agent)                → create({ internal: true, from: { sessionId: this.id, entryId: tip, inherited: false, anchored: false } })  // + origin stamps, as today
session.spawn(agent, { branch: e }) → create({ internal: true, from: { sessionId: this.id, entryId: e, inherited: true,  anchored: false } })
session.branch(opts)                → the explicit form

// the one door underneath everything:
app.createSession({ sessionId, internal?, from? })
```

**Sugar is symmetric, the op is singular:** both poles' verbs lower to the one
`create_session` operation — hooks, journal, and the security guard live there
exactly once. The verbs are thin sugars, deliberately NOT ops (a sugar
envelope would double-wrap the create; same reasoning `abort()` is not an op).
Fresh ids everywhere; ids are strings; the framework mandates no format.

## Four laws

1. **State** — `inherited` ⇒ the child's store-backed scopes read as the
   source's up to `seq`, then its own. This IS the C2 branch fan-out (timeline
   - knobs + state), not a timeline-only copy: a forked conversation keeps its
     knob values. The store satisfies the _invariant_ its own way — the bundled
     store copies at genesis; a durable adapter may stitch at read.
2. **Lists** — the principal-facing list = `internal: false` and not
   `anchored`. Anchored sessions render under their anchor entry; internal
   sessions render nowhere. (This is Backlog F's deferred increment 2 — the
   principal-gated delivery edge — at session granularity. One law, owned
   there.)
3. **Persistence** — `internal: true` ⇒ row at genesis (lineage is not
   speculative); otherwise create early, persist late: no row until the first
   turn earns it via `session:persist`. An abandoned reply thread leaves
   nothing.
4. **Security** — the wire admits `from` only when the caller's principal owns
   `from.sessionId` (without this, `from` is a cross-tenant state read — the
   load-bearing line). `internal` dispositions follow Backlog F's door rules;
   origin stamps are never wire-settable — lineage is the edge's to assert.

**Forward door (recorded, not designed):** a windowed inheritance —
`sinceEntryId`/`sinceSeq` as an optional floor, absent = genesis — is additive:
law 1 gains a clause (`source[sinceSeq..seq]`), the stitcher gains an `AND`,
adapters a column. Nothing else reads how much was inherited. Timeline-only by
nature: knobs/state are snapshots as of the anchor, not sequences.

## Queries

```ts
list({ internal: false, anchored: false, principal }); // the conversation list
list({ from: X }); // the session graph — X's tree, one level, spawn points included
list({ from: X, internal: true, status: "running" }); // X's running workers
list({ from: X, anchored: true }); // threads hanging off X
list({ from: X, internal: false, anchored: false }); // forks of X
```

`SessionStoreQuery` grows the dims (`from`, `anchored`, `internal`); `root`'s
old meaning is subsumed by the first line. Adapters columnize the bag —
`from_session`, `from_seq`, `inherited`, `anchored`, `internal` — btree, never
jsonb-in-a-WHERE.

## Derived, never stored

```ts
relation(record); // "conversation" | "fork" | "reply" | "worker" | "forked-worker"
// a pure fold over internal + from, for lists, UI, logs
```

## Reconciliations (Phase 0 obligations)

1. **Backlog F** — `internal` is THEIR field; this ADR consumes it and
   contributes law 2+3 as its session-granularity semantics. Sync with the
   owning session before build: if the stamping phase's semantics diverge from
   "excluded from principal lists, eager at genesis", theirs win and the laws
   re-read against them.
2. **Existing `session.fork()` (C2)** — the worker-flavored same-image copy is
   absorbed as `spawn`'s plumbing (spawn + branch fan-out + restore). The name
   `fork` is re-minted as the conversation verb above. One word, one meaning,
   both poles. `ForkInput`/`SpawnInput` reshape accordingly.
3. **`parentSessionId` → `from`** — the widest sweep in the plan.
   Subordination consumers (abort-cascade, principal descent, spawnPath) keep
   their semantics: cascade walks the LIVE spawn registry as today (lifecycle
   was never a durable-record fact); the durable edge they read becomes
   `from.sessionId` where they read the record at all. Lands as its own commit
   with the unfiltered-grep ritual.

## Adopter alignment (knowify)

Storage half largely pre-built (`parent_id`, `branched_at_seq`,
ancestry-stitched reads, e2e-pinned). Alignment: one migration adding
`from_session`, `from_seq`, `inherited`, `anchored`, `internal` (mapping
existing `parent_id`/`branched_at_seq` data); `KnowifySessionStore` round-trips
the bag to columns; `KnowifySessionIndex` list predicates per law 2; the
stitcher re-keys to **stitch iff `inherited`** — which also retires the
ancestry-audit finding (v2 workers without inheritance no longer stitch the
parent's whole history). Slack `thread_ts` ↔ anchored-session mapping is the
optional tail. The panel UI (reply button = open-if-exists, thread chips, fork
gesture) blocks on Ryan's design spec — the arc's long pole.

## Plan

| Phase | What                                                                                                                                                                                                                                                     | When                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **0** | Backlog F sync · fork()/spawn reconciliation decision · this bake                                                                                                                                                                                        | now                                                   |
| **1** | Framework: spec (bag, dims, wire) → session (genesis fan-out, the `from` sweep, harness verbs) → app (doors) → gateway (guard) → client-core (verbs, `relation()`) → contract spec per law + conformance + adversarial pass. Agents per package, judged. | after Backlog F + clean .155 · ships .156 · ~2–3 days |
| **2** | Knowify: migration · store/index · stitcher · panel UI (blocked on design spec) · Slack tail                                                                                                                                                             | ~1–2 days + UI                                        |

**Risk register:** the `from` sweep (blast radius: spawn-hardening, resume,
destroy cascade, wire records, knowify `parent_id`) — own commit, own greps;
Backlog F semantic drift (Phase 0 sync closes it); the C2 absorption touching
`ForkInput` call sites.

## The ledger — killed in the workshop, with cause of death

- **Two-edge taxonomy + invariant 4** (rev 1) — fused edge-with-classification;
  the forked worker falsified the invariant.
- **`branchOf` / `kind: thread|peer` bag** — "thread" was never a kind of
  session; it's a kind of attachment (`anchored`).
- **`class: conversation|worker|thread`** — product words on the floor;
  collapsed into Backlog F's `internal` + `anchored`.
- **Derived reply ids** (`deriveReplyId`, uuidv5/v8) — solved a dedup race the
  reply button solves by reading the chip; identity-by-arithmetic traded
  simplicity for cleverness. Apps wanting hard rendezvous can mint
  deterministic ids themselves; ids are strings.
- **`kind: 'spawn'|'fork'|'reply'` enum** — one enum serving two readers;
  needed presence-combos for the overlap case.
- **`origin: "user"|"agent"` field** — redundant with origin-stamp presence;
  redundant pairs drift.
- **`threadKey`** — identity mechanism moonlighting as list posture.
- **Relations table** — structure for structure's sake at two edges; revisit
  at arena scale if edges multiply.
- **Spawns-surface-as-tasks** — still EXPLORATORY, unratified, both ledgers on
  the board; only its naming law survives here (`fork` = conversation,
  `spawn` = delegation, exclusively).
