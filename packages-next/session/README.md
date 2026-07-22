# @agentick/session-next

**SessionHarness — one agent run, one long-lived conversation.**

The integration site where v2's harness surfaces — reconciler, loop
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
reconciler/executor flow; the two views point at the SAME instance.

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
├── reconciler (per-tick, ephemeral)       — JSX → RenderedTree
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
2. Via `bridges.<name>` inside reconciler / executor flow.

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
  agent: <MyAgent />, // opaque — forwarded to reconciler.mount({ element })
  reconciler, // ReconcilerProtocol
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
loop calls it once per tick — AFTER the reconciler tick-end has settled the
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
Gate evaluation lives here, not in the reconciler mount — `useGate` is
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
  capability (`dispatchLifecycle`); a reconciler without it gets no
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
├─ reconciler:command:render-tree
├─ tool:command:replace-reconciler-tools
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

| Verb                  | CommandRegistry key             | Hooks                                             |
| --------------------- | ------------------------------- | ------------------------------------------------- |
| `send`                | `session:send`                  | `onBeforeSessionSend` / `onAfterSessionSend`      |
| `appendEntry`         | `session:append`                | `onBeforeSessionAppend` / `onAfterSessionAppend`  |
| `applyExecutorResult` | `session:apply-executor-result` | `onBeforeSessionApplyExecutorResult` / `onAfter…` |
| `applyToolResults`    | `session:apply-tool-results`    | `onBeforeSessionApplyToolResults` / `onAfter…`    |

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
- ✅ Session snapshot (`snapshot()` → `SessionSnapshot`, persisted log)
- ✅ Open-or-rehydrate resume from an injected `TimelineStore` (ADR 49)
- ✅ Per-tick `RenderContext` production (`contextInfo` + `activeModel`,
  ADR 55) and model resolution against the `ModelBridge` (ADR 56)
- ✅ Lifecycle bridge driving the reconciler `useOn*` hook family (#206)
- ✅ Model registry injection (`models`, #206) + `requiredScopes`
  ceiling (#199)
- ✅ Durable `SessionStore` (E11) — `InMemorySessionStore` + record
  population at construction / status / execution boundary / close
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
- **Snapshot carries the persisted log only.** The (potentially
  compacted) projection is not yet round-tripped via `SessionSnapshot` —
  the composed per-harness `SnapshotHarness` is a later step.
- **`SessionStore` coexists with `SessionSnapshot`; the manifest is not
  built.** This run is additive — the durable `SessionRecord` is written
  alongside (not instead of) `SessionSnapshot`. The `SessionRecord.stores?`
  per-store cursor manifest is a documented `TODO(store-phase-4)` placeholder
  (commented in `spec-next/protocol/session-store.ts`); the Phase-4 manifest
  sweep populates it at `snapshot()` and consumes it at a net-new
  `SessionHarness.restore(manifest)`, and subsumes `SessionSnapshot` then.
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
- `src/__tests__/snapshot-restore.spec.tsx` — `InMemoryDataBridge`
  export/import round-trip (the data bridge the session wires into
  `bridges.data`); not the session `snapshot()` itself.
- `src/__tests__/streaming-handle.spec.tsx` — `SessionExecutionHandle`
  streaming iterator (event order, dense monotonic sequence,
  id/sessionId/executionId stamping, streaming vs non-streaming paths,
  and `handle.events()` yielding the event stream while `.result`
  resolves independently).
- `src/__tests__/extended-surface.spec.ts`,
  `layered-tools.spec.ts` — host-side `dispatch` (incl.
  `ToolPermissionError`), timeline handle append/`trailingInput`,
  layered execution-scoped vs session-scoped tool registry (#139).
- `src/__tests__/timeline-durability.spec.ts` — open-or-rehydrate
  hydration + the execution-end flush barrier (`TimelineWriteFailed`
  → `status=failed`); also exercises `session.snapshot().timeline`.
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
