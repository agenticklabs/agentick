# ADR 32 — Extension shape spectrum

**Status:** Active · 2026-06-07
**Builds on:** ADR 26 (Harness as the single shape), ADR 27 (Modular built-ins), ADR 31 (Self-similar slottable harness hierarchy)
**Touches:** `@agentick/spec-next` (no new types — documents the existing shape options), `skills/create-extension/` (will reference this ADR explicitly), Phase 5+ transport / plugin packages.

## TL;DR

**Not every "extension" is a harness.** "Extension" is a participation
hook — a module that wants to be told when its host (app, session,
gateway) is constructed. *What that module installs* lives on a
spectrum of six shapes, ordered by weight:

1. **Full harness extension** — BaseHarness subclass with substrate audit
2. **Namespace object** — plain JS state, installed via the same installer
3. **Pure bus subscriber** — no state, just listens
4. **Reconciler contributor** — render-time output transform
5. **Descriptor + hook** — declarative typed config composing over an existing harness
6. **Tool / formatter** — first-class registration via `createTool` / `defineFormatter`

The formal `AppExtension` / `SessionExtension` / `GatewayExtension`
interface is **shape-agnostic** — it imposes timing (an `install(installer)`
callback fired at host construction), not shape. The shape an extension
picks is a design choice driven by what the extension owns.

**Harness-shape is justified when substrate participation pays off.**
Substrate participation costs ~150-400 LOC of harness + ~50 LOC of
augmentation + ~200 LOC of conformance + module-augmentation
discipline. It pays off when mutations need audit, state is swappable
across backends, cross-process routing matters (cluster mode), or
async commands need idempotency/retry stories. If none of those apply,
a lighter shape is the right call.

**Gates is the load-bearing counter-example** — it's a real "extension"
in adopter vocabulary (`useGate(name)` + a `gate()` descriptor maker)
but is **not a harness**: no state of its own (gate values live in
KnobsHarness), no async commands, no audit envelopes the model
should see, no swappable backend. Pure declarative composition over
an existing harness. Trying to "fix" gates by making it a harness
would be adding cost for no value.

This ADR pulls the spectrum out of implicit knowledge (scattered
across the example impls knobs/state/timeline/gates) into an explicit
decision framework — including for Phase 5+ work where transports
and plugins each need to pick a point on the spectrum.

## The six shapes

### 1. Full harness extension

**Cost.** BaseHarness subclass, protocol type, augment.ts (`HookBridges`
augmentation), conformance suite, extension factory (`withX()`),
typically `/react` + `/testing` subpaths. Real engineering work —
the `create-harness` skill is ~900 lines for a reason.

**What it owns.** Substrate participation: every state mutation
flows through an Operation (`requested → before → terminal` envelopes),
landing in both the bus (for observers) and the journal (for audit /
hibernate / restore). Inbox routing for cross-actor messaging.
Lifecycle handlers + middleware. Snapshot/restore via
`SnapshotCapable` feature detection.

**When you pick it.**

- Mutations should appear on `session.events()` so the model or
  admins can see what happened.
- The harness state needs to survive hibernate/restore via
  `exportSnapshot()` / `importSnapshot()`.
- Adopters may want to swap the backend (Redis-backed knobs, Postgres
  timeline, remote sandbox provider, etc.) — the protocol contract
  enables this.
- Cross-process operation matters: in cluster mode, inbox messages
  to this harness route across nodes via `@effect/cluster`. Per-tenant
  isolation via per-session substrate factories falls out of the
  hierarchy.
- Async commands have a "this might fail / be retried / be idempotent
  on replay" story — `runOperation` handles all of it.

**Examples in v2.**

- `KnobsHarness` — model-visible reactive state with `set_knob`
  dispatch tool. Mutations are audit-relevant.
- `StateHarness` — adopter session-state stash. Persists via journal.
- `TimelineHarness` — conversation log with two-tier append-only +
  projection model. Audit-critical.
- `SandboxHarness` — exec/file/net with ACL and per-session learned
  permissions. Every command is auditable.
- `MCPHarness` — per-MCP-server connection with resource discovery.
  Per-session learned tool catalog.
- `SubscriptionsHarness` — subscription intents driving connector
  routing.
- `ToolExecutorHarness` — per-session tool registry + dispatch
  framework.
- `LoopExecutorHarness` — per-session execution loop (one BaseHarness
  per session).
- `ExecutorHarness` — model adapter wrapper with streaming + cache
  surfacing.

### 2. Namespace object

**Cost.** A plain class or factory, no BaseHarness inheritance.
Installed via `installer.registerNamespace(name, plainObject)`. Module
augmentation to type the slot. No conformance suite, no operation
framework, no inbox.

**What it owns.** Mutable state inside a closure. The namespace is
addressable from React via `useBridges().<name>`, but mutations don't
emit envelopes and reads aren't go through any framework machinery.

**When you pick it.**

- Shared state across components/tools but no audit need.
- No swappable backend (this is the only impl that'll exist).
- Cross-process routing doesn't matter (single-process is fine).
- Async commands aren't part of the contract (or are wrapped manually
  with try/catch).
- Less than ~200 LOC of state-management code.

**Examples in v2 today.** None ship as namespace-objects — every
current installer-registered slot is a harness. The shape is
available; the framework just hasn't needed it yet.

**Hypothetical adopter use:** a small "session note pad" extension
that holds a `Map<string, string>` and exposes `get` / `set` / `delete`,
with no audit interest. Harness shape would be overkill; namespace
object fits.

**Migration path.** If a namespace object grows to need audit /
hibernate / cluster routing, promote it to a harness. The
augmentation key stays the same; consumer code typed against
`useBridges().<name>` doesn't change shape.

### 3. Pure bus subscriber

**Cost.** Three lines of code. `bus.subscribe(query)` + a callback.
No formal extension needed (or, optionally, a thin extension whose
install body sets up the subscription).

**What it owns.** Nothing. It reacts to events; it doesn't hold
state visible to the rest of the framework.

**When you pick it.**

- Logging, telemetry, OTel export, devtools tunnel.
- Side-effect work that consumes events (write to a log file, push
  to a remote endpoint, emit metrics).
- No reverse path (nobody calls *into* this thing).

**Examples in v2.**

- `@agentick/devtools` (planned) — subscribes to gateway/app bus,
  exposes events to a dev tool over SSE. Pure subscriber.
- Future logging plugin — replaces v1's `loggingPlugin` (~270 LOC).
  Reduces to three lines plus config.

**Why no formal extension is needed.** Adopters can write
`bus.subscribe(query, options).pipe(...)` directly in their app
setup code. The formal `AppExtension` interface is overkill for
"call subscribe and capture the unsubscribe."

**When to wrap in a formal extension anyway.** If the subscriber
ships as a reusable package adopters install via the extensions
array, the formal extension provides a discoverable name + an
`onClose` lifecycle hook. Pattern: a 10-line `AppExtension` whose
install body sets up `bus.subscribe` and registers `onClose` to
clean up.

### 4. Reconciler contributor

**Cost.** A plain object satisfying the `Contributor` protocol from
`@agentick/reconciler-next`. Registered via `app.registerContributor(...)`
or `appOptions.contributors: [...]`.

**What it owns.** Render-time behavior. Contributors plug into the
JSX → IR pipeline:
- Content-block contributors (parse `<custom-block>` JSX → IR nodes)
- Semantic HTML contributors (`<h1>` → `{ kind: "heading", level: 1 }`)
- Formatter contributors (transform IR before compilation)
- Hook contributors (register custom hooks the reconciler exposes
  via `useBridges()`)

**When you pick it.**

- The thing shapes what the model sees (compiled context output).
- It's render-time only — no state survives past `compile()`.
- It's reconciler-specific (a React contributor doesn't make sense
  for a hypothetical Solid reconciler).

**Examples in v2.**

- `@agentick/formatters-next` — Markdown, XML, PlainText formatter scopes.
- Semantic HTML contributors in `@agentick/reconciler-react-next` —
  headings, lists, tables, paragraphs.
- Content-block contributors — `<Image>`, `<Code>`, `<Json>`,
  `<Document>`.

**Why not a harness?** Contributors are render-time; the audit/state
machinery doesn't apply. The reconciler already journals its
mount/unmount/render lifecycle; individual contributors don't add
new events.

### 5. Descriptor + hook

**Cost.** A typed data shape + a React hook composing over an
existing primitive (usually a harness). No `BaseHarness`, no formal
extension. Just exports.

**What it owns.** Typed config. The descriptor IS the data; the hook
is the consumer surface. State lives in whatever primitive the hook
composes over.

**When you pick it.**

- The thing is purely declarative.
- It has no state of its own — values live in another harness (or
  another reactive primitive).
- Adopters interact via a React hook + a typed descriptor.

**Examples in v2.**

- **Gates** (`@agentick/gates-next`) — `gate(name, options)` builds a
  typed descriptor; `useGate(name)` returns `[state, set]` that
  composes over `useKnob`. A gate's value IS a knob value (a
  three-state `inactive`/`active`/`deferred` knob). Zero state in
  the gates package itself.

**Why this is the load-bearing example.** Trying to "fix" gates by
making it a harness would create a `GatesHarness` that duplicates
KnobsHarness's state model under a different name. No audit gain
(knobs already audits); no swappable-backend gain (the backend is
knobs); no cluster gain (knobs handles that). Pure architectural
churn.

The shape is right when the abstraction is *just* declarative
composition over an existing primitive. If you find yourself adding
state to a descriptor-only extension, that's the signal to promote
to a harness.

### 6. Tool / formatter registration

**Cost.** A `createTool(...)` call or `defineFormatter(...)` call.
Inline in JSX or in extension install. No package or formal
extension needed for adopter-defined tools.

**What it owns.** A function (tool handler) or a transform
(formatter).

**When you pick it.**

- Just a tool the model can call.
- A formatter the reconciler can apply.
- No state survives between calls.

**Examples in v2.**

- Every adopter-defined tool — `createTool({ name, input, handler })`.
- Bundled tools like `set_knob` (built by `<Knobs />`).

**Why not a harness?** Tools are stateless function calls. Stateful
tools are usually a sign you should be using a harness — the tool
becomes a method on the harness, and `session.dispatch` routes to
it.

## The decision tree

For adopters or contributors writing a new thing:

```
Does it produce events the model or admins should see in
session.events()?
  YES → Shape 1: full harness extension.
  NO ↓

Does it need mutable state that survives the call stack?
  YES → Does the state need audit / swappable backend /
        cluster routing?
        YES → Shape 1: full harness extension.
        NO  → Shape 2: namespace object.
  NO ↓

Does it transform what the model sees in compiled context?
  YES → Shape 4: reconciler contributor.
  NO ↓

Does it react to events to drive a side-effect (log / push /
emit)?
  YES → Shape 3: pure bus subscriber.
  NO ↓

Is it declarative — typed config + hook composing over an
existing primitive?
  YES → Shape 5: descriptor + hook.
  NO ↓

Is it a tool the model invokes or a formatter the reconciler
applies?
  YES → Shape 6: createTool / defineFormatter.
```

**When in doubt, default to the lighter shape.** Promoting a
namespace object to a harness later is mechanical (the augmentation
slot stays the same). Demoting a harness back to a namespace object
is painful (call sites typed against `HookBridges` lose their
protocol contract).

## What this means for Phase 5+ work

### V1 gateway plugins reshape per shape

The three plugins in v1's gateway (`packages/gateway/src/plugins/`)
take different shapes:

| V1 plugin | LOC | V2 shape | Reasoning |
|---|---:|---|---|
| `mcp-server` | ~400 | Shape 1: harness extension (`MCPServerHarness`) | Per-connection state, request/response routing, resource discovery, tool catalog — substantial audit-worthy state. |
| `openai-compat` | ~400 | Shape 1: harness extension (`OpenAIShimHarness`) | Same reasoning — per-request translation state, streaming buffer, SSE accumulator. |
| `logging` | ~270 | Shape 3: pure bus subscriber | Reads events, writes to a destination. No reverse path. ~270 LOC in v1 mostly because it had to integrate with the plugin machinery; in v2 it's actually small. |

### V1 transports reshape per shape

All six v1 transports (WS / HTTP / SSE / Unix socket / Local /
Embedded) are **Shape 1: harness extensions**. Per-connection state,
bidirectional translation, audit-relevant lifecycle. Each ships as
its own `GatewayExtension` package installing a `TransportHarness`.

### Skills, scheduler, memory — coming in Phase 5

| Capability | Shape | Reasoning |
|---|---|---|
| `SkillsHarness` (OpenClaw / Hermes "skills") | 1 — harness | Skills are searchable, shareable, persistent. Cross-session library. Audit matters (which skill was invoked, when, by whom). Swappable backends (in-memory, sqlite, remote registry). |
| `SchedulerHarness` (cron / heartbeat for autonomous agents) | 1 — harness | Schedule state persists across restarts. Cross-process routing matters (cluster mode runs schedules on whichever node is up). |
| Memory extension | 1 if audit matters; 2 if it's a write-through cache | Depends on the design. Persistent memory with embeddings → harness. Per-session prompt-injection cache → namespace object. |

## What this does NOT propose

**New formal interfaces.** The existing `AppExtension` /
`SessionExtension` / `GatewayExtension` interfaces are
shape-agnostic. They impose timing, not shape. Adding more formal
interfaces (`BridgeExtension`, `ObserverExtension`,
`ContributorExtension`, etc.) would prematurely classify what should
remain composition.

**New spec types.** This ADR documents existing primitives. The
spectrum is already there; the doc makes it discoverable.

**Migration of existing impls.** Every current harness extension is
in shape 1 because the framework historically nudged toward harnesses.
That's fine — the existing harnesses all justify their cost. The
spectrum applies to NEW work, not retroactive rework.

## Relationship to `create-extension` + `create-harness` skills

The `skills/create-extension/SKILL.md` skill already routes through
this decision tree informally (Paths A through D). With ADR 32
landed, the skill can reference this doc explicitly: "shapes 1-2
route to `create-harness`; shapes 3-6 route to ad-hoc patterns."

The `skills/create-harness/SKILL.md` skill is the mechanical walk
for shape 1 only.

When a future `customize-[harness]` family lands, those skills are
shape-1 specialisations.

## Open questions

1. **Should namespace objects (shape 2) get a `withX()` helper?**
   Currently every shape-1 harness ships a `withX()`
   `SessionExtension` factory. A shape-2 namespace object could too —
   the helper would be one line of glue. Probably yes when an
   adopter-published package wants the canonical install pattern.

2. **Cross-cutting observers (shape 3) and `bus.subscribe`
   subscription semantics.** Phase C's cursor protocol gives us
   late-subscriber resume. Pure subscribers may want to pass
   `{ fromCursor }` to replay missed events. Worth a follow-up
   pattern doc once we ship a non-trivial observer.

3. **Reconciler contributors (shape 4) — should they have a
   `withX()` factory analog?** Currently contributors are passed in
   the app options directly. A `withX(contributor)` helper would let
   them ride the same install machinery as other extensions. Worth
   considering when contributor packages multiply.

## References

- `docs/proposals/v2/blueprint/26-harness-api-shape.md` — Harness as the single shape (defines shape 1)
- `docs/proposals/v2/blueprint/27-modular-built-ins.md` — Modular built-ins (shape 1's discipline)
- `docs/proposals/v2/blueprint/31-harness-hierarchy.md` — Self-similar hierarchy (shape 1's composition rules)
- `docs/proposals/v2/blueprint/12-gateway.md` — Gateway extensions reshape from v1 plugins
- `docs/proposals/v2/V1-GATEWAY-PARITY-TRACKER.md` — v1 plugin/transport reshape disposition
- `skills/create-extension/SKILL.md` — Adopter-facing entry skill (routes per shape)
- `skills/create-harness/SKILL.md` — Shape 1 mechanical walk
- `packages/gates/` — Shape 5 reference impl
- `packages/knobs/` — Shape 1 reference impl
