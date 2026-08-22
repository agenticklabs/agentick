# Checkpointing — the session is its stores

**Status:** ratified (2026-08-20 judge pass — §8's three open points resolved
into the body; build-ready). Delta on
[`data-layer-plan.md`](data-layer-plan.md) — this doc does not compete with the
plan; it **promotes Phase 4 (the manifest sweep) and extends it with two
decisions the plan left open**: eviction unification (§4) and the elimination of
the export primitive (§5). Where this doc and the plan overlap, the plan's
ratified vocabulary (E-numbers, §2.5/§2.7, Step 6) is authoritative and cited,
not restated.

**Thesis.** A session's durable identity is its registry record plus its
per-harness stores. There is no snapshot _value_. `snapshot()` and `restore()`
are hooks — each harness flushes to / rehydrates from its own store, resolves
async, and the framework only sequences: it owns the session FSM, faithful
hook dispatch, and the trigger mechanics — never the data. Checkpoint
(durability, every idle-sweep) and export (a payload crossing a boundary,
approximately never) are different operations; conflating them into one
value-returning `exportSnapshot()` is the original defect, and every pathology
below traces to that single signature.

---

## 1. Why now — production evidence

assistant-api (ernesto on agentick v2), 2026-08-19, one light day:
task memory climbs 16.4% → 21.1% in a staircase correlated with traffic, flat
overnight, reset only by deploy. Not a time-linear leak — retention proportional
to distinct sessions touched since boot. The chain:

1. The ernesto app is configured correctly per the 08-17 incident fix
   (`sessions: { store, idleTimeout: 30min, maxActive: 1000 }`). Idle sessions
   evict.
2. Eviction parks the full `SessionSnapshot` in the app-scoped in-memory
   `paged` map — unbounded, entries removed only on resume or destroy
   (`packages/app/src/harness.ts:955`, `TODO(eviction-durable-snapshot)` at
   `:950`).
3. That snapshot's `bridges.timeline` is the god-blob: the complete entry log
   (`packages/spec/src/protocol/timeline-harness.ts:229`,
   `TODO(adr-93-d1b)`) — duplicating data already durable, per-entry, in the
   timeline store.

Net: one full conversation resident in the heap per session ever idled, until
deploy. The 08-17 FD/memory incident was this bug at the live-tree layer; the
fix moved the retention into the paged map, one layer down. Bounding the map
would move it a third time. The only fix that terminates the sequence is
removing the payload.

**Confirmed on day 2 (2026-08-20):** the staircase resumed from day 1's ~20%
plateau and walked to 22.9% — it did not re-climb the 16→21% range. Cross-day
accumulation is the signature that rules out V8 high-water expansion (which
settles after day one); the sharp dips recover instantly to trend (GC-shaped —
a task restart would reset to ~16%). Retention compounds at roughly +2% of
task memory per light-usage day.

## 2. The defect — checkpoint conflated with export

The fan-out is already right: `captureSnapshot()`
(`packages/session/src/harness.ts:1718`) iterates bridges generically via
feature detection, no hardcoded slots, extensions picked up automatically
(ADR 27). The defect is the leaf contract:

```ts
// packages/spec/src/protocol/hook-bridges.ts:120 — the signature that caused everything
interface SnapshotCapable<TSnapshot = unknown> {
  exportSnapshot(): TSnapshot; // sync, value-returning
  importSnapshot(snapshot: TSnapshot): void | Promise<void>;
}
```

A return value must be self-contained → the timeline embeds its whole log →
the caller owns a large opaque payload and must place it somewhere → the app
grows the `paged` map → §1. Secondary damage: **sync** `exportSnapshot` forces
eager projections on harnesses that have no render-read need for them
(skills/prompts — "eager, forced by sync `exportSnapshot`, not render",
data-layer-plan §3 table).

`data-layer-plan.md` §2.5 already ratifies the replacement noun — the
**manifest** (per-store `{scope, key, backend, cursor}` references, embedded
state banned) — and §2.7 removes the timeline's in-memory mirror. What the plan
left open, and this doc decides: what happens at **eviction** (§4), and what
happens to the **value path** the god-blob TODO says must exist for transplant
(§5).

## 3. The contract

### 3.1 Store ports are the persistence model — already the norm

Every harness with durable state declares its own store port, session-scoped,
in-memory by default (capability, not opinion). This is the existing convention
— timeline, tasks, credentials have stores; knobs is storified (run #2,
`8a57e663`); state/session/skills/prompts/resources are on the plan's run list.
Knobs and state have been freeloading on the snapshot blob precisely because
their stores came late — evidence for the model, not against it. No new
placement mechanism (a central keyed slot-bag was considered and rejected: it
is the blob reforming one layer down).

### 3.2 The leaf hook — replaces `SnapshotCapable`

```ts
interface CheckpointCapable {
  /** Flush write-behind to this harness's own store. Async — a flush is I/O. */
  persist(ctx: PersistCtx): Promise<void>;
  /** Rehydrate from this harness's own store, latest, by session scope. */
  hydrate(ctx: HydrateCtx): Promise<void>;
}
```

**Amended 2026-08-22 — no return value.** The earlier draft had `persist`
return a `ManifestEntry` (`{backend, cursor}`) the framework folded into the
record and handed back to `hydrate`. That was the last trace of the framework
caring where data lives and how far it got. The cursor buys nothing on the
recovery path: post-evict the session is unmounted so nothing writes past the
flush; post-crash there is no recorded cursor at all; and the plan's ratified
default is resume-latest (E2). Each harness finds its own data by session
scope in its own store. This supersedes the plan §2.5 cursor-map _as a resume
input_ — consistent with the plan's own default; journal-derived stores keep
cursors internally for time-travel, which stays their business. The framework
knows THAT (FSM, dispatch, triggers), never WHAT. The E2 skew stamp becomes
harness-voluntary (stamp your own store for diagnosability).

- Feature-detected exactly as `SnapshotCapable` is today; the session-level
  fold keeps its names — `SessionHarness.snapshot()` fans out `persist`
  (the flush barrier, plan §2.5), net-new `SessionHarness.restore()` fans out
  `hydrate` (ordering: journal → derived stores → mount, E12).
- **Failure semantics (dispatch fidelity, not data concern):** a rejected
  `persist` ABORTS the eviction — the session stays live (a failed flush must
  never be followed by an unmount, or the un-flushed tail becomes the
  framework's fault); a rejected `hydrate` fails the resume to its caller.
- The framework never sees harness state. Timeline's `persist` = flush pending
  writes. Knobs' = flush its `CollectionStore`. A derivable-by-re-render
  harness implements neither — its declarations regenerate at mount.
- **No value crosses the seam.** `SessionSnapshot`, `SessionSnapshot.bridges`,
  and both `exportSnapshot`/`importSnapshot` methods are deleted in the sweep
  (they coexist until then, per the plan's migration note).
- **Ctx shape (ratified):** `{ sessionId, tick, storeCtx, signal }` — the store
  scope key, the epoch stamp (§3.3), the store-call context, and an
  `AbortSignal` so a shutdown flush has a deadline. **Deliberately no `reason`
  field** (`"evict" | "tick" | "shutdown"`): the moment a hook can see why it
  is running, harnesses flush differently per trigger and the §4 guarantee —
  one recovery path, one conformance suite — dies at the leaves. Uniformity
  depends on the hooks being blind to the trigger. Every future field is
  permanent API surface across all harnesses; additions carry the same burden
  of proof.

### 3.3 Consistency — ratified, restated, not re-litigated

Independent stores have no global consistency point (plan §2.5, E2):
**default = resume-latest, eventually consistent**, window minimized by the
flush barrier; the journal-derived path is the opt-in atomic/time-travel
answer. One addition worth its cost: `persist` receives the current tick in
`PersistCtx` and stores SHOULD stamp it, so a skewed resume is _diagnosable_
(a log line, not a subsystem). Point-in-time restore of non-journal harnesses
is a **stated non-goal** — latest-only.

## 4. Eviction unification — one recovery path

Today there are three recovery mechanisms: evict-resume (replay from the
in-memory `paged` map), restart-resume (durable-record fallback + app
defaults), and crash (whatever the fallback happens to reconstruct). Under
this contract they collapse into **one code path**:

```
evict   = snapshot() [fan out persist — each harness flushes its own store] + unmount
          — retain NOTHING
resume  = build (from app recipe + SessionRecord) + restore() [fan out hydrate]
restart = the same
crash   = the same, minus the un-flushed tail (the stated E2 window)
```

**Triggers are callers, not mechanisms.** Idle sweep, LRU overflow, and
programmatic invocation are all callers of the same composed operation;
configuration (`idleTimeout`, `maxActive`) governs only the automatic callers;
guards/hooks govern admissibility regardless of caller. Resume already has its
public verb (`resumeSession`, `app-harness.ts:794`) beside the implicit
send/dispatch trigger; eviction gains its missing public counterpart —
**`evictSession(id)`** on the app protocol — so both directions are two verbs,
N callers, one operation each.

- `AppHarness.paged` is **deleted**, and with it `PagedSession` and
  `TODO(eviction-durable-snapshot)`. Eviction stops being a residency _tier_
  and becomes the checkpoint everyone else uses. (A bounded resume cache can be
  added later if a real trace ever shows the pg read matters — React-style
  absorption; not built now. The remount dominates resume cost in every tier,
  which is also why hibernate-in-RAM buys nothing.)
- **Build-call durability** becomes a contract instead of an accident: the
  serializable portion of `CreateSessionInput` (id, principal, metadata)
  persists in the `SessionRecord`; everything else is re-derived from the app
  recipe (ADR 30 — the app IS the recipe). The record holds FSM state +
  identity and **nothing else** — with the no-return-value amendment (§3.2)
  the Phase-4 `stores` placeholder is NOT populated as a resume input
  (`TODO(store-phase-4)` re-scoped: if it ever lands, it is observability
  metadata, never something `restore` reads).
- **Spawned sessions are process-bound (ratified).** A child's build call
  (component reference, arbitrary props, runner/model overrides) is not
  serializable in general and has no recipe to re-derive from, so children are
  ephemeral workers: a restart orphans them, and a resumed parent re-spawns if
  its own logic still needs the work. This codifies existing behavior —
  idle-evicted children already self-dispose rather than page
  (`packages/app/src/harness.ts:482`) — and durable child work is what tasks
  (ADR 68) exist for. Durable spawns (catalog-registered agent by name +
  JSON-serializable props → resumable) are a future opt-in:
  `TODO(durable-spawns)` at the spawn path is the trailhead.
- One conformance suite certifies the one path: kill/resume via manifest, for
  every migrated harness, plus the skew-window test (plan Phase-4 gate).
- **Eviction is not a command — it composes two that are.** Evict =
  `session:snapshot` + `session:close({reason:"evicted"})`; resume = build +
  `session:restore`. All hook surface rides the existing minted seams
  (`onBefore/AfterSessionSnapshot`, `onBefore/AfterSessionRestore`,
  `onBeforeSessionClose` — ADR 92 Family 2 §5). Pinning = a guard on
  `session:close` checking `reason === "evicted"`; drain = the close before-hook.
  The command layer sees the trigger (policy may depend on _why_); the harness
  `persist()` hooks never do (§3.2) — that split is what keeps the recovery
  path singular while leaving eviction policy interceptable. Victim selection
  (`isEvictable`, LRU choice) is hardcoded and stays so;
  `TODO(eviction-victim-policy)` is the trailhead if weighted eviction is ever
  wanted.

## 5. Export is not a primitive

The god-blob's last stated justification
(`packages/spec/src/protocol/timeline-harness.ts:233`) is transplant: fork or
cross-store/cross-node move needs a transport. Walked through, every case
resolves below or beside the framework:

| Case                                                   | Resolution                                                                                                                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-node move, shared stores (the actual deployment) | Free. The session lives wherever its stores are; "move" = hydrate on another node. Zero data movement.                                                                                    |
| Cross-node move, node-local stores                     | Impossible **by construction** — and honestly so. Not papered over with a blob.                                                                                                           |
| Fork                                                   | Store-layer branch: copy the scope (composable from `list` + `put` on any `CollectionStore`; a store MAY override with a native copy), timeline forks at a cursor on its append-only log. |
| Leave the store universe (debug dump, env move)        | External tooling iterating the stores. Not a framework verb.                                                                                                                              |

Consequences (the kill list, additive to the sweep's):

- `SessionSnapshot` (spec) — deleted.
- `SnapshotCapable` + conformance — replaced per §3.2.
- Wire `session/snapshot` verb (`SessionSnapshotParams`/`Result`,
  `packages/spec/src/wire/params.ts:483`; client handle in
  `client-core/src/handles.ts`) — deleted. A debugging read, if ever wanted,
  composes per-harness enumerate verbs; it is not a primitive.
- Timeline's embedded log field + `_persisted` mirror — the `adr-93-d1b`
  TODO's precondition ("requires a transplant mechanism first") is satisfied
  by store-layer copy; dies with §2.7 as planned.
- `ExecutionRunner.onPersist(session, snapshot)` — already hook-shaped;
  loses its payload parameter (a runner persisting state uses its own store,
  same rule as everyone).

## 6. Compounding enablers

- **Async `persist` frees the definition libraries.** Skills/prompts eager
  projections exist only to satisfy sync `exportSnapshot` (plan §3 table);
  post-sweep they can be lazy/none per their actual read pattern.
- **Very large sessions stop being special.** Nothing serializes O(session)
  through memory at a checkpoint; timeline flush is incremental by
  construction.
- **The memory ceiling becomes structural**: RSS = `maxActive`-bounded live
  tree + flat overhead. The §1 staircase is not tuned away; it has no
  mechanism left to occur through.

## 7. Sequencing

This is the plan's Phase 4, promoted, with §4/§5 added to its scope. Order:

1. Spec: `CheckpointCapable`, `ManifestEntry`, manifest into `SessionRecord`
   (populate the Phase-4 placeholder); coexistence with residual
   `SnapshotCapable` per the plan.
2. Session: `snapshot()` → manifest fold; net-new `restore(manifest)` with
   E12 ordering.
3. App: eviction path onto snapshot+unmount; delete `paged`; build-call
   durability contract.
4. Harness migrations already sequenced by the plan (state next per the knobs
   template; session-store E11; definition libraries Phase 5).
5. The sweep: delete `SnapshotCapable`/`SessionSnapshot`/wire verb/timeline
   embedded log; unfiltered grep for the dead identifiers; workspace
   typecheck.

**No interim band-aid** (bounding `paged`): at current usage the headroom per
deploy cycle is days-to-weeks and deploys are far more frequent; an interim cap
would be a third relocation of the same bug.

Gates (per phase, cumulative): kill/resume acceptance via manifest for every
migrated harness; skew-window test; heterogeneous resume (some embedded, some
manifest) during coexistence; evict→resume ≡ restart→resume asserted by one
suite; memory: evicted session leaves zero app-side retained references
(heap-assert in test, gauge in prod).

## 8. Ratified decisions (2026-08-20 judge pass)

The three §8 open points, resolved into the body above. The through-line: each
codifies the narrowest contract current behavior already satisfies, and leaves
the widening as a documented trigger, not built machinery.

1. **Spawns are process-bound** (§4) — durable spawns are a future opt-in,
   `TODO(durable-spawns)`.
2. **Ctx = `{ sessionId, tick, storeCtx, signal }`, no `reason`** (§3.2) —
   hooks stay blind to the trigger so the one-path guarantee holds.
3. **Restore ordering is fixed** — journal → derived stores → mount (E12), no
   per-harness dependency declaration. No known harness's hydrate reads a
   sibling's hydrated state; the first harness that needs to is the trigger to
   revisit (`TODO(hydrate-ordering)` at the restore fold is the trailhead —
   an ordering mechanism is additive to introduce and near-impossible to
   remove, so it waits for a concrete counterexample).
