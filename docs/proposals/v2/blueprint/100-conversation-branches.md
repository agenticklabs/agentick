# ADR 100 — Conversation branches: forks and reply threads (`branchOf`)

**Status:** Ratified · 2026-08-25 (design conversation, Ryan) · not yet built —
sequenced after the next clean publish cut
**Builds on:** ADR 48 (Layered isolation — principal descent), ADR 49
(create-or-resume), ADR 51 (Invocation & authorization), ADR 92 §4
(`session:spawn`), checkpointing §branch (`BranchCapable`), `session:persist`
(create early, persist late — the earn command)
**Touches:** `@agentick/spec` (`SessionRecord.branchOf`, `CreateSessionInput`,
wire params, `SessionFilter.root`, `replySessionId()`), `@agentick/session`
(genesis branch hydration), `@agentick/app` (create door threading),
`@agentick/gateway` (same-principal source guard), `@agentick/client-core`
(`SessionHandle.reply` / `.fork` sugar)
**Adopter alignment:** knowify's `sessions` schema already stores branches
(`parent_id` + `branched_at_seq`, ancestry-stitched reads); it gains a
`branch_kind` column and an ancestry audit (§8)

## Decision

A session can **branch** from a message in another session. The branch is a
real session — own id, own turns, the full machinery — whose timeline begins
as the source conversation up to the anchor message, then continues on its
own. One new record slot expresses it:

```ts
branchOf?: {
  readonly sessionId: string;   // the source conversation
  readonly messageId: string;   // the anchor message (resolved to seq at genesis)
  readonly kind: "reply" | "fork";
}
```

`kind` is an **explicit discriminator, never a field-combination signature**.
Reply and fork share the same anchor and the same mechanism; what differs is
declared product intent — subordination versus independence — and structure
cannot tell you intent. Encoding the distinction in presence-combinations
(`parent_id` set but `branchOf` absent, etc.) is the implicit-enum disease
this blueprint line has repeatedly paid to remove; it does not come back here.

## The taxonomy — two edges, three relations

| Relation                   | Encoding                                              | List posture                           | Isolation                                           |
| -------------------------- | ----------------------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| **Delegation** (sub-agent) | `parentSessionId` + origin edges; never `branchOf`    | hidden (`root: true` excludes)         | child of the parent's bus/scope; principal descends |
| **Fork**                   | `branchOf { …, kind: "fork" }`; no `parentSessionId`  | its own root row                       | peer — the user's own scope                         |
| **Reply thread**           | `branchOf { …, kind: "reply" }`; no `parentSessionId` | not a root — surfaced under its parent | peer — the user's own scope                         |

A record never carries both edges. A branch gets **no** `parentSessionId`:
its subordination (for replies) is a _rendering_ fact carried by `kind`, not
a scoping fact — same user, same principal, same bus posture as any of their
conversations. The session tree remains pure delegation.

`SessionFilter.root` changes meaning: **root = no `parentSessionId` AND not
`kind: "reply"`**. Forks list as roots. One filter, no second dimension for
callers to remember to combine.

## Branching is not spawning

The deepest distinction is **what each inherits**: a branch inherits
_transcript_ (the user's continuity); a spawn inherits _authority_
(principal, scope) and composes its own context. That asymmetry is why the
edges cannot be unified.

|            | Branch (`branchOf`)                                 | Spawn (`parentSessionId`)                     |
| ---------- | --------------------------------------------------- | --------------------------------------------- |
| Relates    | conversations, anchored at a _message_              | work, anchored at a _call_                    |
| Created by | a person's gesture ("reply here", "fork from here") | an execution delegating                       |
| Inherits   | the source transcript up to the anchor              | authority; context is composed by the spawner |
| Results go | to the user, in the branch's transcript             | back into the spawning turn                   |
| Lifecycle  | independent                                         | subordinate (abort cascades)                  |

The test when unsure: ask what the new session is _for_. A person talks in a
branch; an agent works in a spawn. There is no session that is both, and no
third kind.

**Naming law:** `fork` means _branch a conversation_ — this ADR's sense —
everywhere it appears. The backgroundable-execution family (the exploratory
"spawns surface as tasks" direction) keeps the name `spawn` exclusively. One
word, one meaning.

## Reply identity — one thread per message

A reply thread's identity IS its anchor message (the Slack `thread_ts`
lesson). The framework expresses this as a _naming convention over
create-or-resume_, not a verb:

- `replySessionId(sessionId, messageId)` — a pure derivation (uuidv5-class)
  in `@agentick/spec`, because both ends must agree on it.
- Every caller derives the same id; ADR 49's create-or-resume makes the first
  tap create the thread and every later tap join it. No get-or-create verb,
  no lookup round-trip, no race.

Forks deliberately do NOT derive: forking twice is two forks. Fresh id per
call. The asymmetry is the semantics.

## Client sugar

```ts
// client-core SessionHandle — thin: mint/derive the id, call the create door,
// return the handle. Synchronous, lazy-create, like client.session().
reply(messageId: string): SessionHandle;   // anchor REQUIRED, id DERIVED
fork(messageId?: string): SessionHandle;   // anchor OPTIONAL (default: the tip), id FRESH
```

No server-harness sugar initially. The queued second consumer is the Slack
connector (`thread_ts` ↔ reply thread is 1:1 via `replySessionId`, dissolving
its binding state); host-side `session.reply()` lands if and when it earns
itself there (three-consumers rule).

## The timeline contract — invariant, not mechanism

**A branch session's timeline reads as the source's entries up to the anchor,
then its own.** How a store satisfies that is the adapter's choice: the
bundled in-memory store copies at genesis; a durable adapter may stitch at
read (knowify's ancestry reconstruction already does exactly this — no
duplication). Genesis resolves the anchor `messageId` to the source's `seq`
once and records both.

Context-inheritance v1 is the full trunk prefix. Summary-instead-of-prefix is
a later refinement and slots into the existing branch hooks; it changes no
surface in this ADR.

## Invariants

1. **Same-principal source guard (load-bearing).** A wire `create_session`
   carrying `branchOf` is admitted only when the caller's principal owns the
   source session. Without this, `branchOf` is a cross-tenant timeline-read
   primitive. Enforced at the gateway door beside the ADR 48 stamp.
2. **Persist late, unchanged.** A branch is created live and earns its row via
   `session:persist` on its first turn. An abandoned reply thread leaves
   nothing behind. No special casing.
3. **Depth is app policy, not framework surface.** The edge is depth-agnostic;
   knowify caps replies at depth 1 by offering no reply affordance inside a
   thread. Capability firm, opinion flippable.
4. **A record never carries both `branchOf` and `parentSessionId`.** The
   create door rejects the combination.

## Adopter alignment (knowify)

The `sessions` schema predates this ADR with the storage half already built:
`parent_id` + `branched_at_seq`, `SessionRepository.spawn/branch` doors, and
`TimelineService` stitching `(parent[..seq] ++ own)` via the ancestry walk —
e2e-pinned. Alignment is three moves, not a rebuild:

1. Add `branch_kind` (`'reply' | 'fork' | null`) — the explicit discriminator
   mirroring `branchOf.kind`. Delegation rows: `parent_id` set, seq null,
   kind null. Branch rows: `parent_id` = source, seq = anchor, kind set.
2. `KnowifySessionStore` round-trips `record.branchOf` ↔ the three columns;
   `KnowifySessionIndex` excludes `kind = 'reply'` from the root list.
3. **Ancestry audit:** the stitcher treats `branched_at_seq: null` as "no
   upper bound", so a v2 _delegation_ child's timeline read would stitch in
   the parent's entire history — dead weight at best under v2, where spawned
   agents own their context. Stitch only when `branch_kind` is set.

## Deferred

- **Spawns-surface-as-tasks** — exploratory, NOT ratified (recorded on the
  board with both ledgers). Orthogonal to this ADR; the naming law above is
  the only coupling.
- **Summary-instead-of-prefix** branch context.
- **Host-side reply/fork sugar** — trigger: the Slack connector consumer.
- **Reply-thread UI** (affordance, thread chips, in-transcript anchors) —
  knowify design spec, Ryan's.
