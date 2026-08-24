# @agentick/gates

**A gate is a rule about when the run may finish.** Most gates hold a loop open: when it would otherwise stop, an engaged gate buys another tick and puts its instructions in front of the model — "don't finish until you've summarized the findings," "don't finish while the typecheck is red." One species does the opposite and ends a turn that would have continued: `stopOnTools("done")`.

The bet is that the holding kind needs no state of its own. Its value _is_ a knob value — so model visibility, per-value subscription, snapshot/restore, and the read-only enforcement that makes a check unforgeable all come from [@agentick/knobs](../knobs) unchanged. What this package adds is a registry, a tick-end evaluation pass, and the rules about holding and ending.

> [!NOTE]
> In this codebase `gate` means loop continuation — should the agent keep going. Admission of an individual operation is a different concept with a different name.

## Install

```bash
npm install @agentick/gates
```

Subpaths: `/react` (hook + provider), `/client` (browser-side handle), `/testing` (fake controller + loop spy).

## Quick start

```tsx
import { System } from "@agentick/compiler-react";
import { gate, useGate } from "@agentick/gates/react";

const typecheckGate = gate({
  description: "Typecheck must pass after edits",
  instructions: "Run the typecheck and fix every error before you finish.",
  activateWhen: (r) => r.toolResults.some((t) => t.toolName === "edit_file"),
  satisfied: async () => (await runTypecheck()).ok,
});

export function Agent() {
  const { element } = useGate("typecheck", typecheckGate);

  return (
    <>
      <System>You are a coding agent.</System>
      {/* Render last — the instructions land right before the model replies. */}
      {element}
    </>
  );
}
```

`element` is a section rendered only while the gate is engaged; the rest of the time it's `null`. The hook also returns `{ active, deferred, engaged, clear, defer }`.

`gate()` is a plain descriptor factory — pure data, no compiler involved — so declare gates at module scope and pass them in.

## Three species

Which predicate you supply picks the species: `activateWhen` a latch, `satisfied` a verified gate, `stopWhen` a stop gate.

### Latch — edge-triggered, model-cleared

`activateWhen` is consulted **only while the gate is inactive**. The first tick it returns `true`, the gate engages and stays engaged until the model clears it with `knob_set`, or host code calls `clear()`. Reach for this when the condition isn't checkable in code and the model has to attest to it.

```ts
import { gate } from "@agentick/gates";

const summaryGate = gate({
  description: "Await summary",
  instructions: "Summarize what you found before you finish.",
  activateWhen: (r) => r.toolResults.length > 0,
});
```

The backing knob is a three-state select — `inactive` / `active` / `deferred` — so the model can also _defer_: acknowledge the gate and postpone it. A deferred gate that would let the run end flips back to `active` first, which is what stops "I'll do it later" from becoming "never."

### Verified — level-triggered, code-cleared

`satisfied` runs at the end of **every** tick. `false` engages the gate; `true` clears it — including re-engaging if a later tick regresses. Reach for this when code can check the invariant.

```ts
const submissionGate = gate({
  description: "A validated submission must exist",
  instructions: "Call submit_answer with a valid payload before finishing.",
  satisfied: (r) => r.toolResults.some((t) => t.toolName === "submit_answer" && t.succeeded),
});
```

Add `activateWhen` to a verified gate and it becomes an **arming** predicate: while unarmed the gate is dormant — the invariant isn't evaluated and can't block. Arming is sticky, and verification takes over on the same tick. That's how "once files were edited, the typecheck must pass" avoids blocking a turn that edited nothing.

### Stop — the inverse species

`stopWhen` runs at the end of every tick and **ends a turn the loop would have continued**. This is the framework's explicit-completion mechanism: the app ships its own `done` tool, and the gate is what makes calling it end the turn.

```ts
import { stopOnTools } from "@agentick/gates";

session.gates.register("completion", stopOnTools("done", "handoff"));
```

The turn continues unless the just-completed tick **dispatched** one of the named tools. Dispatched, not requested: a call an admission guard refused never ran, so it cannot end the turn.

**A parallel batch always completes.** Gates are evaluated at tick end, after every dispatch in the batch has settled — so a batch containing `done` finishes all of its calls, their results land in the timeline, and _then_ the turn ends. A stop never interrupts a batch mid-flight.

A stop gate is **not a value cell**: no backing knob, no `instructions`, no model visibility, no `GateValue`. There is nothing for the model to see and nothing for it to set, which is the whole point — the rule is not negotiable from inside the conversation. It still appears in `gates.list()` (`species: "stop"`, no `value`) so it is auditable, and `useGate` does not accept one: there is no state to reflect and no section to render.

`clear` / `defer` / `override` **reject** on a stop gate, from the host handle and over the wire alike. They have no meaning on a gate with no value, and a silent no-op would be a lie.

## Two guarantees worth the whole package

**The model cannot forge its way past a verified gate.** A verified gate registers its backing knob **read-only**: the model reads the gate's state in the knobs section but `knob_set` refuses to write it. The predicate is the only authority. This is enforced by the same validation pipeline that protects every read-only knob, and it is covered by an adversarial test that drives the model's dispatch path directly.

**A broken check blocks, it does not pass.** A verified predicate that throws is treated as **unsatisfied** and the gate engages. Lifecycle handler errors are isolated rather than propagated, so without fail-closed a crashing verifier would quietly let the run complete unverified.

## The programmatic surface

Everything `useGate` does from the tree, host code does from the session — same registry, same evaluation pass. A tree-declared gate and a programmatic one both appear in `session.gates.list()`.

```ts
const handle = session.gates.register("summary", summaryGate);

session.gates.list(); // [{ name, species, value?, description }, …]
session.gates.has("summary"); // true
session.gate("summary")?.value; // "inactive" | "active" | "deferred" (undefined on a stop gate)
session.gates.subscribe("summary", () => rerender());
session.gates.subscribeAll(() => refreshDashboard());

await handle.clear(); // host-side release
```

`clear` / `defer` / `override` are async and journaled: they route through the `gates:clear` / `gates:defer` / `gates:override` commands, so a host-side release is an audited operation exactly like a wire one. (The React surface stays fire-and-forget — `useGate`'s `clear` returns `void` and the value re-reads reactively off the backing knob when the transition lands.)

### The host override

Verified gates are code-cleared and read-only to the model. A host override is legitimate — the host is trusted — but it is an **explicit, audited** escape, never a silent setter that reopens the read-only protection:

```ts
const g = session.gate("typecheck");
await g?.override("inactive", "manual unblock: known-flaky check");
```

`override()` applies the value _and_ emits a `gate:override` audit record stamped with its origin — `"host"` for an in-process call, `"wire"` for one that arrived over the wire. It throws on a latch gate; use `clear()` there.

## How the two front-ends converge

```
              gate() descriptor  (pure data — no compiler)
                       │
        ┌──────────────┴───────────────┐
   useGate (React)              session.gates (programmatic)
        │  register / read             │  register / get / list / clear
        └──────────────┬───────────────┘
                GatesController          ← ONE registry, ONE evaluation pass
                  (knobs · loop)
```

`GatesController` holds the registry and the tick-end pass that arms, evaluates, fails closed, auto-clears, and holds the loop. It takes its collaborators injected — a knobs surface for the backing cell, a loop-control seam to hold continuation, an audit sink for overrides — so it depends on no framework and no React.

**Evaluation is driven, not subscribed.** The session's continuation decision calls `handleTickEnd(result)` once per tick with the settled tick result, after the tree has settled. A blocking gate calls `continueAfterTick` on the loop seam; the session folds that hold into its decision. There is no per-mount tick-end subscription and no runtime component to render — which is exactly why programmatic-only gates evaluate identically to tree-declared ones. `useGate` is registration-only: register on mount, unregister on unmount, reflect the value.

A gate holds the loop open the same way steering does, under the loop's `maxTicks` cap. It forces continuation; it cannot run forever.

A stop gate drives the same seam in the other direction — `stopAfterTick` — and the controller reports both verdicts in one pass without ranking them. Resolution is the session's: stop beats continue, and the run's `stopReason` becomes `"halted"`.

## Over the wire

`GatesHarness` wraps the controller with four commands, routed to wire clients by the generic dynamic-command lane:

| Command          | Payload                   |
| ---------------- | ------------------------- |
| `gates:list`     | → `GateInfo[]`            |
| `gates:clear`    | `{ name }`                |
| `gates:defer`    | `{ name, reason? }`       |
| `gates:override` | `{ name, value, reason }` |

A fifth read comes from the base rather than from here: `gates/commands` returns every declared verb with its exposure, so `await client.session(id).gates.commands()` is how a client asks what this surface can do instead of assuming. See [@agentick/gateway](../gateway#discovery--two-doors).

Each of the four delegates straight to the one owned controller. A verb naming a missing gate rejects with a typed `GateNotFound` rather than returning null, and deny-by-default holds — an undeclared verb is indistinguishable from an absent method. The three mutation verbs also reject when the named gate is a stop gate; `gates:list` shows it with `species: "stop"` and no `value`.

Importing `@agentick/gates/client` registers `session.gates` on the wire client:

```ts
import "@agentick/gates/client";

const gates = client.session(sessionId).gates;

gates.subscribe(() => render(gates.list())); // zero-arg store contract
gates.list(); // readonly GateInfo[]
gates.get("summary"); // GateInfo | undefined

await gates.clear("summary");
await gates.defer("summary", "after the next tool call");
await gates.override("typecheck", "inactive", "manual unblock");
await gates.refresh(); // force a re-poll
gates.close();
```

**RPC-backed, not channel-backed.** The read side is a poll: an eager `gates/list` seeds the local snapshot and every mutation re-fetches it. `list()` and `get()` read that snapshot synchronously, so the handle drops straight into `useSyncExternalStore`. `gatesHandle(client, sessionId)` is the same handle as a free factory.

## API

### `@agentick/gates`

| Export                                                                                                                                           | Purpose                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `gate(descriptor)`                                                                                                                               | Descriptor factory — declare at module scope         |
| `stopOnTools(...names)`                                                                                                                          | Stop-gate factory — the turn ends once one is called |
| `isVerifiedGate` / `isStopGate` / `gateSpecies`                                                                                                  | Discriminate the three species at runtime            |
| `GATE_OPTIONS` / `VERIFIED_GATE_OPTIONS`                                                                                                         | The knob `options` each value species registers      |
| `GatesController`                                                                                                                                | The registry + tick-end pass                         |
| `GatesHarness`                                                                                                                                   | The wire command surface; owns the one controller    |
| `GateDescriptor` / `LatchGateDescriptor` / `VerifiedGateDescriptor` / `StopGateDescriptor` / `ValueGateDescriptor` / `GateSpecies` / `GateValue` | Descriptor shapes                                    |
| `GateInfo` / `GateHandle` / `GatesHandle`                                                                                                        | Read row, per-gate handle, curated session surface   |
| `GatesControllerDeps` / `GateKnobs` / `LoopControlSeam` / `GatesParentLayer`                                                                     | The injected seams                                   |
| `GateOverrideAudit` / `GateOverrideOrigin`                                                                                                       | The override audit record and its origin             |
| `GatesClearInput` / `GatesDeferInput` / `GatesOverrideInput`                                                                                     | Wire command inputs                                  |

### `session.gates` and `session.gate(name)`

| Method                                                 | Returns                                          |
| ------------------------------------------------------ | ------------------------------------------------ |
| `gates.register(name, descriptor)`                     | `GateHandle` — idempotent, last writer wins      |
| `gates.get(name)` / `gates.has(name)`                  | The handle; whether one is registered            |
| `gates.list()`                                         | `readonly GateInfo[]` — every gate, both origins |
| `gates.clear(name)`                                    | `Promise<void>` — journaled release              |
| `gates.subscribe(name, fn)` / `gates.subscribeAll(fn)` | Transitions plus register/unregister             |

A `GateHandle` carries `name`, `descriptor`, `species`, `value?`, `engaged`, `clear()`, `defer()`, `override(value, reason?)`, and `subscribe(fn)`.

### `@agentick/gates/react`

| Export                           | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `useGate(name, descriptor)`      | `{ active, deferred, engaged, clear, defer, element }`         |
| `useGates()`                     | The in-scope `GatesHandle` — the same shape as `session.gates` |
| `GatesProvider` / `GatesContext` | Supply a controller explicitly; rarely needed                  |

The descriptor and controller types are re-exported here too, so a React-only file can import everything from one subpath.

### `@agentick/gates/client`

| Export                           | Purpose                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `session.gates`                  | Registered on import: `list` / `get` / `clear` / `defer` / `override` / `refresh` / `subscribe` / `close` |
| `gatesHandle(client, sessionId)` | The same handle as a free factory                                                                         |
| `GatesClientHandle` (type)       | The handle contract                                                                                       |

### `@agentick/gates/testing`

| Export                        | Purpose                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `fakeGatesController(knobs?)` | A working controller over stub knobs, a spy loop seam, and a recorded audit sink; `.tick(result)` drives the pass with no mount |
| `spyLoopControl()`            | A `LoopControlSeam` that records continue/stop calls                                                                            |

```ts
import { fakeGatesController } from "@agentick/gates/testing";

const { controller, loop, audits, tick } = fakeGatesController();
controller.register("summary", summaryGate);

await tick(tickResultWhere({ shouldContinue: false }));
expect(loop.continueCalls).toContain("gate:summary");
```

## Patterns

**Knobs.** [@agentick/knobs](../knobs) owns the cell a gate's value lives in, the `knob_set` tool the model clears a latch with, and the read-only enforcement that makes a verified gate unforgeable.

**Rendering.** [@agentick/compiler-react](../compiler-react) owns the bridge context `useGate` reads and the section primitives `element` compiles to.

**Shapes.** [@agentick/spec](../spec) owns `TickResult` (what a predicate is handed) and `GateNotFound`.

**Client.** [@agentick/client-core](../client-core) owns the `ClientHandle` / `Enumerable` contracts and the session sub-handle registry the `/client` subpath registers into.

## Roadmap & known gaps

- **No delta channel for gates.** The client handle polls. A gate's boolean value already reaches clients as a knob JSON-Patch delta, but gate-specific detail — why it engaged, how often, predicate metadata — is not projected. When a `gates-state` channel lands, `list()` gains a live view with no API change.
- **The inherited-gate layer is present but unreachable.** `GatesController` accepts a parent layer: reads unify across the chain with self shadowing by name, and a child's tick drives the parent's own gates in the parent's knob and loop layer. It is tested, but nothing constructs a parent today. It exists so an app-scoped gate tier drops in without a rewrite.
- **`defer` carries a `reason` that goes nowhere.** The wire shape accepts one for parity with `override`; a latch defer emits no audit, so it is accepted and dropped.

## Verified by

- `src/__tests__/controller.spec.ts` (stop species) — a named dispatched tool ending a turn the loop would have continued while an unnamed one does not; the predicate seeing the WHOLE settled parallel batch (the batch-completes proof); no knob registered and no value held, yet still listed; a stop gate and a blocking value gate both reaching the loop seam in one pass; `clear`/`defer`/`override` rejecting; a failed tick evaluating without throwing; the three-way species discrimination; and `stopOnTools()` refusing an empty name list.
- `src/__tests__/controller.spec.ts` — a latch arming on the trigger tick, holding the loop, and releasing on `clear()`; no re-arming once engaged; `deferred` un-deferring when it would block; a verified gate engaging, auto-clearing, and re-engaging on regression; the arming scope keeping a verified gate dormant; fail-closed on a throwing predicate; the read-only backing knob refusing the model's dispatch (adversarial); `override()` releasing a verified gate and emitting the audit while rejecting on a latch; and `list()`/`get()` unifying over a parent layer with self shadowing, including inherited evaluation against the child's tick.
- `src/__tests__/gate.spec.tsx` — the same behaviors through `useGate` against the real compiler: activation and non-activation, no re-activation once engaged, forcing continuation only when the loop would stop, un-deferring, the section rendered with title and instructions only while active, the registered knob descriptor (group, three-state options; two-state and read-only for verified), async predicates awaited, `defer()` a no-op on verified gates, the `knob_set` pipeline refusing a verified gate's knob, and arming keeping a gate dormant then verifying the same tick.
- `src/__tests__/harness.spec.ts` — the dynamic-lane inbox address, each command delegating to the one owned controller, `gates:override` stamping `origin: "host"` for a method call and `"wire"` over the inbox, a typed rejection when the named gate is missing, a stop gate listing valueless while the three mutation verbs reject on it, and all four verbs enumerating as `exposure: "wire"`.
- `src/client/__tests__/gates-handle.spec.ts` + `session-gates.spec.ts` — `list()`/`get()` reflecting the eager poll, each verb's request shape and its re-poll, the zero-arg `subscribe` contract, and `session.gates` self-assembling on the client session handle.
- [@agentick/session](../session) `src/__tests__/gates-integration.spec.tsx` — tree-declared and programmatic gates sharing one registry and one controller instance, and a real execution where both hold the loop to `maxTicks`.
- [@agentick/transport-in-process](../transport-in-process) `src/__tests__/gates-e2e.spec.ts` — `gates/list`, `clear`, `defer`, and `override` round-tripping the real gateway and dynamic lane, with deny-by-default preserved.
