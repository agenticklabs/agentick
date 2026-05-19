# Agentick v2 — Architecture Blueprint

**Status:** Synthesis Draft · last updated 2026-05-08

This blueprint synthesizes the v2 proposal set
(`harness-principle`, `compiled-spec`, `spec-package`, `compiler-harness`,
`renderer-harness`, `loop-executor`, `executor`, `runtime`, `cluster`,
`gateway`) into one navigable picture. It is a working document for the
author, future maintainers, integrators, and code agents working on the
implementation. It does not replace the source proposals — it indexes,
diagrams, and crystallizes them, and flags gaps that the proposals leave
open.

## Reading order

The numbered docs are sortable identifiers; the recommended reading
order is below. **`19-foundation.md` was added late and should be read
right after `01-harness-principle.md`** — it describes the substrate
every harness inherits from (operations, journal, bus, OTel projection)
and the rest of the blueprint sits on top of it.

```
00-overview.md                    (this file)
01-harness-principle.md           the five protocol surfaces (read second)
19-foundation.md                  the substrate underneath (read third)
02-data-model.md                  the wire shapes everything else exchanges
03-reconciler-harness.md            producer of RenderedTree (v2 ships @agentick/reconciler-react)
04-formatters.md                   semantic content → rendered content (pure functions, see ADR 22)
05-loop-executor.md               tick orchestration
06-executor-harness.md            RenderedTree → provider → result
07-tool-executor.md               handler dispatch
08-session-harness.md             identity, state, timeline, persistence
09-app-harness.md                 session lifecycle, cross-cutting
10-events-handlers-inbox.md       five-surface integration substrate
11-cluster.md                     optional distributed wrapper
12-gateway.md                     optional ingress wrapper
13-package-graph.md               who depends on whom; Effect-free line
14-state-tiers.md                 fiber tree / session-side / Scope / persistence
15-flows/                         end-to-end sequence diagrams
16-glossary.md                    every v2 term in one place
17-open-questions.md              deduped across all source docs
18-traceability.md                blueprint section → source proposal map
20-pluggability-charter.md        protocol-first principle in engineering terms
21-reconciler-implementation.md   low-level shape of @agentick/reconciler-react
                                  (host config, contributors, hook bridges)
```

## Annotation conventions

Throughout the blueprint:

- **`[V1-INHERITED]`** — v2 keeps the v1 shape (sometimes promoted, sometimes
  refined). The v1 file path is cited.
- **`[V1-REPLACED]`** — v2 replaces a v1 concept. Both old and new are named
  so readers can map their mental model.
- **`[GAP]`** — the source v2 proposals leave this undefined. The blueprint
  describes the surface area but does not invent a shape.
- **`[PLACEHOLDER]`** — the blueprint synthesizes a placeholder type or
  behavior from v1's existing shape, marked clearly as a starting point that
  needs sign-off, not a final decision.
- **`[PROPOSAL]`** — the blueprint takes a position on a contradiction or
  open question in the source proposals. Always pending sign-off.
- **`[SOURCE: doc.md §X]`** — direct citation to a source proposal.

These markers are also collected in `18-traceability.md`.

## The four pillars of v2

The architecture rests on four load-bearing decisions:

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. THE HARNESS PRINCIPLE                                         │
│    Every meaningful layer is an addressable actor with five      │
│    integration surfaces: commands, inbox (typed messages),       │
│    lifecycle handlers, middleware, events.                       │
│                                                                  │
│ 2. THE SPEC FIREWALL                                             │
│    Anything crossing harness boundaries is JSON-shaped data.     │
│    Effect, React, SDK clients, renderer instances, closures —    │
│    none of these cross the wire.                                 │
│                                                                  │
│ 3. LIBRARY-FIRST RUNTIME                                         │
│    The runtime is in-process by default. Cluster and gateway     │
│    are optional wrappers, not architectural forks.               │
│                                                                  │
│ 4. REAL REACT, LIVING TREE                                       │
│    The reconciler harness is a living mounted application that        │
│    emits multiple artifacts (RenderedTree, rendered         │
│    string, rendered resource), not a one-shot compiler.          │
└──────────────────────────────────────────────────────────────────┘
```

If you only remember one thing, remember that the harness pattern is
fractal: every layer below has the same shape (commands / events /
interceptors / outcomes), and the same observability and testing strategy
applies to all of them.

## The harness stack at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│                          Optional ingress                       │
│   ┌────────────────────────────────────────────────────────┐    │
│   │   @agentick/gateway   (HTTP / WS / SSE / RPC adapters) │    │
│   └────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────────┐
│                       Optional topology wrapper                 │
│   ┌────────────────────────────────────────────────────────┐    │
│   │   @agentick/cluster   (sharding, activation, fan-out)  │    │
│   └────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────────┐
│                     Library-first runtime core                  │
│                                                                 │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │ App harness                                              │  │
│   │   createSession · runOnce · getSession · listSessions    │  │
│   │   ┌────────────────────────────────────────────────────┐ │  │
│   │   │ Session harness   (one instance per session)       │ │  │
│   │   │   send · dispatch · render · append · spawn ·      │ │  │
│   │   │   abort · pause · resume · hibernate · restore     │ │  │
│   │   │   ┌──────────────────────────────────────────────┐ │ │  │
│   │   │   │ Loop executor   (one instance per execution) │ │ │  │
│   │   │   │   runExecution · abort                       │ │ │  │
│   │   │   │   ┌──────────────────────┬───────────────┐   │ │ │  │
│   │   │   │   ▼                      ▼               │   │ │ │  │
│   │   │   │ reconciler harness      Executor harness      │   │ │ │  │
│   │   │   │ (mount, compile,   (project, execute,    │   │ │ │  │
│   │   │   │  render, snapshot)  normalize, run)      │   │ │ │  │
│   │   │   │   │                    │                 │   │ │ │  │
│   │   │   │   ▼                    ▼                 │   │ │ │  │
│   │   │   │ Formatter harness   Tool executor harness │   │ │ │  │
│   │   │   │ (semantic content  (dispatch, validate,  │   │ │ │  │
│   │   │   │  → rendered)        confirm)             │   │ │ │  │
│   │   │   └──────────────────────────────────────────┘   │ │ │  │
│   │   └───────────────────────────────────────-──────────┘ │ │  │
│   └──────────────────────────────────────────-─────────────┘ │  │
└──────────────────────────────────────────────────────────────┘──┘
```

Eight harnesses (App, Session, Loop, React, Renderer, Executor, Tool
Executor — plus arguably the Cluster/Gateway wrappers themselves). Each
one implements the same four-surface pattern.

## What changed from v1

```
v1 concept                          v2 concept
──────────────────────────────────────────────────────────────────────
COM (1268 LOC mutation API)         GONE — no intermediate object model
RenderedTree (Map-based,       RenderedTree (JSON-shaped IR
  contains live Renderer +            with FormatterRef + JSON declarations
  ExecutableTool refs)                only)
COMInput (model adapter input)      GONE — collapsed into RenderedTree
EngineInput                         GONE — collapsed into RenderedTree
Tool.audience field                 ToolDeclaration.exposure[]
SectionEntry.intent (closed enum)   GONE — `id` + `title` + content suffice
EphemeralEntry / EphemeralPosition  Compile/runtime-only transient render
                                      input; not a distinct compiled kind
StructureRenderer                   Formatter harness + runtime projection
                                      (split into two responsibilities)
ExecutionRunner.transformCompiled   Loop / executor interceptors + replace
ExecutionRunner.executeToolCall     Tool executor before-dispatch interceptor
LifecycleCallbacks.onTickStart/...  Session interceptors on send/render/...
EventEmitter on session             Unified PubSub<ProtocolEvent>
~43 raw stream event types          Wrapped in EventEnvelope with
                                      surface / name / phase / outcome
ModelOutput (provider-flavored)     ExecutionResult (canonical, success-
                                      only) wrapped in ExecutorTerminal
Session = sharded entity (by        Session = library object first;
  default, distributed-by-default)    cluster wraps it for distribution
```

`13-package-graph.md` and `02-data-model.md` go deeper.

## Glossary in one paragraph

A **harness** is a layer with four surfaces (commands, events,
interceptors, outcomes). A **command** is a typed request to do work. An
**event** is a past-tense notification. An **interceptor** participates in
command execution and may proceed/defer/veto/replace. An **outcome** is
the terminal verdict (`succeeded`/`failed`/`canceled`/`vetoed`/`replaced`/
`deferred`). The **RenderedTree** is the JSON-shaped IR produced by
the **reconciler harness** and consumed by the **loop executor** which calls
the **executor harness** for provider runs and the **tool executor
harness** for handler dispatch. **Renderer** is a separate harness that
turns semantic content into rendered content (markdown/XML/etc.). The
**session harness** owns identity and timeline; the **app harness** owns
sessions; **cluster** and **gateway** are optional wrappers. The **spec
firewall** says anything crossing a harness boundary must be JSON-shaped.

For the full glossary with v1 cross-references, see `16-glossary.md`.

## How to use this blueprint

- **Designing a feature:** find the harness it belongs to, read that doc
  plus `01-harness-principle.md`, then check the relevant flow diagram in
  `15-flows/`. Search `17-open-questions.md` for nearby unresolved items.
- **Implementing a harness:** the per-harness doc has commands, events,
  interceptors, outcomes, and known gaps. Use `02-data-model.md` for the
  exact types it consumes and produces. Cross-check `13-package-graph.md`
  for what depends on it.
- **Reviewing v2 architectural changes:** start at this overview, then
  `01-harness-principle.md`, then the specific harness doc. The
  `[V1-REPLACED]` markers anchor each move.
- **Triaging an open question:** `17-open-questions.md` is the single
  consolidated list. Each item references the source doc.

## Status of this blueprint

This is a living document like the source proposals. Sections are marked
`Status: Synthesized`, `Status: Synthesized with placeholders`, or
`Status: Gap-noted` so readers can tell at a glance whether a section is
crystallized, awaiting sign-off, or known to be incomplete.
