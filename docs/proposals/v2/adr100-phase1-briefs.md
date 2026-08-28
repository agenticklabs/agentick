# ADR 100 Phase 1 — build briefs

**Source of truth:** `blueprint/100-conversation-branches.md` (rev 2). Every
brief inherits it verbatim; a brief may not reinterpret a law. **Dispatch
gate:** Backlog F complete + clean next.155 cut. Ships as next.156.

**Global rules (every brief):**

- No backwards compat, no shims, no dual paths. The `parentSessionId` field
  dies; `from` replaces it. One way.
- Tests where the dependencies live; conformance carries family obligations;
  doubles under `/testing`, typed against spec. Every claim pinned or listed
  under Roadmap & known gaps. README per touched package.
- Post-sweep: UNFILTERED grep for dead identifiers (`parentSessionId`,
  `ForkInput`, `branchOf`) across the whole repo incl. docs — zero hits
  outside git history and the ADR's ledger. NUL-scan changed files. Workspace
  `pnpm typecheck` before any export deletion.
- LOC is a cost. The model is one bag + one boolean + derivations — if a diff
  grows structure beyond that, stop and report.
- Fences: do not touch `docs/proposals/v2/execution-resume.md`, any Backlog F
  file beyond what your brief names, or anything dirty in the tree you did not
  make dirty. Report unexpected dirt; never sweep it.
- Agents implement; the coordinator judges (diff review, adversarial pass,
  delete-pass) and owns all commits.

---

## Wave A — Brief 1: `@agentick/spec`

**Scope:** the types, complete and alone.

- `SessionRecord.from?: { sessionId, entryId, seq, inherited, anchored }`;
  `SessionRecord.parentSessionId` DELETED. `internal: boolean` — verify
  Backlog F's stamping already put it on the record; if only on content,
  add the session-level field per ADR laws 2/3.
- `CreateSessionInput`: `from?`, `internal?`. Wire `app/create_session`
  params: `from` added; `internal` — check Backlog F's wire posture and FLAG
  (do not decide) whether it is wire-settable; leave it off the wire if
  undocumented.
- `SessionStoreQuery` / wire `SessionFilter`: dims `fromSessionId?`,
  `anchored?`, `internal?`. `root` deleted — its meaning is the composed
  predicate (`internal: false, anchored: false`); update every doc that named
  it.
- `relation(record): "conversation" | "fork" | "reply" | "worker" |
"forked-worker"` — pure fold, exported beside the record types.
- `ForkInput` reshaped to the conversation verb's input (`{ entryId?,
sessionId?, metadata? }`); the C2 shape's fields move to `SpawnInput`
  (`branch?: entryId`).
  **Pin:** type-level: a record cannot express the dead shapes; `relation()`
  truth table (all five rows). **Out:** any runtime code.

## Wave B — Brief 2: `@agentick/session` (the big one)

**Scope:**

- **Genesis fan-out:** `from.inherited` ⇒ the C2 branch fan-out (timeline +
  knobs + state) from the SOURCE's stores up to `seq`. Source LIVE ⇒
  `snapshot()` it first (the checkpointing §5 flush barrier — the one thing
  the rename must not lose); source not live ⇒ stores are already the truth.
  `entryId → seq` resolved here, once, stored on the record.
- **The sweep:** `parentSessionId` → `from` through `SessionRuntime`,
  `SessionHarness`, session-bridges, lifecycle projection. Subordination
  consumers (abort-cascade, principal descent, spawn child tracking) keep
  reading the LIVE spawn registry — their behavior is pinned unchanged.
  `spawnPath` / origin stamps untouched.
- **Verbs:** `reply(entryId)`, `fork(entryId?)`, `branch(opts)` on
  `SessionHarness` — thin sugars over the app create door, NOT ops (abort()
  precedent). `spawn` forces `internal: true` (no option), accepts
  `branch?: entryId`.
- **C2 absorption:** `fork()`'s body becomes spawn plumbing; the public
  `fork()` is the conversation verb. Old fork specs migrate or die
  (delete-pass with stated cause).
  **Pin (contract spec, the five-case table as a matrix):** each row's record
  shape; law 1 (inherited reads as source[..seq] ++ own — timeline AND a knob
  value); snapshot-first on a live source; spawn cannot produce
  `internal: false`; persist law 3 both arms. **Out:** wire, store impls.

## Wave B — Brief 3: `@agentick/app`

**Scope:** create door threads `internal`/`from`; `createChildSession` writes
`from { inherited: per branch option, anchored: false }` + `internal: true`
forced; eager-at-genesis re-keyed from "spawned" to `internal: true` (covers
host-created internal sessions — decided 2026-08-27); `getSessionRecord`/list
paths compile against the new dims.
**Pin:** host-created `createSession({ internal: true })` has a row at
genesis; a plain conversation still earns lazily (existing persist specs stay
green); child records carry the full bag. **Out:** wire guard.

## Wave B — Brief 4: `@agentick/gateway`

**Scope:** the load-bearing line — wire `create_session` admits `from` only
when the caller's principal owns `from.sessionId` (read the source record;
absent record ⇒ reject). Origin stamps and (pending Brief 1's flag)
`internal` are not wire-settable. List paths: the composed root predicate;
new filter dims cross the wire.
**Pin:** cross-principal `from` rejected (the security test is the point of
the package's diff); owned source admitted; unfiltered `root` references
gone from wire docs. **Out:** store query impls (conformance owns them).

## Wave B — Brief 5: `@agentick/client-core`

**Scope:** `reply` / `fork` / `branch` on the session handle, mirroring the
harness signatures (deref handle → ids; fresh ids; synchronous lazy-create
like `client.session()`); re-export `relation()`; filter dims on
`listSessions` params.
**Pin:** verb → wire-params lowering (tapped transport, per the e2e rig
idioms); no verb is an op. **Out:** UI, derivation conventions (dead).

## Wave B — Brief 6: `@agentick/skills` (small)

**Scope:** the runner's `session.fork()` → `spawn(…, { branch: tip })`
spelling. Behavior identical (same-image throwaway child, disposed after
run) — this is a spelling migration, and its specs must not weaken.
**Pin:** existing skills-run e2e stays green unmodified where possible;
where the spec named `fork`, it migrates with cause stated.

## Wave B — conformance & doubles (rides Briefs 1–4)

- Session-store conformance gains the query-dim obligations (`fromSessionId`,
  `anchored`, `internal` — match and non-match each) so every adapter,
  including knowify's, inherits the tests.
- All `/testing` doubles recompile against the new record; any double that
  hand-built `parentSessionId` records updates to the bag — flagged in the
  diff, not silently reshaped.

## Wave C — coordinator (not an agent brief)

Adversarial judge pass; the cross-package contract spec at the adopter's
entry (`createApp` config a user writes: fork a conversation, reply to an
entry, spawn a worker, assert lists/persist/guard behavior end-to-end);
`internal-visibility.md` drift note closed; READMEs verified against the
README-first draft in the ADR; version bump; publish next.156; knowify
Phase 2 briefs.
