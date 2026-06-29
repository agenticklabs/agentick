# ADR 41 — Unified `AgentickError` class hierarchy

**Status:** Proposed — 2026-06-29.
**Touches:** every v2 package that raises typed errors. Concretely: `@agentick/spec-next` (18 union types, ~94 of the ~104 tags live here), `@agentick/runtime-next` (`OperationOutcomeError` — already class-shaped, becomes the template), `@agentick/mcp-next` (`McpServerError`, `McpClientError`, `McpRemoteTaskNonCompletedError`), `@agentick/sandbox-next` (`SandboxError`), `@agentick/tool-executor-next`, `@agentick/cluster-next`, `@agentick/tasks-next`, `@agentick/cluster-broker-next`. **The other 22 v2-next packages have zero typed errors and are not touched.**
**Driver:** Convert v2's typed-error convention from POJO `_tag` discriminated unions to class instances that subclass a common `AgentickError` base. Reason: cross-cutting code (logging, telemetry, error-boundary fallback, gateway extension error reporting, cluster wire codec) needs an `err instanceof AgentickError` check today and cannot get it because every error is a structurally-shaped object. Symptom that surfaced the gap: `SecurityError extends Error` was written by hand in the MCP server pipeline (#171c part 1), reviewed in `2b42039c`, and reverted because it was out of pattern with the surrounding `_tag` POJOs. Both shapes were wrong for cross-cutting; this ADR picks the right one.

---

## TL;DR

1. **Every typed error v2 raises subclasses `AgentickError`.** `AgentickError extends Error`. Single canonical home: `@agentick/spec-next/errors`. `err instanceof AgentickError` is the cross-cutting predicate — gateway extensions, telemetry, cluster wire codec, error-boundary fallback all use it.

2. **Two-level hierarchy.** `AgentickError` (root, abstract) → per-domain **abstract** intermediates (`AppError`, `SessionError`, `ToolExecutorError`, `McpServerError`, …) → concrete error classes (`SessionAlreadyExistsError`, `ToolNotFoundError`, `McpServerAuthRejected`, …). `err instanceof AppError` catches anything an `AppHarness` can raise; `err instanceof SessionAlreadyExistsError` narrows further. Concrete classes carry domain fields as constructor args.

3. **`_tag` survives as a `readonly literal` on the concrete class.** `class ToolNotFoundError extends ToolExecutorError { readonly _tag = "ToolNotFoundError" as const; … }`. This preserves the two ergonomics that already exist: Effect's `Effect.catchTag("ToolNotFoundError", h)` works unchanged, and `switch (err._tag) { case "ToolNotFoundError": … }` still gets exhaustiveness checking through TS's discriminated-union narrowing. The POJO shape and the class shape are equivalent at the type level; only the runtime gains an `instanceof` chain.

4. **The current union *types* survive as type aliases over the new classes.** `type ToolExecutorErrorChannel = ToolNotFoundError | ToolValidationError | …`. Effect signatures keep referring to the union for exhaustiveness; the abstract class is for runtime `instanceof`. Adopters who don't need exhaustiveness can type-relax to the abstract: `Effect.Effect<A, ToolExecutorError, R>`.

5. **Construction = object arg, never positional.** `new SessionAlreadyExistsError({ sessionId, cause })`. The arg object's shape matches the current POJO 1:1 (minus `_tag`) — minimizes codemod diff and keeps call-sites readable. Positional args (`new Foo("x", id, cause)`) get unreadable past 2 params; reject.

6. **`cause` is standard ES2022 `Error.cause`, NOT a custom field.** All typed errors flow the inner cause through `super(message, { cause })`. The class's body holds only domain fields (`sessionId`, `toolId`, `connectionId`, …). Eliminates the current inconsistency where some POJOs carry `.cause`, others carry `.reason`, others carry the raw value as a bare field.

7. **`name` is set in the constructor.** `this.name = "SessionAlreadyExistsError"`. Required for `Error.prototype.toString()` to print the right class — V8 inherits `name` from `Error` otherwise. Three lines of boilerplate per class; not worth deduplicating via a mixin.

8. **JSON codec lives in `@agentick/spec-next/errors/codec`.** `serializeAgentickError(err)` → `{ _tag, message, fields, cause? }`. `deserializeAgentickError(o)` → `AgentickError` via a registry keyed by `_tag`. Every concrete class auto-registers on module import via a side-effect at the bottom of its file. The cluster wire and MCP error projection both go through the codec — no ad-hoc per-package serialization.

9. **`OperationOutcomeError` already follows the pattern.** Class, `readonly _tag = "OperationOutcomeError" as const`, domain fields (`outcome`, `terminal`), `name` set in constructor. The migration ports OperationOutcomeError under `AgentickError` and uses it as the worked example in the package README — no behavior change, just inheritance.

10. **Abstract intermediates carry NO data.** `abstract class AppError extends AgentickError {}`. Empty body. Their job is the `instanceof` group; concrete subclasses hold the fields. Resist the temptation to put a `kind` discriminator or shared fields on intermediates — that's what `_tag` and TS narrowing already provide.

11. **Effect signatures stay union-typed; `Effect.catchTag` works unchanged.** Effect's runtime only looks at the `_tag` property; class instances pass that check. `Effect.fail(new SessionAlreadyExistsError({ sessionId }))` flows through `Effect.catchTag("SessionAlreadyExistsError", h)` without integration code. Exhaustiveness in `Effect.catchAll` still relies on the union type.

12. **Conformance test pins the invariant.** A package-agnostic spec-conformance test (in `@agentick/spec-conformance-next`) iterates the global registry and asserts: every registered class extends `AgentickError`; the abstract intermediate (if any) extends `AgentickError`; `_tag` is a non-empty string; round-trips through `serializeAgentickError`/`deserializeAgentickError`; `instanceof` chain returns the registered class on the deserialized output.

13. **One non-Error survivor: `CursorEvictedError`.** It's an `Error` subclass thrown from the journal cursor's `next()` (not flowed through `Effect.fail`). Convert under the hierarchy too — promote to `class CursorEvictedError extends JournalError` with `_tag = "CursorEvictedError"`. Cursor consumers were already catching it via `instanceof`; that path continues working.

14. **Migration lands on a dedicated branch** (`feat/v2-error-infra`, off `feat/v2`). One commit per package cluster. Conformance test lands last. Merge to `feat/v2` when typecheck + every package's tests are green AND the conformance gate passes. No `_tag` POJO `Effect.fail` site survives the merge.

15. **No compatibility shim.** Per CLAUDE.md "no backwards compatibility, no deprecations" — the codemod sweep is comprehensive; we don't ship a v2 with two error conventions. If a third-party adopter has already started consuming v2 error shapes pre-1.0 (none have at time of writing), they migrate when they upgrade.

---

## Context

### The duality today

Two error-construction patterns coexist in v2 without an articulated reason for the split:

**Pattern P (POJO `_tag`).** Vast majority — ~104 distinct `_tag` literals across `packages-next/`. Raised via `Effect.fail({ _tag: "X", …fields })`. Caught via `Effect.catchTag("X", h)` or `switch (err._tag)`. Union types document the channel (`type AppError = SessionAlreadyExistsError | …`).

**Pattern C (class `extends Error`).** Two cases — `OperationOutcomeError` (runtime-next, dual-mode: `extends Error` AND `_tag = "OperationOutcomeError"`) and `CursorEvictedError` (spec-next, `extends Error`, no `_tag`). One-off, not declared as the convention anywhere.

The user (Ryan) flagged the split when reviewing #171c part 1: a hand-written `SecurityError extends Error` in the MCP server security pipeline was out of pattern with surrounding `_tag` POJOs. We converted that one site back to POJO in `2b42039c`. The deeper observation: **neither shape is right alone.** Cross-cutting code wants an `instanceof` chain; pattern matching wants `_tag`. The current state forces every cross-cutting consumer to write `(err as any)._tag === "X" || err instanceof Error && err.message.includes(…)`, which is what `OperationOutcomeError` was built to avoid — and ended up the lone class in a sea of POJOs.

### Why now (vs deferring to post-1.0)

Two reasons:

1. **Every new `_tag` site adds codemod surface.** #171 (MCP server) is mid-flight; #171d (prompts/elicitation/tasks projection), #171e (HTTP/OAuth), #171f (WebSocket), #171g (direct projection) will each introduce new tags. Landing them on POJO and converting later means doing the conversion twice. The cost grows linearly with each additional slice.

2. **The user signaled regroup.** Quote: "ok let's do these and then re-group… we'll inventory the v2 errors and make an AgentickError class that they all sub-class". The "regroup" was explicitly framed as *between* cleanup and the next big slice, not after the entire feature is done.

### Why a hierarchy and not a flat shape

Considered: every error subclasses `AgentickError` directly, no intermediates. ~104 concrete classes hanging off one root.

Rejected: handlers that want to react to "any error from the App layer" or "any error from the MCP server" become `err instanceof AgentickError && err._tag.startsWith("App")` — string prefix matching on a discriminator is brittle, untyped, and reinvents the inheritance chain in the wrong place. Two-level (`AgentickError → AppError → SessionAlreadyExistsError`) lets the type system answer the group question with `instanceof AppError`.

Also considered: deeper hierarchy (`AgentickError → HarnessError → SessionHarnessError → SessionAlreadyExistsError`). Rejected — no concrete use case for the middle layer. YAGNI.

### Why keep `_tag`

A class hierarchy alone could replace `_tag` with `class.name` or `instanceof` checks everywhere. Rejected for three reasons:

1. **Effect's `catchTag` reads `_tag`.** Removing it forces every `catchTag` call site to become a `catchAll` + manual `instanceof` switch. That's a regression in ergonomics for the largest single category of error-handling code.

2. **Exhaustive `switch (err._tag)` is the dominant pattern in the codebase.** It compiles to a JS switch on a string; class-based discrimination needs `if/else if/else if` cascades or an `instanceof` chain. Slower, uglier, harder to extend.

3. **Cluster wire codec needs a string key.** `_tag` is already the right shape for the wire — a string discriminator that maps to a class via the registry. `class.name` works but is mangleable by minifiers; an explicit `_tag` literal is immune.

`_tag` is cheap (one line per class) and additive. Keep it.

---

## Design

### Base class

```ts
// @agentick/spec-next/errors/base.ts

export abstract class AgentickError extends Error {
  /** Discriminator. Each concrete subclass declares its own literal. */
  abstract readonly _tag: string;

  /**
   * Stable framework-wide error code. Empty by default; concrete
   * classes that want telemetry-friendly codes override
   * (e.g. `"AGNT_SESSION_NOT_FOUND"`). Optional — `_tag` is enough for
   * 95% of consumers.
   */
  readonly code?: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // `this.constructor.name` resolves to the concrete subclass name
    // when called via `new SessionAlreadyExistsError(...)`. No need
    // for subclasses to set `name` manually.
    this.name = this.constructor.name;
  }

  /**
   * Default JSON projection. Concrete classes override only if they
   * need to omit a sensitive field (e.g. `cause` containing a secret)
   * or rename one. Most don't override.
   */
  toJSON(): { readonly _tag: string; readonly message: string; readonly [k: string]: unknown } {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this)) {
      if (k === "name" || k === "message" || k === "stack") continue;
      fields[k] = v;
    }
    return { _tag: this._tag, message: this.message, ...fields };
  }
}
```

Subclasses with `this.name = …` (the OperationOutcomeError pattern) are wrong going forward — the base sets it via `this.constructor.name`. One less line per concrete class.

### Per-domain intermediates

One abstract intermediate per current union type. Empty body — the class exists only so `instanceof` answers the group question.

```ts
// @agentick/spec-next/errors/app.ts
export abstract class AppError extends AgentickError {}

// @agentick/spec-next/errors/session.ts
export abstract class SessionError extends AgentickError {}

// @agentick/spec-next/errors/journal.ts
export abstract class JournalError extends AgentickError {}

// @agentick/spec-next/errors/inbox.ts
export abstract class InboxError extends AgentickError {}

// … one per current union (18 of them).
```

The intermediates map to the inventory's 18 union types, plus a few that don't currently have a union but should (`SandboxError`, `McpServerError`). The full list is finalized at codemod time; this ADR doesn't enumerate them — the inventory in §"Current state" is the source.

### Concrete classes

The pattern, worked example:

```ts
// @agentick/spec-next/errors/session-concrete.ts

export class SessionAlreadyExistsError extends SessionError {
  readonly _tag = "SessionAlreadyExistsError" as const;
  readonly sessionId: string;

  constructor(args: { readonly sessionId: string; readonly cause?: unknown }) {
    super(`session ${args.sessionId} already exists`, { cause: args.cause });
    this.sessionId = args.sessionId;
  }
}

export class SessionNotFoundError extends SessionError {
  readonly _tag = "SessionNotFoundError" as const;
  readonly sessionId: string;

  constructor(args: { readonly sessionId: string; readonly cause?: unknown }) {
    super(`session ${args.sessionId} not found`, { cause: args.cause });
    this.sessionId = args.sessionId;
  }
}

// Auto-register.
registerAgentickError(SessionAlreadyExistsError);
registerAgentickError(SessionNotFoundError);
```

### The union types — what changes, what stays

**Before:**
```ts
export type AppError =
  | { readonly _tag: "SessionAlreadyExistsError"; readonly sessionId: string }
  | { readonly _tag: "SessionNotFoundError"; readonly sessionId: string }
  | { readonly _tag: "AppClosedError"; readonly appId: string }
  | { readonly _tag: "AppExecutionFailed"; readonly cause: unknown };
```

**After:**
```ts
// The abstract intermediate. `instanceof AppError` is the group check.
export abstract class AppError extends AgentickError {}

// Concrete classes (each in its own file or grouped — file layout
// doesn't matter; tree-shaking handles unused).
export class SessionAlreadyExistsError extends AppError { … }
export class SessionNotFoundError extends AppError { … }
export class AppClosedError extends AppError { … }
export class AppExecutionFailed extends AppError { … }

// The union type — kept for exhaustive switch / Effect's E channel.
// Same name as before; consumers don't change their imports.
// Note: this type-alias name collides with the abstract class. Since
// TS distinguishes type-space and value-space, this works — `AppError`
// as a value is the abstract class, as a type is the union.
export type AppError =
  | SessionAlreadyExistsError
  | SessionNotFoundError
  | AppClosedError
  | AppExecutionFailed;
```

The name collision (`AppError` is BOTH the abstract class value AND the union type) is intentional. Consumers of the union don't change their imports or signatures; consumers wanting `instanceof` get the abstract class under the same name. TypeScript's separate type/value namespaces make this work cleanly. It's how `Date` works in stdlib (the class is also a type referring to instances).

### Registry + codec

```ts
// @agentick/spec-next/errors/registry.ts

type AgentickErrorClass = new (...args: any[]) => AgentickError;

const registry = new Map<string, AgentickErrorClass>();

export function registerAgentickError(cls: AgentickErrorClass): void {
  // Read the prototype's _tag — set by `readonly _tag = "..." as const`
  // on instances, but since it's a class field with an initializer it
  // exists on the prototype.
  const tag = (cls.prototype as { _tag?: string })._tag;
  if (!tag) {
    throw new Error(`Class ${cls.name} cannot be registered: no _tag declared on prototype`);
  }
  if (registry.has(tag)) {
    throw new Error(`AgentickError tag '${tag}' already registered`);
  }
  registry.set(tag, cls);
}

export function lookupAgentickError(tag: string): AgentickErrorClass | undefined {
  return registry.get(tag);
}

export function isAgentickError(value: unknown): value is AgentickError {
  return value instanceof AgentickError;
}
```

Codec:

```ts
// @agentick/spec-next/errors/codec.ts

export function serializeAgentickError(err: AgentickError): unknown {
  return err.toJSON();
}

export function deserializeAgentickError(obj: unknown): AgentickError {
  if (typeof obj !== "object" || obj === null) {
    throw new Error("Cannot deserialize non-object as AgentickError");
  }
  const o = obj as Record<string, unknown>;
  const tag = o._tag;
  if (typeof tag !== "string") {
    throw new Error("AgentickError JSON missing string _tag");
  }
  const Cls = registry.get(tag);
  if (!Cls) {
    // Unknown tag — wrap in a generic UnknownAgentickError so the
    // information isn't lost. Consumers that care use `instanceof`
    // against the known classes; this one survives `instanceof
    // AgentickError`.
    return new UnknownAgentickError({ originalTag: tag, payload: o });
  }
  // Concrete classes accept an object arg matching their public fields.
  // Strip `_tag` (it's set by the class's field initializer) and pass
  // the rest as the constructor arg.
  const { _tag: _, message, ...fields } = o;
  const instance = new Cls(fields as any);
  // Restore message if the constructor's default didn't produce the
  // same one (rare; usually the constructor reconstructs it from fields).
  if (typeof message === "string" && instance.message !== message) {
    (instance as { message: string }).message = message;
  }
  return instance;
}
```

`UnknownAgentickError` handles the "we received an error tag we don't have a class for" case — happens when a cluster broker forwards an error from a newer node to an older one. Carries the original payload for debugging without dropping data.

### Effect integration

No changes to Effect itself; everything works because class instances pass the structural-discriminator check Effect uses internally:

```ts
// Before:
const x: Effect.Effect<A, ToolNotFoundError | ToolValidationError, R> = …;
Effect.catchTag(x, "ToolNotFoundError", h);

// After:
const x: Effect.Effect<A, ToolNotFoundError | ToolValidationError, R> = …;
Effect.catchTag(x, "ToolNotFoundError", h);

// New option (was always possible but unergonomic with POJOs):
const x: Effect.Effect<A, ToolExecutorError, R> = …;  // typed to the abstract
Effect.catchIf(x, (err): err is ToolNotFoundError => err instanceof ToolNotFoundError, h);
```

`Effect.catchTag` reads the `_tag` property — class instances expose it as an own property after construction (field initializer sets it on `this`), so the lookup works. Verified by writing a 5-line scratch test in the inventory pass; not pinned in this ADR but the conformance test does pin it.

### Cluster wire compatibility

`@agentick/cluster-next` wire payloads serialize errors via `serializeAgentickError`; deserialization on the receiving side rehydrates classes. ADR 35 §"InboxError round-trip fidelity" already requires preserving typed routing failures across the wire (Phase 3.2 (4), #189) — this ADR is the natural mechanism. The current InboxError round-trip uses an ad-hoc JSON schema; that gets replaced by the codec in this ADR.

Migration note: the cluster wire's existing InboxError serializer is two layers deep — `cluster-broker-next/framing.ts` carries the bytes, `cluster-next/wrappers/` handles the InboxError shape. Both reroute through `(de)serializeAgentickError` in the migration; no protocol-version bump because the on-the-wire JSON shape is unchanged (still `{_tag, message, ...fields}`).

### MCP wire compatibility

The MCP server's tools/call response uses `{ isError: true, content: [...] }` for handler exceptions today. This ADR doesn't change that protocol-level shape — the JSON-RPC error code mapping for protocol errors (auth rejected, etc.) maps from `AgentickError._tag` to MCP error codes in `@agentick/mcp-next/server/projection/`. The mapping table is internal; the wire stays MCP-spec-compliant.

---

## Current state

(Source: inventory pass on `feat/v2` at commit `04f6a307`.)

### Packages with typed errors

| Package | # Tags | # Unions | `extends Error` classes |
|---|---|---|---|
| `spec-next` | 94 | 18 | — |
| `sandbox-next` | 7 | 1 (`SandboxError`) | — |
| `mcp-next` | 5 | 3 | — |
| `tool-executor-next` | 4 | 0 (inline) | — |
| `cluster-next` | 4 | 2 (wrapper guards) | — |
| `runtime-next` | 3 | 1 (`RequestError`) | 1 (`OperationOutcomeError`) |
| `tasks-next` | 1 | — | — |
| `cluster-broker-next` | 1 | 1 | — |
| `spec-next` (extra) | — | — | 1 (`CursorEvictedError`) |
| (22 other packages) | 0 | 0 | 0 |

Rough scale: **~104 concrete classes** to land, **~20 abstract intermediates** (18 existing unions + `SandboxError` + a possible `RequestError` intermediate). Total ~125 new class declarations, distributed across 8 packages.

### Spec-next union types — what becomes a per-domain intermediate

`SubstrateError`, `JournalError`, `InboxError`, `MessageHandlerError`, `LifecycleHandlerError`, `AppError`, `GatewayError`, `SessionError`, `StateApplyError`, `LoopExecutorError`, `ReconcileError`, `ToolExecutorError`, `PromptsError`, `SkillsError`, `KnobsError`, `McpServerError`, `ExecuteError`, `TimelineError`. (18.)

Each becomes an abstract intermediate class extending `AgentickError`; the existing union type alias survives at the same name (type/value collision is intentional, see §"The union types").

---

## Migration plan

### Branch + sequencing

1. **Stay on `feat/v2`** for this ADR commit. No code churn yet.
2. **Cut `feat/v2-error-infra` off `feat/v2`** for the implementation. (Branch, not worktree.)
3. Commit sequence:
   - **a)** Base class + registry + codec in `@agentick/spec-next/errors/` (new module). Tests for the codec round-trip. No other packages touched yet.
   - **b)** Promote `OperationOutcomeError` and `CursorEvictedError` under the base. Verify they still work as before (zero behavior change, just an `extends` chain swap).
   - **c)** Convert `spec-next`'s 18 union types: per union, one commit that defines the abstract intermediate + concrete classes + auto-registration, then updates the union type alias to the new shape. Each commit's test suite must stay green before moving to the next.
   - **d)** Per-package conversion of consumers: `runtime-next`, `tool-executor-next`, `mcp-next`, `sandbox-next`, `cluster-next`, `cluster-broker-next`, `tasks-next` — one commit each, ordered by dependency-graph depth (`runtime-next` first, others can interleave).
   - **e)** Conformance test in `@agentick/spec-conformance-next` that asserts the invariant: every registered tag instantiates to an `AgentickError`; round-trips through the codec; abstract intermediates extend the base; no orphan tags (tags raised in source but not registered).
   - **f)** Sweep: grep all of `packages-next/` for `Effect.fail\(\{ _tag:` — must return zero hits.
4. **Merge `feat/v2-error-infra` → `feat/v2`** when all packages typecheck + test + conformance gate passes.

### Codemod approach

The conversion is mechanical for the common case:

**Before:**
```ts
yield* Effect.fail({
  _tag: "SessionNotFoundError" as const,
  sessionId: id,
});
```

**After:**
```ts
yield* Effect.fail(new SessionNotFoundError({ sessionId: id }));
```

A first-pass codemod (e.g. ts-morph script in `scripts/`) handles ~90% of sites; manual sweep cleans up:
- Sites where `_tag` is computed (rare; checked during inventory — only one case in `tool-executor-next` where the tag is selected by a `kind` variable; flatten manually).
- Sites where extra fields beyond the constructor's args were carried (audit each — likely indicates the constructor signature needs widening).
- Type-guard predicates (`isMessageHandlerError`, `isInboxError`, …) — replace the body with `err instanceof MessageHandlerError`.

Codemod script gets thrown away after the merge; not part of the framework.

### Risks

- **Effect's `catchTag` runtime check on class instances.** Confirmed working in inventory but not pinned by a test in this ADR. The conformance suite (step e) pins it.
- **`stack` propagation.** `Error.captureStackTrace` is V8-specific; on other engines the stack is captured at `super()` time. The base's `super(message, { cause })` is enough; nothing extra needed.
- **Bundler dead-code elimination.** Auto-registration relies on the module being imported. If a concrete error class is only constructed via the codec (i.e. the production code path never `new`s it) AND the codec is the only consumer, a bundler could prune it. Mitigation: every concrete class lives in the same module that exports its abstract intermediate, and adopter code that imports the intermediate (which it must, to type Effect signatures) keeps the module live. Tested in the conformance suite by deserializing every registered tag from JSON and asserting class identity.
- **Branch divergence.** `feat/v2` continues to accept #171d and small fixes during the codemod. Mitigation: rebase `feat/v2-error-infra` on `feat/v2` daily; keep the codemod commits clean enough to replay.

---

## Open questions

1. **`code` field on every error?** §"Base class" defines `code` as optional. Pre-1.0 we don't need stable error codes; if telemetry / customer-facing error messages later want them, populate per concrete class. Deferred decision; not blocking.

2. **Per-package error-namespace barrel exports?** Today errors live in `@agentick/spec-next` (94 of them) — should each consuming package re-export the errors it raises so adopters can `import { McpServerAuthRejected } from "@agentick/mcp-next"`? Lean yes for discoverability; defer to the per-package conversion commit to decide case-by-case.

3. **Localized messages?** Out of scope. Messages are English strings; if i18n is ever needed, it slots in via a `messageBuilder(args)` static or external resolver. Not blocking.

4. **Should `cause` chain through `toJSON`?** Currently yes (it's an own property after `super(message, { cause })`). For wire transmission this means `cause` traverses the wire. If `cause` is a raw `Error` (not an `AgentickError`), it serializes to `{}`. Mitigation: every Effect fail-path that wraps a foreign throw goes through `new XError({ cause: errorReason(unknown) })` (`errorReason` already in `@agentick/utils-next`). Conformance test pins this for the codec round-trip.

5. **Mode for `Effect.fail` literals in tests.** Tests currently `Effect.fail({ _tag: "...", ... })` directly to simulate errors. After conversion they use `new XError({...})`. Codemod handles both paths the same way; no special test-helper needed.

---

## References

- ADR 23 — MCP as harness (errors flow through harness operations; same shape applies)
- ADR 34 — Scoped capability cascade (cascading config doesn't touch errors; mentioned for context only)
- ADR 35 — Cluster protocol (cluster wire codec consumes this ADR's serializer)
- Inventory pass — 2026-06-29, `feat/v2` @ `04f6a307`. Sources: every `_tag:` literal under `packages-next/`, every `extends Error` class under `packages-next/`, all `isXError` type-guard predicates.
- Precedent — `OperationOutcomeError` (`packages-next/runtime/src/substrate/base-harness.ts:1136`) — the existing dual-mode class is the worked template.
