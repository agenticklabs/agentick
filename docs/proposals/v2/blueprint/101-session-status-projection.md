# ADR 101 — Session status is a projected fact (channel, seed, outcome, input_required)

**Status:** ACCEPTED 2026-08-16 (Fable, with Ryan) — shipped in 1.0.0-next.122 (9f49ec69b)
**Depends on:** ADR 53 (channels), the channel-snapshot splice (`resolveChannelSnapshots`), ADR 48 (principal).
**Motivated by:** a production reload — a chat panel refreshed mid-execution rendered a running session as idle (the client `SessionHandle` had no status surface), and a thread list had no way to show which conversations were working, waiting on input, or finished-unseen.

## Decision

`SessionStatus` was already half-projected: on the harness, on the durable
record, on every `list_sessions` row — enumerate without notify. The notify
half is `session:channel:status`: one self-describing frame
`{ sessionId, status, executionId?, outcome? }` per transition, published from
`SessionRuntime.setStatus` — the field's sole writer, change-gated,
fire-and-forget (a dropped frame can never fail the execution that produced
it).

**Channel, not a discrete event — for the seed.** Only `session:channel:*`
names are eligible for the existing snapshot splice, which prepends the
CURRENT status as frame one of the same ordered subscription (the K8s
watch-list model). That kills the read-then-subscribe race by construction; a
discrete event would have needed a separate seed read and reintroduced it. The
rejected alternative — inferring status by scraping `session:command:send`
terminals — has no seed, reconstructs a durable field by inference, and cannot
express `failed`.

**The outcome rider.** `outcome?: "succeeded" | "failed" | "aborted"`
(`runOutcomeOf`; `vetoed` folds to `failed` — a refused run did not happen)
rides ONLY the execution-end transition, passed as a `setStatus` ARGUMENT
rather than ambient context: a parameter cannot outlive its call, while stale
context would stamp the next unrelated transition with a wrong ending.
Snapshots carry state, never endings. Run outcomes never enter the status
VALUE — an `executor_failed` run leaves a usable, idle session.

**`input_required`, not `paused`.** A session whose execution is blocked on a
pending elicitation/confirmation transitions `running → input_required` and
back — tracked by the elicit OPERATION's requested/terminal pair (balanced on
every exit: answer, timeout, abort, close), a Set of opIds (concurrent asks
are one state; replays cannot go negative), both flips status-guarded (an ask
outside an execution never moves an idle session; end-beats-blocked). `paused`
stays reserved for the blueprint's operator pause/resume: a UI must be able to
tell "someone stopped this" from "someone needs to answer something". The
sibling vocabulary precedent is the tasks harness's `input_required`.

## Consumption — two tiers, one stream

- **Focused** (a handle): `session.status` — a lazy `ChannelView`
  (`get()` / `subscribe` / `onChange` with the whole frame). The harness's
  `status` is the value; the handle's is the view over it — same fact, one
  no-await door per side. `app/create_session` (create-or-resume) answers
  `{ sessionId, status }` so a reopening client knows before frame one.
- **Ambient** (no handles): rows seed from `list_sessions` (status was always
  there); ONE gateway/app-scoped `events(sessionStatusEventQuery())`
  subscription delivers transitions for every owned session. Thread lists,
  badges, and toasts are different folds of the same stream: `input_required`
  → "needs you", `idle` + `outcome` → "done / failed over there". Zero new
  client API existed for this tier — the typed query + frame are the whole
  shipment.

## Isolation doctrine (recorded, not implemented here)

Ambient-tier authorization is BUS TOPOLOGY, not event filtering: child buses
fan into parents (global ← tenant ← user), subscribers on a child see only
local events by construction, and the ONE authorization decision is which bus
a connection may attach to, made at subscribe time. Filters on a shared bus
are the anti-pattern. #297 tracks aligning `sub/subscribe` admission with
this.

## Non-goals

- Reattaching to the in-flight turn's DELTA stream (the streamed partial text
  is not replayable); the seed + timeline persistence cover the reload UX.
- Per-user seen/unseen state — adopter-owned (the record's `metadata` bag +
  an open-is-seen stamp at the create-or-resume seam), deliberately not a
  framework field: "seen" is per-user, and the record's scalar would be wrong
  the day sessions are shared.

@verifiedBy `packages/session/src/__tests__/status-channel.spec.ts` ·
`packages/client-core/src/__tests__/session-status-view.spec.ts` ·
`packages/transport-in-process/src/__tests__/session-status-e2e.spec.ts`
