# Command Lifecycle Hooks — Handoff / Continuation Doc

> **⚠️ LANDED AS ADR 83 (2026-07-13). Read [`blueprint/83-one-interceptor-primitive.md`](blueprint/83-one-interceptor-primitive.md) first.** This arc completed with a wider collapse than the doc below anticipated: there is now **ONE interceptor primitive** (`Middleware`) with three KINDS — `guard` (op admission), `transform` (reshape; hooks are its keyed sugar), `observe` (side-effect). The verdict subsystem (`HandlerRegistry`/`mergeVerdict`/`runInheritedBefore`) is **deleted**, and the cascade is a **construction-FOLD** (`inheritedInterceptors` snapshotted at construction) — the `parent`-pointer walk this doc still describes (§`ownAndInheritedMiddleware`, §28) is GONE, and **ADR 81 is superseded**. The op-admission seam is named **`guard`** (`harness.guard` / `guardEffect` / `guardDispatch`), NOT `gate` — `SessionHarness.gate(name)` is loop continuation (guard : operation :: gate : loop). The **hooks** parts below (naming as a total function of the command id, the typed `CommandRegistry` → `CommandHooks`, compose-not-override, the fold) remain accurate; the "before-verdict handler" and parent-walk framing is historical. See STATUS.md 2026-07-13 (later⁵).

**As of 2026-07-13. Branch `feat/v2`.** Read this to charge through the remaining hook-cascade work without re-deriving. Companion to STATUS.md (the whole-v2 log); this is the arc-specific deep guide.

## Where this came from (the through-line)

Started as an nx-knowify question: _how does agentick v2 handle multimodal MODEL INPUT?_ The audit found v2 has the currency (ADR 57 `LanguageModelInput`, canonical `MediaSource` with `url|base64|reference|s3|gcs`) but **no reconciler-agnostic seam** to transform input per-provider before the model call. The clean seam is `onBeforeModelGenerate(input, ctx) => reconcile(input, ctx.target)`. Chasing "where does that hook live and how does it cascade" produced the whole **command-lifecycle-hooks** design. **The original goal is still open** (see §Next). Everything below is the substrate that makes it possible.

## The design in one screen

- **Lifecycle is intrinsic to `command()`.** Every harness verb (`<who>:<what>`, e.g. `tool:dispatch`, `model:generate`, `timeline:append`) routes through `BaseHarness.runOperation`, which already emits phase envelopes (events) + composes middleware. Hooks ride that same seam. No privileged "core" layers — every verb, every harness, uniform.
- **Two surfaces, named for their job:**
  - **Events** `<who>-<what>-<phase>` (kebab, `start`/`end`) — out-of-band, bus, fire-and-forget, wire-projectable. _Observe_ (subscribe).
  - **Hooks** `onBefore<Who><What>` / `onAfter<Who><What>` (camel) — in-band, awaited, ordered, transform-capable. _Participate_ (register).
- **Naming is a total function of the command id.** `hook = on + Before|After + PascalCase(<who>:<what>)`. Type-level `Pascal<K>` === runtime `deriveHookNames` (lockstep-tested). Forces canonical op names (e.g. the pending `tool:dispatch → tool:execute` rename).
- **Contract:** `(value, ctx) => value | void`. Return = transform, `void` = observe, `throw` = veto. `ctx` = RuntimeContext (scope, resolved `target`, principal, hooks, telemetryNamespace). Hooks **are middleware entries** — lifted through the SAME `liftMiddleware` path as `.use`, so ambient ctx / span-nesting / interruption survive an `await` (the §7 fiber invariant — a HARD rule, never a bespoke hook-runner).
- **Typed via a derived mapped type:** empty-seed `CommandRegistry` (`"<who>:<what>": { input; output }`), one line per verb → `CommandHooks` mints `onBefore<Pascal>?: BeforeHook<input>` + `onAfter<Pascal>?: AfterHook<output>`. Exposure-gated (only augmented verbs are type-safe).
- **Cascade = a construction-FOLD, not a parent-walk (ADR 82).** The construction hierarchy (gateway → app → session → sub-harness) is a scope chain. Each scope computes `resolved = parentResolved.extend(Hooks.from(ownHooks))` ONCE and threads the immutable `Hooks` VALUE into the harnesses it builds. Ops read local `this.hooks.forOp(name)`. **No parent pointers, no ordering knot** (a value needs no live parent). `Hooks.extend` **COMPOSES** per-command (both ancestor + descendant fire, outer-first) — deliberately NOT tools' last-wins override.

## `Hooks` primitive (`packages-next/runtime/src/substrate/base-harness.ts`)

Immutable per-command layer: `ReadonlyMap<pascalSuffix, { before: BeforeHook[]; after: AfterHook[] }>`.

- `Hooks.empty` — identity.
- `Hooks.from(config: CommandHooks)` — indexes via `parseHookKey` (strips `onBefore`/`onAfter` → Pascal suffix; shared with `deriveHookNames` so from/forOp can't diverge).
- `extend(child)` — compose: `[...thisBefore, ...childBefore]` per command (this-layer outer). Empty short-circuits (true identity).
- `forOp(opName)` — lifts resolved lists through `liftMiddleware(asBefore/asAfter)`; `[]` for unhooked ops (→ byte-identical chain).

Compose site (`runOperation`): `[...callMiddleware, ...ownAndInheritedMiddleware(), ...this.hooks.forOp(resolvedOp.name)]`. Middleware KEEPS the parent-walk; only hooks fold.

## Current state — what's LIVE vs DORMANT

**LIVE (`6b55b96e`):** `createApp({ hooks: { onBeforeToolDispatch } })` fires on a tool dispatch; `createSession({ hooks })` composes (`"x|app|session"`, app-outer). 4 tests in `packages-next/app/src/__tests__/hooks-cascade.spec.tsx`.

**Wiring:** `AppHarnessOptions.hooks?: CommandHooks` → `Hooks.from` at app ctor; `createSessionBody` computes `sessionHooks = this.hooks.extend(Hooks.from(input.hooks ?? {}))` and threads the VALUE into elicitation/tasks/resources/tool/knobs + session; app-shared spine (loop/executor) gets `this.hooks`. Each sub-harness has a mechanical `hooks`-forward-to-super. `CreateSessionInput.hooks?` augmented FROM the app package (avoids spec→runtime cycle).

**DORMANT:** knobs/tasks/resources/loop/executor are VALUE-wired (hooks fire at runtime) but TYPE-dormant — only `tool:dispatch` augments `CommandRegistry`, so only `onBefore/AfterToolDispatch` are type-safe keys.

**Commit chain:** `3006aec9` (ADR 80 typed derivation + wire slice) → `bcd18e7e` (mechanism, parent-walk) → `1032a1c8` (ADR 82) → `026323ca` (walk→fold rework) → `6b55b96e` (end-to-end wiring). Plus ADR 81 (`c248274f`, `939d969b`).

## ADRs

- **ADR 80** (`blueprint/80-command-lifecycle-hooks.md`) — the mechanism. §9 = wire-extension slice. §7 = fiber invariant.
- **ADR 81** (`blueprint/81-construction-parent-invariant.md`) — construction-parent invariant. **NARROWED by ADR 82 to middleware-only** (hooks no longer need parent pointers). Preferred fix if ever needed = factory injection ("children born from parents"). Deferred; `TODO(adr-81)` at `app/harness.ts` per-session construction block.
- **ADR 82** (`blueprint/82-hooks-cascade-as-construction-fold.md`) — the fold. IMPLEMENTED.

## Next work — prioritized

1. **Light up more verbs (quick wins).** One-line `declare module "@agentick/runtime-next" { interface CommandRegistry { "knobs:set": { input; output } } }` per harness → its hooks become type-safe. Do knobs/tasks/timeline/elicitation/resources as needed.
2. **Fix `onAfterToolDispatch` output type** (`TODO(adr-80)` at `tool-executor/harness.ts:97`). Declared `ContentBlock[]`, body returns `DispatchResult` → after-transforms break `session.dispatch().content`. Reconcile to `DispatchResult` + update the observe-only after test. Makes after-transforms sound.
3. **Slice 0 — session verbs through `runOperation`.** `send`/`render`/`dispatch`/`queue` bypass it (`session/harness.ts:552`, TODO `:1002`). Wrap each body in `runOperation("session:<verb>", body)` mirroring the executor (`language-model-executor.ts:341-360`) — a `sessionOp()` helper + one wrap per verb (~25 LOC). Unlocks `onBeforeSessionSend`. Behavior-preserving (existing session tests unchanged). Do NOT make verbs addressable commands (non-serializable `SendInput`, ADR 51 §1.2).
4. **THE ORIGINAL GOAL — `onBeforeModelGenerate` for media reconciliation.** Needs (a) `model:generate` (or the executor's real op name — likely `executor:*`) augmenting `CommandRegistry` with `{ input: LanguageModelInput; output: ... }`; (b) awareness that the executor is APP-SHARED, so `app.hooks.onBeforeModelGenerate` reaches it but **`session.hooks` does NOT** — per-session media resolvers need **tier-4** (call-scoped, fiber-threaded), not the harness fold. The media resolver logic itself = pull-once+inline / passthrough-native / fileId→URI keyed by `ctx.target.provider`.
5. **Wire-extension slice (ADR 80 §9).** Route `dispatchRequest`'s handler call (`transport/src/server/dispatch.ts:61`) through `runOperation` so wire methods get hooks; `authorizeDispatch` stays the explicit un-waivable pre-gate (auth composes BEFORE userland hooks). Extend `deriveHookNames`/`Pascal` to normalize `/`.
6. **Factory-slot construction-context consolidation (the big cleanup).** Make constructed slots `instance | config | (ctx) => instance`; `ctx` = per-slot-typed construction cascade (`scope, principal, telemetryNamespace, hooks, parent, substrate` + slot config). Subsumes ADR 81's parent threading + hooks + ns/principal into ONE `childContext`. **Discipline:** ADR 42 dichotomy is ground floor (instance vs declarative); factory is the injection form, NOT a third primitive. Don't build a `ScopedConfig<T>` god-object (shared shape, per-type merge: hooks compose, tools override). **`hooks` is a ctx field whose value is slot-shaped, NOT a mounted slot.**
7. **Gateway→app hook threading** (gateway is the new top scope; app folds gateway's resolved hooks).

## Anchors / key files

- `packages-next/runtime/src/substrate/base-harness.ts` — `Hooks`, `parseHookKey`, `deriveHookNames`, `asBefore`/`asAfter`, `BaseHarnessOptions.hooks`, the `runOperation` compose site, `CommandRegistry`/`CommandHooks` types.
- `packages-next/app/src/harness.ts` — the fold + threading (`createSessionBody`); `AppHarnessOptions.hooks`; `CreateSessionInput` augmentation.
- `packages-next/tool-executor/src/harness.ts:95-99` — the `CommandRegistry` augmentation pattern (copy for other verbs) + the output-type `TODO`.
- `packages-next/app/src/__tests__/hooks-cascade.spec.tsx` — end-to-end test shape (copy for other verbs).

## Standing constraints (non-negotiable)

- **NEVER touch/stage/commit `packages-next/client-extensions/src/retry/predicates.ts`** — user's WIP. Its `retry.spec.ts` failure is pre-existing/unrelated; ignore it.
- No git worktrees. Agents never push. Never `--no-verify`. Never pipe `git commit` (run bare, verify with `git log -1`). Commit trailer: `Claude-Session: https://claude.ai/code/session_016zXaLKMPfEYtPLGLBshdjP`. commitlint header ≤100 chars.
- **Gate mechanics:** tests = root `npx vitest run` (per-package `--filter` is a turbo no-op); typecheck = `pnpm typecheck` (= `turbo typecheck`, PER-PACKAGE; the "145/145" is turbo's task count — the monolithic root `tsc -p tsconfig.json` OOMs because the root config is a shared BASE with no `include`, don't run it); formatter = `oxfmt` (not prettier).
- **Working model:** spec → delegate implementation to an agent → JUDGE against the code (not the agent's report) → commit. Fiber invariant + compose-not-override + behavior-preserving-`[]` are the things to verify hardest.
