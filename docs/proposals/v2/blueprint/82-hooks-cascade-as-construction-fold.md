# ADR 82 — The hook cascade is a construction-fold, not a parent-walk

**Status:** GENERALIZED 2026-07-13 by [ADR 83](./83-one-interceptor-primitive.md).
The construction-fold this ADR introduced for hooks is now the cascade for ALL
interceptors — guards and transforms (middleware) fold at construction the same
way, and the parent-walk is deleted outright (not just for hooks). The fold
mechanism here stands verbatim; ADR 83 applies it framework-wide.

**Status (original):** PROPOSED 2026-07-13 (Fable, for Ryan)
**Revises:** ADR 80 §6 (cascade) + §7's `ownAndInheritedHooks` — replaces the runtime parent-walk with a construction-time fold. The naming (`on[When][Who][What]`), the typed `CommandRegistry`→`CommandHooks` derivation, the `(value, ctx)` contract, and the `liftMiddleware` fiber invariant (§4/§5/§7) are **unchanged**.
**Defers:** ADR 81 to middleware-only — the hook cascade no longer needs the construction-parent pointer.

## TL;DR

The construction hierarchy (gateway → app → session → sub-harness) is a **scope chain**. A harness's effective hooks = every ancestor's layer merged with its own. ADR 80 resolved that by walking `this.parent` at every op (`ownAndInheritedHooks`) — which needs correct parent pointers (ADR 81, unbuilt) and hits a construction-ordering knot.

Resolve it the way tools already do: **fold the chain once, at construction.** Each scope computes `resolved = parentResolved.extend(ownHooks)` and threads the resolved value into the harnesses it builds. Every op reads the local, fully-resolved `this.hooks`. The fold _is_ the walk, memoized at each node — same cascade, computed at birth instead of per-op. No parent pointers, no ordering knot, and `extend` composes per-command (hooks are middleware — both ancestor and descendant fire, outer-first).

## Why revise (the parent-walk's two costs)

1. **It needs the parent chain** — `ownAndInheritedMiddleware`/`ownAndInheritedHooks` walk `this.parent`, which most harnesses drop (ADR 81). Unbuilt, and a real refactor.
2. **The ordering knot** — the per-session sub-harnesses are built _before_ the `SessionHarness` that would parent them (`app/harness.ts:1192–1332` vs `:1345`), so there's nothing to point at yet.

A **value** has neither problem. The resolved hooks for a scope is a plain immutable object; compute it once (before constructing anything) and hand the same value to every harness in that scope. The knot dissolves because a value needs no live parent to exist, and pointers vanish because ops read a local field.

## Design

### 1. `Hooks` — an immutable per-command layer

```ts
// @agentick/runtime — holds LISTS per command so layers COMPOSE (can't use a flat
// object: two layers both setting onBeforeToolDispatch would collide on the key).
export class Hooks {
  private constructor(
    private readonly byCommand: ReadonlyMap<string, { before: BeforeHook[]; after: AfterHook[] }>,
  ) {}
  static readonly empty = new Hooks(new Map());

  /** Index a declarative CommandHooks object into per-command before/after lists. */
  static from(config: CommandHooks): Hooks {
    /* deriveHookNames-in-reverse over the keys */
  }

  /** COMPOSE, not override: append `child`'s lists after this layer's, per command (outer-first).
   *  This is the ONE place hooks diverge from tools (which override last-wins). */
  extend(child: Hooks): Hooks {
    /* concat before[]/after[] per command id */
  }

  /** The composed middleware entries for one op — already cascade-resolved, lifted through
   *  the SAME liftMiddleware path as .use (ADR 80 §7 fiber invariant, unchanged). */
  forOp(opName: string): Middleware[] {
    const [b, a] = deriveHookNames(opName);
    const slot = this.byCommand.get(canonical(opName));
    return [
      ...(slot?.before ?? []).map((h) => liftMiddleware(asBefore(h))),
      ...(slot?.after ?? []).map((h) => liftMiddleware(asAfter(h))),
    ];
  }
}
```

### 2. The fold down the scope chain (config flows at construction, like tools)

Each scope contributes its own `hooks` (`createApp({ hooks })`, `createSession({ hooks })`) and threads the **resolved** value onward:

```ts
// app ctor:      this.hooks = (gatewayHooks ?? Hooks.empty).extend(Hooks.from(opts.hooks ?? {}))
// createSession: const sessionHooks = this.hooks.extend(Hooks.from(input.hooks ?? {}))
//                // computed ONCE, at the top of createSessionBody — before any harness exists,
//                // so it threads into the SessionHarness AND every per-session sub-harness with
//                // no ordering knot and no parent pointer.
```

`BaseHarnessOptions.hooks` becomes a resolved `Hooks` (not the flat `CommandHooks`); `this.hooks = options.hooks ?? Hooks.empty`. App-shared spine (loop/executor) fold the _app's_ resolved hooks (correct — session hooks never reach them); per-session harnesses fold the _session's_ (app + session).

### 3. The compose-site read (replaces the walk)

```ts
const composed = composeMiddleware<I, R, E>(
  [
    ...callMiddleware,
    ...this.ownAndInheritedMiddleware(), // middleware KEEPS the parent-walk (see §5)
    ...this.hooks.forOp(resolvedOp.name), // hooks: local, already cascade-resolved — no walk
  ],
  body,
);
```

`ownAndInheritedHooks` is **deleted.**

### 4. Runtime imperative (`.hooks.append`)

`this.hooks` is a mutable holder of an immutable value: `session.hooks.append(name, fn)` → `this.hooks = this.hooks.extend(Hooks.from({ [name]: fn }))`. Local, dynamic, affects this harness's future ops. The declarative fold is the static base; the imperative accessor overlays live.

## What this costs (vs the parent-walk)

The fold **snapshots** the parent's hooks at the child's construction — static. Mutating `app.hooks` after a session exists does **not** reach that session (its fold already ran). The 90% (policy set at boot, `session.hooks.append` at runtime) is unaffected; the 10% forfeited is _runtime-retroactive deployment policy_ (flip an audit hook onto all already-live sessions). If that need materializes, the parent-walk is the tool — but it's not free (ADR 81), so we don't pay for it speculatively.

## Relationship to ADR 80 / 81

- **ADR 80:** the mechanism (types, contract, fiber invariant, naming) stands; only §6/§7's _collection method_ changes (walk → fold). PR #1's `asBefore`/`asAfter`/`liftMiddleware`/`deriveHookNames` are reused verbatim; `ownAndInheritedHooks` is replaced by `Hooks.forOp` + the fold. Cheap because the cascade is dormant (nothing consumes it yet).
- **ADR 81:** the construction-parent invariant is no longer a hook prerequisite. It remains relevant only for ADR-76 tier-3 **middleware** (`app.use`), whose dynamism the walk still serves. So ADR 81 narrows to "if/when middleware needs the deployment-wide dynamic walk," and the hook work stops waiting on it.

## Rejected

- **Keep the parent-walk for hooks.** Needs ADR 81 + eats the ordering knot for a dynamism (runtime-retroactive) hooks rarely need.
- **A general `ScopedConfig<T>` for tools + hooks + knob-defaults.** They share a _shape_ (a layer + a merge, folded down the scope chain) but the **merge differs**: hooks compose, tools override. One god-object forces a lowest-common-denominator merge or a strategy param. Ship `Hooks` with compose-merge; let tools keep their override-merge. Shared shape, per-type merge.
- **A flat merged `CommandHooks` object as the resolved value.** Can't hold two layers' hooks for the same command (key collision) — compose needs lists per command, hence the `Hooks` class.

## Tests

- `Hooks.extend` **composes** (app + session both set `onBeforeToolDispatch` → both fire, outer-first), not overrides.
- `Hooks.from` indexes a `CommandHooks` object; `forOp` returns the lifted entries for the op, `[]` for an unhooked op (byte-identical composed chain).
- **Fold correctness:** a hook set at `createApp` fires for an op in a session created after; a `createSession` hook fires only for that session; the two compose.
- **No-knot proof:** per-session sub-harnesses receive the session's resolved hooks though built before the `SessionHarness` (the value is computed first).
- **Static boundary (documented):** mutating `app.hooks` after a session exists does not reach it; `session.hooks.append` does.
- **Fiber invariant unchanged:** `forOp` lifts through `liftMiddleware` — the ADR-80 §7 fiber tests pass against the folded path.

@see ADR 80 (the mechanism this re-collects), ADR 81 (narrowed to middleware), and the tools layering (`app/harness.ts` — the config-cascade prior art this generalizes).
