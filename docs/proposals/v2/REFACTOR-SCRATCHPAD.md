# REFACTOR-SCRATCHPAD — augmentation refactor (ADR 27 execution)

**Active:** 2026-05-26 — onwards
**Tracks:** the refactor that lands ADR 27 (modular built-ins).
**Format:** running log. Newest entries appended. Each entry is an
ISO date + short title + body. Surprises, gotchas, judgement calls,
and "I expected X but got Y" go here.

When this refactor lands and STATUS.md captures the milestone, this
scratchpad gets archived (or rolled into the milestone description).

---

## Pre-flight context (2026-05-26)

**Where we're starting from.** Going into this refactor:

- `feat/v2` branch, 88 commits ahead of master.
- ADR 26 (`harness-api-shape.md`) is the foundational pattern. ADR 27
  (`modular-built-ins.md`) refines it by making built-ins follow the
  same modular pattern as optional extensions.
- Recent shipped work: Step 5a (TimelineHarness extraction with two-tier
  log + projection), Step 5a follow-up (pending-messages: queue / drain
  / readPending).
- I'm in the middle of a doomed pre-ADR-27 refactor that tried to
  put the Timeline component in `@agentick/timeline/react`. That work
  created three packages (`@agentick/data`, `@agentick/in-memory-bridges`,
  `@agentick/reconciler-react-tests`) routing around a workspace cycle.
  All three get rolled back as Stage 1 of this refactor — they were
  symptoms, not solutions.

**What ADR 27 actually fixes that ADR 26 didn't:**
ADR 26 made everything a harness but left foundational slots
(`timeline`, `knobs`, `state`) hardcoded in `@agentick/spec`. That
asymmetry between built-in and optional extensions forced
`@agentick/reconciler-react` to depend on harness packages, which
blocked harness packages from adding `/react` subpaths.

ADR 27 makes built-ins follow the same augmentation pattern as
optional extensions — uniformly. Reconciler-react becomes a true leaf,
any harness can have a `/react` subpath, and the modularity story
becomes real.

**Expected pain points (anticipated, not yet hit):**
- Generic snapshot iteration replaces hardcoded `bridges.knobs`,
  `bridges.state` access in `reconciler-harness.ts`. Snapshot shape
  changes from named fields to mapped type.
- Test relocation: ~13 reconciler-react `__tests__/` spec files get
  redistributed per harness. Each move requires import updates.
- Cross-harness tests (snapshot-restore.spec.tsx) need a home. Probably
  @agentick/session.
- TypeScript module augmentation has subtle visibility rules — if a
  consumer doesn't transitively import the harness package, it won't
  see the augmented slot.

---

## Entry log

<!-- 2026-05-26 — refactor begins -->

### 2026-05-26 — Stage 0: docs landed first

Wrote ADR 27 + updated `CLAUDE.md` with the principles + created this
scratchpad. Doing this before any code change so the architectural
direction is captured BEFORE the dust of refactor. Future agents
reading the repo encounter the principles immediately.

**Decision:** ADR 27 sits alongside ADR 26 (not as a replacement).
26 is the harness shape; 27 is how harnesses compose into a modular
framework. They're complementary.

**Decision:** CLAUDE.md gets a "v2 modularity model" subsection — not
just a link to the ADR. The principles are loaded into every agent
conversation; non-negotiable for v2 work.
