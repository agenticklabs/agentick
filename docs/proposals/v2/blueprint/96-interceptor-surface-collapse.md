# ADR 96 — The interceptor surface is base behavior, not per-harness code

**Status:** ACCEPTED (tier 1) / PROPOSED-DEFERRED (tier 2) — 2026-08-11.
**Builds on:** ADR 80 (command lifecycle hooks — the `Pascal` derivation),
ADR 83 (one interceptor primitive — guards/hooks/`use` on one chain, §4 live
inheritance), ADR 93 (namespace definitions — the drop-layer `hooks:` /
`guards:` bags), ADR 76/77 (the dual-typed edge — plain facade : Effect twin).

**Touches:** `@agentick/spec` (`protocol/middleware.ts` — `HarnessFx`,
`GuardDecider`), `@agentick/runtime` (`substrate/middleware.ts`,
`substrate/base-harness.ts`), `@agentick/timeline`, `@agentick/prompts`,
`@agentick/skills`, `@agentick/code`, `@agentick/tool-executor`, and the nine
packages with a hand-written `get fx()` object literal.

---

## The law

> A harness owns exactly two things: its **command declarations** (the
> `CommandRegistry` augmentation) and its **handlers**. Every interceptor
> surface is derived from those declarations by `BaseHarness` and is never
> hand-written:
>
> - **Plain forms live on the harness.** `harness.use` · `harness.guard` ·
>   `harness.guards.<command>` · `harness.hook` · `harness.hooks.on*` — and the declarative
>   `defineX({ hooks, guards })` bags, which are the same registrations read
>   out of the construction options.
> - **Effect-native forms live on `.fx`.** `fx.use` · `fx.guard`. `.fx` carries
>   the in-fiber **primitives**; the harness surface carries those plus the
>   derived **sugar**.
>
> A harness that adds a verb to the registry gets the whole surface for that
> verb — declarative and imperative, plain and Effect — with no new line of
> code in its package.

### The naming law (unchanged, now stated in one place)

| where                                      | key style             | example                                                                         |
| ------------------------------------------ | --------------------- | ------------------------------------------------------------------------------- |
| local `defineX({...})` config (drop-layer) | bare verb             | `hooks: { onBeforeAppend }`, `guards: { append }`                               |
| registry-wide imperative registrars        | discriminated command | `harness.hooks.onBeforeTimelineAppend(fn)`, `harness.guards.timelineAppend(fn)` |

Both desugar onto the identical op-scoped interceptor on the identical
command. The drop-layer key is colocation sugar: inside `defineTimeline` the
namespace is already known, so repeating it is noise; on a registry-wide
registrar it is the only thing that says which command you mean.

---

## 1. What was actually duplicated

Measured on `feat/v2` @ `next.108`, not estimated:

- **3 definition types** hand-roll the same two fields with the same two
  docblocks (`timeline`, `prompts`, `skills`). 45 lines of prose and
  declaration saying the same thing three times.
- **3 constructors** hand-roll the same two `if (options.x !== undefined)`
  registration blocks, each under the same 8-line comment explaining the
  cascade law (`timeline/harness.ts:417-431` is the exemplar). 44 lines,
  plus 6 import lines.
- **12 harnesses have no `hooks:` / `guards:` sugar at all** — including
  `code`, whose `code:execute` is the single most guard-worthy verb in the
  framework. Not by decision: by nobody having pasted the block yet.
- **1 bespoke guard method** survives (`ToolExecutorHarness.guardDispatch`,
  `tool-executor/harness.ts:599`), a typed alias for `guardEffect` that exists
  only because there was no public Effect-native guard register.
- **9 hand-written `get fx()` object literals** repeat
  `use: (mw) => this.registerEffectMiddleware(mw)`, so every universal `.fx`
  member added later costs 9 edits. (16 `get fx()` in production; the other 7
  route through `fxProxy` and need no per-harness edit.)

The pattern is the tell: the per-harness code is **identical modulo one string
literal**, and that string literal is `this.surface`, which the base already
holds.

## 2. Why the pieces were already there

Nothing here is new mechanism. The collapse is assembly:

- `NamespaceHooksOf` / `NamespaceGuardsOf` (`spec/hooks/derivation.ts`) already
  derive the drop-layer surface from `(Registry, NS)`.
- `qualifyNamespaceHooks` / `qualifyNamespaceGuards`
  (`runtime/substrate/middleware.ts`) already requalify a drop-layer bag onto
  the discriminated one.
- `BaseHarness` already holds `this.surface` — the `NS` those two need.
- Guards, hooks and `use` already share ONE chain and ONE inheritance seam
  (ADR 83 §4), so registering from the base constructor lands in exactly the
  place the per-harness constructors were landing.

Everything was in the building. Each harness was walking to it separately.

## 3. Tier 1 — ACCEPTED

### 3.1 One mixin, one home

```ts
// @agentick/runtime — substrate/middleware.ts
export interface HarnessInterceptors<S extends string> {
  readonly hooks?: NamespaceHooks<S>;
  readonly guards?: NamespaceGuards<S>;
}
```

**Home: runtime, not spec.** The fields' types resolve through
`CommandRegistry`, which is a runtime-owned interface (spec owns the _generic_
`NamespaceHooksOf<Reg, NS, Ctx>`; runtime binds it to the registry and to
`InterceptorCtx`). A spec-side mixin would need spec to know the registry —
the dep edge that deliberately does not exist. This is also the
construction-types-live-with-runtime convention: `BaseHarnessOptions` is next
door.

### 3.2 The base options bag carries it, parameterized by surface

```ts
export interface BaseHarnessOptions<I = unknown, S extends string = EventSurface>
  extends HarnessInterceptors<S> { … }
```

Each harness's options type names its surface once:
`interface CodeHarnessOptions extends BaseHarnessOptions<unknown, "code">`.
One type argument replaces fifteen lines. A harness that omits it still
compiles and still registers correctly at runtime — it just gets the union of
every namespace's verbs as its key space instead of its own. **Known gap:** a
surface with no registry rows derives `{}`, which TypeScript accepts any object
literal against; such a harness gets registration but no key checking until it
declares a command.

### 3.3 The base constructor registers them

```ts
if (options.hooks !== undefined) this.hook(qualifyNamespaceHooks(surface, options.hooks));
if (options.guards !== undefined) this.guard(qualifyNamespaceGuards(surface, options.guards));
```

Six lines in `BaseHarness`, deleted from every subclass. Placement is the
constructor, not a `ready`-path hook, and that is safe by inspection: the
registrations are inert until an op runs, no harness runs an op during
construction (genesis/hydration is resolved at construction and _run_ at
session-open), and no harness registers own middleware in its constructor — so
relative composition order within the own chain is unchanged. The behavioral
claim is carried by the three existing suites passing **unmodified**.

### 3.4 `fx.guard` — the Effect twin gets its public door

`HarnessFx` gains `guard(decide: GuardDecider<I, R, E>): Unsubscribe`, and
`GuardDecider` moves to spec (single source of truth; runtime re-exports it, so
the public name is unchanged). `fxProxy` grows one branch beside `use`.

The 9 hand-written `get fx()` literals change
`use: (mw) => this.registerEffectMiddleware(mw),` → `...super.fx,`. Net zero
lines today, and the last time this list has to be touched: a future universal
`.fx` member propagates for free.

`ToolExecutorHarness.guardDispatch` is **deleted**. It was the tool-typed name
for a universal seam, from before the universal seam had a name. Its three
tests move to `harness.fx.guard(...)` — the same `guardEffect` call underneath,
so the assertions are byte-identical.

### 3.5 The Promise facade must derive its exclusion, not enumerate it

Adding a member to `HarnessFx` broke three protocol types that spelled the
exclusion by hand — `PromiseView<Omit<XFx, "use">>` — and would have projected
`guard` as a Promise-facade _operation_. The list was never "use"; it was
"the primitives," so it is now derived: `Omit<F, keyof HarnessFx>`, at
`HarnessEdge`, `ToolExecutorProtocol` and `CompilerProtocol`.

This is the same law one layer out. A hand-maintained exclusion list of
primitives fails OPEN — the protocol still compiles and quietly grows a bogus
method. Deriving it means the next primitive costs nothing and cannot leak.

### 3.6 `@agentick/code` gains the sugar for free

`defineCode({ guards: { execute } })` and
`defineCode({ hooks: { onBeforeExecute } })` now type and fire — derived from
the `code:execute` row that already existed. The only code written for it is
the extension forwarding `config.hooks` / `config.guards` into the harness
options, and a pin.

## 4. Tier 2 — PROPOSED-DEFERRED: an Effect-native hook register

`.fx` would gain `fx.hook(config)` / `fx.on<Command>(mw)` taking Effect-native
middleware, so a before/after hook could compose in-fiber.

**It does not exist today, at any layer.** Hooks are `AsyncMiddleware`
end-to-end: `commandHookMiddleware` builds an `AsyncMiddleware` and
`liftMiddleware`s it, and `scopeToCommand` (`middleware.ts:608`) is
`AsyncMiddleware`-typed. Tier 2 is net-new machinery — an Effect-flavored
`scopeToCommand` and a parallel hook desugarer — with zero current consumers.

**The argument for building it now:** this ADR's law is "plain on the harness,
Effect on `.fx`," and a `.fx` carrying `use` and `guard` but not `hook`
falsifies it as stated. An adopter who wants an in-fiber before-hook (so an
OTel span nests through the transform, or an interrupt reaches inner work) has
to drop to `fx.use` and hand-roll the `ctx.op` compare that
`commandHookMiddleware` would have written.

**The argument against, which wins:** the asymmetry is principled once the law
is stated precisely. **`.fx` carries the Effect-native _primitives_; the
harness surface carries the primitives plus the derived _sugar_.** A hook is
one-sided sugar over middleware — and `.fx` already has the general form
(`fx.use`), so an in-fiber hook is a composition an adopter can write, not a
capability they lack. A guard is _not_ sugar over middleware: it is a distinct
KIND, the verdict→`OperationSignal` desugaring, and without `fx.guard` there is
no way to express one in-fiber at all. That is why `guard` belongs on `.fx`
today and `hook` can wait for a consumer.

Revisit when a real in-fiber hook consumer appears. Until then the honest
statement of the law is the one in §The law, with "primitives" doing the work.

## 5. Deliberately out of scope

- **Generalizing the 11 hand-written `XFx` interfaces and 16 `get fx()`
  getters.** Adding `guard` to `HarnessFx` is in; deriving the whole `XFx`
  from the registry is a separate change with its own measurement — every
  `XFx` also carries hand-authored twins whose signatures are deliberately
  _not_ the command's (`code.fx.execute` takes a request, not the audit
  input). Follow-up.
- **Renaming any existing hook or guard key.** Nothing moves.
- **The `guard`-kind derived name.** `deriveHookNames` mints `onBefore*` /
  `onAfter*` (+ `*Chunk`); guards are keyed by the uncapitalized Pascal command
  and always have been. Unchanged.

## 6. Measurement

Measured with `git diff --numstat`, not estimated. The number the hypothesis
rides on is the **per-harness source** column: does a harness package shrink?

| production source                                                              |  +added | −deleted |     net |
| ------------------------------------------------------------------------------ | ------: | -------: | ------: |
| `timeline` (definition fields + docs, ctor block, imports)                     |       7 |       37 | **−30** |
| `skills` (same three)                                                          |       7 |       40 | **−33** |
| `prompts` (same three)                                                         |       6 |       33 | **−27** |
| `tool-executor` (`guardDispatch` + docblock + import)                          |       2 |       32 | **−30** |
| the generic machinery (`base-harness`, `middleware`, `spec/middleware`, index) |      96 |       32 | **+64** |
| surface-naming sweep — 19 option types + 9 `...super.fx`, 1 line each          |      24 |       15 |  **+9** |
| **production total**                                                           | **142** |  **189** | **−47** |

Test-side churn is a separate, honest line. Adding a REQUIRED member to
`HarnessFx` costs every hand-rolled protocol double one line: 9 loop-executor
test stubs, 3 compiler fakes, 2 package stubs (+1 shared `stubHarnessFx()` in
`spec-conformance`, 18 lines, which stops the next one recurring). That is
**+69** across test files, of which **+45** is the new `code` pins and ~24 is
the mechanical `guard:` line. Two new runtime spec files add **304**.

So: **production −47, everything-in +356** (mostly pins). The collapse pays
for itself in source and buys its verification.

The −47 still understates the case, because the interesting number is the
**counterfactual**. Twelve harnesses gained the bags in this change
(`code`, `completions`, `credentials`, `elicitation`, `gates`, `gateway`,
`knobs`, `mcp` client, `resources`, `state`, `subscriptions`, `tasks`) for
**one type argument each**. Giving them the sugar by hand at the measured
per-harness rate (≈30 lines of fields, docs, imports and constructor block)
would have cost **≈360 lines**. The recurring cost of a new harness drops from
"paste 30 lines and remember the cascade comment" to "name your surface."

## 7. What is pinned

Base-level (`@agentick/runtime`):

- `options.hooks` / `options.guards` register and fire for a real command on a
  harness that declares nothing but its verb.
- The drop-layer short names type-check and the wrong-namespace key does not
  (a `.type.spec.ts`, in the style of `guard-bag.type.spec.ts` — a regression
  fails `tsc`, not vitest).
- A guard registered through `options.guards` still cascades parent → child.

Per-harness:

- `timeline` / `prompts` / `skills`: their existing suites pass **unmodified**.
  This is the whole behavioral argument — if a test needed editing, the
  generalization was wrong.
- `code`: `defineCode({ guards: { execute } })` vetoes an execution.
- `tool-executor`: `guardDispatch`'s three tests, green on `fx.guard`.
