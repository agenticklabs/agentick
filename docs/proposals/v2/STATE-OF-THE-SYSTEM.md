# State of the System — 2026-07-22 (the map)

One page to hold the whole thing in your head. AS-IS is what's committed on
`feat/v2` today; GOING is the approved direction. Deep docs are linked, not
duplicated.

## 1. Server side — the execution stack (AS-IS, post-extraction)

```
BaseHarness (1,715 lines; was 2,953)      — identity · inbox · channels · lifecycle
 ├─ CommandRunner        (command-runner.ts)   — declarations/registry/invocation
 │    command() / commandStream() / commandEffect() / commands() / chunk interceptors
 │    runOperation INJECTED ↓
 ├─ OperationRunner      (operation-runner.ts)  — THE EXECUTION KERNEL (v1 Procedure++)
 │    phases · journal+bus · idempotent replay · interceptor cascade · terminals ·
 │    makeEvent (principal stamp) · spans        deps: journal/bus/policy/interceptors(closure)
 ├─ middleware.ts        — composition primitives (chain/compose/lift/tier-4 CallMiddlewareRef)
 └─ harness-protocol.ts  — Effect↔Promise/stream bridges
```

- **Everything is a command** (ADR 80/83/89 — COMPLETE): `model:generate[_stream]` →
  nested `model:provider-request` (native boundary, raw-chunk hooks), `loop:tick`,
  `loop:run-execution` (a commandStream — events are chunks, onEvent retired),
  `session:snapshot/restore/set-model`, `tool:dispatch`. Hooks/guard/journal
  everywhere; lifecycle = projection (LifecycleStore deleted).
- **Harnesses** (session-owned siblings, session = composition root, loop =
  orchestrator): compiler (was reconciler), model-executor (was executor),
  tool-executor, timeline, knobs, state, tasks, elicitation, resources, skills,
  prompts, mcp, gates, credentials, session, app, gateway.
- **Adapters**: `defineLanguageModelAdapter` factory (prepareRequest/send/openStream
  typed TRequest); openai(chat)/anthropic/google/ai-sdk; `openai.responses()` decided-
  not-built (C5).
- **Telemetry**: three-rung span ladder (`telemetry: true` → gen_ai.* semconv + cost;
  per-send functionId; surgical spanMiddleware/annotateOperationSpan). Guide:
  runtime README §Observability.

## 2. Server side — stores (AS-IS, stable since the July convergence)

```
Store<T,Q,M>  — the universal seam (query/mutate/watch?/backend)
 ├─ CollectionStore — keyed (tasks, knobs, state, session, resources, skills, prompts)
 └─ LogStore        — append+seq (timeline; history() is the cursored read)
View<TCache,TStore> / LogView — the SYNC projection a harness holds IFF it has a
sync read surface (credentials = deliberate async-only no-view)
```
Snapshot/restore: `session:snapshot`/`restore` commands fold every `SnapshotCapable`
bridge generically (Step 6 done); `migrateSnapshot` seam; kill/resume green.
Deep doc: `store.md`.

## 3. The wire (AS-IS)

- **Three primitives** (only response currency differs): command (req-res→Promise),
  read RPC (req-res→Promise, side-effect-free), subscription (scope+query→stream).
- **Extension mechanism (settled)**: spec `WireMethods` module augmentation (typed
  row = the contract) + gateway `defineWireExtension` handler + ADR-87 client verb.
- **Transports**: http (SSE) / websocket / unix-socket / in-process; security
  defaults landed (loopback bind, no-`*` CORS, CSRF handshake, Host/Origin +
  loopback-proxy rule).
- Events: CQRS — reads are event-driven channels (Design-B in-band snapshot-first),
  writes are commands. `executedBy` provenance: agentick/client/provider:anthropic
  (optimistic)/mcp:<serverId>; openai needs Responses API; google = never (by design).

## 4. Client side (AS-IS — the murky part, honestly)

ADR-87 registration is uniform; the handle CONTRACTS are not (four passes, no
cross-cutting owner):

| Surface | Shape today | Gap |
|---|---|---|
| `session.elicitations` | stream-handle + respond | live-only (no list of pending) |
| `session.clientToolCalls` | stream-handle + respond | live-only; route/confirm are LOOSE session methods |
| `session.knobs` | get/set/subscribe | values only (no descriptors); `key` vs server `id` |
| `session.tasks` | collection view | closest to correct |
| timeline | `timelineView()` FREE FACTORY (window: seed/tail/prepend/append/clientId reconcile) | not a sub-handle; no wire history read; Cursor≠seq |
| `session.send` | handle: events() + .result (+ onBusy steer/queue, telemetry.functionId) | send handle is GOOD — the model for the rest |

React bindings: none first-party (adopters hand-roll useSyncExternalStore).

## 5. Design lineage (how we got here — the iterations)

1. **Store/View convergence** (server state unified; thin-shared-conformance lesson)
2. **CQRS + Design-B** (client reads = fold event streams; no client cache;
   in-band snapshot-first; `CollectionView` named)
3. **ADR-87 sub-handles** (per-package client/ registration — the mechanism)
4. **Four handle passes** (stage-3 tools, timeline window, knobs, tasks) — each
   locally right, collectively incoherent ← the current murk
5. **B1 one-shot prompt + friction log** (validation pivot: discovery + React
   ergonomics + doc-drift are the weak clusters)
6. **B2 contract draft** (`client-handles.md`, AWAITING RYAN): thin mandatory core
   (`onChange`/`close`) + profiles (Enumerable/Streamable/Respondable) + write
   verbs DERIVED from wire defs + per-handle read views DESIGNED +
   `runClientHandleConformance` making divergence impossible.

## 6. Where we're going (approved direction)

```
NOW  : handles heterogeneous · live-only requests · values-only knobs · free-factory timeline
NEXT : B2 arc (design review → conformance suite → server prereqs:
       pending-request enumeration · KnobDescriptor[] on wire · session/timeline_history
       → handle refactors one-per-commit → session.timeline re-home
       → @agentick/client-react one-liners over the uniform core)
THEN : Phase C cut list (XHarness→X sweep · pnpm-11/versioning · <Skill> decision ·
       devtools · openai.responses() · ai-sdk request-half · Anthropic SDK bump ·
       docs sweep · Ernesto — gate met, Ryan's call)
```

**Read order for the deep dive:** `client-handles.md` (the B2 draft, your review
pending) → `one-shot-friction-log.md` (the evidence) → `store.md` (server state
taxonomy) → STATUS.md ROADMAP (the queue) → V1-PARITY-TRACKER.md (what was
recovered).
