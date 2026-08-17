# Agentick v2 — Implementation Status

**Branch:** `feat/v2`

**2026-08-11 — the bespoke `guardCodeExecute` is deleted; the generic guard bag was always enough (branch `feat/code-host`).**

`CodeHarness.guardCodeExecute` is **gone**, and with it the last Effect on the code surface. It was a two-line delegation to the protected `guardEffect`, which meant the harness published an Effect-only door to a seam `BaseHarness` already exposes generically and plainly:

```ts
codeHarness.guard({
  codeExecute: (input) =>
    input.source.includes("child_process")
      ? { kind: "veto", reason: "no subprocess spawning" }
      : { kind: "proceed" },
});
```

**Verified before deleting, not after.** `guard(bag)` types `input` as `CodeExecuteInput` straight off the `CommandRegistry` augmentation with no annotation (probed `source`, `codeHash`, `bindings`), accepts sync AND async deciders, treats a bare `return` as proceed, and lands on the same `registerOwn(tagInterceptor("guard", …))` path `guardEffect` does — so the deletion changes no semantics. It is in fact NARROWER in the right way: the bag entry is keyed to `code:execute`, where `guardCodeExecute` guarded every command on the harness.

Five pins migrated (`harness.spec.ts` ×4, `source-processing.spec.ts` ×1), all now plain — including the lint-gate and the fx-cannot-defeat-a-binding-veto pins, which read better without the `Effect.succeed` wrapper around what was always just data. Both READMEs' guard examples are plain bags; the Effect variants are dropped rather than demoted, because the public Effect-guard path (`fx.guard`) is a base-harness change that has not landed and `guardEffect` is protected — documenting a form nobody can call would be worse than documenting none.

**Net: `@agentick/code` and `@agentick/code-host` READMEs now contain ZERO Effect.** The remaining `from "effect"` imports in those packages are implementation (the `fx` twin, journal Stream reads in tests), not adopter surface. Orphaned `GuardDecider` / `Unsubscribe` imports removed — oxlint caught both. Unfiltered grep confirms `guardCodeExecute` survives nowhere in `packages/`, `docs/proposals/v2/code.md`, the package description or any test; the only hits left are in superseded STATUS entries below, which are log.

Gates: `npx vitest run packages/code packages/code-host packages/app` (387) and full root green; `pnpm typecheck --force`; oxfmt/oxlint clean; byte-scan clean.

**2026-08-11 — the one-shot is `execute`, and the pre-run pipeline is three shapes (branch `feat/code-host`).**

**`Code.run` → `Code.execute`.** The command is `code:execute`; the public method that rides it now has its name. **This supersedes the `run`-takes-one-bag entry below** — the bag survives verbatim, only the verb changed, and pre-publish it is free. `run` does NOT survive as an alias. 71 call sites swept by a receiver-allowlisted codemod (`harness` / `instance` / anything ending `code`, `code!`, `code?`), which is what kept the four unrelated `.run(` receivers in the same files untouched: `child.run(src, signal)` in the provider example, `base.run(input)` in two app runner tests, and `session.skills!.run(...)`. `isCodeInstance` now structurally tests `execute`.

**The type-name reconciliation.** Three inputs reach one verb and none may collide, so the one-shot's bag is `CodeOneShotInput` — named for the SHAPE, not the verb, because `CodeExecuteInput` is already the command's input (the audit record the harness derives, and the name `CommandRegistry` types the verb with) and `CodeExecuteRequest` is already the `fx` door's `{contextId, source}`. Renaming the audit type to free the prime name was considered and rejected: it would churn the ADR-51 `{Verb}Input` convention, the command registry declaration, every guard and hook signature and their tests, to win a naming preference. Prose now distinguishes `code.execute` (the one-shot) from `context.execute` (the REPL call on an open context), which are the same verb at two scopes.

**Pre-run pipelines — the headline, and a correction to the brief.** The ask described `onBeforeCodeExecute` as `(input, next, ctx) => next(input)`. It is not: `BeforeHook` is `(input, ctx) => In | void`, one-sided by construction, and the `(input, next, ctx)` form is `onCodeExecute`, the around-middleware key `CommandHooks` mints from the same registry entry. **Both are plain async; neither can veto.** So the section teaches four rows: rewrite → `onBeforeCodeExecute` returning a changed input; observe → the same hook returning nothing; needs-the-answer → `onCodeExecute`; refuse → `guard({ codeExecute })`. Two new behavioral pins in `source-processing.spec.ts` cover the observe and around shapes (the rewrite one already existed), including that `ctx.log` really is reachable on the hook ctx — verified before documenting, not assumed.

**Effect hygiene** was done in two passes. The first labeled the guard as the one Effect-native seam; the entry above supersedes it — the guard examples are now plain and the READMEs carry no Effect at all. The `fx.` audit stands: the only one in either README is the API table's `fx.execute`.

**The provider-specific transform example is `"use strict"`, and it is real.** An AsyncFunction body is sloppy mode, which is why a program assigning over a frozen namespace fails SILENTLY — already documented, never actionable. A one-line `onBeforeCodeExecute` prepending the directive turns that into a `TypeError` the model can read; measured both ways before writing it (sloppy returns `"original"`, strict throws `Cannot assign to read only property 'search'`). Paired with a `[!WARNING]` against the tempting wrong pass: putting `transpiler()` in a hook to pre-strip types would fire a rewrite event on every execution and leave the journal carrying emitted JavaScript instead of the program its author wrote — which is exactly the property `language: "typescript"` preserves by transforming below the audit boundary.

Both READMEs gained a "Running TypeScript" section (code's points at the provider and at the checking pipeline; code-host's is the concrete one) and a pipelines section (code's owns the seam semantics; code-host's is the engine-specific worked set, cross-linked). Every example compiles in the two `readme-examples.type.spec.ts`. Gates: `npx vitest run packages/code packages/code-host packages/app` (387) and full root green; `pnpm typecheck --force`; oxfmt/oxlint; byte-scan clean; unfiltered grep confirms no code-harness `.run(` survives anywhere, including `docs/proposals/v2/code.md`, whose two API references were swept (the historical STATUS entry below is left as written — it is a log of what was true then).

**2026-08-11 — TypeScript is a MODE of the host runtime, and the parse gate is the check you can afford (branch `feat/code-host`).**

`hostRuntime({ language: "typescript" })`. **This reverses the position two entries down** — the code-host entry left the esbuild transform to code-mode as "a policy concern about what the model may write, not a runtime one." That reading conflated two things the split now separates cleanly: WHICH LANGUAGE a runtime accepts is a property of the provider (the contract says so in as many words), and WHETHER A PROGRAM IS ALLOWED TO RUN is policy. Stripping types is the former. Checking them is the latter, and it stays in the guard.

**Additivity is the design, and the conformance run is the proof.** `runCodeConformance(hostCodeProbe({ language: "typescript" }))` runs the existing JavaScript vocabulary against a TS-mode runtime — 15 pins, unchanged, green. No TS source vocabulary was added: a variant would have tested a second set of programs rather than the claim that the first set still works. The TS-only differences live in `typescript.spec.ts` (8 pins): annotations with no runtime form, declaration-only syntax (`interface` / `type` / `as`), top-level await and return surviving the wrapper, the capability name, a type error that EXECUTES, source that will not parse, and the same program refused under `language: "javascript"` — that last one is what makes the mode falsifiable rather than decorative.

**Transpile placement: PARENT, and it is not a close call.** The supervisor is spawned as a script by an engine that did not necessarily compile the package, so a bare `esbuild` specifier in the child would have to resolve inside whatever placement the child was put in — the same constraint that already keeps the child at `node:fs` and nothing else. Cost measured through the real runtime: a JS-mode round trip is 0.067ms warm, TS-mode 0.330ms, so the transform is ~0.26ms warm and ~6ms on the first program (esbuild's service start). esbuild is now a DIRECT dependency (`^0.27.3`, resolves to the 0.27.3 already in the lockfile — no fourth copy; pnpm's strict linking means a transitive one would not have resolved).

**A program is an async function body, which no parser accepts.** `return 42` at top level is illegal in every format esbuild emits, and top-level `await` is illegal in the two (`cjs`/`iife`) where return is legal — verified against all four before designing around it. So the source is wrapped in `async function __agentick_program() {…}` for the transform and the CALL is appended to the OUTPUT, never the input (where it would be that same top-level return). Appending to the output beats slicing the printed body out: no brace-matching, and it survives esbuild reindenting everything.

**A parse failure is `threw`, not a rejection.** In JavaScript mode a syntax error is the engine's own `SyntaxError` coming back through the child's try — an ANSWER the caller feeds to the model. A TS-mode parse failure that never reached the engine is the same class of fact, so it reports the same way, with the location corrected back to the caller's coordinates (esbuild's line is against the wrapped text). A failure carrying no diagnostic is the toolchain breaking, not the program, and stays on the rejection path.

**One real bug, caught by an existing test.** The first cut awaited the transform BEFORE constructing the execution promise, which moved the abort-listener registration a microtask later — and "an abort leaves no process behind" aborts in the same turn as the call, so the abort landed after the pre-check and before the listener and was lost entirely. Not a test artifact: any caller aborting synchronously would have hung. Fixed by keeping every piece of lifecycle wiring synchronous at call time and doing the transform inside the promise, with `this.inFlight !== run` as the guard that makes the later send safe to skip.

**Source-processing examples (the bonus).** Two in the README, both `guardCodeExecute` — worth stating plainly because the brief suggested `onBeforeCodeExecute` for the second: a before-hook RETURNS a transformed input and cannot veto. Hooks rewrite; guards refuse. (a) A parse gate built on the exported `transpiler()`, which exists as a public export precisely because a hand-written `esbuild.transform(input.source)` would reject every program with a top-level return — the gate has to wrap exactly as the runtime does, so it should not be writing its own. (b) The typecheck-feedback shape, with the `typescript` API the adopter brings and no bundled checker, plus the honest cost: tens of milliseconds against a warm `LanguageService`, hundreds if built per call, bought in exchange for a diagnostic the model can act on now instead of a `TypeError` three tool calls later. Both compile in `readme-examples.type.spec.ts`.

Digest confirmed unchanged and pinned: `auditInput` hashes the source handed to the harness, and transpilation happens inside `CodeRuntimeContext.execute`, below the audit boundary — so the journal and `codeHash` describe the TypeScript the adopter wrote. Hashing the emitted JavaScript would make an allowlist entry depend on an esbuild version. Known gaps added to the README: no JSX (the loader is `ts`, not `tsx`), and a TS-mode stack trace's line numbers refer to the reprinted program (no source map crosses the membrane).

Not committed. 62 net src LOC (`language.ts` 60, plus wiring in `engine.ts` / `host-runtime.ts` / `index.ts`), ~170 with tests. Gates: `npx vitest run packages/code-host packages/code` (138) and full root (6845) green; `pnpm typecheck --force` (109 tasks); oxfmt/oxlint clean; byte-scan clean. **Under bun: `bun --bun x vitest run packages/code-host` — 59 passed, 1 correctly skipped, three consecutive clean runs.** Note that plain `bun x vitest` runs under NODE (`process.execPath` is the node binary) and is a false green for this package; `--bun` is required. One flaky failure observed once when two spec files ran in parallel under bun — `host:bun: the child never reported ready`, a 10s handshake timeout at spawn in the JAVASCRIPT probe, unreachable from the transpile path — not reproduced in five subsequent runs; recording it rather than explaining it away.

**2026-08-11 — `run` takes one bag, and the digest describes what RAN (branch `feat/code-host`).**

`code.run({ source, bindings?, budgets?, signal? })`. `CodeRunInput extends CodeContextOptions` rather than restating fields, so "run IS a context used once" stays literal in the type; the field is `source`, matching `CodeExecuteInput` and the audit record, so one vocabulary runs from the door through the command, the guard and the journal (no `script` existed anywhere — checked). `CodeContext.execute(source)` stays POSITIONAL: it is the REPL verb, the context is already configured, and a guard sees the command bag either way. 55 call sites swept by a balanced-paren codemod with a receiver allowlist (a fake `child.run(src, signal)` in a provider example sits in the same file and must not be touched), then the flagship README examples hand-formatted, because a mechanically-correct bag that reads badly is worse than the positional form it replaced.

**The digest fix is the real content.** `codeHash` derives at the door, BEFORE the interceptor cascade — so a middleware rewriting `input.source` (Ryan's motivating case: lint autofix) would leave the journal naming a program nobody executed. That is the C1 lie, reopened mid-chain. Investigated what the machinery actually journals: `operation-runner.ts:359` publishes `requested` with `resolvedOp.input` (pre-chain), the composed middleware may hand the body a different input, and `terminal` carries only `{ result }`. So nothing recorded the executed source.

**The shape I picked, and why.** The command body re-derives the digest from the final `input.source` and, when it differs, emits `code:execute:rewritten` with both digests and the executed source. `requested` is left alone: its phase contract is "argument bound" and it truthfully records what was ASKED — rewriting history there would be the dishonest fix, and it is published before any interceptor can run anyway. So the record is two facts, request and execution-when-different, with the ABSENCE of a rewrite event meaning the requested envelope is what ran. The digest comes from the exact string handed to the provider, so no hook can leave the journal describing a different program. Rejected: putting the hash on the result (pollutes the contract union every provider implements), and refusing rewrites outright (transforms are the legitimate future).

Also pinned: the lint-gate pattern (`guardCodeExecute` reading `input.source`, vetoing, provider never touched — with a sentinel binding, because a veto that merely rejected the promise while the program ran would satisfy a bare `rejects`), and a README Policy example pairing it with the name veto, since a lint gate constrains what code DOES rather than what it could reach. Mutation evidence: dropping the re-derivation fails the rewrite pin; the first draft of the lint pin was weak (an invalid binding name would have rejected at validation before the guard ever ran, and `rejects.toBeTruthy()` could not tell the difference) and was rewritten to assert the veto outcome.

**2026-08-11 — the default runtime is the HOST runtime, and a definition can set the base context every program gets (branch `feat/code-host`).**

`createApp({ code: {} })`, `defineCode()` and a bare `withCode()` all mount a working namespace. **The no-default position evolves rather than reverses**: a default is refusable when it would ESCALATE, and this one does not — the program runs in a subprocess of the engine the host already runs, with that process's trust, an empty environment, adopter-supplied bindings, and no path from a model to execution except a tool the adopter wired. An implicit JAIL (containment nobody built) or an implicit ISOLATE (a tier nobody chose) stays refused. Swept the old prose in the README's `[!IMPORTANT]`, the index and harness docblocks, and `CodeProviderMissing`'s message, which now names the install instead of lecturing.

Resolution is an optional dynamic import with a VARIABLE specifier — the `telemetry-otlp` autodiscovery pattern — because `code-host` depends on `code` and a manifest edge back would be a cycle.

**A finding worth Ryan's attention: the bare specifier does NOT resolve under pnpm's strict linking.** `packages/code/node_modules` holds only code's declared deps, so `resolveDefaultRuntime()` returned `undefined` in-workspace on the first measurement — the zero-config default would have been silently inert for every test, every example, and every pnpm adopter who got `code-host` transitively rather than directly. Closed by an **optional peerDependency** (`@agentick/code` → `@agentick/code-host`, `peerDependenciesMeta.optional`), which pnpm links into `packages/code/node_modules` so the bare specifier resolves — and which, unlike a workspace-only fix, travels to adopters. A root `devDependencies` entry served as the interim workspace fix and was REMOVED once the peer dep landed: two mechanisms for one resolution is one too many, and the peer dep is the one that is also correct off the workspace. The zero-config pins are REAL either way — `code: {}` spawns an actual subprocess and returns 42 through the app. Both READMEs still document the rule (install it as your own dependency, or pass `runtime` explicitly and never guess), because an optional peer is not auto-installed by every package manager.

**Definition-level `bindings` / `budgets` are a base layer.** `defineCode({ bindings, budgets })` sets what every program gets; `createContext` merges OVER it per leaf via `mergeLayered` (whose semantics are exactly right here — plain objects deep-merge, functions replace whole, `undefined` never overrides). A context adds `tools.audit` without restating `tools.search`; naming `tools.search` again replaces one leaf. The merge is in the HARNESS before the provider sees anything, so the ceiling check, identifier validation and the audit record's dotted paths all describe the MERGED set. A `layered()` helper wraps `mergeLayered` for the both-absent case, because turning "no budgets" into `{}` would change the audit envelope's shape for the common path.

**Budget layering is beyond the AC and flagged for veto** — same mechanism, and a base ceiling no context can raise is a policy hardcoded where a default belongs.

Mutation evidence: reversing the merge direction fails the two override pins; dropping the base layer fails 5 across `code` and `app`. Gates: `npx vitest run packages/code packages/code-host packages/app` (359) and full root green; `pnpm typecheck --force`; oxfmt/oxlint; byte-scan clean.

**2026-08-11 — bindings are a CONTEXT OBJECT, not a schema: the framework stops having an opinion about the shape of what a program reaches (branch `feat/code-host`).**

Ryan's ruling, applied across both packages in one pass. `CodeBindings` was three reserved groups (`tools` / `fs` / `values`); it is now a recursive record on the `vm.createContext` model — every key injects VERBATIM as an ambient name, a nested record is a frozen namespace of the same rule applied again, anything else is a value. `tools` and `fs` survive as CONVENTIONS in prose and examples (a model has strong priors about `tools.search(...)`, and spending them is free) and appear nowhere in the types. **`CodeBindingNameConflict` is deleted**: one record cannot claim a name twice, so the cross-group collision it guarded is impossible by construction. This also resolved the README inconsistency Ryan caught — the old "Bindings cross as JSON" example bound under `tools` and had the program call a bare `search(`.

**The audit record carries DOTTED LEAF PATHS**, so a guard vetoes precisely: `input.bindings.includes("tools.deleteAll")` names the binding it means. Identifier validation applies PER SEGMENT at every depth, which is also what makes the paths unambiguous — a key can never contain the separator, so `{ "tools.same": v }` is REFUSED rather than forging another binding's path (that is the pin that replaced M2). A record stops being a namespace past `MAX_BINDING_DEPTH` (3) and rides as one value, bounding both the walk and the journal: `{ dataset }` costs one line, not one per row.

**One walk, three readings.** `flattenBindings()` in the new `packages/code/src/bindings.ts` returns the functions by dotted path, the value tree with callables removed, and the sorted names; the harness and every provider call it. A provider that re-derived the rule would be free to disagree with the record a guard already decided on. `resolveBindingPath` and `freezeNamespaces` ship beside it, so the fake and the subprocess child enforce one rule rather than two. In the child the tree is rebuilt with a proxy grafted at each function's dotted path and then deep-frozen.

**One cost, and it is a real one.** A function NESTED in a namespace needs its parameter annotated (`async (input: unknown) => …`) where a top-level one infers. TypeScript will not carry a contextual parameter type through a union member's index signature, and "an entry is a callable OR a record" is exactly that union — verified by bisection (a non-union contextual type infers; every union shape fails, independent of array members, member order or sibling properties). The alternatives were an `any`-valued index signature (silences the error by deleting all checking) or a `ns()` wrapper at every call site (ceremony, and a second way to do things). Annotating is the honest one; it is noted in the contract docblock and as a README admonition. Cheap to revisit later with an optional helper.

Conformance gains `swapsBinding` to the source vocabulary (REQUIRED) and two pins — a nested binding round-trips through its namespace, and a swapped namespace still answers with the original. `swapsBinding` swallows whatever the replacement attempt raises ON PURPOSE: a frozen object refuses loudly in strict mode and silently in a sloppy-mode function body, and a pin that told them apart would be testing engine strictness rather than the guarantee. Mutation evidence: removing the child's deep-freeze fails 2 pins; making the walk emit bare leaf names instead of dotted paths fails 12 across both packages and both providers, including the audit record and the fx guard-veto pin.

Not committed. Gates: `npx vitest run packages/code packages/code-host packages/app` (346) and full root green; `pnpm typecheck --force`; oxfmt/oxlint clean; byte-scan clean; the built child driven directly over the protocol (a dist smoke test through the barrel no longer runs in-workspace, because code-host now imports `@agentick/code` as a VALUE and workspace resolution points at TS source — a dev-only artifact of `main: src/index.ts`, not a publish concern).

**2026-08-11 — `@agentick/code-host`: the first real `Runtime`, and the engine you already trust is the one that runs the code (branch `feat/code-host`).**

`hostRuntime()` spawns `process.execPath` — node or bun, whichever runs the host app — so there is no second engine for an adopter to vet. **The phase-1 bet paid: `runCodeConformance`, written against a recorded-instruction fake that is deliberately not a JS evaluator, certified a real subprocess JavaScript provider with zero changes to the suite.** 13/13 conformance + 19 provider-specific pins, green under node AND under bun as the host (`bun --bun node_modules/vitest/vitest.mjs run packages/code-host` — 28 passed, 1 correctly skipped).

**Engine differences are capability differences, and the capability claim is a MEASUREMENT.** `timeMs` (parent-side kill timer) and `outputBytes` (parent-side cut) hold whatever the child is, so both are always declared. `memoryMb` needs the engine's own heap ceiling — and bun does not have one that works: it accepts `--max-old-space-size` AND `--smol`, exits zero on both, and enforces neither (an allocation loop outlives a 3s watch at 10MB, 64MB and `--smol`, where node dies in ~100ms at 10MB). So `host:bun` leaves `memoryMb` out of `enforces` and the harness refuses it up front. `engine.spec.ts` runs that measurement rather than citing a changelog: it is the only honest basis for a promise the caller relies on. Under bun the conformance suite adapts on its own — the "budget the provider does not declare is refused" pin exercises `memoryMb` there, and the "every declared budget is really enforced" loop skips it.

**Framing: ndjson, control channel on fd 3, program output on the real fds 1 and 2.** Node's IPC channel was rejected as engine-risky; a wire that is lines of JSON is one every engine already implements. The separation is structural, not policed — a program printing a forged `{"t":"done",…}` frame at stdout is captured as output and cannot answer for itself (pinned). Two ordering hazards, both real: the child FLUSHES stdout/stderr before it sends the answer, and the parent settles one loop turn later, because the answer and the last output bytes are racing on different pipes — pinned by 25 iterations of write-10KB-then-return with no loss. And a `StringDecoder` per stream, because the `outputBytes` cut is byte-exact and a chunk boundary otherwise splits a multi-byte character.

**Decisions taken.** (1) **A context IS a process** — `persistentContext: true` means `globalThis`, timers and imports carry across executions on one context; a program's own `const` does not, because each execution is a fresh async function body. (2) **A dead child kills its context**: state lived in that process, so quietly spawning a fresh one would answer the next program with an empty world while still claiming persistence. Next `execute` fails; `run()`/`createContext` open another. (3) **Abort SIGKILLs** (graceful stdin close then 100ms escalation on dispose) and the pin verifies the pid is actually gone, not merely that the promise settled. (4) **A value that cannot cross as JSON REJECTS** rather than reporting `threw` — the program succeeded and the membrane failed, and telling the model its code was wrong would be a lie. (5) **`env` defaults to EMPTY**, so a program inherits no host secrets by accident. (6) `memoryMb`'s verdict reads V8's heap-exhaustion marker off the RAW stderr, ahead of the output ceiling — a budget verdict must not depend on how chatty the program was allowed to be. (First cut sliced the rolling tail before testing it and lost the marker behind V8's stack trace; caught by conformance.)

**`HostProcessPort` is the placement seam and this is NOT containment.** The child is an ordinary process of the same user with the same filesystem and network; the port (spawn/write/kill) is the whole surface a jailed placement would implement, and pairing it with `@agentick/sandbox` is roadmap, stated plainly in the README rather than implied away. Naming flag: the design doc called this slot `code-node`; the host-adaptive ruling makes `code-host` match the factory — **rename-cheap before publish, expensive after**.

Extracted from ernesto vs written fresh: the ndjson line-splitting and the parent-holds-the-functions dispatch shape are ernesto's; everything else is new, because ernesto's is a ONE-SHOT `node main.mjs` with a unix socket, not a supervised persistent child. Left for code-mode as the migration table says: the dispatch server, socket auth, stub/`.d.ts` generation, `CODE_REACHABLE_TOOLS`, and the esbuild TS transform (a policy concern about what the model may write, not a runtime one — programs here are JavaScript).

Not committed. 574 code lines across 8 src files (839 with docblocks; the 600-line target is met on code and exceeded on prose). Gates: `npx vitest run packages/code-host packages/code` (45) and full root green; `pnpm typecheck --force` with tsc verified running; oxfmt/oxlint clean; byte-scan clean; the built `dist/` artifact driven end-to-end, since the supervisor path resolves differently there.

**2026-08-10 — `@agentick/code` after adversarial review: the audit record is the harness's to write, and teardown stops what it tears down (branch `feat/code-harness`).**

**C1, the one that mattered.** `fx.execute` took the full `CodeExecuteInput` — the journaled record — so a caller could hand it a digest and a binding list of its own invention. `guardCodeExecute` decides on exactly those fields, which made the Effect door a way around policy: declare `bindings: []` and a guard refusing `deleteAll` waves the program through, while the journal records a program nobody ran. The twin is now hand-authored over the extras seam (the completions precedent) and takes `{ contextId, source }` only; both doors derive the digest, the names and the budgets from the OPEN CONTEXT, and the command stays `exposure: "internal"` so there is no third. The fx path composes `commandEffect`, not the Promise facade — wrapping the facade would have re-entered Effect on a fresh root and severed the very fiber `.fx` exists to preserve (caught by the fiber-interrupt pin, which failed the moment the first version landed).

**C2 — four ways the conformance suite could be satisfied without the behavior.** `persistentContext: false` had no negative arm (a provider that persisted anyway certified clean); the `outputBytes` pin asserted truncation but not that the program still ANSWERED, which a killing provider would pass; the abort pin asserted only that the promise settled, which a provider that sleeps-then-throws would pass — it now runs a sentinel binding that a still-running program would reach, and fails if it was called. Cross-context isolation is asserted for both settings. And four pins that were never about providers (dispose idempotency, pre-aborted, guard veto, provider-missing) moved to `harness.spec`: a suite whose job is to differentiate providers should contain nothing every provider passes by construction.

**C3 — the live-instance arm was killing the instance.** The session close fold duck-types `close()` over every bridge (`session/harness.ts:1774`), so registering the adopter's harness meant the FIRST session to close disposed a runtime meant to outlive it. It now registers a facade that delegates the surface and answers `close()` honestly-idle. **Reported, not fixed here: `completions`, `prompts` and `skills` all register the bare instance in their live-instance arms and have the same bug.**

**C4 — the privacy claim was too broad.** "Binding values never reach the journal" is true of the REQUESTED envelope and of nothing else: results, streams and error causes journal in full, so a program that returns or prints a secret has published it. Narrowed in the README, the changeset, the contract docblock and the conformance pin's TITLE, with a companion pin that asserts the leak path exists rather than pretending it does not. `CodeRuntimeFailed` also stopped interpolating its cause into `message` — a runtime that dies mid-program quotes the program, and `message` is what every log and span renders.

**H2 (Ryan-approved) — one rule for both doors: abort, drain, then dispose.** `dispose()` fires the context's abort, in-flight executions settle `CodeAborted`, and only then is the provider's context torn down; `close()` does the same for every context before releasing the runtime, so it returns when the work is actually over. This also closed the race the reviewer's probe found: `executeIn` awaited the digest before dispatching, and a dispose landing in that window reported `CodeContextDisposed` for a program the caller was entitled to have run. Executions now claim their slot on a per-context queue SYNCHRONOUSLY — which is also **M9**: one context runs one program at a time, so providers inherit the guarantee instead of each engine deciding.

**H3/H4** — `run()` returns the answer when disposal fails (logged loudly, never swallowed: the caller asked for the program's value, not the provider's teardown trouble), and the harness NORMALIZES what a provider returns (unknown outcome / valueless `returned` / missing error → `CodeResultInvalid`; absent `truncated` filled), so a caller never defends against a malformed answer.

**Refusals at the boundary.** Duplicate binding names across groups (**M2**) and non-identifier or prototype-member names (**M3**) are typed errors at `createContext`, before the provider is touched — these become AMBIENT names in an engine, and the harness is the one place that sees them all. `bindRuntime` binds once (**M6**); `createContext` after close is refused (**M7**). **M1**: `outputBytes` is the combined ceiling the contract always claimed, the fake enforces the sum, and the probe writes both streams — a program writing one stream cannot tell the two readings apart. **H1**: the README's cache-by-`codeHash` example was a cross-tenant replay bug (the digest covers source, not bindings or identity) and is replaced, with a warning and the name-veto caveat.

Package: 61 in-package tests. Not committed. Gates: `npx vitest run packages/code packages/spec packages/app` and full root green; `pnpm typecheck --force` with tsc verified running; oxfmt/oxlint clean; byte-scan clean; `packages/spec` + `packages/session` still zero edits.

**2026-08-10 — `@agentick/code`: running model-authored code is an operation, and the language is the provider's business (branch `feat/code-harness`).**

The harness package for `docs/proposals/v2/code.md`, contract-only — no provider, no code-mode. `code:execute` is a declared command, so a program the model wrote is journaled, guardable, hookable and abortable like every other op; a `Runtime` owns language, engine and isolation. **Nothing in the package names a language**, which is the load-bearing constraint: the same slot, contract and conformance suite have to cover a subprocess, an in-process isolate and a future Python runtime.

**The whole contract lives in `@agentick/code`. `packages/spec` and `packages/session` have ZERO edits.** A first pass put the protocol in `spec/protocol/code-harness.ts` and the error family in `spec/errors/harnesses.ts`, following resources — and that is the legacy shape. Spec placement earns its keep only when `@agentick/app` names the type, and app reaches this harness as an OPAQUE namespace value, so nothing outside the package ever names `Code`. `contract.ts` now holds the whole surface (bindings, budgets, capabilities, the result union, `CodeExecuteInput`, `CodeContext`, `CodeFx`, `Code`, `isCodeInstance`, and the provider-side `Runtime` / `CodeRuntimeContext`), and `errors.ts` holds the first package-local `AgentickError` family in the repo — real classes extending spec's base and calling spec's `registerAgentickError`, so `instanceof` / `_tag` / codec behavior is identical while the registration is a side effect of importing the package. That is sound HERE precisely because `code:execute` is in-process only and these errors never cross a wire; a wire-crossing family would still want spec, whose registry is populated unconditionally.

Two renames off the design doc, both forced: the doc's `RuntimeContext` collides with spec's core `RuntimeContext`, so the provider-side context is **`CodeRuntimeContext`**; `ExecuteResult` is too generic to export from a package barrel, so it is **`CodeExecuteResult`**.

**Wiring is the skills/completions shape, not resources'.** `withCode(config)` is a `SessionExtension` that constructs its own harness on `installer.substrate.*` with `` `${installer.hostId}:code` ``, `parentScope: { sessionId }`, `inheritedFrom(installer)` (the cascade must be total — `code:execute` IS an op, so an `app.guard()` vetoing model-authored code has to reach it), `await ready`, `registerNamespace("code", …)`, `onClose(close)`. The live-instance arm registers and skips `onClose` — we do not close what we did not open. `augment.ts` adds four OPTIONAL slots (`HookBridges.code?`, `SessionHarnessProtocol<P>.code?`, `ToolHandlerCtxExtensions.code?`, `NamespaceSlots.code?`) plus `registerNamespaceSlot("code", { toExtension })`. No `export {}` guard: the file has top-level imports, so it is already a module and the ambient-shadow trap cannot bite — `skills/augment.ts` and `completions/augment.ts` both omit it for the same reason. Nothing reads `getNamespace` at install (the prompts late-binding bug), and there is no fallback construction anywhere in session.

**`codeContextId` is a real scope dimension, not just a typed one.** `EventScopeExtensions` gains it from this package's augment (the `sandboxId` exemplar), and `code:execute`'s `scope` factory stamps it from `input.contextId` — so `app.events({ scope: { codeContextId } })` follows ONE context's executions out of a session multiplexing several, which is the cut `sessionId` cannot make (a session holds as many contexts as it opened). Pinned by a test that runs two contexts in one harness and asserts both that every execute envelope carries its own id and that a scoped query returns one context's `requested`/`terminal` pair and nothing of the other's — through `compileQuery`, the same matcher a scoped bus subscription runs.

**One line outside the package**: `ctx.code`, at the documented "add one line per tool-shipping harness" site in `app/src/harness.ts`, resolved generically from the namespace bridge with no import and no manifest change.

**Presence, in three states — and `runtime` is REQUIRED.** `session.code` is `undefined` until something installs the namespace; installed with a runtime it answers; installed as an adopter-built live instance not yet bound, it is present and fails `CodeProviderMissing` until `bindRuntime`. `defineCode()` with no argument no longer type-checks: mounting the namespace and choosing what runs the code are the same act, and a zero-arg form would read as a complete installation that can do nothing. The unbound window survives only on the deliberately-more-work live-instance path, which is where `CodeProviderMissing` earns its place (conformance pins it, and the adopter test drives present → throws → `bindRuntime` → answers).

**Abort reaches the program, not just the Promise — a contract change taken before any provider exists to break.** The first pass CLAIMED "abortable by the standard machinery" and was not: `Effect.tryPromise({ try: () => ctx.execute(src) })` discards the fiber's `AbortSignal`, and `CodeRuntimeContext.execute` had nowhere to put one, so interrupting the op left the program running behind a settled Promise. Now `execute(source, options?: { signal })`, and the harness passes `mergeAbortSignals(callerSignal, fiberSignal)` (`@agentick/utils`) — so a cancelled turn or an aborted tool dispatch tears the program down, and a caller with no fiber gets the same door through `CodeContextOptions.signal`. The signal sits on the CONTEXT, beside the other non-serializable per-context things, because the alternative — per-call — would have to smuggle a live `AbortSignal` through `CodeExecuteInput`, which is the audit record. Honoring it is MANDATORY, not a declared capability: a runtime that cannot stop a program cannot enforce `timeMs` either, so there is no honest provider that would set the flag false. A stopped program raises the new **`CodeAborted`** rather than becoming a fifth outcome — same line the outcomes already draw, an outcome is what the program ANSWERED and a cancelled program answered nothing (`ToolAbortedError` / `ProviderAborted` / `LoopCanceledError` are the standing precedents). The conformance pin earned itself immediately: it caught the reference fake folding its own abort into `outcome: "threw"`, which is exactly the misreport the error type exists to prevent. **The two halves of abort need two pins, and the first round only had one.** A mutation check — deleting `fiberSignal` from the merge — left all 47 tests green, because every abort pin supplied a CALLER signal and none exercised op interruption, which is the half the cascade actually depends on. The added pin forks `fx.execute` against a recording provider with NO caller signal, asserts the fiber's own signal arrived un-aborted while the program ran, interrupts the fiber, and asserts the in-flight program saw it and that no `terminal:succeeded` was published. It fails in 2ms under that mutation. It interrupts in a `finally` on purpose: a harness that withholds the signal leaves a Promise nothing can settle, and the suite must FAIL on that rather than hang on it.

**Decisions the doc left open.** (1) **`truncated` is a field, not an outcome arm** — `outputBytes` SHAPES output and lets the program finish answering; `timeMs` / `memoryMb` KILL it (`outcome: "budget-exceeded"`). Discarding a computed answer over chatty logging is the wrong trade, and the split leaves a clean four-arm union: `returned` / `no-value` / `threw` / `budget-exceeded`. (2) **A program that throws is a RESULT, not a rejection** — it is an answer the caller feeds back to the model; a rejection means the machinery failed. (3) **`code:execute` is `exposure: "internal"`** — the reasoning that refuses an implicit provider refuses a remotely-addressable eval verb. (4) **The command input IS the audit record**: `{ contextId, source, codeHash, bindings: string[], budgets? }`, with the digest and the names DERIVED by the harness rather than accepted from the caller, so the journal cannot be handed a description of a program other than the one about to run. Both source and hash earn their place — the hash is the stable correlation key, the source is what a guard reads and an auditor needs. (5) **`createContext` / `dispose` stay plain methods** (§1.2 — required function args), and dispose stays with its pair rather than becoming a second command no guard would veto.

**The conformance suite inverts the language problem.** A suite that must not name a language cannot author source, so the PROBE supplies a `CodeSourceVocabulary` (`returns` / `noValue` / `throws` / `callsBinding` / `readsValue` / `writes` / `exceeds?` / `remembers?` / `recalls?`) and the suite drives the contract through it. Capability claims are held to account rather than trusted: every budget in `capabilities.enforces` must come with an `exceeds` program that really overruns it, and `persistentContext: true` must come with state that really survives. 16 pins per provider, run twice in-package (a full-capability fake and an `enforces: []` / `persistentContext: false` one) — lifecycle, one-shot sugar, all four discriminants, bindings reachable by name, dispose idempotency, execute-after-dispose, unsupported-budget refusal, guard veto short-circuiting before the provider is touched (proven by a binding that never fires, not by fake-specific recording), a mid-flight abort settling and a pre-aborted signal never reaching the provider, and the journal carrying source + hash + binding NAMES with the binding VALUE absent from the whole serialized event stream.

**`fakeCode` is not a JavaScript evaluator, deliberately.** Its language is a recorded instruction list — if the double were a JS engine, every conformance claim would quietly be a claim about `eval` instead of about the seam. It enforces `timeMs` (virtual clock) and `outputBytes`, and declares that it does not enforce `memoryMb`, so both sides of the honesty branch are exercised.

Not committed. Not done, on purpose: no provider package, no `execute_code` tool, no client/wire parity, no snapshot participation (contexts hold live resources; programs are journaled, contexts are not). Also carried by this pass: `runCodeConformance` moved off the main barrel to `/testing` (it imports vitest, and a production consumer must not load a test framework), `RuntimeContextOptions` renamed `CodeRuntimeContextOptions` off spec's name-family, the package registered in BOTH `pnpm-workspace.yaml` versioning groups (the fixed array AND the release lanes — it was in neither, which would have silently skipped it at publish), and CLAUDE.md's New Package Checklist step 2 repointed from the inert `.changeset/config.json` to those two. Gates: `npx vitest run packages/code packages/spec packages/app` and full root green; `pnpm typecheck --force` with tsc verified running; oxfmt/oxlint clean on changed files; byte-scan for NULs clean.

**2026-08-10 — a keyed store mounts as a browsable resource tree, with one outbound address boundary (branch `feat/resource-mounts`).**

`@agentick/resources` gains three composable functions over the resolver primitive — none a harness method: `storeResolver(store, projection?, options?)` adapts a content-shaped `MountStore` (`get` → `ResourceContents`, `listChildren(query)` → `Child` page) into a `ResourceResolver`; `mount(resolver, meta?)` packages a resolver with its workspace description; `createTree(tree)` routes an incoming path by longest-prefix (segment-aware) to a mount and merges a root listing carrying each mount's `meta.description`. `registerTree` wires the root `register` plus the `{+path}` descent template in one call. **`MountStore` is named to avoid collision with spec's existing `ResourceStore`** (the durable declaration-record `CollectionStore`); the two are genuinely different — content-and-browsable vs serializable-declaration. Leaf-vs-directory is decided **structurally** (`get` returns content → leaf; `undefined` → list children), not by extension sniffing.

The projection is the one seam: `toHome` is the sole place a store key becomes a model-facing **address**, called in exactly one spot (`storeResolver`'s outbound pass). Every emitted address is minted from it — the requested path, each child, and a leaf's own uri — so a path that does not project back is `ResourceNotFound` on a **direct** read, not merely absent from a listing. A path reaches `toInternal` only in canonical form (no `.` / `..` / empty segment; trailing slash dropped), so a traversal cannot be normalized into a round-trip by the store. The boundary governs addresses and nothing else: **content passes through untouched**, because the framework cannot scrub a body whose format it does not know — an adapter's metadata allowlist owns that. `Page.cursor` is a **contract**, not a projection: it lands verbatim in the listing's `nextPage` address, so it must carry no isolation id (both knowify backends already return the relative child name).

**The computed form `(ctx) => tree` is invoked per read and deliberately NOT memoized.** `ctx.sessionId` is optional and undefined on the real harness path, so a cache keyed on it collapses every ctx lacking one into a single entry and serves one principal's tree to the next. Building a few mount objects is cheap; an expensive attribution or membership lookup inside `tree` is the adopter's to cache, at the only layer holding a trustworthy identity.

Conformance (`runResourceMountConformance`, `fakeMountStore` under `/testing`) pins get/list round-trip with a child's whole `meta` carried, the fail-closed drop **and** not-found on a direct read of the dropped child, id-elision across the whole serialized response including a `nextPage` built from a real cursor, longest-prefix routing + boundary correctness, per-read tree rebuild, and the root-description merge. `mount.spec.ts` adds the address boundary directly: traversal / `.` / empty-segment rejection before the store is touched, trailing-slash equivalence, typed not-found for an unroutable path, and `limit` + cursor arriving as a `MountListQuery`. Deferred with a note rather than built: the tri-state `listChildren` that would separate an empty directory from a missing one. Not committed. Gates: `npx vitest run packages/resources packages/spec` (783) and full `npx vitest run` green (6698 passed); `pnpm typecheck --force` 106/106 with tsc actually executing; oxfmt/oxlint clean.

**2026-08-10 — a reflection can be asked for a SHAPE. The `tools: []` suspicion was right about the symptom and wrong about the cause.**

`session.reflect()` adopts `send`'s structured-output surface: `ReflectInput.output` (the live schema), `ReflectResult.data` beside `text`, and `send`'s two errors — `ResponseValidationError` on a violating reply, `StructuredOutputIncomplete` on a reply that never calls the terminal tool. Same field names, same semantics, no second dialect. **`responseFormat` was deliberately NOT mirrored**: a send carries the serializable twin because a send crosses the wire and a live validator cannot, and a reflection is in-process by construction (it takes an `AbortSignal` and an `onDelta` callback). The twin buys a reflection nothing and is strictly worse than `output` — unvalidated, and dropped by the providers that drop `response_format`. `ReflectInput` and `ReflectResult` are now exported from the package index; they were not, so an adopter could not type a reflect call without reaching into `dist`. This is the structure half of WISHLIST W41; the usage half (`compact()` reporting what the fold cost) is untouched, and `rollingSummary` deliberately still regexes `<questions>` out of the prose — converting it is that item's open measurement question, not a refactor, and the capability it needs now exists.

**The suspected defect was that an explicit `tools: []` slipped past the `allowedTools` terminal-tool exemption. It does not, because `reflect` never enters the loop** — it runs `project → execute → normalize` on the model executor by hand, so §B2's injection was structurally unreachable rather than filtered out. Nothing degraded silently; there was simply no path. The withholding also sat in the wrong place: `withInstruction` cleared a tool list `project()` had just built, which made "what a reflection advertises" a decision taken after the fact by a helper that could not know the answer. `session.project(tree?, tools?)` now takes the list, `withInstruction` only appends the turn and overlays generation parameters, and the reflection decides once: nothing, or the terminal tool with `toolChoice` pinned from the start (a send can spend a wrap-up tick; a reflection has one shot).

**The mechanism is shared now, not mirrored.** `terminalToolDeclaration`, `resolveAutoStrategy` and `validateStructuredOutput` moved from `loop-executor/harness.ts` into `@agentick/spec`'s new `data/structured-output.ts` under their existing names; the loop and the reflection pass both call them, so the strategy truth table and the validation semantics cannot drift apart. **The first pass moved three of the four decisions and left the fourth mirrored, which is exactly the drift this move exists to prevent** — each path hand-built its own `json_schema` directive, and the loop's went through `SpecConfig` → `buildParameters`, which silently dropped `name`. OpenAI therefore saw `submit_result` from a reflection and its own `"response"` fallback from a send, for the same schema. `responseFormatDirective(spec)` is now the fourth shared function and `buildParameters` carries `name` through; a test drives a send and a reflection asking the same shape through one session and compares what the provider-request hook saw. Two things fell out of putting them in one place. The terminal tool now carries `annotations: { narrate: false }` — projection was injecting `_summary` into the schema whose arguments ARE the answer, which a strict schema would reject and every model pays tokens for; that fix lands on the loop too. And `"submit_result"` is `DEFAULT_TERMINAL_TOOL_NAME` in one place instead of three literals. The loop's validation block went from 40 lines to 25, with the two-branch prose above it deleted along with the branches.

**A cap hit is truncation, not a refusal.** A structured pass that runs out of `maxOutputTokens` mid-terminal-call has no complete arguments to validate, and the first pass threw `StructuredOutputIncomplete(no_terminal_call)` at it — reporting "the model declined to answer" for a budget the caller set, discarding the usage it was billed for, and making `ReflectResult.truncated` unreachable on the one path that can set it. `reflect` now checks `stopReason === "max_tokens"` FIRST and resolves `{ text, usage, truncated: true }` with `data` absent. No new error arm: the documented meaning of `truncated` ("stops mid-thought, should not be persisted") already covers it. A reply that ends normally without calling the terminal tool still throws — that one IS a refusal.

Tests: 9 in `session/__tests__/reflect.spec.tsx` (validated object out; the terminal tool is the only thing advertised; the choice forced; the native-`json_schema` target taking the directive with no tool at all; both error semantics; text-mode carrying neither tools nor directive; the terminal call surviving the STREAMING delta path; a capped reply resolving truncated with its usage; an absent overlay value leaving the projected cap standing) plus the cross-path directive test and a narration assertion in `structured-output.spec.ts`.

**Text-mode reflect is NOT byte-identical, and the earlier claim that it was is withdrawn.** It now omits the `tools` key from `LanguageModelInput` entirely where it previously sent `tools: []`, and it no longer calls `compileForTick` at all (`project(tree, tools)` treats an empty array as an answer, not a miss). The behavioral note that IS true, and verified by reading all four: every first-party adapter gates on `input.tools && input.tools.length > 0` (openai, anthropic, google) or never forwards function tools at all (ai-sdk), so absent and `[]` reach the provider identically. The compaction suite is untouched and green. Full root run 679 files / 6681 green (65 skipped, Postgres-gated); workspace typecheck 106/106 with `--force`.

**2026-08-09 — the framework RESPECTS declarations and PUBLISHES decisions; it does not REMEMBER them. Confirmation memory is deleted as application policy.**

**The razor.** An earlier pass on this branch built the executor a memory: an `alwaysAllowed` set honoring `reply.always`, an `onConfirmationResolved` observer to report asks, and `SnapshotCapable` participation so the grant set rode `bridges.toolExecutor`. All three are gone. A framework that remembers an authorization decision has taken a policy position it cannot walk back — it fixes the scope at "this session", makes the snapshot an authorization-bearing payload (a restore verb would become a privilege-escalation surface), and forces every deployment wanting a different scope to fight the built-in one. What the framework owes is the mechanism and the facts: ask when a declaration says to, and publish what was decided. Deleted with the memory: `ToolExecutorSnapshot`, the executor's `exportSnapshot`/`importSnapshot`, `ToolConfirmationObserver` + the `onConfirmationResolved` option and its `/testing` passthrough, the `snapshotCandidates()` special-casing in `SessionHarness`, and `SnapshotSlotOccupied` — that error existed only to police the `toolExecutor` slot the executor no longer claims, so `packages/session/src/harness.ts` and its README are byte-identical to their pre-branch state and the session snapshot is inert data again.

**The decision is data on the paths that already exist.** `ToolConfirmationResolution` survives the rip — canonical `toolName` (a store keyed on the alias a caller dispatched by recognizes nothing when the next call arrives under the real name), `sessionId`, the pre-edit `arguments`, the four-arm `outcome`, and `always` relayed as vocabulary. It now rides `DispatchResult.confirmation` as a typed field for the three arms that resolve and `ToolConfirmationTimeoutError.confirmation` for the one that rejects, so an `onAfterToolDispatch` hook — the house interceptor plane, zero bespoke seams — sees every decision. The standing-grant pattern is therefore a dozen lines of adopter code (hook writes a store, `confirmationPolicy` reads it), pinned end-to-end through a real `createApp` in `app/src/__tests__/confirmation-grant-policy.spec.tsx`, alongside its inverse: the same app minus the policy re-asks until it times out. Re-validation ordering is unchanged — an approval whose `modifiedArguments` fail validation rejects with nothing claiming an approval — and `aborted` stays distinct from `denied`.

**A tool that declares nothing now gets a verdict from its hints, and `withMCP` stops discarding MCP's own default.** `destructiveHint: true` asks, `readOnlyHint: true` never does, neither is ungated; read-only wins when a server sends both, because MCP scopes `destructiveHint` to writes. An explicit `requiresConfirmation` outranks the hints and `confirmationPolicy` outranks everything, receiving the derived verdict as `toolVerdict`. `advertisedAnnotations` now materializes the MCP spec's absence-defaults (readOnly false, destructive **true**, idempotent false, openWorld true) instead of leaving an omitted hint absent, which read as the safe end of every scale. The two compose into the intended consequence: **an MCP tool whose server annotated nothing is confirmed, with no adopter policy in the path.** That is a real behavior change with real blast radius — it broke 25 MCP integration tests that dispatch fixture tools nobody answers a prompt for. Each fixture now advertises `readOnlyHint: true`, which is what a real read-only server does; a suite that forgets will hang, which is the point. Worth a decision before v2.0: this is the one place the framework ships a restrictive default rather than a generous one, and a headless deployment with no elicitation host will block rather than prompt.

Suites: full root `npx vitest run`, 679 files / 6669 green (65 skipped, all Postgres-gated), run twice. Workspace typecheck 106/106 with `--force` (cache bypassed, tsc verified running). Deliberately not done: `advertisedAnnotations` still stamps `destructiveHint: true` beside an advertised `readOnlyHint: true` — MCP calls that combination meaningless rather than contradictory, and the executor applies the precedence, but a policy author reading `destructiveHint` naively would be misled. Collapsing it at the projection is a one-line change if we want the bag self-consistent.

**2026-08-09 — the four MCP advisory hints are typed members of `ToolAnnotations`; `withMCP`'s INBOUND projection reads them by type instead of casting.**

`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` rode the annotations bag as untyped passthrough keys, surviving only through `annotations as ToolDeclaration["annotations"]` in `mcpDeclaration` — a cast that claimed a `boolean` for whatever the bag held. The hints are now typed on `ToolAnnotations` (advisory, never enforced, never trustworthy from an untrusted server — the docblock says so), and `withMCP` reads the wire bag with an explicit typed projection (`advertisedAnnotations`), dropping wrong-typed values. **This is the INBOUND direction only** — a remote server's advertised tools becoming agentick declarations. The OUTBOUND wire projection (`server/projection/tools.ts`) still reads hints exclusively from `metadata.mcp.annotations`, so `createTool({ annotations: { readOnlyHint } })` does NOT reach a connected MCP client; that gap is the `TODO(hints)` trailhead below, not something this change closed. And the motivating `readOnlyHint: "yes"` story was overstated: through the real client path the SDK's own Zod parse rejects a non-boolean before decode ever runs, so nothing that arrives over a live connection was mistyped. The typed projection is defense in depth for descriptor paths that bypass that parse — a hand-built or replayed `ToolDescriptor` — not a fix for a reachable client-path bug. Nothing that can actually arrive is lost: SDK 1.29.0's `ToolAnnotationsSchema` strict-strips to `title` + the four hints (verified in node_modules, not trusted from the repo comment). `McpToolAnnotationHints` on the server-projection side became a `Pick` of the spec type — one source of truth. Open trailheads: `TODO(hints)` in `server/projection/tools.ts` (`createTool({ annotations: { readOnlyHint } })` doesn't reach the outbound wire yet — same shape as the fixed `title` bug beside it); `ClientToolAnnotations` deliberately not extended (client-reported hints influencing anything is a security decision, not a typing side effect). Suites: spec+mcp+tool-executor 118 files / 1561 green; workspace typecheck 106/106. Motivation: ernesto's confirmation policy reads these hints today via casts; the per-session grant persistence arc (next entry, in flight) reads them next.

**2026-08-06 — `ctx.tools`: the one dispatch door rides handler ctx; seatbelt's network deny stops conflating inet with AF_UNIX.**

**A handler composing sibling tools had no door.** ctx carried `elicitation` / `tasks` / `resource` but not dispatch, so ernesto's code-mode tool (`execute_code`) reached UP through `installer.app.getSession(installer.sessionId)` to reach back DOWN into its own session — the ambient-authority inversion ctx exists to prevent. `ToolHandlerCtx.tools?` is now the same `ToolsHandle` as `session.tools` (a spec field, not an augmentation: by the file's own rule a substrate primitive every session has lives on ctx directly), filled unconditionally in the dispatch ctx build. Nothing weaker rides ctx — the `"dispatch"` exposure gate holds identically, pinned by a test in which a handler dispatches a `["model"]`-only sibling and observes the same `ToolPermissionError` a host-side caller gets, with the sibling's handler never running. Phase 2 stays open on #273: a sub-dispatch currently journals as a fresh host-door call; nesting it under the calling tool's span needs caller identity threaded into `DispatchInput.context` (the `buildSessionElicit` runtime-binding precedent) — `TODO(ctx-tools-scope)` at the fill site.

**Seatbelt's blanket `(deny network*)` denied unix-socket connects along with inet**, which forced any supervised-IPC design — jailed code speaking to its supervisor over a workspace socket — to run with open egress on macOS (#274, found the day ernesto's `execute_code` needed exactly that channel). The profile now allows `network-outbound` / `network-bind` under the workspace and mounts: the subpath filter outranks the blanket deny by SBPL's own specificity rule and cannot name an inet destination, so the deny stays total for the actual network. Linux jails never shared the defect — netns withholding leaves filesystem sockets alone. Proven in `isolation.spec.ts` in the suite's paired style: jailed `nc -U` connects under the workspace, is denied outside it, and inet stays denied under the same profile. Downstream: ernesto flips `allow.network` to `false` on the next published version.

Suites: tool-executor + sandbox-local, 34 files, 274 green. Workspace typecheck green except `@agentick/client`'s telemetry spec (another session's in-flight work, untouched here).

**2026-08-05 — a progress frame says WHOSE it is: `op` on the payload, `parentOpId` on the signal envelope, token = the owning op's id (ADR 64 amendment).**

**The gap was found by a consumer, not an audit.** The ernesto compaction bar's only way to answer "is this frame from a compaction?" was to sniff the `timeline:compact:` prefix of an opaque token — a convention one emitter happened to follow, promised by no type. A consumer needs three things from a frame: WHO sent it, WHERE the work stands, WHEN it is over. The wire answered only the middle one by contract; identity rode a string, closure is the operation's job (law 4), and the first surface to emit a second kind of progress would break every "surface = operation" fold silently.

**Identity is now a field, not a parse.** `ProgressEventPayload.op?` carries the owning operation's canonical name (`timeline:command:compact`) — law 1's late-joiner argument extended from determinacy to attribution: a frame classifies alone, including whose it is. The event NAME stays `<surface>:signal:progress` deliberately — per-operation names would collapse the signal domain into the command domain and turn every generic subscriber into a maintainer of an open-ended name list; the one-notification-plus-token split is MCP's own architecture and the payload's MCP-facing core stays byte-identical (the projection maps params field-by-field and does not forward `op`, pinned by test). `emitSignal` stamps `parentOpId` explicitly — passed, not ambient, because every emit site fires through `Effect.runFork` from a Promise context where the FiberRef trunk is already gone. The compact token is now the operation's own `opId` (the tasks "a task is its own token" precedent generalized); the wire bytes even look the same, since the compact opId was already minted `timeline:compact:<ulid>`. Client: `OnSignalOptions.op` filters `onProgress` client-side (the query can't see payloads), STRICT — an unstamped frame does not match a set filter. Stamped emitters: timeline compact + tool dispatch (`tool:command:dispatch`, `parentOpId` from the dispatch op); the MCP-server ctx carries `TODO(signal-identity)` — it is minted before the crossing declares itself, shared across request kinds, so there was no honest opId to pass. Same TODO on `emitLog`: logs stay anonymous until a consumer appears.

**Constant home followed the existing pattern.** `TIMELINE_COMPACT_EVENT_NAME` joined `TIMELINE_APPEND_EVENT_NAME` in `@agentick/spec`'s timeline data module; the tool-executor twin is module-local with `TODO(wire-constants)` since no tool op-name surface exists yet. Downstream: ernesto's dock now guards on `op` structurally (`TODO(agentick-op-filter)` to switch to the typed option on the next published client). Tests: 57 across the four touched specs (timeline correlates token/parentOpId against the `requested` lifecycle envelope; client filter strictness; MCP no-leak); five-package suites 1903 green; workspace typecheck 105/105.

**2026-08-04 — the fold reports what it is doing, records what it cost, and names the questions it answers. `data` renders; `metadata` does not.**

**Three links of one chain were missing, so a compaction that took thirty seconds looked identical to a hung session.** `SessionHarness.reflect()` dropped `gen.onDelta` and called `execute()`, so `rollingSummary`'s progress callback fired never — the signal existed the whole way down and nothing pulled the trigger. It streams now when a caller is listening, counting output tokens from the provider's own mid-stream report where one arrives and estimating from the text until it does (`forwardDeltas` in `session/reflect.ts`). `CompactGenerateResult.outputTokens` became `usage`: a compaction rides the next tick's prefix by construction, and `cachedInputTokens` against `inputTokens` is the only thing that says whether that held. And progress fan-out existed for `session/send` ALONE — the three moves (subscribe filtered, push, stop) are now `fanOutProgressSignals` in the gateway, used by the dynamic command lane too, so any wire-exposed verb invoked with `_meta.progressToken` reports. A verb becomes observable by emitting, not by earning plumbing. Correction to an earlier claim in this log: the client half already existed — `session.onProgress(handler)` subscribes to `*:signal:progress` over `sub/subscribe`; the token lane is the per-RPC twin, not the only door.

**The fold names its own retrieval keys.** Dense retrieval matches a query against stored text, and queries are questions while summaries are statements — different regions of the embedding space, so the match is weaker than it looks. The usual fix is a later pass that rewrites the document into query shape. That pass is unnecessary here and worse than what we can do: the fold IS a model call over the whole conversation at the point of maximum context, so `rollingSummary` asks it in the SAME generation to name the questions this stretch answers (`QUESTIONS_INSTRUCTION`, appended after whatever rules the adopter set; `questions: false` opts out). Defaulted on because the moment does not come back — a summary written without keys can only be given them later by exactly the process this avoids.

**Which exposed a line nobody had drawn.** `eventParts` renders EVERY key of a `system_event`'s `data` into the model's context, so the `usage` addition put token accounting in front of the model, and a questions list there would have invited it to answer them. **`data` is READ, `metadata` is RECORDED** — `BaseContentBlock.metadata` was already the seam and the formatters simply never touched it. Usage and questions moved there, pinned by a formatters test. `coversFrom` / `coversThrough` / the counts stay on `data` behind `TODO(event-payload-split)`: moving them means moving `projectLog`'s `coverageIn` with them, and summaries already written carry them under `data` — a read-both migration, not a rename.

**Tested at the adopter's entry point.** `session/__tests__/reflect.spec.tsx` builds a real session with `timeline: { compact: rollingSummary(…) }` — the config an adopter writes, not a hand-bound `generate` — and asserts the fold, the usage on `metadata`, and rising counts under one progress token. Suites: timeline 254, formatters + timeline + session 884, gateway dynamic-commands 13. Workspace typecheck 105/105.

**2026-08-02 — a gate's tick-end knob write carries its tickId. `HarnessEdge<F>` makes the Effect twin fall out of the protocol instead of being remembered.**

**Measured, not inferred.** A gate transition during a tick emitted `knobs:command:set` with no `tickId` on all three phases — the op ran, journaled, and published, it just could not be attributed to the tick that caused it. Two independent faults, either one sufficient. **(1) The type.** `KnobsHarnessProtocol` declared only `PromiseView<KnobsFx>` and no `fx`, so `GatesController` — typed against a `Pick` of it — had no reachable Effect twin and was _structurally_ forced onto the Promise facade; `transition` then fired `void knobs.set(...)`, a root fiber by construction. **(2) The scope.** Composing in-fiber turned out to be necessary but not sufficient: `tickId` enters the ambient `RuntimeContext` inside `loop:command:tick` and unwinds when it settles, and the DECIDE deliberately runs after it (ADR 89 §4). So the fiber was intact and `executionId` flowed while `tickId` was already gone. The loop re-annotates the decide span with `withContext({ tickId }, …)` — attribution, not parenthood; the tick op is not reopened.

**The general shape.** A protocol that declares only the facade fails OPEN: it compiles, and consumers quietly land on `runPromise`. `HarnessEdge<F> = PromiseView<Omit<F, "use">> & { readonly fx: F }` derives both faces from the one hand-authored `Fx` twin, so `.fx` cannot be forgotten. Knobs is the first adopter; **10 protocols still declare the facade alone** — app, credentials, elicitation, gateway, live, mcp-server, session, skills, state, tasks (audited, recorded as task #9; state and tasks are the likely next tick-scope defects since both are written to during a tick). The stale `fakeKnobsHarness` broke at compile time and was fixed by unifying both faces on one shared body — the mechanism working as intended.

**Two things worth keeping.** The loop's docblock _claimed_ the ambient tickId survived that call, so the steer-drain timeline appends were attributable to their tick; it did not, and they were tickless too — one fix, both defects. And `app/tick-scope-conformance`'s bracket ended at the last tick event, i.e. **before the decide window this bug lived in**, so it stayed green throughout. The bracket now runs to the execution terminal, but reverting the fix confirmed it still does not bite on its own (that scenario has no gate and no steer) — the biting guard is `session/gates-integration`, and the app test's limit is recorded rather than implied. Full suite green: 651 files, 6370 tests.

**2026-08-02 — sections, second pass: the adjacent-section merge is deleted and its join moved to the wire; a section's dialect now follows the same law as its role.**

**The join belongs at the transport that has the defect.** `mergeAdjacentSections` existed because a provider may concatenate a message's text parts with no separator, welding `# B`'s heading onto `# A`'s last line. That is a transport fact, not a formatting one, so the merge is gone from `expandSections` and `buildMessages` now joins ADJACENT TEXT PARTS of one message with `\n\n` (`joinTextParts` / `textRuns` in `@agentick/model`). The join **stops at a hint** — `cache`, `providerOptions`, `providerMetadata` — which is #185 restated one level down: a hinted part marks a position in the prompt text, so joining it would move the breakpoint. Bytes for every existing section tree are unchanged, pinned at both exits (`buildMessages` for the wire, `blocksToText` for the string path, which has always joined blocks with `\n\n` — the two now agree by construction rather than by two separate rules). One level down the rule also covers a text run followed by a fenced code block, which the section-shaped merge never did.

**Per-section identity came back.** Two adjacent sections are two blocks with two ids, end to end. The merged block could carry only ONE id, so the second section's id reached nothing downstream — `prefix-stability.spec.tsx` had its fixture ORDERED around that (auto-id section written first so its id survived into the IR), and that ordering is gone. `buildMessageProvenance` mirrors the join rather than the blocks, because these coordinates index the projected REQUEST; a joined part is named by the block it starts at, and a boundary between two sections makes both separately addressable again. The open "which id should a merged block keep?" call DISSOLVED — removing the mechanism removed the question.

**Dialect follows the same law as role.** `<FormatScope purpose="section">` used to resolve a formatter for nested sections, stamp the ref, and then ignore it — a knob that lied. Now `SectionNode` carries `renderedWith` (stamped at collect from the `ctx.formatter("section")` resolution that already ran at that position), `expandSections` takes a `FormatterResolver`, and the law is: **the nearest declared scope decides a section's dialect; the default is the container's.** A section whose stamp resolves to a different formatter than the pass is an ISLAND — lowered by its own formatter, framed by its own dialect, and embedded **verbatim**. The alternative, escaping an island in the outer transport, emits `&lt;current_user&gt;` — a rendering OF an island rather than an island, produced exactly when an author declared another dialect on purpose; the ubiquitous hand-written prompt is markdown prose with literal XML blocks in it. A markdown island inside XML keeps its raw `&` for the same reason: prompt "xml" is a convention no provider parses, and well-formedness across a declared boundary is the author's call. No conditional escaping anywhere. A pinned formatter (`renderToString({ formatter })`) gets no islands — pinning means one dialect renders everything. An unserved ref is not an island either; the container renders it and the harness reports the unresolved ref as it already did.

**Surface.** `@agentick/spec` gains `FormatterResolver` + `IdentifiedFormatter` and an optional second `Formatter` parameter; `SectionNode.renderedWith`. `@agentick/formatters` gains `declaredFormatterResolver`; `@agentick/model` exports `joinTextParts` / `textRuns`. Both formatter passes (`compiler-react/template.ts` and `CompilerHarness.applyFormatters`) thread the resolver. Full suite green: 647 files, 6343 tests.

**2026-08-02 — `TODO(section-formatter-thread)` closed: the section lowering moved to the formatter pass, and ADR 94 is fully load-bearing.**

**The move, not the wiring.** The deviation note guessed the fix was "resolve the live formatter during the collect walk." It was the opposite: stop lowering during the walk at all. The collect walk now emits the section's STRUCTURE as a `sectionNode` sidecar (`sectionBlock` in `@agentick/formatters`, `SectionNode` in `@agentick/spec`) — deliberately the same carrier shape `semanticNode` has used since ADR 22 §D5, and for the same reason: a block that is not text YET. `expandSections` lowers it during the formatter pass, and `createFormatter` runs that ahead of every formatter's own `render`, so markdown / xml / text and any third-party formatter get section lowering without writing a line of it.

**Body first, then frame.** That ordering is the whole thread-through. The section's content goes through the formatter BEFORE the frame is applied, so an xml section emits `<current_user>` around an already-escaped body: the tag never reaches the escaper and the body reaches it exactly once. Lowering during the walk could not have both — a frame emitted then would be escaped by the pass that follows (`&lt;current_user&gt;`), while a body lowered then would be escaped twice (`&amp;amp;`). One ordering change dissolves both.

**Three consequences, all wanted.** (1) A semantic-HTML-bodied section is ONE block — lowering used to run before the sidecar had any text in it, so `<Section title="X"><Paragraph>…</Paragraph></Section>` produced a title block plus a separate body block, and the title-to-body separator was `blocksToText`'s `\n\n` instead of the pinned `\n`. One lowering, one block, and the bytes now match the conservation pin the split case was quietly violating. (2) `renderedWith` means what it says: the ref was always stamped from `ctx.formatter("section")`, and it now names the dialect that actually ran. (3) `mergeAdjacentSections` moved out of the collect walker into the lowering, byte-equivalently — the collector's `coalesce` lost thirty lines and its `@agentick/formatters` import.

**`TODO(double-format-in-render-to-string)` fell out and was fixed.** `renderToString` ran `renderTree`'s formatter pass and then handed those ALREADY-FORMATTED blocks to `formatTree`, which formatted them again. Invisible while markdown was the only lowering (markdown is idempotent on plain text); catastrophic the moment a pass emits an xml section frame the next pass escapes. `formatTree` no longer re-runs the block pass — it frames and flattens, which is all a caller holding a `RenderedTree` should want, since a `RenderedTree` is wire-shape by contract. A caller-pinned `renderToString({ formatter })` now applies that formatter DURING the block pass rather than after it, which is the only way a pin can reach a section's dialect.

**`compileTemplate` runs the formatter pass now, and it had to.** It never did, so its IR carried unresolved `semanticNode` sidecars — and `@agentick/prompts-react` returns those entries verbatim, so MCP `prompts/get` was already shipping empty text blocks for any semantic-HTML prompt body. Moving section lowering to the pass would have added sections to that leak. Making the two compile entry points agree — `compileTemplate` and `CompilerHarness.renderTree` both return wire-shape IR — closes both. `renderTemplate`'s `formatter` option threads into that pass for the same reason `renderToString`'s does.

**Boundary worth stating.** A section NESTED in a message reads in the MESSAGE's dialect. One formatter renders an entry's content and the section's blocks ARE that content, so the container decides the dialect exactly as it decides the role. `<FormatScope purpose="section">` still picks the formatter for a FREE-STANDING section, whose entry carries the ref — every claim in `formatter-scope.spec.tsx` is unchanged.

**One test fixture moved, and why.** `packages/app/src/__tests__/prefix-stability.spec.tsx` reads an auto-generated section id off a block to prove ids differ across mounts. Its two sections sit adjacent in one `<System>`, and the merge rule keeps the FIRST section's id — previously the merge did not fire there, because the semantic-HTML section left a sidecar block last and sidecar blocks never merged. With the split fixed it fires, so the auto-id section is written first. The assertion is unchanged; the fixture now reflects the merge rule instead of an artifact of the bug.

**2026-08-02 — ADR 94 implemented: sections are content. `SectionEntry` leaves the IR.**

**The law: container decides role, position decides order.** `ContextSpec.entries` is `readonly MessageEntry[]` and nothing else. A model call is system instructions plus ordered messages, so that is what the IR is. A `<Section>` inside any message lowers into that message's content; a free-floating `<Section>` becomes an anonymous `role: "grounding"` message at exactly its tree position (the CSS anonymous-box rule). `<System>` is not special — it is the message whose content becomes the provider's system parameter.

**The defect it removes.** `buildMessages` filtered EVERY section entry, wherever it sat, into one leading system message. A `<Section>` below `<Timeline />` was hoisted to the top of the system prompt: rendered JSX did not equal compiled model input, in the framework whose pitch is that the tree IS the context surface. It is now the LAST message the executor receives, pinned end to end in `packages/app/src/__tests__/positional-sections-e2e.spec.tsx`.

**The compiler nesting fix (next.17).** A `<section>` nested in a `<message>` was SILENTLY DROPPED — its fragment was neither a `content-block` nor a `semantic-node`, so `gatherItems`' switch in `collect.ts` ignored it and the section vanished with no diagnostic. The section contributor now emits a `section-content` fragment that the walker splices into the containing message's content (and the top-level fold wraps in a grounding message). The drop site became the mechanism.

**Deleted, no aliases:** `SectionEntry`, `SectionMetadata`, `SectionMetadata.priority`, the `ContextEntry` union and the name itself, `isMessageEntry` / `isSectionEntry`, `collectSectionText` / `sectionText`, `anthropicSectionText` and the whole Anthropic per-section system loop, `frameSection` from `create-formatter` / `markdown` / `xml` / `text` / `format-tree`, and the `entry.role as LanguageModelMessage["role"]` cast.

**What SectionEntry carried, one level down.** Cache breakpoints: `BaseContentBlock.cache` is new, `lowerSection` puts a section's hint on the last block it produced, and `messagePartFromBlock` forwards it to the part — so #185's per-section boundaries survive with NO special system-message handling anywhere. That is what let the Anthropic projection override shed its section loop: its only reason for existing was that the canonical fold joined sections into one string. Stable ids: the section stamps `id` on every block it produced, and `provenance.ts` reads origins from those blocks, so a system part is attributable for the first time (it used to be `undefined` by construction).

**`<Section role>` — the escape hatch on the anonymous-box default.** A free-standing section's message is `grounding` because that is what non-conversational context IS, but a section that is a turn says so: `<Section role="user">` compiles to a plain user message whose content is still the section structure, and the role rides the same adapter table as any other. On a NESTED section the prop is a diagnostic (`SECTION_ROLE_IN_MESSAGE`), not a silent no-op — the container already decided the role, and honouring it would mean breaking the section out of its parent, which is the hoisting this ADR removes. `role="system"` is a system entry like any other and answers to the same never-mid-stream rule. **No tag-override prop for XML, deliberately:** markdown renders the title's words as a heading and XML renders the same words as a tag, so one section has one name in both dialects; an independent tag prop would let them diverge, and an exact tag already has a home in the custom-block mechanism the XML formatter preserves verbatim.

**The diagnostic story — enforcement at compile time, not silent folding.** Three `FormatDiagnostic`s from the collector. `SECTION_WITHOUT_SYSTEM` (warning) fires on a free-floating section before any `<System>` and before any message, and its text literally says "If these are system instructions, wrap it in `<System>`" — a migration hint, NOT a shim: the section still compiles to grounding at its position. `MID_STREAM_SYSTEM` (warning) fires on a system message at or after the first non-system entry. `SECTION_ROLE_IN_MESSAGE` (warning) fires on a `role` prop the container has already overruled, and names the `<Message role="…">` wrapper that would do what the author meant. The projection keeps ONE path (all system entries merge, in order, into the system parameter) because no provider has a mid-stream system position to project into; what stops the pattern is the diagnostic, not a second fold.

**The role seam.** `LanguageModelMessageRole` is a new closed union carrying `grounding` and `event` alongside the four provider roles. `canonicalRole` narrows the open `MessageRole` and throws `UnknownMessageRoleError` rather than casting; `lowerSemanticRole(role, table)` lowers at each ADAPTER's boundary with a table `satisfies Record<LanguageModelMessageRole, …>`, so a role added upstream breaks every adapter at compile time. OpenAI takes `grounding` → `developer` (its sanctioned non-user channel, legal mid-stream); Anthropic and Google take `user`. `event` is `user` everywhere — an event is a record, not an instruction. What keeps a grounding message from reading as an impersonated human turn on a provider with no role for it is the structure already in its content, which is why `<Grounding>` is a grounding message wrapping a `<Section>` and not a bare text turn.

**Conservation pins, written before the fold changed.** Three, all green: an ernesto-style semantic-HTML `<System>` compiles to byte-identical bytes (`"# Identity\n\nYou are Ernesto.\n\n## Rules\n\nBe terse.\n\n"`); a title+text section's markdown lowering is byte-identical to the old `sectionText` (`"# Title\nbody"` — one heading line, single newline); two sections in one message join with the blank line the old `collectSectionText` used. That last one needed a real mechanism: two sections are two blocks, one block is one projected part, and OpenAI concatenates text parts with NO separator — so `mergeAdjacentSections` in the collector merges adjacent section-stamped text blocks, EXCEPT across a `cache` / `providerMetadata` boundary, which is #185 restated at block level.

**Which formatter cut shipped.** The lowering is written once, in `@agentick/formatters` (`lowerSection` / `sectionTagName` / `SECTION_STAMP`), and `@agentick/compiler` took a dependency on that package to call it. The XML title→tag slug rule is implemented and tested there. The COMPILE path applied markdown unconditionally, marked `TODO(section-formatter-thread)` — closed the same day; see the entry below.

**One unrelated fix while in the file.** `canonical-projection.ts` carried a RAW NUL byte (0x00) inside `` `${decl.provider}\0${name}` `` — a deliberate map-key separator written as a literal byte. It made `file` classify the module as BINARY and plain `grep` skip the whole file silently, which is how a search for `export function buildMessages` in that file returned nothing mid-implementation. Replaced with the `\0` escape (byte-identical runtime string, greppable source) plus a comment saying the separator is deliberate; `file` now reports text.

**Downstream migration note (knowify/ernesto — NOT touched).** Ernesto's identity sections already live inside `<System>`, so those bytes are unchanged. `UserContext` / `ThreadContext` are free-floating between `<System>` and `<Timeline>`: they become grounding turns between system and history, which is what that tree visually claimed all along. `RagContext`'s hand-rolled `<User>` turn can become a plain mid-stream `<Section>` at leisure.

**2026-08-01 — the name collision resolved as a union variant, and the scope ladder gets its living-subtree rung.** Two verticals, both closing a `TODO` the previous entry opened. Neither is a subsystem: one union member, one registry walk beside an existing one, one scope kind through an existing extension.

**(1) Progress signals are a `StreamEvent` variant now (`TODO(mixed-stream)` resolved).** The per-token progress stream has always had two producers — the execution-event fan-out and ADR 64 `<surface>:signal:progress` signals — and `client-core`'s `events()` yielded bare payloads, so consumers duck-typed. The blocked fix was stamping the envelope's `name` onto the payload, which collides with the **tool** name six variants already carry. The resolution is the other door the last entry named: discriminate on the union's EXISTING `type`. `ProgressStreamEvent` = `ProgressUpdate & { type: "progress"; token; sessionId?; executionId? }`, and a consumer writes one `switch` with no shape guards.

**It deliberately does NOT extend `StreamEventBase`.** The base demands `id` / `sequence` / `tick` / `timestamp`; a bus signal emitted by a tool handler can honestly supply none of them — there is no per-session monotonic sequence behind it, and it belongs to a tool call rather than a tick. Faking four fields to satisfy a structural relation nothing reads would be four lies per frame. A union member need not share the base: `type` is the discriminant, and it is the only field consumers narrow on. The cost is real and small — a consumer reading `ev.sequence` off an unnarrowed `StreamEvent` must narrow first. Workspace sweep found exactly two such sites, both tests, both now stating the invariant they were relying on. **No exhaustive switch over `StreamEvent` exists anywhere in the workspace**, so nothing started throwing; the one `type`-dispatching production site (`client-projection`'s tool-output bounder) is an if-chain that ignores what it does not recognize.

**What the variant carries beyond the payload:** `sessionId` / `executionId` off the envelope's scope — the EMITTER's identity, which under `fanIn` is a descendant's, and which `events()` used to discard. The `executionId` learn-step on the client handle deliberately skips progress frames: learning from a signal would advertise a sub-agent's execution as the caller's. Only `progress` gets a variant; `log` does not ride this stream and inventing one would be speculative.

**(2) `session-tree` subscription scope (`TODO(fan-in-session-scope)` resolved).** A channel event is scoped to its emitting session, so a client watching a root's `task-status` saw nothing from the sub-agents that root spawned — precisely the work that outlives a turn and has no turn stream to ride. `SubscriptionScope` gains `{ kind: "session-tree", id }` — a KIND, not a flag on `session`, because the kind names the shape of what you observe and is enumerable on the wire.

**The two membership questions, and why both exist.** `AppHarness.sessionTreeContains(rootId, sessionId)` is the same O(depth) cycle-guarded `parentSessionId` climb as `executionTreeContains`, terminating on the root session instead of an origin execution — and the asymmetry is the point: **an execution id names a turn a session moves past; a session id names the session itself.** So the origin session is NOT a member of its own turn's tree, while the root IS a member of its own tree (a subscription that watched a session's tree but not the session would be one nobody wants). Membership here is lineage, not turn: a descendant belongs whichever turn spawned it and keeps belonging after that turn settles — which is exactly what a subscription needs, because a subscription outlives any one execution. `sessionTree(rootId)` is the enumeration half (root-first, breadth-first), the public projection of the app's existing private `liveSubtree`.

**Snapshot splice and the late-spawn story.** A tree subscription opens the same producers a session one does, widened to the OWNING APP (not the gateway — a spawn tree lives in one app) and narrowed on arrival by the predicate, the same widen-then-filter shape `fanIn` uses one rung down. At subscribe time, when the query names exactly one channel, EACH live member's current snapshot is spliced ahead of the live tail in `sessionTree` order. A session spawned AFTER subscribe needs no retro-splice: its channel emits as it populates and the arrival filter is a live registry read, so its frames are admitted the moment they exist. Frames keep their envelopes, so attribution rides `scope.sessionId` — verified, and nothing was added to the frame.

**Authorization: one gate, unchanged, and an honest note about it.** Every scope kind passes the same verb-derived `sub:subscribe` label. Scope-target resolution (the same-principal rule, the session's `requiredScopes` ceiling) keys on `params.sessionId`, which `SubscribeParams` does not carry — the target rides `params.scope.id` — so it does not run for ANY subscription scope today. `session-tree` therefore adds no reachability a `session` subscription on the same root did not already have, and it is the right shape when the gate does run (principal descends the spawn tree, ADR 48, so admitting a root admits its tree). The gap is pre-existing and already named: `TODO(trail-session-resolution-seam)` in `@agentick/transport`'s `authorizeDispatch`. Recorded in the extension's doc-block rather than papered over.

**Client surface.** `session.treeEvents(query?, fromCursor?)` beside `session.events(...)` — the same subscription with the tree scope, named after the scope. An options bag on `events()` would have had to thread past two positional params to say one thing.

**Deliberately not done.** The third rung — a subscription over everything ONE PRINCIPAL owns, carved by identity rather than lineage — is unbuilt. `{ kind: "gateway" }` exists but is an operator's view, not a tenant's. `TODO(gateway-scope-subscription)` sits at the scope-kind switch naming the design (principal-prefix admission: widen to the gateway, admit iff the emitting session's principal equals the caller's), and why it waits: no consumer has asked, and the envelope scope carries no principal — the same emitter-side gap `TODO(signal-scope-app-id)` names.

Verified by `@agentick/transport-in-process`'s `session-tree-subscription-e2e.spec.ts` (6, real gateway/app/spawn/tasks: descendant + grandchild frames attributed, plain session scope unchanged, per-member snapshot splice root-first, late spawn joining live, a foreign session excluded on both axes while publishing first, and teardown) and the 7th case in `progress-fan-in-e2e.spec.ts` (the union variant through the typed handle, beside unchanged `tool-dispatch` frames), plus `@agentick/app`'s `cascading-abort.spec.tsx` (+1: the membership asymmetry stated as a pair) and spec unit tests for the name predicate and the scope guard. Full suite 6243 green; typecheck clean except the pre-existing untracked `@agentick/model` spec.

**2026-08-01 — a turn's progress now includes its sub-agents (`fanIn`); the envelope `name` stays stripped, and the reason is a collision.** Two loose ends off the determinate-progress and cascading-abort verticals. One landed; the other found a wall worth writing down.

**(A) `envelope.name` on `events()` — NOT done, and not for lack of trying.** The gateway pushes self-describing envelopes onto the per-token progress stream (execution events under `session:execution:event`, raw signal envelopes under `<surface>:signal:progress`), and the client's `events()` yields only the payload, so every consumer re-derives the frame kind by duck-typing. The minimal fix — stamp the envelope's `name` onto the yielded payload — **collides**. Six `StreamEvent` variants already carry a `name`, and it is the TOOL name: `tool-call-start`, `tool-call`, `tool-dispatch-start`, `tool-dispatch-end`, `tool-dispatch`, `tool-confirmation-required`. Those are the most-consumed frames on the stream; overwriting `name` there would silently replace "which tool" with "which frame kind" in every UI that renders a tool call. Resolving it is a real design choice — fold signals into the `StreamEvent` union under their own `type`, or yield the envelope and change what `events()` advertises — and it belongs to whoever owns that union. The `TODO(mixed-stream)` now records the collision with the six variant names so nobody re-derives it, the client-core README documents "ignore unknown `type`" as a rule and points at `client.transport.progress(token)` for consumers that need the envelope, and the gap is listed. **Cost of NOT stamping: nothing was lost — the name was already on the wire and still is.**

**(B) Execution-scoped fan-in of descendant signals — landed, opt-in.** Producer (2) in `session-extension.ts` subscribed `progressEventQuery()` scoped to `{ executionId }`, which is the root turn only; a sub-agent runs its own execution, so its `ctx.progress` matched nothing and a caller watching a fan-out saw silence for exactly the work slow enough to need a bar. The gateway bus already receives every descendant's signals — it is the fan-in root — so this was purely a filter problem, and the fix is a filter plus one registry query, no subsystem. `fanIn: true` swaps the scoped subscription for a gateway-wide one and post-filters each envelope: keep iff its execution IS this turn, or the emitting session's lineage reaches this turn.

**The membership query is the origin edge, read from the other end.** `AppHarness.executionTreeContains(executionId, sessionId)` climbs `parentSessionId` from the session and stops at the first ancestor stamped with that `originExecutionId` — the same membership `abortExecutionTreeBody` computes top-down, answered bottom-up because a subscriber gets one session id per event rather than a snapshot. O(depth), no store reads, no cache. Same limitations, stated the same way: a paged-out ancestor breaks the chain (`TODO(abort-execution-tree-paged-out)`'s twin).

**Isolation is the guarantee, and it is what the tests are mostly about.** A sibling execution satisfies neither arm — not on this session, not on another — and neither do its descendants. Four of six e2e tests are about frames that must NOT arrive. The sharpest: turn A spawns a child and does not await it, turn A ends, turn B starts with `fanIn` on the SAME session, and A's still-live child emits DURING B — both children are live descendants of one session and only the origin EXECUTION separates them.

**Threading.** `SessionSendParams.fanIn?: boolean` (wire) + `ClientSendInput` (client). Deliberately NOT on `SendInput`: it configures the OBSERVATION channel the wire opens alongside the turn, which in-process has no analogue for, so putting it there would be a field on the primary session API that silently does nothing off the wire. Omitted ⇒ byte-identical request and behavior.

**One bug found on the way.** `WireExtensionContext.app` documented itself as populated "when the method is app-scoped OR session-scoped", and only the first half was true — `buildWireExtensionContext` resolved `app` from `params.appId`, which `session/*` never carries. Every session-scoped wire handler had `ctx.app === undefined`. Fixed in `@agentick/transport`: session resolution now returns its owning app, and an explicit `appId` still wins.

**Deliberately not done.** Execution-EVENT fan-in is untouched — what a child surfaces to its parent's event stream is decided at the harness level (`TickEndForwardDecision`), and a second answer at the wire would compete with it. Session-scope subscription fan-in (`sub/subscribe` over `session:channel:*`) has the same blind spot and no equivalent; `TODO(fan-in-session-scope)` states why its membership question is harder (a subscription outlives any one turn). And `TODO(signal-scope-app-id)`: the arrival filter's `appId` check is inert today because no `appId` reaches a `tool:signal:progress` envelope, leaving a narrow hole — two apps on one gateway, deliberate reuse of one explicit session id, concurrent `fanIn` turns. Closing it belongs at the emitter; every scope-filtered bus subscriber shares the blind spot.

Verified by `@agentick/transport-in-process`'s `progress-fan-in-e2e.spec.ts` (6, full stack incl. real `spawn`), `@agentick/app`'s `cascading-abort.spec.tsx` (+1 membership case), `@agentick/client-core`'s `send-fan-in.spec.ts` (threading, and absence when unasked). Full suite 6231 green; typecheck clean except the pre-existing untracked model spec.

**2026-08-01 — determinate vs. indeterminate progress: one grammar, one reporter, one fold.** The split was already sitting in the data (`ProgressEventPayload.total` present or absent, MCP-aligned) and nothing consumed it — every emitter hand-built frames, and nothing checked them. Three things landed on top of the existing frame; **the wire shape, the bus event names, the MCP projections, and the tasks channel topology are unchanged.**

**(1) The law, written down.** Four rules now govern `ProgressUpdate` in the spec doc-block. _Frame-classifiability_: every frame classifies alone — `total` present is determinate, absent is indeterminate — which is the whole reason a late joiner (a reconnect, a snapshot splice, a UI mounted mid-flight) renders correctly from the first frame it happens to see; a determinate frame that omits `total` "because an earlier one had it" breaks every late joiner. _One-way ratchet_: indeterminate → determinate once, when the denominator is learned mid-flight; never back, never changed. _Monotonic_: progress never decreases. _Terminal by operation, not by frame_: no `done` field, deliberately — the tool call resolving or the task reaching a terminal status is what closes the bar, and that omission is exactly what keeps the frame byte-identical to MCP's `notifications/progress` in BOTH directions.

**(2) The reporter — correctness by construction.** `createProgressReporter(emit, opts?)` holds the count, the ratchet, and a finished flag, and cannot break the four laws: `advance` / `set` clamp to a known total and refuse to move backwards, every determinate frame carries `total`, no indeterminate frame ever does, `done()` is idempotent and drops every later emission. It emits **one opening frame at zero** on construction — the affordance should appear when work starts, not at the first `advance()`, and work that emits nothing else still announces that it began. `advance`/`set`/`note`/`done` never throw (a bad number is clamped or ignored — a glitch in a progress call must not take down the work it describes); `total()` alone throws, and only on a ratchet violation, which is a bug rather than a data glitch.

**It lives in `@agentick/spec`, not `@agentick/utils`.** `createLog` — the exact precedent, a pure constructor for a callable ctx surface — is already in spec beside the `Log` type it builds, and utils declares no protocol coupling and has no spec dependency; siting the reporter there would have meant a new utils → spec edge in the foundation for one helper. The type is part of the handler-facing surface, so it belongs with the surface.

**(3) The callable-object door.** `ctx.progress` is now a callable object like `ctx.log`: still callable as `(token, frame)` — the raw door stays, for bridging an MCP client's `_meta.progressToken` and for handlers that own their own counting — plus `.begin(opts?)`, which mints the token from what the runtime already knows (the tool call id in the tool executor; the client's progress token, when it supplied one, under the MCP-server projection) and routes every frame through the SAME emission path, same scope stamping, same `tool:signal:progress` event. Handlers never invent tokens.

**(4) Tasks speak the same grammar.** `ProgressUpdate.current` is **renamed to `progress`**, and the type now lives once in `data/signals.ts` with tasks importing it — the task channel and the signal family were carrying identical data under different field names, so a UI could not fold both. No alias, no compat shim: an alias would have preserved the exact ambiguity the rename exists to delete, and the migration is mechanical. Swept: the harness fold + both publish paths, executor, worker, handler registry, both conformance suites, the tasks README, the otto example, and `@agentick/mcp`'s task bridge — where the boundary code was literally renaming the wire's `progress` field to `current`, and is now a pass-through. `TaskWorkVerbs` gains `progress: ProgressBegin` (`task.progress.begin(...)`, the task's own id as the token) beside `onProgress`, which stays as the raw door on the renamed shape. One straggler was caught only by an unfiltered grep — an MCP integration test that cast the event to a loose `{ current?: number }` shape, so it typechecked clean and would have failed at runtime.

**(5) The fold, and where defensiveness belongs.** `progressView` in `@agentick/client-core` (beside `channelView`, same config/subscription shape) holds the latest `ProgressState` per token, pre-classified: `kind` is the entire render decision, `fraction` clamped to `[0,1]`. The split worth naming: **the reporter makes first-party emitters correct by construction; the fold defends against emitters we do not control.** A third-party MCP server bridged onto the bus can send anything, so a frame that regresses, or that shrinks / drops / changes an established `total`, is dropped rather than rendered — a frozen bar is honest, a bar that jumps backwards or silently rescales is not. The ratchet upgrade is the one legal mutation and is honored. Holding at 99% until the operation settles stays the component's policy; the fold invents no terminal state.

**Also renamed:** the unrelated wire-layer `ProgressReporter` (an RPC envelope streamer with cursor tracking — arbitrary extension-defined payloads, nothing to do with counting) → `ProgressStreamWriter`, symmetric with the client's existing `ProgressStream` reader. It collided with the adopter-facing noun, and the counter has the better claim to it. Three live sites; CHANGELOGs left alone as historical record.

**Not built:** weighted child composition — `work.child(weight)`, a reporter that owns a slice of a parent's range so a fan-out reports one coherent bar. Roadmap, not scope: the frame grammar already accommodates it (a child folding into the parent's count needs no new fields), and there is no second consumer yet. TODO markers are at the reporter's doc-block, not scattered.

Tests: 22 on the reporter (each law in turn), 13 on the fold (classification, the ratchet upgrade, and every drop case), 2 on `ctx.progress.begin()` through a real dispatch, 3 on the task path including the durable record's fold.

**2026-08-01 — cascading abort at two scopes: the SESSION subtree and the EXECUTION fan-out.** `session.abort()` cancelled one execution and nothing else. A sub-agent kept working after its parent was told to stop, because a spawned child only ever received the parent's CONSTRUCTION signal — which `abort()` does not touch — and its RUNNING execution was cancelled by nothing. `destroySession` already solved this for its own purposes (the registry walk over `parentSessionId`, deepest-first), so the fix is reach, not machinery. **The ladder is now four rungs, strictly increasing, and documented as one** (`SessionAbortOptions` doc-block, app README table): `abort()` < `abort({cascade})` < `close()` < `destroySession()`; only the two abort rungs are reversible (nothing disposed, no store touch, detached tasks keep running — pinned against destroy reaping them in one test). Cascade is **scope, not kind**: no new op, one ordinary `loop:abort` per aborted session, so a guard sees the ops it already knew. The walk is `AppHarness.abortEach` (deepest-first over an ordered subtree, returns the ids it aborted), reached two ways — destroy passes the subtree it already snapshotted, and `SpawnContext.abortSubtree(sessionId, reason)` (new required member; the session's only door to the registry that holds its descendants' harnesses) computes one. A session with no `spawnContext` cannot have spawned anything, so cascade there collapses to the self-abort. **The execution scope is the more interesting half.** Two mechanisms, deliberately: (1) LIVE — each execution now owns a downstream `AbortController` (`_currentExecutionAbort`) that `handle.abort` fires BEFORE `loop.abort` (child stops before the parent unwinds) and that the settle path fires on any non-`succeeded` outcome (so a TIMEOUT, which `handle.abort` never sees, tears down too) and on the error path. It is NOT merged into the signal handed to the loop — the loop's ratified abort semantics stay untouched; this controller only fans OUTWARD, and `spawnBody` merges it with the construction signal into the child's construction signal. Cancel a turn and the sub-agents that turn started go with it, with no cascade requested, because they belong to the turn. (2) AFTER THE FACT — a turn that SUCCEEDS deliberately leaves its children running, so there is no live signal left to fire; every spawn now stamps `originExecutionId` (+ the existing `originCallId`) on the registry entry AND the durable `SessionRecord`, and `app.abortExecutionTree(executionId)` walks that edge: direct children of the target execution, then each of their whole live subtrees (once a branch belongs to the cancelled turn, so does everything under it — including a grandchild spawned by a LATER execution of a lineage session), deepest-first, then the origin itself only if `session.currentExecutionId` still equals the target (a session that moved on to a later turn must not have that turn cancelled by a settled turn's id). Its own op (`app:command:abort-execution-tree`) for destroy's reason — a guard should be able to refuse "cancel this turn's fan-out" without refusing every abort. Result names the sessions it stopped, not just a count: the caller's next move needs their ids. Also added: `SessionHarness.currentExecutionId` (sync twin of the record field). Wire: `session/abort` gains `cascade?: boolean`, threaded gateway→session untouched; no new gate — the subtree is the session's own descendants and principal descends the spawn tree, so the dispatch gate's same-principal check on `sessionId` already covers everything reached. Verified by `packages/app/src/__tests__/cascading-abort.spec.tsx` (7) + `session-abort-e2e.spec.ts` (+1 wire round-trip). Two test-fixture traps worth recording: a scripted `FakeLanguageModelExecutor` cursor is per-instance and GLOBAL across sessions (one per send, or interleaving decides who gets which tick), and reusing a tool-call id across two executions of one session means the second call never reaches the handler. NOT built, deliberately: no wire verb for `abortExecutionTree` (`TODO(abort-execution-tree-wire)`) — the client-facing case is session-addressed, and an execution-addressed verb wants the execution-scope gate question answered first; no `SessionStoreQuery.originExecutionId` filter (the walk is live-registry only, so a paged-out descendant of a cancelled turn is out of reach — the same limitation destroy has).

**2026-08-01 — connecting to a gateway that was not there: a dial with no deadline, a dial with a rival, and a resubscribe that took "not yet" for "never."** Two defects from real browser use, both about a gateway that was absent when the client needed it — one where the backend was down at startup and the client never connected after it came up, one where the backend restarted under a connected client and the UI went permanently silent on a wire that had reconnected fine. Neither was in the never-stops work's blind spot by accident: `1ffb0994` closed every way a loop armed by FAILURE could die, and all three of these are ways a dial or a subscription fails to reach that loop at all.

**The dial had no deadline, so the loop was armed by nothing.** `openConnection()` was awaited without a timeout anywhere in `BaseClientTransport`. A refused TCP connect fails in a millisecond and arms the loop, which is why every existing e2e passes — but a backend behind something that is UP (a dev-server proxy, an ingress, an LB with a dead upstream) accepts the TCP connection and never completes the upgrade. No `error`, no `close`, no rejection: the socket sits in `CONNECTING` and the transport parks in `connecting` for the life of the tab, including long after the backend boots. `ReconnectPolicy.dialTimeoutMs` (10s) now bounds every dial, discards the half-open wire through `discardWire()`, and re-arms the loop like any other failure.

**A second `connect()` opened a second socket, and the loser never settled.** `connect()` is public and adopters call it again — a retry button, an effect that re-runs, the backoff timer firing while the caller's own dial is in flight. Each call ran `openConnection()`, and the subclass's `this.socket === socket` staleness guard then muted every listener on whichever socket lost: its promise never settled (so `await client.connect()` waited forever on a transport that was already open) and its socket was never closed (a connection the client cannot read, held open on the server). Dials are single-flight now — `dial()` is the one path, and the reconnect timer routes through it too, so a timer that fires mid-dial joins rather than races.

**A restarted gateway answers "not found" for everything, and that killed the subscription permanently.** `resubscribeAfterReconnect` fires the instant the socket opens — milliseconds after the restart, long before the adopter's create-or-resume has rebuilt anything — so it asks a gateway whose session registry is empty. `onResubscribeFailed` classified every `rpc` failure as a verdict and ended the stream, which is a UI that reconnects to a live wire and never receives another event. But `AppNotFound` / `SessionNotFound` after a reconnect is a RACE with the client's own re-establishment, not an answer: it is final for that instant and very likely wrong a moment later. Those two codes are now re-asked on the same backoff curve for `resubscribeGraceMs` (30s), then ended with the error — the window is what separates a session being rebuilt from one that is genuinely gone, since both say the same thing. Every other refusal still ends the stream immediately. The gateway also had to name what was missing: `subscriptionsWireExtension` threw `AppNotFoundError({ appId: String(params.scope) })` for a session scope, i.e. `app [object Object] not found`, which told a client neither what was missing nor whether to re-ask.

**And the stream class nobody was telling.** A drop rejects every pending RPC and leaves subscriptions registered for the resubscribe above — but PROGRESS streams got neither. `handleConnectionDrop` never touched `progressStreams`; only `close()` did. A progress token names one in-flight operation on a connection that is gone and no verb re-attaches to it, so the drop is the last thing that will ever happen to that stream, and saying nothing left the consumer's `for await` blocked forever. The send's own RPC rejects — but a caller rendering a live turn is not awaiting that promise, it is awaiting the iterator. That is a UI stuck rendering a turn for the rest of the session, on a client whose wire came back fine, and it is the shape the consuming app reported as "it never reconnects". In-flight progress streams now end with the drop failure — with the FAILURE, not cleanly, because "the stream died while the operation may still be running" and "the operation finished" are different facts and the honest recovery (reconnect, re-read what it committed) is only available to a consumer that was told which one happened.

Verified by `packages/transport-websocket/src/__tests__/reconnect-to-new-gateway.spec.ts` (real wire, real gateways: a listener that accepts and never upgrades; the real backend replacing it; two concurrent `connect()` calls yielding ONE accepted upgrade; a live session subscription carried across a restart into an empty registry and healing when the session is re-created; and a resubscribe an authorizer refuses ending that stream and only that stream) and four new cases in `packages/transport/src/__tests__/never-stops.spec.ts` driving the base class directly. All four e2e cases and two of the base cases fail on HEAD. Note what this does NOT change: `connect()` still rejects on its own failed dial, and readiness is still where recovery is observed. Full suite 6170 green; workspace typecheck clean except the untracked `@agentick/model` spec another session is holding.

**2026-08-01 — the client allocates the subscription id; every snapshot-backed channel now delivers frame one.** `sub/subscribe` splices a session channel's snapshot in front of the live stream, which is the entire reason the snapshot exists — and the subscriber it was built for could not receive it. The handler opened the scope's iterable, registered the subscription for a SERVER-minted id (`srv-sub-${++subscriptionCounter}` in `transport/src/server/dispatch.ts`), started a background drain, and only THEN returned `{ subscriptionId }`. The drain's first `publish` reached `sink.sendNotification` a microtask or two later while the response was still unwinding `dispatchRequest`. Client-side the stream sat under a `tentative-sub-…` id until the response callback re-keyed it, and `routeNotification`'s event arm is `const stream = this.subscriptionStreams.get(subId); if (!stream) return;` — so the opening frame arrived, matched nothing, and was gone permanently, since a snapshot is sent once. The symptom is a UI that attaches to a live session and sees an empty knobs panel, no pending elicitation, no running tasks, until something else happens to move.

**The fix is not a better ordering, and that is the load-bearing point.** "Write the response before the first frame" is unenforceable in general: over `@agentick/transport-http` the RPC response comes back on the POST body while notifications ride a separate persistent SSE GET — two connections, no ordering relation, nothing to arrange. So `SubscribeParams.subscriptionId` is now REQUIRED and client-allocated, and the server adopts it verbatim, echoing it in `SubscribeResult` as confirmation (a mismatch fails the subscription as a `protocol` TransportError rather than iterating a stream nothing will route to). The client registers the stream — and its `activeSubscriptions` entry, which is where `routeNotification` records `lastCursor` — under the FINAL id before the request frame is written, so no frame is ever unroutable on any wire. Precedent was already in the same file: progress streams are keyed by a client-minted `progressToken` and never had the dance. `WireExtensionTransport.registerSubscription` took the id (`(subscriptionId, cleanup)`); the module `subscriptionCounter` is deleted; the tentative id, the re-key, `MultiplexedStream.rekey`, and the big docblock defending the same-tick `[response, event, event]` race are gone — `base-transport.ts` is 16 lines SMALLER. `resubscribeAfterReconnect` reuses the same id with no map churn. `BaseConnectionContext.registerSubscription` refuses an absent or duplicate id with `InvalidParams` (`admitSubscriptionId`, exported and reused by the unix-socket server's inline sink): adopting a collision would re-point a live subscription's routing at a second producer.

Verified by `packages/transport-in-process/src/__tests__/subscription-first-frame.spec.ts` (against a real gateway: a subscriber attaching AFTER the state exists gets the snapshot as its literal first frame for knobs-state, a pending elicitation ask, and a working task; plus the duplicate-id refusal) and `packages/transport-websocket/src/__tests__/subscription-first-frame.spec.ts` (the same over a real socket — WS is where the deleted synchronous-re-key defence was aimed, so it is where its removal has to be shown not to cost anything). Both were confirmed non-vacuous: under a simulated pre-fix client that registers the stream only when the response lands, all four snapshot cases TIME OUT. The channel-level cases live in `transport-in-process` rather than in `@agentick/elicitation` / `@agentick/tasks` because the assertion is about wire frame ordering and needs gateway + transport + session composed — the same reason `elicitation-e2e` and `tasks-cancel-e2e` already live there. Full suite 6165 green; workspace typecheck 104/105 (the one failure is the pre-existing untracked model spec).

**2026-08-01 — `ctx.elicit` was dead in every `createApp` session; channel names were unreachable from `/client`.** Two independent bugs, both the same shape: a fact wired at one construction site and not the sibling one.

**(1) Task `ctx.elicit` — one missing argument, total loss of the feature under `createApp`.** `buildTaskElicit` (`packages/tasks/src/task-elicit.ts:69`) returns a throwing stub unless BOTH `hooks.escalate` and `hooks.buildElicit` are present, and `buildElicit` is injected by design — `@agentick/tasks` owns no elicitation dependency. `buildSessionBridges` injected `buildElicitSugar`, but only in its `options.tasks ?? new TasksHarness(...)` FALLBACK arm (`packages/session/src/session-bridges.ts:283`). Every app composes through `createApp`, and `AppHarness` constructs the per-session `TasksHarness` ITSELF (`packages/app/src/harness.ts:2077`, the #159 single-construction-site rule) and injects it — so the arm that supplies the factory never ran, and the FIRST `ctx.elicit.*` call in any background task failed the task with "ctx.elicit is not configured". The scope half had already landed (`submit({ scope })` stamps the owning session; `makeEscalate` reads `record.scope`), so the fix is literally one argument at the app's construction site plus the import — no threading seam, because `@agentick/app` already depends on `@agentick/elicitation` and already constructs the `ElicitationHarness` fourteen lines above. The stale NOTE in `session-bridges.ts` that described the gap as open is rewritten.

The interesting half is what the bug was HIDING. `assertInteractive(record)` — the `interactive ⊥ detached` law (ADR 69) — sat behind the not-configured stub, so on the app path a detached task's `ctx.elicit` failed for the WRONG reason and no test could tell the difference. Confirmed by reverting the one-line fix against the new spec: the detached case failed with "not configured", not `DetachedTaskCannotElicitError`. It is now the live guard and pinned as such.

**(2) `/client` barrels did not re-export their channel names.** `TASK_PROGRESS_CHANNEL` lived only on the ROOT `@agentick/tasks` barrel, so a browser bundle wanting one string constant had to import the whole server harness — the barrels-are-single-environment rule, violated in the one direction `client-entry-browser-safety.spec.ts` cannot see (the tasks harness happens to reach no `node:*` builtin, so the graph walk stayed green). Audited every package with a `/client` subpath: **five** declare channel names — tasks, elicitation, knobs, live, tool-executor — and **all five** had the gap. All five now re-export the names plus the frame/name types a client consumer folds. Server-side helpers stay off the client barrels on purpose: `toWireDescriptor` and `knobPointer` operate on the server's live `KnobDescriptor` and generate patches; the client only reads. The audit also found `TaskStatusFrame` / `TaskStatusSnapshotFrame` reachable from NEITHER barrel — only by deep import into `src/channel.js` — so the root barrel now carries them too, in parity with elicitation's and knobs' (a workspace typecheck caught a consumer already reaching for them). Packages with a `/client` subpath and no channel constants (completions, gates, prompts, resources, skills, state, timeline, transport\*) have nothing to fix — timeline's client is `fold(session event stream)`, not a channel.

Verified by `packages/app/src/__tests__/tasks-elicit.spec.tsx` (the elicit round trip, `canDoForm() === true`, and the detached law, all through real `createApp`) and `packages/spec-conformance/src/__tests__/client-entry-channel-names.spec.ts` — a filesystem-driven anti-rot sweep in the same family as the browser-safety walk: it reads each package's `export const *_CHANNEL` declarations, imports the `/client` barrel by absolute path (so `spec-conformance` needs no dependency on what it sweeps), and fails naming the missing constants. A new harness package is covered the moment it exists. Both suites were confirmed non-vacuous by reverting the fix under them.

**2026-08-01 — `providerOptions` at the factory, on all four adapters.** Reported as a Google problem (enabling `thinkingConfig` meant restating a whole `ExecutionTarget` or authoring a `<model>` element) and it generalized exactly: NO adapter had a factory-level bag. The audit found the other three layers already uniform, which is the useful half of the finding — `ExecutionTarget.providerOptions` is read by all four (`mergeProviderOptions(target, input)` in each `buildParams`), `defaultProject` folds `tree.providerOptions` over `target.providerOptions` for the three that use it and Anthropic's custom `project` does the same fold itself, and both the streaming and non-streaming paths share one `prepareRequest`, so there is no send/stream drift of the class that bit usage normalization. The gap was one layer wide.

Fixed as the `rates` precedent, deliberately: a flat `providerOptions` option folded onto the adapter's own resolved target at construction. That placement is the whole design — `app.target` is `modelExecutor.target` and the ADR 56 per-tick cascade carries `{modelExecutor, target}`, so landing on the target means the bag rides a per-tick `<Model>` swap and reaches `generate()` with zero new plumbing, and `buildParams` needed no change at all. Precedence, per provider namespace, one level deep, more specific winning key by key: `<model providerOptions>` (tree) > factory > `options.target`'s own bag; a per-call `SendInput.target` replaces the target outright, bag included. **No new merge helper** — `mergeProviderOptions` in spec is already the single canonical statement of the rule and now has four more call sites rather than a second overlapping construction-time helper; the right home for one would be `@agentick/model` (blocked this pass) and NOT spec, which stays observation-only for construction types. The bag stays opaque: nothing in it is read or validated.

**Two things the audit found and did NOT fix, both design questions rather than defects.** (1) `SendInput` has `target` but no `providerOptions`, so a per-send knob costs a full target restatement — the same ergonomic complaint one layer down, and the fix is not obvious (a per-send bag has to fold against a target the send may also be replacing). (2) `aisdk()` is missing `stream` / `streamByDefault`, `parseThinkTags` and `customBlocks`, which the other three all carry — the streaming default is the load-bearing one. Also noted, unfixed: `model-anthropic`'s own docblock advertises `service_tier` on `providerOptions.anthropic`, which the pinned SDK's `MessageCreateParams` does not have (caught by strict tsc on a test fixture).

Verified by 16 new cases, four per adapter, each driving the real executor against the stub client / `MockLanguageModelV2`: the factory bag reaching the provider request non-streaming, the same on the streaming path, folding over an explicit `target`'s bag (factory wins the contested key, the target's other keys survive), and a tree-declared bag winning over the factory. `packages/model-{anthropic,openai,google,ai-sdk}/src/__tests__/*-executor.spec.ts`. 343 green across the four packages; all four typecheck clean under `tsconfig.json` (tests included). READMEs carry the option row, the precedence table and a worked thinking-config example each.

**2026-07-31 — teardown owns the detach: `BaseHarness.close` is a template method, `teardown()` is the hook.** Production regression at next.53, on resume: `RoutingFailed: inbox routing failed: Error: address already registered: tasks:<sessionId>:tasks`. ROOT CAUSE is not in tasks and not from next.53 — it is a defect in the base contract that every concrete harness inherited. `BaseHarness.close()` releases the inbox address (`inboxUnsubscribe`), and all five overriding harnesses (tasks, live, mcp-client, credentials, elicitation) ran their own failable work FIRST and reached `await super.close()` only as the last line. So one rejection anywhere in that prelude skipped the detach and the address stayed claimed for the life of the process. For tasks the prelude is `await Promise.all(pending)` over the close cancel cascade (`harness.ts:968`), which reaches an ADOPTER-supplied `TaskExecutor.cancel` — a dead child process, an EPIPE on the IPC write. Nothing above ever saw it: `SessionHarness.closeBody` closes each bridge with `.catch(() => undefined)` and `AppHarness.disposeSession` try/catches the close AFTER it has already dropped the registry entry, so the session vanished from the registry with its tasks address still held, and the next create-or-resume of that id built a fresh `TasksHarness` onto the collision. That it named `tasks:` and not `elicitation:` (constructed first, same session) is the proof it was tasks' own close rejecting rather than a whole-session teardown skip. Second, independent producer found while pinning it: `createSessionBody` constructs the per-session sub-harnesses ~500 lines before `registry.set`, so a create that threw in between (a session extension whose install rejects, a hydrator that throws) orphaned live harnesses holding addresses nothing could ever close — and the retry did NOT fail cleanly, because a colliding registration rejects the harness's `ready`, not `createSession`, surfacing as an unhandled `RoutingFailed` while handing the caller a session whose tasks harness is unaddressable. Both make the FIRST failure permanent for that id and report the wrong error forever.

**The fix is the template method, not five patches.** `close()` is now final in contract: run `teardown()` (the new protected hook — the subclass's own shutdown work), then detach from the interceptor parent, then detach from the inbox, then unwind `onClose` LIFO — each step isolated, and the teardown failure re-thrown after the unwind so isolation is not silence. It also awaits `ready` before detaching, closing a real second leak: `inboxUnsubscribe` is assigned in a `.then()` off the registration Effect, so a close that raced construction found the slot empty and leaked the address with nothing alive to release it. All five overrides became `teardown()`; the two op-wrapping harnesses (`session:command:close`, `live:command:close`) keep their `close()` envelope with a body that calls `super.close()` and their work moved into `teardown()`. Tasks' cascade additionally went `Promise.all` → `allSettled` so a failing executor cancel cannot skip the ttl-reaper sweep beside it. App side: construction records what it claims and releases it LIFO on abort. **Deliberately NOT done — making `LocalInbox.register` re-register over a stale address.** The duplicate check is a correctness guard, not an inconvenience: two live harnesses at one address means messages silently route to one of them, which for a tasks harness answering `tasks-get` on the wrong session is far worse than a loud failure. The inbox holds a handler closure and no liveness signal, so it cannot prove the prior registrant is dead — and it demonstrably is not always dead, since `disposeSession` drops the registry entry BEFORE close completes. Silent re-registration converts a diagnosable leak into an undiagnosable misroute. Verified by `packages/runtime/src/__tests__/close-teardown.spec.ts` (6 — the base contract), `packages/tasks/src/__tests__/close-teardown.spec.ts` (6 — the real harness, each failure mode), `packages/app/src/__tests__/session-address-reuse.spec.tsx` (9 — every disposal path and the full resume cycle). 12 of the 15 are red on the pre-fix tree. Full suite 6130 green; workspace typecheck 104/105 (the one failure is the pre-existing untracked model spec).

**2026-07-31 — session enumeration: the CURSOR-OWNERSHIP rule, `SessionStore.page`, and the gateway-index pattern.** Landed as `app/list_sessions` (paged, caller-scoped) + `gateway/list_sessions` (cross-app), but the durable part is the principle underneath, which generalizes past sessions.

**The rule: the cursor belongs to whoever owns the ORDERING.** The framework defines only the ENVELOPE (`{cursor?, limit}` in, `{items, nextCursor?}` out — `PageRequest` / `CursorPage<T>` in `spec/protocol/paging.ts`) and ships the obligations as CONFORMANCE TESTS the adopter's implementation must pass, never as framework code that would have to understand the token to enforce them. Every case resolves off that one rule: a store implementing the optional cursored read owns its order, so it mints the token and the framework hands it back untouched; a store without one hands over a snapshot, so the framework must impose an order to page it at all and therefore mints; a MERGER over N independently-ordered sources owns the merged order by necessity and mints the merged token. Deliberately NOT applied to `timeline/history` — the framework owns that ordering (store-assigned monotonic `seq`), so the same rule resolves the other way and seq stays.

**`SessionStore.page?()` — optional, `TimelineStore.history`'s precedent exactly.** `list()` stays the bounded snapshot; `page` is the capability, detected by presence and degraded around when absent (`app.pageSessions` falls back to snapshot+sort+cut). Two obligations, both in `runSessionStoreConformance` (6 new cases, all green against the bundled store): rows in `compareSessionRecords` order, and a walk that skips no settled row and repeats none under writes interleaved BETWEEN pages. The order is the ONE thing the framework does dictate at the store, and not as presentation policy — when no gateway index is mounted, N of these stores get MERGED, and a merge needs an order every source agrees on. An adopter wanting product ordering (pinned first, unread first) mounts a `SessionIndex`, whose output nothing merges. My keyset became the DEFAULT (`sessionKeysetPage` in spec, used by `InMemorySessionStore.page` and both framework fallbacks), not the contract. Cursor encoding moved off base64/`Buffer` to a version-tagged delimited string — spec is imported by browser client code and `Buffer` is a Node global.

**`SessionStoreQuery.principal` — forced by store-side paging, and it is a finding not a preference.** Once the store cuts the page, ANY filter the store does not know about must be applied after the cut, which returns pages shortened by rows the caller was never allowed to see plus a `nextCursor` pointing past discarded rows. Scoping has to be inside the query or paging and scoping cannot both be correct. Semantics are `= ? OR IS NULL` (owned-by-me or owned-by-nobody), NOT strict equality — the ADR 48 posture that an unstamped record asserts no ownership is the framework's, and moving a filter into the store must not quietly change it; `destroy_session`'s handlers apply the identical rule to a named record, so the two verbs cannot disagree. `metadata` is the one dimension no store query expresses, so a metadata filter FORCES the snapshot path (documented, tested) rather than returning short pages.

**Gateway indexes — the pattern, with sessions as tenant one.** `GatewayHarnessOptions.sessionIndex` is an optional adopter-provided cross-app query door (`SessionIndex` in `spec/protocol/gateway-index.ts`); mounted → one query per page, the index's ordering, the index's cursor, gateway adds nothing (not even a re-sort — that would override the ordering policy that is the index's to set). Absent → k-way merge over the apps' stores with the framework's canonical order and default keyset. The framework CANNOT choose for you: it does not know whether two apps share a backend, and an app on Postgres beside one in memory cannot be served by one query. Cited precedent is ADR 68's lift of the task store from session to app scope — this is the same lift one scope further up, and `gateway/list_tasks` is the anticipated second tenant (a `taskIndex` slot beside this one, no renames; NOT built).

**DEVIATION from the ruling, flagged.** The fallback merge does NOT carry "an opaque bag of per-app tokens" — that design does not survive contact with opaque cursors and would be subtly broken. A merged page of 50 rows may draw 48 from app A and 2 from app B; resuming requires recording that 2 rows of B's stream were consumed, but B's token is opaque and advances a whole page at a time with no rewind, so the next request either re-serves B's other 46 fetched rows or skips them. Recording a per-app POSITION instead needs a key the framework can compare — at which point the bag is exactly equivalent to one merged key (the session sort key is total across apps) and strictly more machinery. So the fallback mints ONE framework keyset over the merged snapshot. Same opacity to the caller; honest about who owns the order. Reasoning written into `gateway-index.ts` so nobody re-derives it.

**Also:** `AppHandle.listSessions` / `GatewayHandle.listSessions` return the PAGE, not a bare array (breaking — a reply handing back only rows leaves the caller no way to ask for the rest). Topology: nothing built, and that is the finding — `app:command:create-session`, `app:command:destroy-session` and `session:command:close` all land on the app bus already (pinned by existing tests), so enumeration + the existing events IS the collection contract; a bespoke `session.added` would be a second channel for a signal already on the wire. 18 wire tests + 6 conformance obligations; full suite 5992 green; workspace typecheck clean but for the pre-existing untracked model spec. Deliberately not done: no `updatedAfter` / `appId` added to the wire `SessionFilter` (inventing query surface, not passing it through); no `limit` ceiling (the verb was unbounded before); no shipped `SessionIndex` test double under a `/testing` subpath (one tenant, doubles are test-local until a second needs them); `pnpm-lock.yaml` untouched, so the transport test's store doubles are standalone rather than extending `InMemorySessionStore` (which would have needed a new workspace dep).

**2026-07-31 — `app/destroy_session`: the strongest-form, TRANSITIVE session removal.** `close()` was the only removal verb, and it is deliberately gentle — the thread ends, the durable `SessionRecord` survives as history, and DETACHED tasks keep running (ADR 68). Nothing in the API deleted a thread. `AppHarnessProtocol.destroySession(sessionId, { reason? })` is the other end of that pair, landed as its own op (`app:command:destroy-session`, mints `onBefore/AfterAppDestroySession`) rather than a flag on close, precisely so a guard can veto DELETION without also vetoing hangup. Order is the design, each step because the one before it cannot do the job: (1) abort in-flight executions across the live spawn subtree deepest-first — `session.abort()` reaches only that session's own current handle, and a spawned child feels the parent's construction signal but its RUNNING execution is not cancelled by it; (2) cancel DETACHED tasks while the sessions are still live, because a detached task's only in-process handle is its owning session's task harness, which step 3 closes; (3) dispose the subtree through the same `disposeSession("close")` a genuine session end uses (promoted, not duplicated); (4) `SessionStore.delete(sessionId)`. The subtree is walked off the registry's `parentSessionId` edge (`SessionHarness._children` is private, and the registry edge also finds a descendant whose intermediate ancestor was evicted). Result type is normalized to facts held AT ACT TIME and nothing more: `{ sessionId, live: { found, abortedExecutions, disposedDescendants, cancelledDetachedTasks }, record: { existed } }` — deliberately NO `deleted` flag, because `SessionStore.delete` returns void and what deletion MEANS (soft flag / hard row / cascade) is the store impl's contract, not a claim this result can make. Idempotent: an unknown id is `{ found: false, existed: false }`, silence not a fault. Descendant RECORDS are not deleted — a cascade is the store's policy (a SQL `ON DELETE CASCADE` is exactly where it belongs). Wire: `app/destroy_session` on `appWireExtension`, journaled at the default disposition. TWO ownership gates, because one is structurally insufficient: the dispatch gate resolves the target from `params.sessionId` and applies the same-principal rule, but it resolves through the LIVE registry — and destroy's whole point is that it also reaches a paged-out / closed session, for which the gate sees no target while the durable record still names its owner, so the handler re-checks `record.principal` against `ctx.principal`. Client: `AppHandle.destroySession` hand-written alongside its `app/*` neighbors — the wire-row derivation (`makeWireNamespace`) covers the SESSION namespace only, and an app-namespace verb takes `appId` from the handle rather than a `sessionId` from the caller, which is not a shape that derivation covers. RIDER (tasks): `TasksHarness.close()` now sweeps `clearTtl` alongside the eventBus drain for every task it stops serving, making explicit the invariant that only `settle` enforced implicitly — with the deliberate exception that a still-running DETACHED task KEEPS its deadline, since disarming the reaper at close would hand it an unbounded lifetime, a worse leak than the timer. `isTerminalTaskStatus` lifted to `@agentick/spec/guards` (three copies collapsed: tasks harness, child executor, app). Verified by `packages/app/src/__tests__/destroy-session.spec.tsx` (5), `packages/transport/src/__tests__/app-destroy-session.spec.ts` (3), `packages/tasks/src/__tests__/store.spec.ts` (+2). Found in passing and NOT fixed (out of destroy's scope, marked `TODO(session-direct-close-registry)` at `AppHarness.getSession`): a session closed DIRECTLY keeps its live registry entry — only `disposeSession` removes it — so `getSession` can return a closed harness and the LRU cap counts a session that is gone. Also open: `TODO(tasks-detached-orphans)` — a detached task whose owning session already closed has no in-process handle the app can cancel through, so destroy cannot reap it.

**2026-07-31 — `gateway/destroy_session`: the same verb, addressed without an app.** A client that listed threads across apps holds session ids, not app ids, so requiring `appId` to delete one forces it to carry an app id purely as ceremony. `GatewayHarnessProtocol` grows two members: `appForSession(sessionId)` — gateway-level ADDRESS RESOLUTION, live registries first (cheap sync read) then the apps' session stores in parallel (a store that throws answers "not mine" rather than failing the lookup), which is what makes the resolution honest for a paged-out or closed session — and `destroySession(sessionId, opts?)`, pure resolution + delegation to the owning app's verb. Result is `GatewayDestroySessionResult extends DestroySessionResult` with the resolved `appId`; absent on the idempotent miss, because there is no app to name. NOT wrapped in a gateway op: the destruction it delegates to is already `app:command:destroy-session`, and wrapping would mint a second envelope for one destruction (the same reasoning `session.abort` records); the wire boundary journals the call itself at the default disposition. Ownership gated the same two ways, with the store-resolution path making the handler's record check load-bearing rather than belt-and-braces. **A type-level test caught a real design leak**: `SessionWireNamespace` derived session sub-namespaces as "rows carrying `sessionId` and no `appId`", and a `gateway/*` row naming a session satisfies that — so `gateway/destroy_session` would have surfaced on the client as `session.gateway.destroy_session`, exactly reversing what the verb is for. The `appId` guard was always an ad-hoc spelling of "app-addressed"; the gateway is the runtime ROOT and has no `gatewayId` param to guard on. Fixed by naming the RESOURCE-HANDLE namespaces explicitly: `Exclude<…, "session" | "gateway">`, with `wire-proxy.type.spec.ts` carrying the reason so a regression on the gateway arm reads as what it is. Client: `GatewayHandle.destroySession`. Verified by `packages/transport/src/__tests__/destroy-session-wire.spec.ts` (6 total — 3 new: multi-app resolution with a decoy on the first app, store-resolved principal rejection, unclaimed-id idempotency). NOT built in this pass, deliberately: `gateway/list_sessions` — cursor pagination + presentation meta is its own slice with its own doc.

**2026-07-30 — elicit asks carry their real shape (`11fa1c4e`, closes #266).** Every sugar-built elicit projected the degenerate `{type:"object"}` to the client (validate-only StandardSchemas hit `toJsonSchema`'s fallback at `elicitation/harness.ts:279`) — no client could render a typed field for an in-process ask, and `select`/`multiSelect` `labels` were silently dropped. Fixed by construction, not by converter registration: the flat-property builders (`textProp`…`multiEnumProp`, `flatObjectSchema`) lifted from the MCP projection into `@agentick/elicitation` (`flat-props.ts`) as the vocabulary's single construction site; the sugar attaches each shape via the `jsonSchema(shape, {validator})` raw marker with validation semantics unchanged; `labels`→`enumNames` + defaults now serialize on the in-process path; MCP imports the shared builders (existing dep edge). Ruling: in-process schemas are **value-level** (the accept path validates the bare submitted value — the published schema must describe exactly what the client submits); MCP keeps its object wrapping at its own wire. Pinned by `elicit-sugar-schema.spec.ts` (16). Companion workshop draft: `docs/proposals/v2/arg-shape.md` — a derived, wire-safe `shape` field on `PromptArgumentRecord` sharing this vocabulary, so composer slots and dock fields can render typed controls (selects/number/date) for prompt args; open ⁇s recorded there. Knowify consumer work (dock typed controls + completion parity, incl. value-level single-field ask cards) in flight on the app side.

**Last updated:** 2026-07-28 — **MEDIA FIDELITY (next.36, breaking): `image` carries a `MediaSource`; targets declare what they can carry; declines are reported.** THE BUG: `image` carried `imageUrl: string` while its three siblings carried `MediaSource`, so a source with no lexical form was destroyed upstream of every adapter — an adopter `{ type: "reference", fileId }` became the bare id and Vertex rejected it deterministically, against a durable timeline entry, so every later turn resent it and the thread was permanently unusable. Four flatten/re-parse functions deleted, not fixed (`imageUrlFromSource` had no honest `reference` arm: a `string` return cannot express "I cannot represent this").

**`MediaSource` is three closed kinds** (`base64` | `url` | `reference`). `s3`/`gcs` deleted — Ryan spotted them as Knowify concerns leaked into the canonical vocabulary, and verification confirmed every framework use was string recomposition (`gs://${bucket}/${object}` → fileUri), so an app decomposed a URI purely so we could reassemble it. No closure either: R2, Azure, MinIO, IPFS, `file:` were equally entitled. It simplified the CONSUMER too — Ernesto's resolver was parsing a URI for a variant the adapter reassembled; `parseGcsUri` is gone. The one real loss (distinguishing "Gemini fetches gs://" from "Anthropic does not") returned as `capabilities.media.urlSchemes`, which is what those variants were actually encoding and covers every scheme rather than two. Related ruling: **augment pass-through slots, never interpreted vocabularies** — `ProviderOptions` is opaque to us so it augments; `MediaSource` is read by every adapter, so a custom variant would hit `default` in all four and buy a type nothing can consume.

**Targets declare, the framework enforces.** `capabilities.media` per modality; absent = undeclared (nothing screened), present = complete. Enforced in `screenMedia`, between the hook cascade and `prepareRequest` — placement found by TWO bugs the tests caught, both silent-success: inside `defaultProject` it was bypassed by Anthropic's custom `project`; in `projectImpl` it ran BEFORE `onBeforeModelGenerate` and would have eaten Ernesto's `reference` images before its resolver could fix them, with nothing failing. Checked rather than trusted: `runMediaDeclarationCheck` (`@agentick/model/testing`) asserts each declaration against the real wire projection both directions, driving `prepareRequest` directly so it is not tautological.

**New surface, and the criterion that bounded it.** Ryan's question — how much belongs in the application, given the app owns the projection — produced the filter: _does this require knowledge or access only the framework has?_ Three functions survive it: `buildMessageProvenance` (the projection walk), `applyMediaSupport` (the declaration + an unbypassable pipeline position), `detectDroppedInputs` (`prepareRequest`, an adapter internal). Plus `boundary.target` — one field, because only the executor knows which target accepted a turn. Everything else was cut: `ddmin` and its tests DELETED (~940 LOC — an array and a predicate needs nothing privileged), and with them `originsWhere`, `originOf`, `dropOrigins` (`dropOrigins` was the incoherent one: a helper for a search removed on principle). The knowledge those encoded moved into `MessageProvenance`'s docs — dedupe by identity (a `(entryId, blockIndex)` key collides across id-less entries) and index the unfiltered projection. **The arc removed more public surface than it added.**

**`detectDroppedInputs` is the general answer.** `prepareRequest` is pure and does no I/O (verified: every `createSourceInterner` lives in `normalizeImpl`), so removing one canonical input and deep-comparing the native request detects a silent discard with zero network and zero adapter cooperation. It found all four documented-only drops immediately — anthropic `audio`/`video`/**`responseFormat`**, openai `video`/reasoning, google reasoning — each now a characterization test so a fix cannot land silently. It also DELETED the three hand-written `carries` predicates. Complementary to the declaration, not redundant: detection is blind to an input carried in a form the provider rejects (the original bug), which is what the declaration covers.

**Declines are reported**, in the form the Vercel lens suggested rather than as a stream event nobody consumes: one `ctx.log.warning` per declined part with coordinates that join provenance to an entry id. Zero new API, happy path silent.

**Two corrections to my own claims.** "Probing is side-effect free" was half true — the provider commits nothing on a rejection, but an executor probe journals, emits bus deltas and fires hooks, so subscribers would see a search as real turns. And a proposed "failure classifier" was dropped entirely: its inputs would be the error, the request, the app's cost tolerance and the app's knowledge of its own sources — strip the two we don't own and what remains is error taxonomy we already ship. A new entity invented out of existing facts.

**Ryan's regression-range insight**, which reframed everything: a `succeeded` boundary proves every entry it carried was projectable, so the suspects after a failure are the entries appended since the last comparable success — the `git bisect` RANGE, which I had been trying to bisect without. Investigation: the record already exists (`endTurn`), ordering gives the window, `isInputEntry` classifies — a ~10-line fold over data the app owns, so it stays there. Two findings fixed: the spec docblock claimed a committed-offset fold that does not exist (claim removed, not implemented), and the boundary carried no target identity, so a failover silently invalidated the watermark. Established: the watermark is sound enough to NARROW A SEARCH, not to justify a durable verdict (no projection version exists, so deploys invalidate it).

**The doctrine, and what it decided:** the framework's contract on failure is **LEGIBILITY, NOT REMEDIATION**. Repair needs to know what in a store is durable vs derived, whether mutation is permitted, what quarantine means there, and how many requests a diagnosis is worth — none of which we own. _"We don't care where the data is stored or in what format so long as we get what we need to run"_, so the append-only two-tier timeline is **promoted and facilitated, not enforced**. Also: `buildMessageProvenance` is correct ONLY for `buildMessages`' walk — an adapter with its own `project` or an app filtering via `<Timeline>` projects differently, and the alignment guard catches a LENGTH mismatch but not a semantic one. Reframed as a contract (_if you project, emit origins_) with this module as the conforming implementation.

**Ernesto (nx-knowify, uncommitted):** `noteUnprojectableMedia` substitutes a plain note for what stayed unprojectable, so the model is told instead of silently handed a hole — it was answering confidently about files it never received. Wording is the app's voice deliberately (the framework's own reason names the vendor and would have the model explain our infrastructure to a customer). Projection, never a write, so a later fix is retroactive with no migration. Building it first also surfaced two facts an ADR would have got wrong, and validated the pattern worth documenting: **the framework screens and reports; the application decides and speaks.**

**Gates:** agentick 5604 passing / 583 files, workspace typecheck clean, 0 lint errors, oxfmt clean, changesets well-formed. nx-knowify: 4/4 consumers typecheck (strict, specs included), 207 + 104 + 65 green, and an end-to-end probe against Ernesto's real Vertex config confirms the fix — resolved `gs://` survives, an unresolved `reference` is declined with a readable reason, **the fileId appears nowhere in the request**, the user's text survives, `mediaHooks` still gets first refusal. **Open:** no blueprint ADR for the disclosure invariant or the target-declared-capability contract; board not moved; nothing committed in either repo; `TODO(decline-reporting)` client surface (the user is still not told); `TODO(removal-lattice)`; the four adapter silent drops remain drops.

**Last updated (prior):** 2026-07-27 (11th) — **SECURITY: caller credentials no longer journaled (next.17) + createApp({skills,prompts}) LIVE (next.16) + Knowify parity slice judged (uncommitted, awaiting Ryan).** THE LEAK (d1e54cbc, breaking): `toIngressIdentity` spread the WHOLE authenticated user record onto `IngressIdentity.user`, which rides EventScope on every MCP crossing — and call-tool/initialize are PERSISTED classes — so an authenticator hanging a bearer token off the record (the common shape; tool handlers need it) wrote a LIVE CREDENTIAL INTO THE DURABLE JOURNAL on every tool call, contradicting the function's own "never the credential itself" docblock and the ADR 92 redaction law. Found by the Ernesto parity agent (which built on it deliberately + left a tripwire test rather than silently using it). Red-first: 8/9 assertions failed with the token in the serialized journal AND bus at BOTH stamp sites (pre-gated initialize + per-request crossing). FIX PART 1 — structural, not a scrub: the default projection iterates a literal tuple of the four fields `McpAuthenticatedUser` DECLARES (id/displayName/roles/scopes) and cannot read a key it does not name, so the adopter's open bag (tokens, PII) is never copied; `email` dropped too (the framework cannot tell `token` from `tenantId`). Ryan's requested seam: `identityProjection` on McpServerOptions — return becomes identity.user verbatim, undefined omits it, principal/scopes stay framework-derived; a hook that copies the token is the ADOPTER's leak (pinned both ways). `TODO(identity-projection-home)` records the open question of moving it onto the authentication component (unifying with the transport edge, where AuthSource's RETURN IS the stamp — verified at spec/wire/authorizer.ts:175) with the three reasons it sits on config for now. Ryan ruled AGAINST routing the token through @agentick/credentials (that's a durable store for outbound secrets; a per-request credential has no storage lifecycle). FIX PART 2 (my hands — the agent proved it fence-blocked and STOPPED correctly): trunk keys are copied onto child ops' EventScope wholesale by `inheritScope` (no allowlist — verified), so the credential CANNOT ride the trunk; new `BoundaryFacetsRef`/`withBoundaryFacets` in @agentick/runtime is an in-fiber channel `currentOperationCtx` folds in via deriveContext's EXTRAS and `inheritScope` never reads. Landmine I hit: publish must happen OUTSIDE the runtime capture — the starved seams run on the captured runtime via onFiber, not the crossing fiber (red test caught it). `ctx.mcp.user` now reaches EVERY handler seam incl. PromptDeclaration.render + resource resolvers → **ADR 91 stop-rule #2 fully CLOSED**. Proof: one test drives all five crossings, asserts the facet IS read, then asserts neither serialized bus nor journal holds the credential, with non-vacuity guards. next.16 (62a71678/3036c50e): `createApp({ skills, prompts })` lit — D3 shipped the toExtension arms but the app never invoked them (slot value typed, forwarded to SessionDefaults, dropped). Override semantics CORRECTED red-first: "install both, last-writer-wins" is impossible — a second namespace install is a loud inbox address collision by design; the mechanism is SUPPRESSION at the mint site (same extension name ⇒ slot mint skipped). D3's own late report (arrived post-landing, tree-judge confirmed) disclosed this hole. KNOWIFY PARITY (uncommitted, judged, awaiting Ryan's authorization): bump next.9→next.14 across 3 manifests; gap #1 Apps negotiation CLOSED with v1's PRESENCE rule (advertise iff the environment-filtered app set is non-empty); gap #5 me/company CLOSED — the brief's premise was wrong, v1 formats the authenticator-resolved profile rather than querying, and the agent corrected it; gap #3 pre-resolution + DB completions CLOSED except the elicit residual (no elicit facet on render ctx — recorded partial, NOT faked); schema gating closed; found a latent wrong-major import (types resolving to hoisted v1 0.15.3 through a phantom subpath, invisible because the lib never typechecked its specs — added the nx typecheck target). ERNESTO FILE GRAMMAR proposed (four laws: a config key is a file whose default export is its value; collection namespaces are directories + a one-line slot file; composition is explicit imports, no loader magic; the lib is pure, the host binds ports) — awaiting Ryan's go. Gates: full suite 5396/0, forced typecheck 103/103 ×3 today. NEXT: Ryan authorizes nx-knowify commits → Knowify coordinated pass onto next.17 (ports.ts drops the leaky path for ctx.mcp.user at every seam; the tripwire test flips) → file-grammar slice → content-surface restoration → D4. OPEN: push auth (rlindgren lacks perms; agenticklabs switch rejected), staged-only pre-commit hook (favorable, unauthorized), ADR 94 timeline-vs-sections.

**Last updated (prior):** 2026-07-27 (10th) — **ADR 93 D3 LANDED (defineSkills/definePrompts — source unification) + HYGIENE-2 (7 verified defects red-first) + BATCH-6 READMEs + FOLLOW-UPS SLICE — published as next.15 (six commits 685b70e3→273fbad1).** FOLLOW-UPS (685b70e3, breaking): the starved `ExecutionEvent` seam FED — loop emits the run-level `kind: "execution"` summary (output/run-usage/stopReason/durationMs) after execution-end, session forwards `type: "execution"` (declared in spec, produced by nothing until now; failed runs emit no summary as failed ticks emit no `tick`); `session/timeline_history` porcelain DELETED (handler + spec WireMethods row + SessionTimelineHistory\* types; the never-populated `Entry.cursor` co-location affordance dies with it) — `timeline/history` is the ONE wire door, bounded-tool-output HINT repointed; the three deps? factory twins (loop-executor/tool-executor/session-harness) widened optional with dep-less construction tests each — 5/5 factories consistent. HYGIENE-2 (628bc438): H1–H3/Paragraph SILENTLY DROPPED heading semantics (emitted unclaimed `heading`/`paragraph` intrinsics; red: 'Title' where '# Title'); wrappers now emit claimed h1–h3/p, workspace-swept sole offender; guard() bags contextually type without `as const` (overload pair → one union signature); `formatter-unresolved` warning diagnostic (once per distinct ref, degrade-don't-throw; id-miss→format-hint stays silent BY DESIGN; new shared resolveFormatterRef/describeUnresolvedFormatter; mount binds the REAL default ref not the `{id:"default"}` sentinel); defineSession noop model handle read THREW on the documented model-less path → reads undefined, writes reject; first direct ulid/waitFor/waitForStable suites; spec barrel's false "zero runtime dependencies" + eval's shipped-features-as-future both rewritten. AUDIENCE RULING (410bdea6, Ryan): section-level `audience` is DEAD — always model; v1 over-engineering for client-rendered JSX we're not doing; entry `visibility` + tool `exposure` are the mechanisms; CLAUDE.md example/row + semantic-html comment fixed (memory: project_audience_always_model). D3 (2373ba8d, tree-judged — implementer never reported, pattern now 3-for-4): defineSkills/definePrompts per the D1 template; source unification (moot #3: parallel source-config vocabulary DELETED → hydrateFromDirectory/composeHydrators/literal; node-only loader split to hydrators-node; `./loaders`→`./hydrators` subpath); prompts gains store? (moot #4); genesis laws ×2 namespaces with typed SkillsHydrateFailed/PromptsHydrateFailed; createApp({skills,prompts}) slots; runtime slot-registry multi-slot + spec. BATCH-6 (dd10e9ff): cluster×5 + mcp-main READMEs (mcp cut to a third); 155-site `-next` sweep across 85 files + 5 runtime-visible stale strings fixed by hand; residue = lint pragmas only. Gates at release: full suite 5377/0 (+111 over next.14), forced typecheck 103/103 ×2, all agent suites re-verified by the judge. PROCESS: silent-idle-no-report is now the NORM (D2b, D3, batch-6; hygiene-2 reported only after nudge) — tree-judging is the standing fallback; pre-commit workspace-wide lint held commits hostage to in-flight agent WIP twice (classifier blocked --no-verify; staged-only hook proposed to Ryan, favorable, NOT yet authorized). ERNESTO: parity slice IN FLIGHT on nx-knowify (bump next.9→next.14 + close ledger gaps #1 Apps negotiation / #3 ctx prompts+completions / #5 me/company identity + schema gating). DESIGN WORKSHOP OPEN (Ryan, do-not-build): timeline-vs-sections re-vision — sections always inside System; Timeline IS the message array (JSX order = wire order); ephemeral = projection-only entries rendered into the timeline absent from the record; placement is declaration (no position props — token stream has no second axis; CSS flow/display map, positioning does NOT; record as explicit anchor child); per-tick render-window record = the missing provenance fact; candidate ADR 94. NEXT: judge+land Ernesto parity (Ryan authorizes nx-knowify commits) → Ernesto file-grammar on next.15 → content-surface restoration slice (Text/Code/Image/Audio/Video wrappers; Ephemeral as Timeline-child pending workshop; Grounding dissolved) → CLAUDE.md table rewrite → D4.

**Last updated (prior):** 2026-07-27 (9th) — **ADR 93 D2 LANDED (timeline:history — the client read door) + HYGIENE SLICE (cancellation parity, ratified) + batch-5 READMEs (root capstone) — published as next.14.** D2 (4396d16b): `timeline:history` is a DECLARED wire-exposed command — dynamic-lane projection as `timeline/history`, the existing two-step admission (deny-by-default exposure → grant on the verb's own scope label → same-principal target rule, a `*` grant still loses), seq-cursored page with `nextFromSeq` iff capped (`lastSeq+1`, sparse-safe lower bound, the reply carries its next action); reads minted as a JOURNALING CLASS (`timeline:command:history` bus-only by default, adopter `policy` layers per-key via mergeLayered); in-process `history()` runs the SAME command body (hooks/guards on both paths; guard veto = the row-level retention seam, tested); loud-fail on a store with no cursored read; client `session.timeline.history()` = raw stateless page (Posture B) + `loadOlder()` = cursor-tracking splice sugar, both over the ONE door; wire rows moved to type-only `wire-augment.ts` (ambient-shadow trap documented in-file) so the browser subpath types the door without server-bridge augmentations; old `session/timeline_history` porcelain superseded with deletion TODO (spec rows out of D2's additive fence); e2e over transport-in-process incl. cross-principal denial under `*` grants on both sides. D2's implementer never sent its report — tree-judged like D1. HYGIENE (960a270a, BREAKING): every abort path now lands `outcome: "canceled"` — a caller `signal` abort reported `succeeded` before; keyed off abort-derived stopReason so a post-completion abort never relabels finished work; session-side a canceled terminal WITH a result now RESOLVES `send()` with `stopReason: "aborted"` (what session/README.md:91 always promised — the implementer found the corroboration after choosing the fix) instead of rejecting, only a result-less terminal rejects; 3 PA1/SP6 acceptance tests cured by the session fix, NOT rewritten. Riding: derived-promise sweep (4 leaks fixed — BaseHarness `ready` on EVERY harness, harness-protocol abort chain, session settle path netted idempotently, sync knob `set` marked-handled + TODO(phase-3) emitLog; 4 safe sites + 1 deliberate non-mark documented in-code); `CompilerFactory.deps` widened optional (ExecutorFactory precedent; 3 twins remain: loop-executor/tool-executor/session-harness protocol types — queued) + `reactCompiler()` dep-less fallback + new factory.spec.tsx; model-executor backward-compat aliases deleted onto ExecutorLifecycle's own API; tasks `_deriveCtx` param documented (a closure cannot cross fork(); child reconstructs from record.scope); docblock sweep 21 stale `-next` sites in-fence (~150 remain workspace-wide, heaviest cluster-_/sandbox_/spec — wants its own ticket); starved seam surfaced: spec's `ExecutionEvent` has NO producer (one-line unblock recorded at the loop's emit site as TODO(phase-3)). Batch-5 (a2286bbc): root README capstone + app/session/spec/runtime/utils/compiler-react/connector/eval/formatters/spec-conformance/prompts-react on the house treatment; hygiene's README gap-bullet cures applied at landing (loop-executor abort-asymmetry bullet DELETED — cured; compiler defineCompiler-substrate + missing-exports bullets DELETED). Gates: full suite 5266/0 (64 env-skips), typecheck 103/103, four landing-verify items all green (factory.ts:31 fixed by hygiene in-fence with tests; mcp harness.ts:702 TS2353 transient — gone; child-executor imports clean; timeline README `agentick` import fixed at landing). Published 1.0.0-next.14. NEXT: batch-6 READMEs (cluster×5 + mcp main) → D3 (skills/prompts definitions — definePrompts does NOT exist yet) → D4 → hygiene-2 inventory (guard-bag as-const contextual typing, H1–H3 unclaimed-intrinsics silent drop, defineSession deps?, untested ulid/waitFor, CLAUDE.md semantic-table proposal) → metapackage → Knowify final-parity slice + Ernesto file-grammar. OPEN: push authorization (branch ~250 ahead of origin, single-machine risk).

**Last updated (prior):** 2026-07-27 (8th) — **ADR 93 D1 LANDED (defineTimeline — the definitions proving instance) + TRANSPORT HARDENING (13 findings, test-first) + README fan-out batches 1-4.** D1: defineTimeline/defineTimelineStore (brand = non-enumerable symbol; loud-fail on cursor queries without history); hydrate(ctx) genesis seam with typed ctx.store facet, hydrateFromStore()/hydrateTail(n), the three genesis laws tested (seed-never-append / fork-no-genesis / throwing-hydrator-fails-creation-typed); compact(entries,ctx) sugar; hooks:/guards: bags drop-layer; CASCADE TOTAL at every host tier (app+gateway+session installers thread the interceptor handle — gateway taken along as the recon's identical gap, judged correct though unreported); createApp({timeline}) slot via registerNamespaceSlot side-effect augmentation (spec/protocol/namespace-slots.ts + runtime/substrate/namespace-slots.ts); deletions (initial, rehydrateStrategy/importSnapshot-as-resume); §2.7 bounded projection (in-memory persisted tier GONE). Judge fixed one blemish first-hand: derived \_mountReady rejection escaping unhandled when genesis fails (marked handled; real consumers still observe). D1's implementer never reported — tree-judged. TRANSPORT HARDENING (aa36ee93): DELETE authn; ingress authn wall-clock ceiling (10s default, Infinity opt-out); in-process cancellation actually aborts server work + real connection teardown; sub/unsubscribe RAN-not-forgot cleanups (13th finding, EVERY transport); unix bind-error claiming, NDJSON 16MiB cap, typed connect errors, onFailure seam; binaryFrames honesty; ws blurb de-puffed — every fix red-first with verbatim capture. README batches 1-4: ~35 packages at the house treatment; sweep-found source defects fixed-or-queued per the defect-to-test protocol; preview-breaking leaked tool fragments eradicated. ADR 93 map extended: subscriptions (store-bearing) / live (experimental) / connector (optional-pkg slot); membership rationale = governance+legibility over raw capability; metapackage NEED ratified (post-D-phases). NEXT: next.13 → batch-5 READMEs (app/session/spec/runtime/utils on the new surface) → D2 (timeline:history wire grant + client scroll-back) → D3 (skills/prompts) → hygiene slice (abort-outcome semantics, defineCompiler signature, docblock sweep) → Knowify final-parity slice.

**Last updated (prior):** 2026-07-26 (7th) — **ADR 92 SLICE B LANDED (lifecycle & security mutations) + ADR 93 RATIFIED-AND-AMENDED (namespace definitions) + README fan-out underway.** SLICE B, four promotions, all guard-vetoable: (1) spawn/fork — `session:command:spawn` + `app:command:create-child-session` (a FIFTH op vs the brief, judged correct: FiberRef is invisible across the session→app Promise boundary so parenting threads as DATA via `SpawnContextChildInput.parentOpId` — the Slice A shape; spawn = two real layers = two linked records per the ratified layering law; `app.guard` can now veto a spawn, previously inexpressible); fork = 4 linked records (snapshot/spawn/create-child/restore). (2) `session:command:close` BUS-ONLY (the aspirational `:760` override now load-bearing); idle/LRU eviction routes through it with `reason: "evicted"`; `close(opts?: SessionCloseInput)` additive (Gateway precedent). (3) `live:command:{stop,close}` (close bus-only per the house close-op rule; per-stream stops journal individually); `start` fenced to Family 3 with TODO naming the sync-return blocker. (4) `credentials:command:{set,delete}` under the STRUCTURAL redaction law — the secret is a closure argument, never an op input (`CredentialsMutationInput = {namespace, key}`), so journal/bus/guards/middleware CANNOT observe it (asserted over the FULL journal + bus with fragment checks + non-vacuity guards); deliberately not inbox-addressable. New scope dims: `streamId`, `credentialNamespace`/`credentialKey`. LATENT-HAZARD fix: harnesses using their own augmented scope dims now `import "./augment.js"` directly (deep-reach consumers bypass the barrel; subscriptions had the same bug from Slice A — fixed at landing). Gates: suite 5068→5104 /64 (+36; baseline reconciles exactly: 5050 residuals +18 cap-extensions +36 B); typecheck --force 103/103 (caught 2 spec-drift defects vitest passed); verify:publish + ctx-derivers green. **ADR 93** (blueprint/93 + amendments): defineX definition law (store stays the port; hydrate(ctx) = genesis seam w/ ctx.store facet; guards:/hooks: bags, drop-layer naming, broader-wraps-narrower, guard-outermost; withX(definition|inline|instance) — the definition IS the options; timing law: definitions inert until per-session install; resources fs-as-SOURCE; CLOSED surface with judged-out list; D1 tight spec + gates incl. bounded-memory/fork-no-genesis/seed-not-append/cascade-order proofs; 11 landmines). README fan-out: pilot (tool/timeline/skills) + batch 1 (knobs/state/gates/client-core/client/client-react/model/elicitation/tool-executor done; compiler-react in flight) — compile-checked examples catching real API drift (dead model adapter contract buildParams/call → prepareRequest/send; a ctx.session pattern that never compiled; stale docblocks queued: define-tool-executor.ts, combinators.ts). Standing law: touched READMEs conform to .claude/skills/create-readme. NEXT: publish next.12 → D1 (defineTimeline per ADR 93 spec) → D2 → D3; Knowify: carriage commit split + final parity slice await Ryan.

**Last updated (prior):** 2026-07-26 (6th) — **ADR 92 SLICE A RESIDUALS CLOSED: the Effect-native read face (ADR 91 stop-rule #2 fully closed) + the transport admission-failure event (the second stop-rule).** (1) THE `fx` READ FACE — `ResourcesFx` (`read`/`list`/`listTemplates`) and `PromptsFx` (`render`) declared in spec as `readonly fx` ON THE PROTOCOL (the `ExecutorProtocol.fx` precedent verbatim: on the protocol so a protocol-TYPED ref can compose in-fiber), implemented by the concrete harnesses as `get fx() { return this.fxProxy() as unknown as XFx }` (the knobs precedent — same declared command, no second code path). New `runHarnessProtocolOn(runtime, eff)` beside `runHarnessProtocol` in `harness-protocol.ts`: same `unwrapExit` normalization (so `ResourceNotFound` still arrives as itself and the JSON-RPC frame is unchanged) but on a CAPTURED fiber runtime instead of a fresh root. The MCP crossing now hands its body a third arg — `OnCrossingFiber`, built from the runtime it ALREADY captures for `defineOperationFacets` — and the resources + prompts projections route every harness call through it (`source.fx.read`, `fx.list`, `fx.listTemplates`, `fx.render`). PAYOFF (both PROBED: reverted the projection line, watched the new test fail with `expected undefined to be 'user-42'`, restored): over the wire with a real SDK client, a resource resolver AND a prompt render receive `ctx.identity` = the request's identity, `ctx.mcpConnectionId` = the crossing's connection, `ctx.parentOpId` = the crossing's opId — and the inner `resources:command:read` is a LINKED journal record on the resources bus (layered execution = layered journal records), not an orphaned root. **ADR 91 stop-rule #2 is now CLOSED for every handler seam** (tool handler, completion handler, resource resolver, prompt render); the mcp server README's "Known gap" section is replaced by an "Identity reaches every handler seam" table. Deliberate non-change: the inner command keeps `origin: "host"` — wire origin belongs to the crossing, which already passed admission + the security stages; stamping `wire` would re-submit the read to the wire-exposure grant gate. (2) TRANSPORT ADMISSION-FAILURE EVENT — `gateway:admission:failed` (`GATEWAY_ADMISSION_FAILED` + `IngressAdmissionFailure` in spec; `emitAdmissionFailure?` on `GatewayHarnessProtocol`, optional per the `emitCapabilitiesChanged` convention, implemented on `GatewayHarness`). `authenticateIngress` gains an OPTIONAL third param `onRejected: IngressRejectionReporter` — a callback, not a host ref, so the helper stays a pure function with no bus (the reason the seam was stop-ruled). It reports from the catch and rethrows; each of the three edges supplies `(failure) => gateway.emitAdmissionFailure?.(...)` and enriches with the peer address only IT knows (http/ws `req.socket.remoteAddress`; unix has none). This also fixes a misattribution the callers couldn't: unix + ws `.catch()` blocks cover BOTH authn rejection and `gateway.accept` rejection, so a caller-side emit would have mislabeled a rejected `onBeforeGatewayAccept` as an authn failure. Payload = failure class + connection shape + reason, NEVER headers or credential (asserted). Tests live in `runIngressAuthnConformance` — the law is asserted ONCE and enforced at all three edges (+4 tests × 3): a refused crossing emits exactly one event with the right class + transportKind, the serialized payload contains neither the token nor `Bearer`/`authorization`, an ADMITTED crossing emits none, and the no-AuthSource local pole emits none. New `collectAdmissionFailures(gateway)` in `@agentick/transport/testing`; `admissionFailures()` is REQUIRED on `IngressAuthnServer` so a new transport cannot skip the law. TODO(ADR-92) trailheads left at the http + ws edges: the web-security origin/host refusal is the other admission gate and wants the same visibility (a second `IngressAdmissionFailureClass`). Gates: suite 5031 → 5050 /64 (+19: mcp payoff 2, resources fx 3, prompts fx 2, ingress conformance 12); typecheck 103/103 force-run (0 cached); `verify:publish` green incl. the ctx-derivers gate (1415 files); oxfmt on touched files only; oxlint 5 warnings all pre-existing (mine fixed). READMEs updated: mcp/server (gap → closure table + verification), resources + prompts (`fx` face, when to reach for it vs the facade), transport (the reporter seam + the never-credentials law), gateway (`emitAdmissionFailure` + payload contract). UNCOMMITTED. NEXT: ADR 92 Slice B (spawn/fork, session close, live stop/close, credentials set/delete + redaction law) → Family 3 sync-return design pass.

**Last updated (prior):** 2026-07-26 (5th) — **ADR 92 SLICE A LANDED (the ingress family): MCP request crossings, subscription dispatch, and admission-failure visibility.** (1) MCP CROSSINGS — every SDK `setRequestHandler` crossing plus the accept path now runs through `McpServerHarness.runCrossing` as `mcp:command:<kebab-verb>` (`initialize`, `call-tool`, `list-tools`, `read-resource`, `list-resources`, `list-resource-templates`, `subscribe-resource`, `unsubscribe-resource`, `list-prompts`, `get-prompt`, `complete`); scope = `{ mcpServerId, mcpConnectionId, identity, origin: "wire" }` with `identity` = `IngressIdentity` projected from the authenticated `McpAuthenticatedUser` (identifiers + scopes, never the credential). Per-op-class journal policy on the harness: `call-tool` + `initialize` persisted, every read/list/completion/subscription-bookkeeping class `bus-only` (the envelope is unconditional; only RETENTION is policy). (2) SECURITY PIPELINE → GUARD SEAM — `Authenticator` stays PRE-OP (ADR 92 non-goal: admission is not work); `Authorizer` + `RateLimiter` are `guard`-kind and `InputSanitizer` is `transform`-kind tier-4 call-scoped interceptors on the crossing op, self-scoped by command tag, so the runner's guard-outermost ordering reproduces authn→authz→rate→sanitize with NO pipeline runner. `evaluateRequestPipeline` DELETED (one enforcement path — a second, unused one is the Frankenstein the ADR warns about); its 7 tests re-expressed over the real wire against what actually enforces. Stages keep THROWING their typed `McpServerError` (not raising veto signals) so the JSON-RPC frame is byte-identical — all 416 pre-existing MCP tests pass with ZERO assertion changes (wire-invisibility proven, not asserted). (3) RUNTIME SPINE RULE (~35 lines, `operation-runner.ts`) — a child op's effective `EventScope` now INHERITS the ambient fiber trunk's work-path + identity dims (`sessionId`, `identity`, `principal`, and every augmented dim e.g. `mcpConnectionId`), own scope winning on collision; `origin` and the op-identity quartet (`opId`/`parentOpId`/`correlationId`/`op`) are deliberately NOT inherited. `ctxScope` collapsed from a hand-picked field list to `{...scope, origin, opId, parentOpId, correlationId, op}` — smaller AND more general. Behavior-neutral on the whole existing suite. (4) SUBSCRIPTION DISPATCH — new `SubscriptionsHarness` (per-harness convention) declaring `subscriptions:dispatch` → `subscriptions:command:dispatch`, PERSISTED, scope `{ sessionId, subscriptionId }` (new `EventScopeExtensions.subscriptionId` augment); `createSubscriptionBridge({ runDispatch })` is an OPTIONAL injected capability so the bare bridge is unchanged; the "no handler declared" throw stays pre-op (admission). Guard veto blocks a scheduled fire. (5) ADMISSION-FAILURE EVENT — discrete `mcpServer:admission:failed` (connection shape + `failureClass: "connection-guard" | "pre-gate" | "authenticate"` + reason; NEVER headers or credential) at all three MCP rejection points; asserted over real loopback HTTP for the pre-gate 401. **ADR 91 STOP-RULE #2 — PARTIALLY CLOSED, honestly.** Seams reached IN-FIBER now carry the crossing's identity on the TRUNK: tool handlers and completion handlers (both asserted over the wire, with `ctx.opId === crossing.opId`), and a handler's `ctx.run` mints CHILD ops carrying `parentOpId` + connection dim + identity two levels deep. **STILL BLOCKED: resource resolvers + prompt render.** `Resources.read(uri)` / `Prompts.render(...)` re-enter Effect through `runHarnessProtocol`'s `Effect.runPromiseExit` (harness-protocol.ts:41), which starts a ROOT fiber inheriting no FiberRef — empirically confirmed, and confirmed to WORK when the inner effect runs on the crossing's captured runtime. Unblocking needs an Effect-native face on those reads (`Resources.fx.read` / `Prompts.fx.render`) the projection can run on the captured runtime — OUT OF FENCE for this slice (packages/resources, packages/prompts, spec protocol). TODO trailheads at both projection call sites + a README "Known gap" section. **SECOND STOP-RULE: gateway/transport admission event.** `authenticateIngress` (transport/src/server/ingress.ts:36) is a pure helper with no bus and no host ref; its three callers (transport-http:526, transport-websocket:150, transport-unix-socket:66) each hold a `DispatchHost` but never pass it, and `AuthSource` is configured per-transport so there is no gateway wrap point either — threading an emitter through one seam and three OUT-OF-FENCE edges is a deliberate follow-up. `TODO(ADR-92 slice-A)` at the site with the full citation trail. Gates: suite 5006 → 5031 /64 (+25: MCP crossing-ops 20, http-transport +2, subscriptions dispatch-op 10, pipeline −7); typecheck 103/103 force-run (0 cached); `verify:publish` + ctx-derivers gate (1415 files) green; oxfmt on touched files only; oxlint clean. NEXT: Ryan rules on the two stop-rules (the `fx`-face unblock is the interesting one — it also retires the last orphaned-root class) → ADR 92 Slice B (spawn/fork, session close, live stop/close, credentials set/delete + redaction law) → Family 3 sync-return design pass.

**Last updated (prior):** 2026-07-26 (4th) — **ADR 91 PHASE 2 LANDED (starved seams fed, brand near-total, single-auth) + ADR 92 DRAFTED/RATIFIED (operation-grammar completion).** Phase 2, behavior-preserving except the sanctioned single-auth change: (A) STARVED SEAMS — spec exports `OperationCtx = RuntimeContext & Observability & Ops` (THE canonical trunk+facets name); `ResourceResolver`/`TemplateResolver` → `(uri, ctx?)`, `PromptDeclaration.render` → `(args, ctx?)` (harnesses derive in-fiber via `currentOperationCtx()`), MCP `CompletionContext extends OperationCtx` (fully wired to per-request identity — DB-backed completions now possible), `TaskWorkContext = OperationCtx & TaskWorkVerbs` (task bodies can log/trace/run; forked worker mints degraded-but-typed ctx, TODO(phase-3) IPC log bridge). (B) BRAND TOTALIZATION — `deriveContext(parent, facets, extras?)` composes extras via property DESCRIPTORS (live getters unforced, facets win collisions, precedence facets▸extras▸trunk); tool-executor + both MCP ctx builders now mint single branded compositions (`Derived<ToolHandlerCtx>`/`Derived<McpRequestContext>`); compile-time `@ts-expect-error` proof a hand-assembled bag is rejected. STOP-RULED (kept honest): gateway wire ctx stays in-place-attached/unbranded — `runWireDispatch`'s handler closure captures the caller-built ctx object, so minting fresh requires the wire handler-contract change; rides ADR 92 Slice A/B. (C) MCP SINGLE-AUTH — `AuthPreGate.verify` → `AuthPreGateVerdict {ok, user?}`, forwarded as `McpConnectionInfo.authenticatedUser`, seeds `mcp.user`; authenticator runs EXACTLY ONCE per oauth'd initialize (tested). SECOND STOP-RULE (the ADR-91↔92 convergence): MCP WIRE identity cannot reach resource/prompt resolvers because the inner `resources:command:read` op scope is `{sessionId}` only — the orphaned-root problem ADR 92's crossing-op parenting fixes; in-process paths fully threaded. Gates: suite 4996→5006 /64; typecheck 103/103 force-run; verify:publish + ctx-derivers (1411 files) green. **ADR 92** (blueprint/92, committed): litmus-test law; 7 gaps/3 families from the crossing audit; Slice A ingress (MCP `mcp:command:*` + guard-seam security + subscription dispatch + admission-failure event), Slice B lifecycle/credentials (journal-redaction law), Family 3 sync-return design note; RATIFIED: layered execution = layered journal records (N real layers → N linked records); dispatch-unification (MCP→tool-executor) = Slice A consideration under three-consumers. **UNATTRIBUTED TREE RESIDUE (quarantined, uncommitted): a ~40-package `files`+`publishConfig.exports` manifest sweep + pnpm-workspace quote churn — matches the queued "exports polish" backlog item but NO agent claims it (phase-2 implementer denies; formatter can't author it); awaiting Ryan attribution before commit.** NEXT: Ryan rules on residue → next.8 publish → ADR 92 Slice A → Slice B → Knowify follow-up (step-up hints + apps on next.6 carriage; me/company + dynamic prompts un-degrade AFTER Slice A parenting).

**Last updated (prior):** 2026-07-26 (3rd) — **ADR 91 PHASE 1 LANDED: the ctx spine — trunk to spec, branded deriveContext.** Ryan's mandate: contexts "grounded in the same reality... rightfully assumed and framework enforced, not vigilance." Grounded in a full inventory (8 boundary ctxs / 6 fabrication sites / 9 starved seams / 3 name conflicts). Landed behavior-preserving: (1) `RuntimeContext` + `RuntimeContextUser` + `EMPTY_CONTEXT` MOVED runtime→spec (`spec/src/data/runtime-context.ts`; FiberRef substrate stays in runtime; augmentation retargets `declare module "@agentick/spec"`); (2) `Derived<C>` brand (spec, unexported symbol) + `deriveContext` (runtime, absorbing the facet-derivation core; overloads: in-fiber Effect-native ambient parent / off-fiber explicit parent; lazy facet getters preserved) + `deriveTestContext` (/testing); (3) retypes: `ToolHandlerCtx` extends trunk (flat sessionId/executionId/tickId deleted), `WireExtensionContext` extends trunk, `StoreCtx` COLLAPSED to literal `extends RuntimeContext` (`user: unknown` weakening dead — its docblock had begged for exactly this), `InterceptorCtx` formalized; (4) all six fabrication sites route through the deriver (MCP trio, tool-executor, interceptor, gateway wire via the shared `attachOperationFacets` core); (5) `WireExtensionContext.transport` → `wire` (no shim); (6) NEW `check:ctx-derivers` gate in verify (direct `deriveObservability`/`deriveOps` outside the deriver fails the build — 1407 files scanned) + trunk-derivation conformance suites. Net −74 lines on modified files. Gates: full suite 4944→4996 /64; typecheck 103/103 (0-cached force run); verify:publish + new gate green. JUDGE FINDINGS → ADR 91 Phase 2 list: brand totalization (tool/MCP/wire compose final ctxs by SPREAD which erases the brand — only the interceptor seam demands `Derived` today; deriveContext needs a boundary-extras param) + the MCP single-authenticator forward-derivation (stop-ruled: needs pre-gate identity persisted across transport→harness). Phase 2 = starved seams (prompt render, resource resolvers, CompletionContext, TaskWorkContext) + those carry-overs; Phase 3 = namespace whitelabel + metrics sweep + lifecycle audit. Publishing as next.7.

**Last updated (prior):** 2026-07-26 (later) — **MCP WIRE EXTENSIONS (3b-0b-B) — the `metadata.mcp` convention; `wwwAuthenticateMeta` is now live on the wire.** The Ernesto 3b-1 port (v1 `@knowify/mcp` → `McpServerHarness`, landed uncommitted in nx-knowify with shadow gate 4+1skip / principal rider 2 / lib 19 all green; parity doc `docs/ernesto-v2/MCP-PARITY.md`) produced a 5-gap upstream ledger. Family B (wire lossiness, MCP-local) fixed here, NO spec changes — both `ToolDeclaration.metadata` and the tool-result envelope's `metadata` bag already carry open metadata, so MCP payloads ride ONE namespaced `metadata.mcp` block projected at the wire (wire-constraints-at-the-wire): (1) result-side `_meta` — envelope `metadata.mcp.meta` → wire `CallToolResult._meta` (also first-class `_meta` on the low-level `ToolHandlerInvokeResult` for `resolveHandler` adopters); this makes `wwwAuthenticateMeta` (next.5) actually reach clients — it was INERT before (nothing projected it; the README example didn't even typecheck). E2E test: in-memory pair, client observes the full RFC 6750 challenge. (2) declaration-side `_meta` — `metadata.mcp.meta` → wire `Tool._meta` (the MCP Apps `ui://` template-linkage carrier). (3) advisory annotation hints — `metadata.mcp.annotations` (readOnly/destructive/idempotent/openWorld) → wire `Tool.annotations`, empty-block suppressed; wire `title` stays sourced from `metadata.title` (explicit-beats-carried precedence). Typed helpers `mcpToolExtensions`/`mcpResultExtensions` + readers in `server/tool-extensions.ts`. Byte-identical-when-absent asserted both sides (regression guards). Gates: mcp 401→414 /2 (+13); typecheck 103/103; verify:publish green. **Family A still open (Ryan-gated design): ctx threading into content seams** — resource resolvers, prompt `render`, `CompletionContext` are all identity-free (v1 passed ctx; 4-seam cites in MCP-PARITY.md); recommendation = additive ctx param on the shared seams (aligns with the thread-ctx-into-methods design thread), NOT an MCP-local ALS re-creation; template enumeration rides the same batch. NEXT: publish next.6 → (on ratification) Family A → 3b-1 follow-up consumes next.6 (step-up hints on task tools, MCP Apps port).

**Last updated (prior):** 2026-07-26 — **MCP SERVER PARITY SLICE (3b-0) — the four gaps between v1 `@knowify/mcp` and `McpServerHarness`, closed.** The Ernesto 3b scout produced the full parity matrix and a framing discovery: v1 `@knowify/mcp` is NOT hand-rolled — it runs on the OLD agentick `MCPServer` class, so the re-platform is an API migration, not a rebuild. Four upstream gaps blocked it; all four landed in `packages/mcp` (additive only, no other package touched): (1) **`httpMiddlewareTransport`** — the mount door for framework-owned servers (express/Nest), where a raw `server.on("request")` attach is SHADOWED by the framework's catch-all 404 (the exact failure assistant-api documented for the gateway mount). A sibling factory (not a mode flag — return types diverge): no socket/server/path; `listen()` captures accept+pre-gate; host drives `handler(req, res, parsedBody?)` from its middleware (parsedBody threads an express.json()-consumed body to the SDK) + `metadataHandler(req,res): boolean` serves RFC-9728 discovery at server root. BOTH http shapes share one `createHttpCore` (session map, metadata, pre-gate, MCP routing) — a crossing is handled identically, never duplicated. (2) **Per-connection `instructions`** — `string | (ctx) => string | Promise<string>` on `McpServerOptions`, projected into `InitializeResult.instructions`; function form sees the authenticated identity (`ctx.mcp.user` via the configured Authenticator), resolved per initialize, never cached. Noted: on an oauth'd server the authenticator runs twice per initialize (pre-gate + instructions ctx) — idempotent for token-cached authenticators; future micro-opt = thread the pre-gate's authn result through. (3) **Resource-template argument completion** — `completions.resources` keyed by template uri → variable (same `complete*` sugar); `ref/resource` routes to it; closes the phase-#123 TODO. (4) **`wwwAuthenticateMeta`** — tool-result `_meta["mcp/www_authenticate"]` step-up challenge builder (v1 parity: per-op `scope` hints mid-session); new `security/www-authenticate.ts` is the single source of truth ALSO backing the transport pre-gate's 401 header (exact strings preserved); exported from `/server` (main index stays browser-safe), opt-in, never auto-invoked. Deliberately NOT added (userland, per compose-primitives + the absorption rule): `toolSurface` enum (= explicit tool arrays + `tools.filter`), ALS `contextProvider` (= identity via Authenticator → `ctx.mcp.user`), MCP-UI `apps` slot (Ryan ruling: port v1 apps as STANDARD MCP Apps shape in userland — tools + `ui://` resources + declaration `_meta` linkage; and NO conflating server-side compiler-react JSX with human-facing UI — MCP Apps UI is a component-library direction). Gates: mcp suite 372→401 /2 (+29: door 9, instructions 6, www-auth 8, resource-completion 6); typecheck 103/103; verify:publish green (dep-graph incl. new exports); oxfmt/oxlint clean. NEXT: publish next.5 → dispatch Ernesto 3b-1 (the port): all tools/resources/29 prompts/completions onto `McpServerHarness`, HS256→RS256/Redis/refresh cascade in one `bearerTokenAuth` verify, mount at `/api/agentick/mcp` beside the LIVE v1 at `/api/v2/mcp` — the shadow-run gate (same tool call through both doors, claims-filtered identically). Riders: `KnowifySessionStore` round-trips `SessionRecord.principal`; verify declaration-side `_meta` projection (Apps linkage).

**Last updated (prior):** 2026-07-29 — **THE SESSION-PRINCIPAL COMPLETION — ADR-48's owning-principal concept is now load-bearing end-to-end (closes the prior "(2) BACKLOG" item).** Before this the `SessionHarnessProtocol.principal` field existed and the dispatch gate consulted `targetSession?.principal`, but NOTHING stamped it — the same-principal rule was structurally dead. Five parts landed: (1) STAMP — `CreateSessionInput.principal` (host-door, NOT wire-settable like `requiredScopes`); threaded app→`SessionHarnessOptions`→`BaseHarness` (field already backed) + onto `SessionRecord.principal` (new durable identity slot; the `app/create_session` wire method stamps `ctx.principal`, params carry no `principal` field so a smuggled body value is ignored, unauth→unstamped). (2) INHERIT — `session.spawn()`/`fork()` thread `this.principal` onto the child via `SpawnContextChildInput.principal` (not caller-choosable; no `SpawnInput`/`ForkInput` override). (3) FORK METADATA — `fork()` inherits the parent record's `metadata` bag when `ForkInput.metadata` absent (a fork is a same-image copy; the snapshot copies bridge state, the record bag is the arbitrary exception); spawn does NOT auto-inherit. (4) RESHAPE ARM — `onSessionCreate` grows a transform arm (return a `CreateSessionInput` to reshape / `{kind:"veto"}` to veto / void to pass — the house before-hook grammar); spawn's `parentSessionId` folded into the hook-visible input so the seam can read parent→inject-metadata (adopter-selective spawn inheritance). (5) INSTALLER IDENTITY — `SessionInstaller.principal` + `.metadata` for per-session tier-scoped store construction. HEADLINE: the same-principal gate now ENGAGES on the stamped value (caller A vs session owned by B → Forbidden, both holding `*` grants so the denial is PURELY the target rule) — the test that makes ADR-48 real. Gates: typecheck 103/103; suites 4935→4944 /0 (+9, no regressions); verify:publish green; oxfmt/oxlint clean. Downstream note: a durable `SessionStore` adapter (postgres) must persist+round-trip `SessionRecord.principal`. Tests: `transport/…/session-principal.spec.ts` (wire stamp + gate) + `app/…/session-principal-lifecycle.spec.tsx` (inherit/metadata/reshape/installer).

**Last updated (prior):** 2026-07-28 (later) — **ERNESTO 2B COMPLETE (the exposure slice) — the security seam is proven end-to-end; two new upstream items.** All five parts landed against next.3 in nx-knowify (uncommitted, Ryan reviews): createErnestoGateway (two doors over one buildErnestoAppConfig; gateway path supplies reactCompiler explicitly — gateway.createApp does NOT auto-inject the React compiler like /react createApp does), app-side knowifyAuthSource (HS256 kAuth → IngressIdentity; hydrateUser deferred), THE OVERRIDE as gateway hooks (onBeforeWireAppCreateSession/SessionSend reshape via ctx.identity — the next.3 seam working exactly as designed; permissive authorizer + unconditional override = STRUCTURAL tenant isolation), fakes (fakeErnestoApp/fakeErnestoGateway; in-process auth twin via authenticateIngress-before-dispatchRequest), the /api/agentick mount beside v1 (model-less, TODO(phase-model)). Verified independently: lib 8, auth 6, wire gate 7 (incl. smuggle-override on the REAL DB + coexistence in situ), phase-2 gate 1, phase-1 conformance 33 — all green. TWO UPSTREAM ITEMS: (1) DOCS GUIDANCE — on a framework-owned server (Nest/express) the raw httpServerTransport({httpServer}) request listener is SHADOWED by the framework's own 404; the fetchServerTransport door (inside the framework's pipeline) is the correct embed mount — document the decision rule (raw attach = bare Node server; fetch door = framework hosts). (2) BACKLOG — spawned/forked children cannot inherit the parent's principal: SpawnContextChildInput doesn't thread parent metadata and onSessionCreate can veto but not reshape; candidate fixes = fork/spawn inherit parent metadata by default OR onSessionCreate gains a reshape arm (TODO(principal-inheritance) at the ernesto gateway seam). Ernesto phases 1+2+2b now built; next fronts: Phase 3 (MCP server + tiered catalog + OAuth) and Phase 5 (ernesto-client on the waiting fakes; forces the channel-consumer primitive). Grammar workshop parked in memory (membership law, namespace-files-are-store-definitions, gateway-a-level-up; Ernesto = intended first proving ground).

**Last updated (prior):** 2026-07-28 — **THE EMBEDDING-HARDENING PAIR: transport shared-server citizenship (next.2) + wire identity threading (next.3) — both found by Ernesto Phase 2b, both published.** (1) CITIZENSHIP (fix, next.2): both server transports clobbered co-tenants on an adopter-supplied http.Server — websocketServer DESTROYED every non-matching upgrade (would kill socket.io's Engine.IO in assistant-api), httpServer 404'd every non-matching request (Node fires ALL request listeners → double-respond). Fix: ownsServer threads from the wrapper branches ({port} = owned → destroy/404 kept; {httpServer} = attached → ignore); branch-derived, not adopter-settable; new shared-server coexistence smoke (gateway HTTP + v2 WS + adopter /health + foreign socket.io-like upgrade listener on ONE server — previously unexercised contract). (2) IDENTITY THREADING (feat, next.3): the wire carried IngressIdentity to the extension ctx but never onto the OPERATION — params-reshaping before-hooks (THE seam a multi-tenant adopter needs to stamp the token's principal over client-smuggled metadata) couldn't see the caller. 2b's implementer STOP-RULED with a 4-seam citation trail (exemplary — zero workarounds). Fix (seam-over-setting, no new mechanism): EventScope.identity (structured twin of origin; identifiers+scopes, never tokens — auto-serializing into audit events is the journal's job), runWireDispatch threads ctx.identity onto the wire op scope (client-unsettable; omitted unauth), WireExtensionContext.identity beside the legacy principal string. The OVERRIDE itself stays adopter-space (userland-first; README recipe + framework-side smuggle-override proof in transport's wire-identity-hook.spec.ts). Suites 4915 → 4920 → 4924 /0; typecheck 103/103; publish-dev now runs CLEAN end-to-end (no --force, no per-package loop — changelog-storage fix + seeded registry removed both failure modes). Ernesto: Phases 1+2 committed on nx-knowify `assistant-agentick-v2` (4 commits + Ryan's base); 2b implementer un-held with the next.3 seam contract, building the full exposure slice (createErnestoGateway two-door restructure, app-side KnowifyAuthSource HS256, principal-override hooks, fakes, /api/agentick mount, gate tests). Trailheads added: RPC transcoding (Twirp-shaped, streaming design parked: capability-on-descriptor/negotiation-on-request), agentick "devtools for prod/admin" product seed, closeApp→close cut-bucket rename.

**Last updated (prior):** 2026-07-27 (later) — **CONTENT PROJECTIONS LANDED: skill:// + prompt:// — the catalog is addressable.** Ratified with Ryan out of the "are skills/prompts just resources?" design thread (ruling: resource = universal CONTENT substrate, NOT universal primitive — consumption verb discriminates read/render/run; MCP's own trichotomy anchors it; roots are namespace not content; resources model a filesystem's READ face only). The composition: skills/prompts PROJECT as read-only resources (never stored as them). `wireSkillProjection`/`wirePromptProjection` in each package (universal modules, no node:_): one `skill://<name>` / `prompt://<name>` per record, resolver reads the LIVE harness (updates need no re-wire), LIVE set-diff via the View's subscribeAll+list() seam (no new notifier), `exposeAsResources` opt-out (default ON, sibling of registerModelTools), E2 coexistence (body + references/_ both live), honest prompts content decision (string template → text/markdown; function render → application/json declaration doc {name, description, arguments}, validators stripped — a function is NEVER serialized). Two doors deliberately: skill_read = model-directed, skill:// = uniform-addressing (MCP clients + allowedTools-restricted agents). Suite 4903 -> 4915/0 (+12); typecheck 102/102; verify:publish green (no-TLA + dep-graph). ERNESTO DESIGN CONVERGED same window (see memory project-ernesto-v2-track + nx-knowify/docs/ernesto-v2/ARCHITECTURE.md): MCP-first tooling (privilege = claims not code path; native/MCP boundary by COUPLING), tiered catalog (tenant_id/user_id optional; user>tenant>global shadowing), DB-backed catalog store ("save this as a skill" from chat), injection-not-extraction storage, 6-phase roadmap with conformance gates. NEXT (Ryan-gated): Ernesto Phase 1 (store adapters vs conformance suites); agentick queue: README-accuracy sweep, 5 command-key kebab outliers, ./package.json exports polish.

**Last updated (prior):** 2026-07-27 — **THE VERDACCIO REHEARSAL IS COMPLETE — 1.0.0-next.1 live in the canonical registry; consumer smoke GREEN.** The rehearsal earned its keep 4× over. (1) CONFORMANCE DEFECT (fix 203e2fe2): consumer install failed at require — conformance suites import vitest and were on 12 MAIN barrels (workspace hoisting masked it; no-TLA passes in-repo). Moved to /testing subpaths; NEW scripts/dep-graph-gate.mjs in verify:publish (dist import graph vs declared deps; vitest allowlisted on /testing only) whose pre-fix inventory ALSO caught 6 undeclared @agentick runtime deps hoisting masked (session->tool-executor on the MAIN graph!). (2) REGISTRY CANONICALIZATION (bfb5db67): nx-knowify's `nx local-registry` (port 4873, CodeArtifact uplink, start-verdaccio.sh mints the token) is THE registry — agentick-side runner deleted; docs/verdaccio.md rewritten AND actually tracked now (/docs/\* is blanket-gitignored; PR 1's doc silently never entered git — !negation added). Ryan's ~/.npmrc: machine-wide default registry=localhost:4873 + @agentick:registry=npmjs — BOTH hijack flows silently; project .npmrc scoped line out-ranks (documented). (3) CHANGELOG LINEAGE: pnpm 11 registry-composed changelogs fetch the PREVIOUS version's tarball — for the 8 v1-collision names that's v1 0.15.3 through the proxy (wrong lineage + 500). versioning.changelog.storage -> repository. (4) pnpm 11 quirks pinned: --registry flag/env are IGNORED by native publish (scoped registries config wins); fresh-registry GET-404 aborts unforced recursive publish while --force 409-aborts on any present package (per-package tolerant loop for first publish); stale metadata cache resolves @next to dead versions (exact-version add bypasses). CONSUMER SMOKE (clean dir, real install): session/spec/skills/elicitation/knobs/client main barrels + skills/loaders/node all require() green; /testing correctly demands a runner. Session README audited on Ryan's ask (5 rotted claims fixed, 6d904eaf + the model.use ctx omission); 12 more READMEs carry stale boilerplate -> README-accuracy sweep queued. Naming Q&A: session:set-model correct (commands kebab / wire snake / model tools snake); 5 command-key outliers (resources:listTemplates, timeline:replace/resetProjection, model/tool:generate_stream) -> pre-cut kebab sweep + casing law in ADR 27. NEXT: Ernesto scaffold in nx-knowify (needs Ryan: package scope, client ambition, parity bar) + README-accuracy sweep + ./package.json exports polish.

**Last updated (prior):** 2026-07-26 (later³) — **PR 2 LANDED (two commits): v1 removed from feat/v2 (3ad40ba9) + THE RENAME — packages-next → packages, -next dropped from all 59 names.** Phase A: v1 (35 pkgs + agentick 0.15.x metapackage + 3 v1 examples, 968 files) left the branch; v1 lives/publishes on master; parity via `git grep <pattern> master -- packages/`; workspace/versioning/vitest surgery; jsxImportSource agentick → react (v2 tsconfigs already declared it); typecheck graph 155 → 102 tasks. Phase B: `git mv packages-next packages` (1634 tracked renames); 59 names de-nexted; ~5628 specifier rewrites + 385 workspace deps + 126 declare-module augmentation strings (shadow-trap guard: 0 risk files); CLAUDE.md coherent rewrite (556→370 lines, v1-era sections removed); blueprint ADRs swept as living contracts, dated logs (this file etc.) intentionally historical; residue greps ZERO outside docs/proposals+.changeset+lockfile. Notable catches: an escaped-slash regex literal (`@agentick\/gateway-next#gateway`) in a test was the single initially-failed test; 2 v1 files had survived Phase A's git rm; 2 stale repository.directory fields fixed. RATIFIED with Ryan en route: XHarness→X class rename DEFERRED to cut (scout falsified premise — bare nouns are the protocol types adopters hold; Fable recommends reversing: keep XHarness, complete noun aliases); v2 metapackage DEFERRED (single-vs-agentick-react split parked until a second compiler exists). Gates: frozen install green; typecheck 102/102 --force; suite 4903/0 exact; verify:publish 58 pkgs/135 entrypoints under the NEW names; pack proof (@agentick/spec etc.); `pnpm change status` parses. THE PACKAGES NOW CARRY THEIR FINAL NAMES — Ernesto never sees a rename. NEXT: first next-lane publish to verdaccio (pnpm change major intent → version -r → publish-dev), then Ernesto scaffold (client lib + gateway) in nx-knowify.

**Last updated (prior):** 2026-07-26 (later²) — **ERNESTO TRACK PR 1 LANDED: pnpm 11 + native versioning lanes + publishConfig sweep + publish gate (7ce91d2a).** Strategy ratified with Ryan: Ernesto v2 (client lib + gateway for assistant-api embedding) develops in nx-knowify against verdaccio; renames PULLED FORWARD before consumer #1; cut = lane graduation. This PR: pnpm 11.17 (lockfile stays v9; allowBuilds migration; @changesets/cli dropped for pnpm-native versioning — config in pnpm-workspace.yaml `versioning:`, dead .changeset/config.json deleted, intent files + ledger stay); TWO fixed groups (v1 35 names / v2 58 publishable) + `next` prerelease lane on all v2 (v2 ships X.Y.Z-next.N, v1 stays stable); publishConfig sweep on all 58 (access public — scoped default is RESTRICTED, was missing on all 27 pre-existing configs; exports/main/types→dist; files [dist]; engines.node >=20.19 = the require(esm) floor, ESM-ONLY no CJS build — dual-format would break instanceof/registry singletons; bin→dist for mcp + sandbox-lambda; private flags dropped except spec-conformance); verify:publish script (clean → build → no-TLA), gate coverage 17 pkg/28 entrypoints → 58/135; pack-inspection proof 7 tarballs/46 files/0 missing; publish-dev → verdaccio :4873 --tag next + docs/verdaccio.md. pnpm 11 strictness caught 6 undeclared deps pnpm-10 hoisting masked + vestigial example/pnpm-workspace.yaml (deleted). Known pre-existing: agentick-website build broken (typedoc/vitepress rot, untouched). Suite 4903/0; typecheck 155/155 --force; frozen install green. NEXT: PR 2 — the renames (-next drop across all packages, XHarness→X API sweep, v2 `agentick` metapackage decision per ADR 27) while consumer count is ZERO; then first next-lane publish to verdaccio; then Ernesto scaffold in nx-knowify.

**Last updated (prior):** 2026-07-26 (later) — **E1+E2 LANDED — skill loaders complete; THE RATIFIED ARC IS DONE (A → B/B2/B3 → C/C1.1/C2 → toolChoice → F+G → G-prep → onBusy → G2 → §D → E).** E1: `agentSkillsDirectory({ root? })` in `/loaders/node` — Agent Skills (agentskills.io) layout, one skill per `<dir>/SKILL.md`, name defaults to dir name, `allowed-tools` frontmatter → `Skill.allowedTools` (inline array OR comma-string), hidden+symlink rejection (Flue rule), missing root → empty load; the mapping also landed in fromFile/fromDirectory (every Node loader speaks the field) — TODO(E1) closed, and the C2 loop is CLOSED end-to-end: a disk-loaded skill with allowed-tools restricts the model's tools through composeRun with zero adopter code (test-pinned). E2: `references/*` ride the RESOURCES harness — `skill://<name>/references/<relpath>` transient resources readable via resource_read. THE SEAM: `installer.resources` (spec app-extension.ts:332) — host-constructed, first-class, ordering-safe; the exact registry withMCP proxy-registers into (with-mcp.ts:683,729 / resource-surface.ts:107 resolver pattern copied). Universality solved by TWO representations: `metadata.references` = pure `{uri,path}` (serializable) vs `metadata["@agentick/skills-next/reference-wiring"]` = transient resolver closures built Node-side, consumed once at install by the universal extension.ts (zero node:\* imports; no-TLA green). Trailheads: TODO(E3) fromPackage (npm subpath → agentSkillsDirectory semantics; exports-map caveat), TODO(E2-reload) (reload/restore does not re-sync reference resources). Suite 4890 -> 4903/0 (+13); typecheck 155/155 --force. ARC COMPLETE — remaining trailheads: knobs ctx-slot hoist (TODO(tools-sweep)), E3, E2-reload, value-cell stratification, prefix-stability test. NEXT (Ryan-gated): positioning workshop → README/website; v2 cut.

**Last updated (prior):** 2026-07-26 — **§D MODEL-TOOLS SWEEP LANDED (one documented STOP).** The `<harness-noun>_<verb>` naming law is real: `set_knob` -> `knob_set` (~23 files; local identifiers KnobSet* too; wire `knobs:set` untouched), `session*tasks\*_`->`task_\*`(15 files; consts TASK*\*; spec file git-mv'd to task-tools.spec.ts; task_ref/task_id/task_failed correctly fenced), and the FIRST new-convention tools shipped:`skill_list`+`skill_read`(progressive disclosure — model discovers names/descriptions, reads one on demand; skills/src/tools.ts from the resources template; default ON behind`withSkills({ registerModelTools })`; honest degradation; skill_read treats a missing name as a DOMAIN case -> `{error:"skill_not_found"}`, not the must-exist SkillNotFound). CTX SEAM: the ADR-66 augmented-slot population seam EXISTS — tool-executor spreads an opaque `ctxExtensions`record (harness.ts:216,856) filled at the AppHarness single construction site from the session-extension bridge bag (sandbox precedent, now generalized; skills rides it via`ctx.skills?: Skills`augment). KNOBS DELTA-3 STOPPED per stop-rule: the knobs bridge is a CORE session bridge born inside buildSessionBridges AFTER the executor exists, instance-coupled to GatesHarness, interceptor-parented to the SessionHarness — hoisting is a real design (TODO(tools-sweep) trailhead at the site);`knob_set`stays on`use:` capture for now; NO unpopulated ctx.knobs slot was added (always-undefined is worse than none). ADR 27 gained the "Model tools convention" addendum incl. the REJECTED command→tool auto-bridge; TODO(tools-sweep) markers at timeline/prompts/state. Example apps' agent prompts fixed (they instructed the model to call the dead names). Suite 4884 -> 4890/0 (+6); typecheck 155/155 --force; no-TLA green; unfiltered greps clean (packages-next + examples; v1 + historical docs intentionally retained). NEXT: E loaders (agentSkillsDirectory, references-as-resources, fromPackage) — last item in the arc; then the knobs-hoist trailhead + positioning workshop (Ryan-gated).

**Last updated (prior):** 2026-07-25 (later³) — **G2-WIRE-ERRORS LANDED + error-name fidelity fix.** Two commits. (1) fix(spec): FOURTEEN error classes (GateNotFound, SkillNotFound, ToolNotFoundError, six prompts errors, McpServerNotFound, ...) declared `readonly name` as a DOMAIN field — squatting on the platform Error.name slot (base ctor stamps class name; subclasses clobbered it) AND silently DROPPED over every wire (toJSON skips `name` as Error-inherited; cluster + MCP affected too). Found by the G2 round-trip test (gateName arrived undefined). Renamed per family: toolName/promptName/gateName/skillName/serverName; e.name is the class name again; codec untouched; per-family conformance tests pin wire fidelity + platform-slot invariants. (2) feat(client): client-core rehydrates typed AgentickErrors — the composedRequest wrapper (ABOVE the extension pipeline: retry/offline keep classifying raw wire envelopes by code; adopter middleware + app code get instanceof back) throws deserializeAgentickError(error.data) when data.\_tag is a string. Protocol-level errors (MethodNotFound etc., no \_tag) keep the raw {kind:"rpc"} envelope — isMethodNotFound duck-typing intact. Seam choice: NOT the transport base (extensions sit between and speak wire codes — rehydrating below them would regress retry classification). e2e through the REAL in-process stack: gateway-thrown SessionNotFoundError arrives instanceof with sessionId; 3 transport smoke specs (http/ws/unix) updated from raw-envelope assertions to typed (\_tag + appId). Suite 4868 -> 4884/0 (+16); typecheck 155/155 --force; no-TLA green. NEXT: §D naming sweep (knob_set, session_tasks\_\_ -> task\_\_, skill_list/skill_read) -> E loaders.

**Last updated (prior):** 2026-07-25 (later²) — **onBusy REDESIGN LANDED (supersedes steer-verb extraction; judged + committed by architect).** The busy-send knob is renamed AND given a smart default; no back-compat, one code path. **Spec:** `SendInput.delivery?: SendDelivery ("steer"|"followUp")` → `SendInput.onBusy?: OnBusy ("steer"|"queue")` (`"queue"` = the old `followUp` semantics: await quiescence → fresh execution); `export *` barrels re-export `OnBusy` automatically; wire `SessionSendParams.delivery` → `onBusy`. **Smart default** (session `sendBody`): unset `onBusy` resolves per send shape — a send carrying structured output (`output`/`responseFormat`) defaults to `"queue"` (a steer has no final turn to shape), a plain send defaults to `"steer"`. **Guard narrowed to EXPLICIT steer:** the `SteerCannotCarryStructuredOutput` join-point guard now fires ONLY on an explicit `onBusy:"steer"` carrying structured output that actually joins an in-flight execution (`explicitSteer &&` added to the condition — an implicit structured send resolves to `queue` and never reaches it; idle-session explicit steer still degrades to a legal fresh send). Error class + `_tag` UNCHANGED (wire codec stability); message/doc rewritten to the new vocab. **Dead wire method DELETED:** `session/queue` (wire params + method-map entry + `SessionQueueParams`/`SessionQueueResult` types + client-core `queue()` stub + `SessionHandleBase.queue` type + retry-idempotency + offline-policy predicates) — no server handler ever existed; the semantic is now `send({ onBusy:"queue" })`. **Behavioral delta (accepted):** `skills.run` with `output` racing an in-flight execution used to throw; it now QUEUES and delivers after quiescence (composeRun leaves onBusy unset → smart default). Tests rewritten accordingly (app skills-run-e2e; session structured-send/structured-output kept an EXPLICIT-steer rejection test + added implicit-queues + idle-explicit-steer-runs-fresh). Wire e2e: `onBusy` threads through transport-in-process. Suite 4865 → 4868/0 (+3 net); typecheck 155/155; no-TLA green; oxfmt/oxlint clean on touched. Docs swept (session/skills/client-extensions READMEs, guide-structured-outputs, north-star, website-design, blueprint 46, this file). **Terrain note:** the fake executor's `holdUntil` gate only applies to the non-streaming `run` path — the app e2e's in-flight "hold" send needed `stream:false` to genuinely block (the app defaults to streaming; structured-send/output specs already force `defaultStreaming:false`). NEXT: G2-wire-errors → §D naming sweep → E loaders.

**Last updated (prior):** 2026-07-25 (later) — **C2 LANDED: session.fork() + skills.run isolation + the allowedTools restriction seam.** The three C-split follow-ups in one slice (delegated per protocol: scout -> fresh-context Opus implementer -> judged -> landed). (1) FORK: the session now RETAINS its own agent root (`agentRoot`); `SpawnInput.agent` optional, defaulting to the parent's root (SpawnContextChildInput.agent stays required — the session resolves the default before the boundary); `fork(input?)` = snapshot -> spawn({}) -> child.restore — pure composition, the scout confirmed restore already worked on a never-sent child, the retained root was the ONLY missing primitive. Not wire-exposed yet. (2) ISOLATE: `RunnerBindable.bindIsolationRunner?` (optional sibling of bindRunner, typed SessionSendCapability); the APP binds it (it owns the send closure and IS the SpawnContext — the terrain map's one wrong anchor; the bind site was never in the session package): fork -> child.send -> dispose-after-settle, disposal errors swallowed. Skills stays capability-dumb; isolate with no runner bound still throws SkillIsolationUnavailable. E2E-pinned: parent timeline gains NOTHING from an isolated run; child disposed after handle settles. (3) RESTRICTION: Skill.allowedTools -> composeRun -> SendInput.allowedTools -> RunExecutionInput/TickInput -> loop filters the MERGED model list AFTER compileForTick, BEFORE terminal-tool injection (submit_result exempt by construction; resolveAutoStrategy reads the POST-restriction count — empty => toolsMounted:false => responseFormat on capable targets; both interaction cases test-pinned via seenRuns). ToolListFilter deliberately untouched (loop-assembly concern, not a registry filter). Dispatch door unaffected. TODO(E1) at composeRun for the frontmatter mapping. 13 new tests; suite 4852 -> 4865/0; typecheck 155/155 --force; no-TLA green; TODO(C2) fully cleared. NEXT: onBusy redesign -> G2-wire-errors -> §D naming sweep -> E loaders.

**Last updated (prior):** 2026-07-25 — **F + G LANDED: session.tools + the four client parity handles — the ELEVEN-HANDLE CLIENT is real.** F: ToolsHandle/ToolHandle/ToolInfo in spec (DispatchOptions moved to tool-executor protocol), session.get tools() beside the siblings, session.dispatch REMOVED (sweep grep-proven; wire session/dispatch unchanged), dedicated session/list_tools wire method (the dynamic lane's address pattern did not fit the executor — the pre-authorized fallback), registry topology notifier for subscribe/subscribeAll, ToolsClientHandle (no clientToolCalls collision). G: skills/prompts/resources/state client handles (ClientHandle + Enumerable, RPC fire-and-refetch, per-package /client subpaths + wire-augment splits), client bundle now TEN side-effect imports, ADR 87 symmetry-law paragraph appended, tools-e2e + client-handles-e2e in transport-in-process. FLEET INCIDENT (recorded): the F+G implementer sub-delegated per-package via FORKS — each child inherited the FULL session context (~190k tokens each, usage limit hit twice), and one child (prompts) woke believing it owned ALL of F+G (fork inheritance), detected the collision itself, and stood down with ZERO writes (the protocol's stop-rule working). The skills child died mid-dedupe of a duplicate-import collision in client/src/index.ts (its dedupe SUCCEEDED). Architect hand-finished: 5 strict-typecheck fixture errors in tool-executor tests (the fleet died pre-typecheck — vitest strips types, the strict gate caught drift). RULES ADDED to the delegation protocol: per-package children are FRESH-CONTEXT agents with narrow briefs, NEVER forks (context cost + scope confusion); one writer per shared file is a spawn-time partition, not a hope. WIRE-ERRORS finding (Ryan's question): server already ships full typed errors (tag->code table + toJSON in JSON-RPC error.data); the codec (serialize/deserializeAgentickError, registry-driven, UnknownAgentickError fallback) EXISTS in spec and is used by cluster + MCP — but client-core does NOT rehydrate (duck-typed code checks only). One small PR (G2-wire-errors, queued): client request path throws deserializeAgentickError(error.data) when data.\_tag present -> instanceof works identically client and server. Suite 4802 -> 4852/0 (+50); typecheck --force 155/155; no-TLA green. Sequence: C2 (fork enabler + session.fork + isolate + allowed-tools/restriction seam) -> onBusy redesign -> G2-wire-errors -> SS D naming sweep -> E loaders.

**Last updated (prior):** 2026-07-24 (later-9) — **G-prep LANDED (wire reads + grammar alignment so the four G client handles become buildable).** Two groups. **Group 1 — missing Tier-1 wire reads (were law-breakers):** (a) **skills** had NO wire read (register/update/remove only — enumeration wire-unreachable); ADDED `skills:list`/`skills:get`/`skills:search` (all `exposure:"wire"`, registered for side-effect + `commands/list` enumeration; SYNC `get`/`list`/`search` serve in-process, callables discarded). Wire projection IS the `Skill` — `content` INCLUDED (a client managing skills needs the body; noted unbounded → prefer search). (b) **prompts** lacked `prompts:list`; ADDED it (wire-safe `PromptDeclarationRecord[]`). (c) **state** had NO read command AND set/delete were exposure-less (→ addressable, NOT wire); ADDED `state:get`/`state:list` + `exposure:"wire"` on `state:set`/`state:delete`; authored the type-only `state/src/wire-augment.ts` split (the `export {}` guard is load-bearing — a bare `declare module` SHADOWS spec). WireMethods rows on skills/prompts augment.ts + state wire-augment. New e2e `transport-in-process/__tests__/wire-reads-e2e.spec.ts` (7 tests): skills/list+get, prompts/list (records, no fns), state/get+list+set round-trip, commands/list enumeration, deny-by-default MethodNotFound. **Group 2 — ruled grammar fixes (breaking is free):** (1) **GatesHandle** gained `has()` + `subscribe(name,fn)`/`subscribeAll(fn)` (was the only collection missing the family grammar; wired off ONE unified `KeyedNotifier` replacing the per-entry notifier — fires on transition + register/unregister). (2) **Gate MUTATIONS async + command-routed:** `GatesHandle.clear` + `GateHandle.clear/defer/override` were sync-void direct controller calls while every sibling mutation is an async journaled command AND the client handle is async — three contracts for one verb. Now `Promise<void>` routing through a `GateMutationSink` the `GatesHarness` binds (`bindMutations`) → the `gates:clear/defer/override` commands → the controller's shared RAW transition (`rawClear`/`rawDefer`/`rawOverride`, which the commands drive — no recursion). Bare test controllers default the sink to the raw transition (async, un-journaled). Host clears now journal like wire clears. tick-end path (`handleTickEnd`→`transition`) UNCHANGED — semantics identical, only async-ness. React `useGate` clear/defer stay fire-and-forget `()=>void` (void the promise); GateHandle.override drops its `origin` arg (origin now derives from the command path). (3) **prompts rename:** `getDeclaration(name)`→`get(name)` (sync family convention); async render `get(input)`→`render(input)`; wire verbs realigned: `prompts/get`=declaration read, `prompts/render`=render, keep `prompts/invoke`; MCP prompts projection call site updated (`source.render`). (4) **resources** `subscribeListChanged`→`subscribeAll` (spec+impl+stub+conformance+MCP call site+sandbox doc refs; MCP `list_changed` vocabulary stays at the MCP projection). (5) **state.list()** returns `{key,value}` entries (new `StateListEntry` in spec) instead of bare keys. **Existing tests edited (sanctioned + forced-by-async):** gates `controller.spec.ts` (await clear/defer/override; latch override throw→async `.rejects.toThrow`), transport `gates-e2e.spec.ts` (await the setup override — real session journals); PURE-RENAME sweeps: prompts `harness/loaders-dynamic/store-backing.spec` + `prompts-react/renderer.spec` (`getDeclaration`→`get`, render `get({`→`render({`; `store.get` preserved), state `conformance.ts`+`store-backing.spec` (list→entries), compiler `fake-bridges` fake state list→entries, session `define-session` noopGatesHandle. **gate.spec.tsx needed NO edits** (react fire-and-forget + default sink runs rawX synchronously). **Anti-goals honored:** did NOT build the four client handles (that's G) or ToolsHandle (F); no SESSION_SURFACES change (skills/prompts/state already routed); no gates-state channel; resources async list/read + timeline single subscribe + tasks events(id) left as ruled-defensible. **Could-not-do / deviations:** none blocking — `PromptsGetInput`/`PromptsGetResult` type NAMES kept (describe the render I/O now; renaming ripples to MCP, deferred as cosmetic). transport-in-process gained skills/prompts/state devDeps (`pnpm install`). **Gates:** workspace `pnpm typecheck` 155/155 0 errors; targeted suites (skills/prompts/state/gates/resources/session/gateway/transport-in-process/compiler-react/mcp) 1262 passed/7 skipped; oxfmt + oxlint clean on all touched packages (nonzero warnings elsewhere are pre-existing); `check:no-tla` green.

**Last updated (prior):** 2026-07-24 (later-8) — **B3 LANDED (structured-output completion pass — fix #1 + fix #3 + the recording-executor cure; fix #2 rode C1.1).** THE RULING: the LOOP is now the structured-output **validation authority** — both tiers, both strategies. (1) **Capability-aware strategy auto (fix #1):** `"auto"` resolves to the terminal tool when tools are mounted OR the target lacks native `json_schema` (Anthropic/ai-sdk drop `responseFormat`); the text-only DOUBLE-GAP (no json_schema AND no tools) falls back to `responseFormat` (validation still catches non-adherence). New `resolveAutoStrategy(toolCount, capabilities)` in the loop; truth table documented. `TargetCapabilities.supportsJsonSchema`/`supportsTools` drive it. (3) **Close TODO(b2a-tree-data) (fix #3):** the loop validates the terminal capture (tool) / final text (responseFormat) against the RESOLVED schema (send-level `input.outputSpec` OR tree-resolved `<Output>`, lifted onto `TickResult.resolvedOutputSchema`) and surfaces the VALIDATED value on new `ExecutionRunResult.data`; a miss fails the execution with `ResponseValidationError` (added to the loop's E channel + `LoopExecutorFx.runExecution` + the catchAll passthrough, unwrapped like the other structured errors). Session-side validation DELETED — `SendResult.data` reads `result.data` verbatim, present for send-tier AND **tree-only `<Output>`** (the dedicated-extraction-agent story completes; `output_delivered` + typed `data`). `terminalCapture` kept raw for observability beside `data`. **Recording-executor cure:** `FakeLanguageModelExecutor` gained a public `seenRuns: RunInput[]` ledger (appended in `runBody`); `structured-output.spec.ts` + `structured-send.spec.ts` + `layered-tools.spec.ts` migrated off their bespoke `mkRecordingExecutor`/`gatedExecutor` onto the canonical fake (`seenRuns` + scripted `holdUntil`, non-streaming via `defaultStreaming: false`) — ZERO fully-hand-rolled executors left in session/**tests** (extended-surface's gated variants still wrap the REAL fake via an fx-patch — canonical-fake-based, left as-is). **Behavior preserved:** every pre-B3 send-tier test green unchanged except the deliberate shared-target edit (`supportsJsonSchema: true` — models OpenAI). NOTE: validation-failure now routes through the loop E-channel → session onRejected (endTurn `outcome: "failed"`, consistent with `StructuredOutputIncomplete`) vs the old success-branch `outcome: "succeeded"` — no test pinned the old outcome; more correct. **Deviation:** the double-gap `ctx.log` warning is a `TODO(loop-log)` — the loop has no `ctx.log` facet yet (tool-executor + session only); behavior (the fallback) ships, the warning waits. Gates: workspace typecheck 155/155 0 errors; loop-executor + session + model-executor + spec + app + eval + transport-in-process green; oxfmt/oxlint clean on touched files.

**Last updated (prior):** 2026-07-24 (later-7) — **C1.1 LANDED (Ryan pair-programmed): one grammar for send and skills.run — SkillRunResult DELETED.** Ryan started the generics (SendResult<T>, SessionExecutionHandle<T>) and spotted the deeper cut: with the handle generic the projection wrapper has no reason to exist. Final: SendInput<P, T> (output: StandardSchemaV1<unknown, T>) -> send<T>/run<T> BOTH return Promise<SessionExecutionHandle<T>> — data typed at the call site, streaming/abort/status on the handle, failures ride handle.result. Fable completed the threading (spec protocol, session harness + defineSession one-boundary casts, skills handle/harness/index, docs). This also closes B3 fix #2 (generic typing) ahead of the B3 PR. ALSO: Ryan caught the duplicate-helper disease in the app skills e2e (bespoke mkExecutor while FakeLanguageModelExecutor sat in model-executor) — the canonical fake gained a scripted holdUntil race knob (MockScriptedRun) and the e2e migrated onto it; skills run.spec updated to the handle grammar (rejections surface on handle.result, exactly like send). NOTE for the pending handle audit + structured-output.spec: mkRecordingExecutor in session/**tests**/structured-output.spec.ts is the remaining bespoke executor — migrate in B3. Handle-audit scout DIED on the session limit (resets 4:40pm ET) — re-queue after reset; partial finding: skills has NO wire read (only register/update/remove), prompts lacks list. Gates: typecheck --force 155/155; packages-next 4790/0; no-TLA green.

**Last updated (prior):** 2026-07-24 (later-6) — **TypeScript 7.0.2 (native tsc) adopted workspace-wide.** Root typescript ^5.9.3 -> ^7.0.2 (single declaration point). Migration surface: ZERO tsconfigs used any TS7-removed option; ONE compiler-API consumer outside the website — spec's promise-view.spec.ts (the JSDoc-preservation language-service guard) — moved to the sanctioned @typescript/typescript6 compat package (TS7 ships no programmatic API until 7.1; TypeDoc/website stays on its own typescript 5.9 lane); ONE real type error in 155 tasks (v1 core flatMap union-of-arrays inference — explicit callback return annotation). Measured: per-package check 6-8x (spec 1.25s->0.16s, session 2.06s->0.28s); full --force gate 41-70s -> 30s (build tasks now dominate). Declaration emit verified. Transient empty-output task crashes on the FIRST parallel --force run (cluster-net/ws) did not reproduce — watch once. Gates: typecheck --force 155/155 0 errors; packages-next 4790/0; v1 core 1527/0; no-TLA green.

**Last updated (prior):** 2026-07-24 (later-5) — **C-core LANDED (`skills.run` — the model executes, the skill guides).** `session.skills.run(name, { args?, output?, maxTicks?, signal?, isolate? })` on `SkillsHandle` → `SkillRunResult<T> = { data?, text (:= SendResult.response), usage, ticks, stopReason, executionId }`. A skill run is a `session.send` primed with the skill (INLINE only) riding B2a's `output` end-to-end; the skill stays inert data, the model is the executor (Flue line preserved). **Late-bound capability injection (the D principle applied to harnesses):** the skills harness has ZERO session access (substrate-only construction), so it gains `bindRunner(send)` (the `adoptTelemetry` precedent); the send-capability TYPE (`SessionSendCapability`) + a `RunnerBindable` feature contract + `isRunnerBindable` guard live in `spec-next/session-harness.ts` (NO skills→session-next edge — verified). The App's session-construction fold (after `mountReady`) feature-detects `RunnerBindable` across the extension bridges and injects ONLY `session.send` — generic, no hardcoded slot names (uniform with the `SnapshotCapable` fold, ADR 27). Default composition = `system`-role skill body + framing, then `user`-role serialized args (v2 has no structural `system` field — a `role:"system"` messages entry is the path); `withSkills({ composeRun })` is the `(skill, opts) => SendInput` seam (default shipped, seam is the truth). Reentrancy: a `run` carrying `output` that races an in-flight execution hits the existing `SteerCannotCarryStructuredOutput` guard (documented, not re-added). `isolate: true` → typed `SkillIsolationUnavailable` naming the C2 fork follow-up (never silently inline); a run on an unbound harness → typed `SkillRunnerUnbound`; missing skill → existing `SkillNotFound` propagates (via `require`). **Latent inconsistency fixed:** skills' augment declared `SessionHarnessProtocol.skills` + `HookBridges.skills` REQUIRED — surfaced (once app/session gained a skills devDep) that `SessionHarness` provides `skills` via the dynamic extension-bridge getter, not a class member; made both slots OPTIONAL (`skills?`), uniform with `live` / `prompts`. +14 tests (skills `run.spec.ts` 10 dep-free harness-mechanics w/ stub runner; app `skills-run-e2e.spec.tsx` 4 through `createApp` — proves the injection site + terminal path + steer reentrancy). Targeted suites (spec/session/app 881+, skills 100) green; workspace typecheck 0; oxfmt/oxlint clean. **Deviations:** none — spec assumptions from the C split scout held. **Deferred to C2 (`TODO(C2)` at call sites):** `session.fork()` for `isolate`, `allowed-tools` Skill field + per-execution tool-restriction seam, `skills:run` wire command.

**Last updated (prior):** 2026-07-24 (later-4) — **B2a LANDED (structured execution results — the terminal-tool strategy).** `SendInput.output` (live `StandardSchemaV1`) → `SendResult.data` (typed + validated). A structured result is a synthetic TERMINAL TOOL whose `inputSchema` IS the output schema: the loop resolves the strategy at tick 1 (`"auto"` → terminal tool when the tick exposes model tools, else plain `responseFormat` — `generateObject`'s domain), appends the terminal tool at the TAIL of `compileForTick` (never registered / never dispatched — the LOOP owns it, filters its call out of the dispatch set, and synthesizes its `tool_result` so the timeline pairs), captures the RAW input onto `ExecutionRunResult.terminalCapture`, and the SESSION validates it against the retained schema (`ResponseValidationError` on mismatch — the wire never carries the schema). Stop is steer-proof (`terminalCaptured` short-circuits the tick-end fold, riding the post-fold maxTicks-cap position). Enforcement rung folded in (toolChoice landed): a required terminal that goes uncalled on a natural finish gets ONE forced wrap-up tick (`toolChoice: { tool }`, a hard provider guarantee); at the cap / still-missed → typed `StructuredOutputIncomplete`. Sibling-calls-first (real tools dispatch, terminal capture last, then stop). Tree-tier `<Output schema name? description? strategy?>` authored in compiler-react → `OutputDeclaration` (extended with name/description/strategy) consumed by the loop (send-level overrides; 2+ = `MultipleStructuredOutputs`; terminal-name collision with a model tool = `TerminalToolNameCollision`). `SteerCannotCarryResponseFormat` → `SteerCannotCarryStructuredOutput` (covers `output` too). compileForTick now stably tail-sorts execution-scoped winners (the prefix-cache rule; NO auto breakpoint stamping). Compliance eval EXAMPLE shipped (eval `__tests__/*.example.tsx`, typechecked, NEVER CI-gated). +36 tests (session structured-output 12, tool-executor ordering 2, compiler-react `<Output>` 1, plus the structured-send rename); targeted suites 1377/0; workspace typecheck --force 154/154; oxfmt/oxlint clean. **Deviations reported:** (1) tree-ONLY `<Output>` (no send-level `output`) enforces the terminal + captures, but `SendResult.data` validation for the tree case is the send-level flagship's — the session retains the send schema, not the tree schema (`TODO(b2a-tree-data)`); (2) eval `t.calledTool("submit_result")` cannot observe the terminal (it's delivered, not dispatched — filtered from the dispatch ledger by design); compliance reads from `t.completed()` + validated `data` (`TODO(b2a-eval-terminal-observability)`).

**Last updated (prior):** 2026-07-24 (later-3) — **Canonical toolChoice LANDED (the B2 pull-forward).** `LanguageModelToolChoice = "auto"|"none"|"required"|{tool}` on `LanguageModelParameters` + `SpecConfig.toolChoice` (authorable via `<config>`, per-tick-overlay-injectable — the wrap-up tick's seam) → `buildParameters` lift → all four adapter translations per the ratified table (OpenAI function form; Anthropic any/tool forms incl. ToolChoiceNone; Google functionCallingConfig ANY+allowedFunctionNames; ai-sdk toolName form). providerOptions still spreads last everywhere (per-adapter override-wins tests; ai-sdk's is a coexistence assert — its toolChoice is a sibling call field, cannot collide, deviation reported+accepted). Compiler `Exhausted<UnhandledSpecKeys>` guard forced the ModelForwarded union entry — the conformance guard catching a new SpecConfig key exactly as designed. +10 tests; suite 4750 → 4760/0; typecheck --force 154/154; no-TLA green. B2a TERRAIN SCOUTED (full report in session): loop-side terminal detection hooks at result.toolCalls with stop riding the post-fold maxTicks-cap position (steer-proof); terminal call MUST be filtered from dispatch (ToolHandlerMissing trap — toRegistration stamps handlerRef=id) AND its tool_result synthesized for the timeline (dangling tool_use breaks next send); execution bindings serialize MIDDLE today → compileForTick projection reorder needed for the tail cache rule (no auto breakpoint stamping exists); validated input never reaches the loop → session validates raw capture with the retained schema; OutputDeclaration already COLLECTED into RenderedTree.declarations.outputs (consumer + <Output> component missing); ExecutionRunResult.outputs placeholder waiting; eval package has t.calledTool(name,{input}) deep-equal — compliance eval nearly free; per-tick toolChoice INJECTION path (TickInput.toolChoice) is B2a work. CAVEAT recorded: the scout read the concurrent toolChoice implementer's live edits and reported them 'already landed' — attribute tree state to active implementers. Next: dispatch B2a.

**2026-07-23 (latest) — TELEMETRY WIRING SLICE: de-Effected export + end-to-end threading + gateway inheritance + OTLP sink package (NOT committed; tree dirty for the architect to gate+commit).** Consolidated slice by me (Fable) with 3 partitioned Opus agents (otlp package / runtime testing+drop / gateway), judged + gated + docs by me. Closes the observability story whose facet half landed 2026-07-23 (later). **(1) De-Effected options (spec):** `TelemetryOptions` gains `spanProcessor?: SpanProcessor|SpanProcessor[]` + `metricReader?: MetricReader|MetricReader[]` (standard `@opentelemetry/sdk-*` types at the edge; spec took type-only deps) + `autoDiscover?`; new `TelemetrySink = { spanProcessor?, metricReader?, attributes? }` (a raw object literal IS a valid sink — the escape hatch is the primitive). **(2) `createTelemetry(options, ...sinks): TelemetrySetting`** (app-next) — merges sinks (processors concat, readers concat, attributes merge UNDER options'), eager-validates, honors `OTEL_SERVICE_NAME`/`OTEL_RESOURCE_ATTRIBUTES` env; returns the EXISTING slot type (union does NOT grow; `true`|options|Layer inline forms untouched). **(3) `buildTelemetryExport` (app-next, async):** spanProcessors → tracer Layer via `@effect/opentelemetry`'s `NodeSdk` (merged ADDITIVELY with an explicit `layer`; `Resource.Resource` ROut erased at the boundary — sound, the service is present at runtime) → `ManagedRuntime`; metricReaders → OTel `MeterProvider` → the existing `MetricSink` seam (metrics do NOT ride Effect). **(4) Autodiscovery:** zero sinks + `OTEL_EXPORTER_OTLP_ENDPOINT` set → LAZY import of `@agentick/telemetry-otlp-next` (variable specifier, so app-next takes NO build dep on it); absent package → one-line message, never crash. DELIBERATE divergence from OTel SDK: autodiscover ONLY when the endpoint env is explicit (no silent-localhost spam); `autoDiscover:false` opt-out; same for `telemetry:true`. **(5) End-to-end threading (closes the facet slice's flagged gap):** AppHarness builds the export in an ASYNC `initTelemetryExport` awaited by `appReady` (sessions created only after), threads the resolved `telemetryProvider` to every session's `ToolExecutorHarness` so `ctx.trace`/`ctx.metrics` light up in tool handlers; MeterProvider flush+release on close. **PROVEN e2e** (`app/telemetry-e2e.spec.tsx`): `createApp({ telemetry: createTelemetry({}, spyTelemetrySink()) })` → handler `ctx.trace` span parented under `tool:command:dispatch` + `ctx.metrics` carrying ambient `{tool,op}`, both recorded at the standard-OTel edge (proves the full Effect→@effect/opentelemetry→OTel bridge). **(6) HARD CONDITION resolved — multi-app MetricReader re-bind crash** ("MetricReader can not be bound to a MeterProvider again"): a reader binds to exactly ONE MeterProvider, so TWO apps inheriting one gateway setting (the ernesto+ask shape) crashed the 2nd `new MeterProvider`. Fix = MATERIALIZE ONCE, INHERIT INSTANCES: a refcounted module cache in `buildTelemetryExport` keyed by reader identity binds the MeterProvider once per reader set and shares the (provider-agnostic) `MetricSink`; last app to release shuts it down. New ambient **`app` label** (the app's `name`, low-cardinality) threaded through the tool executor (`defaultMetricLabels`) so shared-sink metrics stay distinguishable. PROVEN (`gateway/telemetry-multi-app.spec.ts`): 2 apps, both metrics reach the sink, no crash. **(7) Gateway inheritance (agent, approved):** `createGateway({ telemetry })` default-chains to every app beneath unless the app supplies its own (app override wins); gateway's OWN ops (wire dispatch/authorize/lifecycle) export via `runGatewayOp` on a gateway tracer runtime; gateway is TRACER-ONLY (metric readers flow to apps — avoids gateway-vs-app double-bind). **(8) `spyTelemetrySink()` in runtime/testing** (records at the OTel edge; `spyTelemetryProvider` kept for substrate-level tests). **(9) `composeProviders` DROPPED** (subsumed by the sink concat-merge) — deletion ledger: fn removed from `runtime/substrate/observability.ts`, export removed from `runtime/index.ts`, test block removed from `observability.spec.ts`; unfiltered sweep clean (only a past-tense lineage comment remains). **(10) `@agentick/telemetry-otlp-next` (154th package):** `otlpSink(options?)` → BatchSpanProcessor + PeriodicExportingMetricReader over OTLP proto/http/grpc; `OTEL_EXPORTER_OTLP_{ENDPOINT,HEADERS,PROTOCOL}` env auto-fill (explicit-beats-ambient per-field; per-key header merge); OTel EXPORTER deps live HERE (app-next stays exporter-dep-free); full new-package checklist (typedoc + vitepress; changeset `linked:[]` = v2 -next untracked, correctly skipped). grpc-headers a documented gap. **DOCS (first-class):** `guide-observability.md` finalized (Incoming fence + wiring-status box REMOVED, §6 primary = createTelemetry+otlpSink zero-Effect + precedence table + Layer hatch labeled, no stale refs); app-next README "Observability & telemetry" (3 forms + createTelemetry/sinks + autodiscovery + never-wrap guardrail + multi-app sharing + app label); gateway README (2 roles + inheritance + tracer-only + multi-app sharing + zero-app-no-metrics + telemetryNamespace-no-cascade KNOWN GAP); runtime README composeProviders line corrected. **KNOWN GAPS (documented, not built):** `telemetryNamespace` does NOT cascade gateway→apps (fiber-context concern, ADR 78 brick #2); active trace/span id not yet stamped on the log envelope. **Gates (mine, verbatim): `pnpm typecheck --force` 154/154 (0 cached); full `npx vitest run packages-next` 4661 passed / 0 failed / 64 skipped (bar 4625 → +36); oxlint 0/0 + oxfmt clean across all 6 touched packages.** **Prior:** **2026-07-24 (later²) — META-DOCS TIER-1 REFRESH: the repo's front doors tell the v2 truth.** Opus (solo, scope-fenced), judged + gated + committed by me. Staleness survey first (matrix in session log), then the unblocked column executed: **reconciler→compiler sweep** (README ×7, CLAUDE.md ×5 incl. subsystem stragglers, both v2 skills, resources.md; grep-proof zero remaining outside generated api/ + deliberate ADR history); **WORKING_NOTES.md + CONTEXT.md archived** to new docs/archive/ (were git-IGNORED all along — .gitignore gained `!/docs/archive/**` so the archive is a committable record); **ROADMAP.md → 11-line pointer** (IMPLEMENTATION-PLAN + STATUS; no competing source of truth); **CONTRIBUTING.md rewritten** (two-tree layout, real example/ dirs, vitest/oxfmt/oxlint/check:no-tla gates, false-green warning, Meszaros /testing law); **AGENTS.md rewritten as the v2 agent entry** (84 lines); **CLAUDE.md factual fixes only** (two-layer architecture diagram, v2 File Locations + labeled v1 sub-table, v1-era banners on legacy patterns — policy untouched); **skills routed** (skills/README.md v1/v2 table; .agents banners → packages-next + v2 gates; 10 malformed path prefixes fixed by architect); **license contradiction resolved**: website footer said ISC, everything else MIT — footer fixed. README code blocks verified against real v2 exports (inputSchema confirmed; zero conceptual errors). **GATED ON POSITIONING (not done):** website index, the 31 v1 docs pages, api/ regen — awaiting the positioning workshop (Ryan brings reference sites) → README-as-first-render → website build. **V2 CUT PLAN pinned in session:** packages-next→packages git mv + -next suffix drop + metapackage + XHarness→X + publishing decisions + front-door flip. **Gates (mine): typecheck --force 154/154 (0 cached); vitest 4713/0; oxfmt clean on touched.** **Prior:** **2026-07-24 (later) — WIRE EXTENSIONS ARE COMMANDS (ADR 90): one row, four surfaces — and two silent lies made true.** Opus (solo, no spawns), interrogated mid-flight on nine named quality points, judged + gated + committed by me. **D1 typed hooks (type-only):** `WireCommandMap = { [K in WireMethod as \`wire:${K}\`]: { input: WireParams<K>; output: WireResult<K> } }`folded into CommandRegistry (interface-extends-mapped-type; re-derives on adopter augmentation) —`onBeforeWire<Ns><Method>`fully typed from the row for framework AND adopter methods; lockstep test covers colon+slash+underscore;`as HookConfig`casts deleted. **D2 define-time op config:** methods entry =`handler | { handler, auth?, guard?, middleware?, spanAttributes? }`(ADR-42 dichotomy; authoring type WireExtensionInput; stored form stays bare handlers + a normalized ext.ops map — ONE downstream representation); auth merges into the single enforcement map (conflict = define-time throw, rule 9); guard/middleware/span compose onto the wire op via the EXISTING tier-4 withCallMiddleware seam, tagged + scopeToCommand'd. **TWO LATENT DEFECTS FOUND+FIXED by the mandated e2e:** (1) wire before-hooks were INERT — runWireDispatch discarded its op input (a onBeforeWire* transform never reached any handler); spec signature now threads`run(params)`, the reshaped value reaches the handler, pinned. (2) op vetoes at the wire edge mapped to opaque InternalError — now deliberate taxonomy: vetoed→Forbidden(-32003), deferred→RateLimited(-32040+retry-after), canceled→RequestCancelled. **D3 e2e** (transport/wire-command-e2e.spec.ts): one adopter method over a real gateway proving journal + typed-hook transform + veto/defer at the JSON-RPC edge + middleware + spanAttributes on the exported span + live ctx facets. **D4:** ADR 90 (settled parts + the DEFERRED in-process lane with both walls verbatim: double-fire/wire:-permanence + identity-through-the-second-door); guide gains "Your method is a command"; freshness audit ALL targets grep-verified — one stale claim found+fixed (guide §1's two-arg defineWireExtension → real object form). **Follow-up queued (named):** nested-op non-leakage e2e for per-method guards (scoping primitive unit-tested; full-session pin rides the Ernesto slice). **Gates (mine): typecheck --force 154/154 (0 cached); vitest 4705/0 (bar 4693 → +12); no-TLA 17/17; oxlint/oxfmt clean.** **Prior:** **2026-07-24 — CLOSE-OUT CLEANUP: the observability arc has no loose ends.** Opus integrator + one fork (see process lesson), judged line-by-line + gated + committed by me. **D1 meter-threading complete**: `BaseHarness.adoptTelemetry(provider, defaultLabels?)`— the ONE late-bind seam (spine harnesses are constructed before the async telemetry switch resolves; docblock states the constraint) +`AppHarness.adoptSpineTelemetry()`fanning provider +`{app}`label to loop/model-executor/compiler (+ setModel-swapped executors); per-harness parity tests + a real-send spine e2e (seenOps-vs-sunkOps proof); both`TODO(observability-runtime-ctx)`markers deleted. **D2 wire-extension ctx facets** (closes`TODO(observability-wire-ctx)`): `WireExtensionContext extends Observability & Ops`; `BaseHarness.defineOperationFacets`extracted — the ONE lazy-getter derivation shared by`buildInterceptorCtx`AND`runWireDispatch`(wire ambient label`{method}`); gateway metricReaders un-strip — it now owns a ctx.metrics surface via the SHARED memoized MeterProvider (per-reader refcounted; multi-app proof still green; constraint comment at the site; README tracer-only claim corrected); e2e: wire handler ctx.trace nests under `wire:<method>`, OFF = frozen no-ops. **D3 no-TLA gate** (the D1-resolution obligation to Knowify's require(ESM) strategy): `scripts/no-tla-gate.mjs`via`pnpm check:no-tla`+ CI step — resolves every publishable package's publishConfig entrypoints (resolve hook reproduces publish-time src→dist rewriting) and require()s each in a fresh subprocess; negative-tested (injected TLA caught directly AND transitively); **17/17 packages pass**. **D4 extraction-safety probe** in`runClientHandleConformance`— bare-destructured subscribe/list/get + Unsubscribe proven this-free for every conformer (6 consumers, 56 tests). **Process lesson banked** (memory: nudge-resumes-agents): the slice's 'ghost writer' saga = the integrator's own FORK executing inherited residual intentions + serial misattribution to an exonerated sibling; contained by single-owner ruling + starvation + evidence (mtime sampling, git-status forensics); zero damage to the branch. Follow-up (mine, queued): move the inline 5-facet wire parity into the existing spec-conformance suites. **Gates (mine): typecheck --force 154/154 (0 cached); vitest 4684/0 (64 skipped); no-TLA 17/17; oxlint/oxfmt clean.** **Prior:** **2026-07-23 (later³) — LOG GROWS UP: RFC-5424 Log hybrid + trace correlation + the middleware facet landing.** Opus, judged + gated + committed by me.`Log`= callable-object hybrid (existing call form verbatim — zero breaks) + all eight RFC-5424 level methods +`warn`alias (METHOD only — the call-string vocabulary stays strict; one severity vocabulary crosses every boundary) +`.with(fields)`pino-canonical child binding; every form = ONE bus emission (ADR-64 invariant held);`createLog`pure factory in spec. Level-mapping deletions: NONE WITH PROOF — LogLevel was already the RFC-5424 eight, MCP projection already identity; e2e now pins it (setLevel("warning") threshold + cross-connection isolation). TRACE CORRELATION REAL: facet-scoped ActiveSpanRef captures {traceId,spanId} synchronously pre-runFork; save/restore nesting; ids ride LogEventPayload; off-telemetry = zero reads (sibling-concurrent ctx.trace cross-attribution caveat documented honestly). MIDDLEWARE LANDING closes TODO(observability-runtime-ctx):`InterceptorCtx = RuntimeContext & Observability & Ops`via lazy getters at liftMiddleware (RuntimeContext stays pure data); proofs: middleware ctx.trace parents under the op span; ctx.run from middleware mints a journaled op. Residual (loud TODOs): meter threading wired tool-executor+session, loop/model/compiler pending; wire-extension ctx facets out of scope. **Gates (mine): typecheck --force 154/154 (0 cached); vitest 4670/0 (bar 4661 → +9); oxlint/oxfmt clean.** **Prior:** **2026-07-23 (later²) — TELEMETRY WIRING COMPLETE: createTelemetry + sinks + otlpSink + end-to-end threading + gateway inheritance.** Parent Opus integrator + 3 partitioned children, judged + gated + committed by me.`TelemetryOptions.spanProcessor/metricReader`(standard OTel types at the edge; Effect Layer constructed internally via @effect/opentelemetry — dual-edge law held);`TelemetrySink`(raw bag IS the hatch; never-wrap guardrail documented);`createTelemetry(options, ...sinks): TelemetrySetting`(slot union unchanged; processors/readers concat, attrs merge env<sinks<options per-key; layer composes additively); NEW`@agentick/telemetry-otlp-next`(3 protocols, env auto-fill explicit-beats-ambient per-field, gRPC-headers gap TODO'd); autodiscovery ONLY on explicit OTEL_EXPORTER_OTLP_ENDPOINT (no silent-localhost; autoDiscover:false opt-out; lazy import, absent pkg = one-line install note). THREADING CLOSED: telemetry reaches ctx.trace/ctx.metrics e2e (spy-proven: handler span under tool:command:dispatch, ambient {tool,op,app} labels) — guide's wiring-status box + Incoming fence REMOVED (§6 primary = zero-Effect form + precedence table). Gateway:`createGateway({telemetry})`substrate-style inheritance (app override wins), gateway ops export via runGatewayOp, TRACER-ONLY at gateway. **MULTI-APP RE-BIND CRASH found by child + resolved**: MetricReader binds once → materialize-once refcounted cache shares the MetricSink across inheriting apps;`app`joined the ambient low-cardinality labels; two-app (ernesto+ask shape) proof green. composeProviders DROPPED (subsumed by sink merge; sweep clean). spyTelemetrySink in runtime/testing. Known gaps documented: telemetryNamespace no gateway→app cascade; gRPC headers; log envelope lacks trace-id (queued). **Gates (mine): typecheck --force 154/154 (0 cached); vitest 4661/0 (bar 4625 → +36); oxlint/oxfmt clean.** NEXT: "log grows up" slice (RFC-5424 levels natively + .with child binding + trace-id stamping + RuntimeContext/middleware facet landing). **Prior:** **2026-07-23 (later) — OBSERVABILITY FACET + THE OPS LADDER +`ctx.run`.** Delegated to Opus, judged + gated + committed by me. Spec facets: `Observability` (`trace(name, fn)`span-only +`metrics.count/record/gauge`, absorbs existing `ctx.log`) and sibling `Ops` (`ctx.run(name, {input?, metadata?, spanAttributes?, signal?}, fn)`— an AD-HOC OPERATION through the full runOperation pipeline: journaled requested→terminal, inherited interceptor fold (string-keyed hooks/guards reach it), outcome taxonomy, span parented in the ADR-77 tree; plus`ctx.runner`narrowed to`OperationRunnerView = { runOperation }` — makeEvent/publish withheld so handlers can't forge envelopes). THE LADDER (docs centerpiece): metrics (count it) < trace (see it) < run (make it an operation) < runner (the primitive) < command (name it for the system); frozen-small RunOptions by design; journaled ≠ MEMOIZED stated loudly (Restate/Inngest expectation disabused; replay not precluded, not built). Landed flat on ToolHandlerCtx + MCP request ctx; RuntimeContext found DATA-PURE → middleware/hot-path landing deferred (`TODO(observability-runtime-ctx)`, lazy-getter mechanism proven). Off-path = frozen no-op singletons (referential-identity tested); MetricSink added to the provider seam; composeProviders kept (drop queued for createTelemetry). spyTelemetryProvider in runtime/testing; runObservabilityCtxConformance + runOpsCtxConformance in spec-conformance. `docs/proposals/v2/guide-observability.md` (DRAFT, 322 lines) — wiring-status box + §6 "Incoming" fence (honest: telemetry:true doesn't reach the ctx facet end-to-end until AppHarness threads the provider). **Gates (mine): typecheck --force 153/153 (0 cached); vitest 4625/0 (bar 4595 → +30); oxlint/oxfmt clean.** **DECISIONS QUEUED (Ryan):** (1) Effect 3.22 bump as own PR — unblocks @effect/opentelemetry, span-side de-Effect (`TelemetryOptions.spanProcessor`), `createTelemetry(options, ...sinks)`+`TelemetrySink`+ OTEL_* env autodiscovery default (design converged in-session; otlpSink ships as its own package per ADR 27); (2) metrics-half via sdk-metrics (unblocked now); (3) AppHarness→provider threading + gateway-level`telemetry`slot (substrate-inheritance pattern) as the wire-it-end-to-end slice. **Prior:** **2026-07-23 — REACT ONE-LINERS:`@agentick/client-react-next`—`useHandle`+`useView`, NO per-handle aliases; plus the `filteredView`ref-stability root-cause fix.** Delegated to an Opus agent, judged + gated + committed by me. New package (153rd):`useHandle(handle)`=`useSyncExternalStore(handle.subscribe, handle.list, handle.list)`— works on ANY`ClientHandle & Enumerable`AND on minted`FilteredView`s (structurally identical); item type inferred from the handle. `useView(handle, opts, deps)`mints`handle.view(opts)`, memoizes, closes on unmount/dep-change; type-constrained to view-capable handles (no faked `.view`). **Aliases REJECTED by consuming-code comparison:** `useTimeline(session)`would be`useHandle(session.timeline)`with zero added typing value — the handle carries its type, so the primitive is the whole surface (README states it; north-star §2 revised to the sharper resolved shape, all lines ✓). **BUG FOUND + FIXED at root (client-core):** slice-4`filteredView.list()`returned a FRESH array per call when filtered — violating the store contract's referential stability (render-loops any`useSyncExternalStore`consumer). Fixed in the SUBSTRATE (lazy cache invalidated at the top of the source-subscribe callback, before fan-out) not in the React binding — the contract honored where the contract lives, for all consumers; ref-identity test added. Bundled handles (knobs/tasks/timeline) verified ref-stable by reading each (fold-held snapshots).`useHandle`deliberately does NOT re-cache — a contract-violating handle surfaces as a render loop the render-count test catches, never papered over. **Follow-up banked:** handles pass`subscribe`/`list`as EXTRACTED functions (safe today — all closures, no`this`); add an extraction-safety probe to `runClientHandleConformance` so a future class-based handle can't break bindings silently. Website: typedoc + vitepress entries added (client-react is the lone client-family entry — the family-wide website sweep stays deferred per the 2026-07-14 note). React 18+ peerDep; changeset skipped (`linked: []`, v2 `-next` untracked — confirmed). 12 tests (render-on-change, ref-stability render-count, view close-on-unmount, SSR snapshot path, real-`tasksHandle`integration). **Gates (mine, combined tree):** typecheck --force 153/153 (0 cached); full vitest **4595/0** (bar 4574 → 4595); oxlint/oxfmt clean. **Roadmap gaps (not built, three-consumers):**`useSend`(rAF-batched),`useItem(handle, id)`. **Prior:** **2026-07-23 — B2 SLICE 5 CORRECTED: the embedded door IS a `ServerTransport` (`fetchServerTransport`; `httpFetchHandler`DELETED).** Born from a Ryan+architect workshop ("should the embeddable gateway live on spec?") — the tension resolved to LIFECYCLE, not types: nothing connected`gateway.close()`to the embedded door (heartbeat intervals kept firing, SSE controllers stayed open, the session map floated). The door is now the FIFTH`ServerTransport`implementor:`fetchServerTransport(options): { transport, handler }`— handler mintable at construction (mount in the host framework at setup time) closing over a null host slot;`transport.listen(host)`binds (idempotent),`transport.close()`sweeps every`FetchSessionConnection.close()`(heartbeat cleared, SSE controller closed) + clears the map + unbinds (re-listen starts fresh); pre-listen/post-close requests → honest 503 with typed`InvalidRequest` (`data.reason:"not-listening"`); in-flight requests pin `boundHost`so a concurrent close can't null the host mid-dispatch;`id: "http:fetch"`. Registered like every edge: `createGateway({ transports: [transport] })`. `httpFetchHandler` deleted outright — no shim, one form; the earlier free-function-vs-`gateway.handler()`question DISSOLVES (the door is owned by injection like every other transport; the contract is spec's`ServerTransport`, the machinery stays at the wire, gateway still knows no HTTP). Proofs now 10 e2e (added: gateway.close() ends a live SSE stream + post-close 503; pre-listen→listen→close cycle) + the 6 `runServerTransportConformance`probes. **Gates (mine, combined tree):** typecheck --force 153/153 (0 cached); full vitest **4595/0**; oxlint/oxfmt clean. **Prior:** **2026-07-22 (later) — B2 SLICE 5 LANDED: THE EMBEDDED GATEWAY (C4.5) —`httpFetchHandler(gateway, { identity })`, the web-standard fetch door.** Delegated to an Opus agent, judged + gated + committed by me. New `@agentick/transport-http-next/fetch`subpath:`httpFetchHandler(host: DispatchHost, options): (req: Request) => Promise<Response>` — mounts in any fetch-native framework (`app.all("/agentick/_", (c) => handler(c.req.raw))`); SAME pipeline as `httpServer`(dispatchRequest, resolveWebSecurity,`BaseConnectionContext`fan-out, SSE codec) behind a web-standard door. **Identity seam (ADR 61 embedded edge):**`identity: async (req) => Identity | Response`— the host's auth piggybacked;`Identity`IS`IngressIdentity` (`{principal, user, scopes}`, NEVER tokens); a returned `Response` short-circuits verbatim (their 401/redirect, nothing reaches dispatch). **Fail closed:** no identity callback → every request 401 (`IngressAuthRequired`, `backend:"embedded"`) — a missing resolver is a misconfiguration, never a silent local-pole admission; the one documented opt-out is `security: "host-managed"`(adopter attests their framework gates access; a supplied identity callback is still honored under it). Scopes flow through the EXISTING`authorizeDispatch`choke point — zero new authz code (proven: claimsAuthorizer denies out-of-scope with -32003). No TCP peer on a web`Request`→`trustProxy`inert (the host terminates the connection); Host/Origin/CSRF still run against headers (cross-site-rejected-when-embedded proven). GET SSE = notification channel, POST = commands/RPCs, identity gate sits BEFORE the method switch (DELETE is behind identity too; the remaining #146 parity gap is session-ownership on teardown, tracked). **Shared extraction:**`BaseConnectionContext.defaultSink()`— the 3 inline`DispatchSink`literals in the Node server deleted, single-sourced (consumed 3× server.ts + 3× fetch-handler.ts). **DEVIATION from north-star's`gateway.handler({identity})`— ACCEPTED as the better shape:** a`.handler()`method needs gateway → transport-http (backwards dep + turbo cycle via the devDep); the free function keeps the arrow honest (transports know the gateway's interface, never vice versa) and types against`DispatchHost`so any dispatch-capable host embeds. The literal method remains available as metapackage sugar at the v2 cut (depends on both) — cut-time decision. 8 e2e proofs through the ACTUAL handler (constructed`Request`s): identity round-trip (spied principal on the dispatched op), Response short-circuit, fail-closed + host-managed, scopes deny, SSE subscribe→frame→teardown, Hono-style mount typechecks. **Gates (mine):** `pnpm typecheck --force`152/152 (0 cached); full`npx vitest run packages-next`**4574 passed / 0 failed** (bar 4566 → 4574); oxlint 0/0; oxfmt clean. **NEXT:** React one-liners (useTimeline/useElicitations/useKnobs), then THE BUILD PIVOT (Ernesto + assistant-api on v2). **Prior:** **2026-07-22 — B2 SLICE 4 LANDED: the client session handle IS a WIRE PROXY + VIEW FACTORY, with ONE middleware seam (SPEC v2,`client-handles.md`§"SLICE-4 SPEC v2").** Delegated to an Opus agent, judged + gated + committed by me. **(1) WIRE PROXY:**`spec/src/client/wire-proxy.ts`derives`session.<ns>.<method>`from`WireMethods`rows via mapped types —`SessionScopedMethod`(params carry`sessionId`and NOT`appId`; the `appId`guard keeps`app/get_session`from minting a bogus`session.app`), `SessionWireNamespace`(excludes`session/_`= the handle's own methods),`WireNamespaceMethods`(params-object minus`sessionId`→`Promise<result>`). **NO index signature / `any`/`Record<string,Fn>` anywhere** — the IntelliSense contract is pinned by type-level tests (`spec/src/**tests**/wire-proxy.type.spec.ts`: namespace enumeration, param/result inference, typo = `@ts-expect-error`, `string extends keyof`= false).`SessionHandle`became a type alias:`SessionHandleBase & SessionHandleExtensions & Omit<wire-derived, registered>` — rich sub-handles WIN their namespace. Runtime (`client-core/handles.ts`): `wrapSessionWireProxy` synthesizes memoized namespace proxies for unregistered namespaces (`then`/symbol-guarded, CAST to the mapped type, never widened) issuing `client.request("<ns>/<m>", { sessionId, ...params })`. **ZERO-CLIENT-CODE VERTICAL PROVEN e2e** (`client/src/**tests**/wire-proxy-middleware-e2e.spec.ts`): a `WireMethods`row + a gateway handler and`session.testns.doThing({ count: 7 })`round-trips typed — no client code. **(2) VIEW FACTORY:**`filteredView` (`client-core/view-source.ts`) — a minted view is a filtered projection SHARING the handle's ONE wire subscription (adds a listener, never a `transport.subscribe`); `session.timeline.view(opts)`layers on the`timelineView` seam; fan-out proven (`timeline-fanout.spec.ts`: two views, `subscribeCount === 1`, independent close, handle-close closes all). `filter`only this slice; BYO`{initial,reduce}`deferred (third-consumer rule). **(3) ONE MIDDLEWARE SEAM (§7):**`ClientMiddleware`(spec) +`client.use(mw)`— around middleware on EVERY derived method;`ClientHookRegistry`class +`dispatchWithHooks`DELETED,`client.hook`/`client.hooks`reimplemented as method-scoped sugar over`use`(before/after→around adapter; no second interception path); sub-handle writes covered via`withMiddlewareTransport`(factories get a client whose`transport.request`funnels through the chain — universality with zero per-handle rewiring); per-handle`session.knobs.use(mw)`= namespace-guard sugar. Universality proven: one`client.use`observed on`knobs/set`AND zero-code`testns/doThing`. **As-if-planned pass (mine):** `hook-registry.ts`→`hook-keys.ts`(holds only`commandForMethod`; no registry, no archaeology docblock); unfiltered grep for `ClientHookRegistry`/`dispatchWithHooks`/`hookRegistry` = 0 hits. Kit-tier fold exports (`channelView`/`eventView`/`channelStream`/`eventStream`/`liveStore`) DEMOTED by barrel docblock with `TODO(slice-5-sweep)`→`/kit`subpath once the ~4 harness`/client`imports migrate in one sweep. **Gates (mine, run twice — pre + post rename):**`pnpm typecheck --force`152/152 (0 cached); full`npx vitest run packages-next`**4566 passed / 0 failed** (64 skipped; bar 4552 → 4566, +14 proofs); oxlint 0/0; oxfmt clean. **Open:** row-docblock → client-method hover propagates for params members (homomorphic`Omit`) but the row-KEY docblock through key-remapping needs a manual editor hover check (flagged, not asserted); Q#8 client.status; guide gained Verified-by pointers (additive only). **NEXT:** slice 5 — embedded gateway `gateway.handler({ identity })`(C4.5 design), then React one-liners, then THE BUILD PIVOT (Ernesto + assistant-api on v2). **Prior:** 2026-07-21 — TOOL-CONFIG RESTORATION PASS B (tool-call presentation) BUILT. NOT committed.** Restored v1's`displaySummary`+ added model-self-narration, reusing v2's existing pipes (schema projection + the tool lifecycle events). **Spec:**`ToolAnnotations`gains`title`/`displaySummary`(string |`(input,ctx)=>string`seam, erased on the wire) /`narrate`; new RESERVED `TOOL_NARRATION_FIELD = "\_summary"`const +`ToolPresentation`interface in`data/declarations.ts`; `DispatchResult.presentation`+`LifecycleToolEnd.presentation`+`LifecycleToolStart.narration`slots;`narrate?: boolean`threaded onto`ProjectInput`/`RunInput`/`RunExecutionInput`/`SessionHarnessOptions`/`CreateSessionInput`/app options. **Pipe 1 — injection (`model/canonical-projection.ts` `buildTools(tools, narrate=true)`):** injects an optional `\_summary`string property into each model-facing tool JSON schema, gated on`narrate && annotations.narrate !== false && !schema-already-has-\_summary`; never in `required`; shallow-copies (never mutates the shared cached raw schema). **Pipe 2 — strip+resolve (`tool-executor/harness.ts` `dispatchBody`):** strips `\_summary`from the raw input BEFORE validation (shallow copy, MODEL-DOOR ONLY — never reaches handler/tool*result), then resolves`presentation` as FOUR DISTINCT fields (`name`/`title`/`summary`/`narration`, NEVER collapsed — the framework presumes no precedence; the client composes identity `title ?? name`+ activity`narration ?? summary`) — the SINGLE resolution site (holds all sources + validated input) — onto `DispatchResult.presentation`. (Corrected from an initial collapsed-`summary` build per Ryan: title=identity and summary=activity are distinct, both surfaced.) **Surface:** loop (`loop-executor/harness.ts`) reads the eager narration off `tc.input`for the`tool-start`spinner (live, pre-dispatch) + threads`DispatchResult.presentation`onto`tool-end`; both REUSE existing lifecycle events. **App-level off-switch** (token cost is real): `createApp/createSession({ narrate:false })` cascades app→session→`runExecution`→`ProjectInput.narrate`→`buildTools`; default ON. `createTool`surfaces`title`/`displaySummary`/`narrate`typed to`TInput`. Gates: `pnpm typecheck --force` 152/152 (0 cached); root vitest tool-executor/tool/model/spec/loop/session/app/executor/model-anthropic 1316 passed +16 new (`model/…/narration-injection.spec.ts`8,`tool-executor/…/narration-strip.spec.ts`8); oxfmt clean; oxlint 0 errors. Docs: tool-executor README §"Tool-call presentation" (precedence + reserved field + TOKEN-COST + off-switch) + model README §"Tool-call narration injection" + both Verified-by. **DEVIATION from the contract's locked assumption (reported):** tool-start is emitted by the LOOP \_before* dispatch resolves, so the full precedence chain (which needs post-validation`displaySummary`) can't ride tool-start — per the contract's STEP-3 fallback, the resolved `ToolPresentation`rides`DispatchResult.presentation`+`tool-end`, and only the eager model `narration`rides`tool-start` (which is exactly the live spinner value). **Prior:** 2026-07-20 — STORE CONVERGENCE RUN 1 (`Store`universal):`Store`is now the ONE store contract — zero store-level straddle. NOT committed.\*\*`CollectionStore<T,Q,PruneArg> extends Store<T, Q, CollectionMutation<T>>`and`LogStore<T> extends Store<T, LogQuery, LogMutation<T>>`are formal profiles over the seam (new`LogQuery`/`LogMutation<T>`in`spec/protocol/log-store.ts`, derived from the real `read`/`history`/`append`params);`CredentialsStore extends Store<CredentialEntry, CredentialQuery, CredentialMutation>`conforms too (kept its value-projecting`get`/`set`/`has`/`keys`sugar — the seam is no more value-exposing than`get`, and the store is server-resident so no wire concern). Every concrete store now implements `query`/`mutate`: the in-memory defaults (`MemoryCollection`/`MemoryLog`+ the composing`InMemoryTask/Session/Resource`stores +`InMemorySkill/PromptStore`), the generic decorators (`IdempotentCollectionStore`—`mutate`routes through the dedup path;`JournalProjectedStore`—`query`=fold, `mutate`=no-op, matching its no-op `put`/`delete`), and the adapters (`PostgresTaskStore`, `FsTimelineStore`, `PostgresTimelineStore`). The Cut-1 `TODO(store-cut2)`coexistence markers (memory-collection, skills, prompts) are gone. Gates:`pnpm typecheck --force`152/152 (0 cached); root`vitest`touched packages 1283 passed + timeline-fs conformance 19 (postgres conformance skipped, no DB); oxfmt clean; oxlint 0/0. Docs:`store.md` (BUILT + convergence-cuts LANDED), this entry.

**2026-07-15 — ADR 88 LIVE MEDIA SESSIONS v0 core SCAFFOLDED: `@agentick/live-next` (harness + handle + routing + wire + client), FAKE-transport unit tested. NOT committed.** New OPTIONAL package (like sandbox/mcp, NOT bundled). **Spec (`spec-next`):** `data/media.ts` (`MediaFrame`/`MediaEnvelope`/`MediaSessionRef`/`LiveState`/`TranscriptDelta` + the `MediaTransport`/`MediaUplink`/`MediaDownlink` capability, `openUplink`/`openDownlink`, `send`+`close` verbatim from ADR 88 §Two planes — `MediaDownlink` I spelled out as `onFrame`+`close` since the ADR left the downlink mirror implicit); `protocol/live-harness.ts` (`LiveHarnessProtocol` + `LiveStream` context + `Live` alias); `client/live.ts` (`LiveSessionHandle` portable surface — NO stream types); `readonly media: boolean` added to `TransportCapabilities` (REQUIRED per the ADR → swept `media: false` onto all 4 transport impls + 6 client-core test literals; no-backcompat). **Package (`live/`):** `harness.ts` (`LiveHarness extends BaseHarness<"live">` — stream registry keyed by streamId, `start`/`push`/`interrupt`/`stop`/`close`, uplink fan-in + downlink sink + transcript/state channels), `augment.ts` (`HookBridges.live?`+`SessionHarnessProtocol.live?`, OPTIONAL slots), `extension.ts` (`withLive({ onStream })` = bare SessionExtension mirroring withTasks/withSandbox — self-constructs the harness + `registerNamespace("live")`), `wire.ts`+`wire-augment.ts` (`liveWireExtension`), `channel.ts` (live-transcript/live-state), `client/` (`liveSessionHandle` with `uplink: WritableStream`/`downlink: ReadableStream` runtime projections over `sendFrame`/`onFrame`; `sessionLive` facet with `start()`/`active`; `register.ts` → `session.live`). **DELIBERATE DEVIATIONS from the two things ADR 88 explicitly enumerates (flagged for review):** (1) added a THIRD wire method `live/interrupt` (ADR §Two planes names only start/stop) — the `LiveSessionHandle.interrupt` spec method is a genuine client→server signal distinct from stop (keeps the stream open, carries playedMs), so folding it into stop would misrepresent it; (2) added `LiveStream.onInterrupt` (not in the ADR's explicit `LiveStream` member list) — the interrupt signal must land somewhere for the app to compose barge-in, which the ADR itself prescribes. **Wire registration is OPTIONAL not builtin:** `liveWireExtension` is exported for the adopter to pass to `createGateway({ wireExtensions })`; NOT added to `app-next`'s `builtinWireExtensions` (confirmed sandbox/mcp have no client↔gateway wire ext — live is the first optional one; the `ExtensionBundle.wire` seam exists but withMCP/withTasks are bare SessionExtensions, so I mirrored that + separate export). **Deferred (ADR 88 Future directions, NOT built):** real WS/binary `MediaTransport` (`transport-ws-media-next`), `pipelineEngine`, `SttEngine`/`TtsEngine`, `TurnArbiter`, `RealtimeModel`, driven-loop, per-op hooks. Gates GREEN: `pnpm typecheck --force` 150/150 (0 cached); `vitest run live spec` 542 passed (live: wire 6 + harness 14 + client-handle 11 = 31); oxfmt clean; oxlint live 0/0. Checklist done EXCEPT `.changeset/config.json` `linked` is `[]` (no linked group for -next pkgs — nothing to add); typedoc + vitepress nav + README added; `pnpm install` ran. **Prior:** 2026-07-15 — CHANNEL READ STACK: `channelStream` (ground-floor primitive) + `channelView` (fold sugar) unified; elicitation converged; `onChange`/`subscribe` semantics corrected.** A design-workshop-driven refactor of the client read surface (ADR 33). **The one truth is the frame stream, not the view.** New `channelStream(client, scope, channel)` in client-core — a channel's ordered frame-payload stream (snapshot-first then deltas), materializes nothing, single-consumer (`for await` OR `onChange`); it's the general construct for ANY state shape (value, large collection, paginated, request/event). `channelView` REFACTORED to fold OVER `channelStream` (was: called transport.subscribe itself), with the corrected two-feed surface: **`subscribe((state) => …)`** (STATE feed — the folded value; also the `useSyncExternalStore(subscribe, get)` contract, React ignores the value we hand it) + **`onChange((frame) => …)`** (CHANGE feed — each frame it folds, NOT the whole state) + **`status: "loading"|"live"|"closed"`** (readiness; replaces `closed`). `ChannelView<T>` → `ChannelView<T, F=unknown>`. This corrects the `onChange(fullState)` I'd shipped hours earlier — the payoff shows in the coding example: tasks' `seenTasks` dedup Set is GONE (`session.tasks.onChange((task) => …)` hands the one changed task; `session.knobs.subscribe((knobs) => …)` hands the full store). **Elicitation converged onto the uniform read surface:** the bespoke `ClientElicitationStream` + `session.onElicit` are DELETED — `session.elicitations` is now a `ChannelStream<ClientElicitationHandle>` (opts out of the fold — each frame is a discrete request, not state; taps the envelope for correlationId but PRESENTS the uniform `ChannelStream`), consumed via `session.elicitations.onChange((e) => e.accept(...))` — identical read surface to tasks/knobs. So the invariant now holds: **every channel reads through `channelStream`/`channelView`; the only per-channel variation is the state/frame TYPE and the domain WRITE commands (`knobs.set`/`e.accept`/CQRS).** Rippled through spec (ChannelStream + ChannelView types) + client-core (impl + 2 new tests) + knobs/tasks façades (F param) + elicitation (+e2e dogfoods it) + the example. Workspace typecheck 149/149; affected suites 376 green (+ channel-stream 3 + status/onChange tests). Docs: client-core README (channelStream primitive + two-feed rule). NOT committed yet. Also this session (prior, committed): ergonomic sugar (`inProcessTransport({ gateway })` killed the DispatchSink boilerplate; onChange/onElicit) `1bf5b787`; eval trials+pass@k `bf428407`; eval HTML report `d9c16ebf`. **Prior:** 2026-07-14 (later¹⁰) — EVAL-NEXT: RUN-ACCESS + SCORES + THE `t` PLUGIN SEAM + workspace/judge plugins + a coding-agent eval.** Extended `@agentick/eval-next` (was MVP: `defineEval` + 4 imperative assertions) into a maximally-useful agent-eval surface, grounded in its "vitest for agents" model (NOT a Braintrust rewrite). **Core:** (1) `t.result` exposes the full `SendResult` (usage/ticks/output/toolResults — was fetched-and-dropped); (2) `t.expect(label, passed)` (generic boolean scorer, gates `passed`) + `t.score(label, value)` (numeric, does NOT gate — aggregated across matrix); (3) `formatResult`/`formatMatrix` console scorecards. **The plugin seam (the `t` extension mechanism Ryan asked for):** `EvalContextExtensions` empty seed + `EvalContext extends` it + `registerEvalPlugin` (global install-to-appear) / per-eval `plugins: []` — the SAME ADR-27 augmentation law as HookBridges / SessionHandleExtensions / ToolHandlerCtxExtensions. A plugin is `(rc: EvalRunContext) => methods` merged onto `t`; `rc` gives `result()`/`toolCalls`/`record`/`score`. Runner types the base literal as `Omit<EvalContext, keyof EvalContextExtensions>` (same trick as makeSessionHandle) so downstream augmentation doesn't break the core compile. **Two first-party plugins (subpaths, prove the seam):** `/plugins/workspace` (`t.sh`/`t.file` — EXECUTABLE scoring: grade coding agents by RUNNING the result, SWE-bench model) + `/plugins/judge` (`t.judge(rubric)` — LLM-as-judge, model-agnostic via injected `generate`, records assertion + score). `declare module "@agentick/eval-next"` self-augmentation from a subpath works. **The coding-agent eval (`example/v2-coding-agent/src/eval/coding.eval.tsx`):** executable (`t.file`/`t.sh` run the produced code) + trajectory (`t.calledTool`) + budget (`t.result.ticks`) + judge, ~15 lines; `codingEval.matrix({ model: [...] })` benchmarks across models. Agent runs headless (`setAutoApproveWrites(true)` — evals have no client to answer write*file's elicitation; `t.onElicit` is the follow-on). 5 new tests (16 total, all green), workspace typecheck 149/149. Roadmap-aligned names kept for the rest (`t.onElicit`/`t.stubTool`/`t.withinBudget`/trials+pass@k). **Prior:** 2026-07-14 (later⁹) — NEW EXAMPLE `example-v2-coding-agent`: the client-ergonomics forcing function, end-to-end.** A naive coding agent (server-side JSX: `read_file`/`list_dir`/`grep` + `write_file` gated behind `ctx.elicit.confirm(...)` + `run_shell` via `ctx.tasks.submit(...)`, a `explainSteps` knob, real OpenAI model) driven by a decoupled client over the in-process transport. The client uses ONLY `@agentick/client-next` (the bundle) — proving install-to-appear: `session.knobs` (live view + client-driven `set` = CQRS), `session.tasks` (live status from run_shell), `session.elicitations()` (auto-approves write_file), `handle.events()` streaming (`content-delta`/`tool-dispatch-start`), `session.onLog`. Typechecks clean against live v2 packages (standalone `tsc --noEmit` EXIT=0); runs with an OPENAI_API_KEY. Borrows tentickle's prompt tone (ACT-don't-narrate / list→grep→read / edit>write) + mirrors `v2-otto`'s task-tool pattern. Validated real API surface: `gateway.createApp({appId, rootElement, options:{model, reconciler: reactReconciler()}})`, tool-handler `ctx` (`elicit.confirm`→bare-boolean reply, `tasks.submit`, `log`), client `handle.events()` StreamEvent union. Files: `src/{tools.tsx,agent.tsx,server.ts,client.ts,index.ts}` + README + .env.example. **Prior:** 2026-07-14 (later⁸) — CLIENT CORE/BUNDLE SPLIT: `@agentick/client-next` is now the batteries-included DEFAULT; `@agentick/client-core-next` is the lean core.** Ryan's call (cleaner than an interim `client-bundle-next`): invert the naming so the default name gives you everything. `git mv client → client-core` (renamed `@agentick/client-core-next`, the agnostic core — createClient/makeSessionHandle/registry/handles, deps NO harness) + a NEW `@agentick/client-next` in `packages-next/client` (the bundle — 3 side-effect imports of `tasks`/`knobs`/`elicitation` `/client` + `export * from client-core-next`, zero logic). At the v2 cut → `@agentick/client`(bundle) +`@agentick/client-core`(core). Uniform sweep: EVERY current`@agentick/client-next`import/dep is a CORE usage → 59 files rewritten to`client-core-next`(harness /client packages MUST dep the core, never the bundle = cycle); the freed`@agentick/client-next`name is the bundle. **NO CYCLE** (bundle→harnesses/client→core; core→nothing). **Bug the rename EXPOSED + fixed:** the bundle is the first place`knobs/client`compiles OUTSIDE the knobs package, and`knobs/set`(a`WireMethods`augmentation in the server-side`augment.ts`) wasn't in scope → split it into a type-only `knobs/src/wire-augment.ts`that BOTH the server augment AND the`/client`index side-effect-import (zero runtime, no server code in a browser bundle). Proof: workspace typecheck **146/146** (was 145 — +1 net package); bundle test (registry has all 4 slots + a session handle self-assembles`.tasks`/`.knobs`/`.elicitations()`/`.respondToElicitation()`); client-core+tasks+knobs+elicitation+transport-in-process suites green (171). Docs: bundle README + core README (retitled, metapackage note points at the `client-next`bundle) + ADR 87 §9 (packaging) + tasks/knobs/elicitation/client-extensions READMEs swept (their client dep is the core). Adopter-client refs (root README, gateway/tool-executor READMEs) STAY`@agentick/client-next`(still valid — the bundle IS what an app installs). PRE-EXISTING gap noted: the v2 client family (client-next/client-core/client-extensions) isn't in the website typedoc/vitepress nav — deferred with the rest of the v2-website wiring. NOT committed yet. **Prior:** 2026-07-14 (later⁷) — ELICITATION IS NOW A CLIENT REGISTRANT: client-core is fully harness-agnostic (ADR 87 thesis complete).** The last hardcoded harness surface in client-core is gone.`client/handles.ts` held ~120 lines of elicitation-specific code (`makeElicitationStream`/`parseElicitation`/`wrapHandle`/`ELICITATION_CHANNEL_FQN`) + the `elicitations()`/`respondToElicitation()`methods baked into`makeSessionHandle`+ the two methods declared on the spec`SessionHandle`— a direct ADR-27/87 violation (client-core is supposed to know about NO harness, exactly as it now doesn't for tasks/knobs). MOVED to`@agentick/elicitation-next/client`(new subpath):`elicitations.ts`(impl, retyped against`ClientProtocol`) + `register.ts`(augments`SessionHandleExtensions`with`elicitations`/`respondToElicitation`, registers both). **API UNCHANGED** — a registrant slot may be a METHOD (the lazy getter yields the function), so call sites keep `session.elicitations(opts?)`/`session.respondToElicitation(input)`; only a side-effect `import "@agentick/elicitation-next/client"`is added. Spec`SessionHandle`lost the two methods (now contributed via augmentation); the client elicitation TYPES stay in`spec/client/elicitation.ts`(protocol-shaped, like the rest of`spec/client`). elicitation-next gains a `client-next`dep — NO CYCLE (client-next deps zero harnesses; direction is harness→client, same as tasks/knobs; the`/client`subpath pulls only spec+client+utils+the pure channel constants, never the server harness). Proof: workspace typecheck 145/145; transport-in-process elicitation e2e (6) + unit (3) GREEN through a real gateway+client, driven purely by the side-effect import; client+elicitation suites 157 total. Elicitation is now the 3rd/4th registrant (tasks, knobs, elicitations, respondToElicitation). **SURFACED CONSTRAINT (Ryan's call):** the "always available automatically" bundling belongs in the public`agentick`metapackage's`/client` entry (`import "@agentick/{tasks,knobs,elicitation}-next/client"`— the client twin of how it bundles server built-ins), NOT client-core (agnostic by design; self-bundling = the cycle). But`packages/`+`packages-next/`are ONE pnpm workspace and`packages/agentick`already owns the name`agentick`, so the v2 metapackage is name-blocked until the v2 cut. Interim options pending decision: (A) v2-named client-bundle package now [needs a name], or (B) defer to the cut + document the metapackage bundle-list. **Prior:** 2026-07-14 (later⁶) — `taskStatusView`OPEN-WITH-SNAPSHOT:`session.tasks`now survives reconnect/late-subscribe.** Closes the substance gap flagged after the ADR 87 seam — the task-status channel previously had NO opening snapshot, so a subscriber saw only tasks that transitioned AFTER it joined (never a backfill of the existing list). Now`TasksHarness implements ChannelSnapshotProvider` (`snapshotChannel = "task-status"`; `channelSnapshotPayload()`returns`{ kind: "snapshot", tasks: this.list() }`from the live projection) → the session's generic bridge scan discovers it →`sub/subscribe`prepends the snapshot as frame one (K8s watch-list model, same seam knobs uses). Delta frames stay BARE`TaskInfo`(byte-identical, MCP conceptual-mirror preserved — the substrate channel is independent of the MCP`notifications/tasks/status`path via`task-bridge.ts`, verified); only the OPENING frame is discriminated (`kind: "snapshot"`), and the client `taskStatusView` reduce distinguishes structurally (`"kind" in frame`seeds the whole store; else folds the bare delta by taskId). 3 new tests (harness provider payload reflects live tasks; client seeds-from-snapshot-then-folds-deltas; existing bare-delta fold unchanged); tasks+session suites green (134), workspace typecheck 145/145. NOT committed yet. **STILL OPEN (ADR 87 follow-ups, deferred):** verb-alignment on the server/client`session.tasks`/`.knobs`twin (client replica's`get()`/`set()`signatures diverge from the server authority's — CQRS-justified, documented, but the \_great* version aligns the vocabulary);`enumerate`+ reconnect re-seed as a first-class client-extension composition; elicitation/resources/mcp as further registrants; client metapackage (bundle the built-in`/client`subpaths) once ≥3 registrants; ui-core multi-session firehose (the "listen to N sessions at once" ask — explicitly low-priority per Ryan). **Prior:** 2026-07-14 (later⁵) — ADR 87 CLIENT SUB-HANDLE SEAM BUILT:`client.session(id).tasks`/`.knobs`self-assemble (install-to-appear). The client twin of the server's`HookBridges`.** Workspace typecheck **145/145**; client+tasks+knobs suites green (296 passed, 6 new tests). The obvious-but-missing API: a harness's client façade (`taskStatusView`, `knobsHandle`) was arg-only (`taskStatusView(client, id)`) — you had to know it existed and wire it by hand. ADR 87 makes it a NAMED SLOT on the generic `SessionHandle`, contributed by the harness `/client`package via the SAME module-augmentation law as the server bridges (ADR 27). **(1) Spec seed:** empty`interface SessionHandleExtensions {}`in`spec/client/handles.ts`(twin of the empty`HookBridges`seed);`SessionHandle extends …, SessionHandleExtensions`. **(2) client-core registry (`session-handle-extensions.ts`):** `registerSessionHandleExtension(name, (client, sessionId) => sub)`+`applySessionHandleExtensions(handle, client, id)`spreads each registered factory as a **lazy, cached getter** that skips any name already on the handle (never shadows a real member).`makeSessionHandle`types its literal as`Omit<SessionHandle, keyof SessionHandleExtensions>`(full base-checking, drops the augmented slots the getters add) then`applies…`+ returns`as SessionHandle` — so the slot stays **NON-optional** (`session.tasks`, not `session.tasks?.`) in a harness compilation while client-core stays agnostic. **(3) First registrants:** `@agentick/tasks-next/client`→`session.tasks` (`ChannelView<Record<taskId, TaskInfo>>`=`taskStatusView`); `@agentick/knobs-next/client`→`session.knobs` (`KnobsHandleView`=`knobsHandle`, read view + `set`). Each is a 3-part `register.ts` (`declare module`slot +`registerSessionHandleExtension`+ side-effect import from the`/client` index). Install-to-appear: importing the subpath is the ONLY thing that makes the slot exist — same as the server's bundled-vs-optional packaging law. Closes the "`client.session(id).knobs`sugar" follow-up flagged in the 2026-07-12 (later⁴) channel-arc entry. Docs: client README §"Session sub-handles — install-to-appear (ADR 87)" (usage + how-to-publish-your-own). Prior tiny build this session:`taskStatusView` (`2058996e`) + ADR 87 draft (`0e7908d4`). NOT yet committed (seam left in tree). **Prior:** 2026-07-14 (later⁴) — ADR 84 GATEWAY PROGRAM COMPLETE: full hookable op surface + canonical lifecycle. 3 commits (`ea96cfa4`, `fcd563be`, `a3683038`) close it out; workspace 145/145, gateway+transport+connector+spec green.** **(1) `gateway:create-app`+`authorizer:authorize` (`ea96cfa4`, §4/§5):** createApp normalizes both overloads then wraps the mount in a `gateway:create-app`op →`onBeforeGatewayCreateApp`(veto/transform, e.g. tenant-scoped appId) /`onAfterGatewayCreateApp`; a `mapGatewayError`routes`GatewayClosedError`/`AppAlreadyExistsError`through the op Fail channel so`instanceof`survives.`authorizer:authorize`is the FINE contextual auth layer —`gateway.authorize(input)`wraps`authorizer.authorize` in an op (`onBeforeAuthorizerAuthorize`adds contextual scopes / denies,`onAfterAuthorizerAuthorize`audits);`dispatch.ts`routes the verb-scope + additive-role policy calls through`host.authorize`. **The structural ceiling (`requiredScopes`/`scopeCovers`) stays a direct, un-waivable check OUTSIDE the op** — proven by a test where the ceiling denies regardless of a maximally-permissive hook (which never fires). **(2) LIFECYCLE CANONICALIZATION (`fcd563be`, breaking):** `listen()`is now ENFORCED — the gateway starts UNSTARTED;`createApp`throws the new`GatewayNotStartedError`until`listen()`runs (a pre-gate before the op; closed-check wins). This makes the`gateway:start`seam structurally guaranteed (space for future framework startup logic) and gives ONE canonical start call.`closeGateway()`DROPPED (no deprecation) —`close({ drain })`is the sole terminal verb (pairs with`listen()`, matches `app.close()`). Swept ~103 `closeGateway→close`, 13 test files gained `await gateway.listen()`, every doc example is now `createGateway → listen() → createApp → close()`. **(3) `gateway:accept` (`a3683038`, §4, the LAST op):** `gateway.accept(info: ConnectionInfo)`wraps a`gateway:accept`op →`onBeforeGatewayAccept`(throw to REJECT the connection) /`onAfterGatewayAccept`; guard-able. It's a CONNECTION concept, so only connection-oriented transports fire it AFTER ingress-authn, BEFORE frames: WS (`wss.on("connection")`→ reject =`ws.close(1008)`), Unix (`netCreateServer`cb → reject =`socket.destroy()`); **HTTP deliberately does NOT** (request-oriented — its admission IS the per-request `authorize`path; code comment explains).`transportId` threaded from each wrapper's stable id (`websocket:${port}`, `unix-socket:${path}`) for per-peer rate-limiting. Real-loopback proof: a throwing `onBeforeGatewayAccept`drops a live WS (close 1008) + Unix client connection; a permitting hook round-trips ping, firing once. **The gateway op surface is now:`gateway:start`·`gateway:close`·`gateway:create-app`·`authorizer:authorize`·`gateway:accept`·`wire:<method>` — all hookable, HOOK-LIFECYCLE "Planned — ADR 84" section now empty/landed.** Prior (earlier 2026-07-14): the foundation — live interceptor inheritance (`c3cec53c`, gateway hooks fold live gateway→app→session→subs), `wire:` prefix (`39c4fb88`, no double-fire), client wire hooks (`df2b6acf`), listen/close lifecycle + gateway→app capstone (`1f46ed22`) — see the `ca647896`status entry. **Prior:** 2026-07-14 (later³) — CONCRETE`ServerTransport`WRAPPERS LANDED (ADR 84 §2). The follow-on to the abstraction is now FILLED — all four factories ship.** Not yet committed (left in tree). Workspace typecheck **145/145**; the four transport packages + gateway suites green (29 new tests:`runServerTransportConformance`× 4 = 22 + real-bind/gateway tests). Each factory inverts the raw shape — **wire config binds at construction; host is injected at`listen(host)`** — and lives at each package's `./server` subpath (`inProcess`at the package root). **(1)`webSocketServerTransport({ port, host?, … })`** (`transport-websocket/src/server/transport.ts`): OWNS the Node `http.Server`—`websocketServer`only ATTACHES a WS upgrade handler, binds no port, so`listen(host)`does`createServer()`→`websocketServer({ httpServer, gateway: host })`→`httpServer.listen(port)`; `close()`tears down BOTH the WS handle and the server it created. **(2)`httpServerTransport({ port, host?, … })`** (`transport-http/src/server/transport.ts`): same http-server ownership (the raw `httpServer`mounts on a caller-supplied Node server via`on("request")`). **(3) `unixSocketServerTransport({ path, … })`** (`transport-unix-socket/src/server/transport.ts`): simplest — `unixSocketServer`binds its own`net.Server`, so the wrapper just defers the host and awaits the `listening`event;`close()`closes the socket (Node unlinks the path). **(4)`inProcessServerTransport()`** (`transport-in-process/src/server-transport.ts`): direct-call transport — the in-process client reaches the gateway through an adopter-built `handler`closure, NOT a bound listener, so`listen`/`close`are HONEST no-ops (documented). Exists so an in-process deployment lists its transport alongside the network ones and`gateway.listen()`fan-out stays uniform; stable id`"in-process"`. Both WS and HTTP also accept `{ httpServer }`(adopter-owned server) — attached, never closed. KEY FINDINGS: (a) no port-discovery accessor on`ServerTransport`, so real-bind tests grab a free ephemeral port via a throwaway probe listener, then hand it to the wrapper — teardown is proven by re-binding the freed port (avoids fighting the client reconnect machinery — `reconnect` is a policy object, not a boolean). (b) config-derived ids (`websocket:${port}`, `unix-socket:${path}`, `http:${port}`, `in-process`) — no module-level `ulid`/counter, so oxlint's no-mutable-counter rule is satisfied by construction. (c) `DispatchHost = GatewayHarnessProtocol`, so the raw factories' `gateway: DispatchHost`slot takes the`listen(host)`host directly — zero adapter. Docs: all four package READMEs (factory +`createGateway({ transports })`example + Verified-by row); ADR 84 §2 + §7 flipped to LANDED with the four signatures.`transport-next/src/server/dispatch.ts`+`gateway/src/harness.ts`untouched (owned by the next change). **Prior:\*\* 2026-07-14 (later²) —`ServerTransport` ABSTRACTION + GATEWAY OWNERSHIP (ADR 84 §2).

**2026-07-14 (later²) — `ServerTransport` ABSTRACTION + GATEWAY OWNERSHIP (ADR 84 §2). The `listen()`/`close()` transport fan-out TODO is now FILLED.** Not yet committed (left in tree). Workspace typecheck **145/145**; gateway+spec+spec-conformance suites **600/600 green** (12 new gateway tests). **(1) Spec (`packages-next/spec/src/server/transport.ts`, new `server/` subpath):** `ServerTransport { id; listen(host: GatewayHarnessProtocol); close() }` — the symmetric server-side mirror of `client/transport.ts`. Uses `GatewayHarnessProtocol` DIRECTLY (not transport-next's `DispatchHost` alias — spec must not dep on transport-next). Wire config (port/path/tls) binds at the transport's construction; the one thing only the gateway supplies at listen-time is itself as host, so `listen(host)` is uniform. **(2) Gateway ownership (`gateway/src/harness.ts`):** flat `transports?: readonly ServerTransport[]` on `GatewayHarnessOptions` (withX convention, no `config:{}`); `listenBody()` awaits gateway-ready THEN `Promise.all(transports.map(t => t.listen(this)))`; `closeGatewayBody()` closes transports **FIRST** in the LIFO teardown (`transports → apps → extensions → substrate`) — transports are the ingress edge, so stopping them before apps tear down prevents an inbound frame routing `dispatchRequest(this,…)` into a half-closed app (mirror of `listen`, which binds transports LAST after ready seals the wire registry). Transport close failures best-effort. `listen()`'s started-latch short-circuits BEFORE the op, so a 2nd `listen()` does NOT re-fire `transport.listen`. **(3) Spy double (`gateway/src/testing/spy-server-transport.ts`, new `/testing` subpath):** `spyServerTransport()` records `listen` hosts + `close` count, typed against the spec interface. **(4) Conformance (`spec-conformance/src/server-transport.ts`):** `runServerTransportConformance(name, factory)` — bind/teardown/idempotency/re-listen. **DEFERRED (follow-on task, unchanged):** the concrete transport wrappers (`webSocket`/`http`/`unixSocket`/`inProcess`) wrapping the existing `websocketServer`/`httpServer`/`unixSocketServer` factories behind this interface. See `blueprint/84-…§2` (marked LANDED).

**2026-07-14 (later) — GATEWAY LIFECYCLE + LIVE HOOK PROPAGATION (ADR 84 + ADR 83 §4 amended). Gateway hooks now reach the whole tree, live.** 8 commits (`e686fe85`→`4dc38835`); workspace **145/145**, all affected suites green. **(1) Live interceptor inheritance (`c3cec53c`, ADR 83 §4 amended):** the frozen construction-fold is now LIVE — registering `.use`/`.guard`/`.hook` on a harness propagates to every live descendant (push-on-register + children set), a new child pulls the current set at construction, unsubscribe cascades by identity, close() detaches. Wired every edge (app→executor/loop/session + per-session elicitation/tasks/resources/tool-executor + session→knobs). e2e proof: a LATE `app.hook` reaches a session's tool-executor + knobs bridge (2-hop grandchild). **(2) `wire:` prefix (`39c4fb88`):** `runWireDispatch` names the op `wire:<method>` → `wire:session/send` Pascalizes to `WireSessionSend` → `onBeforeWireSessionSend`, distinct from the session op's `onBeforeSessionSend`. Retired the "collision is symmetry / fold-root no double-fire" call — it was propped on the gateway→app gap. The name is the routing: each hook fires at exactly one layer. **(3) Gateway lifecycle (`1f46ed22`, ADR 84):** `listen()` (hookable `gateway:start`, transport fan-out TODO) + `close({ drain })` (no `destroy` twin); `gateway:close-gateway`→`gateway:close` rename. CAPSTONE — `createApp` threads `interceptorParent: this`, so a gateway hook folds live gateway→app→session→sub (proven: post-createApp `gateway.hook({onBeforeToolDispatch})` reshapes a session dispatch). **(4) Client wire hooks (`df2b6acf`):** `client.hook()`/`client.hooks.on*` symmetric with the server, reusing the SHARED spec derivation (`HooksOf<WireAsCommandReg, ClientHookContext>` — `{params,result}`→`{input,output}` + `wire:` adapter). Wraps the request pipeline live. **(5) `_`-split (`4dc38835`):** `Pascal`/`deriveHookNames` split on `_` too, so snake_case wire ids mint clean camelCase (`app/run_once`→`onBeforeWireAppRunOnce`, was mangled `…Run_once`). NEW ADR 84 (gateway-lifecycle-and-transports) + `createApp(rootElement, input)` overload (`f4053a85`). DEFERRED (own arcs): ServerTransport abstraction + `withTransports` ownership (fills `listen()` fan-out); gateway `authorizer:authorize`/`gateway:accept`/`gateway:create-app` hooks (in HOOK-LIFECYCLE "Planned"). See `blueprint/84-gateway-lifecycle-and-transports.md` + `HOOK-LIFECYCLE.md`.

**2026-07-14 — THE ONE-PRIMITIVE THESIS COMPLETED: hooks ARE op-scoped middleware; the `Hooks` subsystem + its shadow cascade DELETED. Plus the imperative trio and verb-hookability across the harnesses (branch `feat/interceptor-collapse`).** Three follow-on waves on top of the collapse. **(1) Imperative trio (`8f8d9b0d`):** hooks are now runtime-registrable like `use`/`guard` — `harness.hook(config)` (batch → `Unsubscribe`) + `harness.hooks.onBefore<Verb>(fn)` (typed per-verb Proxy). Kebab verbs mint clean camelCase (`Pascal`/`deriveHookNames` split on `-` too). **(2) Verb migration:** `send`/`append`/`applyExecutorResult`/`applyToolResults` (session, `8ec1d86f`) and `elicit` (elicitation, `dbcf8ff5`) now route through `runOperation` via a `sessionOp`/`elicitOp` wrapper → hookable (`onBeforeSessionSend`, `onBeforeElicitationElicit`, …); form+URL unify into one `elicitation:elicit` op (before=request, after=response); session send's synchronous JOIN reservation stays atomic (88 session tests green incl. steering). **Documented limitations:** session verbs are hookable but NON-ADDRESSABLE (SendInput non-serializable, ADR 51 §1.2); `apply-*` hooks fire on the public facade, not the loop's in-fiber `*Fx` path. **Tasks (`c55b0143`): NOT hookable, by a proven boundary** — the seam is intrinsically ASYNC (`asBefore`/`asAfter` await) but `tasks.submit` returns `TaskHandle` synchronously; `runSyncExit` DIES on the async boundary (spiked). No hollow wrapper shipped — greppable `NOTE(adr-83)` + naming-lock tests + README. Unblockers: async `submit` (breaking) or a sync-hook fast-path (necessary-but-insufficient). **(3) HOOKS-INTO-`.use` COLLAPSE (`8c1cd87a`, ADR 83 amendment):** hooks rode a SECOND parallel cascade (`Hooks` class + keyed `hookLayer` + separate `hooks:` threading + `...hookLayer.forOp()` compose term). DELETED. New primitive `on<Command>(mw)` — the full typed op-scoped middleware (sugar over `.use`); `onBefore/onAfter<Command>` are now sugar over IT (`asBefore`/`asAfter`, which already produced middleware). Hooks register as op-scoped `transform` middleware on the ONE `.use` chain, self-scoping via `RuntimeContext.op` (the op's Pascal suffix), cascading through the ONE `inheritedInterceptors` fold. Adopter surface GREW (`on<Command>` added; config object + `onBefore/onAfter<Surface><Action>` names identical), substrate SHRANK. **GUARD UNTOUCHED** (already a `.use` interceptor). Compose order is now registration order within the transform rank (guards still outermost) — resolves ADR 82's "deferred interleave." Verification: full workspace **8250 passed, 1 pre-existing** (`retry.spec.ts` pollution/predicates WIP), typecheck 145/145. **Also caught:** the `app.fx.use wraps runOnce too` test was stale since the FOLD (`7be911a4` made `app.fx.use` reach fold-inherited ops) — proven failing at HEAD pre-change, corrected. Per-harness hookability map: see `blueprint/83-one-interceptor-primitive.md`. Not yet merged to `feat/v2`.

**2026-07-13 (later⁵) — THE VERDICT SUBSYSTEM COLLAPSED INTO ONE INTERCEPTOR PRIMITIVE; the cascade is now a FOLD, not a walk (ADR 83; `01092c6e` / `7be911a4` / `073dc138`, branch `feat/interceptor-collapse`).** The operation boundary had THREE interception mechanisms — the verdict **gate** (`HandlerRegistry` / `mergeVerdict` / `runInheritedBefore` / `LifecycleHandler`, a distinct before-phase), **middleware** (`.use`), and **hooks** (`onBefore`/`onAfter`). That is one concept — intercepting an operation — in three costumes. **ADR 83 collapses it to ONE primitive: the wrapping `Middleware`, with three KINDS** (`InterceptorKind = "guard" | "transform" | "observe"`, tagged via `tagInterceptor`; untagged ⇒ `transform`). `guard` = admission control (`proceed`/`veto`/`replace`/`defer`) — sugar `harness.guard(decide)` / `guardEffect`; a non-`proceed` `HandlerVerdict` desugars (`signalFromVerdict`) into a typed `OperationSignal` (`OperationVeto`/`Replace`/`Defer` in `op-signals.ts`) that the guard RAISES and `runOperation`'s settle step catches → **byte-identical terminal** (`terminateFromSignal` delegates to the same `terminate()` the verdict switch used; only the trigger changed). `transform` = plain middleware (hooks `onBefore`/`onAfter` are keyed sugar over it). `observe` = pure side-effect. `runOperation` composes ONE list `[...callMiddleware, ...inheritedInterceptors, ...ownMiddleware, ...hooks.forOp()]`, stable-sorted **guard-outermost** (`orderInterceptors`, `guard ≺ transform ≺ observe`) so deny-before-transform holds and a retry mw can't swallow a veto. **The verdict subsystem is DELETED.** **NAMING — `guard`, not `gate`:** the type system forced it — a `gate(decide)` on `BaseHarness` collided (TS2416) with `SessionHarness.gate(name) => GateHandle`, which is **loop continuation** (`@agentick/gates-next`), a different concept at a different scope. Rule: **guard : operation :: gate : loop.** New public API: `BaseHarness.guard` (`base-harness.ts:864`) / protected `guardEffect` (`:888`), `GuardDecider` (`:132`), and `ToolExecutorHarness.guardDispatch` (`tool-executor/harness.ts:461`, renamed from `onBeforeDispatch`). **THE CASCADE IS A CONSTRUCTION-FOLD, NOT A PARENT-WALK (generalizes ADR 82; SUPERSEDES ADR 81).** `ownAndInheritedMiddleware` + the `parent` pointer are GONE. Each scope snapshots its parent's `resolvedInterceptors()` at construction into a frozen `inheritedInterceptors` (mirrors the hooks fold). Own tier-2 registration stays dynamic (`this.middleware.snapshot()` per op); only the inherited layer is snapshotted. The trade is a static boundary (registration before a child's construction inherits; after does not) — and the fold FIXES a latent gap: per-session sub-harnesses now inherit app-level guards/middleware (the walk was functional on exactly one edge, App→Session; every sub-harness had dropped `parent`). **Precedence:** multi-guard is now **compose-order** (first non-`proceed` in composed order wins; guard-outermost sort, then scope, then registration), replacing the old order-independent `veto > replace > defer` priority-merge — a substrate hardcoded policy traded for a caller-controlled mechanism (capability-not-opinion). Fiber invariant unchanged (guards ride the same `liftMiddleware` seam). Docs swept: runtime/app/tool-executor READMEs + this entry. `LifecycleHandlerError` (spec) retained as a valid taxonomy entry but currently producer-less (a throwing guard decider propagates raw to `terminal:failed`). See `blueprint/83-one-interceptor-primitive.md`.

**2026-07-13 (later⁴) — HOOK CASCADE LIVE END-TO-END (`6b55b96e`, judged clean).** The dormant mechanism is now wired: `createApp({ hooks: { onBeforeToolDispatch } })` fires on a tool dispatch, and `createSession({ hooks })` composes on top (proven: `"x|app|session"`, app-outer). Public `AppHarnessOptions.hooks?: CommandHooks` folds to the app layer (`Hooks.from`); `createSessionBody` computes `sessionHooks = this.hooks.extend(Hooks.from(input.hooks))` ONCE and threads the resolved `Hooks` VALUE into the session + every per-session sub-harness (elicitation/tasks/resources/tool/knobs); the app-shared spine (loop/executor) gets `this.hooks`. **No parent pointer, no ordering knot** — the ADR-82 payoff realized. Each sub-harness got a mechanical `hooks`-forward-to-super (loop/knobs gained minimal options objects); middleware parent-walk untouched. `CreateSessionInput.hooks?` augmented FROM the app package (not spec) to avoid a spec→runtime cycle (ADR-27 declare-module). 4 tests (reshape/compose/after/behavior-preserving); full packages-next suite green (1 fail = predicates WIP); typecheck 145/145 turbo, zero error TS. **Reachability:** `tool:dispatch` PROVEN (only registry-augmented verb); knobs/tasks/resources/loop/executor value-wired but TYPE-dormant until each adds a one-line `declare module CommandRegistry` entry. **CAVEAT + `TODO(adr-80)` at the site:** `tool:dispatch` declares `output: ContentBlock[]` but the body returns the richer `DispatchResult` → `onAfterToolDispatch` is observe-safe / transform-UNSAFE (returning `ContentBlock[]` breaks `session.dispatch().content`); reconcile the declared output type to make after-transforms sound. **Deferred (unchanged):** slice 0 (session verbs through `runOperation` → unlocks `onBeforeSessionSend`); per-session hooks on shared-spine ops = tier-4 call-scoped; gateway→app hook threading; the factory-slot construction-context consolidation (subsumes hooks/parent/ns/principal threading — design note only).

**2026-07-13 (later³) — ADR 82 DRAFTED: the hook cascade is a construction-FOLD, not a parent-walk (revises ADR 80 §6/§7; narrows ADR 81 to middleware-only).** Design-session conclusion, reached by generalizing the tools config-cascade. The construction hierarchy (gateway→app→session→sub-harness) is a **scope chain**; a harness's effective hooks = every ancestor's layer merged with its own. Instead of walking `this.parent` per-op (ADR 80's `ownAndInheritedHooks` — needs parent pointers = ADR 81, + hits the construction-ordering knot), **fold the chain once at construction**: each scope computes `resolved = parentResolved.extend(ownHooks)` and threads the resolved immutable `Hooks` value into every harness it builds. Ops read local `this.hooks.forOp(name)`. The fold IS the walk, memoized per node — no parent pointers, no ordering knot (a value needs no live parent; computed once at the top of createSessionBody, threaded to the session AND its sub-harnesses). **`Hooks`** = immutable per-command layer holding LISTS (not a flat object — two layers setting the same `onBeforeX` would key-collide); **`extend` COMPOSES, not overrides** (hooks are middleware — both ancestor+descendant fire outer-first; the ONE divergence from tools' last-wins). `forOp` lifts through the SAME `liftMiddleware` path (ADR 80 §7 fiber invariant UNCHANGED); `deriveHookNames`/types/`asBefore`/`asAfter` all reused verbatim — only the collection method changes (walk→fold), cheap because dormant. **Cost:** static snapshot — mutating `app.hooks` after a session exists doesn't reach it (forfeits runtime-retroactive deployment policy, the ~10%; `session.hooks.append` still works via local overlay). **Rejected:** a general `ScopedConfig<T>` god-object (tools+hooks share a SHAPE — layer+merge folded down the chain — but the MERGE differs: compose vs override; per-type merge, not one object). **Net:** ADR 81's construction-parent invariant is no longer a hook prerequisite — it narrows to "if/when tier-3 `app.use` middleware needs the dynamic walk." **IMPLEMENTED + judged clean (`026323ca`):** the `Hooks` primitive (`from`/`extend`/`forOp`/`empty`), `extend` COMPOSES (verified onion order `["app:before","session:before","session:after","app:after"]`), `from`↔`forOp` can't diverge (shared `parseHookKey`), `forOp` lifts via `liftMiddleware` (fiber invariant carries over), `ownAndInheritedHooks` DELETED, middleware walk untouched. 18 tests; dormant-but-correct (`this.hooks` defaults `Hooks.empty` → `forOp` `[]` → byte-identical). **NEXT SLICE (to make it work end-to-end):** public `hooks:{}` option on `createApp`/`createSession` + fold-threading (app computes `resolved`, threads down to session + per-session sub-harnesses via the mechanical `hooks` forward — NOT the ADR-81 parent/factory work) + slice 0 (session verbs through `runOperation` so session-level ops are hookable). **tsc-figure correction (agent-flagged, applies to prior entries too):** the "145/145" cited throughout is TURBO's per-package task count, not a monolithic root `tsc` (which OOMs / surfaces pre-existing v1 `packages/`+`website/` errors); `packages-next` in isolation typechecks clean (87/87, zero `error TS`). See `blueprint/82-hooks-cascade-as-construction-fold.md`.

**2026-07-13 (later²) — ADR 80 PR #1 LANDED (`bcd18e7e`) + ADR 81 DRAFTED (construction-parent invariant).** The command-lifecycle hook cascade is IN base-harness: `runOperation` now composes `onBefore/After<Command>` hooks alongside middleware via `ownAndInheritedHooks` (mirrors `ownAndInheritedMiddleware`, returns `[]` when empty → byte-identical with no hooks). Hooks lift through the SAME `liftMiddleware` path as `.use` (§7 fiber invariant — verified: ambient ctx / span-nesting / interruption survive an awaiting hook; no bespoke hook-runner). Typed via derived mapped type: empty-seed `CommandRegistry` (id→{input,output}) → `onBefore<Pascal>`(input)/`onAfter<Pascal>`(output); type-level `Pascal` === runtime `deriveHookNames` (lockstep test). tool-executor contributes the first registry line. 16 new tests; existing suites unchanged; tsc 145/145. Judged clean against code (not just the agent report) before commit. **ADR 81 (uncommitted→committing): the construction parent must be a mandatory explicit invariant.** Audit found it's SYSTEMIC: loop/tool/knobs/resources call `super(...)` positionally and DROP `options.parent` (`parent-threaded refs: 0`); app passes `parent: this` at ONE site. So the cascade (ADR 76 middleware AND ADR 80 hooks) is silently half-wired — and `app.use()` tier-3 already doesn't reach the parentless spine harnesses (a live bug, pre-hooks). Decision: every harness is ROOT or CHILD, never orphan-by-omission; **parent = whoever owns your scope id** (appId→app, sessionId→session — dissolves the sibling/child ambiguity into a rule). Two-sided fix specced (child forwards options→super; parent passes `parent: this` at construction). NOT YET IMPLEMENTED — the parent-side carries the true-parent determination, deliberately not blind-edited across 8 constructors; the mechanical child-side forwarding + app/session activation is the next slice, ahead of ADR-80 slice 0. See `blueprint/81-construction-parent-invariant.md`.

**2026-07-13 (later) — ADR 80 DRAFTED: command lifecycle hooks (design session, uncommitted; born from the nx-knowify multimodal-input investigation).** A cross-layer audit of every core harness lifecycle (loop/executor/reconciler/model/tool-executor/session/app) established: v2 has THREE disjoint lifecycle vocabularies — `LifecycleStore`+`useOn*` (observer-only, handlers `=>void` discard returns `lifecycle-store.ts:173`, LOOP-fed not layer-owned so no standalone fire), `runOperation` phase envelopes (`base-harness.ts:814/823/877`, observer, standalone), and operation middleware (`.use`/`.fx.use`, the ONLY transform primitive) — plus dead spec (`ToolLifecycleEvent` 9 kinds never emitted `tool-executor.ts:374`; `useOnError` binding with no producer). Gaps proven: reconciler emits ZERO compile events (`renderTreeBody` never touches lifecycle), NO before/after-model transform seam (nothing between `loop-executor/harness.ts:412`↔`:416`), session `send`/`render`/`dispatch` BYPASS `runOperation` entirely (`session/harness.ts:552`, TODO `:1002` — a lifecycle vacuum). **ADR 80 decision:** lifecycle is INTRINSIC to `command()` — every `<who>:<what>` verb auto-gets two surfaces: **events** `<who>-<what>-<phase>` (kebab, observe, wire-projectable, from the phase envelopes) + **hooks** `onBefore<Who><What>`/`onAfter<Who><What>` (camel, in-band transform, ARE middleware entries). Naming = total function of the command id (`hook = on+Before|After+PascalCase(<who>:<what>)`) → forces `tool:dispatch`→`tool:execute` rename. Contract: `(value, ctx) => value|void` (return=transform, void=observe, throw=veto); `ctx`=RuntimeContext (the explicit-ctx-into-methods thread cashed in). Registration: declarative `hooks:{}` augmentable empty-seed `CommandHooks` interface (ADR-27 pattern, exposure-gated) at ANY scope (gateway⊃app⊃session⊃execution, cascades+composes onion via `ownAndInheritedMiddleware`/ADR 76) + imperative `.hooks.append/prepend/remove/off` + `.hooks.fx`. **Fiber invariant (§7):** hooks desugar to `.use`/`.fx.use` registrations → inherit ADR 76's `liftMiddleware` ambient-runtime continuation fix VERBATIM; a bespoke hook-runner side-path would reintroduce the fiber-sever bug — hard invariant. **`Hooks` is NOT a harness** (§8): state is unserializable functions (fails ADR 49 stores), must never cross the wire (policy/code), meta-regress (hooks-on-hooks) — it's a `BaseHarness` capability/facet. Worked examples: `onBeforeModelGenerate(input,ctx)=>reconcile(input,ctx.target)` (the reconciler-agnostic ground-floor media seam the whole investigation was chasing — lands as the plainest possible hook) + `onBeforeTimelineAppend` (ingestion IS timeline append; no separate ingest layer). **Slices:** 0 = route session verbs through `runOperation` (ADR 51 migration, PREREQ); 1 = the mechanism + 3 exposed commands (`model:generate`/`timeline:append`/`tool:execute`) — mergeable alone; 2 = per-harness `CommandHooks` augmentation accretes + wire-or-delete the dead spec. Ryan: "land this soon." NOT built — next is slice 0/1. See `blueprint/80-command-lifecycle-hooks.md`.

**2026-07-13 — Wire auth + naming hardening (4 commits, follows the channel arc).** (1) `knobs/set` now registers in every gateway automatically (`33f81f3d`) — `app-next` owns `builtinWireExtensions`, gateway registers them in the bundled tier (not framework-privileged); gateway stays harness-agnostic. Closes the slice-4 production gap. (2) **Declarative `WireExtension.auth` wired into the dispatch choke point** (`98ea511a`) — ADR 46 specced the slot but it was inert; now `authorizeDispatch` reads it, reconciling ADR 46 with ADR 51 §3.3: `required:false` → open (policy skipped, structural `requiredScopes` ceiling still un-waivable), `scope` → **additive** role (verb-scope AND role, never a relabel — a role can only tighten, so no anti-bypass hole). 6 tests. Also replaced the conditional-spread `...(x!==undefined?{}:{})` in dispatch with `omitUndefined`. **Correction:** my earlier "knobs/set is ungated" flag was WRONG — I'd grepped `gateway/src` and missed the choke point in `transport/src/server/dispatch.ts` (`authorizeDispatch` gates EVERY resolved method: session ceiling → verb-scope → additive role, deny-by-default). (3) Auth guide + examples in the gateway README (`1dbc1483`) — end-to-end flow (AuthSource ingress → single dispatch gate), `staticTokenAuthSource`/`staticAuthorizer`/`claimsAuthorizer`, per-method `auth`, the ceiling. (4) **Wire-naming convention RATIFIED + swept** (`b4eca4bb`) — **snake_case method/notification names, camelCase payload fields** (spec/wire/README.md). Rationale: routing tokens are opaque strings (language-neutral, matches MCP); param fields become identifiers in the serde-less TS stack (keep camelCase). Renamed `app/createSession`→`app/create_session`, `gateway/listApps`→`gateway/list_apps`, `session/respondToElicitation`→`session/respond_to_elicitation`, MCP kebab `mcp/list-tools`→`mcp/list_tools` etc. — 33 files, tsc 145/145, full suite 3573 pass. **KNOWN FOLLOW-UP:** the client-extensions `retry/` module (WIP `predicates.ts`, untouched per constraint) keys on old `app/runOnce` via plain strings — left the whole `retry/` module at the old name (consistent, tests pass); update `retry/*` + `predicates.ts` → `app/run_once` when the retry WIP lands.

**2026-07-12 (later⁴) — Client channel-consumer arc: slices 1–4 LANDED (design B).** The CQRS loop for knobs is built end to end. Commits: `a2db953a` channelView is a pure fold (in-band snapshot, design B — supersedes design-A `e014e0f7`); `c19d27e9` slice 2 (channel subscriptions open with a snapshot — `ChannelSnapshotProvider` conformance + `session.channelSnapshot` bridge-scan + knobs provider + gateway `sub/subscribe` prepend, subscribe-first ordering); `c8da4e2c` slice 3 (`knobsStateView` read façade — the `@agentick/knobs-next/client` subpath, applyJsonPatch fold); `1478d60a` slice 4 (`knobsHandle` read+write — the `knobs/set` wire handler that was ratified-but-unimplemented + the client resource handle whose `set` is fire-and-observe, re-folding via the channel not a hand-patch). ~15 new tests; the CQRS round-trip (set → view UNCHANGED → channel delta re-folds) is pinned. Slice 2 + slice 4 were delegated to agents with precise specs and judged (bridge-scan finds the real KnobsHarness not a handle; key→id mapping matches KnobsHandle.set; ordering guarantee; round-trip proves no hand-patch). **KNOWN PRODUCTION GAP (loud TODO in `knobs/extension.ts`):** `knobsWireExtension` is built + tested but NOT registered in a live gateway — blocked on ADR 26 Step 8 (`withKnobs()` isn't consumed; the `ExtensionBundle.wire` path is unused in production). So `knobs/set` is verified in tests but not yet reachable end-to-end until that registration lands. **REMAINING (clean follow-ups):** slice-1b reconnect re-seed (composes with the `offline`/`retry` client-extensions — not bespoke); `collectionView` keyed sugar (build with tasks as the first real keyed conformer — tasks needs a `ChannelSnapshotProvider` + a snapshot-frame shape, a slice-2-shaped server change); `client.session(id).knobs` sugar (a client-extension or metapackage attaches the free-function `knobsHandle` as a `.knobs` property — the generic client-next can't, dependency direction). Prior design-finalization note (design A→B pivot, CQRS model, CollectionView abstraction, ergonomic ladder) below.

**2026-07-12 (later³) — Client channel-consumer arc: slice 1 LANDED (`e014e0f7`), then DESIGN PIVOTED to a simpler model in review. Read this before building more.** The generic client-side reduced-channel primitive `channelView` + `channelEventQuery` shipped (client-next + spec, 9 tests). **BUT the design has since been superseded in review — slice 1 as committed is "design A" and must be revised.** The arc, as finalized with Ryan:

- **The pattern is CQRS with an event-driven read model.** Reads flow server→client as reactive **channels** (queries, eventually-consistent, subscribe+fold). Writes flow client→server as discrete **req-res commands** (authoritative). The client holds a _replica_ of the read view updated by the channel; a write's effect returns _through the channel_ (a delta), not the response — so one client's write, another client's, and the MODEL's write all update every view uniformly. Server harness = source of truth; the channel = a derived stream; the client view = a folded replica. Prior art is exact: **Kubernetes list-watch (Reflector/Informer)**, CQRS + event-sourced read models, AG-UI snapshot/delta (ADR 73). Frontier deliberately NOT adopted (over-engineering for one-directional small-collection projections): CRDT/local-first (Yjs/Automerge/ElectricSQL/Zero), query-based IVM.

- **DESIGN A (committed slice 1) → DESIGN B (agreed, to build).** A = pull baseline (`channel/snapshot` RPC) + push deltas (`sub/subscribe`), tied by a **cursor**. B = **in-band snapshot / K8s `sendInitialEvents` watch-list**: the subscription OPENS with a snapshot frame, then streams deltas on the SAME ordered stream. B is strictly simpler for our (small) channels — it deletes `baseline()`, `ChannelBaseline`, the cursor tie, the separate pull RPC, the head-cursor accessor, AND the snapshot↔stream race (the snapshot is frame-one, before any delta — ordering guaranteed by construction; reconnect re-seed is free). `channelView` collapses to a **pure fold over a channel subscription**: `channelView(client, scope, channel, { initial, reduce })` — no baseline, no cursor; `reduce(state, frame)` handles snapshot-kind (seed) vs delta-kind (fold), the primitive stays dumb. A's pull+cursor become documented ESCAPE HATCHES for the two cases B gives up (one-shot read without subscribing; mid-stream resume of a LARGE collection) — neither is our case; K8s kept both for the same reason.

- **The abstraction (named): `CollectionView<Id,T>`** = the client-side Informer/materialized-view of a server-owned collection — `get(id) / list() / has(id) / subscribe() / close()`. Sugar over `channelView` (state is `Map<Id,T>`). Conformers (≥5, well past the 3-consumer bar): tasks, resources (`ResourcesHarness` — literally a keyed resource collection), elicitations, mcp-client status, knobs. Named `CollectionView` NOT `Resource` (collision with MCP `Resource`/`ResourcesHarness`).

- **The full resource handle = read projection + write commands** (Apollo/RTK-Query shape): `session.tasks()` → `.get/.list/.subscribe` (channel-backed reactive read) + `.cancel(id)` etc. (req-res mutation). Writes land two ways, same sugar/escape-hatch ladder: typed **wire-extension methods** (`defineWireExtension` → `knobs/set`), or **`session/dispatch`** by name (app-defined `audience:"user"` tools). `channel.request`/`onRequest` is substrate-local, NOT wired — a client write cannot ride it. **`session/send` is a command too but NOT an entity mutation — don't over-fit send/abort into the resource CRUD shape.**

- **Ergonomic ladder (low cognitive overhead): façades arg-free (`taskStatusView(client, sessionId)`, rung 1) → `collectionView`/`channelView` primitive (rung 2) → raw `transport.subscribe`/`request` (rung 3). No cliff — each rung returns the one below.** Future `client-react` `useChannel(view)` is a one-liner over the `get/subscribe` contract.

- **Open per-channel question:** does `knobs` even need JSON-Patch deltas, or is full-record-push (`reduce = replace`) simpler given how small knob state is? The SAME `channelView` fold covers both — delta-vs-full is a producer choice the primitive is agnostic to. Revisit when building `knobsStateView` (AG-UI wire parity is the only counter-reason).

- **NEXT BUILD (in order):** (1) revise `channelView` to the pure fold — DELETE `baseline`/`ChannelBaseline`/cursor from `client/src/channel-view.ts` (supersedes `e014e0f7`); (2) slice 2 = "a channel subscription opens with a snapshot" — the server-side snapshot-**provider seam** on `SessionHarness` (`channelSnapshot(channel)` registry; knobs/tasks register) that PREPENDS the snapshot frame to the live `sub/subscribe` stream (NOT a separate `channel/snapshot` pull RPC); (3) `collectionView` + first resource handle (`taskStatusView`) proving read+write round-trip. See the published design artifact (client↔server layout) from this session.

**2026-07-12 (later²) — ADR 76 gap #2 CLOSED: async middleware wraps are fully in-fiber (ambient-runtime fork). Corrects two prior claims.** Ryan flagged that "applying any non-Effect middleware effectively breaks the fiber connection" — and was RIGHT that it was a real break, but it turned out to be a BUG in `liftMiddleware`, not an inherent limit. **Root cause:** the lift forked the continuation with `Effect.runFork`, which seeds a bare root on the DEFAULT runtime — no tracer, empty FiberRefs, no parent span. So a span opened in the wrapped ops detached (in fact wasn't even collected — the tracer lives in the runtime), and the tier-4 `CallMiddlewareRef` reset to `[]`. **Fix (`liftMiddleware`):** capture `Effect.runtime()` in-fiber (the ambient Runtime = Context + FiberRefs + tracer) and fork the continuation on THAT via `Runtime.runFork(runtime)`. Now everything `next` wraps keeps full in-fiber semantics across the `await`: **OTel span-nesting, `RuntimeContext`/`parentOpId`, tier-4 `withCallMiddleware`, and interruption** all survive. The ONLY residual is the middleware's OWN JS body (statements around `await next`, microtask-driven — inherent, can't be fiber-interrupted mid-statement, hence explicit `ctx`). **This CORRECTS:** (a) the `f387b455` claim "does NOT restore span-nesting (child still a root span)" — FALSE, span-nesting survives once you fork on the ambient runtime; (b) the "definitive lazy-next" framing that a coroutine trampoline was needed for continuation span-nesting — it wasn't; the trampoline is only relevant to making the mw's OWN BODY in-fiber (still impossible, still pointless). **Per Ryan's "everything you uncover becomes a test case":** 6 new `base-harness.spec` tests under "async middleware fiber propagation" pin each property — span nests through the async mw; the continuation body still reads `getContext`; a tier-4 `withCallMiddleware` wraps a NESTED op reached through the async mw (wraps===2 proves the FiberRef crossed); body rejection surfaces on the outer E channel; an async-mw throw surfaces; `next` callable >once (retry). Plus the earlier ctx-third-arg, short-circuit, and interrupt-tears-down tests. Gate: workspace tsc 145/145, base-harness 26/26, oxfmt+oxlint clean. Caveat text corrected everywhere (README, `AsyncMiddleware` JSDoc, ADR 76). **Net: `use` and `fx.use` differ ONLY in whether the middleware's own body runs in-fiber — the wrapped work is identical.** Un-committed as of this note; commit next.

**2026-07-12 (later) — ADR 76 middleware: the `use` / `fx.use` two-surface split + explicit `ctx` (`c2d21187` + doc pass).** Middleware now registers through the SAME facade/twin split as every operation: `harness.use(mw)` takes a pure-JS `AsyncMiddleware` `(input, next, ctx: RuntimeContext) => Promise<R>`; `harness.fx.use(mw)` takes the Effect-native `Middleware` `(input, next) => Effect<R,E>`. **Why split, not overload:** a single `use(Middleware | AsyncMiddleware)` union (and the earlier `async`-auto-detect path) killed inline-arrow param inference for BOTH forms — the async and Effect `next` contracts are structurally incompatible. Splitting across the two surfaces makes EACH a single type → inline arrows infer cleanly. `Middleware` + `HarnessFx` moved to `@agentick/spec-next` (so every `XFx` protocol can type `fx.use`); `AsyncMiddleware` lives in `@agentick/runtime-next` (it carries `RuntimeContext`, a runtime concern). **The `ctx` third arg:** an async middleware runs OUTSIDE the fiber (`await next` = detached `runPromise` root — the honest sever), so it can't read `getContext` itself; `liftMiddleware` captures the ctx snapshot at the op boundary and hands it in. Backed by a new base-harness test proving `use(async (i,next,ctx)=>…)` receives the op's `{sessionId, executionId, opId}` + a short-circuit test (mw returns without calling `next` → body skipped). Doc pass: runtime README (canonical — two-surfaces section + a "which surface" use-case catalog: observe→`use`, control-the-fiber→`fx.use`), ADR 76 §Implementation, app README (`app.use` = tier-3 deployment-global), session README (`session.use` = tier-2, per-send = tier-4). **DEFINITIVE "can `next` be lazy + in-fiber?" analysis (Ryan pushed to exhaust it):** YES for the CONTINUATION — a coroutine trampoline (Queue+Deferred pump loop running `yield* nextEffect` in the outer fiber) makes the wrapped ops in-fiber (spans nest, interruptible). But it's architecturally POINTLESS: (1) the middleware's OWN body (`A` before `next`, `B` after) is plain JS on the microtask queue — never in-fiber, because a JS async fn's suspension points aren't externally steppable; (2) interruption keeps an irreducible seam (orphaned async fn whose `await next` never settles; microtask `B` uncancelable); (3) it's the exact re-entrant dual-form hazard the ADR 77 spike condemned. **QED:** the ONLY way to get the middleware body in-fiber is to make it a generator the fiber drives — i.e. an Effect — i.e. `fx.use`. No fourth construct exists. The split is the honest, minimal statement of a real two-scheduler boundary, not a limitation. **Follow-up LANDED (same session):** the `runFork` + interrupt-on-signal upgrade. `liftMiddleware` now forks each continuation (`Effect.runFork`, holding the fiber handle) instead of `Effect.runPromise`, and interrupts it on the `Effect.tryPromise` abort signal (which fires when the outer op is interrupted). So aborting a `send` tears down the in-flight inner model/tool call an async middleware wraps — instead of leaving it running as a detached root (the leak). It does NOT restore span-nesting (child still a root span) or make the mw body in-fiber; only interruption is re-threaded. Backed by a base-harness test: interrupt a live op whose forked continuation hangs on `Effect.never` → its `onInterrupt` finalizer fires. Caveat text corrected everywhere (was "interruption does NOT cross" — now "span-nesting severs, interruption + ctx are re-threaded"): runtime README + `AsyncMiddleware` JSDoc + ADR 76. Gate: workspace tsc 145/145, base-harness 20/20 + full packages-next suite 3539 green, oxfmt+oxlint clean.

**2026-07-12 — ADR 77 spine-compose: Stage 1 + Stage 2 BUILT (the `.fx` dual-typed edge + the protocol-`fx` hoist). Stage 3 (the `Effect.gen` loop rewrite) is NEXT.** See `docs/proposals/v2/SPINE-COMPOSE-PLAN.md` (the gated tracker — authoritative). Summary of this session's 20 commits (`611a0262`→`724788bb`):

- **A/B fork RESOLVED → A-on-the-spine (ADR 79).** Session spine (session→loop→executor→tool→reconciler) = ONE co-located Effect entity; distribution is coarse at bus/inbox (cluster wraps the substrate, ADR 38, uses direct refs — orthogonal to composing the spine). Telemetry folded in: within-entity = free nested traces (one tracer runtime at the composed root); across = W3C `traceparent`.
- **The runtime already existed** — `commandEffect` (intra-harness) + `runOperation` (builds the Effect then immediately `runHarnessProtocol`s it). `.fx` is EXPOSURE of Effects already built, not invention. Big de-risk.
- **`.fx` = the dual-typed edge.** Effect canonical, Promise DERIVED via `PromiseView<T>` (spec, homomorphic mapped type — preserves JSDoc, mutation-verified guard in `promise-view.spec`; the ONE-WAY erasure means there is no `EffectView` inverse). Facade = `runPromise` at the entity edge; `.fx` = the un-run twin for in-fiber composition.
- **Streaming edge = the DUAL of the Promise edge** (singular concept): `AsyncStream<Item,Result>` (facade type, dual of `Promise<A>`) + `runHarnessStream` (runtime bridge, sibling of `runHarnessProtocol` — ALL the Queue/fork/iterator machinery lives here once). Canonical form = **sink-fold** `(input, sink) => Effect<Result>`. Executor's `executeStream` facade rewritten over it (~120 lines → the bridge; 8 backpressure/cancel tests unchanged). Finding: the Effect side is SIMPLER than the facade.
- **`.fx` mechanism decision tree (settled):** bare command passthrough → `fxProxy` sugar (knobs); command + facade logic (door→origin) → hand-author over `commandEffect` (tool-executor); not-a-command (inline Operation) → hand-author over `runOperation` (executor/loop/reconciler); non-Promise facade (streaming) → hand-author + edge bridge. All behind a uniform `get fx(): XFx`.
- **Twins landed:** knobs (S1 reference), executor `run`+`executeStream`, loop `runExecution`, tool-executor `dispatch` (×2 impls), reconciler `renderTree` (×2 impls).
- **`readonly fx` HOISTED onto the four spine protocols (`c27f4235`)** — THE Stage 2→3 bridge. The loop holds protocol-typed dep refs, so composing `yield* input.executor.fx.run(...)` needs `fx` on the PROTOCOL. Every impl + double now provides it (notably `FakeLanguageModelExecutor` gained `fx.run`+`fx.executeStream`; recording stubs record on the fx path too). **"internal calls go through .fx" now typechecks.**
- **Gate 0 characterization CLOSED** — `loop-executor/__tests__/characterization.spec.ts` (28 tests + `makeLoop` differential seam + `assertLoopInvariants`). This is the net the Stage 3 loop rewrite lands behind.
- **STILL PROMISE-CHAINED (the whole point of Stage 3):** the loop's `runExecutionAsync` (`loop-executor/harness.ts`) still `await`s each dep's facade — ~40 runPromise roots, no nested telemetry/cancellation yet. **Stage 3 = rewrite it to `Effect.gen`, `await dep.method()` → `yield* dep.fx.method()`, behind the char diff.** Model HTTP call stays `Effect.tryPromise(adapter.execute)`, tool handler stays `Effect.tryPromise(handler)` (legit external-I/O boundaries, in-fiber not roots). Remaining twins before/with it: `StateApplicator` + session.
- Gate throughout: workspace tsc **145/145**, ~1146 spine tests green, oxfmt+oxlint clean.

**2026-07-10 — Change-event primitive BUILT + ADR 75 rescoped + ADR 76 drafted (design session, uncommitted).** Delivered honest pushback on the ADR 75 design; Ryan agreed and asked to scale it to "the most elegant and foundational." Result: **(1) ADR 75 rescoped** to two foundational bricks — the change-event primitive + the `kind:"event"` archetype — with projection/normalization as lean _consequences_ and the **wake seam CUT** (a run is an adopter `send()`, callable from an `onChange` handler; a framework wake policy would be shipping a throttling _opinion_ — capability-not-opinion forbids it). Also applied: `ChangeEvent` **de-CRUD'd** (`{key, value?, prev?}`, no verb — the harness names the transition via `eventKind`); the **injection requirement** named (tag-envelope formatters MUST neutralize `<event>` syntax in genuine user content or user input can forge system events); the **no-double-count test** (a kind fully recoverable from a live current-state render does NOT project); "four routings" deflated to three honest consumers. **(2) First brick BUILT** — `createChangeNotifier<V, K>` in `@agentick/pubsub-next` (`change-notifier.ts`): the **notify** seam (`onChange`/`emitChange`/`changeKind`), a **sibling** to `KeyedNotifier` (NOT a bolt-on — bolting a value+prev stream onto the keyed notifier would force a 3rd type param and muddy its void-vs-value ping overload). Stateless pipe, read-only fire-and-forget observers (sync + error-isolated — an observer cannot affect the emitting op), producer supplies `prev` at the mutation site. 12 tests, README updated (Verified-by). **(3) ADR 76 drafted** — operation middleware scoping: per-call / per-instance (`harness.use()`, exists) / **structural inheritance** (compose construction-ancestors' chains root-outermost — the "global middleware" answer; register at app/session → wraps every descendant op) / call-scoped tier-4 DEFERRED (use Effect `Context.Reference`+`provide`, don't hand-roll fiber propagation). `onChange` here is the _notify_ twin of ADR 76's _intercept_ (middleware) seam. Draft base-harness edits landed (`DRAFT(ADR 76)`: `composeMiddleware`, `MiddlewareChain.snapshot`, `ownAndInheritedMiddleware`, `runOperation` compose site) — strictly additive, behavior-preserving (187 runtime tests green). **`@effect/rpc` at the wire: REJECTED** — v2 wire is deliberately JSON-RPC 2.0 for MCP envelope-parity; `@effect/rpc` optimizes Effect-to-Effect ergonomics (opposite of an interop wire); steal its patterns, not the library (record as rejected-alt in ADR 33 — PENDING). Gate: workspace tsc **145/145**, pubsub 58/58 + runtime 187/187, oxfmt+oxlint clean. Supersedes the 2026-07-09 ADR 75 entry below (wake + `KeyedNotifier.onChange` framing now obsolete).

**LANDED (5 commits):** `bb59b0bd` feat(pubsub-next) createChangeNotifier · `ed631113` docs(v2) ADR 75 rescope + ADR 76 + `DRAFT(ADR 76)` base-harness scaffold · `2c29646d` docs(adr-33) reject @effect/rpc at the wire (Ryan: "scrap the effect/rpc idea" — Effect is the engine, not the interface) · `a6811983` **refactor(knobs-next): first retrofit — StateDelta now projects over the `onChange` notify seam** (applySet/applyRegister emit a `ChangeEvent`; the JSON-Patch channel is ONE subscriber via `changeKind`; mutation logic ignorant of the projection; existing state-channel spec passes UNCHANGED = behavior-preserving; +5 change-stream tests incl. multiple-projections-on-one-stream; `harness.onChange` exposed class-only, `TODO(notify-seam)` to promote to protocol when a cross-package projection needs it). **STILL PENDING:** promote the base-harness ADR 76 scaffold out of draft (needs the ancestor-wraps-descendant proving test + handler-inheritance follow-up, ADR 76 Q2) — awaiting Ryan's ADR 76 read; next retrofit candidates = `state`/`gates` onto `onChange`, then the timeline `event` archetype (the second projection that makes the decoupling pay off).

**2026-07-10 (later) — ADR 77 DRAFT: the operation spine (fiber-through-the-process) + dual-typed edges.** Telemetry investigation ("do we emit OTel spans / can users set up a provider?") surfaced a ROOT-CAUSE architectural finding, discussed with Ryan and pinned in ADR 77. **Finding (verified):** the Effect fiber tree is BROKEN at every harness boundary — `runHarnessProtocol` is a bare `Effect.runPromiseExit` and each harness runs its own root; the loop even drops out of Effect entirely (`Effect.tryPromise(() => this.runExecutionAsync(...))`, plain async orchestration, `loop-executor/harness.ts:149`). So the "operation tree" is ~40 independent runPromise roots joined by `await`. This is the ONE root cause of: (a) telemetry can't propagate (every op emits `Effect.withSpan` at `base-harness.ts:687` but against the no-op tracer — spans emitted, never exported; `AppOptions.telemetry` Layer slot exists but is a placeholder that doesn't reach command execution, and no `@effect/opentelemetry` dep is installed); (b) `parentOpId` is hand-threaded (FiberRef can't cross roots); (c) ADR 76 tier-4 FiberRef middleware can't work. **Telemetry is a symptom.** **Decision (ADR 77):** internal ops carry one Effect fiber through a process (harness→harness calls compose via `yield*`; `runPromise` only at true edges); location-transparent boundary (local=compose, remote=`inbox.ask` — fiber breaks exactly at node edges, stitched by W3C `traceparent`); **dual-typed edges** (native-JS primary + Effect twin). Then telemetry/parentOpId/interruption/middleware-context all FALL OUT. **Rejected:** ALS (masks the debt — fails "meaningfully better than Effect"; Ryan: hard-no unless targeted+better, which it isn't here) and the ~80-edit runtime-threading (throwaway once the tree is mended). **SPIKE (run + verified, file discarded — it crashes the vitest worker):** a single object that IS an Effect + thenable **hard-crashes `runPromise`** (Promise-resolution adopts thenables → infinite re-entry → stack overflow, reproduced); Promise-eager+`.effect` **double-executes** side-effecting ops; the **lazy wrapper** (NOT an Effect, `isEffect===false`; thenable runs on `await`; carries the lazy Effect as `.effect`) gives **single execution per consumer, no crash** (v1 `ProcedurePromise` lineage) — this is the chosen dual form (contract: Effect users compose `.effect`, don't `await`). **Staged plan:** S1 mend the spine (session→loop→executor→tool, loop `Effect.gen` rewrite is the crux — characterization tests FIRST), S2 tracer at edge → telemetry lands + delete manual parentOpId on spine, S3 cluster remote-proxy (deferred, less-likely path), S4 leaves later. **Safeguards for "don't break things" (Ryan required high confidence):** dual-path coexistence (every commit works), characterization tests before the loop rewrite, spine-first incremental behind green gate, edge contract frozen (public stays native-JS → nothing external breaks), interruption+error-channel explicitly tested. Confidence: design HIGH; migration HIGH _with_ safeguards. NOT built — ADR pinned; next is S1 characterization tests + the loop rewrite behind dual-path.

**2026-07-10 (later) — `state`/`gates` onChange retrofit landed (`3c90de4e`).** `StateHarness` gets the ADR 75 notify seam parallel to knobs (`applySet`/`applyDelete` emit `ChangeEvent`; `onChange` class-only). State exercises what knobs can't: the `remove` path (`delete`) and `unknown` values that may be `undefined` — so add-vs-update rides an `existed` (`has`) check, not `prev !== undefined`. The `state-deltas` TODO now points at "subscribe `onChange`" (mirroring knobs' `projectStateDelta`) with the undefined-value codec caveat. **Gates deliberately gets NO `ChangeNotifier`** — a gate value IS a knob value, so engage/clear already flows through `knobs.emitChange`; a gates-owned stream would double-emit (documented at `GatesController`; projections filter `knobs.onChange` for gate-backing keys). +4 state tests; gates 31/31 unchanged; workspace tsc 145/145. Two harnesses (knobs, state) now on the notify seam; the `event`-archetype migration (below) is the remaining ADR 75 work.

**2026-07-10 (later) — ADR 75 Decision 2 (event archetype) REWRITTEN after survey; a prior claim was wrong.** Before implementing the `event` archetype I surveyed the blast radius and the ADR's premise did NOT hold: (a) `role:"event"` is **NOT vestigial** — it appears in **two** role unions (`MessageRole` rendered-tree + `SessionMessageRole` persisted), the latter documenting it as a deliberate (crude) mechanism for "state events that flow through the timeline without participating in model context," paired with `MessageTimelineEntry.visibility`; it has reconciler-react `content-blocks.spec.tsx` usages and is already flagged as deferred debt in the timeline README. My earlier "verified vestigial" claim (line below + the superseded 2026-07-09 entry) was WRONG. (b) The ADR conflated **two entry models**: the rendered-tree `ContextEntry = MessageEntry | SectionEntry` (`entries.ts`, `kind ∈ {message,section}`) vs the persisted `TimelineEntry = MessageTimelineEntry | TurnBoundaryEntry` (`session-harness.ts`, `kind ∈ {message,boundary}`) — the archetype belongs in the PERSISTED union, which already has a non-message kind (ADR 53 turn boundary = precedent). **Corrected model:** `event` = a persisted `TimelineEntry` kind (`EventTimelineEntry {kind:"event"; event:{...}; ts; visibility?; tags?}`, nested-domain convention) that **renders to a `MessageEntry`** at compile (role `user` + `<event>` envelope, Decision 4) — NO parallel entry in `entries.ts`; `renderedWith` stored on the event keeps re-projection deterministic (ADR 49). Retiring `role:"event"` is a **migration** (both role unions + reconciler tests + README + fold/render wiring mirroring turn-boundary), not a clean deletion. **No code edited on the wrong premise** — ADR 75 (Decision 2, TL;DR, Problem gap 2, Rejected, References) corrected; implementation scoped off the corrected spec, pending go.

**2026-07-09 (later) — ADR 75 DRAFT: system events + timeline projection.** Pins the design reached with Ryan: (1) a **change-event primitive** (`onChange` typed push variant on `KeyedNotifier`) — the substrate all reactivity routings compose over; (2) the **`kind:"event"` timeline archetype** (sibling to `message`, NO role — removes the stray `"event"` from `MessageRole`, a category error, verified vestigial [CORRECTED 2026-07-10: NOT vestigial — two role unions carry it + a deliberate `SessionMessageRole` mechanism + reconciler tests; see 2026-07-10 (later) entry]); (3) **opt-in timeline projection** of harness ops (per-`eventKind` policy; generous default — discrete outcomes ON, state churn OFF/coalesced — reconciled with ADR 49's ES-bloat prohibition); (4) **normalization** = a `user`-role message in an `<event kind source at>` XML envelope (the ONLY mid-conversation-interspersable role across Anthropic/OpenAI/Google; `developer` non-portable), riding the existing `renderedWith: FormatterRef` seam; (5) a **gated wake seam** (some events enqueue a run, distinct from resume, never automatic). Governing principle recorded: **capability, not opinion** — framework ships mechanism + overridable defaults, owns the default formatter not the format. The change-event unifies four routings: StateDelta (built), AG-UI steps (specced), timeline `<event>` (this ADR), wake (this ADR). NOT built — design pinned for review; first brick is the `KeyedNotifier.onChange` primitive.

**2026-07-09 — StateDelta emission: knobs-state JSON-Patch channel (ADR 73 adoption)** (`649bc919`). Adopt AG-UI's snapshot+delta state-sync natively. `applyJsonPatch` (RFC 6902 subset add/replace/remove/test, **copy-on-write** — untouched subtrees shared by reference, so reactive consumers diff by reference) + `JsonPatchOp`/`JsonPatchError` land in `@agentick/utils-next` (18 tests). `KnobsHarness` fans a `knobs-state` channel (`session:channel:knobs-state`, mirrors task-status): a `snapshot` frame on `importSnapshot`, a per-id `add`/`replace` `delta` on `set`/defaulted-`register` (**no document diff needed — the harness notifies per-id, so a changed knob IS one op**), monotonic gap-detect `version`, plus `stateSnapshotFrame()` for late-join re-seed (7 tests incl. the money test: snapshot seed + applied deltas reconstruct `exportSnapshot()`). **Scope call**: client-apply DEFERRED — no client consumes any `session:channel:*` yet (task-status doesn't either); a generic per-channel client state-model is cross-cutting, not knobs-bespoke → `TODO(state-deltas)` trailheads at `state`/`gates` harnesses (gates already project their bool through knobs via write-through). The AG-UI `StateDelta` projection now falls out as a codec over this channel. Judged by me: full suite 8093 passed / 0 fail, workspace tsc 145/145, oxfmt+oxlint clean. **Next: step labels** (bundled `step()` tool + loop-executor step-span → `step_start`/`step_end`, projects to AG-UI StepStarted/StepFinished — independent follow-on).

**2026-07-08 — MCP/resources wave brought home: ADR 63 built + ADR 64 signals + ADR 65 roots + resource front-ends (all judged by me — fresh uncached per-pkg tsc across touched + consumers, real round-trips, adversarial + mutation checks, oxlint/oxfmt clean).**

- **ADR 63 compiler-surfacing BUILT — b-core** (`125fdfb0` + tests/README `bfeb09a2`/`4ea761b7`/`36bc3523`). `collect` gains a content-append stream + a `<project projectionKey>` override fragment (compiler-general, reconciler-next); a lazy `DefaultProjection` registry (tools advertisement + a `timeline` fold that structurally duck-types `HookBridges.timeline` — no reconciler-react→timeline dep, ADR 27); `RenderedTree.provenance` (`default:`/`authored:`, 1:1 with entries). Default-on + lazy override proven incl. **empty-override-still-suppresses** (keys on presence, not count); retired the `timeline-not-rendered` diagnostic (spec 10→9). Preserves ADR-49 "IR = only what the compiler rendered."
- **ADR 64 log/progress signal family** (`9b45d810`) + **adversarial hardening** (`b801af36`). One emit → one discrete bus event → projections subscribe (emit once, receive everywhere). `ctx.log`/`ctx.progress` are always-present universal `ToolHandlerCtx` slots; `BaseHarness.emitLog`/`emitProgress` are structurally bus-only (never journaled, subscriber-probed). Wave 3a's MCP direct-sink reworked into `installLogProjection`/`installProgressProjection` bus subscribers (wire behavior + level filter preserved — 19 parity tests). Hardening closed progress end-to-end (MCP `_meta.progressToken` → `ctx.mcp.progressToken`; gateway `session/send` bridges progress signals scoped to the executionId → the wire ProgressReporter) and added the adversarial trio: **cross-connection isolation (mutation-checked — I independently stripped the connectionScope filter and confirmed the tenant leak)**, fire-and-forget under `append`-death, below-level-still-on-bus. No ambient global `Context.log` (Promise-bridge FiberRef hazard — `TODO(#19-ambient)`); `useLog` deferred to a future `client-react-next` (`TODO(#19-react)`).
- **ADR 65 roots-as-projection** (`b92e2275`) + seam, **both directions** (`4c8b6f95`). Decision recorded LOUDLY: roots is composed, NOT a harness — mount state already lives in the sandbox (`add-mount`/`remove-mount` declared commands); resources owns reads; roots is the projection (ADR 63). Source is pluggable (static list | fn | sandbox | fs) — **no sandbox required** (pinned by test). Reversible via the `McpRootsSource` provider-fn seam; regret asymmetry favors composing; concrete revisit-trigger + upgrade path documented. Build: `sandboxRootsSource` + `bindSandboxRootsToClient` (live `notifyRootsListChanged` on mount change, via new `SandboxHarness.subscribeMounts`) + `sandboxFileResolver`/`fsFileResolver` + inbound `ctx.mcp.clientRoots` (server pulls `roots/list`, re-pulls on `list_changed`, **structural per-connection isolation** — differential test). Packaged as the opt-in `@agentick/sandbox-next/mcp` subpath (deps mcp+resources; acyclic).
- **Resource front-ends + surfacing + server-info** (`668afdcf`). `ctx.resource` (Resources protocol on `ToolHandlerCtx`); `<Resource>` + `useResourceBridge` in `@agentick/resources-next/react` (mirrors `<Tool>` — register-on-mount, renders null, catalog via the ADR-63 default projection); `withResources` model tools (`resource_list`/`resource_read`). **`ResourcesHarness` is now an always-constructed per-session substrate primitive built at the AppHarness SINGLE construction site (#159)** — the SAME instance on `ctx.resource` + `bridges.resources` + `session.resources` + `installer.resources` (reference-equality pinned by test; the stale extension-constructs-it TODO closed). `withMCP` proxy-registers a remote server's resources into the one session harness under `mcp://<alias>/…` (re-surfaced on `list_changed`, torn down on close). `mcpServerInfo` default projection. **Alias trust-safety**: surfaced resources + server-info key on the trusted adopter `serverId`, NEVER the server's self-reported name — adversarial differential test proves a spoofed colliding name can't shadow another's namespace.
- **Skills `skill://` direction recorded** (`67c6dfc1`, no code). Bundled skill assets → a `skill://<name>/<path>` resource namespace (lazy resolvers into the session ResourcesHarness — the same aliased-resolver pattern as `file://`/`mcp://<alias>/`; progressive disclosure = lazy reads; instructions stay push). Multi-source folders already work (multiple loaders); layered-precedence direction (user>project>bundled) + its coupling to the asset-URI shape noted. **Design stance: markdown/file is the primary authoring form (portability is the format's point); JSX `<Skill>` authoring considered and DEFERRED** — power-path into the same registry only, never the default (a reactive block that doesn't need the catalog is just a `<Section>`).
- **The through-line:** resources is emerging as the universal _scoped-namespace content substrate_ — `file://` (sandbox), `mcp://<alias>/` (remote servers), future `skill://<name>/` — same aliased-resolver mechanism each time, composed onto the one registry, never a new subsystem.
- **Remaining releaseable-bar items:** #22 (cohesive MCP+resources user-facing docs pass — next), #17 (mime-type-aware media capabilities + throw-on-unsupported-modality).

**2026-07-07 (gates) — Verified gates + read-only knobs (parity+ with v1 work of same date).**

Ported the new gate species from `packages/` (v1, uncommitted on this branch — ships separately with its own changeset) and brought `packages-next` to parity plus the arming extension:

- **`@agentick/spec-next`**: `KnobRegistration.readOnly` — model-visible, not model-settable.
- **`@agentick/knobs-next`**: `dispatch()` (set_knob pipeline) rejects read-only knobs by name; group writes skip read-only members (error when the whole group is read-only). `harness.set()` untouched — application writes always work. React: `UseKnobOptions.readOnly` threaded; `<Knobs />` formatter emits a `read-only` hint.
- **`@agentick/gates-next`**: `GateDescriptor` is now a union — latch gates (`activateWhen`, unchanged) | verified gates (`satisfied`): level-triggered code predicate evaluated at every tick-end, auto-clears on pass, re-engages on regression, backing knob registered read-only (unforgeable), `defer()` no-op, **fail-closed on predicate throw** (v2's LifecycleStore isolates handler errors, so the hook must catch and treat as unsatisfied — differs from v1 where a throw propagates). Optional `activateWhen` on a verified gate is an ARMING SCOPE: dormant (no verification, no blocking) until the arming predicate first fires; sticky per mount; verification takes over same-tick.
- **Tests**: +10 gates specs (engage/block, auto-clear, regression, async, fail-closed, read-only knob registration, dispatch bypass rejection, defer no-op, dormant/arming) and +4 knobs harness specs (read-only name/group/all-read-only/application-set). Full `packages-next` suite green (3203 passed); per-pkg tsc clean (spec, knobs, gates).
- Judged by me: fresh per-pkg tsc, real stubKnobsHarness dispatch round-trips (not mocks), adversarial coverage on the bypass path.

**2026-07-07 (later) — MCP push: Waves 1–4a landed + content-block safety net.**

Progress on the 6-wave plan (all judged by me — fresh uncached per-pkg tsc, real round-trips, scope-held, adversarial pass):

- **Wave 1 HTTP transports** (`08470a28`): server `httpTransport` + client `streamableHttpTransport` (OAuth threaded), real-loopback conformance.
- **Wave 2 client completeness** (`75de8b52`): full v1 client surface restored (resources/prompts/completion reads, sampling handler, roots provider, logging) + resource content block in spec + content-mapper carries structuredContent/isError.
- **Wave 3a server mechanical** (`c92d99ac`): completion + logging (MCP projection) wired; `lifecycle.ts` tasks-capability bug fixed.
- **Wave 4a ResourcesHarness** (`fdc38ebf`): new bundled `@agentick/resources-next` (registry-of-resolvers + notifier per ADR 62, NOT a store) + thin MCP server projection (hardcoded `resources:false` gone). ADR 51 note: register/subscribe/notifyUpdated are plain methods (required fn param can't be a declared command); read/list/listTemplates are commands.
- **Content-block safety net** (`e7d95447`, `1268640b`): `foldContentBlock`/`foldContentBlockWith` in spec + `resource→clean text` normalization; house rule = never silently drop (degrade to text or be exhaustive), not a 23-handler mandate.
- **Wave 6 conformance** (`c7c73afb`): `runMcpConformance` (loopback both roles + raw-SDK-client + gated server-everything + draft/2025-11-25 version matrix), parameterized by caller-injected harness factories (shipped module imports no concrete sibling; matches runTimelineStore/Sandbox pattern). **Found + fixed a real interop bug**: `buildCapabilities` advertised `tasks:{}` → SDK rejected task-augmented `tools/call` → our own `callToolAsTask` failed against our own server; now emits `tasks:{list,cancel,requests:{tools:{call}}}` + a real passing round-trip. Grows per-capability as later waves land.
- **Compiler-surfacing model — ADR 63** (`46e46b4d`, ratified): defaults = a default TREE (framework default components composed with the root, overridable, devtools-inspectable), NOT implicit IR injection — keeps ADR 49's "IR = only what the compiler rendered" verbatim while getting default-surfacing ergonomics. Per-primitive default (content/tools on; resources = catalog not inlined; MCP server-info = self-description). Unblocks Wave 4b (surfacing = default components).

**Wave 5 fully designed (discussed with Ryan):** log+progress(+status) = ONE framework runtime-ctx family (like elicit), one bus emit → dual projection (MCP notifications + agentick-client via EXISTING subscribe/progress/subscriptions-next infra + typed sugar) — task #19; `isError→ToolResultBlock.isError` + `structuredContent→json block` in the withMCP tool-bridge (no throw, error not lost); pagination (tools/prompts) + `instructions` mechanical; circuit breaker folded into the connection-status FSM.
**Parked/follow-on:** sampling (Wave 3b — discuss later), mime-type-aware media capabilities + throw-on-unsupported-modality (#17), the framework log/progress family ADR (#19). MCP Apps → later `@agentick/mcp-apps-next`. Wave 6 conformance = concurrent finalizer track.

**2026-07-07 (later) — MCP comprehensive push (Ryan: "the best server + client impls we can do").**

**Gap assessment (read-only audit):** v2 MCP is architecturally _ahead_ of v1 (per-server harness, declared/journaled commands, security pipeline, era codec, tasks/\*, OAuth-via-elicitation) but **regressed hard on protocol coverage** — spoke only tools+prompts+elicitation+tasks over stdio/in-memory; dropped resources, sampling, roots, logging, completion (dead code), all HTTP transports, structured-content passthrough. 6-wave plan to restore + surpass v1. Two ADRs drafted: **ADR 62 `ResourcesHarness`** (resources as a framework primitive MCP projects onto — elicitation precedent, but provider/consumer-asymmetric; awaiting Ryan's 3 calls) and the **ADR 61 correction** (auth stays per-transport). Two build decisions locked: MCP Apps → later `@agentick/mcp-apps-next`; Resources → bundled `ResourcesHarness`. Real bug found: `server/protocol/lifecycle.ts:71` gates the tasks capability on the `resources` opt-out key (fix in Wave 3). No MCP conformance suite exists (8 sibling harnesses have one) — Wave 6.

**Wave 1 — HTTP transports (`08470a28`), both roles.** server `httpTransport({port})` (multi-connection Streamable-HTTP over the `ServerTransport` contract, security pipeline runs per HTTP connection, SSE-hang close-ordering fixed) + client `streamableHttpTransport({url,oauth})` (SDK transport + OAuth provider threaded → the `oauth/` module is finally reachable). Proven over **real loopback HTTP** (initialize→list→call, bad-bearer rejected at the pipeline, concurrent-session isolation, OAuth redirect fires the URL elicit; full dance gated on an IdP). Client-wiring placed in a new `integration/http-transport.ts` (not the pure-types `transport-factory.ts` — avoids coupling the type seam to OAuth impl; there is no spec-kind switch in the real code). fresh mcp tsc clean; 232 passed/0 skipped. **Wave-order note:** Wave 2 (client protocol completeness) is HELD until ADR 62 is ratified — the client resource reads + `content-mapper` fix should use the agreed resource content block, not build it twice.

**2026-07-07 (later) — #240 local OS isolation (`73e70e16`) + auth slice-3 correction (`25800124`).**

**#240:** ported v1's OS-jail into `@agentick/sandbox-local-next` — `LocalSandbox.exec` now routes through a platform-selected jail (macOS seatbelt `sandbox-exec` profile; Linux bwrap/unshare + cgroup v2) instead of a bare unjailed `spawn("bash")` (the silent v1-capability regression, now closed). `readonly isolation` field surfaces the effective strategy honestly; `strategy:"auto"` picks strongest; an explicit strategy the host can't honor THROWS at create (no silent downgrade). Limits: wallClockSec/diskMb both platforms; memoryMb/cpuPercent via cgroup on Linux, documented-unsupported on macOS. **Confinement PROVEN** (`isolation.spec.ts`): each deny guarded by `isolation===<jail>` (can't pass on passthrough) + paired with a `strategy:"none"` CONTROL that performs the same escape and succeeds → the jailed failure is provably the jail's doing (write-escape / read-escape / net-egress). seatbelt exercised live on the darwin host; linux gated-skip. Per-domain network rules stay proxy-based (bypassable, documented like docker); only `network:false` is kernel-hard. deps unchanged; fresh tsc clean; 20 passed/5 skipped. Still dev-safety tier (Lambda microVM is the prod isolation) — non-cut-gating, but no longer a v1 regression. **Judge caught nothing to bounce — the confinement CONTROL pattern met the worse-than-none-if-faked bar.**

**Auth slice-3 correction:** the ADR-61 slice-3 plan (relocate auth from slice-1's per-transport `authSource` option to a gateway `interceptIngress` chain + `withAuth`) was **withdrawn** — it would have removed just-shipped working code, created two auth-config paths (one-code-path violation), and added a chain abstraction with **no consumer** (rate-limit/tenant interceptors are speculative, not cut items). Per-transport `authSource` (slice 1) is THE design; the gateway chain is deferred until a concrete non-auth interceptor needs it (`TODO(#146)`). A delegated attempt was hard-killed mid-edit (`TaskStop`) and fully reverted (transports verified tsc-clean at the slice-1 state); `transport-http` was never touched. **Process lessons banked:** don't ship-then-relocate without a consumer ([[steelman-the-null-hypothesis]] serial-churn corollary); to STOP an agent editing, `TaskStop` it — a message is too slow. Slice 2 (connectors) remains the genuinely-additive auth next-step.

**2026-07-07 (later) — #139 kill-and-resume acceptance, both poles (`30e448ce`).**

End-to-end proof of ADR 49 "open-or-rehydrate" against the REAL store adapters. `runKillResumeAcceptance` (new `session-next/testing` subpath, the conformance idiom — parameterized `makeStore` + `skip?`) drives a genuine cycle: session1 `send()` (real write-behind + flush barrier) → `close()` (kill) → fresh session2, SAME id, store over the same durable backing → `hydrate()` before render. Four cases: (1) completed turn survives the fresh open; (2) **MODEL-VISIBILITY (load-bearing)** — a Meszaros `SpyLanguageModelExecutor` overrides `project()` to capture the compiled `LanguageModelInput`; asserts the hydrated prior turn ("PLUM", written only by session1) lands as a USER message the model received on session2's FIRST render → **closes the flagged STATUS gap** ("does hydrated history reach the MODEL, not just the timeline?"); (3) flush barrier (resolution ⟹ durability, asserted synchronously post-`await`); (4) `delete` ends the session (fresh open hydrates empty). Run at Memory + `fsTimelineStore` (real temp dir) GREEN; `postgresTimelineStore` gated on `TIMELINE_PG_URL` (skipped here, honest). `session-next` gains `./testing` + test-only devDeps on the two adapters; NO fakes of the resume pipe (scripted model only); mirrors `timeline-durability.spec.ts` wiring, which stays untouched. Gate (mine): fresh uncached session tsc clean; `npx vitest run packages-next/session` = 70 passed / 4 skipped; oxfmt+oxlint clean. **The durable-stores + resume foundation is now cut-proven at both poles** — the cloud persona #163 (ernesto) stands on verified sandbox + auth-ingress + durable-timeline + resume.

**2026-07-07 (later) — TimelineStore reference adapters #132 (`dcc5565b`; ADR-49 amendment `865158f9`).**

The durability MODEL + the `TimelineStore` port + hydration/flush wiring were already landed (ADR 49, A2). This adds the concrete Class-A adapters. **Design decision (weighed + recorded in ADR 49):** NO `define*`/`defineStore` helper — a `defineTimelineStore` was considered and rejected (the two archetypes share a _pattern_ + conformance discipline, not code; and a helper can't own the _backend-assigned_ `seq` invariant without breaking DB-serial / stateless-replica resume). Adapters follow the `CredentialsStore` precedent: per-backend factory `implements TimelineStore` directly. **`timeline-fs-next`** (zero-dep JSONL, one append-only file/session, `seq` durable per line, base64url traversal-proof filenames, per-session mutex, batch-append=one syscall) — **restart-durable across prune-to-empty via a GDPR-clean `.hwm` high-water-mark sidecar** (`seed` precedence: cursor → transcript max+1 → sidecar → 0). **`timeline-postgres-next`** (the cloud pole / shared-source-of-truth across stateless replicas): escape hatches first-class — **BYO `executor` (never owns the pool), `table`/`columns`, per-op `sql` function overrides, `codec` (jsonb+schema_ver), `migrate:"off"` default (`postgresTimelineSchemaSql` exported for manual apply)** — the library never owns your schema; `seq = bigint GENERATED ALWAYS AS IDENTITY`; batch `INSERT … RETURNING`. Both pass `runTimelineStoreConformance` against REAL backends (fs: temp dir; **pg: verified 14/14 against real Postgres 16** — IDENTITY + jsonb — plus gated-skip on `TIMELINE_PG_URL` absence, honest like docker/lambda; NO fakes). `timeline-next` gained a `skip?` on the store conformance (mirrors sandbox) + re-exports `TimelineEntry` (adapters dep one package). **Judge loop:** first pass shipped a documented "prune-to-empty + restart resets seq to 0" gap; I rejected it (real violation of the frozen never-reused clause — a cursor-holder silently misses post-restart entries) and sent it back → fixed via the `.hwm` sidecar + a 4-case restart-simulation test (new store instance over the same dir asserts seq continues at 3, not 0). Gate (mine): fresh uncached per-package tsc clean; `timeline-fs` 18/18; pg gated; oxfmt+oxlint clean. **Next:** #139 kill-and-resume acceptance tests (both poles) — the end-to-end resume truth-test #163 (ernesto) leans on. **Known gap:** `seq` coerced to JS `number` (pg `bigint`) — ceiling 2^53 entries, documented on the port.

**2026-07-07 (later) — ADR 61 ingress authentication, slice 1 (`59b66185`; ADR `6c8caee5`).**

The auth story had 3 of 4 pieces built (Authorizer ADR 51 §4, `AuthSource` port, `IngressIdentity` carrier); the 4th — the authn CALL — ran only on WebSocket, leaving `transport-http` (the prod edge), unix-socket, and connectors stamping NO principal → the Authorizer saw the trusted local pole = an open door in prod. **ADR 61** (written this session; #146 retargeted off its stale "ADR 34" title; the `TODO(#302)` code refs are stale → #146) establishes **one `interceptIngress` seam for every trust-boundary crossing** (client transports + connectors), a **polymorphic `IngressCredential`** (`bearer|platform|none`), `AuthSource` as the normalizing identity broker → the existing `IngressIdentity`; `session.send`/in-process is the trusted interior and never authenticates. Authenticate ONCE per crossing (per-connection ws / per-request http), propagate the principal, never re-auth inward (north-south vs east-west; prior art: API-gateway edge auth, `SecurityContext` propagation, federated identity/OIDC/SPIFFE). **Slice 1 built + judged green:** `IngressContext`/`IngressCredential` in spec; `AuthSource.authenticate` widened to the polymorphic credential (breaking — all callers fixed); shared **fail-closed** `authenticateIngress` helper (no source → local pole; configured → run + FAIL CLOSED, never catch-and-continue; enrichment-only, never authorizes); typed `IngressAuth{Required,Failed}`/`IngressCredentialUnsupported`. **Edges:** websocket migrated onto the helper (ZERO behavior change — existing ws suites untouched + green; ALSO fixed a latent query-token leak where `?token=` was honored regardless of the documented `allowQueryToken` default-false, and dropped a false "10s timeout" doc comment); **`transport-http` per-request authn** (each POST authenticates from its OWN `Authorization` header, identity threaded per-dispatch, NEVER cached on the per-session `SessionConnection` → no cross-request bleed; resolves `TODO(trail-http-per-request-auth)`); unix-socket `kind:"none"` default. `staticTokenAuthSource` credential-kind switch (prototype-key-bypass guard KEPT; platform rejected → slice 2). **`runIngressAuthnConformance`** (transport-next/testing) runs against REAL servers (raw ws/fetch/net clients, `spyAuthorizer` records what dispatch saw): valid-bearer→principal, missing/invalid REFUSED at the edge (the fail-closed proof, not local-pole fallthrough), prototype-key bypass, no-source→local-pole, once-per-crossing (ws per-conn shares identity / http per-request proves alice-then-bob no-bleed). **Judge gate (mine, not the agent's word):** fresh UNCACHED per-package tsc clean on all 5 (spec + 4 transports — turbo FULL-TURBO would have lied); `npx vitest run` = 26 files / 184 passed / 15 skipped; oxfmt+oxlint clean; grep-confirmed no client imports `AuthSource` (server-side only). Package READMEs updated with the seam + "Verified by" rows. **Known gaps / TODO(#146) trailheads:** slice 2 (connectors — the `kind:"platform"` federated path + per-message actor, resolves `define-connector.ts:132`); slice 3 (`GatewayInstaller.interceptIngress` multi-interceptor chain + `withAuth` extension, ADR 50 item 2); HTTP DELETE not yet authn-gated; **no authn timeout — a hung `AuthSource` leaks the ws socket / hangs the request** (pre-existing; not a regression).

**2026-07-07 — Lambda MicroVMs prod sandbox provider (ADR 60, `9ab97cd6`; ADR corrections `d7f42f28`).**

Researched the actual [Lambda MicroVMs guide](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html) (Ryan: "research first"). It is a NEW, purpose-built offering ("sandboxes for AI") — a long-lived, addressable Firecracker microVM (dedicated HTTPS endpoint; HTTP/2/gRPC/WS/SSE), FULL OS, persistent processes, NO exec ceiling (the `900` in examples is the idle-suspend timer), with native `suspend`/`resume` preserving memory+disk. This **withdrew ADR 60's A-vs-C substrate fork** — Lambda IS the persistent Firecracker the survey attributed only to a self-operated fleet, serverless + with a real checkpoint. A self-operated `sandbox-firecracker-next` becomes a later portability play, not a capability fork. **Topology decision (Ryan): align with docker/local FIRST** — Lambda = a `SandboxProvider` the gateway-side session reaches into (Topology A). "Agent-in-sandbox" (whole session runs IN the microVM; endpoint = session channel; local sandbox inside) is a real, higher-value prod shape but a **future gateway/session-runtime track**, NOT a SandboxProvider — deferred. **Built (`@agentick/sandbox-lambda-next`, deps sandbox-next only + AWS SDK v3):** provider orchestration (run-microvm→waitRunning→create-auth-token→client stub); the in-VM sandbox-agent (our HTTP/WS server baked into the image, CMD :8080 — readFile/writeFile/editFile with in-VM `applyEdits`, exec streamed over WebSocket→onOutput, the in-VM egress proxy using the base's shared `matchRequest`); the endpoint client (JWE `X-aws-proxy-auth`/`X-aws-proxy-port`, server-side only); a typed-error codec that round-trips sandbox errors across the wire (instanceof preserved); an **injectable `LambdaMicrovmsControlPlane` seam** so the far-side + client + protocol are FULLY real-tested via a loopback (`fakeLambdaMicrovmsControlPlane` spins up real agents; real fs/bash/HTTP-WS) running the shared #218 conformance suite, while the AWS control plane (`@aws-sdk/client-lambda-microvms@3.1080.0`, real shapes) is integration-tested gated on real AWS. **Divergences from docker (deliberate):** NetworkRule[] is SUPPORTED via the in-VM proxy (docker throws); double is a Meszaros `fake*` not `stub*`. **Gate:** fresh uncached tsc clean (incl tests); `npx vitest run packages-next/sandbox-lambda` = 11 passed / 8 skipped (AWS suite gated); oxfmt+oxlint clean. **Known gaps / TODO trailheads (judge pass):** (1) **`TODO(#226)` SECURITY-VERIFY** — `network:false` maps to _omit egress connector_ = intended deny-all, but the AWS doc says egress is PUBLIC by default; if omission ≠ deny-all, `network:false` silently grants internet (the in-VM proxy is soft/env-based, so the connector is the hard boundary). MUST verify on a real microVM. (2) `TODO(#223)` hibernate fast-follow — native suspend/resume = the first HONEST checkpoint (`SandboxSnapshot={microvmId}`, retain-on-destroy); `restore` absent for now. (3) `TODO(#226-followup)` EFS/S3 mount reinterpretation (host binds stay SandboxUnsupportedError). (4) The AWS control-plane wrapper is typechecked against real SDK shapes but UNEXECUTED — closing that needs an AWS account with the offering enabled + a built image (a Ryan-input to prove prod). Docker provider (`487edb42`, #157) + ADR 59 repackaging (`sandbox-next` base, providers dep the base) landed earlier this session.

Merged: adapter combinators (withRetry/withFallback/tapModel — retry/failover through the FIRST chunk); generateObject + normative responseFormat (normalize → translate → providerOptions-wins, ratified); CacheHint awakened (canonical carrier → anthropic cache_control with ttl; explicit providerMetadata wins); usage→cost spine (NORMATIVE UsageStats subset rule — anthropic folds cache tokens into inputTokens; target.pricing adapter-authority precedence, ratified); cursored history (store.history / timeline.history / run({history}) via the hydration path — seeding IS resuming); executeStream iterator throws typed error (#182 Option A; abort clean-terminates); slice 5 (Authorizer port + WireRpcError + dynamic resolver — deny-by-default, exact-beats-dynamic, gated commands/list, augmentations for exactly the ratified matrix rows; unconfigured default: local pole passes, any principal denied). Test infra: runtime-next/testing stubInbox + model-next/testing scriptedAdapter (replaced FIVE per-spec locals). #137 was already fixed (L7 eviction + tests) — closed with evidence. 2836 tests green. **Known gaps flagged:** (1) NOTHING stamps WireExtensionContext.principal — ingress authn (ADR 50 interceptIngress + ADR 34 AuthSource) is the missing half of the security story; (2) the wire lane is unit-tested only — e2e (real gateway+session+staticAuthorizer) owed; (3) timeline→compiled-tree injection unverified (does run({history}) reach the MODEL, not just the timeline?).

**Previously, 2026-07-03 — #152 + #171 landed (PR #180, stacked on #150/PR #170): the `model:` slot and `run()` one-shot.**

`createApp({ model: openai("gpt-4o") })` — exactly one of `model` (LanguageModelAdapter; app wraps it in THE executor) / `executor` (BYO engine); bare-adapter-on-executor rejected with a pointer. The noun aligns across every tier: generate({model}) / run({model}) / createApp({model}) / <Model model> (#169) / model-\* packages. And `run(<Agent/>, { model, messages })` fills the ergonomics ladder's middle rung (generate → run → createApp+sessions): temporary app+session, one full-loop execution, auto-teardown on settle, v1 handle ergonomics (`.result` unwrap + directly for-await-able), exported from app-next + /react. History seeding deferred to the timeline:append exposure story (noted on #171). App 82/82. Also this session: issues #171–#179 filed from the design review (executor-consumes-fold, message-level providerMetadata, customBlocks doc injection, tokenEstimator, merge helper, tool parity audit, loop-ai-sdk design note, tool-call repair hook); #178 updated with the verified ai@5.0.123 prepareStep mechanism — the AI SDK ladder collapses to two rungs (adapter shipped; prepareStep-loop faithful but coupling-priced).

**Previously, 2026-07-03 (later still) — **#150 ADR 52 IMPLEMENTED end-to-end: the ONE LanguageModelExecutor, four providers converted to adapters, @agentick/model-next carved out, packages renamed model-<provider>-next.\*\*

The subclass tier is gone. `LanguageModelExecutor<TRaw,TChunk>` is one final class consuming a `LanguageModelAdapter` options part; `BaseLanguageModelExecutor` + both `define*` factories deleted (755 lines, #103 resolved at the root). All four providers converted with hook bodies verbatim, closures replacing `this.*`: `openai(model?, opts?)`, `google(...)`, `anthropic(...)` (the workspace had been silently red since the collapse — Anthropic still extended the deleted base, so #151's core landed in this branch), `aisdk(model, opts?)` (flat signature, AI-SDK-as-provider-library archetype; the engine archetype stays a follow-up). SDK clients construct lazily — declaring an adapter needs no API key until first call. The substrate-dance `*-factory.ts` files are deleted; `createApp({ executor: openai("gpt-4o") })` works via `isLanguageModelAdapter` detection at the app slot (app wraps the adapter in THE executor on its own substrate; `ExecutorFactory` survives only as a legacy slot form, `TODO(#151)` marks its removal). New package **`@agentick/model-next`** (zero Effect, zero substrate): adapter contract + `StreamAccumulator(+View)` + `DeltaTransform` pipeline + tag routing + canonical projection + **`generate()`/`generateStream()`** options-bag single-shot helpers whose streaming fold mirrors the executor exactly (verified by spec). `defaultFinalizeStream` exported as an executable default (Google's late stop-reason mapping composes it — the `super.finalizeStream()` pattern is dead). Provider packages renamed `executor-<p>` → **`model-<p>-next`** with dep graphs cleaned: `model-next` + spec + utils + SDK only; Effect and runtime-next are devDependencies (an adapter's runtime tree is Effect-free). READMEs rewritten for all six packages. Workspace typecheck green; 2779 tests green (9 new generate specs; executor 41 + model 30 + providers 28/50/43/23). Environment note: verdaccio's CodeArtifact uplink token expired mid-session — restarted via nx-knowify's `scripts/start-verdaccio.sh` (fresh `aws codeartifact get-authorization-token`); public-package installs 404 until that runs.

**Previously, 2026-07-03 (later) — Tracking moves to the GitHub project board: [agentick v2.0 cut](https://github.com/users/agenticklabs/projects/2), issues #132–#167 seeded.**

Kanban columns Backlog/Design/Ready/In Progress/Review/Done + fields Workstream (A–E), Kind, Gate (⛔ ryan-review). 36 issues seeded forward-only from CUT-PLAN + the ADR 51/52 track + the wave's named follow-ups. Division of authority (recorded in CUT-PLAN §0): board = live state; STATUS = narrative log; plan/ADRs = map + design, linking never tracking. Ready column at seed: #133 (seq on TimelineStore), #137 (L7), #140 (verb matrix, ⛔), #141 (slice 5, ⛔), #144 (ADR 51 footnotes), #150 (ADR 52 implementation). Design column: #146 (ADR 34), #154 (connectors ADR, ⛔), #165 (Effect charter, ⛔). **Legacy-number disclaimer:** pre-2026-07-03 `#NNN` references in docs are conversational ids, not issue numbers — ranges collide; issue bodies carry `Legacy id:` annotations. Also: the working tree was found checked out on `master` (the v1 adapter session landed PR #130 + release there) — returned to `feat/v2`; all 25 wave-day commits intact.

**Previously, 2026-07-03 — ADR 51 wave COMPLETE across every harness: skills/prompts/sandbox/mcp-client migrated; reconciler/session/loop/app/gateway precisely classified.**

The invocation model is now uniform. **Migrated** (switches + op literals deleted, wire shapes identical, ZERO test edits across 2792 workspace tests): timeline (6 verbs, slice 4), state (2), knobs (3), skills (3, −52), prompts (5, −39, `prompts:get` newly addressable), sandbox (7, **all newly addressable** — no switch had existed; `exec`/`write-file` flagged for conservative wire-exposure treatment), mcp-client (7, all newly addressable; connect/disconnect/reauth doctrine-excluded as construction-bound; elicitation relay + task fan-out correctly classified plumbing). **Classified with per-verb annotations, not migrated:** reconciler-react (mount/rerender carry live elements/bridges — doctrine; renderTree blocked by two REAL registry gaps the wave discovered: **input-aware scope fn + caller-opId passthrough**, named `BaseHarness.command` follow-ups; recompile/unmount/invalidate are spec-frozen unprefixed wire types → v2.0-sweep rename candidate); session (`TODO(adr-51-session-verbs)`: commands don't run through runOperation at all today + SendInput non-serializables → designed signal form on the slice-5/matrix pass; `session:dispatch` is the easy first declaration); loop-executor (live-refs, permanent doctrine); app/gateway (rootElement doctrine; `close-app`/`close-gateway` are candidates gated on the matrix). Doctrine footnotes owed to ADR 51: optional-fn fields don't trigger §1.2 (required-param rule, knobs/prompts precedent; they degrade to absent over the inbox); opIds canonicalize to `${verb}:${ulid()}` (embedded discriminators move to scope — zero consumers verified). Aggregate wave arithmetic: ~30 verbs declared + enumerable, 6 switches + 27 hand-built Operation literals deleted, 21 verbs inbox-addressable for the first time.

**Previously, 2026-07-02 (late night) — ADR 51 wave: state + knobs migrated (net −83 LOC); Effect-leak audit completed with a clean adopter-edge verdict.**

state (`set`/`delete`) and knobs (`set`/`register`/`dispatch`) are on declared commands — switches, message-type unions, and five hand-built Operation literals deleted; handlers are pure layer logic; wire shapes identical (all pre-existing tests untouched). This commit is what the wave is FOR: **94 insertions, 177 deletions.** The **Effect-leak audit** (grep-verified): every adopter edge is clean — `ctx.emit` void with `runFork` inside, adopter `ChannelHandle.publish` is Promise, `ExecutorStream` is dual-shape AsyncIterable, `tasks.submit` dual-overloaded, store ports Promise; the substrate trio (journal/bus/inbox) is Effect-typed BY DESIGN (the documented internal tier); the one genuine implementer-edge leak is the provider-executor subclass tier — already sentenced by ADR 52. Cosmetic debris removed (the two `_ImportGuard` exports dragging Effect into skills/prompts protocol files). Remaining wave sites carry greppable **`TODO(adr-51-wave)`** markers: session (9 verbs — the big one), prompts (4), skills (3), sandbox (5), mcp-client (6), reconciler-react (3); executor's 13 literals collapse inside the ADR 52 implementation. Full workspace 2792/2792.

**Previously, 2026-07-02 (night) — ADR 51 slice 4 LANDED: timeline migrates to declared commands; `compact` becomes an addressable verb. ADR 52 gains the modalities section.**

Slice 4: every timeline verb is a `this.command()` declaration (`append`/`queue`/`drain`/`replaceProjection`/`resetProjection`/`compact`); the five hand-built Operation literals and the entire `handleMessage` switch are deleted — inbox routing is served by the BaseHarness command registry with **unchanged message types + payload shapes** (the pre-existing inbox-routing tests pass untouched: the zero-behavior-change proof). `compact`'s exception is REMOVED, not enshrined: a bare `timeline:compact` verb from any origin runs the construction-bound default with optional advisory `instructions` as data; the explicit-arg form stays hand-built by doctrine (function input = unaddressable). New substrate primitive: **`BaseHarness.commandEffect()`** — fiber-preserving intra-harness nested-command invocation (drain→append keeps its parentOpId causality tree without crossing `Effect.runPromise`). 3 new tests (bare-verb-over-inbox with `origin: "wire"`, advisory instructions delivered to the resident strategy, six-verb enumeration); 308/308 + consumer suites green. Executor internal-ops migration deliberately **folded into ADR 52 implementation** (migrating ops into a class being collapsed is double work). ADR 52 also gained the **modalities section**: `embed`/`embedMany`/`transcribe`/`generateSpeech`/`generateImage` as optional adapter capability groups + standalone substrate-free helpers, capability-conditional conformance; `embed` lands with the ernesto persona port. **Next: slice 5** (dynamic wire resolver + Authorizer, ONE commit, gated on the verb matrix's `exposure` decisions) and ADR 52 implementation (before any provider work).

**Previously, 2026-07-02 (evening) — ADR 52 drafted + ratified: executors and model adapters — the split.**

The executor (harness — orchestration, opinion tier) splits from provider normalization (part — protocol tier). **ONE** reference `LanguageModelExecutor` owns all Effect machinery (stream pipeline, backpressure, abort, operations); providers become **`LanguageModelAdapter`s** — Promise/AsyncIterable-shaped objects implementing the existing subclass hook surface (`buildParams`/`call`/`openStream`/`mapChunk`/`reconstructRaw`/`normalize` + optional quirk hooks). Standalone use restored (`generate(openai("gpt-5", {apiKey}), input)` — the v1 OCR-service pattern, zero substrate); `createApp({ model: openai("gpt-5") })` quickstart sugar; adapter authors never see Effect (closes the implementer-audience leak); #103 resolved at the root (`define*` factories + subclass points deleted); the four factory files' substrate dance deleted. "Executor" = execution engine, not provider: ai-sdk gets both roles (`aiSdkModelAdapter(LanguageModelV2)` — inherits ai-sdk's whole provider catalog — plus a later `AiSdkExecutor` engine delegating with `stopWhen: stepCountIs(1)`, tools handed back to our tool executor). Guardrail: `LanguageModelInput`/`AdapterDelta`/`LanguageModelExecutionResult` are the ONLY currencies — no double normalization. BYOK (ADR 48 §5) becomes per-principal adapter instances. Packages rename `executor-<provider>-next` → `model-<provider>-next` in the pre-ship window; **Anthropic is written adapter-first — its pending subclass body is never completed** (the forcing deadline: ADR 52 implementation before any further provider work). Also answered: the `this.operation()` question — internal op construction is `this.command({ exposure: "internal" })` (ADR 51, already landed); executor internal ops migrate on the slice-4 wave; function-input ops (explicit-arg `compact(strategy)`) stay hand-built by doctrine.

**Previously, 2026-07-02 (later still) — A2.2 LANDED: open-or-rehydrate + flush barrier + default compact + idempotent createSession (ADR 49).**

Two commits. **(1) Durability wiring:** `SessionHarnessOptions.timeline { store, writePolicy, compact }` threads to the per-session `TimelineHarness` (flows from `createApp({ session: { timeline } })` via SessionDefaults — zero app changes); with a store injected, session construction **hydrates the persisted tier from the durable log before first render** (no store → resolved-promise hot path). `sendBody` awaits `timeline.flush()` at execution end — the ADR 49 barrier: send() resolution implies the store holds the execution; a buffered write failure rejects with the typed `TimelineWriteFailed` and lands the session on **"failed"** (latched past the `.finally`, never a silent "idle" against a diverged log). `TimelineHarnessOptions.compact` + `withTimeline({ store, writePolicy, compact })` — the construction-bound default that makes `compact()` no-arg (the ADR 51 signal form) real; explicit arg overrides (inner-scope-wins, in-process only); neither → typed `CompactStrategyMissing`. All three `TODO(A2.2)` markers resolved. **(2) Idempotent open:** `createSession({ sessionId })` with a live id returns the existing session — create IS resume (stateless replicas open by id blind); `SessionAlreadyExistsError` removed wholesale (class, channel union, spec docs, wire error-code case, codec conformance row — no deprecations). 7+1 new tests; 215 + 768 across affected suites; strict tsc clean. **Next per the ADR 51 slice plan:** slice 4 — timeline migration to `this.command()` declarations (now mechanical: registry landed, `compact` default landed → the bare `timeline:compact` verb becomes addressable), then the matrix-gated resolver+Authorizer (slice 5, one commit, never split).

**Previously, 2026-07-02 (later) — ADR 51 slices 1+2 LANDED: the command registry on `BaseHarness`.**

Spec: `CommandDescriptor`/`CommandExposure`/`CommandInfo` (`protocol/command.ts`), `OperationOrigin` + `EventScope.origin` (provenance — the second gate-stamped core identity dimension, twin of `principal`; the journal is now the authz audit log for the cost of one field), `MessageEnvelope(Input).origin`, `CommandDeclarationError`. Runtime: `BaseHarness.command()` — single declaration site; one canonical verb string = inbox message type = op-name root = authz scope label = future wire method name; declared non-internal verbs are inbox-addressable via one new step in the existing dispatch precedence chain (request-response → `onMessage` → **command registry** → `handleMessage` fallthrough) with Standard-Schema validation at the ONE site (reusing the existing `InvalidPayload`), gate-origin stamping, envelope-causality threading, and ask replies via the existing correlation contract; `commands()` + the `<surface>:commands` meta-verb are the declare-and-discover surface. Zero behavior change (no harness migrated yet — existing switches untouched). 12 new tests; runtime+spec 671/671; strict tsc clean across spec/runtime/timeline/gateway/app. **Deviation from ADR 51 §8 recorded in the commit:** `AuthError`/`PermissionDenied`/`PolicyRule` types land with their consuming slices (5/6), not ahead (no-dead-code rule). Next per the slice plan: A2.2 (hydration wiring + `withTimeline({ compact })`), then the timeline migration to declarations (slice 4, expected net-negative LOC), then the matrix-gated resolver+Authorizer (slice 5, one commit, never split). Also this session: the verdaccio local-registry proxy was fixed (verdaccio 6 sends a malformed `Accept: application/json;` that CodeArtifact 400s; per-uplink `headers.accept` override in nx-knowify `.verdaccio/config.yml`) — the pre-commit hook chain works again.

**Previously, 2026-07-02 — ADR 51 drafted: the harness invocation model + authorization architecture.**

ADR 51 (`blueprint/51-invocation-and-authorization.md`) formalizes the compact-over-wire arc: every harness is a network-addressable actor; commands are **verb + serializable data** ("do X now in/to/with Y") resolved against construction-bound config — executable configuration never travels (signal-form rule for function-param ops; advisory data like compaction `instructions` allowed, the resident strategy authoritative). **Command registry** on `BaseHarness` (`this.command()` single declaration site; one canonical verb string = inbox message type = op-name root = authz scope label = policy-rule target = wire method name; one new step in the existing dispatch precedence chain replaces per-harness `handleMessage` switches at negative LOC). Flat location-transparent addressing (`surface:scopeId` — identity, not topology). Wire projection via a **dynamic namespace resolver** on the sealed registry (explicit-beats-dynamic = porcelain-shadows-plumbing; no catch-all wire method; typed RPC via `WireMethods` module augmentation with types derived from the declaration's Standard Schema; `commands/list` discovery; existing 12 curated methods + extension namespaces untouched). **Two authorization subjects, two gates, one vocabulary:** identity authz (`Authorizer` port at wire dispatch; deny-by-default; same-principal target rule per ADR 48; hard constraint: the resolver ships WITH the gate, never before) and capability policy (`DispatchPolicy` port at tool dispatch; allow/deny/ask generalizing the existing confirmation gate with `confirmationAnnotationsPolicy()` as the zero-behavior-change default; claude.json-style layered **deny-wins narrowing** cascade — new `mergeNarrowing`, explicitly NOT `mergeLayered`; learned layer via `reply.always`; narrowing spawn inheritance). Trust domains name the fourth subject: **the model** — inside the process, intentionally untrusted. Provenance: `origin` joins `principal` as a core gate-stamped `EventScope` dimension; the journal (already the observability ledger, ADR 49) becomes the authz audit log for the cost of one field — Operation carries facts, never decisions. Six-change implementation (~330 LOC across spec/runtime/gateway/tool-executor/utils; harness packages migrate net-negative). Also this session: ADR 27 amendment (harnesses are the behavior, bindings are projections; verbs-not-configuration invariant) and ADR 48 §5 (the fusion rule: the session is where the work and identity axes fuse; the binding decision procedure; the #152 checkout-pattern mandate). Pending Ryan review (⛔).

**Previously, 2026-07-01 (later) — A2 landed: `TimelineStore` durability port (ADR 49) — store-backed persisted tier, write-behind + `flush()` barrier, typed failures. Plus a typed-error sweep (B1 slot collision + compaction failure).**

**A2 — `TimelineStore` durability (ADR 49) — LANDED.** The timeline persisted tier is now store-backed (ADR 49 "stores, not snapshots"). New `TimelineStore` append-log port (`timeline/src/store.ts`) — the flagship generalization of the `CredentialsStore` pattern, but the OTHER archetype: append-only event log (`load`/`append`/`sessions`/`delete`, optional `prune`, `backend`), no `replace` (rewriting the log would break event-sourcing). Bundled zero-dep `MemoryTimelineStore` default. Harness wiring: `TimelineHarnessOptions { store?, writePolicy? }`, a memory-authoritative **write-behind pump** with a `flush()` barrier (added to `TimelineHarnessProtocol`), `writePolicy: "through"` for zero-loss, and `hydrate()` (the resume path). Conformance suite `runTimelineStoreConformance`; the package's first README. **Typed-error correctness (the thread that ran through both B1 and A2):** store-write failures surface the existing registered `TimelineWriteFailed` AgentickError (write-through fails the op channel; write-behind latches + surfaces at `flush()`) — NOT raw `Error`/`orDie` defects. Same fix applied to `compact()`: an LLM-backed strategy failing is OPERATIONAL, so it now surfaces a real `CompactHandlerFailed` instance (was a plain `{_tag}` object + `orDie` defect). And B1's `registerNamespace` slot collision now throws the registered `GatewayBridgeSlotOccupied` (was a bare `Error`), asserted through the `gatewayReady` rejection path. **Deferred (`TODO(A2.2)`):** `createSession({ sessionId })` threading the store + calling `hydrate()` at init, loop-executor awaiting `flush()` at execution end, and the errored-status-transition + retry policy — the cross-package session/executor barrier wiring. Reference adapters (fs/sqlite/postgres) are follow-on packages; the port is locked.

**B1 — `GatewayExtension` (#254) — LANDED (reviewed + approved).** ADR 50 (`blueprint/50-gateway-extensions.md`) is implemented: `GatewayExtension { target: "gateway", install(GatewayInstaller) }` mirroring the existing pair; the installer ships `registerWireExtension` (third install path into the ADR 46 registry, pre-seal only), `registerNamespace` into a new `GatewayBridges` empty seed (occupied slot ⇒ **throw** — hard singleton), `subscribeBus`, `onClose`, and the `gateway` host handle. `ExtensionBundle { gateway?, app?, session?, wire? }` resolves #297: distributed by scope in `GatewayHarness` construction — gateway parts install now, wire parts register into the ADR 46 registry, app/session parts cascade to every `createApp`/`createSession` (composed BEFORE per-call). Wire registry seals in a `finally` after the install phase, so a throwing `install()` fails `createGateway` cleanly (no half-sealed registry). **Two design points decided in ADR 50's 2026-07-01 amendment:** (1) `interceptIngress` (the auth seam) is **deferred to ADR 34/#302**, which owns `IngressContext` + transport wiring — NOT shipped in B1; added later as a non-breaking `BaseInstaller` extension. (2) Gateway bridges are a hard singleton (no outer scope ⇒ duplicate = collision ⇒ throw); app-side `extensionBridges` stays **last-writer-wins** by design (sits under the cascade ⇒ duplicate = override). 19-test adversarial suite (`gateway/src/__tests__/gateway-extensions.spec.ts`). **Retro-driven cleanup folded in:** `subscribeBus` was hand-rolled with an `Effect.promise` fiber-killing defect (a throwing listener silently stopped all delivery) + a fiber leak on close — the fork-a-bus-subscription dance was triplicated across App/Session/Gateway installers and had already diverged. Extracted to `runtime/src/substrate/fork-bus-subscription.ts` (`forkBusSubscription`, canonical error-isolation + atomic teardown; sibling to `busAsyncIterator`), collapsing three call sites; 7 helper tests including the deterministic unsubscribe-stops-delivery pin (via `LocalEventBus.subscriberCount()`).

**ADR 49 — durability — DRAFTED (implementation pending; TimelineStore next).** ADR 49 (`blueprint/49-stores-not-snapshots.md`) pins the durability model: three state classes (A authoritative / B re-derivable / C ephemeral, declared per harness README); Class A durability via per-harness **store ports** generalizing `CredentialsStore`; `TimelineStore` is the flagship (persisted tier store-backed, projection tier derived-never-stored, memory-authoritative write-behind + `flush()` barrier at execution end, write-through opt-in, `createSession({ sessionId })` = idempotent open-or-rehydrate); journal reclassified as observability+idempotency ledger (L7 → TTL/LRU; `DurableJournal` stays the v2.x rung-(d) seam); snapshot demoted to spawn-seeding / opt-in Class-C hibernation / cluster warm hand-off; cluster failover = rehydration + execution leases. Reference adapters: `timeline-fs-next` (JSONL, local pole) + `timeline-postgres-next` (Knowify pole). Pending Ryan review (⛔ gate per CUT-PLAN); the store-port contract + `TimelineStore` is the next build (A2).

**Previously, 2026-07-01 — CUT-PLAN.md drafted: the work plan from Phase 5 to the v2.0 cut.**

Principal-engineer review session produced [`CUT-PLAN.md`](CUT-PLAN.md) — five workstreams sequenced to the v2.0 cut: (A) "Stores, not snapshots" durability model (ADR 49 to be written: state-class taxonomy authoritative/re-derivable/ephemeral, per-harness store ports generalizing the `CredentialsStore` pattern, `TimelineStore` flagship with fs + postgres reference adapters, journal reclassified as observability+idempotency ledger which reduces L7 to a TTL fix, snapshot demoted off the durability critical path, resume = load stores + re-render); (B) gateway completion for the multi-tenant distributed cluster mission (#254 gateway-extensions ADR first — it's the recurring blocker — then auth-at-the-edge principal extraction, wire-extension train #297→#298→#299→#313→#308, MCP slices, cluster failover-by-rehydration + execution leases, Redis fan-out validation against the Knowify Socket.IO-Redis workload); (C) v1 parity landing on gateway (connectors ADR + telegram/imessage ports, channels mapping, express adapter, sandbox providers, devtools, scheduler, terminal tools + continuation-policy hook); (D) `agentick` metapackage + two reference personas (local openclaw-style, cloud ernesto-shaped) with tentickle 100% migration as a cut gate; (E) Effect-containment charter + #103 consolidation + slot-collision guards + missing READMEs. Derived from a four-plane packages-next audit, a full transcript mine (796 user messages), a v1 gap inventory, and a read of the Knowify adopter code (ernesto + assistant-api `V1SessionStore`).

**Previously, 2026-06-30 (later) — ADR 46 drafted (#280 design): Wire extensions — extensible JSON-RPC namespaces on the Agentick client↔gateway wire.**

ADR 46 codifies how packages contribute to Agentick's wire protocol (the Agentick client↔gateway protocol; NOT to be confused with the MCP protocol that gateway-internal `McpClientHarness` speaks to external MCP servers — that's a separate layer). New `WireExtension` primitive: a namespaced bag of typed method handlers + notification declarations + auth metadata + cluster-routing hints. Registered with the gateway at construction; dispatched when matching JSON-RPC arrives. Two install paths to one registry — packages self-install via their `withX` composite (`withMCP` returns `{ session?, app?, gateway?, wire? }`), adopters use `createGateway({ wireExtensions: [...] })` for ad-hoc custom RPC. Built-in packages expose adopter-configurable hooks on their config (`withMCP({ hooks: { beforeReauthenticate, afterReauthenticate, filterClients } })`) — the package's wire handler bodies call hooks at lifecycle points, so adopters customize behavior without authoring raw RPC handlers. Capability discovery is non-optional: built-in `_extensions/list` method, `client.capabilities` populated at connect time, UI gates feature availability. Three locations per wire-aware package: type augmentation (shared between client + server builds via `declare module`), server-side `WireExtension` value (Node bundles), client-side helper library (React hooks / typed proxies, browser bundles). Cross-refs ADR 33 (Client + transports), ADR 32 (extension shape spectrum), ADR 27 (modular built-ins). Depends on #254 (gateway-extensions framework — still needs design). First canonical user lands #279 (MCP client wire projection) + #277d (React useMcpClients hook).

**Previously, 2026-06-30 — ADR 45 drafted (#284 design): Runtime context model — structural identity, propagated context, journal envelope.**

ADR 45 codifies the three-layer model for how identity + ambient state move through the framework: (1) auth-bearing resources encode principal in their CONSTRUCTION (`McpClientHarness` for user-42 ≠ user-43 — structural, not contextual), (2) `RuntimeContext` carries typed dimensions (sessionId/opId/correlationId/traceparent) PLUS an adopter-augmentable `RuntimeContextUser` slot (empty-seed module augmentation, mirrors `HookBridges`), (3) `Operation.scope` collapses into RuntimeContext (one source of truth — operations READ + ENRICH ambient context, don't carry their own scope field). The propagation primitive `runWithContext` writes to BOTH the Effect FiberRef AND an `AsyncLocalStorage` so `readContext()` works across plain async boundaries (post-`Effect.runSync`, callback-based libs, fetch chains). Tool handlers become dual-typed server-side — Promise OR Effect return — same convention as the kernel procedure layer. Client SDK stays Promise-only. Framework primitives NEVER trust adopter `ctx.user` for authorization; adopters can use it for telemetry/branching at their own risk. This unblocks #280 (wire extensions taxonomy needs settled context model), #289 (principal-bearing harness audit — structural identity rule), #290 (capture-replay sweep — residual after ALS coupling). #288 (narrow `RuntimeContext.request`) becomes the destructive prerequisite this ADR specifies the constructive replacement for. Driven by the #277b multi-tenant caveat (OAuth provider's `loadTokens` runs outside Effect → `readContext()` returns EMPTY_CONTEXT → multi-tenant key derivation silently broken).

**Previously, 2026-06-29 (later) — ADR 42 Slice 3 lands (#266): `Skills` + `Tasks` aliases + `withSkills` / `withPrompts` slot refresh.**

`spec-next` now exports `Skills` (= `SkillsHarnessProtocol`) + `Tasks` (= `TasksHarnessProtocol`) adopter-facing aliases, joining the existing `Prompts`. Each ships a matching `isSkillsInstance` / `isPromptsInstance` / `isTasksInstance` structural guard so adopters can discriminate slot forms without touching internal types. The previously-local `isPromptsInstance` inside `mcp/server/config.ts` is gone — single canonical guard now.

`withSkills` and `withPrompts` extension factories accept the trichotomic slot: array shorthand (sugar for `{ initial }`), instance shorthand (`Skills` / `Prompts` instance — adopter owns lifecycle, no per-session construction), or the full config object with a `use:` escape hatch mutually exclusive against `initial` / `loaders` (and `renderers` for prompts). `resolveSlot` is exported per package for adopter inspection. Per-package `slot-trichotomy.spec.ts` suites (10 skills, 11 prompts) verify every form.

`withTasks` is **intentionally exempt** from the trichotomy — the per-session `TasksHarness` is owned by `AppHarness` via the single-construction-site pattern (#159), not by this extension. Constructing another via the slot would collide on the inbox address. README §"About the trichotomy" calls out the exemption + the reason; the `Tasks` alias still lands for downstream code that takes a `Tasks` reference directly.

ADR 42 audit rows updated for skills / prompts / tasks; the trichotomy is a CONVENTION, not a religion — `withTasks` documents why it can't fit. Workspace tests 7173/7188 green; the 7 pre-existing flakes (packages/core v1 reactive-session, cluster-broker reconnect, SessionTree) are unchanged.

**Previously, 2026-06-29 — ADR 42 Slice 2 lands (#265): `Tools` alias + `mcp-next/server` `tools` slot refresh.**

`@agentick/spec-next` exports `export type Tools = ToolExecutorProtocol;` (adopter-facing noun alias) + a structural `isToolsInstance` guard. The mcp-next/server `tools` slot now accepts the trichotomy-aligned shape: `tools: CreatedTool[]` (array shorthand — server splits each into the registry + handler resolver) OR a config object with either inline `tools: CreatedTool[]` OR the low-level `{registry, resolveHandler}` escape hatch (mutually exclusive — `resolveToolsOption` xor-validates at construction time). Filter + transforms work the same on both. Per ADR 43 the handler receives the LIVE `McpRequestContext` (transport: "mcp", `mcp.*` nested) directly — no stub-ctx + no result-shape gymnastics; the spawn-time `normalizeTools` + `createStubHandlerCtx` shims that papered over the old single-shape slot are gone (dead code purged, "no production users" rule).

`spawn.ts` simplified to a pass-through (`SpawnStandaloneOptions extends McpServerOptions`) — the trichotomy at the harness layer absorbs every sugar previously bolted on at the spawn shim. 100/100 mcp tests + 9/9 new `tools-slot.spec.ts` green. Workspace typecheck clean.

Form B (a `Tools` / `ToolExecutorProtocol` instance via `use:`) and the `server.tools` getter remain deferred — blocked on `DispatchInput.ctxOverride` spec evolution because `ToolExecutor.dispatch` builds its OWN `ToolHandlerCtx` and would clobber the MCP `transport`/`mcp.*` discriminator fields. Adopters with an existing executor today can project its registry via the low-level escape hatch. ADR 42 audit row updated; Slice 2 marked ✅ landed.

**Previously, 2026-06-28 (later still) — ADR 40 lands: MCP server harness shape resolved.** Closes the open §"Server-side: shape is OPEN" question from ADR 23. Decisions: Shape 1 harness at gateway scope (NOT session); one package with standalone-process + gateway-extension modes; multiple servers per process; declarative object config; per-connection filters + transforms (NOT per-server pre-baked); security pipeline ported verbatim from v1 (5 named stages); OAuth 2.1 spec-aligned (RS by default, optional embedded AS); internal agents use direct projection (`mcp://gateway/<name>` URL form). Resources defer until #123 lands — additive without shape changes.

v1 audit (20k LOC `packages/mcp/`) catalogued for porting: security stages (`bearerTokenAuth`, `roleBasedAuthz`, `slidingWindowLimiter`, `allowListGuard`), `SamplingAPIImpl.structured()` retry loop, `ElicitationAPIImpl` flat-schema validation, roots path safety, completion builders. Tool transforms (rename / prefix / restrictInput / wrapHandler / alias) are net-new — landing as `@agentick/tool-next/transforms` (#171a) because they're useful beyond the MCP server.

First batch of #171 implementation tasks filed: #171a (transforms), #171b (skeleton + spec types), #171c (stdio + tools projection + security pipeline MVP). Total estimated effort ~16 days across 9 subtasks per ADR 40 rollout plan.

**Previously, 2026-06-28 (earlier) — Skills + Prompts loaders gain `reload()` + lookup-on-miss.** Both harnesses now retain their configured loaders and expose:

- `session.skills.reload({ pruneMissing? })` / `session.prompts.reload({ pruneMissing? })` — re-walk loaders, diff against current state, apply adds + updates (+ optional removes).
- `session.skills.resolve(name)` — async lookup-on-miss read.
- `session.prompts.resolve(name)` — same, plus `invoke()` / `get()` transparently call `resolve` on cache miss before throwing `PromptNotFound`.

`Loader<T>` (in `@agentick/utils-next/loaders`) gains optional `lookup(name): Promise<T | null>` for fast-path resolution; built-in `fromX` factories implement it. Loaders without `lookup` fall back to `load()` + filter on the harness side — same correctness, worse perf. 19 dynamic-surface tests across the two packages bring the total to 98/98 (skills + prompts + prompts-react).

**Previously, 2026-06-28 (earlier) — Skills loaders (#246) + Prompts loaders (#247) close. `withSkills({ loaders })` and `withPrompts({ loaders })` accept the harness-shaped `SkillLoader[]` / `PromptLoader[]`. Subpaths: `@agentick/skills-next/loaders` + `/loaders/node`; `@agentick/prompts-next/loaders`. Composed from the loaders primitive layer in `@agentick/utils-next/loaders{,/node}`.**

Skill loaders are uniform (`fromArray` / `fromUrl` / `fromManifest` / `fromFile` / `fromDirectory`) because `Skill.content: string` carries no functions — every source is sound. Frontmatter parsing defaults to a minimal `key: value` (with quoted strings + inline arrays); adopters override `parseFrontmatter` for full YAML / TOML to avoid pulling a dep at the framework level.

Prompt loaders are intentionally narrower (`fromArray` / `fromModule` / `fromStaticUrl`) because `render(args)` is a function: `fromStaticUrl` enforces at load time that no loaded prompt names a `render` field, with a helpful error pointing adopters toward `fromModule` for dynamic prompts. No `fromDirectory` here — JSX `.tsx` on disk needs a bundler, which is a framework-binding concern.

31 loader tests green (19 skills + 12 prompts) on top of the existing 29 harness tests for these two packages.

**Previously, 2026-06-28 — Native foundation #5 closed: `@agentick/prompts-next` (core, Shape 1 harness) + `@agentick/prompts-react-next` (React binding) ship.**

Prompts harness mirrors MCP `prompts/*` shape (so #171 server projection is a passthrough). `PromptDeclaration { name, description, arguments?, template?, render?(args) }`; Standard-Schema arg validation; `register/update/remove/get/invoke + subscribe/subscribeAll` surface; `invoke` queues messages onto the timeline via `bridges.timeline.queue`. Snapshot/restore carries names + args + description (template/render are non-serializable; adopters re-seed via `withPrompts({ initial })`).

Content shapes: core handles `string` (→ single `system` MessageEntry) and `MessageEntry[]` (passthrough) natively. Anything else flows through a registered `PromptRenderer { name, handles(content), render(content, args) }`. The React binding exposes `reactPromptRenderer` — compiles `ReactNode` via `compileTemplate` and projects context entries: `<message>` → passthrough, sections + loose content → buffered system message (explicit messages flush the buffer; section titles render as a leading `# title` text block). Cross-framework adopters do `withPrompts({ renderers: [reactPromptRenderer, angularPromptRenderer, ...] })`; single-framework adopters use the `withReactPrompts` sugar.

29 tests across the two packages green (17 in prompts-next, 12 in prompts-react-next). Typecheck clean for both. Open: prompt loaders (#247 — `withPrompts({ loaders: [fromArray, fromUrl, fromModule] })`) deferred to a follow-up commit; MCP server projection (#171) deferred to the server harness work.

**Previously, 2026-06-28 (later) — `renderTemplate` + `compileTemplate` ship on `@agentick/reconciler-react-next`; `formatTree` + per-formatter framing ship on `@agentick/formatters-next`; harness `renderToString` migrated to delegate.**

The capability that came out of the ADR 39 compiler-experiment post-mortem: use the existing reconciler infrastructure (compile-until-stable loop, collect walker, `useData` semantics) as a one-shot template renderer without spinning up a session / harness / journal / operation wrap. Two entry points:

- `compileTemplate(element, opts) → { tree, diagnostics, iterations }` — JSX → `RenderedTree` IR
- `renderTemplate(element, opts) → { output, diagnostics, iterations }` — JSX → formatted string via `formatTree`

For static-template use cases: prompt rendering, MCP server prompts / resources (#171), tool descriptions, skill content (`@agentick/skills-next`), snapshot tests, doc generators. Reactive workloads (knobs, `<Tool>` factories, session state, channels) continue through `createApp` + full `ReconcilerHarness`.

`formatTree(tree, defaultFormatter, opts?)` lives in `@agentick/formatters-next`. `DefinedFormatter` gained three optional tree-level serialization methods (`frameSection`, `frameMessage`, `blocksToText`) — each formatter owns its own section/message framing and block-flatten rules; 3rd-party formatters supply theirs for full control or fall back to markdown-flavored defaults.

The reconciler harness's inline `serializeTreeToString` (~190 LOC, marked "Phase 4a pending" since 2026-05) is gone; `renderToStringBody` delegates to `formatTree`. Two modes preserved exactly: per-entry `renderedWith` honored when caller doesn't pin a formatter; caller-pinned formatter overrides everything.

Test pinning: `render-to-string.spec.tsx` (13), `formatter-registry.spec.tsx` (3), `formatter-scope.spec.tsx` (10) — all green after the swap. Full v2 suite at 178 files / 1944 tests; reconciler-react gained 15 new template tests.

**Open follow-ups tracked in tasks:**

- MCP server harness (#171) — when it lands, prompt/resource bodies should use `renderTemplate`
- Prompts loaders (#247) — `withPrompts({ loaders })` for filesystem/url-backed libraries
- Skills loaders (#246) — same shape for `@agentick/skills-next`

**Previously, 2026-06-28 — ADR 39 compiler experiment archived; reverted to `a15807362` (eval-next iter 2).** Phases 1, 1b, and 3 of the JSX-template-walker work (introduce `@agentick/compiler-next` + `@agentick/compiler-react-next` as a parallel walker, then migrate the reconciler over) are reverted as a discarded experiment. The reconciler's existing `collect/` walker already does what the compiler walker did — including compile-until-stable, formatter scope (HostScope), and contributor extensibility. The parallel implementation was unjustified duplication; no real consumer ever materialized outside the new packages' own tests.

**Archived for reference:** `git tag archive/compiler-phase-3-experiment` preserves the full 16-commit experiment tree (Phase 1 + 1b + 3 substeps 1a–3b). Recover with `git reset --hard archive/compiler-phase-3-experiment` if direction changes.

**What carried forward as small follow-up commits on `feat/v2`:**

- `2a898c76` `feat(session-next): track reasoning + cached + cache-creation token usage` — unrelated bug-class improvement that landed alongside the experiment; isolated and preserved
- `e91e9424` `feat(utils-next): isThenable — duck-typed PromiseLike predicate` — generic utility carved out of the experiment; useful broadly

**Lessons that carry forward as practice (not yet ported to code, tracked):**

- Diagnostic-channel pattern — every silent-drop path in the walker (media missing source, malformed event blocks, etc.) should emit a stable-coded `FormatDiagnostic` rather than discarding the JSX node. Worth porting to `reconciler/collect/contributors/*.ts`.
- Three of the five "declaration" JSX intrinsics shipped in v1 have **no runtime consumer**: `<output>` (entirely stubbed), `<mcp>` (replaced by `withMCP({...})` extension), `<resource>` (resource runtime is pending — #123). `<tool>` is half-wired: the layered-tools work (#137) explicitly dropped the executor's `tree.declarations.tools` dependency. The "JSX intrinsic produces an IR field" model is legacy from v1; v2's "extension factories + layered options" superseded most of it without retiring the JSX intrinsics. Worth a deliberate cleanup pass.
- The `RuntimeDeclarations.mcp` singular field name is misleading — it's a plural array. `mcpServers` would read better. Small spec PR if desired.
- Structured outputs (`<output>` / `responseFormat` / "terminal tool") is an unresolved design question, not a feature. Three candidate models, none implemented end-to-end. Worth a dedicated ADR before any more code lands.

**Meta-lesson:** Audit existing code paths before extracting new packages or layers. The compiler walker duplicated the reconciler's render-until-stable + collect walker; the audit takes minutes and would have caught this at Phase 1 scope time.

**Branch state restored to:**

- 177 test files / 1925 tests green (matches pre-experiment baseline)
- Workspace typecheck clean modulo pre-existing v2-real handler-signature drift (`example/v2-real/src/agent.tsx:30` — long-standing, unrelated to revert)
- Origin/feat/v2 is at `9f77ea9c` and is behind local feat/v2 by 16 commits — non-force push to origin is safe

---

**Previously, 2026-06-26 (eval-next MVP shipped) — `@agentick/eval-next` iteration 1 lands.** `defineEval(definition)` returns a callable function; `await myEval()` runs with definition defaults, `await myEval({ executor: X })` overrides any `createApp` slot for one invocation. Iteration-1 surface: `t.send/completed/calledTool/notCalledTool/noFailedActions`. Two subpaths: base (reconciler-agnostic) + `/react` (defaults reconciler to `reactReconciler()`). 8/8 tests pass.

Substrate-level groundwork: `BaseHarness.runOperation` now stamps `op.input` as the `requested` envelope's payload — the blueprint's phase contract pins requested as "argument bound"; previously the field was empty, so eval ledgers had to find the input some other way. With this change, ANY subscriber (eval, OTel exporter, replay harness) sees what was invoked alongside the operation envelope. Verified non-breaking across the v2 workspace (1909/1909 tests).

Eval-next iteration roadmap (deferred): `.matrix(axes)` parameter sweeps, `t.judge(rubric)` LLM-as-judge, tool stubs, fixtures/cassette replay, cost accounting, streaming-event assertions. See [ADR 37](blueprint/37-eval-package-sketch.md) for the sketch.

---

**Previously, 2026-06-26 (Phase 5 closed) — Phase 5 — cluster fusion: `defineXCluster + createApp/createGateway` now actually does something.** Six commits land:

1. **5b — nodeId auto-default**: `defaultNodeId()` / `resolveNodeId()` in `@agentick/cluster-next`. Adopter calls collapse to `defineUnixCluster({ socketPath: "..." })` — no nodeId arg required; falls back to `${hostname}:${pid}` with a `cluster:nodeId:auto-defaulted` diagnostic, OR a `cluster:nodeId:suspicious` warning if hostname is empty/"localhost" (the container-without-HOSTNAME footgun that would otherwise silently corrupt cluster routing). Strict guard at the public-API boundary (`defineXCluster` / `joinXCluster`); internal `XClusterNodeOptions.nodeId` stays required.

2. **5c (app)** — `createApp({ cluster: ClusterFactory })` resolves the factory at construction against a synthesized `ClusterParent`, swaps the substrate to the wrapped versions, and registers cluster close as part of `app.closeApp()`. Substrate factories incompatible with `cluster` (can't resolve factories without the parent shell they'd be constructing) — clear error if mixed. `AppHarness.addInternalCloseHandler(h)` is the new internal slot.

3. **5c (gateway)** — `createGateway({ cluster })` same pattern. Apps spawned via `gateway.createApp(...)` inherit the cluster-wrapped substrate automatically via the existing `bus = input.bus ?? this.bus` default chain. Gateway-owned cluster is THE cluster for all spawned apps — no per-app cluster option, no "precedence" code path needed. `closeGateway()` closes all apps first, then the cluster, then super.close().

4. **defineLocalCluster** — the "fifth wire" testing factory. In-memory ClusterFactory backed by `LocalClusterRegistry`. Optional registry arg (auto-creates for single-node tests; explicit for multi-node simulation). Lives in `@agentick/cluster-next/testing`.

5. **trackPendingAck bug fix** — surfaced via the v2-otto-cluster demo. `subscribeBus`/`subscribeInbox` called before client handshake completes was orphaning the flush()'s Promise; idempotent track preserves the original Promise across the onWelcome re-subscribe loop.

6. **joinXCluster facades** (Phase 4f.7) — `joinUnixCluster`/`joinTcpCluster`/`joinWsCluster`/`joinRedisCluster`. Side-channel cluster wiring for coordination outside the agent loop (proof: `example/v2-otto-cluster` worker went from 148 → 75 LOC). Shared facade builder `makeClusterNode` in `@agentick/cluster-next` hosts the bus / membership.waitForPeers / lifecycle plumbing wire-agnostically.

**ADR 38 — Cluster lifecycle + ownership rules** pins the contract:

- Pattern A (defineXCluster + createApp/createGateway) → framework owns lifecycle
- Pattern B (joinXCluster) → caller owns lifecycle
- One cluster per process (multi-app = gateway-level wiring)
- Cluster requires substrate INSTANCES, not factories
- The `{kind: "unix" | "tcp" | ...}` config form was considered and rejected — runtime missing-package crashes + dynamic-import smell

**ADR 37** sketched the future `@agentick/eval-next` package (testing-shaped framework for evaluating agents/models/tools). Not implementing now.

**Workspace test status**: cluster + app + gateway suites at 281/281. Full v2 workspace remains green at the previous Phase 4 count + Phase 5 additions.

**Deferred to Phase 6+**:

- Real-Redis conformance via docker-compose
- Double-wrap detection (brand cluster-wrapped substrates so a second wrap can refuse)
- Per-app clusters under a gateway (hybrid topologies — drop to `joinXCluster` today)
- Cluster swap mid-flight
- Conformance suite parameterized over all four wires for the integration path
- `@agentick/eval-next` iterations 2+ (matrix sweeps, judge, fixtures, cassette replay, cost accounting)

**Phase 5 closed.** Cluster machinery is now consumed by app/gateway. The "build it once, configure ergonomically" loop is complete; what remains is hardening + real-world adoption signal.

---

**Previously, 2026-06-26 (Phase 4 closed) — Cluster Phase 4f–4g — production-ready cluster wire stack across all four packages.** Eight commits land:

1. **4f.1 — strict-typecheck sweep**: 9 v2 packages had silently regressed `tsconfig.json` since a 2026-06-12 fix; restored across spec, utils, pubsub, tasks, cluster, cluster-broker, cluster-net, cluster-ws, cluster-redis. Surfaced months of accumulated test-fixture drift (deleted obsolete tests for removed features; updated tests for shape-changed types). Fixed a latent `Factory<R, P>` type-soundness bug where `R | Promise<R> | Effect<R, never, never>` was collapsing to `unknown` in TS inference.

2. **4f.2 — DRY consolidation**: extracted `startBroker` / `createClusterNode` / `defineWireCluster` from the three near-identical wire packages into `cluster-broker-next/wire-helpers.ts`. Per-wire LOC dropped ~30%; future wires (Redis, future custom) reuse the helpers transparently.

3. **omitUndefined sweep**: shipped `@agentick/utils-next/omitUndefined` and mechanically swept ~780 instances of `...(X.Y !== undefined ? { Y: X.Y } : {})` across packages-next/. Restricted to pure-forwarding (backreference-enforced LHS = value); thunk-value patterns (`codec: () => opts.codec!`) intentionally untouched (collapsing them would change semantics). Multi-line variants normalized via two-pass perl.

4. **4f.3 — internal re-election (Unix)**: `electableUnixClusterNode` wraps `unixClusterNode` with a diagnostic-event watcher. After K consecutive connect-failed events (default 5), surviving workers race to bind the vacated socket via `tryBindOrConnectUnix`; winner spins up a local `BaseBroker` adopting the bound server. Single-host broker failover without external supervisor restart. TCP/WS multi-host re-election explicitly out of scope (cross-host consensus = wrong fit; use Redis Sentinel via cluster-redis-next).

5. **4f.4 — backpressure**: per-connection `BoundedWriteQueue<BrokerFrame>` (default 1024 frames). All broker → client writes go through queue.enqueue (sync); per-conn background drain. Slow client no longer blocks fan-out; broker memory bounded under sustained slow-consumer stress. Drop-oldest overflow + `cluster:broker:server:backpressure-drop` diagnostic.

6. **4f.5 — BrokerCodec wrapper**: centralized the `as unknown as MessageEnvelope` cast (from Phase 4e) into one adapter in `cluster-broker-next/broker-codec.ts`. `BaseBroker` + `BaseClusterClient` now hold a typed `BrokerCodec` internally; adopter-facing `ClusterCodec` is unchanged. Phase 5+ msgpack/protobuf codecs implement `BrokerCodec` directly.

7. **4f.6 — graceful broker shutdown**: `BoundedWriteQueue.flush(timeoutMs = 5000)` waits for pending frames to drain. `BaseBroker.close()` enqueues FRAME_GOODBYE to every client, awaits parallel flush, then tears down listener. Fixes a regression Phase 4f.4 introduced (writeFrame became sync; Goodbye was fire-and-forget). Aligns with k8s SIGTERM grace period defaults.

8. **4g.1–4g.4 — `@agentick/cluster-redis-next` lands**: the production multi-host story. `createRedisTransport` (pub/sub channels `agentick:bus` + `agentick:inbox:<nodeId>`, two ioredis conns per node) + `createRedisMembership` (SET + per-node TTL keys, 10s heartbeat / 30s TTL / 5s poll defaults) + `redisClusterNode` / `defineRedisCluster` factories. Adopter passes ioredis clients (peer dep); the package is RESP-protocol-compatible (Redis, Valkey, KeyDB, Dragonfly, all cloud managed). 5 integration tests against a fake-Redis hub verify round-trip + broadcast + filter narrowing + membership snapshot + graceful leave. Symmetric — no broker/client role; Redis IS the broker.

**ADR 35 (cluster-protocol)** gains a §10 "Deployment tiers" section that documents the honest tier matrix: dev (none) / single-host (Unix + electable) / multi-host (Redis) / edge (TCP-WS + external supervisor). The "use Redis for multi-host" recommendation is explicit; our broker is for single-host or specialized edge.

**TODO sweep**: retired three resolved phase-4 TODOs (BrokerCodec, per-conn backpressure, listener consolidation). Remaining TODOs catalog deferred concerns to Phase 5+ (codec routing through cluster-next layer, partitioning rebalance on topology change, per-event broadcast FIFO, validator tightening).

**Workspace test status**: 1854+ tests across all cluster packages pass. Strict typecheck clean across 66/66 v2 packages.

**Deferred to Phase 5+** (explicit, ADR-documented):

- Real-Redis conformance via docker-compose (fake-Redis integration ships now; real-Redis is an infra task).
- 3-replica Otto cluster demo (the end-to-end deploy proof point; needs docker-compose infra).
- `createGateway({ cluster })` fusion (Phase 5 ergonomic win).
- DurableJournal adapter (Redis Streams).
- Real adopter signal-driven hardening (compression, TLS shorthand for wsBroker standalone-port, partitioning.onMembershipChange hook).

**Phase 4 closed.** The multi-host production story is shipped; the single-host story has automatic failover; the broker is backpressure-aware and graceful on shutdown. Next: Phase 5 begins with `createGateway` cluster-config fusion.

---

**Previously, 2026-06-25 (Phase 4e) — Cluster Phase 4e — `@agentick/cluster-ws-next` lands. WebSocket wire shipped + uncovered + fixed a latent ClusterCodec type-soundness bug across the cluster build graph.** 16/16 cluster-ws tests green; 148/148 across all four cluster packages. The package mirrors cluster-net's shape (transport + membership multiplexed over one connection, broker mounted standalone OR on adopter's `http.Server`) but uses WebSocket-native message boundaries instead of length-prefix framing. Subprotocol negotiation (`agentick-cluster-v1`) provides forward-compatible versioning; `allowedOrigins` policy rejects unauthorized browser clients; path-prefix routing keeps cluster upgrades from conflicting with adopter HTTP handlers. Verified by 6 WS-specific tests on top of the conformance suite: subprotocol rejection of mismatched clients (×2), mount-coexists-with-other-handlers (×2), origin policy enforcement (×1), connector connect-timeout (×1).

**The uncovered bug:** Building cluster-ws against the cluster build graph surfaced a long-standing type-soundness violation in `packages-next/cluster/src/define.ts` — `resolveFactoryAsync<R, P>(factory: (parent: P) => R | Promise<R> | unknown, ...)` collapsed to `unknown` in TS inference. Every `transport`/`membership`/`partitioning`/`journal`/`codec` resolved-to-unknown, downstream assignments cast through implicit-any. The cluster package's `tsconfig.json` has `"include": []` and references `tsconfig.build.json`, so `pnpm typecheck` (running `tsc -p tsconfig.json --noEmit`) was checking NOTHING — the typecheck script was a silent no-op against the cluster source. Fixed by narrowing the factory's return-type to the documented `R | Promise<R> | Effect.Effect<R, never, never>` union. Once R was correctly inferred, two more cascading errors surfaced in cluster-broker (`writeFrame` passing `BrokerFrame` to a `ClusterCodec.encode` typed for envelopes only — TODOs added documenting the codec-shape gap; cast at boundary is the temporary bridge). A new `createJsonCodec()` synchronous helper was added so wire impls (cluster-net, cluster-ws) can construct the default codec directly instead of invoking `jsonCodec()({} as never)` which returned the factory union.

**Architectural follow-ups documented in-code (TODOs):**

- `phase-4f`: `ClusterCodec` is typed for envelopes only at cluster-next layer; broker frames (Hello/Welcome/Subscribe/SubscribeAck/Membership) piggyback the same codec — JSON tolerates anything; msgpack/protobuf would need broker-specific schema. Cast at boundary documented in `base-broker.ts:writeFrame` and `base-cluster-client.ts:writeFrameRaw`. Follow-up: introduce a `BrokerCodec` that wraps `ClusterCodec` + handles broker frame schema separately.
- `phase-4e-followup`: TCP/Unix/WS listener/connector/cluster modules now follow a near-identical shape across cluster-net + cluster-ws. After Phase 4f Otto demo proves adopter ergonomics, consider a shared `cluster-wire-base-next` package — TODO documented at top of `ws-listener.ts`.
- **Strict-typecheck gap in cluster-next:** `tsconfig.json` has `"include": []` so `pnpm typecheck` runs a no-op. This is a violation of the strict-typecheck memory rule. Phase 4f cleanup should fix the include to `["src"]` so spec drift gets caught at `pnpm typecheck` time, not at downstream build time.

**Workspace:** 148/148 across all four cluster packages — 25 cluster-wrappers + 10 cluster local-conformance + 31 cluster-broker conformance + 14 cluster-net verification + 10 TCP conformance + 10 Unix conformance + 7 Unix stale-cleanup + 10 WS conformance + 6 WS verification. New: `@agentick/cluster-ws-next` (`ws-connection.ts`, `ws-shared.ts`, `ws-listener.ts`, `ws-connector.ts`, `ws-cluster.ts`, README, conformance + verification specs). Workspace registrations updated (typedoc + vitepress).

**Next:** Phase 4f — Otto cluster demo. Real multi-process scenario validating TCP + Unix + WS wires end-to-end with adopter-shape API. Followed by the wire-base DRY consolidation if adopter signal supports it.

**Previously, 2026-06-25 (later still) — Cluster Phase 3.2 — safety pass: Effect.async cancel, wire validation, namespace enforcement, InboxError round-trip, spec-evolution-safe guards.** Closes the load-bearing gaps the Phase 3.1 retrospective surfaced. Eight items:

1. **`Effect.async` cancel hook in `askRemote`.** Returns `Effect.sync(() => { ... })` from the register callback. On caller-interrupt (`Fiber.interrupt`, scope close, etc.) the hook fires: clear the timeoutHandle, delete from pendingAsks, emit `cluster:ask:interrupted`. Pre-3.2, interrupted asks orphaned the Map entry + timer until the timeout naturally fired — under load that's one leak per interrupt.

2. **Wire payload validation at the cluster boundary.** New `isClusterAskRequestPayload` / `isClusterAskResponsePayload` runtime validators in `internal-wire.ts`. `handleInboundAskRequest` rejects malformed requests with `cluster:ask:invalid-payload` (drops envelope; doesn't feed garbage into `local.ask`). `handleInboundAskResponse` validates before resolving the pending Deferred — pre-3.2 a wire-corrupted or attacker-controlled response could deliver a value typed as `R` without any check.

3. **`@cluster/` namespace enforcement.** `ClusterInbox.register` rejects `address.startsWith("@cluster/")` with `RoutingFailed`. `send` and `ask` reject both reserved addresses AND reserved message types. Pre-3.2 the namespace was documented as reserved but not enforced — an attacker (or careless adopter) could register a handler at `@cluster/asks:node-X` to intercept ask responses, or send a forged `@cluster/ask-response` envelope to resolve a pending Deferred with attacker-controlled data.

4. **InboxError round-trip fidelity.** `ClusterAskResponsePayload` now discriminates `handler-fail` vs `routing-fail`. `causeToAskFailure` recognizes both `MessageHandlerError` AND `InboxError` separately and ships the correct tag. Asker reconstructs the typed error with the original `_tag` preserved (`AddressNotFound`, `RoutingFailed`, `InboxClosed`, `AskTimeout` all round-trip). Pre-3.2 only `MessageHandlerError` was preserved; `InboxError` from remote `local.ask` collapsed into a synthesized `HandlerError` wrapping the original — caller couldn't distinguish "remote handler failed" from "remote inbox was unreachable."

5. **Membership-partitioning integration test.** New end-to-end test wires a live-mutable `membership.nodes()` and verifies `ownerOf` observes new nodes after a topology join. Sweeps 100 addresses to statistically prove rebalance. Pre-3.2 the membership-reactivity test only proved bus event emission while the mocked `nodes()` returned a static list — partitioning behavior under topology change was one spot-check away from regression.

6. **Diagnostic event coverage.** Pinned tests for `cluster:ask:dispatched`, `cluster:ask:resolved`, `cluster:ask:timeout` (real handler-stuck timeout, not no-handler proxy), `cluster:ask:response-orphaned` (forged response envelope), `cluster:ask:invalid-payload`, `cluster:ask:interrupted`, `cluster:transport:broadcast:failed`, `cluster:event:malformed`. Pre-3.2 only `cluster:transport:send:failed` and `cluster:routing:address-not-found` had tests — "Every claim needs a test" memory rule violated. Now every documented diagnostic has a verifying test.

7. **Spec-evolution-safe type guards.** `isMessageHandlerError` / `isInboxError` use `Record<TagUnion, true>` initializers — the TypeScript compiler enforces that the Record covers every tag in the union. If spec adds a tag to `MessageHandlerError`, the initializer fails to compile until the guard is updated. Pre-3.2 the guard was hand-rolled (`tag === "HandlerError" || tag === "InvalidPayload"`); a new spec tag would silently downgrade to a synthesized `HandlerError` defect path. Same pattern for `InboxError`.

8. **`ClusterEventBus.onRemoteEvent` shape validation.** `isValidProtocolEvent` minimum shape check (`id`/`surface`/`name`/`phase`/`timestamp`/`scope`) before `local.append`. Garbage from a misbehaving transport adapter emits `cluster:event:malformed` and drops; pre-3.2 it would corrupt the ring buffer.

**Bonus:** Replaced hand-rolled `typeof value !== "object" || value === null` checks throughout with `isObject` from `@agentick/utils-next`. The predicates package owns the canonical type guards; cluster wrappers consume them instead of re-rolling. Caught by user mid-implementation.

**`@agentick/pubsub-next` audit:** Checked all pub-sub-shaped code in the cluster package. (a) `pendingAsks` is one-shot Deferred-by-correlation — not pub-sub. (b) `DiagnosticEmitter` publishes through the canonical `EventBus`. (c) `LocalClusterRegistry` (testing fixture only) has filter-aware fan-out — `KeyedNotifier` doesn't model subscription-side filters, so refactoring would restructure the registry/transport boundary rather than simplify it. No production pub-sub hand-rolls; the registry's pattern is the right primitive for its filter contract.

**Workspace:** 57/57 across cluster-next (12 new tests added in Phase 3.2: namespace enforcement × 4, caller-interrupt cleanup × 1, wire validation × 1, bus shape validation × 1, membership-partitioning × 1, ask lifecycle diagnostics × 3, broadcast failure × 1). Typecheck + oxlint + oxfmt clean.

**Phase 3 retrospectives → 3.1 → 3.2 closed the load-bearing gaps surfaced by each iteration.** The cluster package is now ready for Phase 4 adapters to depend on: cross-node ask works with full typed-error fidelity, interrupt-safe, payload-validated, namespace-enforced; every documented diagnostic is test-pinned; spec evolution is compiler-caught; bus inbound is shape-guarded.

**Next:** Phase 4 — `@agentick/cluster-ipc-next`. First real adapter; cross-runtime broker over Unix socket / TCP localhost. With Phase 3.2's wire-validation contract and diagnostic surface in place, the adapter has a clear safety bar.

**Previously, 2026-06-25 (later) — Cluster Phase 3.1 — cross-node `ask` + membership reactivity + transport diagnostics + loud routing.** Closes the load-bearing gaps the Phase 3 retrospective surfaced. Six parts:

1. **`ulid` moved from runtime-next to utils-next.** The cluster wrappers (and future cross-cluster adapter packages) need monotonic ids without pulling in the in-process substrate impls. The canonical implementation lives in `@agentick/utils-next/src/ulid.ts`; `@agentick/runtime-next/src/substrate/ulid.ts` is now a re-export so existing call sites (`LocalInbox`, `MemoryJournal`) keep their import path. 253/253 across runtime-next + utils-next.

2. **Cross-node `ask` via cluster-internal wire framing.** New `wrappers/internal-wire.ts` defines the reserved `@cluster/` namespace: `@cluster/ask` (forward request type), `@cluster/ask-response` (reply type), `@cluster/asks:<nodeId>` (reply address). Adopter `MessageEnvelope` fields (type, payload, from, correlationId) pass through unmolested — the wrapper carries the inner envelope inside a `ClusterAskRequestPayload` that the receiver unwraps before calling `local.ask`. `ClusterInbox.askRemote` generates a correlationId, registers a `PendingAsk` with timeout, ships the wrapped envelope via transport.send. On the receiving node, `handleInboundAskRequest` runs the inner ask against the local handler and ships back a discriminated `ClusterAskResponsePayload` (`_tag: "success" | "fail" | "interrupt"`). On the asker, `handleInboundAskResponse` looks up the correlationId, clears the timeout, resolves/rejects the pending Effect. Typed `MessageHandlerError` (`HandlerError` / `InvalidPayload`) round-trips structurally; runtime defects collapse into a synthesized `HandlerError`. Interrupts surface as `RoutingFailed`. Timeouts honor `AskOptions.timeoutMs` (default 30s) and emit `cluster:ask:timeout`. Close rejects every pending ask cleanly. Tests cover happy-path remote ask returning the handler value, typed failure round-trip, and timeout-on-unregistered-address.

3. **Membership reactivity.** `defineCluster` subscribes `membership.onChange` at construction and emits one of `cluster:membership:joined` / `cluster:membership:lost` / `cluster:membership:snapshot` per transition on the LOCAL bus (so operators see local topology truth regardless of `fanoutMode`). The subscription is registered with `parent.onClose` so it tears down in the LIFO chain. Pre-3.1 the cluster was operationally blind to topology changes — `membership.nodes()` was queried on demand but nothing reacted to deltas.

4. **Transport error diagnostics.** Replaced silent `.catch(() => {})` swallows. `ClusterEventBus.broadcastWithDiag` emits `cluster:transport:broadcast:failed { eventId, eventName, reason }` on broadcast rejection while still returning local `append` success (broadcast contract is best-effort). `ClusterInbox.sendRemote` emits `cluster:transport:send:failed { target, address, messageId, reason }` before bubbling the failure as `InboxError`. `askRemote` emits the same when the wire `transport.send` rejects before any response arrives, plus cleans up the pending entry. Adopters subscribing to `surface: "cluster"` now see real distributed-failure signal instead of silence.

5. **`ClusterInbox.dispatchInbound` discriminates errors instead of swallowing all.** Branches on env.type for the three inbound classes: `@cluster/ask` → `handleInboundAskRequest`; `@cluster/ask-response` → `handleInboundAskResponse`; everything else → `dispatchAdopterTell`. The adopter-tell path catches `InboxError` and emits `cluster:routing:address-not-found { address, messageId, from }` on the `AddressNotFound` tag — exactly the ops-debug signal pre-3.1 was hiding. `InboxClosed` (expected during teardown) stays silent.

6. **Shared diagnostic emitter + dead-config cleanup.** New `wrappers/diagnostics.ts` factors out the `DiagnosticEmitter` both wrappers consume — single code path for `surface: "cluster"` events with consistent `scope.nodeId` stamping, ULID ids, and fire-and-forget `Effect.runFork` semantics. Stripped the `label` field from the conformance-against-local call site (the field was removed from `ClusterTransportConformanceConfig` earlier; the call site was passing it via TS structural-typing tolerance).

**Workspace:** 45/45 across cluster-next (5 new tests in `cluster-wrappers.spec.ts` covering remote ask happy path, typed-failure round-trip, ask timeout, transport.send failure diagnostic, address-not-found diagnostic; 1 new test for membership reactivity). 253/253 across runtime-next + utils-next (ulid move). Typecheck + oxlint + oxfmt clean.

**Deferred to Phase 5 (createGateway/createApp integration timeframe):** Per-subscription `scope: "cluster-wide"` opt-in for the bus (currently `fanoutMode` is global per-cluster); subscriber-index gossip for `publishLazy` short-circuit in cluster-wide mode; `transport.broadcastBatch` seam for `appendBatch` bulk shipping (currently per-event serial loop).

**Next:** Phase 4 — `@agentick/cluster-ipc-next`. The first real adapter; cross-runtime broker over Unix socket / TCP localhost. Validates the wire-codec story end-to-end and lets us run real multi-process clusters on Node + Deno + Bun + PM2-spawned deployments.

**Previously, 2026-06-25 — Cluster Phase 3 — `ClusterEventBus` + `ClusterInbox` wrapper impls landed.** `defineCluster` no longer pass-through; the returned `Cluster` value carries real wrapped substrate.

- **`ClusterEventBus`** wraps a local `EventBus`. Outbound: stamps `scope.nodeId`, calls `local.append` (synchronous local fan-out), then `transport.broadcast` (cross-node). Inbound: subscribes to `transport.subscribeBus({})` at construction; under `cluster-wide-default` re-appends remote events into the local bus so subscribers see one merged stream; under `node-local-default` (default) drops remote events at the wrapper boundary so subscribers only see local activity. Defense-in-depth: drops any inbound event whose `scope.nodeId === currentNode` even if the transport adapter misbehaves. Emits `cluster:wrap:installed` and `cluster:wrap:disposed` diagnostics on the local bus for operator observability. `publishLazy` keeps its local short-circuit in `node-local-default`; over-builds in `cluster-wide-default` (remote subscriber index isn't known from here) and the README documents the trade-off. `read`/`hasSubscriberFor`/`metrics`/`subscribe` all delegate to local.
- **`ClusterInbox`** wraps a local `MessageInbox`. `send` consults `partitioning.shardKeyFor(address) → partitioning.nodeFor(shardKey)`; if `owner === currentNode` delegates to `local.send`, else stamps a `MessageEnvelope` (preserving idempotency `messageId`, defaulting `from` to `node:<currentNode>`) and forwards via `transport.send(owner, env)`. On the receiving node, the wrapper's `transport.subscribeInbox({})` callback runs `local.send(env.addressedTo, env)` so the registered handler picks up the cross-node message exactly as if it had arrived locally. `register` delegates to `local.register` (registration state isn't gossiped — addresses must live on their partition-owner). **`ask` is local-only in Phase 3** — remote ask fails with `InboxError { _tag: "RoutingFailed" }` carrying a clear "Phase 3b will land remote ask via RequestResponseRegistry" pointer; the call/response correlation across the cluster is meaningful additional plumbing.
- **`defineCluster` wiring** — both wrappers registered with `parent.onClose` so close fires in the same LIFO chain as the underlying seams. Construction order: transport → membership → partitioning → codec → bus wrapper → inbox wrapper. Top-level `cluster.close()` is defensive (calls inbox.close + bus.close directly); wrappers are idempotent on double-close.
- **No production dependency on `@agentick/runtime-next`.** Earlier draft used `ulid()` for diagnostic ids; pulled the dependency out so cluster-next stays framework-substrate-agnostic. Tests still use runtime-next as devDep for `LocalEventBus`/`LocalInbox`/`MemoryJournal` fixtures.
- **`@agentick/cluster-next/testing`** subpath unchanged from Phase 2b — `LocalClusterTransport` + `LocalClusterMembership` + `LocalClusterRegistry`. New `cluster-wrappers.spec.ts` exercises both wrappers end-to-end against two simulated nodes sharing a registry.

**Workspace:** 40/40 across cluster-next (5 files: json-codec, consistent-hash-partitioning, define, conformance-against-local, cluster-wrappers). Typecheck + oxlint clean.

**Next:** Phase 4 — `@agentick/cluster-ipc-next` (first real adapter; broker over Unix socket / TCP localhost; cross-runtime — Node.js + Deno + Bun + PM2-spawned). Phase 5 — substrate-seam integration in `createGateway` / `createApp`.

**Previously, 2026-06-23 (later still + #164) — #164 — `session.dispatch(...)` defaults to Pattern A for host-side callers; Pattern B is opt-in via `{ task: "ref" }`.** Pre-#164, dispatching a `taskSupport: "required"` tool from the host returned a `session_task_ref` content block — adopters had to `JSON.parse` the ref and then call `session.tasks.result(localId)` themselves. That was the right shape for the model-tick path (the model needs the ref to manage the task across ticks) but hostile for host callers who expect "I called dispatch, I get blocks." This change makes the host-side default await the local TaskHandle and return its final blocks. Four parts:

1. **Spec — `DispatchInput.task: "auto" | "ref" | "inline"`** added to `@agentick/spec-next/protocol/tool-executor`, alongside a new `DispatchOptions` (`task` only) on `SessionHarnessProtocol.dispatch(name, input, options?)`. `"auto"` is the default; `"ref"` and `"inline"` are explicit overrides. A new tagged error `ToolTaskModeConflictError` is added to `ToolExecutorError` for the two contradictory pre-flight cases (`{ task: "ref" } + taskSupport: "unsupported"` or `{ task: "inline" } + taskSupport: "required"`).

2. **ToolExecutorHarness matrix.** `dispatchOnResolved` no longer reads `supportMode === "required"` in isolation. It computes `usePatternB = requestedTaskMode === "ref" || (requestedTaskMode === "auto" && via === "model" && supportMode === "required")`. Everything else awaits the handle. The pre-flight conflict check runs before the handler executes — `(ref, unsupported)` and `(inline, required)` reject immediately with `ToolTaskModeConflictError` instead of dispatching nonsense handler shapes.

3. **`SessionHarness.dispatch` threads the option** through to the executor via `task: options.task` on the dispatch input; `defineSession`'s `SessionSpec.dispatch` signature widened to `(name, input, options?)` so adopter-provided session specs can forward the option. The model-tick path in `LoopExecutorHarness` is unchanged — it passes `via: "model"` and gets the `(required, auto, model) → Pattern B` matrix cell. Verified: the executor's existing `via: "model"` branching IS the model-tick path, so we don't need the loop-executor to look up declarations or pass `{ task: "ref" }` explicitly.

4. **Tests + adopter-visible reset.** New `packages-next/tool-executor/src/__tests__/dispatch-task-mode-matrix.spec.ts` covers the full 3×3 matrix (`supportMode` × `task`) plus the `via: "model"` cells for `"auto"` resolution — 12 tests, every cell asserted. `task-handle.spec.ts` (the #156 spec) flipped the two `taskSupport: "required"` host-dispatch tests to pass `{ task: "ref" }` so they still cover Pattern B serialization. `mcp/src/__tests__/task-bridge.spec.ts` — the first test ("auto-completes a task") now asserts Pattern A (host-side dispatch returns the remote payload directly); a new second test covers Pattern B opt-in via `{ task: "ref" }`. The `withMCP` integration didn't need any code change: the matrix lives entirely in the executor; the MCP tool's `annotations.taskSupport: "required"` (bridged from `execution.taskSupport`) still drives the model-tick path's `(required, auto, model) → ref` cell unchanged.

**Workspace:** 245/245 across session + mcp + app + tasks; 120/120 across tool-executor (12 new in the matrix spec). Typecheck + oxlint clean across spec / tool-executor / session / mcp.

**Adopter-visible diff:**

```ts
// before — host caller had to JSON.parse the ref + chase tasks.result
const ref = JSON.parse((await session.dispatch("deploy", input))[0].text);
const blocks = await session.tasks.result(ref.taskId);

// after — same code path, blocks come back directly
const blocks = await session.dispatch("deploy", input);

// still available — Pattern B is one option flag away
const refBlocks = await session.dispatch("deploy", input, { task: "ref" });
```

**Deferred:** Phase C (#174) refines the `(supported, auto)` cell with capability negotiation + per-call `task: { ttl }` opt-in. This pass treats `(supported, auto)` as Pattern A everywhere (host AND model) so `withMCP`'s framework→server-side bridging stays uniform; `#174` adds the per-call escape hatch.

**Previously, 2026-06-23 (later still + Phase B) — Phase B (#158) — MCP wire codec for tasks: outbound client honors server-broadcast `tool.execution.taskSupport === "required"` by routing through `ctx.tasks.submit(mcpTaskEffect(...))`.** Closes the Pattern B over-MCP loop. Six parts:

1. **Wire codec primitives** in `packages-next/mcp/src/wire/task-codec.ts`. Pure helpers built on the SDK's exported schemas: `buildCallToolAsTaskParams` (assembles `tools/call` params with `task: { ttl }`), `discriminateCallToolResponse` (distinguishes `CallToolResult` vs `CreateTaskResult` on the wire), `matchProgressNotificationForTask` (filters `notifications/progress` by `_meta["io.modelcontextprotocol/related-task"].taskId` via the SDK's `RELATED_TASK_META_KEY` constant). Pass-through re-exports of the SDK's task types so consumers don't reach into `@modelcontextprotocol/sdk` directly.

2. **`McpClientHarness` extensions** — five new methods all wired through the same `runOperation` substrate envelope as `callTool`: `callToolAsTask` (returns the discriminated `inline|task` outcome), `taskNotifications(taskId): Stream<{kind, notification}>` (per-taskId fan-out backed by `setNotificationHandler` + Maps keyed by taskId), `getTask`, `getTaskResult`, `cancelTask`. Notification handlers registered once at client construction; subscriber sets keyed by remote taskId; `Stream.async`'s `onCancel` tears down the subscription cleanly. Inbox routing for `tasks-cancel` server-to-client requests stays a future enhancement (we don't expose tasks-bearing tools as a server today).

3. **`mcpTaskEffect(client, input, workCtx)`** in `packages-next/mcp/src/integration/task-bridge.ts`. The Effect adopters pass to `ctx.tasks.submit(...)`. Encapsulates the full lifecycle: task-augmented `tools/call`, branch on inline/task response, fold inbound notifications into `workCtx.onProgress / setStatusMessage` via `Stream.runFoldWhile` (early-exit on terminal status), fetch payload via `tasks/result` on `completed`, surface a `McpRemoteTaskNonCompletedError` on `failed`/`cancelled` so the harness's failure path emits a symmetric local `TaskRejection`. `Effect.onInterrupt(sendCancel)` fires `tasks/cancel(remoteTaskId)` on local Fiber.interrupt (Phase D's settled-cancel awaits it; the wire cancel completes before `await session.tasks.cancel(localId)` returns).

4. **`withMCP` integration** — `discoverAndRegisterTools` detects `tool.execution.taskSupport === "required"` (the MCP-canonical location per SDK 1.29.0 `ToolSchema` — the legacy `annotations.taskSupport` was strict-stripped) and wraps the handler closure: `(input, { ctx }) => ctx.tasks!.submit((workCtx) => mcpTaskEffect(harness, {name, args: input, taskOptions}, workCtx))`. Unannotated tools keep current inline behavior. `mcpDeclaration` bridges MCP's `execution.taskSupport: "optional"|"required"|"forbidden"` to our framework-local `annotations.taskSupport: "supported"|"required"|"unsupported"` so the executor's Pattern A/B branching sees a uniform shape regardless of tool origin. New `McpServerConfig.defaultTaskTtl` field carries the per-server TTL into `task: { ttl }`.

5. **In-memory fake MCP server + end-to-end test** — `packages-next/mcp/src/__tests__/task-bridge.spec.ts` uses the SDK's `Server` class with `InMemoryMcpTransport.createLinkedPair()`. Fake advertises `tasks.requests.tools.call: {}` capability (SDK 1.29.0 shape; `taskCreation` field landed in the unreleased main-branch refactor). Three scenarios verified end-to-end through the AppHarness + withMCP stack: auto-complete happy path (dispatch returns `session_task_ref`; `session.tasks.result(localTaskId)` resolves to the server's `tasks/result` payload); cancellation (local `session.tasks.cancel(localId)` propagates as wire `tasks/cancel` and the server observes it via a Promise hook); progress notifications (server emits `notifications/progress` tagged with `RELATED_TASK_META_KEY` and the local TaskHandle's events stream surfaces the progress in order).

6. **Out of scope (deferred):**
   - **Phase C — capability negotiation.** MCP's `execution.taskSupport === "optional"` (= our `"supported"`) requires a per-call `task: {ttl}` opt-in from the caller, which the executor doesn't have a branch for today. Phase C adds the "supported" path: server-broadcast tools advertise availability, caller chooses to task-augment per-dispatch.
   - **Server-side tasks** (us exposing framework tasks via the MCP wire). mcp-next is client-only; the inbound-server path needs a separate `McpServerHarness` package.
   - **`tasks/list`** wire integration. The local `session_tasks_list` tool only surfaces local tasks; a future enhancement could merge remote `tasks/list` results.
   - **Progress notification `progressToken`** — we currently match on `_meta.related-task` only; future codec work could also recognize the `progressToken` from the original `tools/call` `_meta.progressToken` for servers that don't tag related-task.

**Workspace:** 301/301 tests pass across mcp-next + tool-executor + tasks + app (3 new e2e tests in task-bridge.spec.ts). Strict typecheck clean across spec / runtime / tasks / tool-executor / app / mcp. Adopters: server includes `execution: { taskSupport: "required" }` on its tool listing → our framework routes through Pattern B end-to-end with zero adopter configuration.

**Previously, 2026-06-23 (later still) — #155 (Phase D minimal) — `TasksHarness.submit` accepts `Effect<T, E, never>` work; cancel calls `Fiber.interrupt` for real interruptibility.** Closes the Effect-typed work seam called out as a TODO in `harness.ts` and on the #155 backlog item. Five parts:

1. **`TasksHarnessProtocol.submit` overloaded with an Effect work signature.** Spec adds `submit<T, E>(work: (ctx) => Effect.Effect<T, E, never>, opts?)` alongside the existing Promise/sync form. Both surface the same `TaskHandle<T>` — adopters branch purely on work-fn ergonomics, not on a separate API. `TaskWorkContext` (`signal`, `onProgress`, `setStatusMessage`) is unchanged; Effect work calls the imperative callbacks via `Effect.sync(() => ctx.onProgress(...))`.

2. **Runtime branch on `Effect.isEffect(work(ctx))` in `TasksHarness.submit`.** Promise path is unchanged (still `workPromise.then().catch()` + `AbortController.abort()`). Effect path runs `Effect.runFork(effect)`, stores the resulting `Fiber.RuntimeFiber` on the `TaskRecord`, and chains `Fiber.await(fiber).then(handleExit)` to surface Exit→FSM transitions. `Exit.Success` → `completed`; `Cause.failureOption(...)` Some → `failed` with `errorReason(failure)`; `Cause.isInterruptedOnly(cause)` → internally-cancelled path (treated as `cancelled` with `reason: "interrupted"`); otherwise defect → `failed` with first defect's reason.

3. **`Fiber.interrupt` wired into `cancelInternal`.** When a record carries a fiber, `cancel()` calls `Effect.runPromise(Fiber.interrupt(record.fiber)).catch(() => undefined)` fire-and-forget after the cancel transition is already committed. The fiber's Exit.Interrupt is observed by the `runEffectWork` continuation and silently dropped (status already `"cancelled"`). The AbortController is ALSO aborted on the Effect path as defence in depth — any Promise-flavor side-effects embedded inside the Effect still see the abort.

4. **Cause→reason mapping (`causeToReason`).** Effect's `Cause` structure preserves failure shape that a `.catch()` rejection would flatten. The helper walks `Cause.failureOption` first (typed `Effect.fail`), then `Cause.defects` (`Effect.die`), then `Cause.pretty` as a last resort — feeds the existing `errorReason()` consistently. Same `TaskFailure.kind: "error"` is emitted for both typed failures and defects; the reason string distinguishes them.

5. **Tests landed.** Conformance suite gains 4 cross-impl Effect tests (`succeed`, `fail`, `die`, `cancel-interrupts-Effect.sleep`). `harness.spec.ts` gains 6 reference-impl Effect tests including a **zombie-compute test**: an `Effect.gen` `while(true)` loop incrementing a Ref; after `cancel()`, the counter must freeze (verified by reading it twice across a 50ms gap). That test would loop forever without `Fiber.interrupt` — it's the load-bearing assertion for "real interruptibility" vs "AbortSignal flag flipped, microtasks still running."

**What's deliberately NOT in this slice (deferred TODO, separate refactor):** the per-subscriber `Set<Queue<TaskEvent>>` fan-out → `Stream.fromQueue` rewrite. The current Queue pattern is correct; the rewrite is cleanup, not capability. Tracked as a `#155-followup` TODO in `harness.ts`.

**Workspace:** `packages-next/tasks` 61 tests pass (54 prior + 7 new). `tool-executor` + `session` + `app` sweep clean (225 tests). Strict typecheck across spec / runtime / tasks / tool-executor / session / app / mcp all clean.

**Previously, 2026-06-23 (later) — #157 model-facing `session_tasks_*` tools — `withTasks()` auto-registers list / get / cancel / await so Pattern B is usable end-to-end.** Closes the Pattern B loop opened by #156. Without these the model receives a task-ref content block but has no way to act on it; with them the agent can dispatch concurrent long-running work, continue talking, and reconcile results across ticks. Six parts:

1. **`TasksHarnessProtocol.list()` added to the spec.** Returns `readonly TaskInfo[]` — a snapshot of every task known to this harness. Per-session scope (one harness per session via `withTasks()`). Implemented in `TasksHarness` (iterates the internal `tasks` map, calls existing `snapshot()` helper); implemented in `stubTasks` (returns `Array.from(known.values())`); conformance suite extended with one test covering the lifecycle (empty → 2 working → 2 completed).

2. **Four model-facing tools in `packages-next/tasks/src/tools.ts`:**
   - `session_tasks_list` — `{ tasks: TaskInfo[] }`
   - `session_tasks_get` — `{ task: TaskInfo }` or `{ error: "unknown_task", taskId }`
   - `session_tasks_cancel` — `{ cancelled: taskId }` or `{ error: "unknown_task", taskId }`
   - `session_tasks_await` — content blocks on `completed`; `{ error: "task_failed", status, failure }` on `failed`/`cancelled`; `{ error: "unknown_task", taskId }` for unknown id

   All four are thin handlers over `ctx.tasks` (no closure capture — handler routes through the live harness instance). `session_tasks_await` does **NOT** propagate its own dispatch abort to the underlying task — observation only. Model has to call `session_tasks_cancel` explicitly to actually stop the work.

3. **Naming decision: `session_*` prefix, underscores throughout.** Discussion in conversation log:
   - `tasks.*` alone collides with the huge namespace of user-defined "tasks" tools (todos, kanban, project trackers). Real ambiguity for the model.
   - `agentick.*` / `framework.*` leaks brand or implementation detail — the model doesn't know it's in a framework.
   - `background_tasks.*` / `async_operations.*` work but `session_*` is more accurate (these things ARE per-session) and opens a reserved namespace for future framework-native model-visible primitives: `session_knobs_*`, `session_timeline_*`, etc.
   - Underscores not dots: OpenAI's function-calling validator historically rejected dots; underscores work universally across OpenAI/Anthropic/Google/MCP.
   - The `_kind: "task-ref"` discriminator on the Pattern B content block was renamed to `_kind: "session_task_ref"` for consistency with the tool namespace.

4. **`withTasks()` auto-registers the bundle at session-install.** New `WithTasksOptions.registerModelTools` field (defaults to `true`); set `false` to skip the model surface for headless adopters driving tasks from server code with no LLM in the loop. The substrate (`ctx.tasks`, `bridges.tasks`) is wired regardless. Registration walks `installer.registerToolHandler(handlerRef, handler)` for each of the four handlers, then `installer.registerExtensionTool(registration)` for each declaration — same shape `withMCP` uses for its per-server tools. Bindings: `{ scope: "extension", extensionName: "@agentick/tasks-next", level: "session" }`. Handler refs include `installer.sessionId` so cross-session registrations on the shared `HandlerResolver` don't collide.

5. **Tool descriptions actively disclaim user-tool semantics.** Each tool's description starts with: _"Manage framework-spawned background tasks for the current session. These tools operate ONLY on tasks the framework created via long-running tool calls (signalled by a `session_task_ref` content block in the prior tool result). They are NOT for managing user-facing tasks like todos, project tickets, or kanban items..."_. The description carries real weight at inference time — that's where the disambiguation lives for a fine-tuned model that's pattern-matched on millions of productivity tools.

6. **Test coverage added: `packages-next/tasks/src/__tests__/session-tasks-tools.spec.ts` — 16 tests.** Each tool dispatched end-to-end through a real `ToolExecutorHarness` (constructed on the same in-memory substrate as the `TasksHarness`); known + unknown id paths for get / cancel / await; failure-shape coverage for `session_tasks_await` against a cancelled task; bundle structural assertions (4 registrations + 4 handler refs + per-sessionId namespacing + `level: "session"` binding); extension wiring smoke tests (`withTasks()` default vs `registerModelTools: false`). `@agentick/tool-executor-next` added as a `devDependency` per the CLAUDE.md guidance: "tests live where their dependencies live".

**Workspace:** 433/433 tests pass across the five affected packages (`tasks-next` 51 + `tool-executor-next` + `spec-next` + `session-next` + `app-next`). Lint + strict typecheck clean. README + STATUS updated.

**What's still missing for the full Pattern B story:**

- **#155** — `Effect<T>` work overload + `Fiber.interrupt` on cancel (LANDED in the latest entry). `Stream<TaskEvent>` from per-subscriber `Queue<TaskEvent>` fan-out remains a deferred cleanup (TODO `#155-followup` in `harness.ts`).
- **Phase B (MCP wire codec)** — `mcp-next` translates inbound MCP `tools/call` with `task: { ttl }` into `submit`; outbound MCP wire serializes our TasksHarness state into `notifications/tasks/status` + `notifications/progress`. Tracked separately.
- **`taskSupport: "supported"`** — caller-choice mode is in the spec annotation but executor doesn't branch on it yet. Land alongside MCP wire codec.
- **Otto example update** — the otto example doesn't yet exercise the Pattern B path (no tool declares `taskSupport: "required"`). Worth a one-tool addition to demonstrate the model managing background work.

**Previously, 2026-06-23 — #156 ToolExecutor task integration + `ctx.tasks` / `ctx.elicitation` on every handler — Pattern A vs Pattern B branching on `taskSupport` annotation.** Closes the wiring loop opened by #120 (TasksHarness substrate primitive) and #119 (ElicitationHarness substrate primitive). Both harnesses now reach the handler via `ctx` instead of the JSX `use:` ceremony — the "substrate primitive on `ctx`" rule from the spec doc. Five parts:

1. **`ToolHandlerCtx` extended with `elicitation` + `tasks` slots.** Both typed against their protocol interfaces in `@agentick/spec-next/protocol/*`; both `?:` optional so substrate-stripped test fixtures can omit them without compile errors, but every real session installs both (the required-set contract). Handlers call `ctx.tasks!.submit(...)` / `ctx.elicitation!.elicit(...)` without ceremony. Substrate-primitive slots vs `use:` slots — the rule: framework-provided harnesses every session has (elicitation, tasks, and future sampling/roots) live on `ctx`; extension-provided / provider-scoped things (sandbox bridge, custom MCP refs) flow through `use:` capture.

2. **`ToolHandlerResult` union extended with TaskHandle return shapes.** `TaskHandle<readonly ContentBlock[]>` + `Promise<TaskHandle<...>>` + `Effect<TaskHandle<...>>`. Async handler bodies wrap returns in Promise, so the executor needs the post-await detection path — handled by `dispatchOnResolved(resolved)` in the executor body (see §3).

3. **Pattern A / Pattern B branching on `taskSupport` annotation.** The executor's handler-result processing was restructured into a `dispatchOnResolved` post-processor invoked after Promise/Effect awaits. If the resolved value is a `TaskHandle` (detected via duck-type guard against `taskId` + `result` + `events` + `cancel`):
   - `taskSupport: "required"` → **Pattern B**. Executor serializes a typed task-ref content block (`{ _kind: "task-ref", taskId, status, statusMessage?, ttl? }`) and returns it to the model. The task continues running; the model owns it across subsequent ticks. Abort wires to `handle.cancel(reason)`.
   - `taskSupport: "unsupported"` (default) or undefined → **Pattern A**. Executor awaits `handle.result` transparently via `Effect.raceFirst(taskAwaitEff, abortEff)`. Model sees the eventual content blocks; never sees the taskId. Abort wires to `handle.cancel(reason)` AND short-circuits the await.
   - `taskSupport: "supported"` → deferred to #157 (caller-choice mode lands alongside the model-facing `tasks.*` tools).

4. **Per-session `TasksHarness` constructed alongside the elicitation harness in `AppHarness`.** Threaded through `SessionHarnessOptions → buildSessionBridges → SessionHookBridges` so `session.tasks` accesses the same instance as `ctx.tasks` and `bridges.tasks`. `CallbackSessionHarness` was extended with the same `readonly tasks` slot for parity. `createTestHarness` (tool-executor's `/testing` subpath) now constructs a real `TasksHarness` on the same in-memory substrate as its elicitation harness and exposes both in the bundle — adopter integration tests get the live status + progress envelopes on the bus for free.

5. **Tasks `README.md` rewritten for the current shape.** Pattern A / Pattern B explained with examples; `withTasks()` install path documented as the standard entrypoint; the `fakeTasks()` / `stubTasks()` doubles documented under their canonical `/testing` subpath with full option surfaces and adopter recipes; "Verified by" updated to point at the actual test files + counts (18 harness + 4 cluster-inbox + 12 conformance + 6 tool-executor task-handle = 40 tests across two packages); roadmap aligned with the live backlog (#157 / #155 / Phase B MCP wire codec). `FakeTasksOptions` added to the `/testing` barrel export.

**Test coverage added in this pass:** `packages-next/tool-executor/src/__tests__/task-handle.spec.ts` — 6 tests covering `ctx.tasks` + `ctx.elicitation` wiring, Pattern A (await transparently), Pattern B (serialize task-ref + task continues post-return), and Pattern A abort-propagation (`AbortController.abort()` on the dispatch routes through to `handle.cancel` and transitions the task to `cancelled`).

**Deferred:**

- **#157** — auto-register `tasks.list / tasks.get / tasks.cancel / tasks.await` model-facing tools when `withTasks()` is installed. Required for Pattern B to be usable — currently the model receives the task-ref content block but has no way to act on it.
- **#155** — `Effect<T>` work overload + `Fiber.interrupt` on cancel (LANDED in the latest entry). `Stream<TaskEvent>` from per-subscriber `Queue<TaskEvent>` fan-out remains a deferred cleanup (TODO `#155-followup` in `harness.ts`).
- **#158** — agent-self-coding via MCP server bridge (design only; no implementation).

**Workspace:** all v2 tests pass (1703/1703 in the full sweep + 6 new task-handle tests). Strict typecheck clean. The full README + status doc sweep adds the test-double accuracy guarantee for `fakeTasks`/`stubTasks` per the [[feedback_test_doubles_meszaros]] convention.

**Previously, 2026-06-13 — Executor harness round 2 — Effect.Stream pipeline + declarative hook surface + 4 providers refactored + lifecycle helper extraction + `defineLanguageModelExecutor`.** Second deep pass on the executor layer following round 1 (`BaseLanguageModelExecutor` introduction). This pass swapped the hand-rolled streaming loop for native Effect primitives, factored the v1 `createAdapter` borrowings into per-provider hooks, and consolidated lifecycle bookkeeping into a single shared helper. Four parts:

1. **Effect.Stream-ified streaming pipeline.** `BaseLanguageModelExecutor.executeBody` now uses `Stream.fromAsyncIterable(providerStream)` + `Stream.mapConcat(mapChunk)` + `Stream.mapConcat(pipeline.process)` + `Stream.tap(accum.apply)` + `Stream.tap(bus emit)` + `Stream.tap(Queue.offer)`. `executeStream` forks the pipeline as a daemon fiber with `Queue.bounded(64)` between producer and iterator — real backpressure: when the consumer lags, `Queue.offer` blocks the upstream Stream, which pauses `Stream.fromAsyncIterable`'s pull from the provider SDK. Cancellation flows via `Fiber.interrupt(fiber)` + `Effect.tryPromise({ try: (signal) => … })`'s fiber-aware AbortSignal; the external `abort()` API + caller signal merge in via `withExternalAbort` (`Effect.race` against a watcher). 5 new tests in `base-effect-stream.spec.ts` verify: pipeline routing order, bounded backpressure (exact delta count N+6 for 200 chunks), `abort()` interruption, iterator `return()` interruption, bus emission.

2. **Hook surface aligned with v1 `createAdapter`** (the user's "borrow from v1" item, fully landed). Abstract hooks: `buildParams` / `callProvider` / `openStream` / `mapChunk(chunk, accum) → readonly AdapterDelta[]` / `reconstructRaw(accum, modelSeen) → TRaw` / `normalizeRaw`. Optional hooks: `adapterTransforms(): readonly DeltaTransform[]` / `customBlocks: Record<string, CustomBlockDefinition>` (declarative XML-tag extraction) / `postProcessForNormalize` / `finalizeStream` / `mapProviderError` / `isAbortError`. The base owns the loop + transform pipeline + accumulator + bus + iterator + fiber lifecycle; providers write ~5 pure functions.

3. **All four shipped providers refactored** onto the new hooks. Each provider's drainStream (~200-300 LOC) + local accumulator class (~100 LOC) + buildTagRouter (~50 LOC) + applyTagRouterToX (~30 LOC) collapses to `openStream` + `mapChunk` + `reconstructRaw` + an `adapterTransforms()` returning `[thinkTagTransform()]` (when applicable) + a declarative `customBlocks` field. Cumulative: `executor-openai 1713 → 861` (-50%), `executor-anthropic 1684 → 1105` (-34%), `executor-google 1658 → 966` (-42%), `executor-ai-sdk 1027 → 601` (-41%). **Total provider LOC: 6082 → 3533 (-2549, -42%).** All 211 provider conformance + per-provider behavior tests pass.

4. **Adopter ladder + lifecycle helper.** Added `defineLanguageModelExecutor` — callback wrapper around `BaseLanguageModelExecutor` for adopters with streaming providers who don't want subclassing. Three rungs now: `extends BaseLanguageModelExecutor` (class, full power) → `defineLanguageModelExecutor({ openStream, mapChunk, reconstructRaw, … })` (callback, same hooks) → `defineExecutor({ run })` (single-callback, simplest). Extracted `ExecutorLifecycle` (`packages-next/executor/src/executor-lifecycle.ts`) — the `inFlight: Map`, `aborted: Set`, `abort()` impl, and pre-execute aborted check that was duplicated across `BaseLanguageModelExecutor`, `FakeLanguageModelExecutor`, and `CallbackLanguageModelExecutor`. All three now hold a `lifecycle` instance and delegate. Executor README in `packages-next/executor/README.md` documents the full custom-executor authoring story.

**Workspace:** 214/214 executor-layer tests passing (15-test conformance suite × 5 executors + 5 base-pipeline tests + 22 tag-parser tests + define-executor tests + define-language-model-executor tests + fake-language-model-executor tests + per-provider tests). Strict typecheck clean across executor packages. v2 modularity model preserved — no executor-anthropic/google/ai-sdk depends on executor-openai (the shared `StreamTagParser` lives in `@agentick/model-executor-next`).

**v1 / other-library borrowings explicitly landed:**

- v1 `createAdapter.mapChunk` → `BaseLanguageModelExecutor.mapChunk` (abstract)
- v1 `createAdapter.reconstructRaw` → `BaseLanguageModelExecutor.reconstructRaw` (abstract)
- v1 `DeltaTransform` pipeline + declarative `customBlocks` → `delta-transform.ts` + `tag-transforms.ts` + base's `adapterTransforms()` + `customBlocks` field
- v1 `prepareInput` → `buildParams` hook
- v1 `extractMetadata` → partial: per-tool `providerMetadata` (Google's `thoughtSignature` use case); broader extractMetadata callback not yet exposed
- AI SDK `fullStream` event vocabulary → already aligned in `AdapterDelta` union
- **Net new vs v1:** Effect.Stream backpressure (`Queue.bounded` + fiber-interrupt cancellation) — v1 had no equivalent.

**Follow-up audit deferred to its own pass:** the user flagged that other layers (`runtime-next`, `tool-executor-next`, `loop-executor-next`) likely have similar hand-rolled streaming/looping code that should be reviewed for Effect-primitive opportunities (Stream, Queue, Fiber). Not in scope for this pass; STATUS entry here to anchor the follow-up.

**2026-06-13 (later that day) — Effect audit landed across runtime + tool-executor; extractMetadata + defineLanguageModelExecutor conformance also landed.** Four follow-ups closed in one pass:

1. **`runtime-next/substrate/request-response-registry.ts`** — replaced the manual `setTimeout` + `clearTimeout` + `signal.addEventListener` + cleanups-array juggling with `Effect.raceFirst(deferred.await, timeoutEffect, signalEffect) + Effect.ensuring`. `Effect.raceFirst` (not `Effect.race`/`raceAll`) settles on first to either succeed OR fail — required for fail-fast timeout/abort semantics. `Effect.delay` and `Effect.async`'s cleanup-return-effect handle timer + listener cleanup automatically on race-loser interrupt. Net: ~40 LOC removed, eliminates the race conditions between timeout/signal fire ordering, no leaked listeners. 8/8 registry tests pass.

2. **`tool-executor-next/src/harness.ts`** — same fix in two places. The Effect-handler branch was using `Effect.race(handlerResult, abortEff)` which only settles on first SUCCESS — a slow-but-eventually-succeeding handler would beat an already-fired abort. Switched to `Effect.raceFirst`. The Promise-handler branch was using `Promise.race([handler, abortPromise])` with a hand-rolled `abortPromise` helper — replaced with `Effect.tryPromise(...).pipe(Effect.raceFirst(abortEff))`; deleted `abortPromise` (~10 LOC). Both handler shapes now share the same abort watcher. 71/71 tool-executor tests pass.

3. **`loop-executor-next`** — audit found NO Effect opportunities. Loop is intentionally sequential (tool dispatch waits for state-applicator ordering); the audit recommended "skip for now". Documented as a future optimization under "Roadmap & known gaps" rather than refactored.

4. **`defineLanguageModelExecutor` conformance** — wired the full 15-test `runExecutorConformance` suite against the callback wrapper. All 15 pass — confirms the callback path is equivalent to subclassing. Translates `scripted: LanguageModelExecutionResult` to a synthetic chunk stream that openStream yields, mapChunk translates to AdapterDeltas, reconstructRaw returns the scripted result.

5. **v1 `extractMetadata` borrow — fully landed.** Added optional `extractMetadata(raw)` hook to `BaseLanguageModelExecutor` + the `defineLanguageModelExecutor` callback bundle. Base merges the returned record into `result.finishMetadata` (last-write-wins per key) after `normalizeRaw`. Adopters can surface OpenAI `system_fingerprint`, Google `safetyRatings`, citation slots, etc. without rewriting `normalizeRaw`. Closes v1 createAdapter parity. New test in `define-language-model-executor.spec.ts` verifies the merge semantics + existing `finishMetadata` keys are preserved.

**Workspace:** 1260/1260 v2 tests pass. (Full workspace sweep also flagged 5 failures in `packages/gateway/__tests__/unix-socket-transport.spec.ts` — v1 gateway, EADDRINUSE port 18789, transient port-conflict flake unrelated to v2 changes.)

**2026-06-13 (continued) — Effect-primitives audit extended to session / app / gateway / transport; 2 real bugs fixed + helper deduplication.** Same audit pattern applied to the remaining harness layers. Three concrete changes:

1. **`transport-next/src/client/base-transport.ts` — AbortSignal listener leak.** The abort listener attached on every `request()` was never removed after the response arrived. Long-lived signals (the common case — one `AbortController` shared across many requests) accumulated listeners with each call: real memory leak under sustained load. Hoisted the listener out of the Promise constructor so a wrapper `settle()` can detach it on both success AND error before forwarding the value/error to `resolve`/`reject`. The `pending.has(id)` / `pending.delete(id)` ownership-check was already correct (single-threaded JS, no race); the listener-leak was the actual bug.

2. **`app-next/src/harness.ts` — `subscribeBus` microtask leak.** The previous implementation used an `aborted` boolean flag + manual `iter.next()` polling + `iter.return()` on unsubscribe. Between an in-flight `await listener(env)` and the outer `aborted = true` flip, `iter.next()` could already be pending and yield one more value AFTER the unsubscribe call returned. Replaced with `Effect.runFork(Stream.runForEach(bus.subscribe(filter), ...))` + `Fiber.interrupt` on unsubscribe — atomic, no microtask gap. Errors swallowed via `Effect.catchAll(Effect.void)` so one extension can't kill the bus subscription.

3. **`busAsyncIterator` helper deduplicated.** The `makeBusAsyncIterator` (`Stream` → `AsyncIterator<ProtocolEvent>` bridge with fiber-interrupt-based `return()`) was duplicated nearly identically between `AppHarness.events()` (60 LOC) and `GatewayHarness.events()` (60 LOC, with a worse `require()`-based effect import). Extracted to `@agentick/runtime-next/substrate/bus-async-iterator.ts`. Single source of truth; both harnesses delegate.

Skipped (audit said low-urgency or correct as-is): session's single-execution mutex (Promise-null-check is correct in single-threaded JS), MultiplexedStream (correct hand-rolled implementation), BaseConnectionContext (no concurrency hazards), runtime-next event bus / memory-journal wake-resolver patterns (Effect.async + resolver is idiomatic Effect — Deferred would be marginally cleaner but no resilience win).

**Workspace:** 1260/1260 v2 tests still pass after all three changes (and the prior request-response-registry refactor). v1 gateway flake (EADDRINUSE port 18789) attempted but not fixable from this branch (`gateway.start()` hangs for unrelated reasons when port is changed); v1 test left as-is.

**Previously, 2026-06-13 — Strict typecheck on test files + pre-commit hook coverage rolled out across all 30 v2 packages.** Every `pnpm typecheck` script now runs `tsc -p tsconfig.json --noEmit` (which includes `src/**/__tests__/`) instead of `tsconfig.build.json` (which excluded tests). The `lint` + `format:check` + `clean` scripts are now declared in every v2 package's `package.json` so turbo's pre-commit hook runs them symmetrically (was running on 7/30 before).

The strict-typecheck pass surfaced and fixed **~120 stale-fixture drift errors across 18 v2 packages**. Each error was a test asserting against a spec shape that had since narrowed/renamed/dropped a field — passing in vitest because esbuild strips types, failing under strict `tsc`. Highlights:

- **Spec widening** (real bugs in the spec, not tests): `ExecutorFactory.(deps?: ExecutorFactoryDeps)` is now optional (every shipped impl already accepted no-args; spec was the outlier); `ExecutorProtocol.ready: Promise<void>` added to match every concrete impl and every other harness; `spec-conformance/{loop-executor,session-harness}` stubs picked up the new `ready` field automatically.

- **Canonical extractText**: lifted three duplicate `textOf(content: readonly { text?: string }[])` helpers (knobs, state, reconciler-react, timeline) into `@agentick/spec-next` as `extractText(blocks)`, sibling to `isTextBlock`. Caught the structural-shim drift: `{ text?: string }` accepted ContentBlock by accident; canonical helper narrows via `isTextBlock`. Spec's `guards/index.ts` is now exported from the package root.

- **JSX.IntrinsicElements augmentation drafted, not wired**: v2 doesn't yet declare host intrinsics (`<message>`, `<tool>`, `<section>`, `<text>`, ...) in `JSX.IntrinsicElements`. Test code writing JSX against them fails with `TS2339: Property 'message' does not exist`. Drafted `packages-next/reconciler-react/src/react/jsx-intrinsics.d.ts` (mirror of v1's `packages/core/src/jsx/react-jsx.d.ts`, retyped against `@agentick/spec-next`) — **not wired in yet**. Adopter-facing requirement; lands as its own dedicated piece of work. Until then, tests use `React.createElement("message" as unknown as React.ComponentType<Record<string, unknown>>, ...)` with documented TODOs.

- **Per-layer canonical fakes (extending the previous Meszaros-taxonomy work)**: every layer's drift-fix pass became an opportunity to lift local stubs to a `/testing` subpath. Done so far: `@agentick/reconciler-next/testing/fakeReconciler`. Follow-up renames pending: `MockLanguageModelExecutor → FakeLanguageModelExecutor`, `mockTimelineHarness → fakeTimelineHarness`, `stubBridges → fakeBridges`.

- **Module-augmentation invisibility**: `ProviderOptions` (augmented by executor-openai etc.) and `HookBridges` (augmented by knobs-next, timeline-next, ...) slots are invisible to tests that don't import those packages. Indexed through `Record<string, unknown>` with explanatory comments at affected call sites. Real fix is the side-effect-import pattern, but that's wider than this sweep.

**Workspace:** 1236/1236 v2 tests passing. Strict typecheck clean across all packages-next. Lint + format:check clean across the v2 tree. Pre-commit hook now covers all 30 v2 packages symmetrically.

**Previously, 2026-06-12 — Test-double convention established + `@agentick/reconciler-next/testing` shipped with `fakeReconciler()`.** Per the Meszaros _xUnit Test Patterns_ taxonomy: `fake*` for minimal working impls (default), `stub*` for canned answers, `spy*` for call recorders, `mock*` for expectations. Never `test*` — it collapses the taxonomy and loses information. Every layer ships its test doubles under a `/testing` subpath (CLAUDE.md's harness pattern applied across all layers). Doubles are typed against spec interfaces — when the spec changes, the doubles break at compile time. Adding `fakeReconciler` immediately caught two stale-spec drift bugs in the existing `define-reconciler.spec.ts` fake helper (`{warnings,errors}` diagnostics shape that's now `readonly ReconcileDiagnostic[]`, missing `iterations` field, dead `version` field, missing `MountResult.restoredFromSnapshot`) — exactly what the convention is designed to prevent. Fixed in this pass.

**Follow-up (consistency cleanup):** existing test doubles using `Mock` / `mock` / `stub` prefixes are misnamed under the new convention since they're all working-impl shapes (Fakes per Meszaros). Rename in a separate pass: `MockLanguageModelExecutor → FakeLanguageModelExecutor`, `mockTimelineHarness → fakeTimelineHarness`, `stubBridges → fakeBridges`. Also move helpers like `stubBridges` from `bridges/` into `testing/` for consistency.

**Previously, 2026-06-12 — Phase 33.C hardening pass — `MultiplexedStream` backpressure + jitter property tests + full client→gateway→executor `session/send` e2e.** Three items flagged in earlier STATUS entries closed:

- **`MultiplexedStream<T>` backpressure** — four explicit policies: `"unbounded"` (default; prior behavior), `"drop-oldest"`, `"drop-newest"`, `"close-on-overflow"`. Bounded policies require a finite positive `capacity`; constructor rejects misconfiguration. `onDrop` / `onOverflow` callbacks let adopters observe loss. AsyncIterator now drains buffered values before surfacing the terminal error so close-on-overflow consumers see what was buffered at the moment of overflow. 9 tests in `transport-next/src/__tests__/multiplexed-stream-backpressure.spec.ts`.
- **Backoff jitter property tests** — extracted `computeFullJitterBackoff(attempt, policy, random?)` as a pure free function (the `BaseClientTransport.computeBackoff` is now a one-liner over it). 6 tests verify: output in `[0, cap)` for every attempt, cap doubles per attempt until `maxDelayMs`, uniform distribution across `[0, cap)` (10k-sample chi-squared sanity ±15%, bottom-decile within 7-13% to rule out equal-jitter / no-jitter regressions), and deterministic reproducibility via injected RNG.
- **`session/send` end-to-end** — real `createClient → inProcessTransport → dispatchRequest → GatewayHarness → AppHarness → SessionHarness → MockLanguageModelExecutor` roundtrip in 2 tests. Verifies the wire shape + dispatch + executor wiring all hold together (previous tests stubbed the gateway handler with a switch). Established the pattern adopters use for full-stack tests: `dispatchRequest(gateway, req, sink)` wrapped as an `InProcessGatewayHandler`.

**Workspace:** 1236/1236 tests across `packages-next/*` (+17 from this pass). Typecheck clean.

**Previously, 2026-06-12 — Phase 33.F.1 — consolidated the four client-middleware packages into a single `@agentick/client-extensions-next` bundle with subpath exports.** Reason: `@agentick/client-{retry,telemetry,cache,offline}-next` was colliding with the planned `@agentick/client-{react,angular,vue}-next` framework-binding namespace — `client-X` was carrying two semantically different jobs (middleware behavior vs framework binding). The bundled package keeps each behavior in its own subdir with its own README + test suite + JSDoc, but ships under a single layer-disambiguated name. Adopters install one package and opt in per behavior via subpath imports:

```ts
import { retry } from "@agentick/client-extensions-next/retry";
import { telemetry, noopAdapter } from "@agentick/client-extensions-next/telemetry";
import { cache } from "@agentick/client-extensions-next/cache";
import { offline } from "@agentick/client-extensions-next/offline";
```

This establishes the v2 naming convention for first-party extensions: **`{layer}-extensions-next`** for bundled middleware (`client-extensions-next`, future `gateway-extensions-next`, `harness-extensions-next`); **`{layer}-{framework}-next`** for framework bindings (`client-react-next`, `client-angular-next`, ...). Third-party extensions name themselves freely.

**Second bonus bug caught and fixed:** `BaseClientTransport.request()`'s cancellation path had a microtask gap — when the abort listener synchronously rejected the inner `promise` before the outer async function reached `return promise`, Node observed the rejection as unhandled before vitest could chain its `.then`. Fixed by attaching a passive `.catch(() => {})` immediately on the inner promise; the outer return path still propagates the rejection unchanged. Confirmed via isolated cancellation test — no more `PromiseRejectionHandledWarning` or "Unhandled Errors" line. (Same family as the earlier orphan-pending-on-sendFrame-throw fix — both about `BaseClientTransport` letting inner promises become temporarily handler-less.)

**Phase 33.F original (now subsumed) — four common middleware behaviors shipped.** Each behavior designed against established prior art (cited in its README) and configurable along the axes that matter most for adoption:

- **`/retry`** — exponential backoff with full jitter (AWS Builder's Library), configurable retryable predicate (transport drops + RateLimited/Backpressure/InternalError by default), idempotency-key propagation via `params._meta.idempotencyKey` (RFC 7231 §4.2.2 / Stripe / GCP convention) on non-idempotent methods (`session/send`, `session/dispatch`, `app/run_once`), per-method override, deadline-budget. 16 tests.
- **`/telemetry`** — OpenTelemetry-shaped: span per logical RPC with RPC semconv attributes (`rpc.system`, `rpc.service`, `rpc.method`, `rpc.jsonrpc.error_code`, `rpc.duration_ms`), W3C Trace Context propagation via `_meta.traceparent` / `_meta.tracestate`, BYO `TelemetryAdapter` (we don't bundle `@opentelemetry/api`), per-method sampler, `noopAdapter` for context-only adopters. 9 tests.
- **`/cache`** — method-explicit-allowlist read-through cache (default empty — agentick is stateful), per-method TTL, in-memory LRU `CacheStore` default, pluggable for Redis-backed durable caches, `_meta` stripped before keying so trace/idempotency variations don't fragment. Same family as React Query / TanStack / SWR / Apollo Client. 7 tests.
- **`/offline`** — outbound queue extension. Per-method `queue` / `fail-fast` / `never` policy (default fail-fast), FIFO replay on `state === "open"`, pluggable `OfflineStore` (in-memory default; adopters wire IndexedDB / SQLite / Redis), `client.offline.{pending,size,flush,clear}()` namespace via `ClientNamespaces` declaration merging. Same family as Workbox BackgroundSync / Apollo Link Queue / Redux Offline. 7 tests.

**Bonus bug caught and fixed during the retry tests:** `BaseClientTransport.request()` left an orphaned pending entry when `sendFrame` threw — when retry middleware moved on after a send failure, the original Promise stayed in the pending Map; subsequent `close()` rejected it with `{ kind: "closed" }` and Node logged the unhandled rejection (9 of them across the retry suite). Fixed by wrapping `sendFrame` in try/catch and cleaning the pending entry on throw. The retry middleware's behavior (correctly) didn't change; the noise vanished.

**Known follow-up — cache utility extraction.** The `LruCacheStore` in `client-extensions-next/cache` has a near-identical sibling in `runtime-next/substrate/local-inbox.ts`'s `IdempotencyEntry` cache (LRU+TTL via Map insertion order). Different semantics (RPC response cache vs handler-fiber dedup), same data structure. Two callsites isn't enough to justify extraction — wait for a third (adapter response cache, formatter compile cache, MCP capability cache, ...) before pulling out `@agentick/cache-next` (`LruTtlCache<V>` as a utility, **not** a harness).

**Workspace:** 1219/1219 tests across `packages-next/*`. Typecheck clean across all 95 packages.

**Previously, 2026-06-12 — Phase 33.C.2 — second consolidation pass into `@agentick/transport-next`.** Pulled the reconnect machinery (exponential backoff with full jitter, `scheduleReconnect`, `computeBackoff`, `handleConnectionDrop`, `cancelReconnect`) onto `BaseClientTransport`; pulled the per-connection server state (subscriptions Map, in-flight Map, `dispatchInbound`, `cancelInFlight`, `close` cleanup) into a new `BaseConnectionContext` abstract class. All four transports (in-process, WS, HTTP, Unix socket) refactored to consume these — clients shrank ~150 LOC of duplicated reconnect code; servers shrank ~250 LOC of duplicated `ConnectionContext` boilerplate. Each concrete transport now contains ONLY wire-specific code: WS = subprotocol negotiation + WebSocket lifecycle (165 LOC); UDS = NDJSON + net.Socket lifecycle (130 LOC); HTTP = fetch + SSE parse + GET notification channel (215 LOC). Workspace: 110/110 across all transport packages; WS conformance suite passes 20/20 isolated runs after the consolidation (same as after the earlier race fix). Typecheck clean.

**Previously, 2026-06-12 — Phase 33.E shipped: `@agentick/transport-unix-socket-next`.** Fourth transport on `BaseClientTransport`. Newline-delimited JSON-RPC over a Node `net.Server` / `net.Socket`. Node-only — required for tentickle-class local-IPC (TUI ↔ same-host daemon). ~170 LOC of socket-specific code; the extraction from Phase 33.C.1 is paying off — fourth transport in same session as third (33.D) and shipped on first-try with 18 tests green (5 smoke + 13 conformance). All four transports (in-process, WS, HTTP, Unix socket) now share the same `BaseClientTransport` + `runTransportConformance` discipline.

**Previously, 2026-06-12 — Phase 33.D shipped: `@agentick/transport-http-next` (Streamable HTTP per MCP 2025-03-26).** Single endpoint serves POST (JSON-RPC request → either `application/json` for non-streaming or `text/event-stream` for `_meta.progressToken`-bearing requests), GET with `Accept: text/event-stream` (persistent notification channel for subscriptions + unsolicited events), DELETE (session teardown). Universal `fetch` client (Node 22+, browser, Bun, Deno, edge). Server adapter mounts on `http.Server`; per-session `ConnectionContext` tracks GET notification stream + in-flight RPCs + subscriptions. Session affinity via `Mcp-Session-Id` header. CORS via `allowedOrigins` + OPTIONS preflight. Subclasses `BaseClientTransport` from `@agentick/transport-next` — third transport built in ~250 LOC of HTTP-specific code; gets state machine, RPC correlation, subscription multiplexing, cursor-aware resubscribe for free. 18 new tests (5 smoke + 13 conformance, all passing). Caught one bug: `writeHead` alone doesn't flush headers on a Node `http.ServerResponse` for streaming SSE — explicit `flushHeaders()` + a leading comment frame is required for `fetch` clients to resolve their response promise on connect.

**Previously, 2026-06-12 — Phase 33.C.1 shipped: `@agentick/transport-next` extracts ~400 LOC of shared transport plumbing from `transport-in-process-next` + `transport-websocket-next`.** `BaseClientTransport` (abstract) now owns state machine, RPC correlation, subscription/progress stream registries, notification routing, cursor-aware resubscribe machinery, and AbortSignal→cancellation wire emit. Concrete transports subclass and supply only wire-specific connection management — in-process shrank from ~340 to ~94 LOC; WebSocket from ~390 to ~220 (kept reconnect + subprotocol + WS-specific socket plumbing). `dispatchRequest` (the JSON-RPC → `GatewayHarnessProtocol` adapter) moved out of `transport-websocket-next/server/dispatch.ts` (wrong package) into `transport-next/server/dispatch.ts` — WS, HTTP (Phase 33.D), and Unix-socket (33.E) all consume it. `runTransportConformance(name, factory)` ships in `@agentick/spec-conformance-next`: a shared behavioral suite (13 tests) every transport runs against its own setup function — state machine, RPC dispatch + errors, multiplexed concurrent RPCs, `notifications/cancelled` wire emit, subscription routing + close + eviction, progress stream routing. The extraction caught a real `MultiplexedStream` bug: `end(error)` was resolving pending iterator `next()` calls with `{ done: true }` instead of rejecting — pre-existing in both transport impls, now fixed in one place. Workspace: 5768 tests passing (+46 from conformance × 2 transports), typecheck clean.

**Previously, 2026-06-12 (earlier) — Phase 33 README audit pass — every claim in user-facing docs now traces to a verifying test, or sits in "Roadmap & known gaps" with an explicit `✗` marker.** Caught a real API bug along the way: `ClientProtocol.request()` claimed to accept an `AbortSignal` (per the README and ADR 33) but didn't expose the parameter — the test forced the fix. Wire-level `notifications/cancelled` emit + server-side handling is now genuinely verified end-to-end. Added 17 new tests (security 7, cancellation 2, custom-WebSocket-ctor 1, handler-registry 6, effect-middleware 3, send-shortcut 2). Every Phase 33 README has a `## Verified by` section mapping claims → test files; non-obvious code invariants carry `@verifiedBy` JSDoc citations. Saved as memory rule: "Every claim needs a test" — applies to user-facing docs, comments, and code claims going forward.

**Phase 33.B + 33.C — initial ship (previous work blocks):**

**Phase 33.C — WebSocket transport (this work block):**

- **`@agentick/transport-websocket-next`** package with `/client` + `/server` subpath exports.
- **Client side** — uses `globalThis.WebSocket` by default (Node 22+, browser, Bun, Deno, edge runtimes). Accepts `{ WebSocket }` constructor override for adopters on Node 18/20 (`ws` library) or who need custom headers in Node. Frame multiplexing: a single connection carries N concurrent RPCs (correlated by `id`) plus N subscriptions / progress streams (correlated by `subscriptionId` / `progressToken`). No Socket.IO — the canonical wire-multiplexing pattern via JSON-RPC. Exponential backoff with full jitter (per AWS Builder's Library; 100ms → 30s cap). Cursor-aware resubscribe on reconnect — each active subscription replays from its last-seen cursor.
- **Server side** — `websocketServer({ httpServer, gateway })` attaches a `WebSocketServer` (from the `ws` library; Node's native WebSocket is client-only) to an existing Node `http.Server`. Subprotocol negotiation: accepts only `agentick-rpc-v1`. Per-connection `ConnectionContext` tracks active subscriptions; heartbeat via WS-level ping/pong (RFC 6455 §5.5.2/3, 30s default). Origin validation for browser clients (`allowedOrigins` config). JSON-RPC frame dispatch in `server/dispatch.ts` is **transport-agnostic** — it will serve the HTTP and Unix-socket adapters in Phase 33.D / 33.E without changes.
- **Tests** — 19 new, all green. Smoke (8) covers WS connect with subprotocol, ping roundtrip, listApps reflecting real GatewayHarness state, RPC error → `TransportError`, concurrent RPC multiplexing, clean close, subprotocol enforcement. Reconnect (3) covers server-bounce → reconnect transition, explicit-close suppression, disabled-reconnect → clean closed. Wire conformance (8) — the spec-conformance suite runs against the JSON codec.

**Phase 33.B — `@agentick/client-next` + in-process transport (this work block):**

- **`@agentick/spec-next/client/`** — `ClientProtocol`, `Client` (= protocol + `ClientNamespaces` via decl-merge), `GatewayHandle` / `AppHandle` / `SessionHandle` / `ClientSessionExecutionHandle`, `ClientTransport` contract, `ClientExtension` shape (Promise-native middleware + per-event-merge lifecycle handlers + `ClientInstaller`), `ClientState` machine, `TransportError`, client-bus event surfaces. **Multiple impls can conform** — canonical client, test mocks, future Worker-thread proxy — the protocol is the canonical surface, not any particular package.
- **`@agentick/client-next`** — `createClient()`, `AgentickClient`, `composeRequest` / `composeSubscribe` pipelines, `ClientHandlerRegistry` (per-event merge: observer / first-non-null-wins / any-reconnect-wins, exhaustiveness-checked), `effectMiddleware()` Effect adapter, handle factories, `createSessionExecutionHandle` stitches `session/send` RPC with `transport.progress(token)` stream into the canonical AsyncIterable + `.result` + abort shape.
- **`@agentick/transport-in-process-next`** — first transport. Direct-call, zero-serialization. Optional `wireParity: true` mode JSON-roundtrips for catching wire-shape regressions at test time. Smoke (10) covers ping, listApps, listSessions, session.abort, RPC error shape, wireParity roundtrip, extension middleware order, namespace registration, onClose LIFO. Wire conformance (8) green.
- **Wire-type alignment** — `AppGetSessionResult = SessionEntry`, `AppListSessionsParams.filter: SessionFilter`, `AppListSessionsResult.sessions: SessionEntry[]`. The wire reuses canonical in-process types where they're JSON-safe; eliminates wire/in-process shape divergence.

**Phase 33.A — engineering decisions made (pre-review pass against rev-1 draft):**

- **`JsonRpcSuccessResponse` / `JsonRpcErrorResponse` enforce mutual exclusion** via `error?: never` / `result?: never` markers. JSON-RPC 2.0 forbids carrying both; TS structural typing required explicit `never` to close the gap.
- **`SessionSendParams.messages` typed `SendMessageInput[]`** (not `ContentBlock[]`). Role + content + metadata cross the wire. Same fix on `AppRunOnceParams` / `SessionQueueParams`.
- **`WireRequestParams` base interface** carries `_meta?: RequestMeta`; every request params type extends it (MCP-uniform).
- **`initialize` + `notifications/initialized` handshake** added with `ClientCapabilities` / `ServerCapabilities` (cursorResume, batch, streamableHttp, subscriptions, progress, cancellation, mcpSurface).
- **`validateJsonRpcFrame` / `validateJsonRpcInput`** validators ship in spec — transports MUST validate untrusted JSON before treating it as typed.
- **`runWireConformance(codec)` suite** in `@agentick/spec-conformance-next` — every transport runs this against its own encode/decode.

**Workspace:** 5722 tests passing (was 5703 — +19 WS tests). Typecheck clean across all 89 packages. v1 transport tests in `packages/gateway/{unix-socket,local}-transport.spec.ts` flake under workspace-wide parallel load (Unix socket path collisions; pre-existing — pass 68/68 in isolation).

**Previously, 2026-06-11 — ADR 33 landed + Phase 33.A shipped: wire types in `@agentick/spec-next/wire/`.** ADR 33 (Client + transports) drafted through four revisions: rev-1 initial design, rev-2 ergonomics pass (selector/multiplexer take instances not factories; `client.send()` shortcut; Streamable HTTP), rev-3 `BaseHarness`-parity (client middleware Promise-native with `effectMiddleware` adapter; lifecycle handlers with per-event merge rules; `AuthSource` parameterized per-transport), rev-4 MCP wire alignment (`_meta.progressToken` at MCP-exact location; method separator unified to `/`; `notifications/` prefix; error code table; reserved MCP namespaces; planned `@agentick/mcp-surface-next` + `@agentick/transport-mcp-client-next` bilingual packages). Wire spec types shipped in `@agentick/spec-next/wire/`: JSON-RPC 2.0 envelopes with mutual-exclusion enforcement via `error?: never` / `result?: never`; `ErrorCode` const namespace (-32700/-32603 standard, -32800/-32801 LSP, -32000..-32050 Agentick); `ErrorData` typed-data registry; `SubscriptionScope` discriminator; method-bound param/result shapes for every method including `initialize` handshake (MCP-aligned); `WireMethods` + `WireNotifications` registries for typed dispatch; `validateJsonRpcFrame` + `validateJsonRpcInput` for untrusted-input validation; `runWireConformance` suite in spec-conformance for every transport to verify roundtrip + validator integration.

**Phase 33.A — engineering decisions made (post-review pass against the rev-1 draft):**

- **`SessionSendParams.messages` typed `SendMessageInput[]`**, NOT `ContentBlock[]`. Role + content + metadata cross the wire. Caught in self-review pre-commit; without role the wire cannot represent multi-turn conversation.
- **`WireRequestParams` base interface** carries `_meta?: RequestMeta` so every request shape can opt into MCP `_meta` hints uniformly — no inconsistent presence per method.
- **`JsonRpcSuccessResponse` / `JsonRpcErrorResponse` enforce mutual exclusion** via `error?: never` / `result?: never`. TypeScript structural typing made this a real gap; `never`-marker closes it.
- **`initialize` + `notifications/initialized` handshake added** mirroring MCP. Capability negotiation (cursorResume, batch, streamableHttp, subscriptions, progress, cancellation, mcpSurface) at session start.
- **`validateJsonRpcFrame` / `validateJsonRpcInput`** validators ship in spec — transports MUST call these on untrusted decoded JSON before treating it as a typed frame. Type guards (which exist alongside) narrow already-well-formed frames; the validators reject malformed input with a structured `JsonRpcError`.
- **`runWireConformance(codec)` suite** in `@agentick/spec-conformance-next/wire.ts` — every transport's test file calls this with its own encode/decode pair, exercising roundtrip of all four frame kinds + validator integration + batch handling + empty-batch rejection.

**Workspace:** 5686/5686 tests green (+18 from new wire conformance + extended wire spec). Typecheck clean across all packages.

**Previously, 2026-06-10 — Workspace reorganization: v2 packages relocated to `packages-next/` with `-next` suffix on every package name.** v1 stays untouched in `packages/` so master merges land cleanly. The reorganization is purely packaging; no API or behavior change. At v2.0 cut the suffix strips and `packages-next/` collapses onto `packages/`.

**Reorganization (this work block — `f22b3985`):**

- **`pnpm-workspace.yaml`** — added `packages-next/*` glob.
- **`git mv`** — 22 v2-pure packages relocated to `packages-next/` with rename detection preserving history: `spec`, `runtime`, `app`, `session`, `reconciler`, `reconciler-react`, `executor`, `executor-openai`, `executor-anthropic`, `executor-google`, `executor-ai-sdk`, `loop-executor`, `tool-executor`, `tool`, `knobs`, `state`, `timeline`, `gates`, `skills`, `formatters`, `subscriptions`, `spec-conformance`.
- **Sandbox + Gateway extraction** — `packages/sandbox/src/v2/` → `packages-next/sandbox/` and `packages/gateway/src/v2/` → `packages-next/gateway/` as standalone packages with their own `package.json` / `tsconfig.json` / `tsconfig.build.json`. `/v2` exports + v2 deps stripped from v1 sandbox + gateway package manifests so the v1 surfaces are clean.
- **Rename pass** — `@agentick/<pkg>` → `@agentick/<pkg>-next` across source `.ts`/`.tsx`, every `package.json` / `tsconfig*.json`, examples, blueprint docs, and skill docs (376 files via perl script).
- **Tooling configs** — `.changeset/config.json` drops v2 names from the `fixed` array (v2 packages re-publish under canonical names at v2.0 cut); `website/typedoc.json` replaces v2 entries with `packages-next/*` paths; `website/.vitepress/config.mts` lists the 24 `-next` packages under the v2 group.
- **Verification** — `pnpm install` clean; `pnpm -r typecheck` clean across all packages; `pnpm vitest run` clean (4625 tests passing, 1 file skipped).

**Cut-over plan at v2.0** — perl-strip `-next` suffix + `git mv packages-next/* packages/`. Overlapping names collide with v1 — that collision is the migration moment where v1 gets archived.

**Workspace:** 4625/4625 tests green. 87 packages on `feat/v2` (65 v1 + 22 v2-pure + 2 v2-extracted from v1 dual-tree packages).

**Previously, 2026-06-07** — **ADR 32 landed (Extension shape spectrum — six shapes from full harness to pure descriptor; decision tree + concrete v1 plugin/transport disposition for Phase 5). First Phase 5 deliverable: `SkillsHarness` shape-1 harness scaffold in new `@agentick/skills-next` workspace package (OpenClaw / Hermes style durable, searchable agent skill library). Plus `readonly id: string` exposed on `AppHarnessProtocol` and `SessionHarnessProtocol` (filled the adopter-surface gap from Phase 4).**

**Phase 5 kicked off (2026-06-07 work block):**

- **`blueprint/32-extension-shape-spectrum.md`** (new ADR). Documents the spectrum every "extension" lives on: (1) full harness extension, (2) namespace object, (3) pure bus subscriber, (4) reconciler contributor, (5) descriptor + hook (gates pattern), (6) tool / formatter. Each shape has a cost/value calculus. Decision tree adopters or contributors use to pick the right shape. Phase 5+ plugin/transport disposition table — most v1 plugins reshape into shape 1 (mcp-server, openai-compat as harnesses with per-request state) but logging reshapes into shape 3 (pure subscriber, ~3 lines of code). All v1 transports reshape into shape 1 — per-connection state + bidirectional translation justifies the substrate audit cost. Gates is the load-bearing shape-5 counter-example.
- **`AppHarnessProtocol.id` + `SessionHarnessProtocol.id`** (new spec fields). Filled the gap flagged in Phase 4. Promoted from `protected scopeId` to public via `get id()` getter on `AppHarness`, `SessionHarness`, `CallbackSessionHarness`. Gateway tests now round-trip the auto-generated `app:${ulid()}` id through `gateway.createApp`.
- **`@agentick/skills-next` workspace package** (shape 1 harness extension). `Skill` data model (`name` / `description` / `content` + optional `tags` + `metadata` + timestamps). Sync surface: `get`/`has`/`list`/`search`/`subscribe`/`subscribeAll`. Async surface: `register`/`update`/`remove` through `runOperation`. Snapshot/restore. Inbox catalog with three message types. Module augmentation: `HookBridges.skills` + `SessionHarnessProtocol.skills`. `withSkills({ initial })` SessionExtension. Conformance suite (18 contract tests). `stubSkillsHarness(initial?)` testing helper. `"skills"` added to `EventSurface` union.

**Workspace:** 5647/5647 tests green (was 5615; +19 skills + 13 from interim). Typecheck clean across 87 packages (now includes `@agentick/skills-next`).

**Previously, 2026-06-06 — Phase 4 kicked off — thin `GatewayHarness` scaffold shipped in `packages/gateway/src/v2/`. Runtime-root harness; multi-app hosting with substrate inheritance / per-app factory overrides; lifecycle cascade; cross-app event observation. Plus three doc artifacts grounding the v2 Gateway story against v1's actual implementation: rewrite of `blueprint/12-gateway.md` (runtime-root framing, four deployment tiers, transports/plugins as extensions), `V1-GATEWAY-PARITY-TRACKER.md` (42 v1 features inventoried across 12 categories; Phase 4 closes 6 of them, rest deferred / reshaped), and ADR 31 framing clarifications (Gateway useful at all tiers, not just cluster-node level).**

**Phase 4 (this work block — sequenced 4.1 through 4.4):**

- **`blueprint/12-gateway.md` end-to-end rewrite (4.1)** — V1 deep-read revealed the doc's prior "stateless front door" framing didn't match v1's actual `Gateway` (~27K LOC, stateful multi-app host + transports + plugins + auth + sessions). Rewrote around the harness-shape view: Gateway is the runtime root in every tier, cluster substrate is a swap not a separate harness, transports are extensions. Useful for OpenClaw/Hermes-class local agents AND multi-tenant cloud.
- **ADR 31 framing clarifications (4.2)** — "Gateway: cluster-node level" → "Gateway: runtime root, useful at every deployment tier." `@agentick/cluster` provides substrate impls, not a separate harness type.
- **`V1-GATEWAY-PARITY-TRACKER.md` (4.3)** — explicit inventory of v1 Gateway capabilities matching the `V1-PARITY-TRACKER.md` pattern. Categories: gateway core (GG1–GG4), extension protocol (GE1–GE2), network transports (GT1–GT7), plugins (GP1–GP3), session management (GS1–GS5), method registry (GM1–GM6), auth (GA1–GA5), config (GC1–GC2), backpressure (GB1–GB3), static (GF1–GF2), tool confirmation (GTC1), devtools (GD1–GD2). Phase 4 closes 6; rest reshape or defer.
- **`GatewayHarness` scaffold (4.4)** — new files in `packages/spec/src/protocol/gateway-harness.ts` + `packages/gateway/src/v2/`. Spec defines `GatewayHarnessProtocol` (read-side apps surface, lifecycle, events), `GatewaySubstrateParent`, `CreateAppInput`, `GatewayExtension`/`GatewayInstaller`/`GatewayExtensions` for future extension impls. Impl ships `GatewayHarness extends BaseHarness<"gateway">` + `createGateway(options)` factory. Apps inherit gateway substrate by default; per-app substrate overrides supported (instance or factory). Close-op envelopes are bus-only via Option G `JournalingPolicy.override`. Package `./v2` subpath added to `packages/gateway/package.json` (matches sandbox v2 coexistence pattern). 11 tests passing.

**Workspace:** 5615/5615 tests green (was 5604; +11 gateway). Typecheck clean across all 86 packages.

**Phase 4 — engineering decisions made:**

- **`GatewayHarnessProtocol` keeps read-side only for apps.** `createApp(input)` is on the concrete impl (`GatewayHarness` from `@agentick/gateway/v2`), not on the protocol. Reason: typing input opts at the spec level would force pulling `@agentick/app-next`'s `AppHarnessOptions` into spec or making it opaque (useless for adopters). Concrete impls expose their own typed `createApp`; protocol consumers can enumerate apps but not construct them.
- **`EventLog<E, AppendError>` parameterised error channel** carried over from Phase C — Gateway uses default `never` (in-memory substrate, infallible appends).
- **No transports / plugins / auth in Phase 4.** Per ADR 31's "Gateway is optional, plugins reshape into extensions" + the parity tracker's reshape table. Tier 0 only — embedded library shape. Phase 5+ ships per-transport / per-plugin packages.
- **`gateway:app:created` event** emitted on the gateway bus when an App is registered. Adopters subscribing to `gateway.events({ surface: "gateway" })` see app construction observability without adapter wiring.

**Phase 4 — adopter-surface gaps acknowledged (not blockers):**

- `AppHarnessProtocol` / `SessionHarnessProtocol` don't expose `readonly id: string`. Adopters track app/session ids through the construction-time input (the caller-supplied appId / sessionId). Gateway's `app(id)` lookup works because the gateway tracks its own appId mapping. Worth a follow-up to add `id` to the protocols for symmetry with v1 ergonomics, but not Phase 4 scope.
- No example/v2-real or new example demonstrating Gateway hosting multiple Apps with per-tenant substrate factories. Worth adding before Phase 5 to exercise the multi-tenant emergent pattern.

**Previously, 2026-06-06 (earlier) — ADR 29 Phase C shipped: `EventLog<E, AppendError>` unified primitive; `LocalEventBus` ring buffer + cursor pull; `MemoryJournal` aligned to the same protocol; `bus.publish` → `bus.append` rename in lockstep with the spec extends; `tail` collapsed to sugar over `read`. Net Phase B+C delivers ~1.5–1.6× on the executor hot path; the cursor pull subsumed most of Phase B's relative win because the per-subscriber Effect.Queue model it replaced was the underlying bottleneck.**

**ADR 29 Phase C (this work block — sequenced C.1 through C.7):**

- **Spec — `EventLog<E, AppendError = never>` primitive** (new `packages/spec/src/protocol/event-log.ts`): `Cursor`, `CompiledMatcher<E>` generic, `CursorEvictedError`, `LogMetrics`, `EventLog<E, AppendError>` interface. Parameterised error type so bus uses `never` (in-memory, infallible) and journal uses `JournalError` (storage can fail).
- **Spec — `EventBus extends EventLog<ProtocolEvent>`**: `append`/`appendBatch`/`read(cursor, matcher)`/`hasSubscriberFor`/`metrics` inherited from the log primitive. `subscribe(query, options?)` is now sugar with `SubscribeOptions { fromCursor?: Cursor }`; failure channel flipped to `CursorEvictedError`. Old `bufferSize`/`overflow`/`SubscriberOverflow`/`BufferOverflowError` dropped (no longer meaningful under cursor pull).
- **Spec — `OperationJournal extends EventLog<ProtocolEvent, JournalError>`**: same inheritance. Old `OperationJournal.read(query, from)` renamed to `readByQuery(query, from)`; new `read(cursor, matcher)` is the EventLog primitive. `tail(query)` is now sugar over `read(currentHead, compileQuery(query))` with `CursorEvictedError → JournalError` mapping.
- **Runtime — `LocalEventBus` rewrite**: shared ring buffer (default `capacity: 4096`; configurable via `LocalEventBusOptions.capacity` and `defaultRetention.maxEvents`); per-subscriber cursor + `Promise`-based wake registered via `Effect.async`; `Stream.unfoldEffect` for clean stream-end on close. Phase B's batch accumulator + `publishLazy` + parent fan-in preserved.
- **Runtime — `MemoryJournal` aligned**: `tailListeners` set replaced by `cursorSubs`. Same `pullOne` pattern as `LocalEventBus`. Sliding-window event-rate metric via cheap two-counter scheme. **True wall-clock `cursorLagP99`** (not eps-approximation) — looks up `event.timestamp` at the subscriber's cursor position.
- **Audit + rename in lockstep**: every `bus.publish(...)` → `bus.append(...)` across BaseHarness, session-harness, channel-publisher, conformance suite, all tests, all benches. Every `journal.read(query, from)` → `journal.readByQuery(query, from)` across 8 test files + the v2 example. Caught a buggy `{ kind: "earliest" }` in `create-factory.spec.ts` that was passing TypeScript structurally but never matched a real `JournalReadFrom` variant.
- **C.5 collapsed into C.2**: old per-subscriber `Effect.Queue` path removed entirely — single code path through the ring buffer. No transitional state shipped.

**Phase C — engineering decisions made (documented in `blueprint/29-bus-overhaul.md`):**

- `EventBus`/`OperationJournal` extend `EventLog<E, AppendError>` as **parameterised interface** — bus and journal share the same primitive surface but specialize the append error channel.
- `LocalEventBusOptions.defaultRetention.maxEvents` defaults to **4096** with per-surface overrides via `LocalEventBusOptions.retention`. Pass `defaultRetention: {}` for unbounded.
- **Loud-failure backpressure**: cursor past retention → `CursorEvictedError` on the stream's failure channel. No silent skip-ahead. Adopters who want skip-ahead semantics catch the error and resubscribe with `oldestAvailable`.
- **`tail` is sugar over `read`** on both bus and journal. `tailListeners` removed from MemoryJournal — single cursor-pull mechanism.
- **`maxAge` retention is reserved by spec but not enforced** by either impl. Time-based eviction requires a periodic sweep; small lift, not Phase-C-critical. Documented as deferred.
- **Self-instrumentation deferred**: bus emitting its own metrics events would require a new `EventSurface` value or piggybacking on an existing one. Punted to ship alongside the L8 OTel projection.

**Phase C — bench numbers** (full results in `packages/runtime/src/__bench__/substrate-bench-results.md`):

| Path                                                    | Pre-Phase-B |          Phase B |                   Phase C |
| ------------------------------------------------------- | ----------: | ---------------: | ------------------------: |
| `OpenAIExecutor.run` 100 deltas + 1 sub (full hot path) |    1,558 hz | 2,679 hz (1.72×) | 2,448 hz (1.57× vs pre-B) |
| `bus.publish(executor:delta)` 1 sub batching OFF        |           — |          175K hz |            299K hz (+70%) |
| `bus.publish(executor:delta)` 3 subs batching OFF       |           — |           64K hz |            109K hz (+71%) |

The ring buffer made the unbatched baseline ~70% faster, which means **Phase B's relative batching win shrank from 1.89×/2.26× (Phase B) to 1.05×/1.16× (Phase C)** — but both absolute numbers are higher than Phase B's batched path. Net Phase B+C delivers ~1.5–1.6× on the executor hot path; most of it from Phase C's cursor pull, not Phase B's batching.

**Phase C — adopter-surface gaps acknowledged (not blockers):**

- Events don't carry their own cursor — adopters consuming `app.events(...)` have no way to capture a resume point from events they've already seen. The cursor protocol is wired through `bus.subscribe(query, { fromCursor })` (and `app.events(filter, { fromCursor })` per this commit), but actually using it requires either (a) carrying cursor on the envelope OR (b) emitting a "current cursor" probe. Either is small follow-up work; neither is in Phase C.
- `metrics()` is exposed on the bus, not on the app/session façade. Adopters who want metrics need bus access.
- No `example/v2-real` cursor-replay demo was added — the demo would require the adopter-surface work above to be usable. Documented honestly rather than shipping a contrived example.

**Workspace:** 5604/5604 tests green (3 skipped, 5 todo). Typecheck clean across 86 packages.

**Previously, 2026-06-05 — ADR 29 Phase B shipped: per-surface batched LocalEventBus + `publishBatch` direct path. Transparent ~1.7–1.9× win at one subscriber on the full OpenAI streaming path; 4.4× via explicit `publishBatch`. Honest writeup of the gap from ADR 29's 10× target (Phase A's `compileQuery` already moved the floor) in `packages/runtime/src/__bench__/substrate-bench-results.md`.**

**ADR 29 Phase B (this commit)**:

- **Spec** — `SurfaceBatchPolicy`, `SurfaceRetentionPolicy`, optional `JournalingPolicy.batch?`/`retention?` types added to `@agentick/spec-next/data/journaling-policy.ts`. Optional `EventBus.publishBatch?` added to `@agentick/spec-next/protocol/bus.ts` (technically-accurate Phase B name; renames to `appendBatch` when Phase C unifies under `EventLog<E>`).
- **Runtime** — `LocalEventBus` gained a per-surface batch accumulator with two flush triggers (time-window via `setTimeout`, count-cap on push). `LocalEventBusOptions.batch?` accepts adopter policy; defaults to `DEFAULT_LOCAL_BUS_BATCH_POLICY` (exported constant — only `executor:delta` 8ms/4 ships by default; ADR 29 draft's `session:metric` was dead config keyed against a non-existent phase, dropped). `publishBatch` direct path bypasses the accumulator entirely. Chained close-drain (caught + fixed a race between `Effect.runFork(dispatch)` and `Effect.runFork(Queue.shutdown)` where queue could shut down first).
- **Executors** — zero adapter code changes needed. `OpenAIExecutor extends BaseHarness<"executor">` + `emitDeltaLazy(streamOp, () => delta)` → `bus.publish` with `surface=executor phase=delta` automatically hits the batched path.
- **Tests** — 16 new batching specs in `packages/runtime/src/__tests__/local-event-bus-batching.spec.ts`; 3 type-only specs in `packages/spec/src/__tests__/types.spec.ts`. All existing bus tests still green (they use surfaces/phases that don't match the default policy, so they fly through the immediate path).
- **Benches** — 6 new Phase B scenarios in `packages/runtime/src/__bench__/substrate.bench.ts` + 2 A/B scenarios in `packages/executor-openai/src/__bench__/streaming.bench.ts`. Full numbers in `packages/runtime/src/__bench__/substrate-bench-results.md`.
- **Workspace** — 5582/5582 tests green (3 skipped, 5 todo). Typecheck clean across all 86 packages.

**Honest read against ADR 29's 10× per-delta target:** that target was anchored to a 2026-06-02 measurement of "+20 μs per delta with one subscriber" (full executor.run path). Phase A's `compileQuery` (already shipped) moved the bus-only baseline from ~20 μs to ~5.7 μs/publish — a ~3.5× cheaper floor than the figure ADR 29 was written against. Against today's actual baseline, Phase B's transparent win is **1.7–2.3× at 1 sub, 2.3× at 3 subs**; `publishBatch` direct delivers **4.4×** on 8-event batches. Remaining cost is dominated by `Effect.runPromise`/`Effect.suspend` runtime entrance (~3 μs floor) which batching cannot reduce. Pushing further requires either executor-level explicit batching (deferred — invasive, low marginal benefit) or sync `publishUnsafe` (out of Phase B scope).

**Previously, 2026-06-02 — G9 + G11 closed; layered providerOptions architecture across all four executors; ADR 29 (bus overhaul) proposed; pre-compiled query matchers shipped (Phase A of ADR 29).**

`@agentick/executor-google-next` shipped covering G9: full streaming + non-streaming through `@google/genai`, Vertex AI + Gemini Developer API paths via `clientOptions: GoogleGenAIOptions`, thoughtSignature round-trip for Gemini 3+ thinking (without it, multi-turn tool use returns `MISSING_THOUGHT_SIGNATURE`), `part.thought === true` routing to the reasoning channel (Gemini 2.5+), single-pass stream accumulator that builds `ContentBlock[]` directly during streaming, full 16-entry FinishReason map, `thoughtsTokenCount`/`cachedContentTokenCount` surfacing, `sanitizeSchemaForGemini` ported from v1, parseThinkTags + customBlocks via the shared `StreamTagParser`. 54/54 tests in the package (35 provider-specific + 15 conformance + 4 factory).

**Layered providerOptions** landed across all four executors (closes G11): three new empty-seed augmentable interfaces in `@agentick/spec-next` (`ProviderClientOptions`, `ProviderOptions`, `ProviderToolOptions`) mirroring v1's `ProviderClientOptions`/`ProviderGenerationOptions`/`ProviderToolOptions` triad. Each adapter contributes its slots typed as the SDK's actual config types — no hand-rolled subsets. OpenAI: `OpenAI.ClientOptions` / `Partial<ChatCompletionCreateParams>` / `Partial<FunctionDefinition>`. Anthropic: `Anthropic.ClientOptions` / `Partial<MessageCreateParams>` / `Partial<AnthropicTool>`. Google: `GoogleGenAIOptions` / `GenerateContentConfig` / `Partial<FunctionDeclaration>`. Each executor's construction options now nest SDK config under `clientOptions` (replacing flat `apiKey`/`baseURL`/etc. fields). `ToolDeclaration.providerOptions?` extends `ToolDeclaration`; `buildTools` in every executor forwards it through projection. **Anthropic `cacheControl` meta-knob removed entirely** — per-block cache control now flows via `BaseContentBlock.providerMetadata.anthropic.cacheControl` (per-block adopter stamps the specific block; executor reads it and stamps SDK `cache_control` on the corresponding param). `providerMetadata?` lifted from `ToolUseBlock` onto `BaseContentBlock` so every block type carries per-block round-trip data (Anthropic cache_control, Gemini thoughtSignature, future OpenAI logprobs).

**Streaming adapter benchmarks landed** (`packages/executor-{openai,anthropic,google}/src/__bench__/streaming.bench.ts` + dated entry in REFACTOR-SCRATCHPAD `§2026-06-02`). Numbers: no-subscriber per-delta is ~2 μs across all three adapters (OpenAI 2.20 μs, Anthropic 1.72 μs, Google 1.79 μs); the dual-walk pattern in OpenAI/Anthropic costs only ~0.4 μs more than Google's single-pass. **The real cost is subscriber fan-out: +20 μs per delta the moment ONE subscriber attaches** — 10× the no-sub baseline. Drives ADR 29's prioritization (batching > leaner aggregation).

**ADR 29 — Bus overhaul** proposed at `blueprint/29-bus-overhaul.md`. Phased rollout toward multi-tenant cloud + cluster-ready substrate: (A) pre-compiled queries [SHIPPED], (B) batched LocalEventBus with per-surface policy, (C) cursor protocol + ring buffer impl swap, (D) `@agentick/cluster` backend. Captures the architectural picture (unified `EventLog<E>` primitive, structural tenancy at the log level, gossip-replicated distributed `hasSubscriber`) and names four open design decisions for review before Phase B lands.

**Phase A shipped this session**: `compileQuery(query): CompiledMatcher` exported from `@agentick/runtime-next`; specialises per-event filter from a query-union walk to a 2-comparison closure for typical `{ surface, phase }` shapes. Wired into `LocalEventBus.subscribe` (per-subscriber matcher), `MemoryJournal` tail listeners, and `MemoryJournal.read`. 24-test correctness spec assert agreement with `matchesQuery` across every shape; bench numbers (1.65× – 2.49× faster) appended to substrate.bench.ts. 89/89 runtime + 402/402 across substrate + executors green.

**Previously, 2026-05-27:** **FAÇADE.6 shipped + `@agentick/reconciler-next` package extracted**. The four deferred callback-style factories landed: `defineToolExecutor`, `defineLoop`, `defineSession`, `defineReconciler` — same pattern as the existing `defineExecutor` (callback bundle → marker-tagged factory). Spec gained the corresponding `XFactory` / `XFactoryDeps` / `isXFactory` type-guard triple per harness. `AppHarness` slots widened to accept factories alongside instances/options: `tools`, `loop`, `reconciler` all detect the marker and invoke the factory with the shared substrate so harness events flow through `app.events()` automatically. `defineReconciler` initially shipped in `@agentick/runtime-next`; relocated immediately into the new **`@agentick/reconciler-next`** package as the reconciler-agnostic base. The split matches the existing pattern (`@agentick/model-executor-next` base + `@agentick/executor-openai-next` concrete; `@agentick/reconciler-next` base + `@agentick/reconciler-react-next` concrete). New-package checklist completed (changeset linked, typedoc entry, vitepress group, README). **Honest assessment of the factories captured in scratchpad:** they are substrate-wiring sugar, not full replacements for the reference subclasses — most reference-impl ergonomics (validation pipeline, lifecycle events, middleware hooks, state stores) are NOT replicated. defineX is the right tool for test stubs, simple adapter patterns, and protocol-conforming mocks; subclassing `BaseHarness<X>` remains the path for production-quality custom impls. Documented this trade-off so users aren't surprised. **Also captured in scratchpad: the model-catalog / `ModelAdapter` architecture** as a deferred design note (resolves the `executor-openai` naming concern by re-shaping concrete provider impls as adapters consumed by a native executor, with capabilities lookup uniform across native + ai-sdk paths). 19 new tests across the four define APIs; 5314/5314 effective tests pass; 2 pre-existing executor-ai-sdk msw failures unchanged.

**Previously, 2026-05-23:** **End-to-end real-model example landed** (`example/v2-real/`). Validates v2 ergonomics with a real OpenAI model via `@agentick/executor-ai-sdk-next` + `@ai-sdk/openai`. Writing the example surfaced three missing ergonomic affordances which were filled inline: (1) **`app.send(input: string | SendInput): Promise<SendResult>`** — Vercel-grade shortcut over `runOnce` for the 90% case (plain prompt → final result); (2) **`app.close()` alias** — natural counterpart to `session.close()` / `harness.close()` (thin alias for `closeApp`); (3) **Semantic role components** — `<System>`, `<User>`, `<Assistant>` as pass-through wrappers over `<Message role="...">`, plus block-level `<Paragraph>`, `<H1>`, `<H2>`, `<H3>` over the `paragraph` / `heading` intrinsics. All trivial wrappers (no behavior) but lift the user surface from "JSX boilerplate" to "JSX prose." The example agent (~30 LOC) renders a `<System>` prompt, declares a `Calculator` tool inline via `createTool` (zod schema + inline handler), exposes a `verbose` knob via `useKnob`, renders `<Knobs />` to auto-emit `set_knob`. The runner (~15 LOC) is `createApp(<Agent />, { executor: aisdk({ model: openai("gpt-4o-mini") }) })` + `await app.send("prompt")`. Full workspace typecheck green (86 packages). End-to-end run pending adopter's `OPENAI_API_KEY`. Lesson reinforced: the example is the unit test for ergonomics — write it BEFORE freezing the user surface. See REFACTOR-SCRATCHPAD.md "2026-05-23 — End-to-end real-model example landed" for the punt list.

**Previously, 2026-05-26:** **ADR 27 landed: modular built-ins**. Built-in extensions (timeline, knobs, state, gates) now follow the IDENTICAL pattern as optional extensions (sandbox, mcp): per-harness package layout, TypeScript module augmentation for `HookBridges` slot registration, `/react` subpath convention, `/testing` subpath convention. Difference between built-in and optional is shipping only — built-ins are private workspace packages bundled into the `agentick` metapackage; optionals are public packages installed separately. `@agentick/spec-next`'s `HookBridges` is an empty seed; every harness augments its own slot via `declare module "@agentick/spec-next"`. `@agentick/reconciler-react-next` has NO dependency on any harness package and is a true leaf — its snapshot/restore iterates `Object.entries(bridges)` generically via `SnapshotCapable` feature-detection (no hardcoded slot names). **Hooks and components relocated:** `useKnob` + `<Knobs>` → `@agentick/knobs-next/react`, `useTimeline` + `<Timeline>` + `compactEntries` → `@agentick/timeline-next/react`, `useSessionState` → `@agentick/state-next/react`. Each harness's `/react/index.ts` does `import "../augment.js"` to register its slot. **Per-harness `/testing` subpaths** house the real `stubXHarness` factories. **Integration tests relocated** to their harness packages (`@agentick/knobs-next/__tests__/integration-with-reconciler.spec.tsx`, etc.); cross-harness snapshot tests moved to `@agentick/session-next`. Reconciler-react's tests use mock-protocol bridges where needed (the `mockTimelineHarness` / `mockKnobsHarness` / `mockStateHarness` in `reconciler-react/src/bridges/stub-bridges.ts`). **Real cycle break achieved** — turbo no longer detects any workspace cycle; any future harness can add a `/react` subpath without architectural risk. ADR 27 doc + REFACTOR-SCRATCHPAD.md document the journey; CLAUDE.md carries the principles as foundational. 5501 workspace tests green (5312 + 189 tui).

**Previously, 2026-05-26 (earlier):** ADR 26 Step 5a follow-up: **post-migration cruft cleanup** + **pending-messages on TimelineHarness**. **Cleanup pass** (commit `94a2d0c1`): rewrote `packages/spec/src/__tests__/reconciler-protocol.spec.ts` to drop dead `KnobBridge`/`TimelineBridge`/`TimelineSnapshot`-old type imports + their test sections (only passing because vitest's esbuild strips types — broken at the type level); retargeted 6 comment-rot sites referring to retired `KnobBridge`/`TimelineBridge`/`StateBridge` interfaces (`example/v2/substrate.ts`, `spec/protocol/session-harness.ts`, `spec/data/reconciler-snapshot.ts`, `sandbox/v2/acl.ts`, `knobs/harness.ts`, `reconciler-react/harness/reconciler-harness.ts`); tightened extension factory docs (`withTimeline`/`withKnobs`/`withState`) from "compiles but not yet invoked" v1→v2 leftover wording to explicit "ADR 26 Step 8 — pending" planning notes. Left alone: session/app inbox dispatch "not yet wired" stubs (legit deferred work) and v1 ↔ v2 `TimelineEntry` namespace collision (Phase 6 sunset territory). **Pending-messages** (this commit): added the **third tier** to TimelineHarness — pending queue alongside log and projection, mirroring v1's `_queuedMessages` / `ExecutionMessage` pattern. New protocol surface: sync `readPending(): readonly PendingEntry[]`; async `queue(input): Promise<{id}>` (pushes pending, no log/projection write; returns stable id) and `drain(): Promise<{entries}>` (moves pending → log + projection via per-entry `appendEffect` calls, returns drained entries). `subscribe` is one signal — fires on either projection OR pending change. `appendEffect` is a new private Effect-native variant of `append` so `drain`'s inner calls compose within the same Effect fiber and the substrate's FiberRef-based parent auto-threading lands `parentOpId` on every append envelope (Step 3.5 capability exercised at scale). Inbox-addressable at `"timeline:queue"` and `"timeline:drain"`. **Session integration:** `SessionHarness.queue()` and `SessionHarness.sendBody`'s input-messages loop now route user-input through `bridges.timeline.queue()` instead of direct append; `sendBody` drains pending into the durable timeline at the start of every execution before the first tick. Per-tick mid-execution drain deferred (Step 6+). New `queueInputMessage` helper supersedes the old `appendInputMessage`. 5344 workspace tests green (+18 from new pending conformance + unit tests covering envelope emission, parent-causality, inbox routing, interleave with append, metadata preservation); 2 pre-existing `executor-ai-sdk/msw` failures unchanged.

**Previously, 2026-05-24:** ADR 26 Step 5a: TimelineHarness extraction with two-tier (log + projection) model. New private workspace package `@agentick/timeline-next` housing `TimelineHarness extends BaseHarness<"timeline">`. **Two-tier storage:** `persisted` is an append-only durable log (the system of record for "what happened"); `projection` is the materialized view consumers read (`useTimeline`, formatter). Normally a live mirror; after `compact`/`replaceProjection`/`resetProjection`, can diverge. This is event-sourcing + CQRS in CS terms — direct prior art is Greg Young's CQRS, LSM/WAL + compaction, git's object-db vs working-tree split. The novel piece is that the projection function is non-deterministic (LLM-driven) with strategy metadata recorded on the snapshot for replayable rehydrate. **Protocol:** sync `read`/`subscribe` (projection-level) + `readPersisted` (log); async Operations `append` (writes to both), `compact(strategy)` (rewrites projection only), `replaceProjection` (overwrite), `resetProjection` (rebuild as mirror); `exportSnapshot`/`importSnapshot` with three modes ("as-is" / "persisted-only" / "rehydrate" — rehydrate requires a strategy). **Compaction strategy** is an opaque object built by factories (`withHandler` ships in 5a; `withModel` + `withApp` deferred to 5b). Strategy.metadata is preserved on the snapshot's `lastCompaction` for snapshot fidelity. **Storage migration:** `SessionStateStore._timeline`/`_timelineVersion` removed; SessionHarness constructs TimelineHarness via session-bridges with the session's substrate (`timeline:{sessionId}:timeline`); `applyExecutorResult`/`applyToolResults`/`appendEntry` are now async paths that await `bridges.timeline.append`; `SessionHarness.timeline()` returns the projection; `SessionHarness.snapshot()` carries the persisted log (Step 6 will compose per-harness snapshots into the SessionSnapshot shape). **Reconciler-react:** `useTimeline` reads the projection unchanged; `<Timeline>` + `compactEntries` migrated to consume the full `TimelineEntry[]` (kind-discriminated) — `TimelineEntrySummary` retired, components filter `kind === "message"` directly. `TimelineBridge`/`TimelineSnapshot` (old shape)/`TimelineEntrySummary` deleted from spec. `stubTimelineBridge` → `stubTimelineHarness(initial?: TimelineEntry[])`; old `runTimelineBridgeConformance` retired in favor of `runTimelineHarnessConformance`. **Session bridge close hygiene:** SessionHarness.close iterates over every bridge with a `close()` method (built-ins + extension-installed) and shuts them all down — not a hardcoded triple. Inbox-addressable: `"timeline:append"`, `"timeline:replaceProjection"`, `"timeline:resetProjection"` (compact is NOT inbox-addressable because the strategy carries a function reference; cross-process compaction would route through a higher-level surface). 5328 workspace tests green (+43 from new timeline harness + conformance + migrated tests); 2 pre-existing `executor-ai-sdk/msw` failures unchanged.

**Previously, 2026-05-23 (later):** ADR 26 Steps 3.5 + 4: parentOpId envelope projection + gates package extraction. **Step 3.5:** Added `parentOpId?: string` to `EventEnvelope`; `BaseHarness.makeEvent` projects `op.parentOpId` onto every emitted envelope. The substrate already auto-threaded parentOpId via the `RuntimeContext` FiberRef + stamped it on the Operation/OTel span — this surfaces it on the bus stream so subscribers see the causality tree without inspecting spans. New plumbing test (`packages/runtime/src/__tests__/harness-plumbing.spec.ts`) proves Effect-native nested `runOperation` auto-threads parentOpId onto every child envelope phase. Known gap (documented in the existing Promise-bridged parent/child test): when a parent's body crosses `Effect.promise(() => child.set())`, the child's fresh fiber doesn't inherit the parent's FiberRef and auto-propagation is lost; Promise-bridged composition must thread parentOpId explicitly. Effect-native composition (canonical shape) propagates automatically. **Step 4:** Extracted gates to new private workspace package `@agentick/gates-next` — `useGate` + `gate()` descriptor + `GateDescriptor`/`GateState`/`GateValue` types moved from `reconciler-react/react/hooks/use-gate.ts`. Gates is NOT a harness; gates have no independent state — the gate's value IS a knob value (a three-state `inactive`/`active`/`deferred` knob in the "gates" group). Pure hook composition over `@agentick/knobs-next` + reconciler-react's `useKnob`/`useLoopControl`/`useOnTickEnd`. The "seven harnesses" list stays at seven — gates is a _pattern_ over knobs, not a primitive. `useGate`/`gate` removed from reconciler-react's package index; `UseKnobOptions` type now re-exported from reconciler-react's index for cross-package consumption. 9 gate tests moved + green; 5285 workspace tests pass; 2 pre-existing `executor-ai-sdk/msw` failures unchanged.

**Previously, 2026-05-23:** ADR 26 Step 3a — StateHarness extraction. New private workspace package `@agentick/state-next` housing `StateHarness extends BaseHarness<"state">` — the "adopter stash" backing `useSessionState`. Sync `get/has/list/subscribe/subscribeAll` + async `set/delete` through `runOperation`; inbox-addressable at `state:{scopeId}`; `exportSnapshot`/`importSnapshot` for hibernate/restore; conformance suite (`runStateHarnessConformance`) covering envelope flow + inbox routing + snapshot round-trip. `StateHarnessProtocol` added to `@agentick/spec-next/protocol/state-harness.ts`; `StateBridge` interface deleted from `hook-bridges.ts`; `HookBridges.state` now typed as `StateHarnessProtocol`. Session-bridges (`@agentick/session-next/src/session-bridges.ts`) constructs `new StateHarness(${store.id}:state, journal, bus, inbox)` with the session's substrate. `useSessionState` in reconciler-react uses async fire-and-forget + `getSnapshot` fallback to `initial` (mirrors the useKnob pattern from Step 2.5). `inMemoryStateBridge` deleted from reconciler-react (replaced by `stubStateHarness()` factory). Step 3b (compose KnobsHarness on StateHarness) **abandoned** — composition layers conceptually right but costs (different listener semantics, different envelope surface, nested-Operation orchestration) outweigh the ~50 LOC of shared Map boilerplate; kept as parallel implementations following the same pattern. 5284 workspace tests green (16 new state tests); 2 pre-existing `executor-ai-sdk/msw` failures unchanged.

**Previously, 2026-05-22:** ADR 26 Steps 1, 1.5, 2, 2.5 — Extension protocol + KnobsHarness extraction + dead-code cleanup. Reshaped `@agentick/spec-next`'s extension types to a discriminated union by `target` (`AppExtension | SessionExtension`, open via `(string & {})`); per-host installer interfaces (`AppInstaller` / `SessionInstaller`) with minimal surface (`hostId`, `substrate`, `registerNamespace`, `getNamespace`, `onClose`); `AppExtensions` / `SessionExtensions` augmentation slots. AppHarness adopts new shape: `extensions` accepts `Extension[]`, filters by target, `registerBridge` → `registerNamespace`, `uninstall` retired in favor of `installer.onClose(handler)`. Step 1.5 harness-plumbing test graph in `@agentick/runtime-next/__tests__/` proves substrate primitives via toy harnesses (12 tests). `MessageEnvelopeInput<T>` cleanup: inbox.send/ask take an input type; inbox stamps `addressedTo`/`timestamp`/`messageId(ULID)`. Step 2 extracts `@agentick/knobs-next` private workspace package with `KnobsHarness extends BaseHarness<"knobs">` — sync get/has/list/subscribe/subscribeAll + async set/register/dispatch through `runOperation`; inbox-addressable at `knobs:{scopeId}`; full v1 set_knob validation pipeline lives in dispatch; conformance suite. Step 2.5 (this commit) wires KnobsHarness into core SessionHarness as a default required surface — session-bridges constructs the harness with the session's substrate; useKnob in reconciler-react uses async fire-and-forget + `getSnapshot` fallback to `initial`; `<Knobs/>` set_knob tool delegates to `harness.dispatch()` directly; `KnobBridge` interface deleted from spec; `inMemoryKnobBridge` deleted from reconciler-react (replaced by `stubKnobsHarness()` factory); old `runKnobBridgeConformance` retired. 5267 workspace tests green; 2 pre-existing `executor-ai-sdk/msw` failures unchanged. Open: bus subscribe is lazy via Stream — caller-side race (subscribe-then-publish drops events) requires `setImmediate` workaround in tests. Effect-idiomatic fix: reshape `bus.subscribe(filter)` to return `Effect<Stream<...>>` so acquisition registers the subscriber eagerly; remote late-joiner replay via `PubSub.sliding(N)` when cluster substrate lands. Tracked but not blocking; revisit alongside L5/L6 substrate scalability.

**Previously, 2026-05-21:** Component port batch — `<Timeline>`, `<Message>`, `<Section>`, `useGate`/`gate()`, `useKnob` descriptor extension, `<Knobs/>`. Timeline reads via `useTimeline()`/`TimelineBridge`; default render is `<Message {...entry} />` (the contributor's new `content` prop takes spec-shape `ContentBlock[]` verbatim, v1 precedence: non-empty prop wins, else children). `<content blocks=…>` passthrough intrinsic kept for niches `<Message>`'s content prop can't serve (cross-container injection in `<section>`/`<ephemeral>`/etc., mixed authored+pre-built compositions). Token-budget compaction (`maxTokens`/`strategy`/`headroom`/`preserveRoles`/`guidance` with truncate + sliding-window + custom-function escape hatch). `useGate` + `gate()` ported as knob-backed continuation conditions — composes `useKnob` + `useOnTickEnd` + `useLoopControl`; auto-renders `<Section>` with instructions only while active. KnobBridge spec extended with `register(id, descriptor)` + `subscribeAll(listener)`; `KnobDescriptor`/`KnobRegistration` carry v1's full surface (description, valueType, group, options, min/max/step, maxLength/pattern, required, momentary, inline, validate, schema — `validate` is a function ref, non-serializable, dropped by cross-process bridges). `useKnob(id, initial, options?)` accepts the full descriptor surface; two-phase init (synchronous `set` seed + deferred `register` in `useEffect`) avoids setState-in-render. Momentary resets at execution-end via `useOnExecutionEnd`. `<Knobs/>` ships default + render-prop + `Knobs.Provider`/`Knobs.Controls`/`useKnobsContext` modes; emits `set_knob` tool via `createTool` with `use()` capturing the bridge; v1's validation pipeline (exactly-one(name,group) → exists → type → options → bounds → length/pattern → custom validate); atomic group dispatch with type-mismatch detection. `InMemoryKnobBridge.list()` and `stubTimelineBridge.read()` now cache snapshot refs between mutations — without it `useSyncExternalStore` infinite-loops (recurring v2 gotcha worth a spec note). Dropped from v1: `Timeline.Provider`/`Timeline.Messages`, `useConversationHistory`, pending/queued message rendering (deferred until a v2 queued-messages bridge surface exists). Deliberately NOT ported yet: `<Ephemeral>`/`<Grounding>` — only consumer in v1 was gates' auto-render, replaced with `<Section>`; real interleave/role-mapping value depends on richer `TargetCapabilities` than v2 has today. 829 workspace tests green; 43 KnobBridge conformance tests (was 37).)

This is the **running progress log** for v2 implementation. Update it
every session. New contributors / sessions read this first.

Related docs:

- [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md) — overall phasing,
  exit criteria, risk register
- [`blueprint/`](./blueprint/) — architectural contracts (~24 docs)
- [`blueprint/17-open-questions.md`](./blueprint/17-open-questions.md) —
  unresolved design decisions

## Current state

```
Phase 0  ■ in progress — workspace setup
  ✓ Spec + spec-conformance packages scaffolded (committed)
  ✓ Nomenclature rename pass (compiler→reconciler, renderer→formatter,
    CompiledStructure→RenderedTree, useContinuation→useLoopControl)
  ✗ Package renames (still pending decisions — defer to convenience)
  ✗ Website / typedoc updates (deferred to end of Phase 0)

Phase 1  ■ in progress — spec package type population
  ✓ Foundation-critical types (envelopes, outcomes, errors, policy)
  ✓ Substrate protocol interfaces (journal, bus, inbox)
  ✓ Reconciler-related wire types (RenderedTree, ContextSpec,
    MessageEntry, SectionEntry, ContentBlock, SemanticNode,
    FormatterRef, FormatInput/Result, RuntimeDeclarations, etc.)
    — landed 2026-05-15, unblocks Phase 3
  ✓ Executor wire types (ExecutionResult, ExecutorTerminal,
    LanguageModelExecutionResult, ExecutionTarget) — landed 2026-05-15
  ✗ Channels, Timeline, Knobs, ReconcilerSnapshot, SessionRecord
    (later phases)

Phase 2  ✓ in-memory substrate — MemoryJournal, LocalEventBus,
         LocalInbox, BaseHarness implemented in @agentick/runtime.
         Effect-native protocols (Effect<R,E,never> / Stream<E,F,never>);
         FiberRef-based RuntimeContext substrate; conformance suites
         populated for journal + bus + inbox; 4953 workspace tests green;
         full workspace typecheck clean.
Phase 3  ■ in progress — RECONCILER HARNESS
         ✓ 3.1 ReconcilerProtocol + I/O + errors + inbox messages
         ✓ 3.2 ReconcilerSnapshot + diagnostics
         ✓ 3.3 HookBridges (DataBridge no-Suspense contract)
         ✓ 3.4 @agentick/reconciler-react-next package scaffold
         ✓ 3.5 host layer (HostInstance / HostScope / Container)
         ✓ 3.6 host-config + react-reconciler init (React 19)
         ✓ 3.7 Contributor protocol + IRFragment + ContributorRegistry
         ✓ 3.8 Built-in contributors (section/message/tool/resource/
               output/mcp/model)
         ✓ 3.9 collect walker + foldFragments → RenderedTree
         ✓ 3.10a ReconcilerHarness BaseHarness subclass
         ✓ 3.10b InMemoryDataBridge + stub bridges
         ✓ 3.10c render-until-stable loop (no-Suspense useData async path)
         ✓ 3.11 BridgeContext + 5 hooks (useData/useKnob/useTimeline/
               useLoopControl/useSession)
         ✓ 3.12 Lifecycle hooks + tick-start catch-up (useOnTickStart/End,
               useOnExecutionStart/End, useOnError, useOnMount/Unmount)
         ✓ 3.13 Formatter scope providers (FormatScope + Markdown/XML/PlainText)
         ✓ 3.14 runReconcilerConformance + bridge conformance suites
         ✗ 3.15 Snapshot/restore concrete impls (hook state capture)
Phase 4  ■ in progress — REMAINING HARNESSES
         ✓ 4a.1 ToolExecutorProtocol + I/O + errors + inbox + lifecycle (spec)
         ✓ 4a.2 runToolExecutorConformance + FixtureToolSpec
         ✓ 4a.3 @agentick/tool-executor-next package scaffold
         ✓ 4a.4 Harness skeleton + registry + handler resolver + validators +
                dispatch happy path + abort + handler errors + timeout.
                53/53 tool-executor tests; 16/16 conformance pass against
                the reference impl. (Lifecycle event emission, confirmation
                flow, middleware are deferred to 4a.5+.)
         ✗ 4a.5 Confirmation flow + framework channel
         ✗ 4a.6 Middleware + lifecycle handler hooks
         ✗ 4a.7 Inbox dispatcher (abort + confirmation-response)
         ✗ 4a.8 v1 tool tests port + parity sweep
         ✓ 4b.1 ExecutorProtocol + LanguageModelExecutor spec types
         ✓ 4b.2 runExecutorConformance suite
         ✓ 4b.3 @agentick/model-executor-next package + MockLanguageModelExecutor
                reference impl (12/12 tests; 6 conformance + 6 impl-specific)
         ✓ 4b.4 example/v2 executor scenario — JSX → RenderedTree →
                executor.run → streaming deltas → ExecutionResult
         ■ 4c   Provider adapters
                ✓ 4c.1 @agentick/executor-openai-next package scaffold
                ✓ 4c.2 OpenAIExecutor extends BaseHarness<"executor">
                       implements LanguageModelExecutor (project/execute/
                       normalize/run/abort). Promise-typed surface via
                       runHarnessProtocol; per-tick opId composition;
                       SDK injection point for tests.
                ✓ 4c.3 tool-use round-trip + streaming deltas
                       (StreamAccumulator reconstructs ChatCompletion from
                       chunks; emitDeltaLazy per chunk via Effect-driven
                       iterator drive; finish_reason → stopReason map).
                ✓ 4c.4 stub-client tests (8 OpenAI-specific: non-streaming,
                       model id passthrough, finish_reason mapping, tool
                       extraction, tool_result threading, abort, streaming
                       deltas, journaled lifecycle)
                ✓ 4c.5 runExecutorConformance against OpenAIExecutor
                       (6/6 pass — identical contract to mock)
                ✗ 4c.6 Anthropic, Google, AI SDK adapters
                ✗ 4c.7 example/v2 wired through real provider (deferred
                       — no API key in CI)
         ✓ 4d.1 LoopExecutorProtocol + StateApplicator spec types
         ✓ 4d.2 runLoopExecutorConformance suite (5 scenarios:
                happy path, applyExecutorResult call count,
                tool-call round-trip, max ticks, abort no-op)
         ✓ 4d.3 @agentick/loop-executor-next package +
                LoopExecutorHarness + NoopStateApplicator
                (5/5 conformance tests pass against reference impl)
         ✓ 4d.4 example/v2 loop scenario — multi-tick agent loop:
                tick 1 returns tool_use → loop dispatches calculator
                → tick 2 returns final text → terminal "end". Streaming
                deltas observed on the bus. 2 ticks, 1 tool dispatch.
         ✓ 4e.1 SessionHarnessProtocol spec types (minimum surface:
                send, close, timeline, snapshot, StateApplicator
                methods, notifyLifecycle). SessionMessage, TimelineEntry,
                SendInput, SendResult, SessionExecutionHandle,
                SessionSnapshot, SessionError taxonomy.
         ✗ 4e.2 runSessionConformance suite (deferred — impl proven
                via example end-to-end)
         ✓ 4e.3 @agentick/session-next package + SessionHarness:
                  - SessionStateStore — in-memory timeline + status +
                    usage + listeners
                  - session-bridges — HookBridges backed by session
                    state (TimelineBridge reads accumulated timeline,
                    KnobBridge in-memory)
                  - session-execution-handle — AsyncIterable + .result
                    dual-shape handle
                  - SessionHarness — owns mount, implements
                    StateApplicator (real timeline writes), delegates
                    send() to LoopExecutorHarness
         ✓ 4e.4 example/v2 session.send({ messages }) — end-to-end:
                user message → render → executor → tool_use →
                dispatch calculator → timeline append (assistant +
                tool result) → render → executor returns final text →
                stopReason "end". 2 ticks, 1 tool dispatch, timeline
                with 4 entries.
         ■ 4f   App harness
                ✓ 4f.1 AppHarnessProtocol spec types (createSession,
                       runOnce, getSession, listSessions, closeApp);
                       CreateSessionInput, RunOnceInput/Result,
                       SessionEntry, SessionFilter, AppError taxonomy.
                       Spec stays React-agnostic — construction options
                       live in the impl package.
                ✓ 4f.2 @agentick/app-next package + AppHarness:
                        - Shared substrate (journal/bus/inbox) + shared
                          sub-harnesses (reconciler, loop) — one
                          instance per app, reused by every session
                        - Per-session ToolExecutorHarness (so JSX-
                          declared tools don't bleed between sessions),
                          shared HandlerResolver
                        - In-memory SessionRegistry with metadata filter
                        - Promise-typed surface via runHarnessProtocol
                        - 6/6 smoke tests pass: createSession + send,
                          listSessions filter, duplicate-id reject,
                          runOnce ephemeral dispose, closeApp guard,
                          direct constructor variant
                ✓ 4f.3 example/v2 scenarioAppHarness — createApp(<Agent />,
                       opts) → runOnce + createSession + listSessions
                       + closeApp end-to-end. Verifies the ergonomic
                       surface wraps everything below.
                ✓ 4f.4 RECONCILER-AGNOSTIC TYPING — session/app types
                       changed from `ReactNode` to `unknown`. The spec
                       was already renderer-agnostic
                       (`MountInput.element: unknown`); the impls had
                       drifted. React/Angular/etc. reconcilers all
                       satisfy the contract with no app/session change.
                ✓ 4f.5 SLOT-PATTERN CONFIG CASCADE — every parent
                       harness's options now accept child slots as
                       either a pre-built instance OR an options bag
                       for the default impl. CSS shorthand/longhand
                       semantics: per-call > app-level longhand
                       (`session.defaultMaxTicks`) > app-level shorthand
                       (`defaultMaxTicks`) > framework default.
                         - AppHarnessOptions.reconciler: instance | opts
                         - AppHarnessOptions.loop: instance only (no
                           opts on LoopExecutorHarness today)
                         - AppHarnessOptions.tools: per-session
                           ToolExecutor defaults
                         - AppHarnessOptions.session: per-session
                           SessionHarness defaults
                       Duck-typed slot resolution (`mount()` discriminator
                       for reconciler). Same leak fixed on SessionHarness:
                       `reconciler`/`loop` are now ReconcilerProtocol /
                       LoopExecutorProtocol (was concrete classes).
                ✓ 4f.6a app.events(filter?) cross-session subscription —
                       AsyncIterable<ProtocolEvent> over the app's bus.
                       Filter via EventQuery. Multi-subscriber; clean
                       cleanup on break-out via Fiber.interrupt.
                       3 tests pass (filter, multi-sub, close).
                       NOTE: caller-supplied executor must share the
                       app's substrate (journal/bus/inbox) to appear in
                       app.events(). When the executor is constructed
                       with its own substrate, its events stay private
                       — a feature for isolation, a footgun for naive
                       use. Slot-pattern for executor (instance | opts
                       so app constructs with its own substrate) is a
                       future ergonomics fix; documented in the test
                       helper for now.
                ✗ 4f.6b use() integrations (interceptors + observers
                        + services registry)
                ✗ 4f.7 persistence + telemetry Layer slots
Phase 5  □ Adapters, cluster, gateway
Phase 6  □ v1 sunset
```

## Known loose ends (track-but-not-blocking)

Captured 2026-05-15 so these don't fall off the radar while we move on.
Most are addressed later — none of them gate the next priority
(conformance suites, 3.14). Listed here so any later session can pick
up the right one.

### Stubs / placeholders to flesh out

- ~~renderToString / renderResource return spec-shaped empty payloads~~
  ✓ renderToString implemented 2026-05-15 with default markdown/xml/text
  serializer. renderResource dropped — over-specified; resource content
  resolution is the runtime/MCP layer's concern via `handlerRef`.
- **Snapshot/restore hook-state capture**. `ReconcilerSnapshot.hookStates`
  is always empty, `dataCache` always empty. Hibernate-and-resume is
  shape-conformant but doesn't preserve component state yet.
- ~~strictNoSuspense plumbing~~ DROPPED 2026-05-15. Suspense firing
  cannot be reliably detected via react-reconciler 0.33's host config
  callbacks. Tried fetch-count heuristic (false positives/negatives),
  static element-tree scan (misses dynamic Suspense), and
  outer-Suspense sentinel (detection works but inner user-Suspense's
  unwrap-on-resolve doesn't fire with LegacyRoot, leaving fallback
  stuck in IR). Removed from spec.
- ✓ **Suspense warning heuristic** added 2026-05-15.
  `ReconcilerHarness.maybeWarnSuspense` scans the input element tree
  for `React.Suspense` at mount + rerender; emits a one-shot
  `console.warn` per mount. Static scan — Suspense returned from a
  function component is still invisible. Catches the common case
  (user wraps their JSX in `<Suspense>`) and gives a clear pointer to
  the "no-Suspense DataBridge contract" rather than silently rendering
  fallbacks into the model context. Tests in
  `boundary-diagnostics.spec.tsx`.
- ✓ **ErrorBoundary detection** — `error-boundary-active` info
  diagnostic emits via host config `onCaughtError`. Landed 2026-05-15.
- ✓ **Custom lifecycle event dispatch** — `LifecycleStore.registerCustom`
  - `useOnLifecycleCustom(kind, handler)` hook land 2026-05-15. Dispatching
    a custom kind with no registered handler emits a one-shot
    `console.warn` per kind so typos surface instead of being silently
    dropped. Tests in `lifecycle.spec.tsx`.

### Spec gaps

- **`@agentick/spec-next/guards`** — directory exists, stubs only. Type guards
  for runtime validation (isTextBlock, isSection, isToolDeclaration, etc.)
- **`@agentick/spec-validator`** — referenced in pluggability charter
  for opt-in JSON-Schema runtime validation; package doesn't exist.
- **Phantom-type Operation inference (`__r`, `__e`)** — never validated.
- **Idempotency conflict semantics** — same opId, different input is
  currently silent first-wins. Charter says we'll add detection "if a
  real case demands it"; no diagnostic yet.

### Tests deferred

- **max-iterations diagnostic test** — TODO comment in hooks.spec.tsx.
  Need a controlled DataBridge fixture that fakes pending without
  actually throwing.
- **Concurrent features no-op verification** — useTransition /
  useDeferredValue documented as no-op; not tested.
- **Wire-compat round-trip** — pluggability charter rule #7 asserted in
  docstrings but not exercised. Add a smoke test that
  `JSON.parse(JSON.stringify(renderedTree))` recovers an equivalent
  value.
- **Hibernate/restore round-trip** — even with empty hookStates,
  snapshot → JSON → restore → renderTree should produce equivalent IR.
- **findOrphaned semantics for non-memory journals** — protocol doesn't
  specify index requirements; concrete durable impls will surface this.

### Integration gaps

- ✓ **react-devtools bridge** — ported to
  `@agentick/reconciler-react-next/react/devtools-bridge.ts`. Each
  `createReconciler()` auto-injects into DevTools via
  `injectIntoDevTools` (no per-mount opt-in). Call
  `enableReactDevTools({ host?, port? })` once at startup to connect to
  the standalone DevTools app — returns a typed outcome
  (`connected`/`already-connected`/`not-installed`/`failed`) instead of
  console-warning side effects. `react-devtools-core` is loaded via
  dynamic import (not a declared peer dep — install yourself when
  needed). Landed 2026-05-15.
- ✓ **Content-block intrinsics** — all 14 content-block contributors
  (`text`/`image`/`code`/`json`/`document`/`audio`/`video`/`reasoning`/
  `csv`/`html`/`xml`/`user_action`/`system_event`/`state_change`/
  `custom`) are registered in `createBuiltInRegistry()`.
  `messageContributor` folds them into `MessageEntry.content` via
  `ctx.collectContentBlocks()`; 15 tests in `content-blocks.spec.tsx`.
  Landed 2026-05-15 (the line that used to live here was stale).
- **Semantic HTML intrinsics** — `<strong>`, `<em>`, `<ul>`, etc. v1 has
  them; v2 design says they're a formatter concern (formatter harness
  consumes SemanticNode tree). Not wired.
- ✓ **`format` JSX intrinsic typing** — confirmed as intentional. The
  `format` intrinsic is INTERNAL; `<FormatScope>` / `<Markdown>` /
  `<XML>` / `<PlainText>` are the only typed entry points and they all
  funnel through one `internalIntrinsic()` helper that owns the unavoidable
  cast. Wider IntrinsicElements augmentation for `<section>` /
  `<message>` / `<text>` / etc. is a Phase-4-or-later concern — v2
  test code uses `React.createElement(...)` for intrinsics by design.
  Updated 2026-05-15.
- **Long-lived primitives** (`<Cron>` / `<Webhook>` / `<EventListener>`)
  — declared via SubscriptionIntent in the snapshot; no JSX components
  yet.

### Performance / observability

These are **gating items for Phase 4c (executor)** unless flagged
otherwise. Tracked in `blueprint/17-open-questions.md` §Substrate
scalability + observability.

- ~~**L5 — OTel exception recording without breaking error-reference
  identity.**~~ ✓ decided 2026-05-18. Restored standard `Effect.withSpan`
  (was side-channel). Empirical finding: only the _outer_ failure
  wrapper loses `===` identity; inner `.cause` Error references survive,
  all structural data (`_tag`, prototype chain, properties, stack)
  matches, and the recommended matchers (`instanceof`, `_tag` checks,
  `expect.objectContaining`) all work as adopters would expect. The
  narrow loss is acceptable in exchange for full OTel span hierarchy
  - exception recording. Substrate `annotateOperationSpan` documents
    the contract; see `blueprint/17-open-questions.md` §L5 investigation
    for findings + adopter patterns.
- ~~**L6 — Bus publish hot-path benchmark.**~~ ✓ landed 2026-05-17.
  Numbers in `blueprint/17-open-questions.md` §Benchmark results.
  Headline: lazy emission no-subs at 0.5 μs (12× speedup vs eager),
  bus.publish 1-sub at 6.0 μs (20% over target — acceptable),
  runOperation empty body at 46.8 μs (target revised from 10 μs →
  50 μs after Effect framework overhead measured).
- ~~**L7 — `MemoryJournal.appendedKeys` Set unbounded growth.**~~
  ✓ landed 2026-05-18. Eviction tied to the ring buffer's drop point —
  when an event drops, its (opId, phase) key is removed from
  `appendedKeys`, and `terminals` / `inFlight` are cleaned up
  accordingly. 14/14 journal tests pass; full workspace 5005/5005.
  MemoryJournal is explicitly non-durable; durable journals (sqlite,
  pg) implement dedup against their backing store and aren't affected.
- **L8 — Substrate self-instrumentation.** No metric surface for
  subscriberCount / journal size / inbox cache size / queue depth.
  How does a deployment know if the substrate is overloaded? Designed
  alongside L6.
- **Render-until-stable wallclock budget** — only iteration-bounded.
  A slow fetcher blocks the loop. We may want `awaitTimeoutMs` per
  iteration.

### Documentation gaps

- **Per-package API reference READMEs** — high-level pitch only. No
  user-facing component / hook reference for reconciler-react.
- **Flow diagrams in `15-flows/`** reference v1 vocabulary in places.

## Critical priority recalibration (2026-05-14)

**The reconciler is the most foundational piece of agentick.** Everything
connects to it; everything else is plumbing around it. Phase 3 in
`IMPLEMENTATION-PLAN.md` was originally the tool executor (chosen as
"simplest proof of substrate"). It is now the **reconciler harness**.

Rationale: if `BaseHarness` doesn't fit the foundational harness cleanly,
we need to know that before building six other harnesses on top. The
tool executor is peripheral; proving the substrate against it teaches
us little. Tool executor moves to Phase 4a.

This means Phase 3 lands more spec types in parallel (ContentBlock,
RenderedTree, MessageEntry, SemanticNode, FormatterRef, etc.) before
the reconciler harness can be implemented.

## What's done so far

### Architecture (locked)

- [`blueprint/`](./blueprint/) — 23 docs covering the five-surface
  harness model, foundation substrate (journal/bus/inbox/OTel),
  data model, every per-harness contract, flows, and packaging.
- Naming scheme locked: `compiler-*`, `client-*`, `server-*`,
  `executor-*`, `persistence-*`, `sandbox-*`.
- Foundation contract: `Operation`, `DiscreteEvent`, `ChannelEvent`,
  `MessageEnvelope`, `OperationJournal`, `EventBus`, `MessageInbox`,
  `BaseHarness` with five surfaces.

### Resolved open questions

From `17-open-questions.md`:

- **A10** `ReconcilerSnapshot` shape — locked 2026-05-08
- **A11** `StateApplicator` interface — locked 2026-05-08 (Pick of session)
- **F2** Handler verdict merge — locked 2026-05-08 (veto > replace > defer > proceed)
- **N5** Ingest mechanism — locked 2026-05-08 (hybrid: direct call +
  lifecycle handler chain)

### Code (Phase 0 morning, 2026-05-08, committed)

```
packages/spec/                                          ✓ scaffolded
  package.json                                          zero-dep, types-only
  tsconfig.json + tsconfig.build.json
  README.md
  src/version.ts                                        SPEC_VERSION
  src/index.ts
  src/data/                                             populated this session
  src/protocol/                                         populated this session
  src/guards/index.ts                                   stub

packages/spec-conformance/                              ✓ scaffolded (private: true)
  package.json                                          (same as before)
  src/{journal,inbox,harness,renderer}.ts               stubs (Phase 2+)

.changeset/config.json                                  ✓ @agentick/spec-next in fixed group
```

### Amendment — React feature semantics + notifyLifecycle (2026-05-15)

Pushback on the original Phase 3.1 framing landed two refinements:

1. **`notifyTickEnd` → `notifyLifecycle`.** Single command carrying a
   tagged `LifecycleEvent` union (`tick-start | tick-end |
execution-start | execution-end | error` + a namespaced `custom`
   escape hatch). Direct method-based coupling (synchronous, ordered)
   coexists with parallel event-bus emission (async, fan-out) — they
   answer different questions. Future lifecycle kinds don't add
   protocol methods.

2. **React feature semantics.** "Forbidden" was too strong. Revised:
   - `<Suspense>` — fallbacks DO appear in the IR if a boundary
     fires. Default behavior: emit `suspense-boundary-active` warning
     diagnostic. `MountInput.strictNoSuspense = true` upgrades to a
     terminal `RenderFailed`. The reconciler's outer Promise catch
     means `useData` does NOT trigger Suspense boundaries — only
     things React itself intercepts (e.g., `React.lazy`).
   - `<ErrorBoundary>` — supported. Catching a render error and
     rendering a fallback is a _good_ pattern (per-section
     resilience). Emits `error-boundary-active` info diagnostic.
   - `useTransition` / `useDeferredValue` — allowed; no effect in
     sync-render mode.

Diagnostic codes added: `suspense-boundary-active` (warning),
`error-boundary-active` (info).

Blueprint docs updated: `01-harness-principle.md`, `03-reconciler-harness.md`,
`05-loop-executor.md`, `08-session-harness.md`, `17-open-questions.md`,
`21-reconciler-implementation.md`, `IMPLEMENTATION-PLAN.md`.

Tests: 74/74 spec green (26 in reconciler-protocol.spec.ts with new
LifecycleEvent + strictNoSuspense + diagnostic coverage).
`pnpm -r typecheck` clean.

### Code (Phase 3.1–3.3 reconciler protocol contracts, 2026-05-15)

```
packages/spec/src/data/                                 ✓ snapshot + diagnostics
  reconciler-snapshot.ts  ReconcilerSnapshot, HookStateEntry,
                          DataCacheEntry, SubscriptionIntent,
                          ReconcileDiagnostic, ReconcileDiagnosticCode,
                          RenderToStringPayload

packages/spec/src/protocol/                             ✓ contracts
  hook-bridges.ts         HookBridges + DataBridge (no-Suspense),
                          KnobBridge, TimelineBridge, LoopBridge,
                          SessionBridge, Sandbox/MCP placeholders
  reconciler.ts           ReconcilerProtocol with mount/rerender/
                          renderTree/renderToString/renderResource/
                          notifyLifecycle/unmount/snapshot/restore.
                          notifyLifecycle carries tagged LifecycleEvent
                          union (tick-start | tick-end | execution-start |
                          execution-end | error). Direct-method coupling
                          coexists with bus-event fan-out — same moments,
                          different channels.
                          ReconcileError taxonomy (11 tags).
                          ReconcilerInboxMessage (recompile/unmount/
                          invalidate).

packages/spec/src/__tests__/
  reconciler-protocol.spec.ts                           23 new tests
                          - MountInput/Result, RenderTreeInput/Result
                          - RenderToString/Resource I/O
                          - Snapshot JSON round-trip
                          - ReconcileError taxonomy
                          - InboxMessage discrimination
                          - Diagnostic codes
                          - DataBridge no-Suspense semantics (cached
                            sync, pending throws Promise, failure
                            throws Error)
                          - Knob/Timeline/Loop/Session shapes
                          - ReconcilerProtocol method roster
```

**Design constraints baked into Phase 3.1:**

- **No Suspense.** `DataBridge.resolve` is the no-Suspense contract:
  cached value returns synchronously; pending throws an in-flight
  Promise (caught by the reconciler's render-until-stable loop, not
  by React `<Suspense>`); prior failure throws the underlying Error.
  `RenderedTree` never carries "loading" states.
- **JSON firewall.** `ReconcilerSnapshot` survives
  `JSON.parse(JSON.stringify(s))`. No functions, Dates, Maps, Sets.
- **Bridges, not globals.** Every runtime-supplied capability hook
  components need (timeline read, knob get/set, async data, loop
  control, session identity) goes through `HookBridges` passed at
  mount time. Module-level singletons are forbidden by contract.
- **`MountScopedInput` base.** Every operation that targets a mount
  carries `(mountId, opId?, correlationId?, parentOpId?)`. Phase
  contract + idempotency + causality come from `BaseHarness`.
- **Forward-compat strings.** `RenderPurpose`, `SessionStatus`,
  `HookType`, `ReconcileDiagnosticCode` are open string unions with
  named recognized values — new variants don't break older snapshots.

**Status check:**

- `pnpm vitest run packages/spec` — 71/71 green
- `pnpm -r typecheck` — all packages green
- Phase 3.4 (`@agentick/reconciler-react-next` scaffold) unblocked

### Code (Phase 2 in-memory substrate, 2026-05-15)

```
packages/runtime/                                       ✓ new package
  package.json                                          deps: @agentick/spec-next
                                                        devDeps: @agentick/spec-conformance-next
  tsconfig.json + tsconfig.build.json
  README.md
  src/index.ts                                          public exports
  src/substrate/
    ulid.ts                                             lex-sortable id gen
    query.ts                                            EventQuery matcher
                                                        (exact|prefix|segments|wildcard)
    memory-journal.ts                                   MemoryJournal
                                                        (ring buffer, idempotency map,
                                                         tail subscribers, findOrphaned,
                                                         bounded retention)
    local-event-bus.ts                                  LocalEventBus
                                                        (per-subscriber bounded buffer,
                                                         lazy fan-out, 3 overflow strategies)
    local-inbox.ts                                      LocalInbox
                                                        (address registry, messageId
                                                         idempotency cache w/ TTL,
                                                         tell + ask + timeout)
    base-harness.ts                                     BaseHarness, HandlerRegistry,
                                                        MiddlewareChain, mergeVerdict,
                                                        OperationOutcomeError
                                                        (5 surfaces wired; phase contract;
                                                         idempotent replay; verdict merge
                                                         veto > replace > defer > proceed;
                                                         JournalingPolicy honored;
                                                         override map with longest-prefix)
  src/__tests__/
    memory-journal.spec.ts                              conformance + capacity tests
    local-event-bus.spec.ts                             pub/sub + buffer + abort
    local-inbox.spec.ts                                 conformance
    base-harness.spec.ts                                phase contract, idempotency,
                                                        verdict merge, middleware
                                                        composition, inbox dispatch

packages/spec-conformance/                              ✓ bodies populated
  src/journal.ts                                        runJournalConformance
                                                        (append/read, idempotency, tail,
                                                         crash recovery)
  src/inbox.ts                                          runInboxConformance
                                                        (registration, tell, ask, timeout,
                                                         handler error, idempotency)
  src/harness.ts                                        DEFERRED to Phase 3
                                                        (needs a concrete harness driver)
  src/renderer.ts                                       DEFERRED to Phase 3
```

**Decisions baked in this session:**

- **Promise/AsyncIterable end-to-end.** No Effect in runtime yet. The
  blueprint reserves Effect for higher layers (Scope/Span integration);
  the in-memory substrate doesn't need it. If a real case demands
  cancellable Effects, we layer them in then.
  > **REVERSED 2026-05-15.** This decision contradicted `19-foundation.md`
  > as written and produced architectural drift. Substrate is now
  > Effect-native; see the dated entry above.
- **Idempotency dedup is per `(opId, phase)`, not per envelope id.** Same
  operation replaying the same phase is a no-op. Same opId in different
  phases is normal (requested → terminal).
- **`emit` returns Promise<void>** so concrete harnesses can await
  delivery. Discrete events still skip the `before` handler/middleware
  chain — they're light-path only.
- **`OperationOutcomeError`** is the runtime's signal for non-success
  terminals (failed | canceled | vetoed | deferred). `succeeded` and
  `replaced` return the result directly via the call.
- **Journaling override map** supports exact name OR longest-prefix
  matching. Lets harnesses tag noisy event families ("session:stream:")
  as `bus-only` without enumerating every leaf.
- **`runHarnessConformance` deferred to Phase 3.** It needs a concrete
  harness to drive; the runtime tests cover the BaseHarness contract in
  the meantime.

**Status check:**

- `pnpm vitest run packages/runtime packages/spec` — 82/82 green
  (24 prior spec + 23 phase-1c spec + 12 journal + 9 inbox + 4 bus + 9 base-harness + 1 version)
- `pnpm -r typecheck` — all packages green
- v1 packages unaffected

### Code (Phase 1c reconciler-facing wire types, 2026-05-15)

```
packages/spec/src/data/                                 ✓ wire types for Phase 3
  content-blocks.ts     ContentBlock taxonomy (21 variants), MediaSource,
                        role-scoped allow lists. `any` → `unknown`; enums
                        collapsed to string literal unions. Runtime helpers
                        stay in @agentick/shared.
  semantic.ts           SemanticNode (with rendererRef instead of function
                        ref), SemanticType, SemanticMetadata, FormattableBlock
  formatter.ts          FormatterRef, FormatterCapabilities, FormatInput,
                        FormatScope, FormatTrace, FormatDiagnostic,
                        FormatDiagnostics, FormattedContent, FormatResult
  entries.ts            CacheHint, MessageEntry, MessageMetadata,
                        SectionEntry, SectionMetadata, ContextEntry,
                        ContextSpec
  declarations.ts       ToolDeclaration, ToolExposure, ToolAnnotations,
                        ResourceDeclaration, OutputDeclaration,
                        MCPDeclaration, RuntimeDeclarations, JsonSchema
  rendered-tree.ts      RenderedTree, SpecConfig, ProviderOptions,
                        ResponseFormat, ModelSelection, SpecFeatureName
  execution-result.ts   UsageStats, ExecutionResult, ExecutorError,
                        ExecutorTerminal, LanguageModelStopReason,
                        ToolCall, LanguageModelExecutionResult,
                        ExecutorDelta
  execution-target.ts   ExecutionTarget, LanguageModelTarget,
                        TargetCapabilities
  index.ts              re-exports all of the above

packages/spec/src/__tests__/                            ✓ 48 tests passing
  rendered-tree.spec.ts (23 new tests: ContentBlock narrowing, SemanticNode,
                         Formatter protocol, ContextSpec entries,
                         RuntimeDeclarations, RenderedTree free-root,
                         ExecutorTerminal outcomes, ExecutionTarget)
```

**Decisions baked in this session:**

- **Function references can't cross the wire.** v1's
  `SemanticNode.formatter: Formatter` field becomes
  `rendererRef?: FormatterRef`. Formatter identity is data; behavior
  lives behind the formatter harness. `[V1-REPLACED]`.
- **Enums are runtime artifacts; spec is types-only.** v1's `BlockType`,
  `MessageRole`, `MediaSourceType`, MIME-type, and `CodeLanguage` enums
  collapse to string literal unions (with `(string & {})` escape hatch
  on open lists for ergonomics without losing literal autocomplete).
- **`readonly` everywhere on wire types.** The spec exposes shapes
  consumers MUST treat as immutable. Implementations construct fresh
  objects; downstream code reads.
- **`ExecutorTerminal` omits `deferred`.** `deferred` is a pre-execution
  handler verdict (the `before` phase), not a terminal outcome. The
  envelope carries the five values that actually terminate execution.
- **Runtime helpers stay in `@agentick/shared`.** Type guards
  (`isTextBlock`, `isToolUseBlock`, …) and base64 helpers depend on
  Node Buffer / browser fallbacks — those don't belong in zero-dep spec.

**Status check:**

- `pnpm -r typecheck` — all packages green
- `pnpm vitest run packages/spec` — 48/48 green (24 prior + 23 new + 1 version)
- v1 packages unaffected

### Code (Phase 1 foundation-critical types, 2026-05-11)

```
packages/spec/src/data/                                 ✓ all populated
  events.ts             EventEnvelope, ProtocolEvent, EventSurface,
                        EventPhase, EventScope, EventQuery, NameQuery
  outcomes.ts           CommandOutcome (6 values), HandlerVerdict,
                        TerminalEvent<R,E>, HandlerScope
  operations.ts         Operation<I,R,E>, DiscreteEvent, ChannelEvent<T>
  inbox.ts              MessageEnvelope<T>, MessageAck, MessageHandler
  errors.ts             JournalError, InboxError, MessageHandlerError
  journaling-policy.ts  JournalingPolicy + DEFAULT_JOURNALING_POLICY
  standard-schema.ts    Inlined StandardSchemaV1 (~30 LOC; zero-dep preserved)
  index.ts              re-exports all of the above

packages/spec/src/protocol/                             ✓ substrate protocols
  journal.ts            OperationJournal (append, appendBatch, read, tail,
                        lookupTerminal, findOrphaned)
                        + OrphanedOperation, OrphanQuery, JournalReadFrom,
                          Maybe<T> sentinel
  bus.ts                EventBus (publish, subscribe)
                        + SubscribeOptions, BufferOverflowError
  inbox.ts              MessageInbox (register, send, ask)
                        + AskOptions, Unsubscribe
  index.ts              re-exports

packages/spec/src/__tests__/                            ✓ 25 tests passing
  version.spec.ts       (1 test, SPEC_VERSION format)
  types.spec.ts         (24 tests, structural smoke for every new type)
```

**Decisions baked in this session:**

- **Async return type in spec is `Promise<T>` / `AsyncIterable<T>`.** Not
  `Effect<T, E, R>`. This preserves spec's zero-dep claim and matches
  the blueprint's own pattern (compiler-react is Effect-free; the
  runtime bridges to Effect at the BaseHarness boundary). Errors are
  thrown/rejected, typed via JSDoc `@throws`. Implementations using
  Effect convert at their protocol boundary via
  `Effect.runPromise` / `Effect.tryPromise`.
- **Streaming uses `AsyncIterable<T>`** (TS-native) rather than Effect's
  `Stream`. Implementations adapt.
- **No `Option<T>`.** `OperationJournal.lookupTerminal` returns a plain
  discriminated union `Maybe<T> = { some: true; value: T } | { some: false }`.
- **Error shape is `{ _tag: ...; ... }` tagged unions** for runtime
  pattern matching. No exception class hierarchy.
- **Phantom type fields on `Operation<I, R, E>`** (`__r`, `__e`) are
  inference-only; not runtime properties.

**Status check:**

- `pnpm typecheck` — 55/55 green
- `pnpm vitest run packages/spec/src` — 25/25 green
- v1 packages unaffected

## What's next

### Immediate

Two parallel work streams can proceed now:

1. **Foundation substrate (Phase 2)** is **unblocked** — spec has the
   types and protocol interfaces needed to implement `MemoryJournal`,
   `LocalInbox`, `LocalEventBus`, and `BaseHarness`.

2. **Reconciler spec types (Phase 1 continuation)** can start in
   parallel — these are needed for Phase 3 (reconciler harness):
   - `ContentBlock` taxonomy + `MediaSource` (promote from
     `packages/shared/src/blocks.ts`)
   - `SemanticNode`, `SemanticType`, `SemanticMetadata` (promote from
     `packages/core/src/renderers/base.ts`)
   - `FormatterRef`, `FormatInput`, `FormatResult`, `FormattedContent`,
     `FormatScope`, `FormatTrace`
   - `RenderedTree`, `ContextSpec`, `MessageEntry`, `SectionEntry`
   - `RuntimeDeclarations`, `ToolDeclaration`, `OutputDeclaration`,
     `ResourceDeclaration`
   - `ReconcilerSnapshot` (per `03-reconciler-harness.md` §Snapshot rules)
   - `Message`, `MessageRoles` (promote from
     `packages/shared/src/messages.ts`)
   - `TimelineEntry` (promote from `packages/shared/src/timeline.ts`)
   - `UsageStats` (promote from `packages/shared/src/models.ts`)

Recommended order:

1. **Commit current state** (nomenclature rename + priority reorder).
2. **Promote reconciler spec types** (Phase 1 continuation). Mostly
   mechanical — move + re-export from `@agentick/shared` for transient
   compat.
3. **Start Phase 2 substrate** (`MemoryJournal`, `LocalInbox`,
   `LocalEventBus`, `BaseHarness`) — can happen in parallel with #2.
4. **Phase 3 — Reconciler harness** in `@agentick/reconciler-react-next`.
   Port v1 reconciler + JSX runtime + components + hooks. Implement
   `ReconcilerProtocol`. Prove the substrate against the foundational
   harness.

### Deferred (do later when needed)

These spec types are NOT needed for foundation substrate (Phase 2) or
the first harness (Phase 3). Promote them when the consuming harness
gets implemented:

- **Phase 4 prereqs** (compiler-react, executor adapters):
  - `ContentBlock` taxonomy (from `packages/shared/src/blocks.ts`)
  - `Message`, `MessageRoles` (from `packages/shared/src/messages.ts`)
  - `TimelineEntry` (from `packages/shared/src/timeline.ts`)
  - `ToolCall`, `ToolResult` (from `packages/shared/src/tools.ts`)
  - `UsageStats`, `ResponseFormat` (from `packages/shared/src/models.ts`)
  - `RenderedTree`, `ContextSpec`, `MessageEntry`, `SectionEntry`
  - `RuntimeDeclarations`, `ToolDeclaration`, `OutputDeclaration`
  - `SemanticNode`, `SemanticType`, `SemanticMetadata`
  - `FormatterRef`, `FormatInput`, `FormatResult`, `FormatScope`
  - `ExecutionResult`, `ExecutorTerminal`, `LanguageModelExecutionResult`
  - `ExecutionTarget`, `LanguageModelTarget`
  - `ExecutorDelta`
  - `ReconcilerSnapshot`
  - `SessionRecord`
  - `FrameworkChannels` (concrete channel payloads)

- **Higher-layer protocol interfaces** (promote when implementing the
  corresponding harness):
  - `ReconcilerProtocol` (Phase 4b)
  - `FormatterProtocol` (Phase 4a)
  - `ExecutorProtocol`, `LanguageModelExecutor` (Phase 4c)
  - `ToolExecutorProtocol` (Phase 3)
  - `LoopExecutorProtocol` (Phase 4d)
  - `SessionHarnessProtocol` (Phase 4e)
  - `AppHarnessProtocol` (Phase 4f)

### Pending decisions (carried from 2026-05-08, not yet blocking)

The rename pass on existing v1 packages is still pending decisions —
but it can happen at any time and doesn't block substrate work. Defer
until convenient. The four open questions:

### Pending decisions (from session 2026-05-08)

1. **`@agentick/server`** exists today, described as "channel routing,
   session handling, transport adapters." Action:
   - (a) Rename to `@agentick/gateway` (current gateway pkg is something else?)
   - (b) Keep as `@agentick/server` (separate from gateway?)
   - (c) Fold into runtime

2. **`packages/adapters/` has 7 packages** vs the 3 in the original
   rename list:

   ```
   ai-sdk          → @agentick/executor-ai-sdk-next     (in plan)
   anthropic       → @agentick/executor-anthropic-next  (not in plan)
   apple           → @agentick/executor-apple      (??)
   bedrock         → @agentick/executor-bedrock    (??)
   google          → @agentick/executor-google-next     (in plan)
   huggingface     → @agentick/executor-huggingface (??)
   openai          → @agentick/executor-openai-next     (in plan)
   ```

   Rename all 7? Defer some?

3. **Other v1 packages** — angular, cli, client-multiplexer, connector\*,
   guardrails, nestjs, scheduler, secrets, socket.io. Keep current
   names? Some renamed?

4. **`packages/agent/` and `packages/agentick/`** — which is the
   meta-package and what's the other?

## Environment quirks

### pnpm install requires explicit registry

Workspace has a Knowify CodeArtifact registry configured (`.npmrc`)
that intercepts unrelated package requests when its auth token is
expired. Two workarounds:

```bash
# Option 1: pass registry flag
pnpm install --registry=https://registry.npmjs.org/

# Option 2: refresh Knowify token
# (the team's standard token refresh procedure)
```

The `.npmrc` warning during pnpm runs about `${NPM_TOKEN}` failing to
replace is benign — comes from the workspace `.npmrc` template; not a
v2 concern.

### Vitest configuration is workspace-level

Don't add a per-package `"test": "vitest run"` script — vitest's
include glob `packages/*/src/**/*.spec.{ts,tsx}` is resolved relative
to the directory vitest is invoked from. Per-package `pnpm test` ends
up resolving to `packages/spec/packages/*/...` and finds nothing.

Run tests from workspace root:

```bash
pnpm vitest run packages/spec/src           # all spec tests
pnpm vitest run packages/spec/src/foo.spec.ts   # specific
```

### Day 1 morning fix applied

Originally `packages/spec/package.json` had `"test": "vitest run"` and
explicit `typescript` + `vitest` devDeps. Both removed:

- Test script removed (workspace runs tests from root)
- TypeScript + vitest provided by root devDeps

## Decision log

Running record of decisions made during execution (separate from the
blueprint's design decisions; this is execution-level).

### 2026-08-16 — emitter stamping, client-call op, ADR 102 draft (shipped next.125)

Three landings in one arc (#305, #306; cut 1.0.0-next.125):

- **Envelope stamping at the emitters (#304).** The three principal-unstamped
  emitters (`channel().publish`, channel snapshot, model deltas) now stamp;
  model deltas via `RunExecutionInput.principal → TickInput → modelScope` —
  the model packages stay principal-free, the scope arrives stamped. The
  probe established the rule: ops through `runOperation` inherit principal
  ambiently; the at-risk emitters are exactly those supplying an EXPLICIT
  scope. A fourth (`BaseHarness.request()` → elicitation request frames) is
  found and still open on #304.
- **User turns carry execution provenance.** Input messages appended from
  send are stamped with the `executionId` they open (same metadata slot as
  assistant/tool entries); steers stamp the live id. An open turn is now
  derivable from the log alone — the downstream `hasOpenTurn` scaffolding
  retires against this.
- **`tool:command:client-call` (#303, #306).** The `requiresResponse` client
  relay wraps in an operation so the suspension has both bus edges (elicit's
  exact shape); its opIds fold into the SAME blocked set, so a session
  waiting on a browser reads `input_required`. Ruling: no default timeout —
  a pending ask is a surfaced state, not a silent fallback. Plus `sessionId`
  on `ClientToolCall`/`ToolCtx`, memoized `client.session(id)` (destroy
  verbs release), per-dispatch ctx contributor via `ToolCtxExtensions`.
- **ADR 102 draft** — attachment is authorization; the bus tree is the scope
  model. Generalized at Ryan's direction: scope NODES (registry of path-named
  buses) with tenancy, session-tree/fanIn, operator views, and arena rooms as
  profiles over one primitive. Accepting it deletes `onlyOwnedBy`.
- Environment: website `pnpm build` fails on typedoc ENAMETOOLONG from a
  recursive `code ↔ code-host` node_modules nesting in transport-in-process —
  packages build green; docs-only, unresolved.

### 2026-08-15 — no installer telemetry verb; nudges are structural (deferred facet)

Follow-on to the ADR 78 inversion. Proposal considered: an
`installer.installTelemetry(...)` verb to nudge plugins toward registering
their telemetry. **Rejected** — it re-centralizes span identity the inversion
just moved into class-level `spanAttributes` overrides (install-time state for
a class-level fact), and an optional verb is omitted exactly as silently as an
un-overridden method, so it nudges nobody. The forgettable-and-catastrophic
step is INTERCEPTOR THREADING (ADR 93 landmine 11 — an extension harness that
doesn't spread `inheritedFrom(installer)` runs outside the whole app cascade,
telemetry middleware included). Nudges land structurally instead:

1. **`registerNamespace` tripwire** — detect a registered harness that didn't
   inherit the installer's cascade (dev warning → hard error once definitions
   advertise `hooks:`/`guards:` bags).
2. **Conformance telemetry rung** — shared rung in every `runXHarnessConformance`
   asserting ops carry `<ns>.*` identity attrs and flow through a parent cascade.
3. **DEFERRED: `installer.telemetry` read-side facet** — a tracer/meter/logger
   pre-scoped to the extension's namespace, for plugin code that is NOT a
   harness (connector polling loops, store adapters, sandbox providers) and
   today would reach for `@opentelemetry/api` globals. Nudges by existing; not
   a registration path. Waits for the first real non-harness consumer
   (React-style absorption — userland first).

Related trailhead already in code: `resultAttributes(op, result)` (symmetric
result-derived sibling of `spanAttributes`) — class-level, not installer-level.

### 2026-08-16 — session status is a projected fact (channel + seed + outcome + input_required)

9f49ec69b, shipped in 1.0.0-next.122. The reload bug (a refreshed chat panel
renders a running session as idle — the client SessionHandle had NO status
surface) closed by completing the enumerate/notify pair:
`session:channel:status` publishes one self-describing frame per transition
from `SessionRuntime.setStatus` (the field's sole writer, change-gated,
fire-and-forget), with a `ChannelSnapshotProvider` splicing the CURRENT status
in as frame one — channel rather than discrete event PRECISELY because only
`session:channel:*` names get the existing snapshot splice (the raceless
seed). Frame outcome rider (`succeeded`/`failed`/`aborted`, `runOutcomeOf`,
vetoed→failed) rides only the execution-end transition, passed as a setStatus
ARGUMENT (ambient context could stamp a stale outcome onto the next unrelated
transition). `input_required` joins `SessionStatus` as a first-class literal —
blocked-on-elicit/confirmation tracked via the elicit OPERATION's
requested/terminal pair (balanced on every exit; Set of opIds; both flips
status-guarded; end-beats-blocked) — NOT `paused`, reserved for the
blueprint's operator pause/resume. Consumption: `session.status` ChannelView
on the handle (value/view asymmetry documented), `create_session` answers
status (protocol gained the read), thread lists = list rows seed + ONE
gateway-scope `sessionStatusEventQuery()` subscription (zero new client API).
Ryan's ambient-tier doctrine recorded: bus hierarchy IS isolation
(global←tenant←user child buses, fan-in up, attach-down = scope; authorize
the attachment once — never per-event filters). Follow-ups: #297
(subscription attachment authorization), #298 (fake executor holdUntil
ignores abort). Knowify consumption (thread-list indicator, seen_at
watermark, panel serverBusy) in flight on the knowify side.

### 2026-08-16 — recovery is a conformance rung; two adapters were still coercing

A staging MALFORMED_FUNCTION_CALL incident (reproducible in-session,
clean in a fresh one — context-correlated, not dice) prompted an
end-to-end proof that the ADR 99 retry chain composes. It does:
zero production changes needed, pinned at the provider boundary
(exactly 2 calls, byte-identical requests, retryOfTick [--,1]). The
proof first landed WRONG twice — in packages/app with a leafward-
pointing devDep (Ryan: reject; inverted in-place), then as one
adapter's bespoke spec (Ryan: "how is this not a generalizable testing
pattern?"). Final form: `runRecoveryConformance` in spec-conformance
(ca5e904aa), dependency-inverted — the suite imports vitest + one spec
type; each adapter ships a ~30-line factory mapping an abstract
[malformed, ok] script to its provider's native failure shape; the
bespoke spec deleted. Wiring all four adapters found two live instances
of the slice-4a defect one layer up (644b1c897): anthropic coerced an
unparseable input_json_delta buffer to {} (now withholds the summary
delta so the accumulator raises); openai's normalizeImpl wrapped
garbage as { value } (now raises MalformedModelOutput). openai 4/4
both seams; anthropic streaming live, nonStreaming:false as a provider
fact (messages.create returns input server-parsed). Two review rules
now standing in session memory: dep edges never point leafward, and
family obligations ride the existing conformance vehicle. Remaining
recovery design item: guided retry (ephemeral corrective context on
the retry tick — blind identical retry provably loses to
context-correlated malformation).

### 2026-08-15 — failed ticks flow through the decide fold (ADR 99)

`blueprint/99-tick-failure-recovery.md`. Production incident: a malformed model
tool call killed the run (`executor_failed`, dead air, human "try again"). The
finding: **no new hook.** A failed executor terminal currently breaks out of the
loop BEFORE `notifyTickEnd`, so the failure is invisible to every continuation
authority that already exists — and `NotifyTickEndInput.outcome` anticipated
non-success ticks all along. Route the failed terminal through the decide fold;
because a failed tick persists nothing, **force-continue IS retry by
construction** (fresh tick, identical request, clean events). Abstain flips to
stop on failure (fail-safe), `maxConsecutiveFailedTicks` backstops, and the
bundled policy retries `MalformedModelOutput` once — a new `ExecuteError`
classified by adapters in their existing `mapProviderError`. Config is ONE
dual-form option (`tickFailurePolicy`, ADR 42 dichotomy): a retry-budget table
keyed by `ExecuteError["_tag"]` or the full predicate — the taxonomy IS the
config namespace, no `max<Mode>Retries` breeding. Rejected: a
transform-retry on `loop:tick` (re-enters the same tickId, hides the attempt,
competes with decide) and any `onTickFailure` lifecycle name (a third
authority). Two independent tool-path bugs ride along: the accumulator's silent
`{}` coercion of unparseable tool args (silently-wrong execution under
`permissiveValidator`), and failed dispatches persisting `content: []` so the
model gets an error with no body. The split: retry when there is nothing
coherent to show the model; feedback when there is. Status: wave 1 (slices 1, 4a, 4b)
LANDED — `MalformedModelOutput` + `isExecuteError` in spec, accumulator raises
at finalize instead of coercing to `{}` (executor finalize moved to
`Effect.try` so the raise reaches the typed channel), adapters classify via
`mapProviderError` with `defaultMapProviderError`/`defaultIsAbortError`
extracted so an adapter refines-then-delegates, `streamTerminal` passes typed
errors through, failed dispatches persist the error text.

Wave 2 (slices 2 + 3 + the deferred items) LANDED. The loop no longer breaks
before notify on a `failed` terminal: it folds `notifyTickEnd`
(`outcome: "failed"`), abstain resolves to STOP for that outcome (so a run with
no policy is byte-identical to before — pinned by a test), `canceled`/`vetoed`
still break out ahead of the fold, and `maxConsecutiveFailedTicks` (default 3,
session-settable) backstops whatever a participant asks for, reporting the LAST
failure as `stopCause`. `TickResult.consecutiveFailures` carries the count to
every participant (`TickInput.consecutiveFailures` is the entry-side twin, and
non-zero is what stamps `retryOfTick` on the retry's `tick-start` — spec's
`LoopExecutionEvent` + the public `TickStartEvent` both carry it). The session
fold gained the tick-failure predicate LAST (weakest claim: a tree stop and a
gate hold are deliberate, this only answers "worth re-issuing?"), with
`tickFailurePolicy` in both forms normalized by
`session/src/tick-failure-policy.ts`; a failure outside the `ExecuteError`
family never retries. The lifecycle projection now SETTLES a failed tick
(previously skipped) — without that, `useOnTickEnd` +
`useLoopControl().continueAfterTick()` could not be the tree-level retry seam
the ADR promises. Google's `MALFORMED_FUNCTION_CALL` family flipped to a raised
`MalformedModelOutput` (both stream-finalize and normalize), which retired the
`malformed_tool_call` stop reason entirely; `runExecutorConformance` now takes a
REQUIRED `errorFixtures` map over `ExecuteError["_tag"]`, so a future taxonomy
class breaks every adapter's conformance file at compile time; and
`ToolValidationError` folds its issues into its message, so the persisted
tool_result names the bad argument path.

Not done, deliberately: usage on failed ticks (ADR open point 1 — the provider
bills for a malformed generation and the run under-reports), and the app-level
`createApp({ tickFailurePolicy })` shorthand (the longhand
`createApp({ session: { … } })` works today; `AppHarnessOptions` was owned by a
concurrent session). Tracked on #291.

Wave 3 LANDED — the coverage holes named in the wave-2 review, closed. (1)
Non-streaming retry parity: `executor.run` folds any `ExecuteError`-classified
failure to a `failed` terminal via a shared `executeErrorToTerminal` (the fake
already folded; the real executor did not — one helper now prevents that
divergence recurring), placed as a tail catch so a classified raise from
`normalize` (Google's flip) folds too; projection/normalization defects keep
rejecting. (2) `ProviderTimeout.timeoutMs` optional and the timeout arm added
to `defaultMapProviderError` BEFORE the status arm — matching on
`constructor.name`, because neither the OpenAI nor Anthropic SDK assigns
`name` on its error classes (`APIConnectionTimeoutError` reports `"Error"`);
deliberately no message regex, which would steal a 504 from `ProviderRejected`.
Known latent twin: `defaultIsAbortError`'s `APIUserAbortError` name check is
dead for the same reason (survives on its message fallback) — #291. (3)
ai-sdk error PARTS: the adapter records the first part's native error and its
`finalizeStream` raises it raw — the wave-1 finalize raise IS the failure
channel, no new machinery; classification then routes invalid-tool-input to
`MalformedModelOutput`. (4) Conformance `errorFixtures` also drive
`executeStream` (same `throws` seam, zero adapter-file edits); non-streaming
executors `ctx.skip()` visibly.

CLOSED (#291, board Done). Close-out commit 487b4f62b: the
`createApp({ tickFailurePolicy, maxConsecutiveFailedTicks })` flat shorthand
(unblocked by ADR 100 landing) and the `defaultIsAbortError` dead-name fix
(`constructor.name`, twin of wave 3's timeout discovery). Shipped in
1.0.0-next.118/119. Follow-on design spun off: #293 structured-output
validation failures → feedback via the §B2 forced wrap-up tick (open
question: un-winding the steer-proof stop for an INVALID capture); #294
replayed-terminal rehydration + usage on failed ticks (the §6 honesty gap).

### 2026-08-12 — scoped capability leasing, named (ADR 98)

`blueprint/98-scoped-capability-leasing.md`. Two shipped seams — the code
runtime over a session sandbox and the data-layer `View` over a `Store` —
independently converged on one shape: a capability **declared session-blind**,
**resolved late** against the `SessionInstaller` (`RuntimeProvider.resolve`,
with `capabilities()` deliberately session-free), **selected** by a total
`activeX(ns, id?)` (id → primary → sole → ambiguous-fails, one rule in one
place), and **borrowed** as a narrowed type that omits the ownership verbs
(`SandboxPlacement` has no `destroy`; `View` is not `Store`). Attenuation is by
type, not by comment.

The ADR names the pattern and its three elements; the one new call is a
**deferral** — no shared `Lease<T>`/`Provider<T>` at two instances. It waits for
the third consumer (`@agentick/code-stdlib`, the natural one), which proves what
actually factors — the `resolve(installer)` verb and the `activeX` tie-break
look universal, the attenuation is per-capability by construction. Same "extract
at three" discipline the model/compaction two-door took in ADR 97.

### 2026-08-12 — measuring the request; compaction decides outside the tree (ADR 97)

`blueprint/97-measuring-the-request.md`. A production thread compacted twice in a
row. Root cause is structural, not a bug in the trigger: **a component cannot
measure the tree it is part of**, so a render-time trigger can only read the
PREVIOUS request's size, and a level check re-fires on a number the fold did not
change. Relocating the predicate does not fix it; the decision has to leave the
render.

**Landed (parts 1–3 of the ADR).** `estimateTokens` was not merely imprecise — it
walked `part.text` only, so `input.tools` (every schema, on every call) and all
media counted as **zero**. Rewritten as `estimateTokenBreakdown` returning
`{ messages, tools, total }`, folding all nine wire part types with a `never`
guard so a new part type breaks the build instead of silently costing nothing.
The split is load-bearing: compaction can only fold `messages`, and a trigger
counting `tools` against a ceiling it can only relieve by folding is the
**ratchet** — it folds forever without ever getting under the bar.

Per-modality rates went onto **the adapter** (`ExecutionTarget.mediaTokens`),
beside `pricing` and under the same authority argument. Ryan rejected the central
`PROVIDER_MEDIA_TOKENS` table in `@agentick/model` and was right: a table here is
closed to any adapter shipped outside this repo — ADR 27's privileged center. The
same 1024² screenshot is ~765 tokens on OpenAI, ~1365 on Anthropic, ~1032 on
Gemini, so one shared constant is wrong for everyone by construction.
`runMediaDeclarationCheck` now ties the pair together, so a future adapter cannot
ship media that estimates as free. `model-ai-sdk` declares none, deliberately —
it cannot know its concrete provider.

**Discovered:** `CompactStrategy.shouldCompact` has **zero call sites** — spec
declares it, `rollingSummary` implements it, the timeline README documents "a
trigger asks the strategy rather than keeping its own copy of the number", and no
trigger ever asked. `rollingSummary({ threshold })` compiles, typechecks, reads
correctly, and does nothing. That is why Ernesto hand-rolled `<Compaction>` with
a duplicate constant.

**Next (parts 2–3):** the trigger moves to the ADR 67 tick-end fold, where each
measurement arrives once as an event and the double-fire cannot occur; and a
compaction strategy becomes declarable in the tree via ADR 56's coat-check
pattern (`compactRef` in the IR, live strategy on a bridge), precedence
tick-IR > config. No per-send rung — a send names a model, nothing names a fold
strategy. The two-door mechanism is NOT generalized: models is one consumer,
compaction is two, extract at three.

### 2026-08-11 — the interceptor surface collapses into BaseHarness (ADR 96)

`blueprint/96-interceptor-surface-collapse.md`. A harness now owns only its
`CommandRegistry` augmentation and its handlers; the `hooks:` / `guards:`
drop-layer bags ride `BaseHarnessOptions<I, Surface>` and the base constructor
registers them for every harness. The three hand-rolled halves (timeline,
prompts, skills) are gone and their suites pass **unmodified** — which is the
whole behavioral argument. Twelve harnesses that had no sugar gained it for one
type argument each; `defineCode({ guards: { execute } })` now vetoes a
model-authored program.

`HarnessFx` gained `guard` (the Effect-native primitive), so
`ToolExecutorHarness.guardDispatch` is deleted and its tests run on
`fx.guard`. The 9 hand-written `get fx()` literals now spread `...super.fx`, so
the next universal `.fx` member costs zero per-harness edits.

Two things the change surfaced. (1) Three protocol types spelled the
Promise-facade exclusion by hand (`PromiseView<Omit<XFx, "use">>`) and would
have projected `guard` as a bogus operation; the exclusion is now derived
(`Omit<F, keyof HarnessFx>`). A hand-maintained list of primitives fails OPEN.
(2) `compiler-react/src/harness/compiler-harness.ts` carried a literal NUL byte
in a template-string delimiter (`${ref.id}\x00${ref.format}`), which made the
whole file invisible to `grep` — that is how its `get fx()` escaped the first
sweep. Replaced with the `\0` escape. Byte-scan changed files; a `Bin` in
`diff --stat` is an alarm.

Measured: production source **−47 lines**; the counterfactual (hand-writing the
bags for the twelve harnesses) **≈360 lines** never written. Tier 2 — an
Effect-native hook register on `.fx` — is PROPOSED-DEFERRED with the honest
asymmetry argument in ADR 96 §4: `.fx` carries primitives, the harness surface
carries the derived sugar, and an in-fiber hook is composable over `fx.use`
while an in-fiber guard has no other expression.

### 2026-07-31 — usage → cost vertical (`docs/proposals/v2/usage-cost.md`)

Cost became a first-class, durable record. Contract in
`docs/proposals/v2/usage-cost.md`; arithmetic and folds in
`@agentick/spec` (`src/data/usage-cost.ts`), stamping in loop-executor,
rollups in loop-executor + session, the seam on `AppHarnessOptions`.

**The audit found four defects, all real.** (1) Every rollup was FLAT
across models — `ExecutionRunResult.usage`, `SessionRecord.usage`, the
turn record — while `setModel` / per-send / per-tick `<Model>` / spawn
overrides all change model mid-flight. Cost is not a function of a
flattened bag, and the information was destroyed at fold time. (2) Cost
was never recorded anywhere: `estimateCost` had exactly ONE caller in
the workspace (`app/src/telemetry-defaults.ts`, an OTel span
annotation), so a restored session knew its tokens and not its money.
(3) Nothing being stamped meant every read repriced history. (4) Two
adapter normalization bugs: Anthropic's STREAMING path dropped
`cache_creation_input_tokens` entirely (the non-streaming path folded it
correctly) — cache writes cost 1.25x input, so streamed calls
under-billed; and Google's `candidatesTokenCount` excludes
`thoughtsTokenCount` while Gemini bills thinking at the output rate.
Both fixed, with streaming/non-streaming equivalence pinned.

**Decisions.** Money is INTEGER micro-units (`1_000_000` = one currency
unit) — a total is a fold over hundreds of ticks, so float error
accumulates where nobody audits. Rates are a `RateCard` declared at
MODEL CONSTRUCTION (`anthropic("...", { rates })`) landing on
`ExecutionTarget.rates`, so a per-tick `<Model>` override carries its
own card through the cascade with no extra plumbing; an app-level
`costResolver` callback WINS over declared rates, returning either a
`RateCard` ("you do the math") or a `Cost` ("I did") — both arms are
real (per-tenant contracts vs. marketplace markup). Rates apply to
DISJOINT REMAINDERS because cache/reasoning tokens are subsets; rounding
is deferred to one final division so the total is order-independent.
Cost is stamped ONCE per tick at act time with a `rateRef`, inside the
tick body where the settled usage and the `<Model>`-resolved target
coexist — **not** in model-executor as originally planned, because the
model-executor does not know which model the cascade chose.

**The honesty rule is the load-bearing invariant.** An unpriced tick
rolls up as explicitly unpriced, NEVER as zero — zero is a claim ("this
cost nothing") and an unpriced tick cost something we cannot name.
`CostRollup` is a DISCRIMINATED union (`complete` | `partial`), not a
flat shape with an ignorable `unpricedTicks`, for the same reason
`StopCause` is discriminated: the two arms demand different words on
screen ("$1.23" vs "at least $1.23"), and a flat shape lets every
consumer render the wrong one by omission. A foreign-currency tick
counts as unpriced _in that total_ and stays fully priced in its own
`byModel` bucket — summing across currencies is the same class of lie.

**Two planes, one stamp (design ruling).** The stamp happens once and is
projected twice: the TRUTH plane (execution events/journal + the
session-record aggregate) is what billing reads; `ctx.metrics` gets a
MIRROR of the same facts for telemetry. **Money never lives only in
metrics** — a metrics pipeline samples, pre-aggregates, expires series
and sheds labels under cardinality pressure, all correct for telemetry
and catastrophic for an invoice. The mirror is emitted at the session's
`applyExecutorResultBody`, where cost + model are already in hand and
already being durably written; the loop has no `ctx.metrics` threading
yet, so the session is the correct emitter today. The honesty rule
crosses over intact: an unpriced-tick COUNTER is mandatory beside the
cost histogram, or a dashboard shows a confident silently-low number.
Labels stay low-cardinality (provider/modelId/currency/kind, never
rateRef — it is adopter-chosen and DATED, so it mints a new series on
every price change forever — and never session/execution/tick id).
Landed as `session.tick.cost_micros` (histogram),
`session.tick.tokens` (histogram, labelled by kind), and
`session.tick.unpriced` (counter). A tick that reported no usage at all
emits nothing — not even an unpriced count, since unmeasured is not
unpriced. Live in-turn cost display is a THIRD thing — the client folds
`tick` events — and is display, not accounting: it may lag or drop
because nothing reads it back.

**Rollup boundary (design ruling): write-time WITHIN a session,
query-time ACROSS the graph.** tick → execution → record is written as
it happens, per-model preserved. Sub-agent sessions (`spawnPath`) and
task executions (`scope.sessionId`) are NEVER propagated root-ward.
Three refusal reasons, each sufficient alone: (1) **write
amplification** — every ancestor re-written on every descendant tick,
scaling with depth × ticks; (2) **structural double-count** — if a
parent contained its children's spend, then _summing records_, which is
exactly what a billing export or per-principal total does, counts each
descendant once per ancestor above it; silent, grows with depth, always
overstates, and unfixable by a careful consumer because it is a property
of the shape; (3) **attribution is policy** — who pays for a detached
task or a shared sub-agent is the adopter's call, and a write freezes
one answer while a query leaves the scope open.

Framework obligation discharged: spec ships `rollupTree(records,
rootId)` + `inSpawnTree` over the existing join keys (`SessionRecord`
already satisfies `CostAttributionRecord` structurally — no new
storage, no new writer). Root is a PARAMETER, so the same records answer
"whole tree" / "subtree" / "this session alone". Tree honesty extends:
`partial` if any descendant is itself partial OR has usage with no cost
rollup at all — the second case is the trap, since
`mergeCostRollups(acc, undefined)` returns `acc` and a naive fold would
claim `complete` over an unaccounted branch. Cannot detect a descendant
whose record was never handed in, so the caller owns input completeness
(documented). Pinned by test, including that a spawned child's cost
lands on the child's record only.

**Corrections made mid-flight, both caught by verification rather than
by review:**

- The doc originally argued `SEED_MODELS`' prices were "wrong, off by
  3x". Checked against current list pricing: the rows are RIGHT today
  (Opus $5/$25, Sonnet $3/$15, Haiku $1/$5, cache read 0.1x / write
  1.25x). The argument was rewritten to the real one — an undated table
  applied as a silent default cannot express a repriced family under one
  prefix (`anthropic/claude-opus` matches Opus 3 at $15/$75 and today's
  Opus at $5/$25), introductory pricing, or the 1h-TTL 2x cache-write
  tier.
- §8 claimed cost "rides the wire automatically" because it sits on
  payloads that already project. FALSE — the wire `StreamEvent` types in
  `spec/data/streaming.ts` are separate, explicitly-fielded types that
  session projects onto field by field. Added `cost`/`model` to
  `TickEvent`/`TickEndEvent` and `byModel`/`cost` to `ExecutionEvent`,
  plus a test that an unpriced tick emits NO `cost` key (not `null`).
- §7.1 claimed `SessionStore.list` already scopes on `spawnPath`. FALSE
  — `SessionStoreQuery` has `parentSessionId` (direct children) and
  `root`, no ancestor predicate. **Deliberately not added**: an adapter
  that does not recognize a new query field ignores it silently and
  returns too many records, which for a cost query is an over-count with
  nothing in the result shape to signal it — exactly what the honesty
  rule exists to prevent. `TODO(trail-spawn-tree-query)` at the
  `parentSessionId` site: land it across the conformance suite and every
  adapter as one change, or not at all.

**Two spec faces of one call had silently drifted.**
`StateApplicatorFx.applyExecutorResult` (what the loop actually
composes) and `ApplyExecutorResultInput` (the Promise facade) were
structural copies, and they disagreed twice over: the facade declared a
narrow projection (`output`/`stopReason`/`usage?`) while the twin took a
whole `LanguageModelExecutionResult`, and only the facade learned about
`cost`/`model`. Neither disagreement ever went red, because the loop
forwards via a SPREAD and TS's excess-property check only fires on
literal keys — so the declared contract said the money fields did not
exist while every call site passed them. Collapsed to ONE type
(`ApplyExecutorResultInput`, widened to the full result), which
immediately caught an under-specified conformance fixture that had been
omitting `specVersion`. Also ended a pre-existing drift on
`TimelineEndTurnInput`, which was missing `target?` (accepted by its one
implementation since ADR 53) alongside the new `byModel?`/`cost?`.

**The recurring defect worth naming.** Three separate hops in this
pipeline copy a payload forward by NAMING each field, and each silently
drops what it does not name: `TimelineHarness.appendTurnBoundary`'s
`omitUndefined({usage, stopCause, target})` allowlist, the session's
`LoopStreamEvent` → wire `StreamEvent` projection, and
`SessionRuntime.commit`'s record rebuild. All three dropped
`byModel`/`cost` on the first pass and **none failed to compile** — the
fields are optional, so an omission is legal everywhere. Only a test
reading the far end catches it. Hence one assertion per landing site
rather than one end-to-end test standing in for all of them. (The
timeline allowlist is why `packages/timeline/src/harness.ts` is in this
change at all; the fix is additive.)

**Known gap this vertical inherits.** `UsageStats.cacheCreationTokens`
collapses the 5-minute-TTL (1.25x) and 1-hour-TTL (2x) cache writes that
Anthropic reports separately, so no rate card can price them apart and
long-TTL workloads under-bill. `TokenKind` is a closed union, so closing
it is a spec change touching every adapter.
`TODO(trail-cache-ttl-tiers)`.

**Two cost systems now coexist, and that is a defect.**
`@agentick/model` still holds the #186/#204 estimator (float USD,
seeded-by-default, ephemeral span annotation) and
`ExecutionTarget.pricing`. Untouched — a concurrent session owns that
package. Nothing in the new vertical reads `target.pricing` or
`SEED_PRICING`, so there is no silent cross-talk, just duplication. The
exact convergence diff (delete `estimateCost` / `SEED_PRICING` /
`ModelPricing` / `CostEstimate` / `ExecutionTarget.pricing`; keep
`mergeUsageStats` as a re-export from spec; repoint
`telemetry-defaults.ts` at the stamped `Cost`) is written up in
usage-cost.md §9. They should not both exist at v2.0.

### 2026-07-30 (evening) — the consolidation wave

Three parallel workstreams, gated as one tree (3,827 tests green):

**Wire honesty** — #251 `session/abort` is real (`SessionHarnessProtocol.abort`
added; delegates to the current handle's abort — the notifications/cancelled
path; e2e: reason observed at the model call). #252 `initialize` derives every
capability flag from actual wiring (per-flag source-of-truth table in the
handler; `WireServerDescriptor` threads real serverInfo per transport;
`WIRE_PROTOCOL_VERSION` validated BOTH ends — the check immediately caught a
lying fixture). `cursorResume: false` (honest) + `TODO(wire-resume)` trailhead
(retention → replay → eviction, in that order). `notifications/progress/complete`
registered; `SubscriptionEvictedParams` documented as reserved-no-producer;
client handshake claims `cursorResume: true` (the one true flag). findSession:
three copies → one spec helper — both apologetic doc-blocks were WRONG
(SessionNotFoundError existed all along; knobs/completions were mislabeling
session ids as appIds). Reported-not-fixed: the loop-abort string vs
ToolAbortedError asymmetry (14 sites, 5 packages — needs its own ticket).

**Pagination consistency** — shared `paginate()` in @agentick/utils (resources'
hand-rolled impl deleted); `prompts/list` + `skills/list` + `session/list_tools`
gain cursors with MCP-shaped envelopes (breaking: bare arrays → named
collections); MCP tools/prompts projections honor request cursors (paginating
AFTER per-connection filters); #250 client listTools drains all pages; the six
poll handles collapse into client-core `polledView` (804 → 621 LOC; public
surfaces unchanged). Law kept: sync `list()` stays a bounded snapshot —
pagination is a wire/projection concern. No per-harness pageSize seam until a
second adopter asks (TODO trailheads).

**Primitive consistency** — #249 `skills:run` is a declared command (exposure
INTERNAL — a run returns a live handle, which cannot cross a wire truthfully;
same blocker as session:send, widen when the serializable form lands); opId
threads into SkillMessageSource; guard can veto a run; conformance suites
assert the version round-trip (absence contractual — the framework never
invents history). #245 ResourceAliasAmbiguous joins the error channel + tag
list (the masking regex test now asserts the tag + candidates). #259
IconDescriptor.sizes → readonly string[] (sweep: only describe.ts ever used
the string form); projected icons validated against the SDK's own schema on
all four surfaces. PromptsGetResult.metadata gives GetPromptResult.\_meta its
source (declaration bag surfaces on render; no per-render invention).

mcp-parity.md updated in place (pagination rows → have; #250 closed).
Released as next.46.

### 2026-07-30 (later) — era discovery, defect wave, #257

**MCP 2026-07-28 era**: current-official MCP is a protocol REWRITE (stateless,
MRTR/requestState, no sessions; SDK answer = the GA 2.0.0 package split — the
monolith is capped at 2025-11-25 forever). Repo advertises the era in labels
only (0cbe88e3). Decision doc `mcp-era-2026-07-28.md` (178acd33), umbrella
#256. Era-safe: completions, pagination, icons. Moot: the URL-elicitation
completion-notification gap (fields removed in-era).

**Defect wave landed** (parity-audit shortlist + handle audit):

- `a7081eac` — #246 sub-handle teardown on session close; #247 live active-map
  shrinks (+ live gains close()); #248 per-method namespace merge
  (wireFallthrough proxy gated on satisfies-checked wireMethods lists; handle
  methods always win; timeline.compact newly reachable). Follow-up #258
  (\*/commands rows reachable, zero consumers — verdict needed).
- `01899e4c` — #254 SDK abort → ctx.signal (no merge: single source, listener-
  leak argument); #255 outbound content mapper (foldContentBlock-exhaustive,
  both producing sites, retired the broken toMCPResult duplicate); #253 +
  display/\_meta carriage for prompts/resources (tool-extensions →
  wire-extensions); opt-in SSE eventStore + bundled bounded
  inMemoryEventStore (old-era surface by spec). Found: #259 icon sizes shape
  mismatch + GetPromptResult.\_meta needs a spec source.
- #257 (this commit) — prompts.invoke appended NOTHING in every default
  createApp deployment: host timeline invisible to installer.getNamespace
  (session constructed after extensions install). Fix: app publishes the host
  timeline into the shared extensionBridges map post-construction (guarded —
  withTimeline claims win); PromptsHarnessOptions.timeline widens to a
  provider thunk (retry-on-miss, cache-on-hit); the silent skip warns once.
  Ordering law doc-blocked on BaseInstaller.getNamespace. Found by the Knowify
  usage-walk e2e (send→3 entries, invoke→0); missing test class added
  (real-createApp integration in packages/app).

**Releases**: next.43 publish had silently half-failed (concurrent 02:16
publish of the same version → immutable-conflict skips; only the new
completions name landed — false-green types via skipLibCheck any-degradation).
next.44 = the real tree, tarball-verified. next.45 cut after this wave.
Completions /client subpath added (8395a54f) — the wire row is now importable
outside the monorepo. Knowify piece 2 landed (composer→invoke; bare-send run
trigger; RunOutcome "appended"); pieces 1&3 resume on next.45.

### 2026-07-30 — MCP spec parity audit (`docs/proposals/v2/mcp-parity.md`)

Systematic four-way audit (have / partial / missing / deliberately-not) of
agentick v2 against MCP `2025-11-25` + `draft`, at `cbfdae13`. **The headline:
parity is materially better than our working memory of it, and there is no
missing vertical.** What remains is three small correctness defects, one
metadata asymmetry, and exactly one architectural question.

**Counts.** Server features: 12 have, 7 partial, 4 missing. Client features: 3
have (roots both directions, elicitation form + URL both directions), 1 partial
(sampling). Protocol: 8 have, 4 partial, 2 missing, 1 deliberately-not.

**Three defects, not gaps — the code is wrong rather than absent.** (1)
`ctx.signal` on the MCP server is a throwaway `new AbortController().signal` at
both ctx mint sites (`server/harness.ts:855`, `:1224`), so a client cancelling an
in-flight `tools/call` drops its request while the handler runs to completion.
(2) Outbound tool-result content is an unchecked cast
(`projection/tools.ts:278`) — agentick's 23-member `ContentBlock` union goes
straight onto a wire whose union has five, so a `JsonBlock` / `CodeBlock` /
`XmlBlock` emits content no MCP client can parse. The **inbound** direction has a
real mapper (`integration/content-mapper.ts:87`); outbound has none. (3)
`PromptDeclaration.title` is declared, documented, motivated
(`spec/.../prompts-harness.ts:154`) and then dropped by `toWirePrompt`
(`projection/prompts.ts:178`).

**The metadata asymmetry.** `tool-extensions.ts` established exactly the right
convention — one namespaced `metadata.mcp` key, helper-built, projected at the
wire, byte-identical when absent, folded on the inbound side too — and it stopped
at tools. Prompts and resources already carry the open `metadata` bag it needs
(`prompts-harness.ts:193`, `resources-harness.ts:98`), so extending it requires
no new spec surface. This is generalizing a proven pattern, not designing one.

**Pagination: resources solved it, nothing else adopted it.** `resources-harness.ts:159`
is first-class cursored end to end; `ToolCatalog.list()` (`tool/src/catalog.ts:53`)
and prompts/skills/completions/elicitation return whole arrays. The client harness
mirrors the split — `listResources`/`listPrompts` take cursors, `listTools()`
takes no argument (`client/harness.ts:873`), which means we silently consume only
the first page of any large third-party server. Steel-manned: for agentick's own
catalogs pagination mostly does not matter (tool lists are context-bound), but the
client-side truncation is a correctness bug against servers we do not control, and
`Store<T,Q,M>`'s generic `Q` already permits cursors (`spec/.../store.ts:62`), so
the cost is per-harness with zero foundational change. Noted for the record: this
puts mild tension on "wire constraints live at the wire" — the resolution is that
the principle governs wire _encodings_, and pagination is a storage concern.

**Sampling is the one real architectural question, and it splits in half.**
Outbound (server→client): **defer.** An agentick MCP server already has a model —
sessions own them, tree-declared per tick (ADR 56) — so a handler needing
inference composes `session.spawn()`. Sampling adds no capability there; it
transfers _cost and consent_, and we have no cross-boundary cost primitive to hang
that on. It is also a poor fit for tool-is-the-action: it is a reverse dependency,
not an invocable action. The `SamplingHarness` name stays a TODO, not a package.
Inbound (a remote server asks us): **build, opt-in.** Today an adopter
hand-writes a model call against raw SDK types (`client/types.ts:182` calls
executor routing "a Wave 3 concern") while the session sits right there with a
configured executor. Ships as capability-not-opinion: a default handler behind an
explicit opt-in with a `(request) => verdict` seam, never on by default.

**Resumability is one unset SDK option.** `transports/http.ts:22` claims the SDK
owns resumability; it does only when given an `eventStore`, and `:466` passes
none. A dropped SSE stream silently loses every notification sent while
disconnected — which bites hardest on exactly the long-running Pattern B tasks our
tasks projection is good at.

**Corrections to what we believed.** The recorded "MCP server-harness next.5
gaps" note is **stale**: all four listed gaps are closed — declaration and result
`_meta` (`tool-extensions.ts:78`/`:95`, the MCP Apps `ui://` and step-up-auth
cases), annotation hints (`:67`), and both prompt render and resource resolution
now run on the crossing's fiber carrying caller identity plus the `mcp` boundary
facet (`projection/prompts.ts:117`, `projection/resources.ts:146`). Also:
`ctx.sample` does **not** exist despite `server/protocol/lifecycle.ts:80` claiming
it was installed in #171d — that line is the only hit in the workspace; delete it.
Effect-returning tool handlers throw on the MCP server projection
(`server/config.ts:993`).

**Shortlist (earn-per-line order).** (1) Thread the SDK per-request abort into
`ctx.signal` — S. (2) Outbound content-block mapper — S/M. (3) Extend
`metadata.mcp` to prompts + resources and project prompt `title` — S. (4)
`listTools(cursor)` on the client harness — S. (5) Inbound sampling default from
the session's own model, opt-in behind a verdict seam — S/M. (6) Native cursors on
tools + prompts, and an `eventStore` for HTTP resumability — M. **Explicitly not
building:** a `SamplingHarness` for outbound sampling, a `RootsHarness` (ADR 65
already refused it with a recorded trigger), JSON-RPC batching (withdrawn from the
spec), and any projection of skills / knobs / gates / timeline as MCP capabilities
— they already reach clients through tools and prompts, and
`capabilities.extensions` (`lifecycle.ts:118`) is the open seam if that ever
changes.

### 2026-07-30 — materialization provenance A+B landed (the stamp + declared `version`)

`docs/proposals/v2/materialization-provenance.md` phases A and B(skills half).
THE DEFECT: `prompts:invoke` appended rendered messages carrying no provenance,
so a chat UI had to render four hundred words as if the user had typed the six
tokens of `/quoting_report period:2026-01`. What shipped: `version?: string`
declared on `PromptDeclaration` / `PromptDeclarationRecord` and on
`Skill` / register / update inputs — **adopter-defined, never
framework-computed** — plus a `metadata.source` stamp written by the two sites
that materialize content: `applyInvoke` on every entry it appends, and
`skills.run` on every message its composition produced.

**The razor held: the framework stamps only facts it already holds.** Name, args
(the op input verbatim), `opId` (the invoking command's), `version` (the
record's own string). No hashing, no computed revision, no extra store read. The
record-hash helper from §4 was NOT built: `@agentick/utils` has no stable-hash
and no canonical-JSON serializer to compose one from, and hand-rolling a
canonicalizer (key order, undefined-vs-absent, cycles, floats) inside a
provenance slice is exactly the kind of subtle thing that should not ride along.

**Correction to the design doc #1 — the augmentation grammar is a KEYED BAG, and
the `kind` union was impossible, not merely unidiomatic.** `MessageSource` is an
augmentable INTERFACE; interface merging requires every declaration of a
property to have the same type, so prompts declaring `kind: "prompt"` and skills
declaring `kind: "skill"` is `TS2717` (verified with `tsc` before choosing) — and
both are bundled in the `agentick` metapackage, so the second tenant would have
broken the build. Each package contributes an optional KEY instead
(`source.prompt`, `source.skill`), which is what the founding tenant
(connectors: `source.telegram`) already did. The seed's doc-block now states
this as law so the next tenant does not rediscover it.

**Correction #2 — the skills stamp carries no `opId`, and that is honest.**
`skills.run` is a plain method, not a declared command: it mints no operation, so
there is no id to link to and none is fabricated. `TODO(skills-run-op)` records
what would close it (promote `skills:run` to a command → journal envelope, guard
seam, and an `opId`). The skills materialization site was investigated rather
than assumed: `run` → `composeRun` → the bound send capability → an ordinary
turn on the timeline. The stamp goes on AFTER composition, so a `composeRun`
override cannot opt out of provenance by not knowing about it. Skill LOADS
(`skill_read`) are NOT a site — a tool result is already structurally
provenance-bearing.

**Two laws at both stamp sites:** merge into existing metadata, never clobber;
and an entry that already carries a `source` KEEPS it — a `render` fn or a
composition that stamped its own is the closer authority. Also promoted the
Agent Skills frontmatter `version:` key onto the declared field (it used to fall
into the metadata bag, which would have left two homes for one fact), and made a
version-only bump count as a change in the reload diff. One design improvement
fell out: `PromptsHarnessOptions.timeline` narrowed from the whole
`TimelineHarnessProtocol` to `TimelineAppendCapability` (`Pick<…, "append">`) —
least-privilege injection on the `bindRunner(send: SessionSendCapability)`
precedent, and it is what let the provenance test double be typed rather than
cast.

### 2026-07-30 — completions P3 landed (MCP squaring: one declaration, both wires, #244)

The MCP server's `completion/complete` now resolves through the SAME seam the
agentick wire uses, so a prompt argument that declares `complete` answers an MCP
client with **nothing restated in server config**. Ryan's requirement was that
MCP consume completion the way it consumes every other layer, and the answer was
already written down: the `PromptsFx` / `ResourcesFx` precedent — the projection
holds the PROTOCOL and composes the harness's Effect twin from inside its
crossing. P3 added the two twins that were missing and mirrored that wiring
exactly.

**The twins, and why the Promise face is not merely less elegant but WRONG here.**
`CompletionsFx.resolve` and `PromptsFx.complete` are new protocol members
implemented via a widened `fxProxy(extras)`. Through the Promise facade,
`complete`/`resolve` mint the resolver ctx from the harness's CONSTRUCTION-bound
scope — so an inbound MCP completion would run a tenant-scoped lookup with the
owning session's identity and know nothing of the client that asked. That is
fatal for the exact feature (`knowify.jobs` filtered by caller). Composed on the
crossing's captured runtime via `onFiber`, connection → crossing → resolver holds
and `ctx.mcp.user` carries the caller's credential. Pinned directly: the seam
test asserts the resolver reads `ctx.mcp.user.token` AND the redacted trunk
`identity.principal` in the same call.

**These twins are the first `.fx` members that are NOT sugar over a command,**
and that is a consequence of an earlier decision rather than a new one:
`complete`/`resolve` are deliberately command-less so a keystroke mints no
journaled op. So `fxProxy` gained an `extras` bag for hand-written Effect twins,
and `currentOperationCtx` gained a typed `extras` param — the in-fiber mirror of
`deriveOperationCtx`'s existing one, merged by descriptor so a lazy getter is not
forced. Deliberately NOT `withBoundaryFacets`: a fiber-published facet would leak
one completion's `resolvedArguments` onto every nested seam on that fiber, while
`extras` stops at the call that owns them.

**Resolution order, doc-blocked at the projection.** (1) an explicit
`completions.prompts[name][arg]` handler wins — the adopter's override, and the
ONLY path for a standalone server with no prompts surface to read; (2) else
`prompts.fx.complete` inside the crossing, `resolved` → clamp → wire, `ref` →
`completions.fx.resolve` (registry via the new `completions.use` slot,
adopter-owned exactly like `resources.use`); (3) else empty. Unknown prompt,
unknown argument, an argument declaring nothing, a ref nobody bound — all
`{ values: [] }`, byte-identical to the pre-seam wire.

**One rule ADDED, on purpose:** the per-connection prompts `filter` now applies
to completion. A prompt hidden from `prompts/list` was already unfetchable via
`prompts/get`; completing its arguments runs a resolver over the caller's data,
which is precisely what the filter withholds, so leaving that open would have
been a quiet read-side leak around a visibility control.

**`clampToWireLimit` stays the ONE cap site** and now covers seam-resolved
results too. Pinned as a differential: one 150-value declaration answers
100 + `hasMore` over MCP and all 150 through `prompts.complete`.

**Capability advertisement now follows the SURFACE, not a handler count.**
`completions` is advertised when the config slot carries a handler OR a prompts
surface is projected. It deliberately does NOT scan for arguments that declare
`complete`: a capability is negotiated once at `initialize` while prompts
register after it (`start()` seeds them, adopters add more later), so a scan
answers for a catalog that has not finished arriving and a prompt registered a
second later would be uncompletable for the connection's life. Over-advertising
costs a client one request that answers empty; under-advertising costs it the
feature. Advertisement and handler-install now read the SAME field — the SDK
asserts the capability at registration, so a disagreement would throw.

**`TODO(adr91-brand)` retired.** `{ ...ctx, resolvedArguments }` inside the
handler body erased the `Derived` brand and force-forced five lazy facet getters.
The fix is the generalization of what `progressToken` already did by hand:
`McpCrossing<R, X>` gained a typed `ctxExtras?: X` that composes INTO the branded
mint, and the body's ctx is typed `Derived<McpRequestContext & X>` — so the
projection needs no cast to satisfy `CompletionContext`. One `as unknown as`
remains, at the mint that owns it, because no structural check can relate a
generic `X` back through the composed extras literal. No new runtime crossing
machinery was needed.

**MCP client widened (breaking, no shim per v2 rules):**
`completePromptArgument` / `completeResourceTemplate` answer `CompletionResult`
instead of `readonly string[]`. The reason is the forwarding resolver the
MCP-prompts-fold will need — MCP caps at 100 and flags it, and a forwarder that
drops `total`/`hasMore` presents a truncated list as the whole answer.
`TODO(mcp-prompts-fold)` marks both where the fold lands and that
`context.arguments` is not forwarded yet.

**One real defect caught by the new tests, not by review.**
`CompletionsHarness.fx.resolve` first reused the throwing `requireResolver`; a
synchronous throw inside `Effect.gen` becomes a DEFECT, which escapes the
declared `CompletionsErrorChannel` and reached the wire as an unwrapped crash —
breaking the "a ref nobody bound is silence" rule one layer up. Now
`Effect.fail`. Worth remembering as a general trap for the hand-written twins.

Gates: `npx vitest run packages/mcp packages/completions packages/prompts
packages/spec` → 98 files / 1332 passed; a second sweep over runtime, gateway,
transport-in-process, session, resources, knobs, tool-executor, loop-executor,
compiler, app (base-harness is shared) → 220 files / 1774 passed.
`turbo run typecheck` → only the pre-existing `@agentick/model` failure.
dep-graph, ctx-derivers, oxfmt, oxlint clean.

**Still open, reported not built:** the `authorizer:command:authorize` journaling
question P2 pinned. See the investigation below.

**Authorizer journaling — the finding.** `JournalingPolicy.override` is keyed by
event NAME, and `GatewayHarness.authorize` mints ONE name
(`authorizer:command:authorize`) for every wire method. So the existing knob is
all-or-nothing: silencing completion's authorization audit silences
`session/send`'s too. The information needed IS present — `AuthorizeInput.scope`
carries the canonical verb label — but it lives in the op's INPUT, and policy
cannot see inputs. `WireExtension.journal` therefore cannot be extended to cover
it, since its fold translates a method name into an op name and the authorize op
has no method in its name. Recommended shape: a per-op disposition on the
`Operation` descriptor (`journal?: EventNameOverride`) that the runner consults
before the name-keyed policy — ~15 LOC in runtime, generalizes to any op whose
cadence depends on its input rather than its name — plus a SEPARATE declaration
key for the induced authorization op, deliberately not a reuse of
`WireExtension.journal`. Conflating them is how audit gaps happen: "this verb's
traffic is a query" and "this verb's authorization need not be audited" are
different claims with different owners, and a wire extension must not silently
make the second while tuning the first. Not built — the decision is Ryan's.

### 2026-07-30 — completions P2 landed (the agentick wire verb, #244)

The client half of docs/proposals/v2/completions.md, same day as P1. What
shipped: `PromptsHarness.complete` beside `render` — a PLAIN method, not a
command, for the same reason `CompletionsHarness.resolve` is one — answering the
three-arm `PromptsCompleteOutcome` (`resolved` when an inline sidecar resolver
ran, `ref` when the argument names a registry source prompts will not chase,
`unavailable` when there is nothing to ask); the `completions/complete`
`WireExtension` in `@agentick/completions`, registered through
`builtinWireExtensions`; and `ctx.completions` finally populated at the app's
`ctxExtensions` site.

**The client method is free.** `completions/complete` is a `WireMethods` row with
a bound `sessionId`, so `session.completions.complete(params-minus-sessionId)`
falls out of the derived wire proxy with zero client code. No hand-written
handle, no `session.complete` base method. `ref.type` is a ONE-member literal
union (`"prompt"`), so `"resource"` / `"tool"` are additive arms rather than a
widened string.

**Three arms, and they fall out of the existing re-join.** `complete()` reads the
declaration through `declarationOf`, and the three shapes
`restorePromptArguments` can already hand back — a function, a string, nothing —
ARE the three outcomes. P1's deliberate asymmetry (a derived ref with no sidecar
restores to no `complete` at all) became `unavailable` for free.

**The gateway boundary op DID journal — verified, then fixed with a seam rather
than a special case.** Every wire dispatch mints a `wire:<method>` op whose
`requested` + `terminal` envelopes are `alwaysJournal` phases: measured at 2
appends per dispatch. Routing completion over the wire would therefore have moved
the per-keystroke journal flood from the harness (where `resolve` is a plain
method precisely to avoid it) up one layer to the gateway. The brief proposed a
hardcoded `override: { "wire:completions/complete": "bus-only" }` on the gateway's
policy; that contradicts the invariant stated in the gateway's own source at the
`builtinWireExtensions` site ("the gateway stays harness-agnostic — never imports
a built-in directly") and would grow a new hardcoded string per high-cadence verb.
Instead: **`WireExtension.journal`** — a per-method `EventNameOverride` map,
parallel to the existing per-method `auth` / `clusterRoute` maps, validated at
`defineWireExtension` like both. The gateway folds it into its `JournalingPolicy`
`override` keyed by the op name IT derives (`wire:<method>`), so the method
declares its own durability disposition in its own vocabulary and the gateway
still names no namespace. Layer order matters and is deliberate: the declaration
sits BEFORE `options.policy` (an adopter outranks a framework default) and after
`DEFAULT_JOURNALING_POLICY`; the close-op override stays last because it is a
substrate-safety invariant. Cost: ~25 LOC across spec + gateway. Known limit:
a wire extension registered by a gateway EXTENSION's `install()` arrives after
the policy binds at construction — `TODO(wire-journal-late-registration)`.

**What still journals per keystroke, stated rather than hidden:** the gateway's
own `authorizer:command:authorize` op, 2 envelopes per dispatch. That is a
security audit record with a different owner and an explicit hook seam
(`onAfterAuthorizerAuthorize`), it applies to every wire method, and exempting
authorization audit is not one verb's call to make. The e2e test ASSERTS those 8
appends across 4 keystrokes so the fact is pinned rather than discovered later;
`TODO(completions-p3)` marks revisiting it at the authorization seam for all
high-cadence verbs if the volume proves real. (P3 investigated it and reported:
the op name is shared across every method, so the name-keyed policy knob cannot
express a per-verb answer. See the P3 entry above.)

**Registration home: `builtinWireExtensions`, not `withCompletions`'s bundle.**
Completions is extension-installed, so the optional-package pattern
(`@agentick/mcp` self-installing its wire extension) looks like the right home —
and is wrong here, because the route's PRIMARY path does not need the completions
namespace at all: an inline `complete:` resolver rides the prompts sidecar, so an
app with prompts and no completions still completes over the wire.
Self-installing would make that case unreachable. Consequence accepted:
`@agentick/app` gains a runtime dependency on `@agentick/completions`.

**Boundary held in both directions.** The route reads `session.prompts` through a
structural feature detection (`typeof candidate?.complete === "function"`) typed
against spec's own `PromptsCompleteInput` / `PromptsCompleteOutcome` — completions
does not depend on prompts, and prompts still does not depend on completions
(`foldCompletionValues` is a three-line local twin of
`normalizeCompletionResult`, pinned against it by a test, for the same reason
`completeRequiresOf` duplicates `isDependentResolver`).

**Silence over faults, everywhere.** No prompts surface, an argument that
declares no completion, an argument name the prompt does not have, a ref nobody
bound, a restored session with no sidecar → `{ values: [] }`. MCP parity, and
honest: zero candidates is the right composer UI for all of them. The one real
error is an unknown PROMPT. A resolver that THREW still surfaces
(`CompletionResolveFailed`) — a broken source is not an empty answer.

### 2026-07-30 — completions P1 landed (@agentick/completions + prompts threading, #244)

The primitive phase of docs/proposals/v2/completions.md, implemented same-day.
What shipped: spec seam (`CompletionResult` / `CompletionCtx = OperationCtx &
{ resolvedArguments, signal? }` / `CompletionResolver` /
`CompletionsHarnessProtocol` + `CompletionNotFound`/`CompletionResolveFailed`);
new `packages/completions` mirroring resources' layout — registry + `resolve`
door that mints NO journaled op (asserted: 3 keystrokes → `totalAppended() === 0`),
ctx via `deriveOperationCtx` with facets composed into the brand; the five
builders LIFTED from `mcp/protocol/completions.ts` with the v1 100-cap stripped
(cap now enforced once at `mcp/server/projection/completions.ts::clampToWireLimit`
— wire behavior unchanged, tested both sides); conformance + `/testing`
(`fakeCompletions`/`stubCompletions`/`fakeCompletionCtx`). Prompts side:
`PromptArgument.complete?: CompletionResolver | string`, record split
(`PromptArgumentRecord` with `complete?: never` as the compile-time forcing
function; `completeRef` + projectable `completeRequires`), sidecar widened
(`completions` keyed by arg name, cleared on importSnapshot like render),
derived-ref grammar `prompt:<prompt>:<arg>` in ONE site
(`prompts/src/completion.ts::promptCompletionRef`, `prompt:` prefix reserved).

Design corrections vs. the morning doc (recon-verified): MCP server completion
ctx-free gap #3 was ALREADY closed (`CompletionContext extends OperationCtx` +
`ctx.mcp.user`); resolver ctx is `OperationCtx & facets`, NOT ToolHandlerCtx
(no toolCallId/task/transport to fabricate; Derived brand forbids it anyway).
Doc updated in place.

Singular/plural definition rule (Ryan): `defineCompletion(name, fn)` returns
the resolver carrying `completionName` (dual-use: barrel entry OR direct
`complete:` value — prompts normalization uses the canonical name as
`completeRef` instead of deriving); `defineCompletions({ sources: map | named[] })`
— reshaped from bare-map to an options bag for slot-grammar uniformity +
unambiguous instance discrimination (NO `store`: nothing serializable to hold;
`guards: { resolve }` is the believable future knob). Duplicate barrel names
throw at define time. `definePrompt` (singular, in prompts): identity +
const-generic inference — `render(args)` typed from the arguments literal
(required→string, optional→`string | undefined`, schema→InferOutput; LAW: no
schema → string, MCP parity); returns ERASED `PromptDeclaration` (createTool
precedent — the narrowing can't survive strictFunctionTypes). Nothing
self-registers at import: attachment = listed in `sources` or embedded in a
declaration; ambient registries refused on multi-session-isolation grounds.

Notable: records already project `completeRef`/`completeRequires` through
`prompts/list`/`get` and the client handle — Knowify's composer can grey out
dependent slots with zero further wire work (P4 input). READMEs: completions
written + resources rewritten per .claude/skills/create-readme (elicitation as
the bar); found real bug → #245 (`ResourceAliasAmbiguous` missing from
`ResourcesErrorChannel` + `RESOURCES_ERROR_TAGS`, unreachable as typed error).
`scripts/dep-graph-gate.mjs` hardened: `${…}` template-literal artifacts no
longer read as import specifiers (was a false-positive publish blocker at HEAD).
Gates: 1279 tests green across completions/prompts/spec/mcp; workspace
typecheck green except pre-existing `@agentick/model` failure from a concurrent
session's in-flight files (not ours; left untouched). NOT committed here:
pnpm-lock.yaml + the 59 version-bump package.json hunks (concurrent session's
sweep) — only the two dependency hunks were staged surgically. Next: P2 wire
verb (`TODO(completions-p2)` markers at the exact sites), P3 MCP squaring
(`TODO(completions-p3)` in-fiber twin), P4 ernesto consumers. (P2 and P3 have
since landed; both TODOs are retired.)

### 2026-07-30 — completions design doc (docs/proposals/v2/completions.md)

Argument completion (MCP `completion/complete` generalized) designed doc-first;
implementation not started. Findings: both MCP edges already have completion
(client harness `completePromptArgument`/`completeResourceTemplate` from Wave 2
#146; server harness `completions.{prompts,resources}` config but CTX-FREE),
while the native middle is empty — no seam on `PromptDeclaration`, no verb on
the agentick client wire. Decisions: named completion sources resolved by
`completeRef` string (handlerRef pattern — functions never cross the spec
firewall); resolver ctx borrows the `ToolHandlerCtx` shape (fixes the MCP
server harness's ctx-free completion as a side effect); ONE generalized
ref-discriminated `complete` wire verb, MCP-shaped; the five v1 sugar builders
port WITHOUT the 100-cap (cap moves to the MCP wire — wire constraints live at
the wire); home is a small dedicated `@agentick/completions` package, NOT
sources-as-runtime-tools (journal pollution per keystroke, result-envelope
mismatch, tools-list pollution — see doc §5). Verdicts recorded in doc §6: no
"command" vertical (decomposes to existing primitives), no `Action` supertype
under Tool. Consumer chain is already live in nx-knowify (Tiptap composer slot
completion + `RunnableRegistry.complete`, commits 312601d6a6d / 990083d90d9 /
4ddd8ce8f8f) and terminates at a `TODO(prompts-complete)` waiting on P2.

### 2026-07-27 (13th) — node10 consumers cannot import ANY subpath

The first real server consumer (`apps/assistant-api` in nx-knowify, a Nest app on
`"moduleResolution": "node"`) failed to build with **47 errors, 37 of them one
cause**: node10 resolution ignores `exports` maps entirely, and our packages ship
only `dist/` plus `exports`, with **no `typesVersions` fallback**. So every
subpath import fails to resolve — `@agentick/transport-http/fetch`,
`@agentick/transport-websocket/server`, `@agentick/app/react`,
`@agentick/timeline/react`, `@agentick/knobs/react`, `@agentick/gates/react`,
`@agentick/skills/hydrators/node`. Proven by trace:

```
======== Resolving module '@agentick/mcp/server' from '/tmp/probe.ts'. ========
Loading module '@agentick/mcp/server' from 'node_modules' folder, target file types: TypeScript, Declaration.
======== Module name '@agentick/mcp/server' was not resolved. ========
```

The failure is worse than it looks, because 27 of those 37 present as
`Module '"@agentick/mcp/server"' has no exported member 'McpRequestContext'` —
members that demonstrably ARE in the published `dist/server/index.d.ts`. An
adopter reading that error hunts for an API that was removed, not a resolution
setting. Runtime is fine throughout: Node honors `exports` regardless of what
TypeScript is configured to do. This is purely a types gap.

`moduleResolution: "node"` is still the default in large established monorepos
and cannot be flipped without a migration, so "tell them to upgrade" is the
Vercel violation — the consumer would be opting into correctness. Fixing it costs
us a generated manifest field. **Every package's `publishConfig` now carries
`typesVersions` derived from its own `exports` map**, with a `scripts/` generator
(idempotent, no hand-maintained list) and an anti-rot sweep in spec-conformance
asserting every published subpath has an entry pointing at a `.d.ts` under
`dist/`.

For the record, the other 10 errors in that build are the CONSUMER's and were
misattributed to us at first glance: three duplicate-`typeorm`-instance
assignability failures, four implicit-`any` parameters, one `import.meta` under
`module: CommonJS` (their own skills-root lookup, not something the framework
asks for), and one `'submit.Tool' cannot be used as a JSX component` — which is
two `@types/react` in their tree (18.3.31 and 19.2.17), not a framework typing
defect. Worth stating plainly so the next person does not chase a phantom.

### 2026-07-27 (12th) — next.20: the browser-safe client door

**LAW: a barrel is single-environment.** No barrel may re-export both a
browser-reachable surface and a Node surface. `@agentick/transport`'s root did
(`export * from "./client"` + `export * from "./server"`), which is what made
`from "@agentick/transport"` look like the obvious import for client code — all
three client transports took it, so every browser bundle carried the whole
server half until it hit `node:crypto` in `web-security.ts` and the build died
with `UnhandledSchemeError`. Found by the first real browser consumer
(k-assistant-v3 in nx-knowify), four hops from anything it imported.

Fixed at two levels rather than at the import site:

- **`CSRF_HEADER` moved to `packages/transport/src/shared/wire.ts`**, exported
  from both doors. A header name is a WIRE fact — the client sends what the
  server checks — and parking it in `server/web-security.ts` is precisely what
  gave the HTTP client a legitimate reason to reach across.
- **The root barrel is now the Node door only.** Client code imports
  `@agentick/transport/client`. This matches every harness package (root =
  server surface, `/client` = the projection) and `@agentick/utils`, which was
  already exemplary — its Node-only code sits behind explicit `/loaders/node`
  and `/path/node` subpaths. **The violation was localized to the transport
  family, not systemic**: all 18 harness `/client` entries were already clean,
  and `skills/src/client/index.ts` even states the law in its docblock.

**Two adopter-facing mechanisms, both zero-config (the Vercel principle — never
make a developer opt into correctness):**

- `transport-http` and `transport-websocket` gained a **`browser` export
  condition** on their root: the same specifier resolves to the client barrel in
  a browser bundle. The dual root stays for a process that owns both halves, but
  a browser gets something that builds, and asking it for `websocketServer` is a
  named-export error that says what is wrong.
- `transport-unix-socket` **denies the `browser` condition** (`"browser": null`)
  on every subpath. Its `/client` is the connecting end of a same-host IPC pair
  and `node:net` there is correct; a web bundler that lands on it now fails with
  "not exported under browser condition" instead of an unresolvable scheme.
  NOT `"browser": false` at top level — that is not a defined form.

**Enforcement:** `packages/spec-conformance/src/__tests__/client-entry-browser-safety.spec.ts`
walks the real module graph out of every browser entry point (each `./client`
subpath, each `@agentick/client*` root, each `browser` condition) and fails on
any reachable `node:` specifier, printing the full import chain. Manifest-driven
(a new `/client` is covered the moment it exists), type-only edges not traversed
(they erase), and the exclusion above is read from the manifest rather than
listed in the test. Confirmed by restoring the bad edge: it reproduced the
original chain verbatim from both affected entries. Every file in that chain is
browser-innocent alone — only the graph is guilty, which is why a per-file lint
would not have caught it.

**Noted, not fixed:** the ROOT `tsconfig.json` currently reports hundreds of
errors (CommandHooks naming drift in app/compiler-react/elicitation tests,
missing DOM lib for client-react tests, structural-mock drift in
gates/knobs/prompts client tests). It is not the gate — `pnpm typecheck` runs
per-package configs and is 103/103 green — but a root config nobody can run is a
config that rots. Worth either fixing or deleting.

### 2026-07-21

- **ROADMAP (2026-07-22, Ryan-approved — the standing task list; work top-down).**
  **Phase A — finish the approved queue:**
  ☐ A1 (IN FLIGHT) 4b steer/follow-up — steer = tick-boundary injection into the RUNNING
  execution (proof: message reaches tick N+1's compiled context); follow-up = true
  settlement (not agent*end). Critical-inspect on landing.
  ☐ A2 4c security-defaults pass (gateway/express bindings): loopback-only default,
  CSRF-in-bootstrap + custom header, Sec-Fetch-Site/Origin rejection, Host allowlist,
  trust forwarded headers ONLY from loopback proxy, realpath-descendant containment.
  SHARPENED (opencode post-mortem, 2026-07-22): never permissive CORS (their CVE class
  — exposed server + CORS * = any website executes shell), no exec-from-URL patterns,
  no curl-pipe upgrade paths.
  ☐ A2.4 (Ryan-approved 2026-07-22, REVISED to instance form) **`createCommandRunner`**:
  a standalone deployable INSTANCE owning the whole command subsystem — the registry
  Map, `command()`/`commandStream()`/`commandEffect()` manufacture (deduping the
  command↔commandStream op-manufacture copy), `commands()` wire-safe listing,
  `get(name)` for dispatchMessage, AND the Phase-2 per-command chunk-interceptor
  lists (command-scoped state lives with the commands). **`runOperation` stays an
  INJECTED capability** (`createCommandRunner({ surface, runOperation })`) — NOT
  absorbed (it drags journal/bus/interceptor-inheritance/tier-4/idempotency with
  it; absorbing = "BaseHarness minus channels", defeats standalone-ness). BaseHarness
  constructs one at creation w/ its bound runOperation and delegates; typed hook
  MINTING stays module-level, runtime registrars delegate into the runner. Tier 2
  (named future, not now): `createOperationRunner` packaging journal+bus+interceptors
  as its own instance — the full depless/ADR-44 substrate. ACs (Ryan): design + impl
  presented for REVIEW before commit; full workspace stays at ZERO failures
  (behavior-preserving); new fake-runOperation unit tests on the declaration logic.
  Signature-preserving; own commit. LAUNCH AFTER the provider-hooks pass lands
  (same-tree discipline).
  ☐ A2.5 prefix-stability conformance test (opencode post-mortem): a STATIC tree must
  compile to byte-identical model input across ticks (prompt-cache invariant we have
  machinery for — CacheHint — but never assert). + doc rule: time-varying content
  belongs in <Ephemeral>/late positions, never the cached prefix; no date injection
  in defaults (we don't — assert it stays that way).
  ☐ A2.6 (docs-only, launching now) policy-vs-boundary stance in user docs: guards/
  confirmation/tool-allowlists are POLICY seams, NOT security boundaries — the
  boundary is the OS-level sandbox provider (Landlock/Seatbelt class). Place in
  sandbox + tool-executor (confirmation section) + gateway/security docs. Also: B1
  example states batch-streaming-updates as a pattern (quadratic-markdown lesson).
  ☐ A3 4d bounded tool-output client projection — never multi-MB to the browser; bounded
  preview at projection, full content stays durable (two-tier).
  **Phase B — the VALIDATION PIVOT (outward-facing; generates the next work list from
  real usage friction — inward work is at diminishing returns):**
  ☐ B1 4e one-shot prompt artifact — "build a codex-style dashboard on
  @agentick/client-next" exercising timelineView/elicitations/clientToolCalls/knobs/
  fakes. Every hedge the prompt needs = a discovered ergonomics defect. This IS the
  Ernesto-class validation.
  ☐ B2 UPGRADED (Ryan 2026-07-22: handles feel "made at 4 different times by 4
  different teams" — historically TRUE, four separate passes, no cross-cutting
  owner): the deliverable is the STANDARD, not just fixes — (i) a normative
  ClientHandle contract (the client twin of the Store/View taxonomy); (ii)
  **runClientHandleConformance** — a shared suite every package's /client handle
  MUST pass (the spec-conformance enforcement mechanism applied client-side; a
  future fifth handle cannot diverge); (iii) the four existing handles refactored
  onto it incl. timelineView → session.timeline (it's a free factory today — not
  even a sub-handle), loose routeClientTools/confirmClientTools folded onto the
  clientToolCalls handle as verbs, knobs key→id; (iv) ADR-87 registration stays
  (already uniform — the incoherence is contract-level, one level up). Design-first:
  the contract doc goes to Ryan BEFORE any handle moves.
  = the **CLIENT API CONSISTENCY + DISCOVERY arc** (Ryan 2026-07-22: "the client
  needs some work vis a vis ergonomics and apis" — converges with B1's meta-finding).
  Design-first (Ryan reviews the design), then implement: (a) ONE core handle
  contract across ALL client sub-handles — `list()/get(id)` (current state) +
  `onChange()` + async-iterability-as-sugar + domain write verbs — unifying the
  collection-shaped (tasks/knobs) and request-stream-shaped (elicitations/
  clientToolCalls) handles. KEY INSIGHT: a pending elicitation/tool-call is STATE
  keyed by correlationId, not just an event — live-only streams violate
  enumeration-is-foundational; a client connecting mid-ask must see it. Needs
  server-side pending-request enumeration/snapshot-first (friction #9). (b) fold in
  friction #1 (KnobDescriptor[] on the wire — labels/types/bounds, not just values),
  #2 (first-party session/timeline*history + lazy prepend), #13 (client knobs
  key→id), (c) decide #6 (first-party @agentick/client react bindings — useTimeline/
  useKnobs/useElicitations one-liners once the contract is uniform) + convenience
  sugar (session.onElicitation(cb)) ONLY after the contract lands. Friction #4 docs
  fixed (aaccee4c); #10 dangling queue already TODO'd (4b).
  ☐ B2.x **KNOWN GAP — tree-side transform/guard hooks (the unfinished half of ADR-89
  §4)**: the React useOn* hooks are OBSERVE-only projections (real command lifecycle,
  catch-up, unsubscribe — all landed). NOT built: components as full participants —
  `useGuardToolDispatch` (veto/defer a tool call from render state — the <ToolGate>
  confirm-dialog case), `useTransformModelInput`, and arbitrary-command registrars
  from the tree. Mechanism proven (callbacks-via-ref + awaited-in-cascade, §4
  validated it for the settle); the React registrars were never written. PULLED by
  Ernesto/assistant-api when a component needs to intercept, not just see.
  ☐ B2 BUILD-OUT ORDER (Ryan-weighted 2026-07-22): slice 2 server truths (IN FLIGHT)
  → slice 3 THE CLIENT HANDLES (headline: 4 handles onto the contract + .route/
  .confirm folded + session.timeline re-home) → slice 4 CLIENT MIDDLEWARE (promoted:
  client.use()/per-handle use() + frame tap, consolidate embryonic client-core
  machinery) → slice 5 EMBEDDED GATEWAY (promoted from C4.5: gateway.handler w/
  identity seam) → React one-liners ride when trivial. migrateSnapshot config move =
  a two-line rider, not a headline (Ryan: "don't care a lot right now").
  ☐ B3 **THE BUILD PIVOT (Ryan 2026-07-22: "finish up today's work and get to
  building")**: after B2 slice 1 (contract+conformance) lands, START BUILDING —
  Ernesto AND assistant-api on agentick v2. B2 slices 2+ (server prereqs, handle
  refactors, session.timeline re-home, React bindings) are PULLED by what the real
  apps hurt on, not pushed from the design doc — every refactor lands with a living
  consumer. The five principles + the converged contract (list/get/subscribe/verbs,
  floors-not-ceilings) govern; the apps are the design instrument from here.
  **Phase C — v2.0-cut checklist (assemble + then walk; items in one place so the cut
  is a checklist walk, not archaeology):**
  ☐ C1 XHarness→X class-suffix sweep (LanguageModelExecutor→ModelExecutor,
  ToolExecutorHarness→ToolExecutor, …) — batched rename, workspace-wide gates.
  ☐ C2 pnpm 10→11 upgrade + native versioning (drop @changesets/cli; versioning.fixed
  for the @agentick/\* family; evaluate a `next` lane; ledger for main↔feat/v2).
  ☐ C3 <Skill> RuntimeDeclarations slot decision (MEDIUM rec: dynamic/scoped
  availability is the real withSkills gap) + <Prompt> = LOW, <Guard> = NO.
  ☐ C4 devtools package attention (Ryan-flagged).
  ☐ C4.5 **GATEWAY EMBEDDING (Ryan 2026-07-22, from the Hono-MCP pattern):** mount the
  gateway INTO existing server frameworks (Hono/Koa/Express/NestJS) instead of only
  owning the port via listen(): a `gateway.handler()` / handleRequest-style surface —
  ideally the web-standard fetch shape (Request => Response | ReadableStream for SSE)
  so ONE handler mounts everywhere (`app.all("/agentick", (c) => gw.handler(c.req.raw))`)
  and adopters use their framework's middleware ecosystem (auth, logging, rate limits).
  Less standalone, more embeddable. NOTE: the A2 security policy applies MORE, not
  less, when embedded (forwarded-header trust, Host/Origin — the adopter's framework
  sits in front; document the trust handoff). Likely shape: a `fetchTransport()` /
  handler-mode on transport-http sharing resolveWebSecurity + dispatchRequest — the
  funnel already exists; this is a new entry door, not a new pipeline.
  **IDENTITY SEAM (designed w/ Ryan 2026-07-22):** `gateway.handler({ identity:
async (req) => Identity | Response })` — the host app's EXISTING auth runs in
  front; the callback hands us the RESULT (never tokens): { principal → ADR-48
  stamping, user → RuntimeContextUser (credentialKey/structural identity just
  work), scopes → the authorizer }. Three existing destinations, one injection
  point, zero new identity machinery. Returning a Response = their rejection
  shape. Streams bind identity at connect; req-res re-resolves per request. Our
  CSRF/Host checks stay ON by default in embedded mode; explicit
  `security: "host-managed"` opt-out w/ the trust handoff documented (silent
  relaxation = the opencode CVE class).
  ☐ C5 OpenAI Responses API — SEPARATE adapter, NOT a migration (Ryan-decided
  2026-07-22): `openai()` = Chat Completions default (the compat lingua franca —
  vLLM/Groq/Together speak it; 90%+ of users stay on the stable path),
  `openai.chat()` = explicit alias, `openai.responses()` = the Responses adapter.
  Two definition objects via defineLanguageModelAdapter sharing client/auth but
  with SEPARATE pure transforms — no mode-flag straddle through one pipeline.
  Responses unlocks: executedBy:provider:openai (typed web_search_call/
  code_interpreter_call items — the discrete tool-result blocks Chat Completions
  lacks), full provider-tool results, semantic streaming events, reasoning items.
  Deliberate non-use: previous_response_id server-side state (our timeline is the
  source of truth). Not urgent — note, don't build.
  ☐ C6 ai-sdk provider-tools request-half (provider→factory registry).
  ☐ C7 Anthropic SDK bump (replace the optimistic local wire types w/ SDK types).
  ☐ C8 docs/website sweep + New-Package-Checklist refresh for -next packages.
  ☐ C9 tool:dispatch→tool:execute rename + TODO(adr-80) output type (turnkey, from the
  ergonomics pass). Also: TODO(task-wake) narrow-the-catch; TODO(spawn-lifecycle)
  spawn_start/end; session-scoped chunk interceptors (phase-2+).
  **Standing discipline:** agents build (Opus), I judge critically (diff review, gates
  re-run, mechanistic root causes), every pass commits against the ZERO-FAILURE
  workspace bar (4308/0 as of fc97dcf7).

- **WORK QUEUE (2026-07-22, systematic — Ryan: "significant progress today").**
  In flight: PA1–PA3 (bounded registry LRU/idleTimeout + app signal cascade). Then:
  (1) SP4–SP6 spawn hardening (MAX_SPAWN_DEPTH crash vector, parent-abort→child
  teardown, spawnPath plumbing); (2) SW6 chat-UX backlog filing (LineEditor/
  AttachmentManager/chat-transforms — file the issue, don't build); (3) **TASK-WAKE
  SEAM (new, from unified-exec/codex analysis):** task-completion → session wake — a
  backgrounded task finishing while unobserved synthesizes exactly ONE follow-up send
  (bounded metadata, no raw output) into the session; consume-on-observe dedup (a
  completion seen directly by a tool result CONSUMES the wake — exactly-once between
  in-band + out-of-band paths); shape it per seam-over-setting (a wake option on task
  submission or a session-level policy callback, NOT a config subsystem); small pass on
  tasks-next + loop/session. Agentick can already express unified-exec's whole tool
  surface (Pattern B tasks + sandbox + stdin tool) — the wake is the ONE missing
  capability. (3b — ALREADY LANDED 2026-07-09 f72508bb; parity+provenance tests added 76783219) **TOOL-RESULT CURRENCY unification (Ryan-confirmed):** widen SERVER
  handler returns to the ADR-70 currency (`string | ContentBlock[] | envelope{content,
structuredContent?, isError?, metadata?}` | TaskHandle) — today only client-relayed
  results accept it (asymmetry). Normalize ALL results to the canonical envelope at the
  dispatch boundary (`normalizeToolResult` already exists — move/reuse at the one point),
  advertise the canonical shape + use it internally. Handler-declarable ≠ executor-stamped:
  `executedBy`/`durationMs`/presentation stay executor-only (provenance-spoof rule, same
  as ClientToolAnnotations exclusion). Additive — bare ContentBlock[] stays valid (union
  member). (4) remaining audit ergonomics (tracker — IN FLIGHT); **(4b–4e, Ryan-approved from the
  Pi-post analysis 2026-07-22):** (4b) **steer/follow-up semantics** — first-class
  mid-execution steering: steer = injected after the current turn's tool calls BEFORE the
  next model call within the SAME run (the injection point exists structurally now —
  `loop:tick` command boundary / a queue drained at tick start); follow-up = waits for
  settlement (weigh promoting `whenQuiescent()` to a true session-quiesced signal — a
  queued follow-up is a separate execution today); (4c) **security-defaults pass** for
  the server bindings (gateway/express): loopback-only bind default, CSRF-in-bootstrap +
  custom-header requirement, `Sec-Fetch-Site`/Origin rejection, Host allowlisting, trust
  forwarded headers ONLY when the immediate proxy is loopback, realpath-descendant (not
  string-prefix) root containment — documented defaults, not adopter homework; (4d)
  **bounded tool-output client projection** — never push multi-MB tool results to the
  browser; bounded preview at the client projection, full content stays in the durable
  store (two-tier already supports it); (4e) **one-shot prompt artifact** — "build a
  codex-style dashboard on @agentick/client-next" exercising timelineView/elicitations/
  clientToolCalls/knobs/fakes — the Ernesto-class demo AND a continuous ergonomics audit.
  (5) candidates after: OpenAI
  Responses API, devtools attention, ai-sdk request-half, XHarness→X sweep,
  app-harness flake fix, Ernesto (gate met).

- **Contributor derivation pass LANDED (all 16, no stragglers).** Every contributor now
  derives props from its spec type (`Omit<Spec,supplied> & deltas`), spread-forwards all
  fields, and carries a type-level conformance assertion
  (`Exhausted<UnhandledSpecKeys<Spec,Forwarded,Supplied>>`, shared helper
  `spec-conformance.ts` — a new spec field fails tsc at the contributor until triaged;
  teeth verified via deliberate TS2344). THREE drift classes found+fixed: tool dropped
  `aliases`+`providerOptions` (4 surfaces fixed: contributor, jsx-intrinsics,
  ReactToolSpec/<Tool>, base createTool); model dropped `topP`/`frequencyPenalty`/
  `presencePenalty`/`stopSequences`; jsx-intrinsics heavy drift (custom/csv/xml-block/
  mcp-websocket/system_event-severity + missing fields) — all aligned, grep-proved no
  consumer breakage. NEW `provider-tool` contributor + `<ProviderTool>` component →
  `declarations.providerTools` (closes the Pass D sugar TODO; loop already reads the
  slot). 3 justified local interfaces remain (content passthrough, project, semantic-html
  — documented). Ownership convention in compiler README (both sides derive from spec;
  ContributorRegistry escape hatch; compiler never depends on a harness).
  **Recommendation table for Ryan (report-only):** `<Skill>` = MEDIUM (dynamic/scoped
  availability is a real withSkills gap — skills appearing with a mounted subtree);
  `<Prompt>` = LOW (no tree position; bundling only); `<Guard>` = NO (category error —
  guards intercept operations, not positioned content). Gates: typecheck --force 152/152
  0-cached; 932 tests; oxlint 0 errors (1 pre-existing warning).

- **executedBy provenance — Anthropic optimistic + MCP stamping LANDED.** PASS A:
  local wire-shape interfaces (docblocked "replace on SDK bump" — SDK 0.39 doesn't type
  server tools) structurally detect `server_tool_use`/`web_search_tool_result`;
  results surface as ToolResultBlocks stamped `provider:anthropic` w/ interned
  Sources/citations; the request-half NEVER reaches `toolCalls` (structural exclusion —
  the extractor matches `"tool_use"` exactly; tested). Fixture exception documented
  (typed vs OUR wire interfaces). openai (Responses-API TODO stays)/google (metadata by
  design)/ai-sdk untouched. PASS B: `ToolAnnotations.executedBy?` (declaration-level
  provenance seam); `mcpDeclaration` stamps `mcp:<serverId>`; the server SUCCESS site
  reads `annotations?.executedBy ?? "agentick"`. SPOOF-PROOF ×2: excluded from
  `ClientToolAnnotations` + `toClientToolRegistration` strips a smuggled value at the
  wire fold (raw JSON bypasses TS excess-property checks); client path stays hardcoded
  `"client"`. **My correction over the agent:** the confirmation-DENIAL site reverted to
  hardcoded `"agentick"` — a denial is produced by the gate, the tool never ran;
  `mcp:<serverId>` would claim an execution that never happened. +16 tests. Gates:
  typecheck --force 152/152 0-cached; 1151 tests; oxlint 0 errors (2 pre-existing).
  executedBy state: agentick ✓ client ✓ provider:anthropic ✓(optimistic) mcp:<serverId> ✓;
  provider:openai needs Responses API; google = never (by design); ai-sdk = can't name.

- **reconciler → compiler RENAME LANDED (#243).** The JSX/tree→IR subsystem's public
  identity is now "compiler" ("reconciler" was React-fiber jargon leaked into the API).
  114 git-detected renames: `packages-next/{reconciler→compiler, reconciler-react→
compiler-react}` (`@agentick/compiler-next`/`compiler-react-next`), spec
  `protocol/reconciler.ts→compiler.ts`, ALL subsystem identifiers `Reconciler*→Compiler*`
  (Protocol/Harness/Container/Snapshot/defineCompiler/reactCompiler/
  replaceCompilerTools/…), `RunExecutionInput.reconciler→compiler`. Data surfaces (locked,
  no-compat): ToolBinding `scope:"reconciler"→"compiler"` + PRECEDENCE_RANK; EventSurface
  `"reconciler"→"compiler"`; op-name literals `compiler:command:*` (forced by the
  `${surface}:` prefix requirement — coupled, unlike the deferred executor case).
  AVOID-LIST held: `react-reconciler` npm dep + ReactReconciler/FiberRoot + provenance
  comments intact (12 refs, 0 `react-compiler` corruption). Driver judgment call approved:
  internal `Reconciler`→`Compiler` in `react/compiler.ts` (ours, not the library).
  Blueprints keep filenames + got rename notes; all READMEs/website config swept.
  Gates: pnpm install re-link; typecheck --force 152/152 0-cached; 897 tests incl
  kill/resume; oxfmt 264 files clean; oxlint 0 errors; unfiltered greps = only blueprint
  filename refs. **The locked queue is COMPLETE:** stage 3 ✓ narration ✓ ADR 89 §1-§4 ✓
  chunk hooks ✓ streaming-up ✓ compiler rename ✓.

- **Streaming-up LANDED — `loop:run-execution` is a commandStream; onEvent RETIRED.**
  The loop's execution events are first-class chunks: `commandStream<RunExecutionInput,
LoopExecutionEvent, ExecutionTerminal>` (renamed `LoopEmittedEvent`→`LoopExecutionEvent`
  — "Emitted" encoded the retired push mechanism; + `LoopExecutionSink` alias). ONE
  channel, no straddle: `RunExecutionInput.onEvent` DELETED, `TickInput.onEvent`→`emit`
  (required), ~11 emit sites → sink; facade = the `.run` drain face;
  `LoopExecutorProtocol` dropped PromiseView (explicit drain-only facade). Session:
  `buildOnEvent` kept verbatim, wrapped as `loopSink` passed as fx's 2nd arg — STILL
  inside the §4+§2 `withCallMiddleware` (tier-4 threads via runOperation, verified).
  `SessionExecutionHandle` unchanged for users. **Payoff:** `onLoopRunExecutionChunk`
  minted free (registry `chunk:` field) — new spec proves an observer taps run+tick
  events even on the drain-only facade; event-ordering characterization now captures
  VIA the chunk observer, same assertions green. Fakes/conformance/README current
  (define-loop + stubLoop accept+ignore the sink). Unfiltered onEvent grep: only
  cluster-bus callbacks, substring matches, the session's private helper, and 4
  retired-refs doc comments — zero live accesses (typecheck corroborates). Gates:
  typecheck --force 152/152 0-cached; 1039 tests incl kill/resume green; oxfmt/oxlint 0.
  send-as-commandStream deliberately NOT pursued (handle already stream+result; seam is
  sendBody's emit machinery if ever wanted). **NEXT: reconciler→compiler rename.**

- **setModel(adapter) overload LANDED (ergonomic parity w/ construction).**
  `session.model.setModel` now takes `RegisteredModel | LanguageModelAdapter`; both
  normalize to RegisteredModel BEFORE `session:set-model` (veto sees identical input;
  method now async). Injected-builder design: `SessionHarnessOptions.buildModelExecutor?`
  — the APP wires the closure (same LanguageModelExecutor-on-app-substrate path as
  construction, live resolvedInterceptors + interceptorParent); session stays
  adapter-agnostic. BYO-executor apps (no builder) → typed
  `ModelExecutorBuilderMissingError` (SessionError family, thrown pre-command). +5 tests
  (3 facade, 2 e2e via createApp). Gates: typecheck --force 152/152 0-cached; touched
  tests green; oxfmt/oxlint clean. **KNOWN FLAKE (pre-existing, verified on clean HEAD
  by stash):** `app-harness.spec.tsx` "filters by surface" + "invokes an ExecutorFactory"
  — 30s timeouts under load, fail with AND without this change; fix separately.

- **Phase-2 chunk hooks LANDED (commandStream per-chunk interception).** The v1-style
  chunk capability on the streaming-command primitive: `ChunkInterceptor` = `{observe}`
  (tap) | `ChunkTransform {onChunk(chunk,emit,ctx), onFlush?(emit,ctx)}` (map/drop/fan-out/
  COMBINE — emit 0..n). Minted per streaming command via `deriveChunkHookName` →
  `hooks.onModelGenerateStreamChunk(...)` + declarative `hook({...})` + programmatic
  `commandStream({chunk:[...]})` (def entries compose closest to body). Sink-wrapped
  INSIDE `streamFx` — the one closure behind all THREE faces (stream iterator, fx in-fiber
  sink, registry run), so every consumer incl. the loop sees TRANSFORMED chunks.
  **Flush-on-terminal:** flush walks stages in order after the body's last emit, BEFORE
  onAfter (tested via fx-sink snapshot); on abort the interrupted body never reaches flush
  → no bogus tail (tested). **Zero-overhead:** empty list → raw sink, no pipeline (tested
  incl. unsubscribe-restores). No per-chunk guard (raising transform covers it).
  Session-scoped chunk interceptors TODO(phase-2+) (harness-local by design for now).
  +2 e2e on the real executor (observe every AdapterDelta; uppercase content-delta
  transform); +1 conformance vs real+fake+4 providers. Gates: typecheck --force 152/152
  0-cached; 858 tests; oxlint/oxfmt clean. **QUEUED NEXT: setModel(adapter) overload
  (injected-builder, ergonomic parity w/ construction) → loop/session streaming-up →
  reconciler→compiler rename.**

- **§2 session.model facade LANDED — ADR 89 COMPLETE (§1 ✓ §2 ✓ §3 ✓ §4 ✓).**
  `session.model` (`ModelSelectionHandle`, `session/src/model-facade.ts`, module-augmented
  slot — NOT a new harness, per the revised ADR): `.current`; `.setModel/.setTarget` via
  new session command `session:set-model` (mints `onBefore/AfterSessionSetModel`, journaled;
  a throwing onBefore vetoes the swap); `.use/.guard` = session-scoped interceptors on
  `model:generate[_stream]` that PERSIST across swaps — they live on the facade and fold
  into the SAME `withCallMiddleware` as §4's projection (harness.ts:1626-1635), so the
  ADR-77 spine threads them to whichever executor issues the call (op-scoped via
  deriveHookNames tags, guard composed outermost via tagInterceptor/signalFromVerdict —
  additive runtime re-exports). Precedence unchanged + proven: per-tick `<Model>` >
  per-send > swapped default; swaps picked up next send (per-send capture). 6 new tests
  incl. the payoff (use+guard registered once, applied across a swap); define-session's
  CallbackSessionHarness brought current. Gates: typecheck --force 152/152 0-cached;
  539 tests incl kill/resume green; oxfmt/oxlint clean. **NEXT (order locked): Phase-2
  chunk hooks → loop/session streaming-up → reconciler→compiler rename.**

- **§1 fx.run command gap CLOSED.** The non-streaming `fx.run` now composes project →
  the `model:generate` COMMAND → normalize (`commandEffect` in-fiber, parentOpId threads,
  interruption propagates) in BOTH real + fake executors — non-streaming ticks now fire
  `onBefore/AfterModelGenerate` + guard + journal; `useOnModelGenerateStart/End` project
  on non-streaming ticks (lifecycle-bridge assertion flipped from gap to proof). Design
  call (correct): a `guardGenerate` veto on `run` folds to a **vetoed TERMINAL**, not a
  rejection — `run` returns `ExecutorTerminal` and the loop pattern-matches it without
  `Effect.either` (matches the existing ProviderAborted→canceled fold; unifies real +
  fake-scripted vetoes). Shared folds in `executor-lifecycle.ts`
  (`operationOutcomeToTerminal`, `isFoldedTerminal`). Conformance +2 (non-streaming hooks
  - guardable run, vs real AND fake). `adr-89-phase-next` grep = 0. Gates: typecheck
    --force 152/152 0-cached; 750 tests incl kill/resume green; oxlint 0 errors. **§1 is
    now fully closed. NEXT: §2 session.model facade.**

- **Lifecycle projection LANDED (model-harness §4) — LifecycleStore RETIRED.** React
  `useOn*` hooks are now projections of the REAL command lifecycle. New
  `session/src/lifecycle-projection.ts` (`wireLifecycleProjection`, session constructor =
  composition root, disposed on close): loop hooks (`onBefore/AfterLoopRunExecution` →
  execution-start/end fire-and-forget; `onBeforeLoopTick` → tick-start AWAITED;
  `onAfterLoopTick` → tick-end THE SETTLE, awaited in-cascade — before terminal → before
  decide, ADR-67 preserved by construction); tool-executor around-middleware
  (`onToolDispatch` → tool-start/end + narration/presentation, loop-driven only);
  **model hooks via ADR-76 tier-4 call-scoped middleware** (`withCallMiddleware` around
  `loop.fx.runExecution`) — solves the per-tick swapped `<Model>` executor (outside the
  interceptorParent tree; the one-fiber spine threads call middleware to WHICHEVER
  instance issues `model:generate[_stream]`). Events land via optional capability
  `LifecycleProjectionTarget.dispatchLifecycle` (feature-detected, NOT a ReconcilerProtocol
  method). Error source: in-process interceptors (onAfter doesn't fire on failed terminals;
  executor failure = failed-terminal TickResult as data, tool failure = around-catch) —
  `useOnError` gets its FIRST real producers. DELETED: `lifecycle-store.ts` (−278; replaced
  by thin `LifecycleDispatch` — per-mount dispatch + catch-up cache + custom-kind path),
  loop's 7 notifyLifecycle sites, `ReconcilerProtocol.notifyLifecycle` (spec test asserts
  the key is GONE). Gates' `notifyTickEnd` seam untouched. NEW: `useOnModelGenerateStart/
End` hooks (streaming ticks only — **found a §1 gap:** non-streaming `fx.run` bypasses
  the `model:generate` command in real+fake executors, `TODO(adr-89-phase-next)` at both
  sites). Barrier proofs: settle<after<decide w/ macrotask, knob-mutation-seen-by-decide,
  per-mount routing on a shared loop, unsubscribe-on-close. Gates: typecheck --force
  152/152 0-cached; 1085 tests incl kill/resume verbatim-green; oxlint/oxfmt clean;
  unfiltered notifyLifecycle grep = only the ADR-67 session seam + history. **Arc: §1 ✓
  §3 ✓ §4 ✓ — remaining: §2 session.model facade; fx.run command-gap; Phase-2 chunk hooks;
  loop/session streaming-up; reconciler→compiler rename.**

- **Tick-as-command LANDED (model-harness §3, `loop:tick`).** The per-tick round is now a
  declared command on the LOOP harness (ADR-89 open question resolved: the loop owns tick
  orchestration; the model-executor owns the single model call). `this.command<TickInput,
TickResult>({ name: "loop:tick", exposure: "internal" })` — mints `onBeforeLoopTick`
  (over TickInput: tickId/tickIndex identity first, then the live refs
  reconciler/modelExecutor/toolExecutor/… exactly as RunExecutionInput carries them;
  in-process only, never wire-addressable) and `onAfterLoopTick` (over the settled
  TickResult). **Settle IN / decide OUT:** the command body = render → model → tool →
  apply → SETTLE (reconciler tick-end); the DECIDE (notifyTickEnd fold, stop-force >
  continue-force > abstain, maxTicks) stays in the run-execution while-continuation AFTER
  onAfterLoopTick — ADR-67 order proven by the new "settle < onAfter < decide" test. **The
  tick barrier IS the command terminal** (`yield* commandEffect("loop:tick", …)` in the
  run-execution fiber — ADR-77 one-fiber, parentOpId auto-threads, interruption
  propagates). Model-call failures return a `failedTickResult` (no settle) with
  byte-identical outcome→stopReason mapping. `notifyLifecycle` deliberately LEFT in place
  (tick-start/end transiently fire both the command hooks AND the notifies) — §4 collapses
  it. Telemetry delta (legitimate): a loop `.use` middleware now wraps run-execution AND
  tick (`wrapped: 2`) — the tick is a real op now. Gates: typecheck --force 152/152
  0-cached; 679 tests (loop 58, session 103 incl kill/resume HARD GATE green 8|4pg-skip,
  runtime 301, reconciler-react 217); +tick-command.spec (3: N-ticks-N-commands+payloads,
  barrier, settle-in/decide-out); oxlint/oxfmt clean. **§4 now unblocked with NO straddle:**
  every lifecycle event (execution/tick/tool/model/error) is command-backed — project the
  React useOn\* hooks onto the command-hook system and DELETE LifecycleStore + the
  notifyLifecycle feeds.

- **Model-executor command-ification LANDED (model-harness §1, Phase 1B).** The model
  call is now a real command: `execute → model:generate` (`this.command`),
  `executeStream → model:generate_stream` (`this.commandStream`), so the per-tick model
  call finally mints + fires `onBefore/AfterModelGenerate[Stream]` + `guardGenerate` +
  journal — the actual §1 payoff (streaming itself was already plumbed via the send
  handle). **`commandStream` extended (1A→1B):** now returns a `StreamCommand<I,Chunk,R,E>`
  with THREE faces over the ONE cascade-wrapped body — `fx(input,sink)=>Effect<R>` (the
  cascade-wrapped sink-fold the LOOP consumes in-fiber, so the model call rides the
  interceptor cascade), `stream(input)=>AsyncStream<Chunk,R>` (public queue form, now
  threading a `def.stream` streaming-edge policy — resolves the 1A phase-2 TODO), and
  `run(input)=>Promise<R>` (inbox drain). The loop harness is UNCHANGED (still
  `fx.executeStream(input,sink)`); the routing moved inside the executor's fx →
  `modelGenerateStream.fx`. `project`/`normalize`/`run` stay Operations, renamed
  `executor:* → model:*` (finishes the rename-pass transient — command forces
  surface=`this.surface`="model"). **Conformance robust** (`spec-conformance/executor.ts`,
  runs vs BOTH real + fake): model:generate mints/fires onBeforeModelGenerate,
  guardGenerate vetoes execute() while leaving project() untouched, streaming yields the
  iterator + fires onAfterModelGenerateStream, envelopes carry model:command:generate, no
  executor:\* op surface survives. **Fakes/stubs current:** FakeLanguageModelExecutor
  command-ified identically (shared `generateBody`, passes the same conformance);
  `/testing` scripted-adapter audited (pure adapter, no change); adapter executor specs +
  benches (openai/google/anthropic) updated to surface="model". **kill/resume HARD GATE
  green** (8 passed | 4 pg-skipped). Gates: typecheck --force 152/152 0-cached; 830 tests;
  oxlint 0 errors (2 pre-existing anthropic warnings). Note: the 10 `executor:command:run`
  literals remaining are generic query-compiler/bench MATCHER fixtures (arbitrary sample
  namespace, self-consistent w/ paired negative assertions) — NOT stale op names; left
  deliberately. **NEXT:** Phase 2 (per-chunk `onModelGenerateStreamChunk` observe/
  transform/combine + flush-on-terminal); then loop/session as `commandStream` (streaming
  all the way up); compiler-hooks (§4).

- **`commandStream` substrate primitive LANDED (model-harness §1, Phase 1A).** First-class
  STREAMING command in `BaseHarness` (`commandStream<I,Chunk,R,E>`) — the fusion of
  `command`'s registry registration (mints `onBefore/After<Verb>` via ADR 80) +
  `runOperation`'s interceptor cascade + `runHarnessStream`'s async-iterator bridge. Body
  `(input, sink) => Effect<R>` emits chunks + returns the final R; ONE cascade-wrapped
  `streamFx = runOperation(op, (i) => body(i, sink))` reused by both consumption modes —
  the streaming facade (`runHarnessStream((sink) => streamFx…)` → `AsyncStream<Chunk,R>`)
  and the inbox-addressable registry `run` (no-op sink drains to R). NO second interceptor
  path. **Effect mechanics confirmed:** `Queue.bounded` + `Effect.forkDaemon` (NOT
  `Effect.Stream`) — the daemon fiber stays live for the whole stream, backpressure via the
  bounded queue, `forkDaemon` inherits the parent FiberRefs so ambient `getContext()` works
  throughout; abort interrupts the op fiber (no bogus terminal). **Phase 1A = boundary
  hooks + iterator ONLY;** per-chunk hooks (`onModelGenerateStreamChunk` observe/transform/
  combine, sink-wrapped before the queue so the iterator sees transformed chunks; needs a
  flush-on-terminal contract for combine) are Phase 2 (TODO(phase-2) trailhead planted).
  14 deep tests (`command-stream.spec.ts`): hook minting, boundary ordering
  (before→chunks→after→terminal), guard-vetoes-before-any-chunk (body never runs), abort/
  kill-mid-stream (parks on `Effect.never` + interrupt handler proves interruption, no
  onAfter, zero terminal:succeeded), async-iterator contract, registry-`run` drain,
  transform-over-input/output, zero-overhead. Gates: typecheck --force 152/152 0-cached;
  298 runtime tests; oxlint/oxfmt clean. **OPEN THREAD (decide holistically):** explicit
  ctx-into-body (`body: (input, sink, ctx)`) — today ctx is ambient in the body / explicit
  in middleware; if adopted, land it on `command` + `commandStream` together, not just the
  stream. **NEXT — Phase 1B:** model-executor command-ify (`execute→model:generate`,
  `executeStream→model:generate_stream`, `executor:*→model:*`), fake + `/testing`
  scripted-adapter + conformance current, loop invocation, kill/resume, README/docs.

- **ADR 89 REVISED + `executor → modelExecutor` rename (model-harness arc, pre-work).**
  Corrected ADR 89's stale premise: it claimed "the model is not a harness," but
  `LanguageModelExecutor extends BaseHarness<"executor">` already — session-owned
  (`session.executor`), per-send overridable, per-tick resolvable (ADR 56). Rewrote
  the ADR around the REAL gap (the model call is a `runOperation` Operation, not a
  `this.command` → no `model:generate` hooks/guard/journal) + added an "Actual
  architecture" section: **session = composition root** (owns reconciler /
  model-executor / toolExecutor / stateApplicator / models / loop as siblings, DI'd
  into the loop); **loop = orchestrator** (owns none; drives the injected siblings).
  Layering `RegisteredModel ⊃ modelExecutor ⊃ adapter`. Decision reframed: command-ify
  the EXISTING model-executor (no new `ModelHarness` layer — rejected as over-layering;
  hooks resolve by NAME so they survive per-tick executor swaps); model selection/swap
  = a `session.model` FACADE over what the session already owns, NOT a new harness
  sibling (escape hatch: promote to a real harness only if cluster addressability /
  its own lifecycle FSM is needed). **Naming — it's the model-executor** (sibling of
  `toolExecutor`): running the SURGICAL rename `session.executor → session.modelExecutor`
  - harness type `"executor" → "model"` (the `"executor"` surface has NO production
    consumers — contained). AVOID-LIST (overloaded look-alikes, DO NOT touch):
    `executorFactory`, `executorTerminal`, `executorKind`/`executorState` (tasks),
    Postgres `QueryExecutor`/`.executor` (tasks-store-postgres, timeline-postgres),
    sandbox executor, `toolExecutor`, `tickExecutor`, `ExecutorProtocol` (generic family
    protocol — kept), `LanguageModelExecutor` CLASS (kept; class rename batches with the
    deferred `XHarness → X` suffix sweep). `session.modelExecutor` (runner) ≠ `session.model`
    (selection facade) — distinct concepts. **Package renamed too** (symmetry with
    `@agentick/tool-executor-next`): `git mv packages-next/executor → packages-next/model-executor`,
    `@agentick/executor-next → @agentick/model-executor-next`, 89 importers updated (+ website
    vitepress group, `pnpm install` re-link). LANDED: field/type rename (18 src, 48 test, 9
    READMEs — the agent caught a private-field-cast runtime bug via vitest that typecheck
    couldn't) + package rename. Gates: typecheck --force 152/152 0-cached; 1477 tests
    (model-executor+session+loop+app+spec+model+mcp); oxfmt/oxlint clean. **Transient
    (aligned by the command-ify pass, ADR 89 §1):** harness type is `"model"` but the emitted
    operation-event surfaces stay `"executor:*"` (literal on the Operation objects, decoupled
    from `this.surface`) — `model:generate` command-ification renames them. **Not renamed
    (deliberate):** `LanguageModelExecutor` class, `ExecutorProtocol`, `family="language-model"`,
    all Postgres/sandbox/tasks `executor` look-alikes.

- **Pass B narration TUNING LANDED (terse `_summary` + `withMCP({narrate})` opt-out).**
  Two token-cost cuts. (1) The injected `_summary` schema description dropped from 24
  words w/ an example to 12: "One short first-person sentence describing this call,
  shown to the user." — injected into EVERY model-facing tool schema every request, so
  every word is per-tool-per-tick. (2) `withMCP({ narrate: false })` + per-server
  `narrate` opt-out: MCP tools narrate by default like any tool; `false` stamps
  `annotations.narrate: false` on the declaration (`mcpDeclaration`) so `buildTools`
  skips `_summary`. Per-server overrides the withMCP default; `undefined` at both = ON.
  Threaded `options.narrate` → `discoverAndRegisterTools(config.narrate ?? default)` →
  `mcpDeclaration` (merges narrate:false without clobbering mapped taskSupport / the
  tool's own annotations). `mcpDeclaration` module-exported for a focused mapping test
  (not on the public index); the buildTools-skips-`_summary` half is already covered by
  narration-injection.spec. Gates: typecheck --force 152/152 0-cached; 645 mcp+model
  tests (+4 narrate-opt-out); oxlint 0.

- **Client-tools STAGE 3 LANDED (client-side router + confirmation policy).** The
  first client REQUEST-channel consumer (stages 1/2 were executor-native handling +
  the declarative `set_client_tools` write verbs). Mirrors `@agentick/elicitation-next/client`.
  Three surfaces under `@agentick/tool-executor-next/client`: `session.clientToolCalls`
  (a `ChannelStream<ClientToolCallHandle>` — async-iterable + onChange over
  `TOOL_CALL_CHANNEL_FQN`; each handle `{ toolCallId, name, input, correlationId:
string|undefined, respond }`); `session.routeClientTools(handlers, {onUnknown?})`
  (dispatch by name → auto-respond; throw/unknown → `{isError:true}` result, never
  leaves a suspended call hanging; returns Unsubscribe); `session.confirmClientTools(policy)`
  (`"approve"|"deny"|(req)=>boolean` over `tool_confirmation` elicitations). **Two
  correctness catches over the spec (lift-heavy):** (1) approval is `accept({ approved:
true })` NOT `accept({})` — the gate (`harness.ts:877`) requires `accepted &&
approved===true`, so `{}` would silently DENY (verified vs `confirmation-schema.ts`).
  (2) `correlationId: string | undefined` — fire-and-forget relays (stage-1 non-
  `requiresResponse`, one-way `notifyChannel`) carry none; those frames still surface +
  dispatch but `.respond` no-ops. Confirmation keys from the gate publish site
  (`harness.ts:846`): `hints.kind==="tool_confirmation"`, `metadata.{toolName,toolUseId,
arguments,preview}` + `message`. Coordination caveat documented. Gates: typecheck
  --force 152/152 0-cached; 355 tests (+9: 5 router, 4 confirm); oxlint 0.

- **Citations/sources — PROVENANCE HALF + NORMALIZED MODEL LANDED (Pass D complete).**
  Supersedes the embedded-`Citation.source` spec foundation below. Final model is
  NORMALIZED (sources are entities, citations are edges): `Source { id (turn-stable);
url?; title?; documentIndex? }`, `Citation { sourceId; citedText?; range?;
confidence? }` (embedded `source` GONE), `BaseContentBlock.sources?` (the entities
  THIS block's citations reference — co-located so a lifted block resolves its own
  citations), `AssistantMessage.sources?` (the turn's full consulted set — the
  "Sources" footer surface + the only home for orphans). Decided with Ryan: block
  level + message aggregate (blocks get lifted out of messages → sourceId must be
  block-resolvable; message rolls up for the footer + orphans). Shared
  `createSourceInterner()` in model-next (one-source-one-id per turn, dedupe by
  url/`doc:<index>`) so all 4 adapters share ONE id scheme, not four; `message.sources`
  rolled up from block.sources (dedupe by id) at the `language-model-adapter` summary
  assembly — adapters do BLOCK level only. **Per-provider citations** (each maps its
  OWN format, SDK-typed fixtures): anthropic document citations (char/page/
  content_block_location); openai `url_citation` annotations; google grounding
  (`groundingSupports`×`groundingChunks`, one citation per support×chunk w/
  confidence); ai-sdk `.sources`. **executedBy provenance NARROWED across all 4**
  (honest external-constraint deferrals, TODO(pass-d)'d, NOT straddle): anthropic
  web-search needs SDK >0.39 (server_tool_use untyped); openai needs Responses API
  (Chat Completions has no provider tool_results); google grounding is METADATA not a
  tool_result → NO executedBy by design; ai-sdk opaque handle can't name the provider
  key. Gates: typecheck --force 152/152 0-cached; 865 tests (model+spec+4 adapters+
  loop; +interner 5, +message-rollup, +per-adapter dedup/resolution); oxlint 0 errors
  (2 pre-existing warnings). **Follow-on (own passes):** executedBy where the SDK/API
  allows; provider-tools `<ProviderTool>` component + config seam; ai-sdk request-half.

- **Citations — canonical representation LANDED (spec foundation).** Provider
  web-search/grounding responses routinely carry citations; v2 had NO representation
  (v1 had a flat `ContentMetadata.citations: ContentCitation{text,url?,title?,
startIndex?,endIndex?}` — refined here). Added `Citation` + `CitationSource` to
  `content-blocks.ts` and `citations?: readonly Citation[]` on **`BaseContentBlock`**
  (NOT TextBlock — citations are cross-cutting provenance: any content can be cited
  (a generated image's source, a document reference, a grounded claim), not only
  text; `range` char-offsets stay optional + text-only. Placed with the existing
  cross-cutting optionals `metadata`/`providerMetadata`/`summary`).
  Shape: `Citation { source: CitationSource; citedText?; range?{start,end};
confidence? }`, `CitationSource { url?; title?; documentIndex? }` — a FLAT source
  bag (url present ⇒ web, documentIndex present ⇒ document/file), NOT a discriminated
  union, normalizing OpenAI `url_citation`/`file_citation`, Anthropic
  `web_search_result_location`/`char|page_location`, Google `groundingChunks`+
  `groundingSupports` without inventing a taxonomy. Refines v1's ambiguity: `range`
  = span in the ASSISTANT text, `citedText` = snippet of the SOURCE (v1's `text`
  conflated them). Spec-only foundation; adapters POPULATE it in the provenance pass
  (next) with tests. Gate: spec typecheck clean.

- **Pass D adapters — REQUEST-HALF LANDED (3 of 4; ai-sdk deferred).** Each adapter
  consumes its own `input.providerTools` slice (filtered by `provider` key) and maps
  it onto the native request tools array: **openai** `{ type, ...config }` →
  `params.tools`; **anthropic** `{ type, name, ...config }` (server tools need both
  versioned type AND name); **google** `{ [type]: config }` as distinct grounding
  `Tool` entries alongside the single `{ functionDeclarations }`. Each gates on a
  non-empty filtered slice and maps ONLY its own key — cross-provider leakage is
  test-asserted; provider tools never enter the function-`tools`/dispatch path.
  **ai-sdk request-half DEFERRED (correct call):** the AI SDK builds provider tools
  via provider-specific factories (`openai.tools.webSearchPreview(config)`) that emit
  opaque `Tool` objects; the adapter holds only an opaque `LanguageModel` handle and
  can't reconstruct the factory call from `{provider,type,config}` — a hand-rolled
  entry would be rejected at runtime. Needs a `provider→factory` registry; TODO'd
  loudly (`ai-sdk-adapter.ts:429`). **LOUD provenance trailheads** (`grep -rn
"TODO(pass-d): PROVENANCE HALF"`): 4 uniform box-comment markers at each adapter's
  `normalizeImpl` (openai:761, anthropic:1185, google:858, ai-sdk:615), each naming
  that provider's concrete result-block shape — the exact spec for the provenance
  pass. Gates: typecheck --force 152/152 0-cached; 178 adapter tests (+4 request-half,
  native-shape + cross-provider-filter asserted); oxlint 0 errors (2 pre-existing
  warnings). **Provenance-half = NEXT PASS:** `executedBy: "provider:*"` stamping +
  a canonical CITATION representation (web-search/grounding return citations — common,
  needs a spec home; Google grounding emits citation METADATA not a discrete
  tool_result block, so provenance may not be a stamp-on-a-block there).

- **Tool-config parity — Pass D FOUNDATION LANDED (provider-executed tools).**
  Restores v1's `ToolExecutionType.PROVIDER` (provider runs the tool INSIDE the
  model call, result bypasses the executor — OpenAI `web_search`/`code_interpreter`,
  Anthropic `server_tool_use`, Google grounding). Design (LOCKED): a DISTINCT
  `ProviderToolDeclaration` slot, NOT a `type:"provider"` discriminator on
  `ToolDeclaration` — a provider tool has none of the executor's concerns (no
  `inputSchema`, no `handlerRef`, no confirmation, no client-relay, no `_summary`),
  so it is a SIBLING declaration at the IR that NEVER enters the executor /
  `compileForTick`; folding it into `ToolDeclaration` would break the clean
  `handlerRef present=server / absent=client` binary. Lean shape (no cross-provider
  taxonomy): `{ provider (routing key), type (provider-native, verbatim), name?
(defaults to type), config? (passthrough) }`. **Steel-manned the null hypothesis:**
  the escape hatch (`target.providerOptions[key]`) already lets an adopter inject
  raw provider-native tool JSON, so the slot buys first-classness (config/tree-
  declarable) + executor-bypass + uniform provenance stamping, NOT mere possibility.
  Landed: `ProviderToolDeclaration` + `RuntimeDeclarations.providerTools` (spec);
  `ProviderToolWire` + `providerTools?` on `ProjectInput`/`RunInput`/
  `LanguageModelInput` (executor protocol); `buildProviderTools()` projection
  (model-next, dedupe by provider+resolved-name last-wins, never narrated/schema'd);
  loop threads `tickCompiled.declarations.providerTools` into both project + run
  call sites (TODO(pass-d): config-level `createApp/createSession({providerTools})`
  seam once it exists — compiled-tree source only this run). **Client provenance:**
  the `ToolExecutor`/`executedBy` docblock rewritten to the full four-source axis
  (`agentick`/`client`/`provider:*`/`mcp:*`) — provider results ride `executedBy`
  on the `tool_result` block into the timeline the client folds, NOT a separate
  event, NOT the dispatch stream (provider tools emit no `tool:dispatch`). Gates:
  typecheck --force 152/152 0-cached; 845 tests (model+spec+loop-executor, +4
  projection cases); oxlint/oxfmt clean. **Follow-on:** the 4 adapters consume
  `LanguageModelInput.providerTools` + stamp `executedBy: "provider:<key>"`; a
  `<ProviderTool>`/`<WebSearch>` tree component; the portable cross-provider vocab.

- **Client timeline — mutable WINDOW LANDED (`prepend`/`append`).** `timelineView`
  (the client-side fold of `timeline:command:append` events) gained a mutable
  window: `prepend(entries)` splices OLDER history at the HEAD (scroll-back — the
  adopter loads it from `LogStore.history` server-side, no wire read verb), `append`
  splices optimistic/pending entries at the TAIL. Copy-on-write per mutation (the
  `useSyncExternalStore` contract fires); empty/all-filtered batch = no-op (same ref).
  **Minimal splice — NO seq-merge/dedup** (bus `Cursor` ≠ store `seq`, two numbering
  systems; the ecosystem reconciles app-side): the app owns reconciliation via the
  `message.metadata.clientId` passthrough (`send({messages:[{metadata:{clientId}}]})`
  survives onto the folded entry). Extracted **`liveStore<T,F>`**
  (`@agentick/client-core-next`) — the fan-out core (held state + dual state/frame
  feed + `useSyncExternalStore` contract + status + fault isolation) with an
  imperative `set(next, frame?)` seam; `eventView` now sits on it (behavior
  identical), `timelineView` drives `set` from BOTH the live fold AND `prepend`/
  `append`. **This is purely CLIENT-SIDE** — the backend `TimelineHarness`
  (server-side `LogView`, `timeline:command:append`, `history`) needed nothing; the
  window folds the server's existing event stream. Worked typed example at
  `example/v2-coding-agent/src/timeline-client-example.ts` (server hydrate → seed →
  tail → scroll-back → optimistic send → `reconcileByClientId`). The one deferred
  piece: a wire `timeline/history` read verb for the THIN-client (no adopter server)
  case — `history` is in-process only today; server-hydrate path works now. Gates:
  typecheck --force 152/152 0-cached; tests 171 passed (timeline-view.spec +6 cases);
  oxlint/oxfmt clean.

- **Tool-config parity restoration — Pass A LANDED (confirmation seams).** A full
  v1→v2 tool-config audit found the rewrite dropped 15 fields, 4 of them
  callable→static seam-violations (all in the confirmation-UX cluster). Pass A
  restores the confirmation seams, reusing the elicit request's existing
  `message`/`metadata` slots (the gate had hardcoded them) — NO new machinery:
  `annotations.confirmationMessage` (`string | (input,ctx)=>string|Promise`) →
  elicit `message`; `annotations.confirmationPreview` (`(input,ctx)=>Promise<Record>`,
  e.g. a write/edit diff) → `metadata.preview`; `defaultResult` widened to a
  callable at both the fire-and-forget + timeout-fallback sites; `ToolDeclaration.aliases`
  with exact-name-first / alias-index dispatch resolution (an alias never shadows a
  real tool). All typed on `createTool` (erased on the declaration, like `handler`).
  Gates: typecheck --force 152/152 0-cached; 783 tests (9 new confirmation-seams);
  README Confirmation-flow + Dispatch-aliases sections updated. **Restoration queue:**
  Pass B (presentation: `title` humanized name + `displaySummary` + a model-narration
  `_summary` field injected into every tool schema, surfaced on the tool-start event);
  Pass C (`onComplete`/`onError` hooks); Pass D (`type:PROVIDER` provider-executed
  tools — executor skips dispatch, provider runs it). Client `policy` (approve/deny/
  prompt) → folded into client-tools stage 3. Then client-tools stage 2 (wire) ships
  the complete declaration shape.

- **Client-side tools — Stage 1 LANDED (executor native handling).** Baked
  handler-less "client tool" handling + an async `requiresConfirmation` predicate
  into the tool executor's `dispatchBody`, reusing the elicitation suspend/resume
  infra. Discriminator: `handlerRef === undefined` → client-handled (a
  present-but-unresolvable `handlerRef` stays `ToolHandlerMissing`). Two modes off
  `annotations.requiresResponse`: `true` → **suspend** and relay via
  `this.request(TOOL_CALL_CHANNEL, …)`, await the client's `ContentBlock[]`
  (`executedBy: "client"`; timeout → `defaultResult` if set else
  `ToolCallTimeoutError`); falsy → resolve immediately with `defaultResult ??
"executed successfully"` + a fire-and-forget `this.notifyChannel(...)` (new `BaseHarness`
  primitive — the one-way twin of `request`, `requestType: "notify"`, no
  correlationId). `requiresConfirmation` widened to `boolean | ((input,ctx) =>
boolean | Promise<boolean>)`, evaluated at the gate. `createTool` handler +
  `handlerRef` now optional. New: `ToolCallTimeoutError`, `tool-call-schema.ts`
  (`TOOL_CALL_CHANNEL`/`ToolCallRequestPayload`/`TOOL_CALL_REQUEST_SCHEMA` — the
  stage-2/3 wire contract), `annotations.responseTimeoutMs`. Gates: typecheck
  --force 152/152 0-cached; 1056 tests (12 new client-tools + regression guard;
  elicitation unchanged); tool-executor README updated with the client-tool flow +
  the confirmation seam. **Next:** the flattened-seam RESTORATION (v1→v2 audit
  running — `confirmationMessage`/`displaySummary`/`confirmationPreview`/
  `defaultResult`-as-function/client `policy`) BEFORE stage 2 (wire `register_tool`
  - `respond_to_tool_call`) so the wire carries the complete declaration shape;
    then stage 3 (client router), then custom UI for tool-use blocks.

- **Phase 4a LANDED: `View.flush()` durability barrier.** View writes are
  fire-and-forget (reads served from the sync cache; a durable-write failure must
  not crash the mutation). Added a private `persist(m, ctx)` that routes the store
  write off the critical path but TRACKS the promise in a `pending` Set and
  latches the first failure (`writeError ??= err`); `flush()` awaits all pending
  writes then surfaces + clears the latched error. `seedSync` stays cache-only.
  Hot path unchanged — the only new surface is `flush()` (the graceful-close /
  hibernate barrier a durable store needs; a no-op for the in-memory default).
  `wrapWriteError` seam skipped (harnesses wrap at their own flush delegation).
  Manifest DROPPED from Phase 4 (Ryan: "too much ceremony") — resume is just
  "each store hydrates its own scope," no per-store cursor record. Gates:
  typecheck --force 152/152 0-cached; store 81 passed (view.spec 16→18). **Next
  (4b):** wire `hydrate()` per harness into construction/resume, seed only when
  the store is empty (fresh), retire `importSnapshot` as the resume mechanism,
  wire close→flush; resources re-runs loaders post-hydrate.

### 2026-07-20

- **Store convergence — COMPLETE (Run 5: resources migrated, credentials closed
  out). ZERO STRADDLE.** resources' two raw catalog Maps (`fixed`/`templates`)
  fold into ONE `View<ResourceDeclarationRecord>` over its single kind-discriminated
  store — durable declarations via `view.write`, transient tree-mounts via
  `view.seedSync` (cache-only, never persisted), unmount via `view.deleteSync`,
  `fixed`/`templates` a read-time partition by `record.kind`. Resolver sidecars +
  both MCP notifiers (`resources/updated` content, `list_changed` topology) stay
  domain-owned (the tasks/prompts precedent). The agent's read: a CLEANER fit than
  the two-Map catalog — the store was already one kind-discriminated collection, so
  the two-Map split was the outlier. Two named behavior changes: durable writes are
  now fire-and-forget (the View trade — reads from cache, a durable failure doesn't
  crash the mutation, same as tasks) and the single keyspace honors the disjoint-key
  invariant the store already relied on. credentials documented as the deliberate
  **async-only no-view case** (no sync read surface ⇒ no View, not SnapshotCapable).
  Gates: typecheck --force 152/152 0-cached; resources+store+mcp 479 passed.

  **The final taxonomy — one contract, one projection pattern, nothing hand-rolled:**
  - `Store<T,Q,M>` — the universal store seam (`query`/`mutate`/`watch?`/`backend`).
    Every store conforms; `CollectionStore`/`LogStore` are ergonomic profiles that
    `extends Store`.
  - `View<TCache, TStore, Q, M>` — the sync collection projection: pure-mirror
    (knobs/state/skills/prompts), fused cache≠store via `project`/`reconstruct`/
    `seedSync` (tasks), single-record single-key (session).
  - `LogView<T>` — the sync log projection (timeline): two-tier + write-behind + flush.
  - **Rule:** a harness holds a `View`/`LogView` IFF it has a synchronous read
    surface. credentials (async-only) is the one principled no-view store.
    Seven commits: 17183a4a (View foundation) · 44b00cf1 (retire CollectionProjection)
    · 9493e505 (rename Reactive\*→Store/View) · 746a0b53 (Store universal) · a9a6f64f
    (View cache≠store + tasks) · 8b9f93f7 (session) · a80bd935 (LogView + timeline)
    · [Run 5].

- **Store convergence — Run 4 LANDED: `LogView` extracted, timeline migrated.**
  The log-archetype projection — the sibling of `View`. Timeline hand-rolled a
  two-tier (durable `persisted` + bounded/compacted `projection`) log projection
  with a write-behind pump + `flush()` barrier + compaction; that whole ~200-line
  payload-agnostic machine moved verbatim into `LogView<T>` (`@agentick/store-next`).
  Timeline harness shed net −115 lines, now holds one `log: LogView<TimelineEntry>`
  — grep for bare `_persisted`/`_projection`/`writeBuffer`/`pumpError` fields
  returns none. Two DI seams keep it generic: `wrapWriteError` injects the
  `TimelineWriteFailed` mapper (a spec domain error a generic primitive must not
  hardcode) so `flush()` throws the exact typed error; `LogProjectionMeta` carries
  compaction provenance opaquely. `append` is `Promise<void>` (through awaits the
  store inline + surfaces the typed error; behind buffers + pumps) — awaited via
  `Effect.tryPromise` in `appendBody`. Two-tier kept (the §2.7 projection-only
  drop is a separate future concern); snapshot shape unchanged so restore/
  kill-resume untouched. Gates: typecheck --force 152/152 0-cached; store +
  timeline 178 passed; session/timeline-fs resume green. **The projection taxonomy
  is complete: `View` (collection / single-record / fused) + `LogView` (log), both
  over the one `Store`.** Remaining: resources (`View` + resolver sidecar);
  credentials stays the principled no-view case.

- **Store convergence — Run 3 LANDED: session onto a single-key `View`.**
  `SessionRuntime` hand-rolled the View machine (sync cache + `syncSessionRecord`
  write-through + a `_listeners` notifier); all three fold into
  `View.collection(store, r => r.id)` — one cache entry, keyed by session id. No
  View refinement needed — proof the primitive covers the single-record cell.
  Typed accessors stay as the session-domain facade. Parity-only: the E11
  upsert-on-transition semantics are preserved exactly — `setStatus`/`setMeta`
  persist (`view.write`), `addUsage`/`bumpExecutionCount`/`setCurrentExecutionId`
  are cache-only (`view.seedSync`, riding the next status write), `currentTick`
  stays transient. Optional `SessionStore` handled with a module `NULL_STORE`
  (no-op mutate) so there's ONE read path and no durable mirror is introduced
  where there wasn't one. Honest cost: scalar mutation became whole-record
  copy-on-write (+ ~modest ceremony); session-state.ts grew (a lot of it docs +
  identity fields relocated from the harness, which shed −48) — the trade is
  uniformity over minimal LOC, per the explicit "everything leverages View"
  mandate. `subscribeMetadata` is now consumer-less (folded into `view.write`);
  the `setMeta` change fires an unobservable extra ping. Gates: typecheck --force
  152/152 0-cached; session + app 202 passed / 4 skipped (kill-resume).
  **Remaining:** timeline (`LogView` sibling), resources (`View` + resolver
  sidecar); credentials stays the principled no-view case.

- **Store convergence — Run 2 LANDED: `View` generalized (cache ≠ store) + tasks
  migrated.** The thesis test — does `View` cover the augmented FUSED case, or was
  it only ever a pure-mirror? It covers it, cleanly. `View<TCache, TStore = TCache,
Q, M>` gains a symmetric CQRS boundary pair — `project: TCache→TStore` (strip on
  write) + `reconstruct?: TStore→TCache` (rebuild on hydrate) — plus `seedSync`
  (cache-only adopt of a record that came FROM the store, no re-persist, no
  change-emit). `View.collection` fills identity, so the 4 pure-mirror consumers
  are unchanged (annotations widened to 4-param, zero behavior change). **tasks**
  dropped its hand-rolled `live: Map<string,LiveTask>` for `View<LiveTask,
TaskRecord,…>` (`project = lt => lt.record`): `persist()` → `view.write`,
  adopt-from-store → `view.seedSync`, the interrupted-resume branch seeds then
  writes to round-trip the mutation. tasks keeps its per-task `eventBus` (domain
  event stream, NOT the projection notifier) and bespoke `hydrateOrphans`
  (reattach) — View's notify/hydrate are opt-in, unused here. The old
  `TODO(store-phase-N)` betting the primitive would never fit tasks is refuted and
  removed. Gates: typecheck --force 152/152 0-cached; tasks 140 passed (kill/resume
  - cancellation unchanged); store + pure-mirror 349 passed; oxfmt + oxlint clean.
    **Remaining to zero straddle:** session (single-key `View`), timeline
    (`LogView` sibling), resources (`View` + resolver sidecar); credentials stays
    the principled no-view (async-only) case.

- **Store convergence — Run 1 LANDED: `Store` is the universal store contract.**
  `CollectionStore`/`LogStore` formally `extends Store`; every concrete store
  (in-memory defaults, generic decorators, Postgres/Fs adapters, AND credentials)
  implements `query`/`mutate`; the profile methods are sugar. `LogQuery`/
  `LogMutation` defined; duplicate `backend` dropped from the profiles; Cut-1
  coexistence TODOs removed. No store-level straddle left. Gates: typecheck
  --force 152/152 0-cached; vitest 1000 passed (+ timeline-fs 19); oxlint clean.

- **Store convergence — Cut 1 LANDED (foundation + pilot proof).** The
  nine store-backed harnesses each hand-rolled the same reactive machine; the
  convergence collapses it. Design: `docs/proposals/v2/store.md`
  (grounded in TanStack Query / RxDB / Svelte-stores; the "Locked" section).
  **The seam** (`Store<T,Q,M>` in spec-next): three verbs — `query(q,ctx)`
  (read = projection from the source), `mutate(m,ctx)` (write), optional
  `watch?(q,ctx)` (reactivity is a capability, not a mandate). `Q` = a
  serializable query DESCRIPTION (never a query language), defaults to `void`; `M`
  the mutation vocab. `CollectionStore`/`LogStore` are ergonomic PROFILES over it
  (Cut 1: coexist additively — `MemoryCollection` implements both `get/list/put`
  AND `query/mutate`; the formal `extends` sweep is Cut 2). **The collapse**
  (`View` in store-next): ONE harness-side sync projection that subsumes
  `CollectionProjection` + `KeyedNotifier` (render pings) + `ChangeNotifier`
  (typed deltas) — sync reads (`getSync`/`listSync`, render + sync-`exportSnapshot`
  safe), single-mutation `write`/`deleteSync` (cache → seam `mutate` off the
  critical path → ping + typed change), and CHANGE-SILENT bulk `replace`/`hydrate`
  (cache-first, batched pings — a wholesale replace is the harness's own aggregate
  frame, not N spurious deltas). **Pilot:** knobs + state migrated (3 fields → 1
  `view`; `applySet`/`applyRegister`/`applyDelete`/`importSnapshot`/`hydrate`
  boilerplate collapsed). Parity held on the delicate points: knobs `knobs-state`
  JSON-Patch channel (entry-typed stream, `projectStateDelta` unwrap), state's
  `undefined`-value classification (add/update rides `cache.has`, NOT
  `prev !== undefined` — a stored value may legitimately BE `undefined`). Gates:
  **152/152 typecheck 0-cached, 1043 tests / 64 files, oxfmt + oxlint clean.**
  Residual drift (deferred to Cut 2 per the three-consumers rule): a ~7-line
  `toValueChange` entry→value unwrap is duplicated in knobs + state — hoist to a
  `store-next` `mapChange` export during the fan-out. **Cut 2+:** fan `View`
  out to the remaining 7 harnesses, retire `CollectionProjection`, make the
  profiles formally `extends Store`. TODO markers greppable:
  `TODO(store-cut2)`.

- **Store Cut 2a LANDED — skills + prompts migrated, `CollectionProjection`
  RETIRED.** The seven remaining harnesses do NOT fan out uniformly (map in the
  Cut-2 planning): only skills (pure mirror) and prompts (mirror + harness-owned
  `augmentations` split-map sidecar) were the other `CollectionProjection` holders,
  so migrating them onto `View` left the old primitive with zero consumers
  — deleted `collection-projection.ts` + its spec (−287 lines), dropped the barrel
  export. Both in-memory stores gained additive `query`/`mutate` delegates to their
  composed `MemoryCollection` (`TODO(store-cut2)`); store options widened
  to the `Store` seam. Prompts parity detail: the `augmentations` sidecar
  stays harness-owned (cleared on import, untouched on hydrate) and is populated
  BEFORE the now-synchronous `view.write` ping so a subscriber sees the combined
  `declarationOf`. Also fixed Cut-1 doc-rot (state README + store-backing spec still
  named `CollectionProjection`). Gates: **152/152 typecheck 0-cached, 225 tests /
  17 files, oxfmt + oxlint clean.** Net −254 lines.
  **DEFERRED (each needs a design decision, not a sweep):** tasks (cache-type ≠
  store-type `LiveTask` sidecar — needs a `View` refinement + honors tasks'
  own ≥2-augmented-consumer gate), session (single-record `SessionRuntime` → wants
  a `ReactiveCell` sibling; one consumer, three-consumers rule), resources (hybrid
  raw-Map catalog + resolver sidecars — partial fit), timeline (LOG archetype →
  needs a `ReactiveLogView` sibling, not `View`), credentials (async-only,
  untouched — the standing counter-example). **Cut 2b (next mechanical step):**
  `CollectionStore`/`LogStore` formally `extends Store` (in-memory defaults
  inherit `query`/`mutate` free; hand-write on the Postgres/Fs adapters + MemoryLog
  - Idempotent/Journal stores) — retires the coexistence TODOs.

### 2026-07-15

- **ADR 88 + 88a — live media sessions (DRAFT).** Designed the "live" capability
  grounded in OpenAI Realtime / Gemini Live / AI SDK / LiveKit / Pipecat + Knowify
  v1 parity. **Retargeted to a minimal core (rev 3):** a `MediaTransport` _capability_
  (feature-detected, backpressured uplink/downlink, keyed by `(sessionId, streamId)`),
  a continuous `MediaSession`, and the `session.live` handle — client `sendFrame`/
  `onFrame` spec + `uplink`/`downlink` stream projections; server `withLive({ onStream })`
  routing + a per-stream context. Everything above the pipes (STT/TTS engine packaging,
  `TurnArbiter`, capability record, `RealtimeModel` archetype, driven-loop/full-duplex,
  2-track reflex tier) is **app-composed from existing primitives** (`session.send`,
  `guard`, steering, tasks) or **demoted to Future directions**. Key design calls:
  callback/imperative is the spec (no stream-type dep in spec), streams are the
  runtime projection; barge-in = `abort` + steering (not a subsystem); hooks are
  server-lifecycle-grained + opt-in (client is a projection: callbacks + middleware).
  88a validates the deferred engine layer against session-required streaming STT
  (Google) over a continuous multi-turn call (one recognizer, many turns, rotation
  at turn boundaries, Timeline = memory). Scaffolded v0 (`ba3d5770`): harness +
  handle + routing + wire + client, fake-transport unit tested (31 tests).
- **live-next increment 2 — frames actually flow (in-process media plane).** Added
  `inProcessLiveMedia(gateway)` (`@agentick/live-next/testing`) — the in-memory
  `MediaTransport` — composed with the generic control transport via a new optional
  `inProcessTransport({ gateway, media })` hook (transport-in-process stays live-agnostic;
  the coupling lives in live-next). Spec: `onDownlink` egress seam on `LiveHarnessProtocol`
  (the mirror of `push`). 4-test full-stack e2e proves a client `sendFrame` reaches the
  server `onStream.onFrame` and a server `sendFrame` reaches the client `onFrame`, +
  concurrent-stream routing by `streamId`. **Finding (real gap the e2e surfaced):**
  optional-extension bridges (registered via `installer.registerNamespace` →
  `extensionBridges`) had **no server-side `session.<name>` getter** — only built-ins
  (`get tasks()`/`get elicitation()`) did — so `session.live` was `undefined` and the wire
  handler couldn't reach the harness. `live` is the first optional extension with a wire
  method, so nothing hit it before. **Fixed generally in `session-next`:** the SessionHarness
  now exposes every `extensionBridges` name as a `session.<name>` getter (never shadowing a
  built-in) — the server twin of the ADR-87 client sub-handles; makes `session.sandbox`/
  `.credentials`/`.live`/etc. all resolve. Gates: `pnpm typecheck --force` 150/0-cached;
  927 tests across session/app/live/transport-in-process/sandbox/credentials/spec.
- **`session.tasks` completed to a CQRS handle** (`e271c834`): added
  `tasksWireExtension` (`tasks/cancel`) + `tasksHandle` (client) so
  `session.tasks` is now `ChannelView & { cancel(taskId, reason?) }` — uniform
  with `session.knobs` (view + `set`) and `session.elicitations` (stream +
  `respond`). Reads are uniform (channelView/channelStream); writes are per-domain
  commands, NOT divergence. `tasks/cancel` rides `builtinWireExtensions` (owned by
  app-next), so every gateway registers it. Closes the "read-only until its wire
  method lands" note in `builtin-wire.ts`.
- **Ambient-module shadow trap — root-caused a 1575-error regression.** A wire
  `wire-augment.ts` with a bare `declare module "@agentick/spec-next" { … }` and
  NO top-level `import`/`export` is a SCRIPT, so TS reads the block as an _ambient
  module declaration that shadows the entire spec package_ (every export vanishes)
  rather than a merging augmentation. Symptom: `example-v2-real` went 0 → 1575
  "has no exported member" errors while every changed package typechecked clean in
  isolation. Fix: `export {}` at the top makes it a module → augmentation. The
  knobs twin dodged this only incidentally (`import type { CommandInfo }`). Load-
  bearing comment added at the seam. **Watch for this on every new type-only
  augmentation file.**
- **Proportionality call:** `tasks/cancel` is a structural twin of `knobs/set`
  (plain request/response wire method), so it gets the knobs test treatment
  (wire-unit + client-handle-unit + real-gateway registration), NOT a heavier
  inProcessTransport full-stack e2e. The elicitation e2e existed because
  elicitation had novel correlationId-routed-stream machinery; tasks/cancel has
  none, and a dedicated e2e would only re-prove the generic dispatch path.

### 2026-07-09

- **Tasks/escalation close-out batch (4 built + verified):** (1) escalation routes
  per ORIGINATING session — `makeEscalate`/lineage read `record.scope`, `submit`
  stamps a per-submit `scope` (`de8aeaa5`); (2) `taskSupport: "supported"` verified
  ALREADY built (pre-flight conflict validation + caller-choice ref/inline + the
  `dispatch-task-mode-matrix` suite; only #174 auto-capability-negotiation remains);
  (3) `ttl` reaper — unref'd per-task timer → `expireTask` marks `failed{kind:
"timeout"}` + tears down the executor, cleared on terminal (`08155ac2`); (4)
  `client.events()` live stream — `AsyncIterable<ClientEvent>` over a dedicated
  `LocalPubSub` emitter, filter/close/multi-iterator, live-only cursor honestly
  documented, `#308` (`b4497f9d`).
- **ADR 73** (`0ea18bb8`) — AG-UI projection (session bus/`ClientEvent` stream +
  inbox → AG-UI events; thin codec over existing substrate; gated on #308, now
  partly unblocked). **ADR 74** (`980f35dd`) — DRAFT media capabilities +
  capability-aware normalization (#17): structured `media` capability on
  `TargetCapabilities` + a shared normalization pass (source-form transcode in-core;
  format transcode pluggable; unsupported → `onUnsupportedMedia` policy). Design-first
  (no prior spec); 7 open questions to workshop before build.
- **Design ADRs drafted (NOT built — banked for later):** **ADR 71** (`a2df8b02`)
  — app workspace conventions + `agentick.config.ts` (workspace-default layout,
  five explicit-barrel convention folders, a `mergeLayered`-resolved config with
  profiles/`extends`, `create-agentick-app --framework`). **ADR 72** (`33333635`)
  — the `ui://` IR **widget** seam → **A2UI** (MCP-Apps = A2UI-over-MCP), with
  interaction via the ADR 69 inbox relay. **ADR 73** (`0ea18bb8`) — the **AG-UI**
  projection: the session bus/`ClientEvent` stream + inbox → AG-UI events (a thin
  codec over existing substrate; "closer to done"; gated on #308 `client.events()`).
  A2UI = widgets, AG-UI = event stream, MCP = tools — three axes, they compose.
  Companion workshop artifacts exist for 71 + 72. All three are DESIGN drafts;
  none started. (NOTE: the "## What's next" section above is STALE — it predates
  the whole tasks/escalation/tool-result arc; this Decision Log is the live record.)
- **ADR 70 — tool result currency landed** (`5719389f` ADR, `f72508bb` build). A
  tool handler returns `string | ContentBlock[] | { content: string |
ContentBlock[]; structuredContent?; isError?; metadata? }` (+ Promise/Effect/
  TaskHandle), normalized to one internal result at dispatch. `structuredContent`
  is `outputSchema`-validated (typed `ToolValidationError` on failure) and flows
  to `DispatchResult` + the MCP `CallToolResult` wire — closing the dead
  `outputSchema`→`structuredContent` seam. The headline is composition:
  `outputSchema` is what lets a model chain tools (typed output→input) or write
  code that calls them. `isError` (soft/domain error, model-visible) **replaces**
  `DispatchResult.succeeded` (removed) — soft-error path coherent end-to-end
  (`DispatchResult.isError` → loop `dispatchSucceeded` → `LoopToolResult.succeeded`
  → session `tool_result.isError`); throw stays the HARD path. NO plain-object→
  JsonBlock guessing (rejected — kills inference; wrong-shape return is a TS error,
  guarded by `@ts-expect-error`). `toContentBlocks` string→text normalizer created
  in `spec-next`. `LoopToolResult`/`ExecutionTerminal.succeeded` retained
  (different types, loop-internal — out of scope). Full suite 8060 green.
- **`@agentick/tasks-store-postgres-next` rename** (`6e0a5c90`) + configurable
  `created_at` column across both pg stores (`a2b4445f`) — the pg store gains a
  slot discriminator (tasks has two swappable slots: store + executor, unlike
  timeline's one), forward-compatible with a future `tasks-executor-*`.

### 2026-07-08

- **ADR 69 — substrate request escalation (chain-of-responsibility over the
  ownership inbox); T1 landed** (`5f1794bf` ADR, `01ea384b` T1). A nested unit
  (task or sub-agent) blocked on input escalates up the ownership chain to the
  connected client; the answer routes back. The mechanism IS **nested
  `inbox.ask`** — the ask return-value stack is both the relay AND the reply
  route (no envelope-forwarding / reply-address threading; the first ADR draft
  had that and it was deleted). Escalation edge is the **spawn lineage
  (`parentSessionId`), NOT the structural harness `parent`** (which is the App).
  Interception = a hop's handler returns instead of forwarding; default is
  forward; bubble is the superset, cluster-direct a future optimization.
  Invariant: **`interactive ⊥ detached`** — a detached task can't elicit (no
  live chain) → typed `DetachedTaskCannotElicitError`. T1: `ctx.elicit =
awaitingInput(escalate)`; `escalate = inbox.ask("session:"+sessionId, 24h,
signal-interruptible)`; `SessionHarness.handleMessage` forwards if
  `parentSessionId` else resolves terminally via `elicitation.elicit`.
  Payload-agnostic escalation protocol lives in `runtime-next` (substrate
  floor). First consumer = elicitation; sampling/permission/credential/error
  are free future riders. Verified: round-trip + FSM flip + detached guard,
  full suite 8028 green.
- **ADR 69 T2a landed** (`1f4ac378`) — the multi-agent bubbling core: the
  recursive `parentSessionId` hop (2-session chain proven — child task elicit
  forwards up, root parent resolves against the real client), the
  `interceptEscalation(handler)` seam (an ancestor answers / denies / forwards
  a descendant's request; `{forward:false,response}` short-circuits before the
  terminal, throw = deny, `{forward:true}` falls through; NO interceptor =
  byte-identical to T1 parity), `lineage` provenance appended per hop
  (origin task+session → each forwarding hop, principal best-effort per ADR
  51), and the folded dual-currency gap: `awaitingInput` gains an
  `Effect<T,E,never>` overload run as a real interruptible child fiber
  (cancel/ttl `Fiber.interrupt`s it — finalizer-fires proven — vs the
  Promise flag-only path). Contract types (`EscalationEnvelopePayload`,
  `EscalationHop`, `EscalationOutcome`, `EscalationInterceptor`) moved to
  spec-next (cycle-free: the spec `SessionHarnessProtocol.interceptEscalation`
  references them); wire constants stay in runtime-next. Full suite 8035 green.
- **ADR 69 T2b landed** (`6c3f18be`) — the cross-process child elicit bridge:
  a forked task's `ctx.elicit` (a generic `Elicit` Proxy) marshals a
  serializable INTENT `{method, args}` over IPC; the parent
  (`ChildProcessTaskExecutor.bridgeElicit`) reconstructs the live-schema
  request via `hooks.buildElicit(hooks.escalate)[method](...args)` and feeds
  the SAME escalate chain — so interception + lineage apply to a forked task
  for free (proven: a parent interceptor short-circuits a forked child's
  elicit, client elicit never called). The live `StandardSchemaV1` NEVER
  crosses IPC (only `{method, args}` does; `assertElicitArgsCloneable` fails
  loud on a raw `form(liveSchema)`). Typed elicit errors round-trip via
  `serializeAgentickError` (child rethrows the exact class, e.g.
  `ElicitationDeclined`). `input_required` flip crosses via `awaitingInput`
  over IPC. `@agentick/elicitation-next` is a TEST-ONLY devDep — tasks src
  stays elicitation-free (the sugar is injected). Full suite green.
  **Escalation arc (T1 + T2a + T2b) complete for in-process AND cross-process.**
- **Deferred:** lineage UI-surfacing into the client elicit request, and T3
  (durable/cluster escalation + the direct-delivery optimization).
- **ADR 68 input_required (#120-followup) landed** (`4fdb548f`) —
  `ctx.awaitingInput` status wrapper (`working → input_required → working`),
  the origin seam ADR 69 builds on. Plus worker self-terminates on parent IPC
  `disconnect` (`65cf49d8`); cross-restart child reattach reframed as the
  distributed tier (unsound over fork IPC), not a follow-on.
- **ADR 68 persistent tasks — Builds A + B landed** (`3c747508`,
  `3c1beb6f`). The pivot: a task is a persisted `TaskRecord` FSM in a
  `TaskStore`; _how it runs_ is a pluggable `TaskExecutor`. Build A:
  record-source-of-truth refactor of `TasksHarness` (CQRS — sync
  projection kept in lockstep with async `store.put`; bus stays the
  LIVE plane, store the DURABLE plane, wire payloads byte-identical),
  `InMemoryTaskStore` + `runTaskStoreConformance`, `InProcessTaskExecutor`,
  `detached` lifetime (survives session close), `interrupted` orphan
  accounting on hydration (scope-filtered per session). Build B:
  `ChildProcessTaskExecutor` over fork+IPC (by-ref: closures can't cross
  the boundary → `handlerRef` + serializable `TaskRecord` descriptor;
  graceful IPC-cancel → SIGKILL backstop; crash → `failed`; within-process
  reattach), and the harness single-executor field generalized to a
  **registry keyed by `.kind`** — per-submit `executorKind` selection,
  hydration/cancel dispatch by `record.executorKind`.
- **Executor authoring surface decided.** `TaskHandlerRegistry` +
  `registerTaskHandler<I,O>` (transport-agnostic, generic) factored
  STRICTLY apart from `runTaskWorker` (the IPC driver) — the registry is
  the reusable piece a future distributed (e.g. queue-backed) executor
  reuses with its own driver. NO `defineTaskStore`/`defineTaskExecutor`
  factories: the ports are non-generic and validation lives in the
  conformance suites, so a factory would be a pass-through returning its
  arg. The `define`-energy belongs at the by-ref handler layer, not the
  port layer.
- **App-scoped `tasks: { store, executors }` seam on `createApp`** — NOT
  a cascade. Detached tasks + child reattach require shared singletons
  that outlive any one session, so the store + executors are app-owned
  for the app's lifetime (a session-scoped store would lose detached
  tasks on close). Contrast knobs/gates, which DO cascade (policy).
- **ADR 68 pg tier landed** (`4e3b43d3`). `@agentick/tasks-store-postgres-next` —
  a durable Postgres `TaskStore`, the flexible cloud-pole sibling of
  `timeline-postgres` (BYO executor, table/columns/sql/codec/migrate escape
  hatches, factory implements the port directly per ADR 49). Schema: task_id
  PK + scope jsonb (GIN) + status + updated_at + payload jsonb + schema_ver;
  UPSERT put, `scope @>` containment list, terminal-only prune. Passes
  `runTaskStoreConformance`. The unlock the in-memory store structurally
  can't demonstrate — a cross-process resume proof (verified 12/12 on a real
  postgres:16): `interrupted`-on-restart FIRES FOR REAL (abandon harness #1
  without close → fresh harness #2 over the same pool+table marks the orphan
  `interrupted`) + terminal adoption (result decoded from pg, not a live
  fiber). NOTE: the earlier scout finding stands — with the in-memory store,
  same-process session-resume re-hydration was already a no-op the ADR 68
  machinery covered; this pg store is what makes cross-process resume real.
- **Still deferred (seam-ready):** cross-restart CHILD reattach-by-pid
  (needs the executor to persist its pid into `record.executorState` +
  pid-based re-adoption) — `TODO(ADR-68 child-reattach)`; and the
  `input_required` transition (`#120-followup`). A
  distributed/queue executor (pg-boss-style) is the ambitious tier: it's
  the child-process executor with the pipe swapped for a queue + the
  cluster bus (report goes through the durable + cluster planes rather
  than an in-process closure).

### 2026-06-29

- **ADR 43 Slices 2 + 3 landed.** Slice 2: `buildSessionElicit(harness)`
  factory in `@agentick/elicitation-next/src/elicit-sugar.ts` wraps an
  in-process `ElicitationHarness` in the `Elicit` sugar surface. Wired
  into `tool-executor-next/harness.ts` ctx-build so in-process tool
  handlers get `ctx.elicit` populated identically to MCP-server tool
  handlers (same Elicit interface, same throwing semantics). Slice 3:
  `fakeToolHandlerCtx({ ... })` factory in `spec-conformance-next`
  centralizes ToolHandlerCtx test fixtures; two existing ad-hoc fakes
  (`tool-next/__tests__`, `reconciler-react-next/__tests__`) migrated
  to the helper. Tool-handler ctx shape changes now propagate to all
  tests via one factory update.
- **#272 landed — `session.elicit` accessor.** Augment adds
  `SessionHarnessProtocol.elicit: Elicit` required slot; both
  `SessionHarness` (lazy getter) and `CallbackSessionHarness` (eager
  constructor) implementations expose the sugar. Adopters writing
  session-level commands or agent-side asks use the same `Elicit`
  interface tool handlers receive via `ctx.elicit`.

- **ADR 43 proposed + Slice 1 landed — Unified `ToolHandlerCtx` across
  transports.** Adds `transport: "in-process" | "mcp"` discriminator
  to `ToolHandlerCtx` + `mcp?: McpRequestExtras` sub-slot for
  MCP-only wire identity material (connection id, client capabilities,
  authenticated user, sendProgress). `McpRequestContext` collapses to
  a structural type alias of `ToolHandlerCtx & { transport: "mcp";
mcp: McpRequestExtras }`. Tool handlers receive the SAME ctx shape
  whether dispatched in-process or via MCP server — `createTool` is
  now portable across transports. ADD-only rollout strategy: no
  existing fields removed; new fields populated at three known
  ctx-build call sites (in-process tool-executor, MCP server
  projection, session dispatch path) in the same slice. **Why:** the
  prior split between `ToolHandlerCtx` (in-process) and
  `McpRequestContext` (MCP) was historical, not designed — adopter
  pushback on 2026-06-29 ("createTool tools should work with mcp
  server too and both should basically work the same") forced the
  unification. **How to apply:** any new ctx-build site populates
  `transport` + `mcp?` per ADR 43 §3; sugar surfaces (`ctx.elicit`,
  future `ctx.sample` / `ctx.roots`) work identically in both
  transports; `Partial<McpRequestContext>` test fixtures use the
  flat-override helper documented in `pipeline.spec.ts`. Workspace
  7150/7158 green (+1 conformance round-trip). Tasks #272
  (session.elicit), #266 (ADR 42 Slice 3 — withX trichotomy), and
  future sampling/roots ctxes all unblocked by this landing.

- **ADR 42 proposed — Harness-slot trichotomy (`Instance | Config | shorthand`).**
  Codifies the convention every harness-backed adopter slot must follow:
  the slot is an `Instance | Config` union, with an optional third
  `readonly Decl[]` shorthand case for harnesses that have a single
  dominant declaration type. Naming rules pin "no Harness in adopter
  vocabulary" (every protocol gets a `<Noun>` alias —
  `Prompts = PromptsHarnessProtocol`, etc.), `use:` as the pre-built
  escape-hatch field name (never `harness:`, `instance:`, `source:`),
  `filter:` for per-connection visibility, and `parent.<slotName>:
Instance | null` as the runtime-mutation read surface. Lifecycle
  ownership follows construction: parent-built → parent closes;
  adopter-supplied (top-level Instance OR `use:`) → adopter closes.
  Initial audit lists `mcp-next/server.prompts` as the lone fully-
  passing slot; `mcp-next/server.tools`, `withSkills`, `withPrompts`
  all flagged for follow-up slices. Triggered by #171d.1b where
  `prompts: { harness: ... }` leaked framework vocabulary into adopter
  code. Not a code-level generic (the first draft was — pushed back as
  too tight; the per-harness Config shape varies too much). ADR is a
  CONVENTION + 7-item audit CHECKLIST. Cross-references ADR 26, 27,
  40, 41. **How to apply:** every new harness-backed slot scored
  against the checklist before merge; existing slots get follow-up
  tasks for each gap.

- **ADR 41 landed — `AgentickError` class hierarchy supersedes POJO
  `{ _tag: ... }` unions for typed errors.** Closes #256. Every typed
  error in v2 is now a class extending `AgentickError extends Error`
  (with optional per-domain abstract intermediates carrying a literal
  `_tag` union for `Effect.catchTag` narrowing). A registry-based codec
  (`registerAgentickError(tag, cls)` + `serialize`/`deserialize`)
  preserves class identity across the wire; `UnknownAgentickError` is
  the lossless fallback for unregistered tags. The previous 2026-05-11
  decision ("Spec error shape = `{ _tag: ...; ... }` tagged union. No
  class hierarchy") is **superseded**. Zero production `Effect.fail({_tag:...})`
  / `throw {_tag:...}` sites remain; 404 surviving `_tag` references
  are all on non-error tagged unions (message envelopes, wire frames,
  content blocks, channel events) and are correct. Conformance test in
  `@agentick/spec-conformance-next/__tests__/agentick-error-conformance.spec.ts`
  pins registry-membership + instance-shape + codec round-trip
  invariants for all 88 framework error tags. Adding a new error class
  requires adding one row to the suite's `EXPECTED` list. Work landed
  on branch `feat/v2-error-infra`; ready to merge → `feat/v2`. 2476/2476
  workspace tests green. Commits: `5420945c` (ADR-41 proposal) →
  `cd90ec8f` (#256e + #256f final sweep).

### 2026-06-23

- **`@agentick/utils-next` carved out from `@agentick/shared`.** The
  v1 `@agentick/shared` package is fundamentally a v1-API content bag
  (block-types, messages, transport, identity, etc.) with a single
  `utils/` subdirectory of framework-agnostic helpers. Adding new v2
  utilities (`mergeLayered`, `isEqual`, `isPlainObject`, predicates)
  there forced every v2 package to import from a v1-coupled package,
  creating a backwards dep edge from v2-next to v1.
  Moved predicates + merge-layered + tests into a new private
  workspace package `@agentick/utils-next` at `packages-next/utils/`.
  Inlined the tiny `isObject` helper that v1's `mergeDeep` was using
  so v1 `@agentick/shared` stays self-contained. Updated v2 consumers
  (`tool-executor-next/registry.ts`, three harness migrations for
  journalingPolicy) to import from `@agentick/utils-next`.
  Future v2 framework-agnostic utilities land here, not in v1 shared.
- **`mergeLayered` first internal demonstration — journalingPolicy
  cascade in App / Gateway / Session harnesses.** Replaced
  `{ ...DEFAULT_JOURNALING_POLICY, override: { ... } }` hand-spreads
  with `mergeLayered<JournalingPolicy>(DEFAULT_JOURNALING_POLICY,
options.policy, { override: { ... } })`. Adding fields to
  `JournalingPolicy` no longer requires touching the three close-op
  override sites. Gateway's adopter-supplied `policy` now deep-merges
  through the cascade rather than per-field copy.
- **#133 ElicitationBridge landed — MCP server-to-client
  `elicitation/create` routing.** Closes the MCP-side half of the
  elicitation chapter. Spec gains an optional
  `AppInstallerHost.getSession(id)` so app-extensions can reach live
  session bridges at dispatch time without coupling to
  `@agentick/app-next`. `withMCP`'s tool-handler closure resolves
  `installer.app.getSession(ctx.sessionId)?.elicitation` and threads
  it through `harness.callTool(..., { elicitResolver })`. The MCP
  SDK's `ElicitRequestSchema` handler routes inbound `elicit/create`
  through the per-call slot — accept → tool result embeds value,
  decline/cancel → server sees clean termination. Translation lives
  in a separate `mcp/client/elicit-bridge.ts` so #134a (URL mode) is
  a small drop-in. v0 concurrency caveat: single resolver slot per
  harness; concurrent elicit-routed `callTool`s race. Mitigated by
  MCP's per-connection serial-call convention; per-request-id
  correlation deferred until the wire ships stable
  `relatedRequestId` on inbound server-initiated requests.
- **#149 cluster-friendly elicit routing + URL mode + Effect
  cleanup.** Substrate-level overhaul of the elicit bridge.
  `ElicitationHarness` gains an `elicit-request` inbox message
  handler that runs an elicit locally and routes the result back via
  `request-response`. `McpClientHarness` slot stores a _sessionId
  string_ (not an object reference); the SDK elicit handler routes
  via the substrate inbox to the session's elicit address — same
  protocol in-memory (LocalInbox) and cluster (ClusterInbox). The
  per-call slot stamp uses `Effect.acquireUseRelease` for
  interrupt-safe acquire/release. URL mode wired end-to-end:
  harness publishes URL-mode payload, MCP bridge forwards URL
  elicits as consent-only terminals. `UnsupportedElicitationModeError`
  deleted (both modes wired). SDK exported `ElicitRequestFormParams |
ElicitRequestURLParams` union used directly (replaces hand-rolled
  type). `BaseHarness.address` made public — every harness exposes
  its cluster-portable inbox address. `ElicitationHarnessProtocol`
  gains `address: string`. Unrouted/ambiguous elicits emit
  `mcp:warning:routing-dropped` bus envelopes. URL-mode conformance
  - capability handshake + concurrent in-session tests added.
- **#150 SessionExtension lifecycle wiring.** The `target: "session"`
  half of the extension union was a placeholder — AppHarness cached
  the extensions but never invoked them. Now wired:
  `createSessionBody` builds a SessionInstaller (sessionId + tool +
  bridge + bus + onClose registration surface), runs session-target
  extensions BEFORE constructing the ToolExecutor so contributed
  tools (binding `{ scope: "extension", level: "session" }`) land in
  `initialTools`. Per-session bridges overlay app-level. Close
  handlers + tool-handler unregisters + bus subscriptions fire LIFO
  at session.close. Foundational for every session-scoped extension
  — knobs, sandbox-session, mcp-future. 6 conformance tests cover
  install-once-per-session, dispatch reachability, bridge isolation,
  LIFO close, no-zombie-handlers, app+session sibling phasing.
- **#151 withMCP becomes per-session — drops the elicit slot
  entirely.** Architectural floor for multi-tenant MCP.
  `McpClientHarness` is now per-(session, server); `elicitAddress`
  is fixed at construction (set to `SessionInstaller.elicitation
.address`). The `activeElicitSessionId` slot, the
  `Effect.acquireUseRelease` wrapper around `callTool`, the
  `resolveElicitAddress` callback, the cross-session ambiguity
  warning path — all gone. handlerRefs are per-session
  (`mcp:<sessionId>:<serverId>:<toolName>`) to avoid collisions on
  the shared HandlerResolver. Tools bind with
  `{ scope: "extension", level: "session" }`. Multi-tenant
  correctness: MCP binds OAuth tokens + `Mcp-Session-Id` + auth
  decisions to the connection; sharing across users is a wire
  violation. **Future optimization (#152, weeks horizon):**
  connection pool keyed by auth principal — sessions check out /
  back in. Sits BENEATH McpClientHarness; same auth principal →
  connection sharing, different principals → isolation. Loud
  documentation in `packages-next/mcp/README.md` "Connection
  lifecycle" and `blueprint/23-mcp-as-harness.md`.

### 2026-05-08

- **Day 1 morning approach:** do additive (new packages) safely first;
  pause before destructive renames until full package inventory was
  understood.
- **`@agentick/spec-conformance-next` not separate repo:** marked private
  in monorepo. The "private repo" idea was overengineered — conformance
  tests aren't a competitive moat.
- **Per-package test scripts:** removed; vitest runs from workspace root.

### 2026-05-11

- **STATUS.md created:** running progress + decision log to enable
  cross-session continuity.
- **Spec async return = Promise/AsyncIterable** (not Effect). Preserves
  zero-dep. Implementations bridge to Effect at the boundary.
- **Spec error shape = `{ _tag: ...; ... }` tagged union.** No class hierarchy.
  **⚠ SUPERSEDED 2026-06-29 by ADR 41 — see decision-log entry. v2 now
  uses an `AgentickError` class hierarchy with a registry-based codec.**
- **`lookupTerminal` returns `Maybe<T>`** (plain discriminated union),
  not Effect's `Option<T>`.
- **Phantom type fields on `Operation<I, R, E>`** for inference; not
  runtime properties. Marked `@internal`.
- **`DEFAULT_JOURNALING_POLICY`** ships as a const in spec:
  `alwaysJournal: ["requested", "terminal"]`, `busOnly: ["before", "delta"]`,
  `overflow: "sliding"`, `queueCapacity: 4096`. Per-surface override at
  consumer.

### 2026-05-14

- **Nomenclature recalibration:** drop idiomatic naming where it
  conflicts with proper CS terms. Specifically:
  - `Compiler harness` → `Reconciler harness` (it reconciles a reactive
    program; it does not compile in the static-compilation sense).
  - `Renderer harness` (markdown/xml) → `Formatter harness` (it formats
    semantic content into output formats; "renderer" collides with
    React's own meaning).
  - `CompiledStructure` → `RenderedTree` (matches React's mental model:
    what the reconciler "renders" to).
  - `useContinuation` → `useLoopControl` (avoids overloading the existing
    "gate" concept; clearer semantic about what it does).
  - `CompileError` → `ReconcileError`.
  - `RenderError` (formatter) → `FormatError`.
  - `compileContext` command → `renderTree`.
  - `compile-until-stable` → `render-until-stable`.
  - Event prefixes: `compiler:*` → `reconciler:*`,
    `renderer:*` → `formatter:*`.
  - Surface enum: `"compiler"` → `"reconciler"`,
    `"renderer"` → `"formatter"`.
  - Package: `@agentick/compiler-react` → `@agentick/reconciler-react-next`.
  - Doc file: `03-compiler-harness.md` → `03-reconciler-harness.md`,
    `04-renderer-harness.md` → `04-formatter-harness.md`.
  - "Harness" stays — adds engineering-discipline specificity over
    bare "actor" (BaseHarness inheritance, five surfaces, journal
    durability). Documented as an addressable actor.

### 2026-05-17

- **L6 — substrate benchmark suite landed.** New
  `packages/runtime/src/__bench__/substrate.bench.ts` exercises every
  hot path (bus.publish ± subscribers, bus.publishLazy, journal.append
  ± dedup, inbox.send ± cache hit, runOperation ± idempotent replay,
  LocalChannelPublisher ± subscriber, streaming simulation 10 ops ×
  10 deltas eager vs lazy). Full table + decisions in
  `blueprint/17-open-questions.md` §Benchmark results.

  Key results:
  - **Lazy emission validated end-to-end.** `bus.publishLazy` no-subs
    at 0.5 μs is a **12× speedup** vs constructing-and-publishing
    (6.0 μs). The streaming sim shows 10 ops × 10 deltas: lazy at
    229 μs/iter beats eager at 289 μs/iter by ~20% when no
    subscriber. Construction-on-demand is the right call.
  - **`bus.publish` no-listeners hits target.** 0.5 μs < 1 μs.
  - **`bus.publish` 1-subscriber misses by 20%.** 6.0 μs vs 5 μs.
    Mostly Effect-runtime overhead (`Effect.all` + `Queue.offer`
    plumbing). Acceptable; micro-opt available.
  - **`journal.append` + `inbox.send` cache hit excellent.** ~1.4 μs
    fresh append, 0.6 μs dedup; 0.6 μs cache hit on inbox.
  - **`runOperation` empty body is 46.8 μs, 4.7× over original 10 μs
    target.** Decomposition: ~21 μs in three publishes, ~26 μs in
    Effect framework overhead (Effect.scoped + withContext + nested
    Effect.gen yields). **Target revised: < 50 μs.** Realistic
    given how much work the phase contract does. Substrate cost is
    0.5% of a 10 ms tool call, 0.05% of a 100 ms model call —
    real-world throughput is not substrate-limited at this number.

  Optimization opportunities deferred (not blocking Phase 4c):
  - Inline single-subscriber path in `bus.publish` to skip
    `Effect.all` overhead.
  - Flatten nested `Effect.gen` blocks in `runOperation`; skip
    `Effect.scoped` when no finalizers registered. ~15-20 μs
    recoverable.

### 2026-05-16

- **Substrate refinement pass — 8 critical items closed.** Audit of
  the substrate after the Effect-native migration surfaced eight gaps
  between the blueprint and the implementation. All eight closed in
  one pass:
  1. **`Effect.scoped` wrap around every command body.** `runOperation`
     now establishes a `Scope` for the operation's lifetime — any
     `Effect.acquireRelease` inside a body runs its finalizer when the
     operation terminates (success, failure, or interrupt). Unblocks
     adapters that hold per-operation resources (HttpClient, WebSocket,
     sandbox process handles).

  2. **Typed error channel.** `runOperation` now returns
     `Effect<R, E | SubstrateError, never>` instead of
     `Effect<R, unknown, never>`. New `SubstrateError` tagged union in
     `@agentick/spec-next` covers `OperationOutcomeError | JournalError |
LifecycleHandlerError`. Callers regain compile-time signal about
     what failure modes to handle; subclass harnesses can pattern-match
     in `Effect.catchTag` / `Effect.catchTags`.

  3. **`parentOpId` auto-set from the FiberRef.** When `runOperation`
     starts and `op.parentOpId === undefined`, it reads the surrounding
     `RuntimeContextRef`'s `opId` and uses that. Nested operations
     compose into a causality tree without app code threading
     parentOpId. Every consumer of the journal/bus (devtools, OTel
     exporter, replay debugger) can reconstruct the operation tree.

  4. **OTel span integration — without breaking error-identity.**
     `runOperation` annotates each operation with `Effect.withSpan`
     via a private `annotateOperationSpan` helper that side-channels
     the span (success-typed `Effect.void.pipe(Effect.withSpan(...))`)
     so the failure value the caller sees is the same JS reference the
     body raised. Earlier attempt to use `Effect.withSpan` directly on
     the body's pipe lost error-reference identity (failures appeared
     as Errors with the same `.message` but different `.constructor`
     ref). Workaround preserves identity at the cost of the span not
     seeing the original error — for now, OTel sees only the span
     name + attributes; explicit `recordException` integration is a
     follow-up.

  5. **Lifecycle-handler failures flow through `SubstrateError`.** A
     `before`-handler's Effect failing now produces a typed
     `{ _tag: "LifecycleHandlerError", phase, cause }` instead of
     silently widening the operation's `E`. The substrate publishes
     `terminal:failed` for the operation and re-fails with the typed
     lifecycle error.

  6. **`runHarnessProtocol` extracted to `@agentick/runtime-next`.**
     Concrete harnesses (reconciler-react, tool-executor) used to
     duplicate this `FiberFailure → typed error` unwrap helper.
     Now exported once; both consumers import it.

  7. **`ToolHandler` accepts Effect, Promise, or sync.** The 90%-case
     Promise ergonomic (v1-compatible) keeps working. Effect-typed
     handlers see the harness's `RuntimeContextRef` directly via
     `getContext` (no `ctx` plumbing), participate in `Effect.scoped`
     finalizer chains, and cancel via `Effect.race` against an
     AbortSignal-driven failure. The dispatch body itself converted
     from Promise-shaped to Effect-shaped so the FiberRef propagates
     into Effect handlers without crossing the JS-async boundary.

  8. **`AbortSignal` ↔ Effect interrupt bridge.** Effect-typed tool
     handlers race the handler effect against an `Effect.async` that
     fails when the dispatch's AbortSignal fires. Promise handlers
     continue using the `AbortSignal` directly. The two abort
     primitives coexist without one dictating the other.

  **Status:** `pnpm -r typecheck` clean; 4953/4961 tests green across
  the workspace; example/v2 demonstrates both Promise and Effect
  handler paths end-to-end (the Effect `whoami` reads sessionId /
  executionId / tickId / opId via FiberRef without any parameter
  plumbing).

- **Components → reconciler-react.** Decision locked: user-facing
  component wrappers (`<Section>`, `<Message>`, `<H1>`, `<Tool>`, etc.)
  live in the matching reconciler package, not a separate
  `@agentick/components`. Rationale: components are coupled to the
  reconciler's intrinsics; future Solid / Vue reconcilers ship their
  own. example/v2 defines them locally as a stopgap; they graduate
  into `@agentick/reconciler-react-next` before Phase 4e so app authors can
  `import { Section, Tool } from "@agentick/reconciler-react-next"`.

- **Substrate scalability + observability — gates registered.** Four
  new entries in `blueprint/17-open-questions.md` §L (Observability):
  L5 (OTel exception recording without breaking error-reference
  identity), L6 (bus publish hot-path benchmark), L7 (`MemoryJournal.
appendedKeys` Set unbounded growth), L8 (substrate self-instrumentation).
  L5 + L6 are **gating items for Phase 4c (executor harness)** —
  must land before adapter authors write code on top of the substrate.
  L7 gates v2.0 release. L8 lands alongside L6. See "Substrate
  scalability + observability (running notes)" in 17-open-questions.md
  for the benchmark plan and concrete concerns.

### 2026-05-15

- **Phase 3 priority reorder:** the reconciler harness, not the tool
  executor, is the proof harness. Reasoning: the reconciler IS the
  foundation; the substrate is plumbing for it. If substrate doesn't fit
  the foundational harness cleanly, we need to know that before building
  on top. Tool executor moves to Phase 4a.
- **Mechanical rename pass complete** across blueprint + plan + status.
  55/55 typecheck green; 25/25 spec tests green.
- **Path A — substrate flipped to Effect-native.** The earlier
  "Promise/AsyncIterable end-to-end. No Effect in runtime yet"
  decision is reversed. It contradicted `19-foundation.md` as written
  (`BaseHarness.runOperation` returns `Effect<R, E, Scope>`; journal /
  bus / inbox return `Effect` / `Stream`) and produced architectural
  drift — most visibly in an aborted attempt to bolt a `FiberRef + ALS
mirror` `RuntimeContext` onto a Promise-typed substrate. The bolt-on
  was thrown out; the substrate itself is now Effect.

  Concretely:
  - `@agentick/spec-next` protocols flipped: `OperationJournal`,
    `EventBus`, `MessageInbox`, `MessageHandler` all return Effect /
    Stream. Tagged-union errors flow through the `E` channel.
  - `effect` is a direct dependency of `@agentick/spec-next`,
    `@agentick/spec-conformance-next`, `@agentick/runtime-next`,
    `@agentick/reconciler-react-next`, and `@agentick/tool-executor-next`.
  - `@agentick/runtime-next` rewrites: `MemoryJournal` (Stream-based read /
    tail, idempotency unchanged), `LocalEventBus` (Effect `Queue`
    backed — `Queue.sliding` for drop-oldest, `Queue.dropping` for
    drop-newest), `LocalInbox` (Fiber-memoized idempotency cache —
    same `messageId` joins the same Fiber), `BaseHarness` (Effect
    `runOperation` with `withContext` establishing
    `RuntimeContextRef` for the operation's lifetime; FiberRef
    propagates sessionId / executionId / tickId / opId / parentOpId /
    correlationId to every Effect launched inside the body).
  - New `runtime-context.ts`: `RuntimeContextRef: FiberRef<RuntimeContext>`,
    `getContext`, `withContext`. **No AsyncLocalStorage mirror** —
    the prior session's dual-surface attempt is the exact pattern we
    are refactoring v2 to escape (ALS is scoped to async-resource
    chains; actor identities outlive any single call stack).
  - `runEventBusConformance` added (charter rule #4 status table
    flagged it as missing).
  - Reference harnesses re-anchored: `ReconcilerHarness` and
    `ToolExecutorHarness` keep their Promise-typed `ReconcilerProtocol`
    / `ToolExecutorProtocol` public surfaces (the spec hasn't
    flipped those — Phase 4 concern) but wrap each command body
    with `Effect.runPromise` via a `runProtocol` bridge that
    unwraps `FiberFailure` → original typed error. FiberRef scope
    propagates within each command.
  - Workspace status: 4953/4961 tests green (3 skipped, 5 todo, 0
    failed); `pnpm -r typecheck` clean.

  Architectural payoff (now realized for every harness that
  inherits BaseHarness):
  - FiberRef propagation across command bodies — sessionId / opId /
    tickId visible to any downstream Effect via `getContext`. No
    parameter plumbing, no ALS scope leaks.
  - `Effect.withSpan` integration point ready in `runOperation` for
    the OTel projection (`19-foundation.md` §OTel). Spans align with
    `parentOpId` via FiberRef.
  - `Effect.scoped` finalizer chaining available for harness
    teardown / abort cleanup when the per-command scope closes.
  - `@effect/cluster` substitution path open — `ClusterJournal` /
    `ClusterInbox` will implement the same Effect-typed protocols
    that `MemoryJournal` / `LocalInbox` do, satisfying the same
    conformance suites.

  Cost: the migration was a one-day mechanical conversion. Test
  bodies cross at `Effect.runPromise` / `Stream.runCollect` at the
  vitest edge; impl bodies are `Effect.gen` / `Effect.sync` /
  `Effect.tryPromise` wrappers. Nothing fundamentally new is being
  built — we're aligning the substrate with the blueprint that
  already specified it. The longer this drift had run, the more
  expensive the conversion.

## Open architecture decisions (deferred from blueprint)

Top of the priority list from `17-open-questions.md`:

```
1. A19 — PersistenceBackend methods (Phase 5; defer)
2. A13 — ExecutorDelta shape (Phase 4c; defer)
3. C6 — Provider-side tool execution marker (Phase 4c; defer)
4. B5 — Handler ID validation mechanism (Phase 4b; defer)
5. A1 — features[] registry (Phase 1; address as types land)
6. E11 — Spec version migration on restore (Phase 5; defer)
7. Inbox idempotency cache size + TTL (Phase 2)
8. Per-harness inbox message catalogs (cross-validate during 4-9)
9. Cluster routing integration with @effect/cluster (Phase 5 spike)
```

None of these block immediate work.

## Quick-start for a new session

```
1. Read this file (STATUS.md).
2. Skim docs/proposals/v2/IMPLEMENTATION-PLAN.md for phasing.
3. Read blueprint/00-overview.md for the architecture map.
4. Read blueprint/01-harness-principle.md + blueprint/19-foundation.md
   for the foundational concepts.
5. Check "What's next" section above for the immediate work item.
6. Update this file when work completes.
```

## How to update this file

When finishing a session or work block:

1. Move items from "What's next" → "What's done" as appropriate.
2. Add a dated entry to "Decision log" for any non-obvious choices.
3. Update "Current state" phase markers.
4. Add new pending decisions if encountered.
5. Note any environment surprises.
6. Commit alongside the work it describes.
