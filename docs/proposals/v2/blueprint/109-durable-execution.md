# ADR 109 — Durable execution: memoize-and-re-drive, not replay

**Status:** Proposed
**Date:** 2026-09-07
**Reference implementation:** `@knowify/ernesto-v2` + `apps/assistant-api` (nx-knowify)

## Context

An agent execution must survive process death — a crash, a deploy, a scale-down —
mid-flight, and resume without re-charging a card, re-sending an email, or
duplicating a created record. Today it does not: the journal on the live path is
`MemoryJournal` (`app/harness.ts:1292`), so a restart loses all operation state and
a re-driven tick re-runs its side effects.

The sprint stalled trying to solve this the Temporal way — **exactly-once via
deterministic replay** — which pulled us into reconstructing stable operation keys
across a sandbox boundary (the `code:execute` membrane), threading positional
counters through Effect fibers, and the A/B/C/D fork on where the key comes from.
Every one of those fights existed to make arbitrary code replay identically.

## The forcing insight

**Agent loops cannot be deterministically replayed.** An LLM call returns something
different every run — different tool calls, in a different order. So "re-run the
workflow and reproduce the same operations" is incoherent here. You can never
replay a model turn; you can only **record its result and not re-run it.**

That is not a limitation to engineer around. It is a signpost: the durable model
for agents is necessarily **journal the completed operations, re-drive only what
did not finish** — memoize-and-re-drive, not replay.

And that is what agentick already is:

- **Journal** — an append-only log of operations (event-sourced execution).
- **Tick-atomic re-drive** — `runExecutionCore(seedTickIndex)`; "a finished turn is
  never re-driven."
- **`lookupTerminal(opId)`** — `operation-runner.ts:361`; a completed op short-
  circuits on re-run, returning its journaled terminal instead of re-executing.
- **Journaling policy** — `journaling-policy.ts:139` already journals `requested`
  and `terminal` for **every** op by default. Nothing is dropped.

## Decision

Durable execution is **memoize-and-re-drive on a durable `OperationJournal`**, with
**caller-supplied idempotency** covering the residual. We do **not** pursue
deterministic whole-program replay.

On a crash re-drive, `lookupTerminal` finds each completed op in the durable journal
and returns its recorded terminal without re-executing the body. A create that
already ran returns its recorded `Id`; the insert never re-fires. Model-turn
memoization falls out for free: the model op's terminal (its emitted tool calls) is
journaled, so re-drive replays the **same** `tool_call_id`s rather than re-calling
the LLM — which is what makes the downstream tool ops key stably
(`tool:dispatch` opId = `i.opId ?? tool:dispatch:${toolCallId}`,
`define-tool-executor.ts:247`).

### The change (small — the machinery already exists)

The policy is already correct and the write path already exists. The gap is that
the live journal is in-memory. Two changes:

1. **A Postgres `OperationJournal`** implementing the port
   (`spec/protocol/journal.ts` — `append`, `lookupTerminal`, `readByQuery`, `tail`,
   `findOrphaned`), validated against the conformance suite. In the reference
   implementation the idempotent `append` half already exists as
   `ChangeJournal.upsert` (`INSERT … ON CONFLICT (op_id) DO UPDATE`) over the
   existing `ernesto_v2.changes` table (`op_id, parent_op_id, session_id,
execution_id, tick_id, name, outcome, payload`); what is added is the read half —
   `lookupTerminal(opId)` selects the terminal-phase row and returns it.
2. **Inject it as the harness journal** — thread it through the gateway options so
   the app is constructed with `journal: <postgresJournal>` instead of
   `new MemoryJournal(...)`. From there `operation-runner`'s `this.journal` is
   durable and `lookupTerminal` reads Postgres.

No new engine, no policy change, no positional-replay machinery.

## Exactly-once vs at-least-once

The durable journal gives **exactly-once for any op with a stable opId** (the model
loop: tool calls keyed by `tool_call_id`, which is stable because the model turn is
memoized). Where a stable key is absent, the model is **at-least-once + idempotency
key**, pushed to the side-effecting boundary where it belongs.

An idempotency audit of the knowify mutating tools (2026-09-07) found:

- **13 of 21 safe as-is** — every update, delete, and state transition writes
  absolute target state or keys on an existing `Id`; re-run is a no-op.
- **8 at-risk keyless creates** — `contract_change_order_add` (worst),
  `service_job_create`, `project_plan_create`, `contract_create`, `project_create`,
  `project_plan_milestone_create`, `list_items_create`, and partially
  `service_job_schedule`. There is **no** platform idempotency key or unique
  constraint today.

The at-risk creates are protected by the journal short-circuit **when issued by the
model loop** (stable `tool_call_id` + durable `lookupTerminal`). They are genuinely
exposed only when issued with an unstable key — the residual below.

## Rejected: deterministic replay + positional keys

Temporal-style exactly-once-via-replay was rejected. It requires the workflow to be
deterministic, which an LLM agent is not; it forces stable-key reconstruction across
the `code:execute` sandbox membrane (orphan fibers, no FiberRef propagation),
positional counters threaded through Effect, and ambient context (ALS) we have
consistently refused. It is thousands of lines building against the grain of a
system that already memoizes by opId — to buy a guarantee the domain cannot honor.

## Residual (known, bounded)

- **Flush-before-mark** — the terminal must be journaled before the op is marked
  done, so the exactly-once window is tight. A fix already exists on the
  execution-resume path; verify it covers this.
- **Two writers to `changes`** — the in-band harness-journal `append` and the
  existing async bus projection (`changes-journal.ts`) both target the table;
  `ON CONFLICT (op_id)` dedups them. Decide whether the projection is retired once
  the journal writes in-band.
- **Code-mode-nested creates** — a create issued from inside a `code:execute`
  sandbox binding gets a random `host:${generateId()}` id, so it does not
  short-circuit on re-drive. This is the one at-risk zone that needs an explicit
  key — either a code-door-supplied key or an idempotency key on the tool. It is
  narrow and severable; it does not block the model-loop case.

## Consequences

- Memoize-and-re-drive survives process restart; the assistant resumes mid-execution
  without re-firing completed side effects.
- The durable substrate is one conformance-tested adapter plus one wiring line, over
  a table and a write path that already exist.
- The request-suspension substrate (input_required / elicitation, ADR-adjacent work
  already built) composes unchanged: it rides the same tick spine and journal.
- Exactly-once for the model loop; at-least-once + idempotency for keyless creates,
  with a short list of tools to give idempotency keys as they matter.
