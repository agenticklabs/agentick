# Session eviction is not transparent — the three-leg gap (+ latent cluster split-brain)

**Status:** open issue / proposal. Pre-existing on `feat/v2`. Independent of the
op-journal & media work.

## Summary

Eviction is documented as invisible paging ("eviction is paging, invisible to
correctness"). It is not. It **pages out but does not page back in faithfully.**
There are **three independent gaps**; the priority is state-loss (leg 2), not the
mount error that surfaced first (leg 1). The same root also exposes a **latent
cluster deal-breaker**: there is no single-writer session ownership, so two nodes
can host the same session at once.

The bar we are grading against (stated requirement): _a client must be able to
continue in an evicted-then-reinstated session with nothing lost and no visible
blip._ Today: **~30% met.**

## Repro

```ts
createApp({ sessions: { maxActive: 1 } });
// create A, send; create B (evicts A); reopen A; send  → NotMounted
```

Deterministic via the LRU cap; also reachable racily via the async idle sweep.

## Leg 1 — mount clobber (correctness bug)

One shared compiler serves all sessions; the mount key is derived purely from the
session id: `mount:<sessionId>` (`packages/session/src/harness.ts:1131`). The
compiler's mount registry is a `Map`; unmount is an **unconditional delete by key**
(`packages/compiler-react/src/harness/compiler-harness.ts:413-421`), mount throws
`AlreadyMounted` on a live key (`:516-519`), render/dispatch throw `NotMounted`
when the key is gone (`:310-312`).

Because successive harness objects for the same id share the key, correctness
depends on the dead object's unmount being ordered strictly before the fresh
object's mount. It isn't, across all triggers (the async `sweepIdle` is not
serialized against reopen). Two failure interleavings:

- fresh mount before old unmount → `AlreadyMounted`;
- old unmount after fresh mount → deletes the live successor's mount → next send
  `NotMounted`.

**Fix:** a per-mount **generation (fencing token)** on `MountInput`/`UnmountInput`
(`packages/spec/src/protocol/compiler.ts:120-149`). Unmount deletes only if the
generation matches; a stale harness's late unmount is fenced out. Minted by a
local monotonic counter today; handed out by the cluster authority later (same
token — see cluster corollary).

## Leg 2 — state loss on reopen (**the priority**)

Eviction takes **no snapshot** — `disposeSession(id,"evict")` →
`session.close({reason:"evicted"})` → `teardown()` → `compiler.unmount`, nothing
state-preserving (`packages/app/src/harness.ts:3285-3301`;
`packages/session/src/harness.ts:1799-1830`). Reopen's genesis hydrates only
`runtime.hydrate()` + (conditionally) `timeline.hydrate()`
(`packages/session/src/harness.ts:1201-1209`); it never calls `restore()` /
bridge `importSnapshot()`. So evict→reopen restores **strictly less** than
`snapshot()`→`restore()`.

| State                                            | Survives evict→reopen?                           | Why                                                                        |
| ------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------- |
| Accounting (usage/cost/counts), status, metadata | **Yes**                                          | app-scoped `SessionStore`, outlives the harness                            |
| Tasks                                            | **Yes**                                          | app-scoped task store                                                      |
| Timeline (the conversation)                      | **Only if a durable timeline store is injected** | default in-memory store isn't reloaded                                     |
| Knobs                                            | **No**                                           | per-harness in-memory store; resume is `importSnapshot`-only, never called |
| Session state (`useSessionState`)                | **No**                                           | same as knobs                                                              |
| Custom `SnapshotCapable` bridges                 | **No**                                           | only `captureSnapshot`/`restore` handle them; neither runs                 |
| `currentTick`                                    | **No**                                           | transient, resets to 0                                                     |
| `useResolved` / Layer-2                          | **Derived**                                      | only as good as the timeline/state it reads → effectively lost             |

The reopened session is a **hollow shell**: same id, but knobs, working state, and
(usually) the conversation are gone.

**Fix:** make eviction a real **passivation** — snapshot before unmount (or persist
all bridge state continuously) — and make reopen a real **activation** — the full
`restore()` / `importSnapshot()` fan-out, not just timeline + record. Invariant:
**evict→reopen must equal snapshot→restore.**

## Leg 3 — client continuity / cursor (no replay)

Good: the client subscription rides the **app-scoped bus**, not the session, so
eviction does **not** drop the wire subscription and reopen is automatic
(`packages/gateway/src/wire/subscriptions-extension.ts:120-127`).

Bad:

- the client receives a visible `session:command:close(reason:"evicted")` event in
  its stream (session ops are bus-emitted; `packages/session/src/harness.ts:953-955`);
- no fresh channel snapshot on reopen (baseline runs only at `sub/subscribe`), so
  the client relies on live deltas — empty for everything leg 2 dropped;
- **no event cursor / replay at all** — `cursorResume:false`
  (`packages/transport/src/server/dispatch.ts:477`), `fromCursor` accepted-and-
  ignored (`subscriptions-extension.ts:192-213`), `notifications/subscription/evicted`
  unbuilt. A real disconnect/reconnect in the eviction window silently drops gap
  events.

**Fix:** buffer requests during activation; a retention ring + honored cursor for
replay-on-resume; emit/handle the `evicted` frame so the client resumes cleanly
instead of seeing a bare close.

## Cluster corollary — latent split-brain (deal-breaker)

There is **no single-writer session ownership** in the cluster layer: ownership is
a _stateless consistent-hash recomputed on every send_
(`packages/cluster/src/partitioning.ts`); `ownerOf` is "for human/operational
visibility." No lease, no lock, no fencing token (the only Redis TTL is a node
heartbeat, not a session claim). Mount is process-local and ungated. During a
membership transition, **two nodes can each compute `owner === currentNode` for the
same session and both mount it** — cold-rehydrating from the store with no
interlock → two live trees, divergent state, double execution.

The leg-1 generation **is** the fencing token the cluster needs. The seam is the
existing `Cluster.ownerOf` / `ClusterPartitioning` (`packages/cluster/src/cluster.ts`,
`partitioning.ts`): upgrade owner resolution from a stateless hash to an
**authoritative leased owner + generation**, consulted before mount. Same token,
adjudicated locally now, cluster-coordinated later — so the local fix is the down
payment, not a throwaway. (`principal`/ADR 48 cannot serve: it's authorization, and
a reincarnated same-id session inherits the _same_ principal, so it can't
distinguish fresh from stale.)

## Model: virtual-actor (drop-and-respin), not hibernate

Memory is a **cache**; the user's durable stores (all user-configurable) are the
**truth**. There is no special "eviction" operation — only:

- **ensure-resident on message:** if the session isn't live on this node, hydrate
  it from its stores (the existing cold-hydrate path that already works — #290)
  and handle the message. _One_ path for cold-start, reopen, and cross-node.
- **drop under pressure:** dispose fully; the stores retain everything.

This is the Orleans/Temporal/Akka consensus. Hibernate (keep state resident, drop
only the fiber tree) is demoted to an **optional keep-warm tier** (see Risks —
it's optional for correctness, often load-bearing for interactive latency).

## The two gaps that block drop-and-respin today

1. **Incomplete hydrate fan-out.** Genesis hydrates only `runtime` + `timeline`
   (`session/harness.ts:1201-1209`); knobs/state/custom bridges resume _only_ via
   `importSnapshot`, which genesis never calls. So even with durable stores wired,
   a respun session is missing those bridges. **Fix: genesis hydrates EVERY bridge
   from its store, uniformly.**
2. **No single-writer guarantee.** "Whoever gets the message spins it up" is safe
   only if at most one activation happens per id. Local: concurrent messages can
   double-construct → needs **single-flight activation** (one in-flight hydrate per
   id). Cluster: ownership is a stateless per-send hash, so a membership change can
   double-route → needs **authoritative ownership + fencing** before "the cluster
   routes it correctly" is true.

## Plan

1. **Complete the genesis hydrate fan-out** — every bridge from its store. _This is
   the fix that makes drop-and-respin faithful._ (Step 1, scope now.)
2. **Single-flight activation** — one in-flight hydrate per id (local).
3. **Eviction = a bare drop** — dispose fully; delete the lossy special path. No
   snapshot-on-evict, no hibernate-as-foundation.
4. **Authoritative cluster ownership + fencing** — single-writer cross-node; the
   fence must be **enforced at the store-write layer**, not merely minted.
5. **Client (leg 3)** — suppress the `close(evicted)` event; cursor/replay ring for
   a real reconnect.

**Invariant to enforce in tests:** a respun session (fresh construction + full
hydrate) is behaviorally equivalent to the pre-drop session, and a post-drop `send`
succeeds — with no in-memory state relied upon.

## Risks / where a critic pushes (design for these, don't paper over)

- **Hydration latency + eviction thrash.** First message after a drop pays full
  rehydrate/re-render (+ replay if the store is an event log); a tight cap → cache
  thrash. Keep-warm/hibernate is **optional for correctness but often load-bearing
  for interactive UX** — treat it as a considered tier, not an afterthought.
  Snapshots shorten replay tails; materialized stores make hydrate a plain load.
- **Faithful reconstruction requires determinism.** Reopen must be a _pure
  projection_ of the log — captured state mutations, not recomputed via
  non-deterministic handlers; no `Date.now`/random on the reconstruct path.
  Explicit invariant + guard, or "faithful" silently becomes "approximate."
- **Single-writer is not absolute.** Honest guarantee: single-activation under
  normal operation + **fenced reconciliation** on conflict (Kleppmann). A fence the
  store writes don't check is theater — enforce it at persistence.
- **Per-bridge hydration is a contract on every harness author.** Make it a
  **conformance-tested capability**, or partial-hydration bugs recur, just
  distributed across bridges.
- **Dissent (OTP "don't evict, add nodes"):** legitimate, but converges on the same
  single-writer requirement and still needs passivation as a single-node backstop.

## Tests (the gap that let this slip)

`session-eviction.spec.tsx` only asserts snapshot equality after reopen, never a
**send** — and `snapshot()` doesn't touch the mount, so it's blind to leg 1 and
leg 2. Add: post-reopen `send`; state-survives-reopen (knobs/state/timeline);
idle-sweep-interleaved reopen; (cluster) double-activation is prevented.

## Hibernate vs passivate — two tiers, and today's default is the wrong one

Today's "eviction" conflates two different operations and picks the worst blend.
Split them:

- **Hibernate** (OTP-style, should be the DEFAULT idle strategy): drop only the
  expensive, rebuildable part — the compiler mount (the live fiber tree) — but
  keep the session harness and its bridges (knobs/state/timeline) **resident in
  memory**. Wake = re-mount + re-render from resident state. **Transparent by
  construction**: state never leaves, so leg 2 disappears and leg 1 reduces to a
  clean local remount. No durable round-trip, near-instant wake.
- **Passivate** (Akka/Orleans-style): serialize everything to the durable store
  and drop the whole session. Needed only under real memory pressure (working set
  exceeds RAM) or for cross-node migration. Requires the full snapshot/restore +
  fence (legs 1–3 in full).

Today's eviction is the **worst of both**: it drops the whole session (like
passivate) but **without saving state** (unlike passivate) → lossy paging.

Cost intuition: the fiber tree is the big, reconstructable cost; session state is
small and precious. Hibernation frees the former and keeps the latter — the right
tradeoff for many idle sessions on one node. Passivation is the only thing that
helps when state itself won't fit or must move nodes. Ship **hibernate as the
default idle tier; passivate only when forced**, and make passivate a real
snapshot/restore.

## Prior art

See the "how other actor systems do this" analysis accompanying this issue:
OTP hibernation + pid-as-fence + atomic name registry; Akka Cluster Sharding
(coordinator = single-writer authority, stop-before-start handoff, passivation);
Orleans virtual actors (single-activation via grain directory, transparent
activate/deactivate); Temporal (history replay as recovery). The consensus shape:
an **authoritative directory/coordinator** for single-writer, an **incarnation/fence**
so stale owners can't clobber, **passivate=persist / activate=recover** with request
buffering, and **everything that must survive lives in the durable substrate**.
