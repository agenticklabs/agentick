# @agentick/spec

**The contract package.** Every type that crosses a boundary — compiler to runtime, runtime to executor, harness to store, adapter to model, gateway to wire — is declared here exactly once.

This README is written for implementors: you are building a harness, a store adapter, a model adapter, or a transport, and you need to know what shape to satisfy, where a type lives, and how to add your own slot to the framework's types without patching the framework. Nothing here executes anything.

## Install

```bash
npm install @agentick/spec
```

| Subpath                   | Contents                                                                        |
| ------------------------- | ------------------------------------------------------------------------------- |
| `@agentick/spec`          | Everything — data, errors, protocol, wire, client, server, guards, derivation   |
| `@agentick/spec/data`     | Wire data shapes only (content blocks, entries, declarations, targets, results) |
| `@agentick/spec/protocol` | Protocol interfaces and store ports only                                        |
| `@agentick/spec/guards`   | Type guards only                                                                |

Import from the root barrel unless you are trimming a browser bundle; the subpaths exist so a client-side module can pull data shapes without dragging in protocol surface.

## What lives here — and what doesn't

Four constraints decide every admission:

- **No runtime logic.** The only functions that ship are total, self-contained, and stateless: a merge, a fold, a codec, a name builder, a type guard. Anything with a lifecycle, a scheduler, an I/O handle, or a cache belongs to the package that owns the lifecycle.
- **Zero runtime dependencies.** Every declared dependency (`effect`, the OpenTelemetry SDK types) is imported `type`-only. The emitted JavaScript imports nothing at all.
- **Browser-safe.** No Node built-ins, no `process`, no polyfill assumptions.
- **Two version axes.** `SPEC_VERSION` is a date string (`"2026-05-08"`) that moves when the wire format itself evolves; the npm package version is semver and moves on every release. Read the date when negotiating compatibility, not the semver.

```ts
import { SPEC_VERSION } from "@agentick/spec";

if (SPEC_VERSION < "2026-05-01") throw new Error("peer spec too old");
```

And one non-constraint that follows from them: **spec never enumerates the harnesses, providers, stores, or wire methods that exist.** There is no `KnownHarness` union, no provider registry, no `timeline?:` line anywhere in this package. Those facts arrive from the packages that own them, through the augmentation seams.

## The augmentation seams

A seam is an interface spec ships **empty** (or minimally seeded) for the sole purpose of being widened elsewhere. You widen one with TypeScript module augmentation from your own package, and the slot appears — typed — on the framework surface that reads that interface. Adopters who install your package see the slot; adopters who don't, never see it. Spec learns nothing.

```ts
// @acme/budget/src/augment.ts — type-only, zero runtime
export interface Budget {
  remainingUsd(): number;
  charge(usd: number): void;
}

declare module "@agentick/spec" {
  interface HookBridges {
    /** Present only when `withBudget()` is installed — guard before use. */
    readonly budget?: Budget;
  }
  interface RenderContext {
    readonly budget?: { readonly remainingUsd: number };
  }
  interface ToolHandlerCtxExtensions {
    readonly budget?: Budget;
  }
}
```

That is the whole mechanism. Three slots, three different framework surfaces, no change to any framework package — and the slots are typed on the spec interfaces themselves, so a consumer needs nothing but spec to read them:

```ts
import type { HookBridges, RenderContext, ToolHandlerCtx } from "@agentick/spec";

// A render-time reader: `bridges.budget` and `render.budget` are both typed
// by the augmentation above. Reached in a React tree via `useBridges()` and
// `useRenderContext()`; reached here directly, because the seam is the type.
function budgetLine(bridges: HookBridges, render: RenderContext): string | undefined {
  if (!bridges.budget) return undefined; // optional slot — always guard
  const left = render.budget?.remainingUsd ?? bridges.budget.remainingUsd();
  return `$${left.toFixed(2)} of budget remains.`;
}

// A dispatch-time reader: the same value, resolved fresh from the live bridge
// and spread onto every tool handler's ctx.
function charge(ctx: ToolHandlerCtx, usd: number): void {
  ctx.budget?.charge(usd);
}
```

> [!WARNING]
> **A type-only `declare module` file with no top-level `import` or `export` is a script, not a module — and TypeScript reads its `declare module "@agentick/spec"` as an _ambient module declaration that replaces_ `@agentick/spec` instead of merging into it. Every real export of the package vanishes and the failure surfaces in a _different_ package as "has no exported member".** Add `export {};` to any augmentation file that would otherwise have no top-level import or export. Several files in this workspace carry that empty export with a comment explaining why; it is load-bearing.
>
> ```ts
> export {}; // ← without this, the block below SHADOWS the module
>
> declare module "@agentick/spec" {
>   interface WireNotifications {
>     "acme/ping": { params: { at: number } };
>   }
> }
> ```

### The seams, and what each one lights up

| Seed                                                                | What it seeds                                                 | Widened by                                                   | What appears                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `HookBridges`                                                       | The live harness implementations the runtime hands a mount    | Every harness package's `augment.ts`                         | `useBridges().timeline`, `bridges.knobs`, `bridges.sandbox?`          |
| `NamespaceSlots`                                                    | The top-level config slots on `createApp`                     | Each namespace package's `augment.ts`                        | `createApp(Agent, { timeline: defineTimeline({ store }) })`           |
| `SessionHarnessProtocol<P>`                                         | The session facade                                            | Each namespace package's `augment.ts`                        | `session.timeline`, `session.knobs`, `session.tasks`, `session.gates` |
| `ToolHandlerCtxExtensions`                                          | Optional dispatch-resolved slots on a tool handler's `ctx`    | Optional harness packages                                    | `ctx.sandbox?.get("primary")` inside a handler                        |
| `RenderContext`                                                     | Per-render facts the IR is a function of, read synchronously  | Whoever produces the fact (the loop, the session, your code) | `useRenderContext().budget?.remainingUsd`                             |
| `ProviderClientOptions` · `ProviderOptions` · `ProviderToolOptions` | Provider escapes at client, per-call, and per-tool level      | Model adapter packages                                       | `target.providerOptions.openai`, typed as the SDK's own params        |
| `WireMethods` · `WireNotifications`                                 | The JSON-RPC method and notification registry                 | Harness `wire-augment.ts` files, adopter wire extensions     | Typed `client.request("timeline/compact", …)` + derived wire hooks    |
| `EventScopeExtensions`                                              | Harness-specific identifier dimensions on every event's scope | Harnesses with their own routing id                          | `event.scope.sandboxId`; subscribe filtered by that dimension         |
| `SessionHandleExtensions`                                           | Client-side per-harness sub-handles                           | Each harness's `/client` subpath                             | `client.session(id).timeline`, `.tasks`, `.knobs`                     |
| `ClientNamespaces`                                                  | Client-level namespaces                                       | Client extension packages                                    | `client.offline.flush()`                                              |
| `ClientLifecycleEvents`                                             | The client lifecycle event registry                           | Client extension packages                                    | A typed listener for your own event name                              |
| `ClientCapabilityExtensions`                                        | Capability metadata richer than a boolean                     | Extension packages                                           | `capabilities.ext.mcp?.authFlavors`                                   |
| `AppExtensions` · `SessionExtensions`                               | Extension-installed harnesses at app and session scope        | Optional extension packages                                  | `app.extensions.sandbox?`, `session.extensions.<name>`                |
| `GatewayBridges` · `GatewayExtensions`                              | Gateway-scope singletons and extensions                       | Gateway-scope packages                                       | `gateway.bridges.credentials`, `gateway.extensions.mcpServers?`       |
| `MessageSource`                                                     | Inbound platform provenance, stamped at `metadata.source`     | Connector packages                                           | `metadata.source.telegram?.chatId`                                    |
| `RuntimeContextUser`                                                | Your ambient state on every `ctx`                             | Your application                                             | `ctx.user?.tenantId` in any handler, hook, guard, or store method     |
| `StoreCtxExtensions`                                                | Store-only ambient fields across the Effect/Promise edge      | Store adapter packages                                       | `ctx.tenantShard` inside a store method                               |
| `ErrorData`                                                         | Typed `data` payloads keyed by JSON-RPC error code            | Anyone adding a code                                         | `err.data` narrowed once you match the code                           |

Two of these deserve more than a row.

### `HookBridges` — the live implementations

The bundle the runtime hands a compiler mount as `MountInput.bridges`; render-time hooks reach it through context. Spec seeds only the interface-only contracts that have no package of their own to augment from — `data`, `loop`, `session` required, `tools` and `models` optional. A slot backed by a real harness is contributed by that harness:

```ts
// @agentick/timeline/src/augment.ts
import type { TimelineHarnessProtocol } from "@agentick/spec";

declare module "@agentick/spec" {
  interface HookBridges {
    readonly timeline: TimelineHarnessProtocol;
  }
}
```

Required (`readonly timeline:`) for a bundled namespace that is always installed; optional (`readonly sandbox?:`) for anything the adopter opts into. Snapshot and restore walk `HookBridges` generically and feature-test each slot with `isSnapshotCapable` — so declaring `SnapshotCapable<YourSnapshot>` on your protocol is the entire opt-in, and no framework package ever learns your slot name.

```ts
import { isSnapshotCapable, type SnapshotCapable } from "@agentick/spec";

export interface BudgetSnapshot {
  readonly spentUsd: number;
}
export interface BudgetProtocol extends SnapshotCapable<BudgetSnapshot> {
  charge(usd: number): void;
}

declare const bridge: unknown;
if (isSnapshotCapable(bridge)) await bridge.exportSnapshot();
```

### `RenderContext` — the facts, not the implementations

The render-**input** twin of `HookBridges`. `HookBridges` carries what a render can call; `RenderContext` carries what is _true_ for the render being produced. Two slots are seeded because the loop and session are their producers and have no package of their own: `contextInfo` (`{ contextWindow?, usedTokens? }`, read by `useContextInfo`) and `activeModel` (`provider` / `modelId` / `capabilities`, read by `useActiveModel` with no dependency on any model package — so a tree can render _for the model it is about to call_).

The distinction is tense, and it decides which channel a new fact belongs on. A fact that must shape the current IR is forward-looking and rides render-context: the session resolves it, the loop threads it into the render, and a synchronous context read makes it visible during render. A fact about what already happened is backward-looking and rides the lifecycle projection instead. Routing a forward-looking fact through the async lifecycle path races the synchronous render and never lands in the IR.

### Provider options, and the one merge

Three seeds mirror the three structural levels at which a provider needs an escape hatch. Each adapter augments with the SDK's _actual_ config types, not a hand-rolled subset, so `target.providerOptions.acme` is exactly what you would write against that SDK directly:

```ts
declare module "@agentick/spec" {
  interface ProviderClientOptions {
    readonly acme?: { readonly apiKey: string; readonly baseURL?: string };
  }
  interface ProviderOptions {
    readonly acme?: { readonly seed?: number; readonly safety?: "off" | "strict" };
  }
  interface ProviderToolOptions {
    readonly acme?: { readonly strict?: boolean };
  }
}
```

| Seed                    | Scope                                                | Rides on                                                          |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `ProviderClientOptions` | SDK client construction — per executor, not per call | The adapter's own options                                         |
| `ProviderOptions`       | One generation request                               | `RenderedTree.providerOptions`, `ExecutionTarget.providerOptions` |
| `ProviderToolOptions`   | One tool definition                                  | `ToolDeclaration.providerOptions`                                 |

`mergeProviderOptions` is the single canonical fold, and every layer that stacks these uses it. Patch wins per provider namespace, one level deep — so two adopters decorating under different namespaces can never collide, and the same namespace's keys shallow-merge with the patch on top:

```ts
import { mergeProviderOptions } from "@agentick/spec";

mergeProviderOptions({ acme: { seed: 1, safety: "strict" } }, { acme: { seed: 7 } });
// → { acme: { seed: 7, safety: "strict" } }
```

Do not hand-roll it. A per-call-site merge is how a decoration silently disappears.

### Wire methods derive their own hooks

Augmenting `WireMethods` is the only declaration a new wire method needs. The key is statically known, so the runtime's command registry folds every row in wholesale and the typed interceptor names are _derived_ — `Pascal` (exported here) is the pure type-level function that mints them:

```ts
import type { Pascal } from "@agentick/spec";

declare module "@agentick/spec" {
  interface WireMethods {
    "acme/reindex": { params: { readonly tenant: string }; result: { readonly queued: number } };
  }
}

type Hook = `onBefore${Pascal<"wire:acme/reindex">}`;
//   ⇒ "onBeforeWireAcmeReindex"
```

`HooksOf`, `GuardsOf`, `RegistrarsOf`, `ChunkHooksOf`, `NamespaceHooksOf`, and `NamespaceGuardsOf` are the generics that turn a registry of `{ input, output }` rows into before/after, guard, registrar, and chunk-observer surfaces. They are pure and free in their context parameter, which is why both the server (bound to its runtime context) and the client (bound to a wire context) share one implementation.

## The helpers that do ship

Small, total, and shared — each exists because a second hand-rolled copy would drift.

| Helper                                                        | Does                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `mergeProviderOptions(base, patch)`                           | The one provider-namespace fold                                              |
| `toRegistration(declaration, binding)`                        | Tag a `ToolDeclaration` with a binding; `handlerRef` falls back to `id`      |
| `toClientToolRegistration(declaration, binding)`              | Fold a wire-declared client tool into a client-handled registration          |
| `jsonSchema(schema, options?)`                                | Wrap a raw JSON Schema object as a `StandardSchemaV1`                        |
| `toJsonSchema(schema)` · `registerJsonSchemaConverter`        | Recover JSON Schema from any Standard Schema; register a vendor converter    |
| `parseJsonWithSchema(text, schema)`                           | Text → typed value, never throwing; discriminates parse vs. schema failure   |
| `foldContentBlock` · `foldContentBlockWith`                   | Exhaustive dispatch over the `ContentBlock` union                            |
| `normalizeToolResult` · `toContentBlocks`                     | Tool-return normalization into content blocks                                |
| `resolveToolOutputBounder(options?)`                          | Build the tool-output size bounder from options; overridable, off-switchable |
| `logEventName` · `progressEventName` · `channelEventName`     | The canonical `<surface>:<domain>:<action>` name builders                    |
| `logEventQuery` · `progressEventQuery` · `timelineEventQuery` | Cross-surface subscriber queries over those names                            |
| `defineWireExtension(input)`                                  | Validate and normalize a wire extension declaration                          |
| `validateJsonRpcInput` · `validateJsonRpcFrame`               | Frame validation for transports                                              |
| `scopeCovers` · `intersectScopes`                             | Authorization scope-pattern algebra                                          |
| `deriveHookNames` · `pascalOfCommand` · `Pascal`              | Command hook-name derivation, value and type level                           |

Plus the guards. `@agentick/spec/guards` narrows every content block (`isTextBlock`, `isToolResultBlock`, `isMediaBlock`, …), every context entry, every event phase and outcome (`isTerminalEvent`, `isVetoed`, `isDeferred`, …), every lifecycle event kind, and every declaration kind — and feature-detects optional capabilities (`supportsLifecycleProjection`, `supportsTreeInterception`, `isSnapshotCapable`, `hasFeature`).

```ts
import { jsonSchema, parseJsonWithSchema, toJsonSchema } from "@agentick/spec";

const Ticket = jsonSchema<{ id: string }>({
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
});

toJsonSchema(Ticket); // the raw object back, field-for-field

const parsed = await parseJsonWithSchema('{"id":"T-1"}', Ticket);
if (parsed.ok) {
  parsed.value.id; // string
} else {
  // "invalid-json" (issues empty, `cause` is the SyntaxError) or "schema" (validator issues)
  console.error(parsed.reason, parsed.issues, parsed.text);
}
```

### Errors

`AgentickError` is the abstract root: a real `Error` subclass, so it is catchable as one and carries `stack` and `cause`. Concrete classes declare a literal `_tag`, register under it, and round-trip through the codec with class identity preserved — including across a process boundary.

```ts
import {
  AgentickError,
  deserializeAgentickError,
  registerAgentickError,
  serializeAgentickError,
} from "@agentick/spec";

export class BudgetExhausted extends AgentickError {
  readonly _tag = "BudgetExhausted" as const;
  readonly spentUsd: number;
  constructor(args: { readonly spentUsd: number; readonly cause?: unknown }) {
    super(`budget exhausted after $${args.spentUsd}`, { cause: args.cause });
    this.spentUsd = args.spentUsd;
  }
}
registerAgentickError("BudgetExhausted", BudgetExhausted);

const wire = serializeAgentickError(new BudgetExhausted({ spentUsd: 12.5 }));
const back = deserializeAgentickError(JSON.parse(JSON.stringify(wire)));
back instanceof BudgetExhausted; // true — and `back.message` survived
```

A tag the deserializing process has never heard of does not throw: it becomes `UnknownAgentickError` carrying the original payload, and re-serializes under the _original_ tag, so a middle hop forwards an error it cannot construct without corrupting it. `isAgentickError` narrows; `registerAgentickError` throws when two classes claim one tag, at import time.

> [!IMPORTANT]
> An abstract intermediate (`AppError`, `TimelineError`, …) that declares `_tag` must type it as a **literal union of its concrete tags**, not `string`. Widening to `string` silently defeats `Effect.catchTag` narrowing on every leaf below it.

## Adopter-facing aliases

Adopter-visible types carry no `Harness` or `Protocol` in the name. Each harness protocol therefore ships a noun alias next to it, and the alias is what appears in adopter-facing signatures:

| Alias       | Underlying                         | Reached at                           |
| ----------- | ---------------------------------- | ------------------------------------ |
| `Tools`     | `ToolExecutorProtocol`             | `app.tools`, tool wiring             |
| `Tasks`     | `TasksHarnessProtocol`             | `session.tasks`, `ctx.tasks`         |
| `Skills`    | `SkillsHarnessProtocol`            | `withSkills(...)`, a `skills` slot   |
| `Prompts`   | `PromptsHarnessProtocol`           | `withPrompts(...)`, a `prompts` slot |
| `Resources` | `ResourcesHarnessProtocol`         | `ctx.resource`, `session.resources`  |
| `Live`      | `LiveHarnessProtocol`              | `session.live`                       |
| `Elicit`    | The sugar surface over elicitation | `ctx.elicit`, `session.elicit`       |

The alias is strictly nominal — the protocol shape remains exported for power-user access, and `isToolsInstance` / `isTasksInstance` / `isSkillsInstance` / `isPromptsInstance` / `isResourcesInstance` discriminate a live instance from a declarative definition at a slot.

## Ports, for adapter authors

If you are writing storage, one seam is the whole contract. `Store<T, Q, M>` is `query` (read is always a projection shaped by a query), `mutate` (write is always a mutation applied to the source), an optional `watch` for changes you did not cause, and a `backend` label for observability. Every method takes `StoreCtx` as its final parameter — the explicit runtime scope carrier, which is what `StoreCtxExtensions` widens.

Two profiles specialize it, and every shipped port is one of them:

| Profile                           | Adds                                                               | Ports built on it                                                         |
| --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `CollectionStore<T, Q, PruneArg>` | `get` / `list` / `put` / `delete`, optional `prune` — keyed upsert | `SessionStore`, `TaskStore`, `SkillStore`, `PromptStore`, `ResourceStore` |
| `LogStore<T>`                     | `append → seq[]`, cursored `history`, `keys`, `delete`             | `TimelineStore`                                                           |

The sugar is derived from the seam, not parallel to it: `list` **is** `query`, and `put` / `delete` **are** the two arms of the mutation union. So archetype-agnostic infrastructure — a conformance runner, a wire projector — targets `Store` while day-to-day callers reach for the sugar. Substrate ports live alongside: `OperationJournal`, `EventBus`, `MessageInbox`, `EventLog<E>`.

> [!IMPORTANT]
> `seq` ordering, idempotency on a repeated `opId`, and cursor stability across `prune` are behavioral contracts that no type can check. Certify an adapter with the matching suite from [@agentick/spec-conformance](../spec-conformance) or from the owning namespace package.

## The `.fx` dual-typed edge

Every spine harness exposes two first-class surfaces for the same operation: a Promise edge-facade and an Effect-native `.fx` twin. Neither is second-class — take the facade for ergonomics, `.fx` to compose inside your own Effect so telemetry, interruption, and context propagate into your fiber.

```ts
import type { ExecutorTerminal, LanguageModelExecutor } from "@agentick/spec";

declare const executor: LanguageModelExecutor;
declare const input: Parameters<LanguageModelExecutor["run"]>[0];

const terminal: ExecutorTerminal = await executor.run(input); // Promise facade
const effect = executor.fx.run(input); // an UN-RUN Effect — yield* it in your own gen
```

**Effect is canonical; the Promise facade is derived.** `harness.op()` is the twin with a single run at the entity edge. `PromiseView<T>` expresses that derivation at the type level — a homomorphic mapped type that rewrites each Effect-returning method to its awaited Promise form and drops the error and context channels:

```ts
import type { PromiseView } from "@agentick/spec";
import type { Effect } from "effect";

interface BudgetFx {
  /** Charge the budget. */
  charge(usd: number): Effect.Effect<void, Error, never>;
  readonly backend: string;
}

interface BudgetProtocol extends PromiseView<BudgetFx> {
  readonly fx: BudgetFx; // the Effect twins are the single source of truth
}

declare const budget: BudgetProtocol;
await budget.charge(1); // Promise<void>, DERIVED — declared once, on BudgetFx
```

The erasure runs one way only: a `Promise<A>` carries no typed-error channel, so `E` cannot be recovered going back. Author the `Fx` twin by hand; there is deliberately no inverse.

> [!WARNING]
> Keep `PromiseView` homomorphic (`[K in keyof T]`). A key-remapped or union-wrapped rewrite silently drops the JSDoc authored on the `Fx` twin — types still resolve, every suite stays green, only the hover goes blank. One regression test is the guard.

Streaming has no such derivation, because the facade and its twin differ in arity. `AsyncStream<Item, Result>` is the streaming dual of `Promise<A>`: an `AsyncIterable` of items that also carries the terminal `result` and an `abort`.

```ts
import type { AdapterDelta, AsyncStream } from "@agentick/spec";

declare const stream: AsyncStream<AdapterDelta, { readonly stopReason: string }>;

for await (const delta of stream) console.log(delta.type);
const { stopReason } = await stream.result;
stream.abort("user canceled");
```

Both shapes derive from one underlying run: iterating does not change the summary, and awaiting `result` does not steal items from a concurrent iterator. Its Effect twin is a sink-fold — `(input, sink) => Effect<Result>` — so the facade method is hand-declared on the protocol while the twin lives on `.fx`; they share the bridge implementation, not a mapped type.

## Patterns

**Certify behavior types cannot.** [@agentick/spec-conformance](../spec-conformance) ships an executable suite per protocol. Run the matching one against your implementation; that is what "conforms" means here.

**Where the implementations live.** [@agentick/runtime](../runtime) owns the substrate implementations (journal, bus, inbox) and the operation machinery; [@agentick/compiler-react](../compiler-react) owns the JSX pipeline, the bridge context, and the render-time hooks; [@agentick/store](../store) owns the in-memory `Store` backings.

**Where a seam is widened.** Each harness package's `augment.ts` is the worked example for its own seam — [@agentick/timeline](../timeline) for a required `HookBridges` slot plus a `NamespaceSlots` config slot, [@agentick/sandbox](../sandbox) for an optional slot plus `ToolHandlerCtxExtensions`, [@agentick/model-openai](../model-openai) for the three provider tiers.

**Tests live where their dependencies live.** A seam is exercised by the package that widens it, not here. Spec's own suites cover the shapes, the helpers, and the derivations.

## Roadmap & known gaps

- **`RenderContext.activeModel` is construction-bound.** The model comes from the session's target, so the slot is stable across ticks rather than re-resolved per tick from the tree. Marked in-source with a `TODO`.
- **`ClientCapabilities.ext` has no runtime population.** The `ClientCapabilityExtensions` type slot is ready, but the gateway does not yet include per-extension metadata in its extension listing, so `ext` is empty at runtime.
- **`ModelSelection` and `SpecFeatureName` are provisional.** Both are marked `[PLACEHOLDER]` in source: the feature registry is an initial, extensible set and the selection shape is unsigned-off.
- **`ErrorData` covers only the codes that needed structured payloads.** Most error codes carry no typed `data`; add a row when yours does.
- **Nothing enforces the "no runtime logic" rule mechanically.** It is a review constraint, not a lint. The zero-import property of the emitted JavaScript is the practical check.
- **The shadow-trap footgun has no automated guard.** A missing `export {}` in an augmentation file fails loudly but in the _wrong_ package. Nothing warns at authoring time.

## Verified by

- `src/__tests__/types.spec.ts` — structural assertions across the whole data layer: `EventEnvelope`, `CommandOutcome`, phases, surfaces, verdicts, `Operation`, `EventQuery`, `MessageEnvelope`, the error taxonomies, the default journaling policy, and `StandardSchemaV1`.
- `src/__tests__/guards.spec.ts` — every narrowing family: content blocks, context entries, event phase and outcome, terminal outcomes, lifecycle kinds, declaration kinds, semantic content, and `hasFeature`.
- `src/__tests__/rendered-tree.spec.ts` — the compiler-facing shapes (`ContentBlock`, `SemanticNode`, formatter protocol, `RuntimeDeclarations`, `RenderedTree`, `ExecutionResult`, `ExecutionTarget`) and `mergeProviderOptions` semantics.
- `src/__tests__/compiler-protocol.spec.ts` and `tool-executor-protocol.spec.ts` — mount/render/snapshot I/O, the reconcile-error taxonomy, inbox messages, dispatch and registry I/O, the confirmation flow, and the `DataBridge` / loop / session bridge contracts.
- `src/__tests__/standard-schema.spec.ts` — `parseJsonWithSchema`: success, JSON-parse failure (`reason: "invalid-json"`, empty issues, `SyntaxError` cause), schema failure (`reason: "schema"` with validator issues), and async validators.
- `src/__tests__/content-blocks-fold.spec.ts` — exhaustive dispatch in `foldContentBlock` and the explicit fallback in `foldContentBlockWith`.
- `src/__tests__/tool-result.spec.ts` and `tool-output-bound.spec.ts` — `toContentBlocks` / `normalizeToolResult` / envelope detection; and the output bounder's text, JSON, inline-binary, and recursive paths plus the override, the disable switch, and that truncation is off by default.
- `src/__tests__/client-tool-declaration.spec.ts` — `toClientToolRegistration`: the `jsonSchema` wrap and the omitted `handlerRef` that marks a call client-handled.
- `src/__tests__/promise-view.spec.ts` — the homomorphic-shape regression: JSDoc authored on the `Fx` twin survives onto the derived Promise method.
- `src/__tests__/wire.spec.ts`, `wire-extension.spec.ts`, `wire-proxy.type.spec.ts` — JSON-RPC envelopes and guards, batches, error codes, subscription scope, the initialize handshake, validator accept/reject and JSON round-trip, the `WireMethods` / `WireNotifications` registries, `defineWireExtension` happy path and each rejection, and the type-level wire-proxy surface.
- `src/__tests__/signals.spec.ts`, `channels.spec.ts`, `timeline.spec.ts` — the signal, channel, and timeline event-name builders and their query shapes. Cross-surface query _matching_ is verified against the real matcher in [@agentick/runtime](../runtime).
- `src/__tests__/event-log.spec.ts`, `version.spec.ts` — the `EventLog<E>` contract with its cursor, compiled matcher, eviction error, and metrics; and that `SPEC_VERSION` is a date string.
- `src/errors/__tests__/base.spec.ts`, `codec.spec.ts`, `registry.spec.ts`, `effect-interop.spec.ts` — the abstract root and its JSON projection, codec round-trip for known and unknown tags with input validation, registry duplicate-rejection, and `Effect.catchTag` narrowing.
- The full registry — every framework error tag exercised for membership, instance shape, and codec round-trip — is pinned by the error conformance suite in [@agentick/spec-conformance](../spec-conformance).
- The augmentation seams are exercised by the packages that widen them: [@agentick/timeline](../timeline), [@agentick/sandbox](../sandbox), [@agentick/model-openai](../model-openai), [@agentick/gateway](../gateway), and the transports.
