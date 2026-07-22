# @agentick/session-next

**SessionHarness — one agent run, one long-lived conversation.**

The integration site where v2's harness surfaces — compiler, loop
model-executor, tool executor, timeline, knobs, state, elicitation, tasks,
prompts — wire together for a single conversation. One session per
human dialog; sessions are created by an app harness and persist
across ticks.

Private workspace package. Bundled into the `agentick` metapackage;
not published independently.

## Quick start

Most adopters never construct a `SessionHarness` directly — they
write an agent (a function or React component returning JSX
declarations) and call `createApp(MyAgent, options).run(input)`. The
app harness spins up a session per run.

For session-level commands (REPL apps, agent-side asks not initiated
by tool dispatch, snapshot/restore workflows), reach for the
session surface directly:

```ts
// createSession takes no messages — it opens (or rehydrates) a session.
// Messages are handed to session.send below.
const session = await app.createSession({ sessionId: "s:1" });

// Built-in harness surfaces. Each is added via TypeScript module
// augmentation by its own package (ADR 27); the `agentick` metapackage
// bundles all of them, so every session in the metapackage has them.
session.timeline      // TimelineHandle — durable conversation history
session.knobs         // KnobsHandle — model-facing reactive config
session.state         // StateHandle — adopter-stash K/V (not model-visible)
session.tasks         // Tasks — long-running work registry
session.resources     // Resources — resource read-projection (ADR 62)
session.gates         // GatesHandle — unified gate registry
session.gate("write") // GateHandle | undefined — per-gate handle
session.model         // ModelSelectionHandle — model selection / swap facade (ADR 89 §2)

// Elicitation — ask the user for typed input.
session.elicitation   // ElicitationHarnessProtocol — raw substrate
session.elicit        // Elicit — sugar surface (preferred)

// Dispatch + send.
await session.dispatch("rename-file", { from: "a", to: "b" });
await session.send({ messages: [{ role: "user", content: [...] }] });
```

Each surface is contributed by a bundled harness package
(`@agentick/timeline-next`, `-knobs-`, `-state-`, `-tasks-`,
`-resources-`, `-gates-`, `-elicitation-`) via `declare module
"@agentick/spec-next"` — no slot is hardcoded in spec. On the reference
`SessionHarness` each is also reachable as `bridges.<name>` inside the
compiler/executor flow; the two views point at the SAME instance.

## `session.elicit` vs. `session.elicitation`

Per ADR 43 §"Sugar surfaces converge": every session exposes two
surfaces for asking the user:

| Surface               | Type                               | Use when                                                                                                                             |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `session.elicit`      | `Elicit` (sugar)                   | typed single-call asks — `text`, `confirm`, `select`, `number`, `boolean`, `url`, `multiSelect`, `requireUrls`, plus `try*` variants |
| `session.elicitation` | `ElicitationHarnessProtocol` (raw) | structured request with `Standard-Schema` validator + bespoke timeout/abort/hints control                                            |

The sugar `Elicit` interface is identical to what tool handlers see
via `ctx.elicit` (whether dispatched in-process or via MCP server).
Adopter code using `await session.elicit.text(...)` is the canonical
shape; reach for the raw protocol only when the sugar is too narrow.

This session is also the **escalation terminal / hop** for input requests
that originate deeper in the ownership tree: a long-running task's
`ctx.elicit` (or a spawned sub-agent's) escalates up the spawn lineage
(`parentSessionId`) as a nested `inbox.ask`. A **root** session resolves it
here against the real client; a **spawned** session forwards it one hop up
to its own spawner (appending a `lineage` provenance entry). Adopters don't
wire this; it's handled in `handleMessage`. See ADR 69.

**`session.interceptEscalation(handler)` (ADR 69 T2a)** lets an ancestor
session **mediate its descendants' input requests** instead of blindly
forwarding — the value of a chain over a dumb pipe. The handler is consulted
first on every hop the session receives:

```ts
// A parent agent answering / denying / forwarding a sub-agent's elicit.
const unsub = session.interceptEscalation(async (payload) => {
  if (payload.class === "elicit" && isKnownAnswer(payload)) {
    // Answer it here — the client is never bothered (dedupe / cache / policy).
    return { forward: false, response: { outcome: "accepted", value: cached } };
  }
  if (isRateLimited(payload)) throw new Error("denied"); // hard deny → origin rejects
  return { forward: true }; // fall through to forward / terminal
});
```

`{ forward: false, response }` short-circuits (this hop answered); a **throw**
is a hard deny (propagates as the origin's `ctx.elicit` rejection);
`{ forward: true }` falls through. Payload-agnostic — the handler branches on
`payload.class`; no policy DSL. With none registered, behavior is identical to
plain forward/resolve (T1 parity). The escalation envelope carries a `lineage`
path (origin task + session → each forwarding hop, principal-stamped best-
effort per ADR 51) the interceptor can inspect.

### Task-completion wake (the TASK-WAKE seam)

`handleMessage` also handles a second inbox message — a **task-completion
wake** (`session:task-wake`). When a backgrounded (Pattern B) task finishes
while **nothing is observing it**, its `TasksHarness` fires a fire-and-forget
`inbox.send` here carrying bounded completion metadata (task id, terminal
status, duration — **never raw output**) plus a `SendInput`. The session turns
it into a real turn via the **normal `session.send` path** — journaled, hooked,
streamed — so a wake that arrives while an execution is running STEERS into it
(no colliding second execution) and an idle session runs a fresh one.

Provenance is stamped authoritatively here: `metadata.source === "task-wake"`
plus `taskId` on both the execution and every wake message, so timelines and
clients attribute the synthesized turn to a task completion rather than a real
user turn. Consume-on-observe dedup + the wake policy itself live in
`@agentick/tasks-next` (per-task `wake` / app-wide `tasks.defaultWake`); the
session only owns the receive-and-send half. Verified by
`__tests__/task-wake.spec.ts` (real journaled wake execution + provenance,
observed → no wake, steering during a running execution).

```ts
// 90% case — sugar
const name = await session.elicit.text("Your name?");
const role = await session.elicit.select("Role?", ["admin", "user"] as const);

// Decline / cancel throw typed errors (exported from @agentick/spec-next)
import { ElicitationCancelled, ElicitationDeclined } from "@agentick/spec-next";

try {
  await session.elicit.confirm("Apply changes?");
} catch (err) {
  if (err instanceof ElicitationDeclined) {
    /* user declined */
  }
  if (err instanceof ElicitationCancelled) {
    /* user cancelled */
  }
}

// Non-throwing variants
const outcome = await session.elicit.tryConfirm("Apply?");
if (outcome.status === "accept" && outcome.value) {
  /* proceed */
}
```

See [`@agentick/elicitation-next`](../elicitation/README.md) for the
full `Elicit` interface contract.

## Surface integration

```
SessionHarness
├── compiler (per-tick, ephemeral)       — JSX → RenderedTree
├── loopExecutor (per-tick, ephemeral)     — runs ticks until terminal
├── toolExecutor (session-scoped)          — dispatch handlers; ctx.elicit, ctx.tasks
├── timeline (session-scoped, durable)     — message + section + event log
├── knobs (session-scoped, reactive)       — model-visible config
├── state (session-scoped, persisted)      — adopter-stash K/V (not model-visible)
├── gates (session-scoped, reactive)       — unified gate registry; session.gate(name)
├── elicitation (session-scoped)           — raw substrate primitive
│   └── elicit                             — sugar surface (Elicit interface)
├── tasks (session-scoped)                 — long-running work registry
├── resources (session-scoped)             — resource read-projection (ADR 62)
└── prompts (session-scoped, optional)     — when withPrompts mounted
```

Every harness whose lifecycle is bound to a session is constructed
once per session at create-time and surfaced both:

1. On the `SessionHarnessProtocol` (this object) for adopter code, AND
2. Via `bridges.<name>` inside compiler / executor flow.

The two views point at the SAME instance. `session.elicitation ===
bridges.elicitation` always.

## Constructing a `SessionHarness`

The reference `SessionHarness` takes the **substrate positionally**
(`journal`, `bus`, `inbox` — typically the AppHarness's, inherited as
defaults) and **everything else in an options bag**. The positional
shape makes the "substrate flows from parent by default" semantic
visible at every call site (ADR 31 §Two-phase construction).

```ts
import { SessionHarness } from "@agentick/session-next";

const session = new SessionHarness(journal, bus, inbox, {
  sessionId: "s:1",
  agent: <MyAgent />, // opaque — forwarded to compiler.mount({ element })
  compiler, // CompilerProtocol
  loop, // LoopExecutorProtocol
  modelExecutor, // ExecutorProtocol
  toolExecutor, // ToolExecutorProtocol
  target, // ExecutionTarget — the default model; overridable per send
  defaultMaxTicks: 8,
});

const handle = await session.send({
  messages: [{ role: "user", content: "Hello" }],
});
for await (const event of handle.events()) {
  /* StreamEvent: tick-start | model deltas | tool-dispatch | result | ... */
}
const result = await handle.result; // SendResult
```

`send` returns a `SessionExecutionHandle` — its event stream is reached
via `.events(): AsyncIterable<StreamEvent>`, plus
`.result: Promise<SendResult>`, `.status`, and `.abort(reason?)`. A
`send()` while an execution is
running is **steering** (ADR 53): the messages append to the timeline
(visible next tick), and the _in-flight_ handle is returned rather than
starting a fresh run.

### Injecting a model registry (`models`, #206)

Supply a `ModelRegistry` (provider → prefix → `ModelInfo`, merged over
`SEED_MODELS`) so the session can resolve the active model's
`contextWindow` for `useContextInfo`. Registries are federated: adapters
export fragments, the app merges and injects.

```ts
import { mergeRegistry, SEED_MODELS } from "@agentick/model-next";

new SessionHarness(journal, bus, inbox, {
  /* ... */,
  models: mergeRegistry(SEED_MODELS, { anthropic: { "claude-": myModelInfo } }),
});
```

### `requiredScopes` — the wire dispatch ceiling (#199)

A construction-bound scope ceiling checked at the wire dispatch gate —
structural, before policy and before any authorizer short-circuit. A
caller whose claims do not COVER (glob-aware) every listed scope is
Forbidden regardless of grants. Server-declared only (via
`CreateSessionInput`); deliberately **not** settable over the wire. It
requires claim-carrying identities — under a pure grant-table deployment
a non-empty ceiling makes the session wire-inaccessible, by design.

## The render ↔ runtime feedback loop

The session is the **per-render fact producer** and the **model
resolver** for the loop. Each `send` hands the loop two resolvers it
calls per tick — this is how the JSX tree renders _for the model it is
about to call_, _within the window it has left_:

- **`resolveRenderContext()`** (ADR 55) — the session folds every
  `RenderContext` slot it can supply into one envelope: the active
  model's window (via `effectiveModelInfo(target, models)`) into
  `contextInfo`, and the active model itself (a projection of the target)
  into `activeModel`. The loop threads the whole envelope into
  `renderTree({ renderContext })`; `useContextInfo` / `useActiveModel`
  read it **synchronously** while producing the IR. Future per-render
  facts (budget, principal) fold in here as augmented slots — no spec
  widening per fact.
- **`resolveModel(modelRef)`** (ADR 56) — resolves against the mount's
  `ModelBridge` (`bridges.models`). `useModelRegistration` registers
  tree-declared models on that bridge at render time; the loop looks up
  `declarations.model.modelRef` per tick and runs _that_ executor +
  target. No default registration — the loop falls back to the session's
  `executor`/`target` for the undeclared case. Precedence: **tick-IR >
  send > session**.

The loop stays a dumb conduit — no per-fact knowledge. The **backward**
half of the loop is the state applicator: after each tick the loop calls
`applyExecutorResult` (append the assistant message + this generation's
usage) and `applyToolResults` (append tool messages) so the _next_
render sees them via `<Timeline/>`.

**`notifyLifecycle` is the session's continuation decision (ADR 67).** The
loop calls it once per tick — AFTER the compiler tick-end has settled the
tree — with the settled `TickResult`, and the session folds every
continuation predicate it owns into ONE `TickEndForwardDecision`, in tier
order (mirroring the loop's own resolution):

1. **stop-force** — a trusted tree `stopAfterTick` (via `useLoopControl`) →
   `{ kind: "stop" }`. Tier-1; beats everything. Provenance (ADR 51): gates
   only ever _continue_-force, so a drained `stop` can only be trusted tree
   code — the model cannot stop-force.
2. **continue-force** — an active/blocking **gate** (evaluated here via
   `session.gates.handleTickEnd(result)`), a tree `continueAfterTick`, or
   **steering** (input appended mid-execution) → `{ kind: "continue" }`. A
   gate holds the loop open exactly as steering does.
3. **abstain** — `undefined` → the loop's own default (tool_use), under its
   `maxTicks` hard cap.

The settle-then-decide order is load-bearing: a tick-end effect may update a
knob a gate checks, so the tree must settle before the predicates read it.
Gate evaluation lives here, not in the compiler mount — `useGate` is
registration-only. Since ADR 89 §4 the SETTLE itself is a session-registered
`onAfterLoopTick` forwarder (below), awaited in the `loop:tick` command
cascade — before the command terminal, hence before this decide.

## The lifecycle projection — the session wires it (ADR 89 §4)

The React `useOn*` hooks are a **projection of the command-hook system** —
there is no bespoke lifecycle feed. The session, as the composition root,
registers the forwarders at construction (`src/lifecycle-projection.ts`)
and unhooks them on `close()`:

- **`loop:run-execution` / `loop:tick` / `tool:dispatch`** — tier-2 hooks on
  the (app-shared) loop + tool executor, identity-filtered by the payloads'
  `mountId` / `sessionId` so each session projects only its own mount.
  tick-start and the tick-end **settle** are AWAITED in-cascade; the rest are
  fire-and-forget. Tool events use the around form (`onToolDispatch`) so a
  HARD handler failure projects `tool-end (failed)` + `useOnError`
  (`phase: "tool"`); a FAILED executor terminal projects `useOnError`
  (`phase: "model"`).
- **`model:generate[_stream]`** — tier-4 call-scoped middleware wrapped
  around each `loop.fx.runExecution` (`withCallMiddleware`), so the
  projection reaches WHICHEVER executor instance runs a tick, including a
  per-tick `<Model>`-swapped executor (ADR 56) outside the session's
  interceptor tree.
- The target is the compiler's optional `LifecycleProjectionTarget`
  capability (`dispatchLifecycle`); a compiler without it gets no
  projection.

## `defineSession` — adopter-facing factory

Most adopters use `createApp(MyAgent, options)` which constructs
sessions via `defineSession` under the hood. For custom session
shapes (testing, alternative runtime topologies), call directly:

```ts
import { defineSession } from "@agentick/session-next";

const factory = defineSession({
  // ── Required: lifecycle + core verbs ──
  send: async (input) => {
    /* returns a SessionExecutionHandle */
  },
  snapshot: () => ({
    /* SessionSnapshot */
  }),
  // ── Required: the state-applicator triple the loop calls ──
  applyExecutorResult: async (input) => ({ appendedEntryIds: [] }),
  applyToolResults: async (input) => ({ appendedEntryIds: [] }),
  appendEntry: async (input) => ({ appendedEntryIds: [] }),

  // ── Optional: everything below has a default ──
  close: async () => {
    /* ... */
  },
  dispatch: async (name, input) => [], // unconfigured → throws "not configured"
  // Top-level handles — override to expose real state; otherwise no-op stubs.
  timeline: customTimelineHandle,
  knobs: customKnobsHandle,
  state: customStateHandle,
  elicitation: existingElicitationHarness, // optional; factory builds one if absent
  tasks: existingTasksHarness, // optional; same
});

const session = factory({ scopeId: "test-session" });
```

`send`, `snapshot`, and the state-applicator triple
(`applyExecutorResult` / `applyToolResults` / `appendEntry`) are
**required**; every other callback defaults to throwing a "not
configured" error, and the extended verbs (`spawn`, `dispatch`,
`channel`, `knob`) do the same. `timeline` / `knobs` / `state` default
to **no-op handle stubs** unless you supply real ones. `elicitation`
and `tasks` are the only session-scoped harnesses the factory builds
eagerly on the supplied substrate when omitted; there is no
`bridges.*` wiring — that plumbing is exclusive to the reference
`SessionHarness`.

## Telemetry — nested traces (ADR 77 / 78)

Because the session runs the execution as ONE Effect fiber (the ADR 77 spine —
`send → loop → executor → tool`), running it on a tracer runtime yields a
**nested** span tree for free, with `parentOpId` auto-linked via FiberRef. No
manual span threading.

You bring the tracer (the framework bundles no OpenTelemetry dependency —
capability, not opinion). Supply a telemetry `Layer` to `createApp`; the app
builds a `ManagedRuntime` from it ONCE and forwards it (plus the whitelabel
`telemetryNamespace`) to each session, which runs the composed loop on it:

```ts
import { NodeSdk } from "@effect/opentelemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const telemetry = NodeSdk.layer(() => ({
  resource: { serviceName: "my-agent" },
  spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
}));

const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
  telemetry, // → session.send now emits a nested trace to your exporter
  telemetryNamespace: "acme", // whitelabels the attribute keys (acme.op_id, …)
});

await (await session.send({ messages })).result;
```

A single `session.send` produces:

```
loop:command:run-execution                 (the execution span — root)
├─ compiler:command:render-tree
├─ tool:command:replace-compiler-tools
├─ executor:command:project / run / …
└─ tool:command:dispatch                    (one per parallel tool call)
```

Every child's `<ns>.parent_op_id` equals the execution's `<ns>.op_id`. Without
a telemetry Layer, spans emit against Effect's no-op tracer (discarded) — the
run is otherwise identical. Verified in `__tests__/telemetry.spec.ts`.

> **Known gap:** the namespace whitelabels SESSION-owned spans; the shared spine
> harnesses carry their own (default `"agentick"`). A whole-spine whitelabel
> needs the namespace read from fiber context — `TODO(stage-4:
fiber-context-namespace)`. Nesting is unaffected.

## Middleware — per-session (tier 2) and per-send (tier 4)

`session.use(mw)` wraps **this session's own** operations (ADR 76, tier 2) —
narrower than `app.use` (which wraps every session; tier 3). Use it for
session-scoped concerns bound to one conversation: per-session rate limiting,
a redaction pass, request logging keyed to `ctx.sessionId`.

```typescript
// Async form (severs the fiber; reads ctx). Effect form is `session.fx.use`.
session.use(async (input, next, ctx) => {
  log.debug("session op", { session: ctx.sessionId, op: ctx.opId });
  return next(input);
});
```

Because the loop / executor / tool harnesses are shared singletons (construction
_siblings_, not children of the session), middleware that must wrap **the model
call or a tool dispatch for one send only** is tier 4 — `withCallMiddleware`,
scoped to the fiber of that `send` and gone when it settles. That's the ADR 77
spine paying off: one send is one fiber, so a call-scoped FiberRef reaches across
the shared harnesses. See [runtime README — Operation middleware](../runtime/README.md#operation-middleware--three-tiers-adr-76)
for the full tier model and the `use` vs `fx.use` split.

## Command hooks — the session verbs are hookable (ADR 80 / 83)

The four public session verbs route through `runOperation` (via the private
`sessionOp` wrapper), so each fires the ADR-83 interceptor seam — guards,
`.use()` middleware, and the derived **command lifecycle hooks** — plus the
full phase contract (`requested` → `before` → terminal). The verbs and their
minted hook names:

| Verb                       | CommandRegistry key             | Hooks                                                |
| -------------------------- | ------------------------------- | ---------------------------------------------------- |
| `send`                     | `session:send`                  | `onBeforeSessionSend` / `onAfterSessionSend`         |
| `appendEntry`              | `session:append`                | `onBeforeSessionAppend` / `onAfterSessionAppend`     |
| `applyExecutorResult`      | `session:apply-executor-result` | `onBeforeSessionApplyExecutorResult` / `onAfter…`    |
| `applyToolResults`         | `session:apply-tool-results`    | `onBeforeSessionApplyToolResults` / `onAfter…`       |
| `model.setModel/setTarget` | `session:set-model`             | `onBeforeSessionSetModel` / `onAfterSessionSetModel` |
| `snapshot`                 | `session:snapshot`              | `onBeforeSessionSnapshot` / `onAfterSessionSnapshot` |
| `restore`                  | `session:restore`               | `onBeforeSessionRestore` / `onAfterSessionRestore`   |

Kebab `-what` segments PascalCase into the hook name (`apply-executor-result` →
`ApplyExecutorResult`), so every verb yields a clean, dot-accessible hook.

```typescript
// Declarative (returns an Unsubscribe):
const off = session.hook({
  onBeforeSessionSend: (input) => reshape(input), // transform, or void to observe, or throw to veto
});

// Per-verb imperative (typed Proxy):
session.hooks.onBeforeSessionAppend((input) => audit(input));
```

A before-hook returning a value **transforms** the input; `void` passes through;
`throw` vetoes (the op aborts on the `E` channel). After-hooks are symmetric over
the output.

### Wire limitation — hookable, NOT addressable (ADR 51)

These ops are the **in-process door only**. `SendInput` carries non-serializable
per-call overrides (`executor`, `target`, `signal`, and tool registrations with
_live_ handlers) that, by ADR 51 §1.2, cannot cross the wire — so **no wire
`CommandDescriptor` is declared** for the session verbs. Wire addressability
would require a designed serializable input subset (`messages` + `maxTicks` +
`stream` — the porcelain the wire's `session/send` already carries), which
remains future work. `session:dispatch` (name + JSON input) is fully
serializable and is the natural first wire declaration when that pass lands.

## Snapshot / restore — the generic bridge fold (ADR 27 "Step 6")

`session.snapshot()` and `session.restore(input)` are commands (see the table
above), so the **persist/restore hook quartet** falls out of the CommandRegistry
derivation — no bespoke callback slots.

**Generic composition.** Neither method hardcodes `timeline`/`knobs`. They fold
**every** `SnapshotCapable` bridge generically (feature-detection via the spec
`isSnapshotCapable` guard — the same pattern as the channel `snapshotProviders()`
scan). Each bridge's state lands under `SessionSnapshot.bridges[name]`:

```typescript
const snap = await session.snapshot(); // Promise<SessionSnapshot>
snap.bridges.timeline; // TimelineHarnessSnapshot ({ persisted, projection, … })
snap.bridges.knobs; // knob value map
snap.bridges.state; // K/V state map
// …plus any installed SnapshotCapable extension bridge — ZERO session change

await session.restore({ snapshot: snap }); // fans importSnapshot() back out
```

A new SnapshotCapable extension harness (sandbox, subscriptions, …) round-trips
automatically. The single authoritative payload per bridge avoids the divergence
a denormalized top-level copy would invite.

**The hooks map to v1 parity.** `onAfterSessionSnapshot` (transform the output)
is the v1 `onPersist` **augment/redact** seam; `onBeforeSessionSnapshot` vetoes.
`onBefore/AfterSessionRestore` are the v1 `onRestore` parity.

```typescript
// Redact before the snapshot leaves the process (v1 onPersist):
session.hooks.onAfterSessionSnapshot((snap) => ({ ...snap, metadata: redact(snap.metadata) }));
```

**The migration seam.** A snapshot whose `specVersion` differs from the running
`SPEC_VERSION` is a schema-evolution event. Supply a typed `migrateSnapshot`
callback (construction-bound on the session, or `createApp({ migrateSnapshot })`)
— invoked at the restore version-check decision point to bring the old shape
forward. With none supplied, a skew throws `SnapshotVersionMismatch` (fail-closed
— no silent stale apply). Per the seam-over-setting rule this is one callback at
the decision point, not a version registry; the adopter owns any version dispatch
inside it.

```typescript
const app = await createApp(Agent, {
  model,
  migrateSnapshot: (snap, { from, to }) => upgrade(snap, from, to),
});
```

> Distinct from the ADR-49 open-or-rehydrate path (a durable `TimelineStore`
> auto-hydrates the persisted log at construction). `snapshot()`/`restore()` are
> the on-demand full-session capture/transplant — they round-trip knobs, state,
> and every extension bridge, not just the timeline.

## Model selection / swap — `session.model` (ADR 89 §2)

`session.model` is a **facade**, not a harness. The session already owns the
stable model-selection state — the construction-bound default `RegisteredModel`
(`this.modelExecutor` + `this.target`), the per-tick `resolveModel`, and the
`input.modelExecutor ?? this.modelExecutor` override — so cross-swap concerns
live here as a thin projection, not a new harness sibling. (The escape hatch —
promote to a real `BaseHarness` if the model layer ever needs its own identity /
inbox-addressability / lifecycle FSM — is documented in ADR 89 §2.)

```typescript
session.model.current; // the session-default RegisteredModel in effect now

// Swap the session default — the runner AND its target. Journaled + hookable
// via the `session:set-model` command; effective on the NEXT send (never
// mid-execution). setTarget swaps ONLY the target (keeps the current runner).
await session.model.setModel({ modelExecutor: gpt4o, target: gpt4oTarget });
await session.model.setTarget({ ...target, modelId: "gpt-4o-mini" });

// Policy — veto a swap (onBeforeSessionSetModel throws → the command aborts):
session.hook({
  onBeforeSessionSetModel: (input) => {
    if (denylist.has(input.target.modelId)) throw new Error("model not allowed");
  },
});
```

### `setModel` accepts an adapter too — parity with construction

`setModel` takes **either** overload form, mirroring construction's
`createApp({ model: openai("gpt-4o") })` sugar:

- a `RegisteredModel` (`{ modelExecutor, target }`) — BYO executor, used as-is;
- a bare `LanguageModelAdapter` (`openai("gpt-4o")`, `anthropic(...)`, …) —
  wrapped in an executor **for you**.

```typescript
// Ergonomic parity — pass the same adapter sugar you'd pass at construction.
await session.model.setModel(openai("gpt-4o"));
```

The session stays **adapter-agnostic**: it never imports
executor-construction machinery. The app owns the adapter→executor build (the
same `LanguageModelExecutor`-on-the-app-substrate path the construction-time
`model` slot uses) and injects it as a `buildModelExecutor` closure. Both
overload forms normalize to a `RegisteredModel` **before** the
`session:set-model` command, so `onBeforeSessionSetModel` (the veto path) sees
identical input regardless of which form the caller passed.

A **BYO-executor app** — one constructed with `modelExecutor` rather than a
`model` adapter — opted out of the app's adapter-wrapping machinery, so it
injects no builder; passing an adapter to `setModel` then throws
`ModelExecutorBuilderMissingError`. Pass a `RegisteredModel` there instead.

### Interceptors that PERSIST across a `setModel` swap — the payoff

A model swap can swap the whole executor (a different adapter), so an
interceptor registered on executor-A evaporates once you swap to executor-B.
`session.model.use` / `.guard` solve this **without a new harness**: they
register interceptors op-scoped to the `model:generate[_stream]` commands (ADR
89 §1), riding the **tier-4 call-middleware seam** (the same seam the §4
lifecycle projection uses), not any executor instance. The ADR-77 one-fiber
spine threads them to whichever executor issues a send's model calls — including
a per-tick `<Model>`-swapped executor (ADR 56) — so, registered once, they hold
across every subsequent swap.

```typescript
// A cost/redaction transform on the model call — survives setModel swaps.
const offUse = session.model.use(async (input, next) => {
  meter.record(input);
  return next(input);
});

// A guard on the model call — admission control (proceed | veto | replace |
// defer). Survives setModel swaps; composes OUTERMOST (deny-before-transform).
const offGuard = session.model.guard((input, ctx) =>
  overBudget(ctx) ? { kind: "veto", reason: "cost ceiling" } : undefined,
);
```

**Effective-model precedence (unchanged).** Per-tick `<Model model={…}>`
(`resolveModel`) > per-send `send({ modelExecutor, target })` > the session
default. `setModel` changes only the DEFAULT; the loop resolves the effective
`RegisteredModel` per tick exactly as before.

## Spawn hardening — depth, lineage, teardown (SP4–SP6)

`session.spawn(input)` creates a child session bound to the same app (it needs a
`SpawnContext`, injected by the app). The hardening is threaded on
`SessionHarnessOptions` and enforced by the harness:

- **Depth ceiling (SP4).** `maxSpawnDepth` (from `createApp({ sessions:
{ maxSpawnDepth } })`, default 10 — v1 `MAX_SPAWN_DEPTH` parity) is stamped on
  every session. `spawn()` throws the typed `SpawnDepthExceededError` when the
  parent's lineage is already at the ceiling — fail-closed against runaway
  self-spawn. Depth is `spawnPath.length`; there is no separate depth counter.
- **Lineage (SP5).** A child's `spawnPath` is `[...parent.spawnPath,
parentId]` — the ancestor chain, root-first. It is stamped on the child's
  `SessionRecord.spawnPath`, threaded into the loop's `run-execution` / `tick`
  `EventScope` (bus/journal envelope attribution), and stamped on every
  `StreamEvent` the child's execution handle emits. With `parentSessionId`, the
  records reconstruct the spawn DAG.
- **Teardown (SP6).** The parent's construction signal is fanned into each child
  at spawn, so a parent abort tears down the child's in-flight work (merged into
  the child's execution signal, PA1 plumbing). The parent tracks its children
  (`_children`) and disposes them on close (`onClose`) AND on construction-signal
  abort, via `SpawnContext.disposeChildSession`. Abort-driven disposal awaits
  `whenQuiescent()` first, so closing never unmounts the compiler mid-tick.
  Children collapse their own sub-trees transitively.

## API

Full surface in the [typedoc]. The package root exports the thin set an
adopter or the app harness actually constructs against:

| Export                                                 | What                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `SessionHarness` / `SessionHarnessOptions`             | Reference `SessionHarnessProtocol` impl + its construction options bag.        |
| `defineSession` / `DefineSessionInput`                 | Callback-style factory for custom / test session topologies.                   |
| `SessionStateStore`                                    | Per-session status / tick / usage store (advanced; the harness owns one).      |
| `InMemorySessionStore`                                 | Bundled in-memory `SessionStore` default (E11) — the durable session registry. |
| `runSessionStoreConformance`                           | Conformance suite every `SessionStore` adapter must pass.                      |
| `SessionRecord` / `SessionStore` / `SessionStoreQuery` | Re-exported from spec — the E11 record + port + query.                         |
| `SessionSubstrateParent`                               | Re-exported from spec — portable factory-typing for substrate overrides.       |

## The durable session registry — `SessionStore` (E11)

The `SessionStateStore` above is the harness's synchronous in-memory metadata
cell (status / tick / usage). The **`SessionStore`** is the harness's _durable_
metadata mirror — the collection-archetype store (`@agentick/store-next`
`MemoryCollection` under the bundled `InMemorySessionStore`) holding
`sessionId → SessionRecord`. It is bigger than a metadata bag: per the data-layer
plan (E11) it is the **session registry + resume index + the backing for every
"list / resume my sessions" surface**, and the `SessionRecord` is the natural
home for the Phase-4 per-store cursor **manifest** (`stores?`, not populated
yet).

### The live-registry vs. record-store split

Two structures, deliberately NOT merged:

|             | Live registry (app)               | `SessionStore` (this)                                             |
| ----------- | --------------------------------- | ----------------------------------------------------------------- |
| Key → value | `sessionId → live SessionHarness` | `sessionId → SessionRecord`                                       |
| Purpose     | routing / interaction             | durable, queryable metadata                                       |
| Lifetime    | ephemeral — dropped on close      | the **superset** — every non-ephemeral session ever, incl. closed |
| Read via    | `app.getSession(id)`              | `app.listSessions(query)` / `app.getSessionRecord(id)`            |

The app's `getSession` routes to the live object; `listSessions` /
`getSessionRecord` read the durable store. They coexist — this run is additive
and does not replace `SessionSnapshot` or the live registry.

### How the harness populates its record

The `SessionHarness` mirrors its metadata into an injected `SessionStore` **off
the critical path** — `void store.put(record).catch(() => undefined)`, exactly
like the tasks store, and with **NO projection** (the record is written, never
read back during render). One subscription to the `SessionStateStore`'s metadata
notify catches every `setStatus` (running / idle / failed / closed); the
execution boundary bumps `executionCount` + toggles `currentExecutionId` before
`setStatus`, so a single write per transition captures the full delta:

| Site              | Record delta                                                              |
| ----------------- | ------------------------------------------------------------------------- |
| construction      | initial record — `createdAt`, `status: idle`, `executionCount: 0`         |
| status transition | `status` + `updatedAt`                                                    |
| execution start   | `currentExecutionId` set, `executionCount++`, `status: running`           |
| execution end     | `currentExecutionId` cleared, `usage` aggregated, `status: idle`/`failed` |
| `close()`         | `status: closed`                                                          |

`title` / `description` / `metadata` are **app-owned slots** (the framework
STORES them, never populates their semantics). Seed them at
`createSession({ title, description })` or set them later via
`app.setSessionMeta(sessionId, ...)` (routed through the live session's
`setMeta`, which is the single writer). There is **no `currentTick`** on the
record — a tick is execution-local, so it is execution-scoped runtime, not
session metadata.

`session.send` / `dispatch` / `snapshot` / `spawn` / `channel` / `knob` /
`gate` and the harness surfaces (`timeline`, `knobs`, `state`, `gates`,
`tasks`, `resources`, `elicitation`, `elicit`) are all defined on
`SessionHarnessProtocol` in `@agentick/spec-next` (built up by each
harness package's module augmentation) — see the individual harness
package READMEs for each surface's contract.

**`@agentick/session-next/testing`** — `runKillResumeAcceptance` +
`KillResumeAcceptanceOptions`, the parameterized ADR 49 open-or-rehydrate
acceptance suite that store adapters (memory / fs / postgres) run against
their backing.

[typedoc]: https://example.com/typedoc/session-next

## Status

- ✅ SessionHarness construction + lifecycle
- ✅ Per-session timeline / knobs / state / gates / elicitation / tasks / resources
- ✅ ToolBridge integration with layered tool registry (#135-#141)
- ✅ `session.elicit` sugar surface (#272 / ADR 43)
- ✅ Session execution handle (`send` → `Promise<SessionExecutionHandle>`)
- ✅ Session snapshot/restore (`snapshot()` / `restore()` commands) —
  generic `SnapshotCapable` bridge fold (ADR 27 "Step 6"), persist/restore
  hook quartet, and the typed `migrateSnapshot` schema-evolution seam
- ✅ Open-or-rehydrate resume from an injected `TimelineStore` (ADR 49)
- ✅ Per-tick `RenderContext` production (`contextInfo` + `activeModel`,
  ADR 55) and model resolution against the `ModelBridge` (ADR 56)
- ✅ Lifecycle bridge driving the compiler `useOn*` hook family (#206)
- ✅ Model registry injection (`models`, #206) + `requiredScopes`
  ceiling (#199)
- ✅ Durable `SessionStore` (E11) — `InMemorySessionStore` + record
  population at construction / status / execution boundary / close
- ✅ `session.model` selection / swap facade (ADR 89 §2) — `setModel` /
  `setTarget` via the journaled + hookable `session:set-model` command;
  `use` / `guard` interceptors on the model call that persist across swaps
- ⏳ `session.prompts` — depends on whether withPrompts is mounted (ADR 42 audit)

## Roadmap & known gaps

- **`activeModel` is construction-bound.** The model is `session.target`,
  so `RenderContext.activeModel` is stable across ticks. Under #169 it
  becomes IR-derived per tick (`TODO(trail-per-tick-model)`).
- **Session commands are not declarable yet.** `send`/`dispatch`/`queue`/
  `append` don't run through `runOperation`, and `SendInput` carries
  non-serializable per-call overrides (`executor`, `target`, `signal`,
  live tool handlers). An addressable `session:send` needs a designed
  serializable signal form — `TODO(adr-51-session-verbs)`. `session/send`
  and `session/respond_to_elicitation` are already routed via the gateway.
- **Inbox dispatch mostly not wired.** `handleMessage` handles the
  `session:escalation` message type — the terminal / forward hop of ADR 69
  request escalation (a task or sub-agent asking the client for input;
  root session resolves it against its elicitation harness, a spawned
  session forwards to its `parentSessionId`). It consults a registered
  `interceptEscalation` handler first (T2a — answer / deny / forward) and
  appends a `lineage` provenance entry per forward hop. Every other message
  type still rejects with `HandlerError` (Phase 4e+). The recursive forward
  hop + interception + lineage are tested (T2a); the cross-process child
  elicit bridge is `TODO(ADR-69 T2b)` — see
  [ADR 69](../../docs/proposals/v2/blueprint/69-request-escalation.md).
- **Snapshot/restore round-trips the full session.** `SessionSnapshot.bridges`
  now folds every `SnapshotCapable` bridge — the timeline slice carries BOTH
  the persisted log AND the (potentially compacted) projection
  (`TimelineHarnessSnapshot`), plus knobs, state, and any extension bridge.
  `session.restore()` fans `importSnapshot()` back out generically. Done in
  recovery pass #1 (was the "Step 6 SnapshotHarness" placeholder).
- **`SessionStore` coexists with `SessionSnapshot`; the manifest is not
  built.** The durable `SessionRecord` is written alongside (not instead of)
  `SessionSnapshot`. The `SessionRecord.stores?` per-store cursor manifest is a
  documented `TODO(store-phase-4)` placeholder (commented in
  `spec-next/protocol/session-store.ts`) — a cross-store restore manifest is a
  separate future step from the in-process `snapshot()`/`restore()` shipped here.
- **`setSessionMeta` targets LIVE sessions only.** Editing a closed
  session's record (absent from the live registry) needs a store
  read-modify-write path — `TODO(store-phase-4)`.

## Verified by

- `src/__tests__/session-store.spec.ts` — `InMemorySessionStore` runs the
  full `runSessionStoreConformance` suite (E11): put/get round-trip, upsert,
  `list` filtered by `appId` / `status` / `parentSessionId` / `updatedAfter`
  recency, enumerate-all, delete, and prune-of-closed. The harness's own
  record population (construction / execution boundary / usage aggregation /
  close) is verified in `@agentick/app-next`'s `app-harness.spec.tsx`, where a
  real `SessionHarness` + store are wired together.
- `src/__tests__/conformance.spec.ts` — `SessionHarnessProtocol`
  conformance suite.
- `src/__tests__/session-hooks.spec.ts` — the session verbs route through
  `runOperation` (ADR 83): `onBeforeSessionSend` fires on `send`,
  `onBeforeSessionAppend` on `appendEntry`, `onAfterSessionSend` sees the
  `SessionExecutionHandle`; plus the `deriveHookNames` ↔ `Pascal` agreement
  for `session:command:send` / `:append`.
- `src/__tests__/model-facade.spec.ts` — the `session.model` facade (ADR 89
  §2): `setModel` swaps the session default (the next send uses the new
  executor); `setTarget` swaps only the target; `onBeforeSessionSetModel`
  vetoes a swap (default unchanged); a `session.model.use` transform AND a
  `session.model.guard` veto, registered once, still apply to the model call
  across a `setModel` executor swap; per-send `modelExecutor` override beats
  the swapped default (precedence). Plus the adapter-overload parity:
  `setModel(adapter)` swaps the default via the injected `buildModelExecutor`
  (next send uses the built executor); the adapter form with NO injected
  builder throws `ModelExecutorBuilderMissingError`; and
  `onBeforeSessionSetModel` vetoes the adapter form identically (normalized to
  a `RegisteredModel` before the command). End-to-end through `createApp` in
  `@agentick/app-next`'s `set-model.spec.tsx`.
- `src/__tests__/define-session.spec.ts` — `defineSession` factory wiring.
- `src/__tests__/model-bridge.spec.tsx` — tree-declared per-tick model,
  real loop resolving the `ModelBridge` (ADR 56); tick-IR precedence over
  the session default.
- `src/__tests__/lifecycle-bridge.spec.tsx` — the real loop driving the
  whole `useOn*` hook family + `useContextInfo` yielding a live window
  and utilization (#206 / ADR 55). Plus the ADR 89 §4 projection suite:
  per-mount routing (two sessions on ONE shared loop — only the running
  session's hooks fire; unsubscribe on close), THE BARRIER (a knob
  mutated by an async `useOnTickEnd` effect is visible to the decide —
  settle-before-decide), `useOnModelGenerateStart/End` from the real
  `model:generate_stream` command via tier-4 call middleware, and the
  error projection (failed executor terminal → `phase: "model"`; hard
  tool-handler throw → `tool-end` failed + `phase: "tool"`).
- `src/__tests__/gates-integration.spec.tsx` — the continuation decision
  (ADR 67): a real execution drives `notifyLifecycle`, which evaluates the
  shared gate controller against the settled `TickResult`; both a
  tree-declared and a programmatic gate engage AND hold the loop open to
  `maxTicks` (the load-bearing continue-force proof).
- `src/__tests__/snapshot-command.spec.tsx` — the `session:snapshot` /
  `session:restore` commands (recovery pass #1): the hook quartet fires
  (`onBefore/AfterSessionSnapshot`, `onBefore/AfterSessionRestore`), the
  after-snapshot hook redacts the output (v1 `onPersist` parity), a
  before-snapshot hook vetoes; the Step-6 generic fold picks up a FAKE
  `SnapshotCapable` extension bridge and restores it via `importSnapshot` with
  zero session change; the `migrateSnapshot` seam runs on a `specVersion` skew
  (its output is applied) and `SnapshotVersionMismatch` throws when absent; plus
  the `deriveHookNames` ↔ `Pascal` agreement for `session:command:snapshot` /
  `:restore`.
- `src/__tests__/snapshot-restore.spec.tsx` — `InMemoryDataBridge`
  export/import round-trip (the data bridge the session wires into
  `bridges.data`); a compiler-level bridge fold, complementary to the
  session-level fold above.
- `src/testing/kill-resume-acceptance.tsx` — the ADR-49 acceptance suite
  (hard gate) additionally proves a `snapshot()` → `restore()` round-trip
  transplants a completed turn into a fresh, storeless session (independent of
  the durable-store hydration path), JSON-firewall-safe.
- `src/__tests__/streaming-handle.spec.tsx` — `SessionExecutionHandle`
  streaming iterator (event order, dense monotonic sequence,
  id/sessionId/executionId stamping, streaming vs non-streaming paths,
  and `handle.events()` yielding the event stream while `.result`
  resolves independently).
- `src/__tests__/extended-surface.spec.ts`,
  `layered-tools.spec.ts` — host-side `dispatch` (incl.
  `ToolPermissionError`), timeline handle append/`trailingInput`,
  layered execution-scoped vs session-scoped tool registry (#139),
  plus `spawn()` routing through a `SpawnContext`.
- Spawn hardening (SP4–SP6) is verified cross-harness (spawn needs a real
  app-provided `SpawnContext`) in `@agentick/app-next`
  `src/__tests__/spawn-hardening.spec.tsx` — the depth ceiling +
  `SpawnDepthExceededError`, `spawnPath` on record / loop `EventScope` /
  handle stream, and parent close/abort → child disposal.
- `src/__tests__/timeline-durability.spec.ts` — open-or-rehydrate
  hydration + the execution-end flush barrier (`TimelineWriteFailed`
  → `status=failed`); also exercises `session.snapshot().bridges.timeline.persisted`.
- `src/__tests__/kill-resume.spec.ts` +
  `src/testing/kill-resume-acceptance.tsx` — the end-to-end
  kill-and-resume acceptance (`runKillResumeAcceptance`) across the
  memory / fs / postgres store poles (ADR 49).
- `src/__tests__/escalation.spec.ts` — ADR 69 T1 + T2a request escalation.
  T1: a task's `ctx.elicit` escalates (nested `inbox.ask`) to its root
  owning session, which resolves terminally against the real client
  elicitation; the answer round-trips and the task FSM flips
  `working → input_required → working → completed`; plus the
  `interactive ⊥ detached` guard end-to-end. **T2a** (5 tests): a real
  2-session chain proving the recursive `parentSessionId` forward hop
  (child task elicit → child forwards → root parent terminal resolve →
  answer threads back + FSM flip); ancestor **interception** — short-circuit
  (parent answers, the real client elicit is never called), **deny**
  (interceptor throws → child `ctx.elicit` rejects), and **forward**
  (`{ forward: true }` reaches the terminal); and **lineage** (the envelope
  reaching the parent carries `[origin(task+session), child-session hop]`
  in order).

## See also

- [ADR 43 — Unified ToolHandlerCtx](../../docs/proposals/v2/blueprint/43-unified-tool-handler-ctx.md)
  — the cross-transport sugar story `session.elicit` participates in.
- [`@agentick/elicitation-next`](../elicitation/README.md) — the
  underlying ElicitationHarness + `Elicit` sugar contract.
- [`@agentick/app-next`](../app/README.md) — the parent harness that
  spins sessions up per run.
- [ADR 26 — Harness API shape](../../docs/proposals/v2/blueprint/26-harness-api-shape.md)
