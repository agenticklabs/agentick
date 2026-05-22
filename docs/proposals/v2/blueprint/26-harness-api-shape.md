# ADR 26 — Harness API shape: namespaced surfaces

**Status:** Proposed — 2026-05-21
**Touches:** Every harness protocol interface in `@agentick/spec` (`SessionHarnessProtocol`, `AppHarnessProtocol`, `ReconcilerProtocol`, `ToolExecutorProtocol`, `LoopExecutorProtocol`, sandbox + MCP harness protocols), the concrete implementations (`@agentick/app`, `@agentick/session`, `@agentick/reconciler-react`, `@agentick/tool-executor`, `@agentick/executor`, `@agentick/loop-executor`, `@agentick/sandbox/v2`), every conformance suite, every example, every test that calls a harness method by name.
**Driver:** API surface explosion is a v2 risk. Every harness has 5–20 methods today, mostly flat. Consistency across harnesses is what makes the framework teachable. Lock in the shape now, before v2 ships.

## Decision

**Group related methods on a harness under named namespace properties; keep terminal verbs and identity flat.**

Verbs that _do the thing the harness exists for_ stay on the surface:

- `session.send(...)`, `session.render(...)`, `session.queue(...)`, `session.close()`
- `executor.run(...)`, `executor.execute(...)`, `executor.project(...)`, `executor.abort()`
- `loop.runExecution(...)`
- `app.close()`
- `sandbox.exec(...)`, `sandbox.destroy()`

Everything else lives under a namespace keyed by topic:

- `session.knobs.{list, get, set, dispatch, subscribe, subscribeAll, has}`
- `session.gates.{list, get, engaged, isEngaged, clear, defer, activate}`
- `session.state.{list, get, set, has, subscribe, exportSnapshot, importSnapshot}`
- `session.timeline.{read, subscribe}` (and `append` if/when ADR 27 lands)
- `session.tools.{list, dispatch, register}`
- `session.snapshot.{export, import, hibernate}`
- `session.events.{subscribe, emit}`
- `session.extensions.<name>`
- `app.sessions.{create, runOnce, get, list, close}`
- `app.events.{subscribe, emit}`
- `app.extensions.<name>`
- `reconciler.mounts.{create, rerender, destroy, render, notify}`
- `toolExecutor.tools.{register, unregister, list, dispatch}`
- `loop.handlers.{register, unregister}`, `loop.state.<x>`
- `sandbox.fs.{readFile, writeFile, editFile, stat, readdir}`
- `sandbox.mounts.{add, remove, list}`

This is the single API-shape rule across every harness.

## Rule of thumb: flat or namespaced?

```
Flat:        the harness's terminal verb(s)
             identity / status (id, ready, status)
             one-shot lifecycle hooks (close, abort)

Namespaced:  collections of related operations (≥2 methods)
             surfaces that mirror a bridge protocol (knobs, state, timeline)
             extension bags (extensions.<name>)
             event subscription surfaces
```

If you'd put it next to ≥1 other method on the same topic and they share a noun, namespace. If it's the verb the harness was built to perform, flat.

## Why this shape

### What we get

1. **Discoverability.** `session.<tab>` reveals 8 nouns, each a topic. Today it reveals 15 verbs you have to know by name.
2. **Cross-harness consistency.** Once an adopter learns the pattern on SessionHarness, every other harness reads the same way. No per-harness API muscle memory.
3. **Imperative reach into bridge-backed surfaces.** Knobs/state/timeline today are React-only via `useBridges()`. Namespaced harness surfaces give headless callers (eval harnesses, slash commands, webhooks, test code) first-class access without going through React.
4. **Extension symmetry.** `app.extensions.sandbox` for app-level imperative reach pairs with `useBridges().sandbox` for React reach. Same bridge, two access paths matched to two contexts.
5. **Lower naming pressure.** Today `set_knob`, `setKnob`, `setKnobValue` would all be reasonable flat names. Namespaced: `knobs.set`. One choice, mechanically derived.

### What we lose

1. **One extra property allocation per harness instance.** Negligible.
2. **Slightly more verbose call sites.** `session.knobs.get("verbose")` vs `session.getKnob("verbose")`. Adopters destructure (`const { knobs, gates } = session;`) when they care.

The tradeoff is overwhelmingly toward the namespace shape.

## Considered and rejected

### Shared `Storage` / `Collection` / `Events` sub-interfaces in spec

Initial sketch had `StorageNamespace<TKey, TValue>` (read+write+subscribe+snapshot) as a reusable shape that knobs, state, and timeline would all implement.

**Rejected.** Walking the actual data:

- Knobs: read + write + per-id subscribe + wildcard + snapshot
- State: read + write + per-id subscribe + (no wildcard) + snapshot
- Timeline: read + (write — ADR 27 question) + version subscribe (wildcard-ish)

Different shapes. Trying to enforce a shared interface either over-fits (forcing wildcard on state) or under-fits (leaving timeline's read-only/writable status as a flag on the interface). Either way the interface adds spec surface for trivial gain.

**Convention over enforcement.** Document informally that storage-shaped namespaces commonly expose `list/get/subscribe`; each namespace declares its actual concrete shape in its own spec interface. Conformance is per-namespace, not per-shape.

### Flat surfaces for "internal" agentick extensions

Carve-out: `@agentick/sandbox` is in this monorepo, so let `app.sandbox.exec(...)` work top-level; third-party extensions go under `app.extensions.<name>`.

**Rejected.** "Internal" is fuzzy and moves over time — every extension is structurally the same `AppExtension` shape. Top-level extension names also conflict with the harness's own surface (`app.sessions`, `app.events`). Reserved names rot. Inconsistency in docs is a wart. Adopters who want flatness `destructure` once: `const { sandbox } = app.extensions;`. One rule, no exceptions.

### Per-method decoration (Fastify `app.decorate("name", value)`)

Extensions register arbitrary methods onto AppHarness / SessionHarness directly.

**Rejected.** Silent clobbers; type drift; debugging pain. Maximum flexibility traded for maximum surprise. Extensions can already register bridges (their methods live there); the bridge accessor (`app.extensions.<name>`) gives them imperative reach without harness mutation.

### Chained handles (`session.knobs.get(name).subscribe()`)

`get(name)` returns a `KnobHandle` object with methods.

**Rejected.** Object-per-call allocation + the "what if id doesn't exist" branch. Flat methods (`session.knobs.subscribe(name, fn)`) match the bridge surface 1:1; adopters destructure when they want locality.

## Per-harness namespace inventory

The complete mapping (current → proposed). Anything not listed below stays flat or is unchanged.

### AppHarness

| Today                                                                | Proposed                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| `createSession`, `runOnce`, `getSession`, `listSessions`, `closeApp` | `app.sessions.{create, runOnce, get, list, close}`        |
| `events(filter?)`                                                    | `app.events.{subscribe(filter?), emit(event)}`            |
| (proposed) extension bag                                             | `app.extensions.<name>` (per ADR-22 augmentation pattern) |
| `close`, `ready`, `id`                                               | Flat (terminal / identity)                                |

### SessionHarness

| Today                            | Proposed                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `send`, `render`, `queue`        | Flat (terminal verbs)                                                                                                |
| `dispatch(name, input)`          | `session.tools.dispatch(name, input)` (moved)                                                                        |
| `timeline()`                     | `session.timeline.{read, subscribe}` (and `append` if ADR 27 lands)                                                  |
| `snapshot()`                     | `session.snapshot.{export, import, hibernate}`                                                                       |
| `close`, `id`, `status`, `ready` | Flat                                                                                                                 |
| (new) knob access                | `session.knobs.{list, get, set, dispatch, subscribe, subscribeAll, has}` — see "Knob mutation audit" below           |
| (new) gate access                | `session.gates.{list, get, engaged, isEngaged, clear, defer, activate}`                                              |
| (new) state access               | `session.state.{list, get, set, has, subscribe, subscribeAll, exportSnapshot, importSnapshot}`                       |
| (new) tools                      | `session.tools.{list, register, dispatch}`                                                                           |
| (new) events                     | `session.events.{subscribe, emit}` (per-session view of execution lifecycle events)                                  |
| (new) extension bag              | `session.extensions.<name>` (same instances as `app.extensions.<name>`; forwarded by AppHarness at session creation) |

### ReconcilerHarness

| Today                                                           | Proposed                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| `mount`, `rerender`, `unmount`, `renderTree`, `notifyLifecycle` | `reconciler.mounts.{create, rerender, destroy, render, notify}` |
| `ready`, `id`                                                   | Flat                                                            |

### ToolExecutorHarness

| Today                     | Proposed                                                    |
| ------------------------- | ----------------------------------------------------------- |
| (registration via bridge) | `toolExecutor.tools.{register, unregister, list, dispatch}` |

### LoopExecutorHarness

| Today                            | Proposed                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `runExecution(input)`, `abort()` | Flat                                                                          |
| lifecycle handler registration   | `loop.handlers.{register, unregister}`                                        |
| StateApplicator-facing surface   | `loop.state.<x>` (specific shape TBD when StateApplicator surface stabilizes) |

### ExecutorHarness

Mostly stays flat. `project`, `execute`, `run`, `abort`, `normalize` ARE the executor's verbs. Capability inspection (target metadata) could go under `executor.target` if it grows; today it's just a property.

### SandboxHarness

| Today                                                  | Proposed                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `exec`, `destroy`                                      | Flat (terminal verbs)                                       |
| `readFile`, `writeFile`, `editFile`, `stat`, `readdir` | `sandbox.fs.{readFile, writeFile, editFile, stat, readdir}` |
| `addMount`, `removeMount`, `listMounts`                | `sandbox.mounts.{add, remove, list}`                        |

## Knob mutation audit (side concern, but tracked here)

Today's knob mutations split into two paths:

- **Model-side** (`set_knob` tool dispatch) → journaled via the tool-executor's standard op flow. The "verification set inactive at tick 7" trail exists.
- **Host-side** (via `session.knobs.set(...)` once Stage A lands) → bypasses that path; no trail.

This asymmetry exists regardless of the namespacing — it's a property of having an imperative knob mutation surface at all. Cheap fix: have `session.knobs.set` / `session.knobs.dispatch` emit a `knob-changed` bus event (sessionId + knob id + old → new) on every write. One-line addition during the SessionHarness refactor; closes the audit gap without promoting knobs to a journaled harness.

Apply the same pattern to gates implicitly (gates ARE knobs; gate mutations land as knob-changed events) and state (`state-changed` event with key + old → new).

## Migration

Stepped, bottom-up so depended-on harnesses move first and their consumers compile against the new shape immediately. No flat-method shims (per CLAUDE.md "no backwards compatibility, no deprecations"). Every adopter call site in the workspace gets refactored in the commit that lands the change.

```
Step 0 — This ADR (locks the design)
Step 1 — Spec refactor: protocol interfaces declare namespaced surfaces;
         conformance suites updated to walk namespaces
Step 2 — ReconcilerHarness        (bottom of dep graph)
Step 3 — ToolExecutorHarness
Step 4 — ExecutorHarness          (minor — mostly confirms the rule)
Step 5 — LoopExecutorHarness
Step 6 — SessionHarness           (biggest; lands knobs/gates/state/tools/snapshot/events
                                   namespaces + knob audit bus events)
Step 7 — AppHarness               (sessions + events + extensions)
Step 8 — SandboxHarness           (fs + mounts)
Step 9 — Sweep                    (READMEs, STATUS.md, IMPLEMENTATION-PLAN.md)
```

Each step is one commit. Each commit: refactor + tests + example/express + example/v2 + knowify integration if affected. Estimated 1500-2500 LOC of churn, mostly mechanical once Step 1 is in.

## Open questions

1. **`session.dispatch` → `session.tools.dispatch`.** Breaking rename for a method already in v2. Per CLAUDE.md special window: accept.
2. **`reconciler.mounts.render` and `reconciler.mounts.notify` placement.** These take a `mountId` and operate on a mount — they belong under `mounts`. But they're not collection-shaped operations (no `list` / `get`). Decision: keep under `mounts` for cohesion; document that the namespace is "everything mount-related," not strictly "the mount collection."
3. **`session.events` vs `app.events`.** Sessions emit execution-lifecycle events; the app's bus carries every session's events. `session.events` is a per-session filtered view; `app.events` is the full firehose. Both useful, both consistent with the rule.
4. **`loop.state` shape.** StateApplicator's interface is small today (`applyExecutorResult`, etc.). Likely just stays as a couple of flat methods on the loop and `loop.state` doesn't materialize. Punt until LoopExecutor's surface is more mature.

## Notes

This ADR is the prerequisite for the imperative knob/gate/state methods on SessionHarness — those land in Step 6 directly in their namespaced form, never as flat methods. It also lays the surface that ADR 27 (timeline-as-write-mechanism) will extend if/when it lands — `session.timeline.append` slots naturally into the `timeline` namespace.
