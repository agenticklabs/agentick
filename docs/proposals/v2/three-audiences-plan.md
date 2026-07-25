# Three audiences — implementation spec

**Status: SPEC — for review. No implementation yet.**
Companion to `website-design.md` §6 (items 1–3, 7). 2026-07-24.

---

## 0. The design

Every harness capability lives **once**, as a command on its harness —
validated, journaled, guarded, hookable at one choke point. Audiences never
get the command raw; each gets a **curated projection**:

| Audience     | Projection                                            | Curation it adds                                                 |
| ------------ | ----------------------------------------------------- | ---------------------------------------------------------------- |
| Host code    | typed handle verbs (`session.gates.clear()`)          | ergonomics, sync mirrors                                         |
| Wire clients | dynamic-command lane (`gates/clear`), deny-by-default | authz, serializable params, enumeration                          |
| The model    | hand-authored tools (`set_knob`, `resource_read`)     | model-directed naming/prose, input reshaping, honest degradation |

The four work items below are all instances of one move: **route an existing
command to a missing audience, or add the missing capability at the right
tier so the projection stays thin.** Nothing here adds an executor: skills
remain data; "running" a skill _aims the executor we already have_ (the
model). No command→tool auto-bridge — curation is the point (§D).

Dependency: **B enables C. A and D are independent.**

### Trailhead: value-cell stratification (parked — ratified 2026-07-24)

Gates values living in knobs was challenged ("seems dirty") and ruled
**deliberate composition, not expediency**: a knob IS v2's primitive for
"a model-readable/writable value cell with validation, audit, channel
projection, persistence"; a gate is that cell + loop policy. Building a
GateStore + `gate_clear` tool + gates channel would duplicate the entire
model-write subsystem — the actually-dirty outcome. Verified clean at the
boundary: knobs' `readOnly` is generic (`knobs/harness.ts:527`); knobs
contains zero gate knowledge; the dependency arrow points one way.

The named right lift, IF the coupling ever needs dissolving, is
**stratification, not separation**: extract the _value cell_ as its own
substrate primitive and make BOTH knobs and gates compositions over it
(knobs = cells presented as config; gates = cell + continuation policy).
"Gates are knobs under the hood" becomes "gates and knobs share a cell."
Parked under the three-consumers rule — today the cell has two
(knobs, gates); a third cell-shaped harness (sampling? roots?) tips it.
The store fan-out's knobs store is already drifting toward this layer.

Known leaks, tracked (not avoided): (1) gate VALUES still project on the
knobs channel while gate VERBS ride `gates/*` — resolved when the gates
delta channel lands with the store fan-out (`controller.ts:483-488`);
(2) latch attestation via `knob_set` erases "gate" from the model's
vocabulary — deliberate (one write path), revisit only with evidence the
model confuses it.

---

## A. Gates + resources on the wire

### A1. Resources — routing only (small)

`ResourcesHarness` already declares `resources:read/list/listTemplates`
with `exposure: "wire"` (`resources/src/harness.ts:260-278`); the gateway
just never routes them — `SESSION_SURFACES` omits `resources`
(`gateway/src/dynamic-commands.ts:38-46`).

- Add `"resources"` to `SESSION_SURFACES`.
- e2e (transport-in-process): `resources/read`, `resources/list`,
  `resources/listTemplates` round-trip; `commands/list` enumerates them;
  non-wire verbs stay MethodNotFound (deny-by-default preserved).

### A2. Gates — needs the slim harness first (the real work)

Gates today is a **controller, not a harness** (`gates/src/` = controller +
augment + react; zero command declarations). The dynamic lane requires a
per-surface inbox (`<surface>:<sessionId>:<surface>`) plus a
`gates:commands` meta-verb — i.e. BaseHarness machinery.

**Proposal: `GatesHarness` (slim) owning the `GatesController`.**

- `gates/src/harness.ts`: BaseHarness subclass; constructs and owns the
  controller (today constructed loose in `session-bridges.ts:308` and
  stapled on at `:314` — that construction moves inside). The controller
  remains the single convergence point for `useGate` + `session.gates`;
  the handle surface (`GatesHandle`, `GateHandle`) is unchanged.
- Declared commands, all delegating to the controller:
  - `gates:list` → `GateInfo[]` (exposure `wire`)
  - `gates:clear` `{ name }` (exposure `wire`)
  - `gates:defer` `{ name, reason? }` (exposure `wire`)
  - `gates:override` `{ name, value, reason }` (exposure `wire`) —
    verified-gates-only rule and the `GateOverrideAudit` trail stay in the
    controller; the command adds `origin: "wire"` identity to the audit
    entry (already threaded by `inbox.ask`).
- Register namespace `"gates"`; add `"gates"` to `SESSION_SURFACES`.
- **Alignment bonus:** this is the same shape as state-harness run #5 (the
  knobs twin) — gates joins the store-substrate world as a harness whose
  _values_ live in knobs but whose _verbs_ live on its own command surface.
  Also closes the documented gap at `gates/src/controller.ts:483-488`
  (gate reason/hit-counts not projected) — `gates:list` over the wire is
  the read; the delta-channel projection can ride the store fan-out later,
  not this ticket.
- Tests: harness spec (commands delegate + audit carries origin), wire e2e
  (clear/override/defer/list + `commands/list`), and the existing gates
  suites stay green (controller behavior untouched).

### A3. Client knows gates (in scope — Ryan, 2026-07-24)

A new harness the client can't see is half a harness. `client-next`
already has the sub-handle pattern (`session.tasks/knobs/elicitations/
timeline` — `client/src/index.ts:34-38`); gates joins it:
`client.session.gates` with `list()` / `clear(name)` / `defer(name,
reason?)` / `override(name, value, reason)` riding the A2 wire methods.
Read side: `list()` is RPC-backed (request/response) for now — the
_reactive_ client mirror (gate deltas as a channel projection) is the
known gap at `controller.ts:483-488` and rides the client
channel-consumer primitive, not this PR. Tests: client-side handle spec
against the in-process transport e2e.

**Non-goals:** no `gates` model tool — the model already has its gate
surface (`set_knob`/`knob_set` attestation); host/wire override is
deliberately NOT model-reachable.

---

## B. `responseFormat` on sends — `trail-response-format-send`

The named trailhead in `model/src/generate-object.ts`: structured **final
turns** at the session tier. ADR-42 dichotomy applied — two forms, one
canonical representation:

- **Declarative / wire-safe (canonical):** `SendInput.responseFormat?:
ResponseFormat` — the existing JSON-shaped spec type
  (`rendered-tree.ts:55` already carries it on compiled config). Fully
  serializable; works over `session/send` unchanged.
- **Live sugar (in-process only):** `SendInput.output?:
StandardSchemaV1<unknown, T>` — normalized at the session boundary into
  `responseFormat: { type: "json_schema", … }` via `toJsonSchema` (the
  `generateObject` path), and the final assistant text is parsed +
  validated into **`SendResult.data`**. Functions can't cross the wire, so
  `output` is rejected at the wire boundary (declare `responseFormat`
  there instead; the client parses).

Semantics:

- **Precedence:** send-level `responseFormat` overrides tree-level
  (`<config responseFormat>`), explicit-beats-ambient. Threads
  `SendInput → loop → ProjectInput` each tick; providers that support
  tools+response_format together just work (OpenAI/Google native;
  Anthropic adapter currently drops it — its tool-shaped strategy is
  `TODO(trail-anthropic-structured)` and is **called out, not silently
  worked around**; validation still catches non-adherence).
- **Failure:** schema given + final text doesn't parse/validate →
  `handle.result` rejects with a typed error (`ResponseValidationError`,
  carrying issues + raw text). Errors over nulls. One-round cheap-model
  repair stays `TODO(trail-object-repair)` — out of scope.
- **`SendResult.data?: unknown`** — present only when a live `output`
  schema was supplied. Wire `SendResult` is unchanged (no `data` — the
  schema never crossed).

Tests: session-level (output schema → typed data; validation failure →
typed error; precedence over tree config; wire rejection of `output`),
model-executor pass-through, e2e with fake adapter.

---

## B2. Structured execution results — the terminal-tool strategy (SPEC, 2026-07-24)

**Why B alone is not enough (Ryan's challenge, ratified).** `responseFormat`
is a _generation-time text constraint applied every tick_. In a multi-tick
agentic execution it (a) strangles interleaved narration on tool ticks,
(b) only works on providers with native response_format (Anthropic and
ai-sdk drop it), and (c) decouples "done" from "shaped" — nothing ties
emitting the conforming JSON to being finished. B therefore landed ONLY
the canonical plumbing; `SendInput.output` / `SendResult.data` were
descoped mid-flight into this design.

**The strategy: a terminal tool.** Inject a synthetic tool whose
`inputSchema` IS the output schema; the model calls it to deliver the
final answer; the call is the completion event.

- **Validation is free** — providers constrain tool arguments natively
  (ALL of them, including Anthropic: this erases the provider gap), and
  the tool executor validates inputs anyway.
- **Stop is free** — the loop detects the terminal tool's call in the
  tick's tool calls (by name, from the output spec — loop-side detection,
  no handler→loop back-channel needed) and ends the execution;
  `stopAfterTick` semantics already exist on the seam and in the session's
  tick-end fold.
- **"Done" and "shaped" become the same event** — the exact property
  responseFormat lacks.

**Per-execution scoping — the question that shaped this design.** No
forks required, no context injection required:

- The terminal tool binds through the EXISTING execution-scoped tool
  mechanism — `SendInput.tools: ToolDeclaration[]` is already "bound into
  the tool executor's registry for the duration of this execution, and
  removed when the execution closes" (`session-harness.ts:225-236`, with
  the ToolBinding precedence ladder). One send in a long session gets the
  tool; the next send doesn't. This is public API today.
- **The tool IS the instruction.** Its description carries "when the task
  is complete, call this with the final answer" — per-execution because
  the binding is per-execution. No last-message injection, no ephemeral
  system append; the tool's presence in the tick's tool list is the
  context. (If evidence shows description-driven compliance is weak, the
  enforcement rung below is the mechanism — never prompt splicing.)
- Timeline hygiene: the terminal call + result persist as ordinary
  history (informative — it shows the final answer); later executions
  seeing a past call to a no-longer-mounted tool is normal.

**Sources, two tiers (explicit-beats-ambient, as everywhere):**

- **Tree-level: `OutputDeclaration` — ALREADY SEEDED ON THE IR**
  (`spec/src/data/declarations.ts:547-562`, drawn with exactly the right
  distinction: "outputs the application wants to extract from the result.
  Distinct from `SpecConfig.responseFormat`, a generation-time provider
  directive"). Unconsumed today. `<Output schema={...}/>` compiles to it;
  it means "every execution of this agent produces this shape" —
  dedicated extraction agents, skill-runner children, forks. NOT required
  for the one-off case.
- **Send-level: `SendInput.output`** (returns, redefined) — "THIS
  execution produces this shape." Overrides the tree declaration. This is
  the long-session one-off; `skills.run` composes on it.

**Strategy selection (seam, not hardcode):** auto — tools mounted /
multi-tick possible → terminal tool; bare single-tick send → plain
`responseFormat` (constrained decoding is strictly better there; it's
`generateObject`'s domain). Overridable per output spec
(`strategy?: "tool" | "responseFormat"`).

**Capture:** `SendResult.data` = the terminal tool's validated input
(schema-validated by the executor; re-validated via `parseJsonWithSchema`
only on the responseFormat strategy path). Model ends WITHOUT calling the
terminal tool → `handle.result` rejects with a typed error (honest
failure), until the enforcement rung lands.

**Canonical `toolChoice` (RATIFIED + pulled forward — Ryan,
2026-07-24: "amend the tool params to include tool choice if it is
sufficiently normalizable and all adapters should then support it").**
Normalizability verified — the canonical form is
`toolChoice?: "auto" | "none" | "required" | { tool: string }`:

| Provider  | Translation                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------- |
| OpenAI    | `"auto"/"none"/"required"` verbatim; `{tool}` → `{type:"function", function:{name}}`                      |
| Anthropic | `auto`→`{type:"auto"}`, `required`→`{type:"any"}`, `none`→`{type:"none"}`, `{tool}`→`{type:"tool", name}` |
| Google    | `functionCallingConfig.mode` AUTO/NONE/ANY; `{tool}` → ANY + `allowedFunctionNames:[name]`                |
| ai-sdk    | `"auto"/"none"/"required"` verbatim; `{tool}` → `{type:"tool", toolName}`                                 |

Ships as its own small PR (spec `LanguageModelParameters` +
`buildParameters` + four adapter translations + per-adapter tests;
normalize-translate-escape-hatch — `providerOptions` still spreads last).
Multi-tool restriction (Google's `allowedFunctionNames` plural) stays in
the provider escape hatch, not the canonical form.

**Enforcement rung (folds into B2a once toolChoice lands):** when the
model stops without calling the terminal tool and an output spec is
required, the loop runs ONE forced wrap-up tick
(`toolChoice: { tool: <terminal> }`). Deterministic loop machinery, not
prompt hacking. B2b as a separate slice is dissolved by the pull-forward.

**Names:** default terminal tool name `submit_result`, configurable on
the output spec. NOTE the precedence ladder: a compiler-emitted tool of
the same name would SHADOW the execution-level binding — document, and
throw at bind time on collision rather than silently shadowing.

**Prefill-cache interaction (Ryan, 2026-07-24 — the rule this adds).**
Tools serialize at the head of the provider prompt, so a per-execution
tool injection is a prefix perturbation. Analysis:

- **Within one execution** the terminal tool is stable across ticks —
  tick 1 pays the (re)cache, ticks 2..n hit. The cost is bounded to one
  cold tick per one-off structured send, per provider cache TTL.
- **Anthropic — survivable with an ordering rule:** cache breakpoints
  cache the prefix THROUGH the marked block. RULE: execution-scoped tool
  bindings (the terminal tool included) MUST serialize at the TAIL of the
  tools list, AFTER any cache breakpoint on the stable tools — then the
  stable prefix through the breakpoint keeps hitting; only the tail is
  new. This ordering guarantee belongs to the projection (deterministic:
  tree tools first, execution bindings last) and gets asserted by the
  prefix-stability test (§6 item 4 — extend that test's scope to cover
  execution-scoped appends preserving the stable boundary).
- **OpenAI/Google:** automatic prefix caching hashes the serialized
  prompt including tools — the one-off execution busts and re-primes;
  bounded, unavoidable, documented (not worked around).
- **Tree-level `OutputDeclaration` is fully cache-stable** (the tool is
  always present) — one more reason dedicated extraction agents and
  skill-runner children should declare on the tree, not per-send.
- **`toolChoice` (B2b):** provider docs note tool_choice changes
  invalidate downstream cache segments — the forced wrap-up tick pays a
  partial cache cost on its single tick. Acceptable: it's the terminal
  tick by construction.

**Terminal-call tick semantics (pinned 2026-07-24).** If the model calls
the terminal tool ALONGSIDE other tools in one tick: the other calls
execute first (normal dispatch, results captured), the terminal capture
processes LAST, then the execution stops. Deterministic and testable; no
"terminal call cancels sibling work" surprises.

**Guarantees & testing strategy (pinned 2026-07-24 — the anti-flakiness
contract).** Three tiers:

1. **Mechanism — CI, deterministic** (FakeLanguageModelExecutor scripted
   runs): execution-scoped binding; tail-append ordering; stop-on-
   terminal-call; sibling-calls-first semantics; `data` capture +
   validation; miss → wrap-up tick with `toolChoice: {tool}`; still-no-
   call → typed error; name-collision throw; tree-vs-send precedence;
   steer conflict. Every spec claim above maps to a scripted test.
2. **Provider contract — CI, no network**: the four adapter translation
   unit tests (toolChoice mapping, schema pass-through).
3. **Behavioral compliance — EVALS, never CI**: "does the model call the
   terminal tool unforced" is model behavior, same epistemic category as
   gate attestation — measured in `@agentick/eval` on demand, reported as
   numbers, not asserted. B2a's deliverables include the eval suite.

The guarantee chain the docs state honestly: description-driven natural
path (usually) → forced wrap-up tick (`tool_choice` forcing is a HARD
provider guarantee — the model cannot respond without calling it, args
provider-constrained to the schema) → executor validation → typed error
in the residual sliver. Plain `responseFormat` is strictly weaker
(Anthropic: none).

**Presentation scoping (Ryan, 2026-07-24).** `skills.run` is the
flagship consumer; `SendInput.output` is the primitive it composes on —
documented as plumbing, not marketed as a general "structured output"
promise until the eval tier produces compliance numbers. Docs carry an
honest guarantees section (natural path / forced path / failure mode).

Sequencing (ratified 2026-07-24: "land B then go B2a" + toolChoice
pull-forward): land B (in flight, descoped) → **toolChoice PR** (small,
independent — overlaps B's files in spec/model/adapters, so sequential
after B, never parallel with it) → **B2a** (OutputDeclaration consumption

- terminal-tool strategy + `SendInput.output` + `SendResult.data` +
  typed miss error + the enforcement wrap-up tick, since toolChoice will
  exist + the compliance eval suite). C (`skills.run`) rides B2a. The B2a
  delegation scout can run read-only in parallel with the toolChoice PR.

---

## C. `skills.run(name, opts)` — the model executes, the skill guides

Flue-aligned, line preserved: _skills guide agent work; they do not add
executable capabilities._ `run` is sugar composing existing primitives:

```ts
const review = await session.skills.run("review", {
  args: { change },
  output: z.object({ approved: z.boolean(), summary: z.string() }),
});
review.data; // typed, validated
```

Mechanics (in `@agentick/skills-next`, on `SkillsHandle`):

1. `require(name)` → the `Skill` record (throws on missing — existing).
2. Compose the send: skill instructions + serialized `args` as the message
   payload. **Seam over setting:** `withSkills({ composeRun })` — a
   `(skill, opts) => SendInput` callback; we ship the default composition,
   the seam is the truth.
3. `allowed-tools` frontmatter → `SendInput.tools` filter (field exists).
4. Execute + validate via **B** (`output` → `SendResult.data`).
5. Return `SkillRunResult<T> = { data, text, usage, ticks, executionId }`.

**Execution site — reframed (Ryan pushed on `isolate: { agent }`; he was
right to).** Default **inline** (`session.send` on the calling session) —
matches Flue, zero new machinery, and skill work is often conversation
work. But the isolated form is not a _spawn_ — spawning a different agent
is not what "run this skill off to the side" means. It's a **fork**:

- **`spawn` = new process image**: a _different_ agent root, fresh state.
  Exists (`session.spawn`).
- **`fork` = same image, copied state**: the _same_ agent tree, a copy of
  the current session state (timeline projection, knobs, state), diverging
  without writing back. Does not exist today — but it's pure composition:
  `session.snapshot()` → `spawn({ agent: <own root> })` (no send) →
  `child.restore(snapshot)` → return child. Sugar, not subsystem.

The fork is what a skill actually wants: a review skill needs the
conversation it's reviewing (fresh-context isolation would blind it), and
the parent wants the verdict without thirty turns of working noise. So:

- **Propose `session.fork(opts?)`** as a session primitive (sugar over
  snapshot/spawn/restore; needs one small enabler — `SpawnInput.agent`
  defaulting to the parent's root, which the app's `spawnContext` can
  supply). CS-canonical pair: spawn = new program, fork = copy of self.
- `skills.run(name, { isolate: true })` → fork, run inline _in the fork_,
  return the validated result, dispose the fork. No `agent` option in the
  skills API at all — if you want a different agent running your skill,
  that's `session.spawn` + `skills.run` composed yourself.

Open question flagged honestly: what the fork copies is exactly what
`snapshot()` captures — if a store-backed harness isn't snapshot-complete
yet (store fan-out in flight), the fork inherits that gap. Acceptable:
fork fidelity improves as the manifest work lands, for free.

Wire: `skills:run` as an `exposure: "wire"` command comes later (needs the
declarative `responseFormat` form only — serializable by construction);
not in this ticket.

### C split (2026-07-24, post-scout — three spec assumptions corrected)

The C terrain scout falsified three assumptions; C splits into C-core
(now) and C2 (follow-up):

1. **`SkillsHandle`/`SkillsHarness` have ZERO session access** — both are
   constructed from substrate only; `run` on the handle cannot reach
   `session.send`. Ruling: **capability injection, not ambient session**
   (the D principle applied to harnesses): the skills harness gains a
   late-bound `bindRunner(send)` seam (the `adoptTelemetry` precedent) —
   injected at install with ONLY the send capability (type lives in
   spec; no skills→session package edge; dependency graph verified clean
   both directions). `session.skills.run(...)` then reads exactly as
   intended. Reentrancy note: `skills.run` during an in-flight execution
   takes the steer-join path carrying `output` → the existing
   `SteerCannotCarryStructuredOutput` guard rejects it honestly — no new
   guard needed; document it.
2. **`allowed-tools` does not exist** — not on the `Skill` record (only
   name/description/content/tags/metadata) AND there is no per-execution
   tool-RESTRICTION seam anywhere (`SendInput.tools` is additive; the
   loop hardcodes `compileForTick({exposure:"model"})`; `ToolListFilter.
nameMatches` is a single string, not an allowlist). **C2**: add the
   Skill field (align with Agent Skills frontmatter, feeds E1's loader)
   - a `SendInput` restriction seam threading into `compileForTick` +
     the `output`×restricted-tools strategy interaction test.
3. **Fork's missing enabler confirmed**: the session does not retain its
   own root (`options.agent` forwarded to the compiler, never stored),
   and `SpawnInput.agent` is required — the app-level fallback is the
   APP root, wrong for previously-spawned children. **C2**: store the
   session's agent, make `SpawnInput.agent` optional defaulting to it,
   then `session.fork()` sugar + `isolate: true`. **C-core is
   inline-only** — `isolate` rejects with a typed not-yet error naming
   the follow-up, never silently running inline.

C-core ships: `skills.run(name, { args?, output?, maxTicks?, signal? })`
on the handle (late-bound runner), default composition = system-role
skill message + user-role args message (v2 has no structural `system`
field — deliberately; a `messages` entry with `role: "system"` is the
path), `composeRun` seam on `withSkills`, `SkillRunResult<T> = { data,
text (:= SendResult.response), usage, ticks, stopReason, executionId }`,
riding B2a's `output` end-to-end.

### C1.1 — run returns the execution handle (LANDED 2026-07-24, simplified)

`run` is a send in a trenchcoat and was swallowing the handle the
injected `SessionSendCapability` already returns. Ryan started the
generics (`SendResult<T>`, `SessionExecutionHandle<T>`) and spotted the
deeper cut: with the handle generic, **`SkillRunResult` should not exist
at all** — the wrapper's only delta was renaming `response` to `text`.
Final shape: `SendInput<P, T>` (output: `StandardSchemaV1<unknown, T>`)
→ `send<T>` / `run<T>` both return `Promise<SessionExecutionHandle<T>>`
— ONE grammar, zero mapping layer, `data` typed at the call site (this
also closes B3 fix #2 for the session tier ahead of schedule).
`SkillRunResult` deleted. Also landed with it: the canonical
`FakeLanguageModelExecutor` gained a scripted `holdUntil` race knob, and
the app skills e2e migrated off its bespoke `mkExecutor` (the
duplicate-helper disease, caught by Ryan).

Depends on B. Tests: run-with-schema (typed data), run-without-schema
(text), `allowed-tools` scoping, `composeRun` seam override, missing skill
throws, inline timeline effects documented in the spec test.

### C2 — fork + isolate + allowedTools (LANDED 2026-07-25)

All three C-split follow-ups shipped in one slice:

1. **Fork enabler + `session.fork()`.** The session retains its own
   agent root (`agentRoot` field; `options.agent` still forwarded to the
   mount unchanged); `SpawnInput.agent` is now OPTIONAL, defaulting to
   the parent's root (`SpawnContextChildInput.agent` stays required —
   the session resolves the default before the spawn-context boundary).
   `fork(input?: ForkInput)` = `snapshot()` → `spawn({})` (unbound,
   same-image) → `child.restore(snap)`. The scout's key finding held:
   restore already worked on a never-sent child, so fork is pure
   composition — the retained root was the ONLY missing primitive.
   `ForkInput` carries sessionId/metadata/maxTicks only (no agent — a
   fork is by definition same-image; no send — always returned unbound).
   Not wire-exposed (later slice, with the client fork story).
2. **`skills.run({ isolate: true })` works.** `RunnerBindable` gained an
   OPTIONAL `bindIsolationRunner(SessionSendCapability)` sibling; the
   APP (which owns the send closure and IS the SpawnContext — the scout
   map's one wrong anchor: the bind site was never in the session
   package) binds a closure doing `session.fork()` → `child.send()` →
   dispose-after-settle (`disposeChildSession`, errors swallowed, never
   masking the run result). Skills stays capability-dumb: isolate with
   no runner bound STILL throws `SkillIsolationUnavailable` — never a
   silent same-session degrade. Isolation invariant e2e-pinned: the
   parent timeline gains NOTHING from an isolated run; the child is
   disposed from the live registry after the handle settles.
3. **`allowedTools` restriction seam.** `Skill.allowedTools` (+
   register/update inputs) → `composeRun` threads it →
   `SendInput.allowedTools` → `RunExecutionInput`/`TickInput` → the loop
   filters the MERGED model-visible list (Set on canonical `name`) after
   the compiler-tools merge + `compileForTick`, BEFORE terminal-tool
   injection — so `submit_result` is exempt by construction, and
   `resolveAutoStrategy` reads the POST-restriction count (empty ⇒
   `toolsMounted: false` ⇒ responseFormat on capable targets; both
   interaction cases test-pinned). `ToolListFilter` deliberately
   untouched — restriction is a loop-assembly concern, not a registry
   filter (no consumer needs a registry-level names filter yet).
   Dispatch door unaffected (restriction scopes the MODEL's view only).
   `TODO(E1)` left at composeRun for the frontmatter `allowed-tools`
   mapping (loader work). Skill record is the only source in C2 — no
   opts-level override.

Thirteen tests across skills/session/app pin the invariants (restriction
reaches the model via `seenRuns`, additive×restriction composition,
terminal-tool exemption, empty-restriction auto-resolution, fork state
copy + divergence, isolate e2e, `SkillIsolationUnavailable` without a
bound runner, `Skill.allowedTools` round-trip).

---

## B3. Structured-output completion pass (usage-walk punch-list, ratified 2026-07-24)

The C-era usage-walk found three defects; one PR closes all three:

1. **Capability-aware strategy auto.** Today auto keys ONLY on
   tools-present — a bare send with `output` on a target without native
   json_schema (Anthropic; its adapter drops responseFormat) reliably
   fails with ResponseValidationError. Fix: auto = terminal tool when
   (tools mounted) OR (!target.capabilities.supportsJsonSchema). The
   signal exists on ExecutionTarget. One-line policy + tests per branch.
2. **Generic send/result typing.** `skills.run<T>` types `data`; raw
   `send` leaves `data: unknown` — typing that evaporates at the primary
   door. Fix: `send` generic over the output schema; `SendInput<P, T>`
   (output: StandardSchemaV1<unknown, T>) flows to `SendResult<T>.data:
T | undefined`. Wire shapes untouched.
3. **Close TODO(b2a-tree-data).** Tree-only `<Output>` injects, captures,
   stops — but `data` never materializes (session retains only the SEND
   schema). The loop resolves the tree schema per-tick
   (OutputDeclaration.schema is StandardSchemaV1, in-band) — so validate
   tree-tier capture where the schema lives and surface the validated
   value on ExecutionRunResult for the session to place on `data`.
   Completes the dedicated-extraction-agent story.

Then: **C2** (fork enabler + `session.fork()` + `isolate: true`;
`allowed-tools` Skill field + per-execution restriction seam threading
into `compileForTick` — LANDED, see §C2), and the **onBusy redesign**
(below — supersedes the earlier "steer-verb extraction" sketch).

### onBusy redesign (LANDED — supersedes steer-verb extraction)

Ryan rejected a separate `session.steer()` verb ("should we just add an
option to .send() to define steering method"): steering stays an option
ON the one send grammar, not a second verb. The ratified shape:

- **`SendInput.onBusy?: "steer" | "queue"`** replaces
  `delivery?: SendDelivery ("steer" | "followUp")`. `"queue"` is
  today's `"followUp"` semantics (await quiescence, then a fresh
  execution) under the name callers actually reach for. Type
  `OnBusy = "steer" | "queue"` replaces `SendDelivery`. No back-compat
  alias (house rule).
- **Smart default.** Unset `onBusy` resolves per send shape: a send
  carrying structured output (`output` or `responseFormat`) defaults to
  `"queue"` (a steer has no final turn to shape); a plain send defaults
  to `"steer"` (today's default, ADR 53 §5 join). Both modes remain
  identical on an idle session.
- **Conflict errors only for EXPLICIT contradictions.** The join-point
  guard (`SteerCannotCarryStructuredOutput`) now fires only when the
  caller EXPLICITLY set `onBusy: "steer"` AND carried
  `output`/`responseFormat` AND actually joins an in-flight execution.
  Implicit structured sends never hit it — they queue. Explicit steer
  on an idle session still degrades to a fresh send (no conflict
  materialized — the guard is a join-point fact, not input validation).
- **Behavioral delta (accepted):** `skills.run` with `output` racing an
  in-flight execution used to throw `SteerCannotCarryStructuredOutput`;
  under the smart default it now QUEUES and runs after quiescence — the
  honest semantics the throw was approximating.
- **Fold the dead wire method.** `session/queue` (wire params + client
  stub + retry/offline predicates, NO server handler — the TODO(4b)
  vestige) is DELETED; its semantic is `send({ onBusy: "queue" })`.
- Wire rename rides along: `SessionSendParams.delivery` → `onBusy`,
  gateway passthrough, client handle passthrough.

---

## D. Per-harness model tools — convention, not mechanism (LANDED 2026-07-26 — knobs ctx-slot normalization deferred to the TODO(tools-sweep) hoist trailhead; see STATUS)

Codify in ADR 27 (layout addendum) + this first sweep:

- **Convention:** a harness MAY ship `src/tools.ts` — hand-authored,
  model-facing tools for the actions that make sense — behind a uniform
  `registerModelTools` option on its `withX()` (default per-harness
  judgment; resources chose ON). Tools are thin front-ends: forward to the
  harness's command/handle (reusing its validation), model-directed
  naming + descriptions, honest degradation when unmounted. Template:
  `resources/src/tools.ts`.
- **Naming law: `<harness-noun>_<verb>`** (Ryan, 2026-07-24). The harness
  noun is the namespace; tools sort together per harness in the model's
  list: `resource_list`, `resource_read`, `skill_list`, `skill_read`,
  `knob_set`. **Rename sweep:** `set_knob` → `knob_set` (inverts the
  pattern today) — touches the gates attestation story, `<Knobs/>` docs,
  and tests; finish with an unfiltered grep for the dead name. Audit the
  tasks tools (`session_tasks_*`) against the law in the same sweep.
- **How tools reach their harness — `ctx` slots, NOT `ctx.session`.** The
  rule already codified in `spec/src/data/tool-handler.ts:88-98`:
  substrate harnesses every session has (elicitation, tasks, resources)
  are hardcoded `ctx` fields; optional harnesses contribute
  `ctx.<slot>` via `ToolHandlerCtxExtensions` augmentation (ADR 66),
  dispatch-resolved from the live bridge; `use:` is reserved for
  tree-positional context. The tool audience gets the same treatment as
  the other two: a **curated projection of the session, not the session**.
  Exposing the full `SessionHarness` on ctx would hand every
  model-triggered handler `send`/`close`/`spawn`/`snapshot` — ambient
  authority plus reentrancy (send-within-tick) for zero curation.
  Adopters who genuinely want the whole session close over it in their
  own tool definitions — their session, their call; shipped tools never
  do. **Two convention obligations:** (1) a harness that ships tools also
  contributes its ctx slot (skills adds `ctx.skills?: SkillsHandle` in
  `augment.ts`); (2) normalize knobs onto the rule — `set_knob` today
  captures the harness via `use: () => ({ knobs: useBridges().knobs })`
  (`knobs/src/react/knobs.tsx:277`), which the rule reserves for
  tree-positional context; give knobs a ctx slot and make `knob_set`
  dispatch-resolved like every other harness tool.
- **Explicitly rejected:** an automatic command→tool bridge. The axes are
  deliberately orthogonal (`CommandExposure` = reachability;
  `ToolExposure` = audience); mechanical projection gets naming, prose,
  input shape, and degradation wrong. Record this in ADR 27 so it isn't
  re-litigated.
- **First sweep: skills only.** `skill_list` + `skill_read`
  (progressive disclosure — the model discovers skill names/descriptions,
  reads one on demand; the Claude Code pattern), `exposure:
["model","dispatch"]`, default ON behind `registerModelTools`.
  Timeline/prompts/state tools are deferred — each is a policy question
  (a model-invocable `compact` needs the guard story told first), and the
  convention shouldn't launch with filler tools. `TODO(tools-sweep)`
  markers at each candidate harness.

Tests: skills tools spec (list/read/degradation), conformance that
`registerModelTools: false` mounts nothing.

---

## E. Skill distribution & discovery (Flue-inspired, seams mostly exist)

Skills already have the loader seam: `withSkills({ loaders })`, evaluated
at install (`skills/src/extension.ts:53`), with `fromArray` / `fromUrl` /
`fromManifest` / `fromDirectory` shipping today (`loaders.ts`,
`loaders-node.ts` — Node subpath, recursive `.md` walk). Three additions,
in order of value:

1. **`agentSkillsDirectory(root?)` loader preset** — discovers
   [Agent Skills](https://agentskills.io/specification)-compatible
   directories (default `<cwd>/.agents/skills/`): each `<dir>/SKILL.md` is
   one skill record (frontmatter `name`/`description`/`allowed-tools`
   mapped onto the `Skill` shape); reject sensitive files + symlinks at
   load, per Flue's packaging rule. Sandbox-side discovery falls out —
   point it at the sandbox cwd.
2. **Supporting files ride the RESOURCES harness — composition, not new
   machinery.** A skill directory's `references/*` register as resources
   (`skill://<name>/references/checklist.md`) so the model pulls them
   progressively via `resource_read`. Two harnesses composing is the
   design proven (withMCP already proxy-registers remote resources into
   the same registry); no "skill file API" gets invented.
3. **npm-packaged skills** — `fromPackage("@acme/review-skills/review")`
   resolving the subpath via the host's resolver, then delegating to (1)'s
   directory semantics. The package exports its `SKILL.md` subpath;
   distribution is npm's problem, which is the point.

**Deferred, not promised:** Flue's
`import review from '…/SKILL.md' with { type: 'skill' }` import-attribute
form needs a Node loader hook / bundler plugin — real machinery, real
publish-surface risk (and a no-TLA-gate interaction to check). Investigate
after 1–3 prove out; `fromPackage` covers the use case without new
toolchain.

---

## F. `session.tools` — the missing handle (design, open)

Tools are the one session collection WITHOUT a handle: today it's the raw
`session.toolExecutor` (full `ToolExecutorProtocol`) plus the
`session.dispatch(name, input)` sugar. Every sibling collection got the
handle treatment (`timeline`, `knobs`, `gates`, `state`); tools should
read the same way — and per the data-layer rule, an in-memory registry
with a sync read surface holds a View, so `list()` is sync.

```ts
interface ToolsHandle {
  list(query?: { exposure?: ToolExposure }): ToolInfo[]; // sync (View)
  get(name: string): ToolHandle | undefined; // name-then-alias
  has(name: string): boolean;
  dispatch(name, input, opts?): Promise<readonly ContentBlock[]>;
  subscribe(listener): Unsubscribe; // topology (add/remove)
}
interface ToolHandle {
  readonly name: string;
  readonly info: ToolInfo; // declaration projection incl. exposure
  dispatch(input, opts?): Promise<readonly ContentBlock[]>;
}
// session.tools.list({ exposure: "model" })
// session.tools.get("resource_read")?.dispatch({ uri })
```

Decisions inside this design:

- **Shape follows the sibling handles, exactly.** The knobs/state handle
  grammar is the convention: sync reads (`list`/`get`/`has`), async
  mutations, `subscribe(name, listener)` + `subscribeAll(listener)` — the
  draft above adjusts to that pair (per-tool subscription = declaration
  changes; `subscribeAll` = topology). No novel verbs, no novel
  signatures; a user who knows `session.knobs` already knows
  `session.tools`.
- **Verb: `dispatch`, not `run`.** It's the established verb across the
  codebase (`toolExecutor.dispatch`, `knobs.dispatch`, wire
  `session/dispatch`, `via: "dispatch"` provenance). One vocabulary.
- **Field: `exposure`, not `audience`** — `audience` is the v1 name;
  v2's `ToolDeclaration.exposure: ToolExposure[]`
  (`declarations.ts:337`).
- **Client side (in scope):** a client `ToolsHandle` per ADR 87 —
  `tool-executor/src/client/` gains it beside the existing
  client-tool-calls lane (`ClientToolCallsHandle` is the respond/confirm
  surface, a different concern; naming must not collide). Extends
  `ClientHandle, Enumerable<ToolInfo>` like `KnobsHandle`
  (`knobs/src/client/knobs-handle.ts:49`). Dispatch rides the existing
  `session/dispatch` wire method; **enumeration needs a wire read that
  doesn't exist yet** — declare `tools:list` (`exposure: "wire"`) on the
  tool-executor harness + add its surface to `SESSION_SURFACES`. Without
  it the client handle would be dispatch-only, which violates the
  enumeration rule.
- **`session.dispatch` — recommend REMOVE** once the handle lands.
  It duplicates `session.tools.dispatch` verbatim; the philosophy is one
  way, done well, and the no-backcompat window is exactly when this cut
  is free. The wire method `session/dispatch` is unaffected (wire names
  are a separate, stable contract). Alternative (if vetoed): keep it as
  documented sugar delegating to the handle. **Ryan calls it.**
- `ToolInfo` is the wire-safe projection (name, description, exposure,
  aliases, annotations, `hasInputSchema`) — NOT the live declaration with
  the Standard Schema on it; power users keep `toolExecutor`.

Scope note: this is additive surface + one removal sweep
(`session.dispatch` call sites are internal + docs); the executor
registry already has everything the View needs.

---

## G. Client handle parity — the symmetry law (Ryan, 2026-07-24)

**Law: a harness that projects a session handle ships the matching client
handle.** Same noun, same verb grammar (minus what can't cross the wire),
rows typed by the wire projection, `Enumerable` by default, delivered per
ADR 87 (`/client` subpath: `declare module` types the slot + registers the
runtime factory; `@agentick/client-next` bundles built-ins — bundled, not
privileged, same as ADR 27 server-side).

Current inventory vs the law:

| Server handle | Wire surface                                                                                                           | Client handle today    | Parity work                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| timeline      | ✓ (`session/timeline_history`, `timeline/*`)                                                                           | ✓                      | —                                                                                   |
| knobs         | ✓ (`knobs/*`)                                                                                                          | ✓                      | —                                                                                   |
| tasks         | ✓ (`tasks/*`)                                                                                                          | ✓                      | —                                                                                   |
| elicitation   | ✓ (`session/respond_to_elicitation`)                                                                                   | ✓                      | —                                                                                   |
| tools (F)     | `session/dispatch`; needs `tools:list`                                                                                 | client-tool-calls only | **F**                                                                               |
| gates (A2)    | after A                                                                                                                | —                      | **A3**                                                                              |
| resources     | declared, unrouted                                                                                                     | —                      | **G** (after A1)                                                                    |
| skills        | ✓ (`skills/*` routed)                                                                                                  | —                      | **G**                                                                               |
| prompts       | ✓ (`prompts/*` routed incl. `invoke`)                                                                                  | —                      | **G**                                                                               |
| state         | surface routed, but `state:set/delete` omit `exposure` → `"addressable"`, NOT wire-reachable (corrected by PR-A scout) | —                      | **G** (+ explicit `exposure: "wire"` on state's commands)                           |
| model         | in-process only                                                                                                        | —                      | deliberate hold (model swap over the wire is an authz question — decide separately) |

G's scope: `/client` subpaths for **skills, prompts, resources, state** —
mechanical application of the knobs template (`knobs/src/client/`), read
verbs RPC-backed, mutations riding the already-routed dynamic-lane
commands. Reactive mirrors (channel-backed views like `knobsStateView`)
remain gated on the client channel-consumer primitive — parity here means
verbs + enumeration, not live state.

Also codify the law itself in ADR 87 (one paragraph), so the next harness
can't ship handle-less by accident: the per-harness checklist becomes
harness + augment + extension + conformance + `/client`.

### Audit outcomes (2026-07-24 — full matrix in the session record)

Table corrections applied by the audit: **gates A2+A3 and resources A1 are
LANDED** (rows above now historical); skills/prompts rows were misleading —
routed for MUTATIONS only: **skills has NO wire read at all**
(register/update/remove only — enumeration wire-unreachable), **prompts
lacks `prompts:list`** (has single `get` + `invoke`), **state has no read
command in existence** (and set/delete are exposure-less) — a client state
handle needs `state:get`/`state:list` AUTHORED, not re-flagged.

**G-prep (new, blocks G):** one PR authoring the missing wire reads +
grammar alignment before the four client handles:

1. `skills:list` (+`get`/`search`), `prompts:list`, `state:get`+`state:list`
   + `exposure:"wire"` on state's mutations; wire-augment splits (the
   `export {}` guard is load-bearing).
2. Grammar deviations ruled worth fixing while breaking is free:
   - `GatesHandle` gains `has()` + `subscribe(name,fn)`/`subscribeAll(fn)`
     (only collection missing the family grammar); gate handle MUTATIONS
     route through the harness commands (async, journaled) instead of
     sync-void direct controller calls — aligns the three divergent return
     contracts AND makes host-side clears journaled.
   - prompts: `getDeclaration(name)` → `get(name)` (sync, the family
     convention); async render `get(input)` → `render(input)`.
   - resources `subscribeListChanged` → `subscribeAll` (MCP vocabulary
     belongs at the wire projection, not the adopter handle).
   - `state.list()` returns entries (`{key, value}[]`), not bare keys —
     same projection depth as siblings.
3. Ruled DEFENSIBLE, documented not changed: resources' async
   `list/read` (resolver-backed; `snapshot()` is the sync View read),
   timeline's single `subscribe` (a log, not a keyed map), tasks'
   `events(id)` AsyncIterable (richer primitive for task streams).

F additions from the audit: `tool-executor` is NOT in `SESSION_SURFACES`
(add a surface + `tools:list` + wire-augment split); the client tools
handle must not collide with the existing `clientToolCalls` slot.

Sequencing: B3 lands → **G-prep** → F + G (parallelizable per package)
→ C2 → onBusy redesign (supersedes steer-verb extraction) → §D naming
sweep (knob_set, session_tasks_* → task_*).

---

## Sequencing & gates

1. **A** (independent, decided) — one PR: GatesHarness + SESSION_SURFACES
   for both `gates` and `resources` + the client gates handle (A3).
2. **B** (the enabler) — one PR.
3. **C** (rides B; `session.fork` enabler can land inside it or as its own
   small PR first) — after the fork ratification.
4. **D** (independent; can run parallel to B/C) — one PR: ADR 27 addendum
   - skills tools + `knob_set` rename/normalization sweep.
5. **E** (independent; E1+E2 one PR, E3 later) — loader presets +
   references-as-resources.
6. **F** (independent) — ToolsHandle (server + client + `tools:list`
   wire read) + `session.dispatch` removal sweep.
7. **G** (after A1 for resources; otherwise independent, parallelizable
   per package) — client handle parity: skills, prompts, resources,
   state; ADR 87 law paragraph.

Per-PR verification: root `npx vitest run packages-next/<touched…>`;
workspace `pnpm typecheck --force`; oxfmt/oxlint; `pnpm check:no-tla`;
READMEs updated per package (Verified-by sections); STATUS.md prepended.

## Delegation protocol (applies to every PR above)

The recurring agent failure mode is not ignorance of the task — it's
ignorance of the existing seam, or drift under friction (the seam
resists, the agent invents a bypass / parallel structure). Countermeasure
is in the brief, not in agent diligence:

1. **Scout at delegation time, not spec time.** Before each PR is
   dispatched, a read-only exploration pass refreshes the terrain (this
   codebase moves; `file:line` anchors in this spec rot). The scout
   output feeds the brief; the implementing agent receives a terrain
   map, never a research assignment — an implementer that explores
   first hands you its _interpretation_ of the architecture, which is
   the thing that drifts.
2. **Brief structure (all four parts mandatory):**
   - _Terrain map_ — the seams it will touch and the template to copy,
     each with fresh `file:line` (e.g. G copies `knobs/src/client/`
     verbatim in shape; D copies `resources/src/tools.ts`).
   - _The delta_ — what changes, spelled against the terrain.
   - _Anti-goals + stop rule_ — "the seam is X; do NOT create a
     sibling; if X can't accommodate the requirement, STOP and report
     the mismatch — that is a successful outcome." Name the specific
     parallel structure the task tempts (a second controller, a
     duplicate schema helper, a bespoke channel).
   - _Required reading_ — the exact ADRs (27, 42, 51, 66, 87, 90 as
     relevant), not "read the blueprint."
3. **Rails**: conformance suites + the existing tests are named in the
   brief as invariants ("these stay green, unmodified" — test edits
   require a reported justification).
4. **Architect end-gate** unchanged: diff review + adversarial pass +
   gates before commit; commits stay Ryan's.
5. **Mid-flight amendments are unreliable — twice bitten (B, B2a).** A
   mailbox message to a BUSY implementer may sit unread until a later
   resume: B built the full pre-amendment scope and applied the descope
   only on resume (crossing the interim landing call); B2a shipped
   without the stopReason amendment and applied it as a post-report
   delta. RULE: a scope amendment to a busy agent is not real until
   acknowledged — either require an explicit ack before relying on it,
   or (preferred) hold the change and apply it as a judged DELTA after
   the report, which worked cleanly both times. Also expect the
   redundant crossed follow-up after any nudge; judge the TREE, not the
   correspondence.

## Decisions — RATIFIED (Ryan, 2026-07-24: "i think i am aligned")

1. **A2 shape:** GatesHarness owning the controller — YES. A3 client
   handle in scope.
2. **C site:** inline-default; isolation = `session.fork()` (sugar over
   snapshot/spawn/restore) + `skills.run(name, { isolate: true })` — YES.
3. **D scope:** skills-only first tools sweep + `knob_set` naming law —
   YES.
4. **F:** ToolsHandle as drafted; `session.dispatch` REMOVED (one way).
5. **G:** parity law + model-handle hold — YES.

Residual per-PR determinations (seam-level, not design-level) are made
after each delegation-time scout and reported with the dispatch.
