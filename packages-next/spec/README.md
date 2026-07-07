# @agentick/spec-next

**The canonical contract package for Agentick v2 — the firewall between
compiler, runtime, executor, and optional topology wrappers.**

Everything that crosses a harness boundary is typed here. No runtime
logic lives in this package; it is pure types, JSON Schema artifacts,
type guards, and a handful of pure merge helpers (`mergeProviderOptions`,
`toRegistration`, error codecs).

This package is:

- **Zero-dep** at runtime (only `effect` for the tagged-error base).
  Pure types + schemas otherwise.
- **Browser-safe** — works in any JavaScript environment without
  polyfills.
- **Versioned** — date-versioned spec contract (`SPEC_VERSION`); semver
  package version.

## Purpose

`@agentick/spec-next` contains:

- **Wire data shapes** that cross harness boundaries (`RenderedTree`,
  `EventEnvelope`, `MessageEnvelope`, content blocks, execution results,
  `LanguageModelMessage`, …).
- **Protocol interfaces** for harness-to-harness integration
  (`ReconcilerProtocol`, `ExecutorProtocol`, `LoopExecutorProtocol`,
  `SessionHarnessProtocol`, `OperationJournal`, `MessageInbox`, …).
- **Augmentation seams** — empty-seed interfaces every harness/adapter
  package widens via `declare module` (see below). This is the
  ergonomic heart of the package.
- **JSON Schema artifacts** for cross-language validation.
- **Type guards** for structural validation.

## Subpath exports

- `@agentick/spec-next` — index; re-exports everything (`data`,
  `errors`, `protocol`, `wire`, `client`, `guards`).
- `@agentick/spec-next/data` — wire data shapes only.
- `@agentick/spec-next/protocol` — protocol interfaces only.
- `@agentick/spec-next/guards` — type guards.

## The augmentation-seam pattern (read this first)

Spec is the firewall, so it must stay neutral about _what harnesses
exist_. The mechanism is a small set of **empty-seed interfaces** that
every harness and adapter package widens via TypeScript module
augmentation. The spec ships an empty (or minimal) surface; packages
contribute slots from their own `augment.ts`; adopters who import a
package see its slots typed correctly, and adopters who don't never see
them. No central registry of "known harnesses" or "known providers"
lives in spec (ADR 26/27).

There are **three** such seams. They differ by _what_ they carry:

| Seam                   | Carries                                     | Widened by                    | Read at             |
| ---------------------- | ------------------------------------------- | ----------------------------- | ------------------- |
| `HookBridges`          | runtime _implementations_ hooks call into   | every harness package         | render time (hooks) |
| `RenderContext`        | per-render _facts_ the IR is a function of  | fact producers (session/loop) | render time (sync)  |
| `ProviderOptions` (×3) | provider-specific request/tool/client knobs | model adapter packages        | project/execute     |

### `HookBridges` — runtime implementations (ADR 27)

The empty-seed bundle the runtime hands a reconciler mount via
`MountInput.bridges`. Hooks (`useTimeline`, `useKnob`, `useData`, …)
consume it through React context. Spec seeds only the small
interface-only contracts with no dedicated package (`data`, `loop`,
`session`, `tools`, `models`); anything backed by a real harness
augments from its own package:

```ts
// in @agentick/timeline-next/src/augment.ts
declare module "@agentick/spec-next" {
  interface HookBridges {
    readonly timeline: TimelineHarnessProtocol;
  }
}
```

Extension packages (`@agentick/sandbox`, `@agentick/mcp`,
`@agentick/subscriptions-next`) add optional slots the same way; the
reconciler threads the bag through unchanged. Snapshot/restore iterates
`HookBridges` generically and feature-tests each slot for
`SnapshotCapable` — no harness-specific knowledge in the reconciler.

### `RenderContext` — per-render facts (ADR 55)

The render-**input** analogue of `HookBridges`. Where `HookBridges`
carries the runtime _implementations_ hooks call into, `RenderContext`
carries the runtime _facts_ the current render is a function of. Same
empty-seed augmentation model:

```ts
declare module "@agentick/spec-next" {
  interface RenderContext {
    readonly budget?: { readonly remainingUsd: number };
  }
}
```

Spec seeds two framework-core slots (the loop/session is their producer
and has no package of its own to augment from):

- **`contextInfo`** — `{ contextWindow?, usedTokens? }`. The active
  model's window facts for this render. `useContextInfo` reads it.
- **`activeModel`** — `Pick<ExecutionTarget, "provider" | "modelId" |
"capabilities">`. The model the loop is about to call. `useActiveModel`
  reads it with zero model-layer coupling (identity + capabilities are
  spec-resident, no `model-next` dep). Enables rendering _for the model
  you'll call_ — per-model tool descriptions, formatting, reasoning
  scaffolds.

**Why an input, not a lifecycle observation:** a fact that must shape
the current IR (the window, the active model) MUST ride render-context —
the session resolves it, the loop threads it into `renderTree`, and a
React context provides it **synchronously** during render. Routing it
through the async lifecycle bridge (`notifyLifecycle` → `setState`)
races the synchronous render and never reaches the IR. The two channels
split by tense: render-context is forward-looking ("what is true for the
render I am about to produce?"); the lifecycle bridge is backward-looking
("what just happened?").

### `ProviderOptions` — provider escapes (ADR 26/57)

Three empty-seed interfaces mirror v1's provider-options tiers; each
adapter augments its own slot with the SDK's _actual_ config types
(not a hand-rolled subset), so `target.providerOptions.openai` is the
exact shape you'd write against the OpenAI SDK directly:

```ts
// in @agentick/model-openai-next
declare module "@agentick/spec-next" {
  interface ProviderClientOptions {
    openai?: OpenAI.ClientOptions;
  }
  interface ProviderOptions {
    openai?: Partial<OpenAI.Chat.Completions.ChatCompletionCreateParams>;
  }
  interface ProviderToolOptions {
    openai?: { strict?: boolean };
  }
}
```

- `ProviderClientOptions` — SDK client construction (apiKey, baseURL,
  vertexai/project/location, …). Per-executor, not per-call.
- `ProviderOptions` — per-call/generation request shape (seed, safety,
  thinking, response_format, …). Lives on `RenderedTree.providerOptions`
  and `ExecutionTarget.providerOptions`.
- `ProviderToolOptions` — per-tool-definition (OpenAI strict mode,
  Anthropic per-tool `cache_control`). Lives on
  `ToolDeclaration.providerOptions`.

The one canonical merge is `mergeProviderOptions(base, patch)` — `patch`
wins per provider-namespace key, one level deep (two adopters decorating
under different namespaces never collide; the same namespace's keys
shallow-merge with the patch on top). Four call sites share it: the
reconciler folding multiple `<ProviderOptions>` declarations; projection
folding tree over target (#176, tree/per-render wins); adapters folding
`input.providerOptions` over `target.providerOptions` defensively. **Do
not hand-roll.**

## Recent contracts (ADR 54–57)

### ADR 54 — lifecycle event union

`LifecycleEvent` (`protocol/reconciler.ts`) is the tagged, open-ended
union `notifyLifecycle` carries. Kinds: `tick-start`, `tick-end`,
`execution-start`, `execution-end`, **`tool-start`**, **`tool-end`**,
`error`, and a namespaced `LifecycleCustom` escape hatch. Adding a kind
does not change the protocol method count; implementations dispatch on
`event.kind` and ignore unknown kinds. Each event lights up a `useOn*`
hook (`tool-start` → `useOnToolStart`, `tool-end` → `useOnToolEnd`, …).
The loop executor is the producer; see
`@agentick/loop-executor-next`. The same moments also fan out as
`ProtocolEvent` bus envelopes for ordering-agnostic observers.

### ADR 56 — tree-declared per-tick model

Three types make a render able to select the model for its tick, mirroring
the tool `handlerRef`/handler split exactly:

- `ModelDeclaration` (`data/declarations.ts`) — `{ modelRef, parameters? }`.
  The **serializable** selection a render contributes to
  `RuntimeDeclarations.model`. Single per tick (one model per model
  call); nearest-scope / last-wins if nested.
- `RegisteredModel` (`protocol/hook-bridges.ts`) — `{ executor, target }`.
  The **live**, run-ready model. Both fields are spec types, so the loop
  and `reconciler-react` thread it _without_ importing `model-next` — the
  firewall holds.
- `ModelBridge` (`protocol/hook-bridges.ts`) — the live side:
  `register(modelRef, model)` / `unregister` / `resolve(modelRef)`. The
  exact analogue of `ToolBridge`. `useModelRegistration` registers through
  it at render time; the loop's `resolveModel` closes over it and looks
  the ref up per tick. Precedence: **tick-IR > send > session**.

### ADR 57 — executor-input currency

The types the executor consumes (`protocol/executor.ts`):

- `LanguageModelMessage` — `{ role, content: LanguageModelMessagePart[],
toolCallId?, name?, cache? }`. The projected message shape adapters
  consume.
- `LanguageModelMessagePart` — the content-part union. **Wire-native
  modalities** (`text`/`image`/`document`/`audio`/`video`/`reasoning`/
  `tool_use`/`tool_result`) each get a first-class variant so adapters
  emit the provider's native structural form; **textual blocks**
  (`json`/`xml`/`csv`/`html`/`code`/`custom`) are flattened to `text` by
  the format harness before reaching the executor.
- **The `providerOptions` / `providerMetadata` split** carried on every
  part (§2):
  - `providerOptions` — **what you send.** Adopter-stamped per-block knobs
    (Anthropic `cacheControl`) and model-produced opaque data replayed
    verbatim (Gemini `thoughtSignature`) both ride here on the input path.
    Typed/augmentable (same `ProviderOptions` seam).
  - `providerMetadata` — **what the provider returned.** Set by
    `normalize` on output parts (returned cache/reasoning tokens,
    `thoughtSignature` as returned). Keyed by provider namespace
    (`ProviderMetadataBag = Record<string, Record<string, unknown>>`).

## Adopter-facing type aliases

Per ADR 42 §"Naming rules": no "Harness" or "Protocol" in
adopter-visible types. Every harness exposes a noun alias alongside its
`*HarnessProtocol`/`*Protocol` interface so adopter code reads naturally:

| Adopter alias              | Underlying protocol                         | Where used                              |
| -------------------------- | ------------------------------------------- | --------------------------------------- |
| `Prompts`                  | `PromptsHarnessProtocol`                    | `server.prompts`, `withPrompts(...)`    |
| `Elicit`                   | (sugar surface in `protocol/elicit-api.ts`) | `ctx.elicit`, `session.elicit`          |
| `Tools`, `Skills`, `Tasks` | (pending — ADR 42 Slices 2–3)               | `server.tools`, `withSkills(...)`, etc. |

The protocol shapes stay for power-user access; the aliases are strictly
nominal sugar.

## Cross-cutting types worth knowing

- **`ToolHandlerCtx`** (`data/tool-handler.ts`) — the unified ctx every
  tool handler sees, in-process AND MCP-server. Carries
  `transport: "in-process" | "mcp"` discriminator + optional
  `mcp?: McpRequestExtras` sub-slot for MCP wire identity. See ADR 43.
- **`McpRequestContext`** (`protocol/mcp-server-harness.ts`) — type alias
  of `ToolHandlerCtx & { transport: "mcp"; mcp: McpRequestExtras }`.
  Import this from MCP-server-specific code paths; structurally identical
  to the unified ctx.
- **`Elicit`** (`protocol/elicit-api.ts`) — sugar interface exposed on
  `ctx.elicit` (tool handlers) and `session.elicit`. Same surface
  regardless of routing transport.
- **Runtime signals** (`data/signals.ts`, ADR 64) — the firewall types
  for the `log` + `progress` family: `LogLevel`, `ProgressToken`,
  `LogEventPayload`, `ProgressEventPayload`, plus the canonical
  `<surface>:signal:<action>` name builders (`logEventName` /
  `progressEventName`) and cross-surface subscriber queries
  (`logEventQuery` / `progressEventQuery`). `ctx.log` / `ctx.progress`
  (universal slots on `ToolHandlerCtx`) emit ONE bus event; projections
  subscribe. `McpLogLevel` is a re-export alias of `LogLevel`.
- **`AgentickError`** (`errors/base.ts`) — abstract root of the v2
  typed-error class hierarchy (ADR 41). Concrete subclasses register via
  `registerAgentickError(tag, cls)` and serialize through
  `serializeAgentickError` / `deserializeAgentickError` with full
  cross-wire class-identity preservation.

## Status

🚧 In active development as part of v2 (`feat/v2`).

- ✅ Wire data shapes, protocol interfaces, error hierarchy, guards.
- ✅ Three augmentation seams (`HookBridges`, `RenderContext`,
  `ProviderOptions` ×3).
- ✅ ADR 54 lifecycle union (incl. `tool-start`/`tool-end`).
- ✅ ADR 55 render-context (`contextInfo`, `activeModel` seeded slots).
- ✅ ADR 56 model-per-tick (`ModelDeclaration`, `RegisteredModel`,
  `ModelBridge`).
- ✅ ADR 57 currency (`LanguageModelMessagePart`, `providerOptions` /
  `providerMetadata` split, `mergeProviderOptions`).

## Roadmap & known gaps

- **`RenderContext.activeModel` is construction-bound today.** The model
  is `session.target`, so the slot is stable across ticks. Under #169 it
  becomes IR-derived per tick and a change re-resolves the slot
  (`TODO(trail-per-tick-model)`).
- **`ModelSelection`** (`data/rendered-tree.ts`) is marked
  `[PLACEHOLDER]` — sign-off pending.
- **`SpecFeatureName`** is an initial, extensible registry
  (`[PLACEHOLDER]`), tracked in `17-open-questions.md`.
- Some `Tools` / `Skills` / `Tasks` adopter aliases are pending ADR 42
  Slices 2–3.

## Verified by

- `src/__tests__/types.spec.ts` — structural type assertions on the wire
  shapes.
- `src/__tests__/guards.spec.ts` — type-guard behavior.
- `src/__tests__/reconciler-protocol.spec.ts`,
  `tool-executor-protocol.spec.ts` — protocol conformance shapes.
- `src/__tests__/rendered-tree.spec.ts` — `RenderedTree` +
  `mergeProviderOptions` semantics.
- `src/__tests__/wire.spec.ts`, `wire-extension.spec.ts` — wire schema +
  extension registry.
- `src/__tests__/event-log.spec.ts`, `version.spec.ts` — event log
  contract, spec version.
- `src/errors/__tests__/` — error base, codec, registry, Effect interop.
- `src/__tests__/signals.spec.ts` — signal name builders + query shape
  (ADR 64). The cross-surface query *matching* is verified against the
  real matcher in `@agentick/runtime-next`
  (`runtime/src/__tests__/signals.spec.ts`).

The augmentation seams themselves are exercised by the packages that
widen them (`@agentick/timeline-next`, `@agentick/model-openai-next`, …)
— tests live where their dependencies live (ADR 27).

## See also

- [ADR 26 — Harness API shape](../../docs/proposals/v2/blueprint/26-harness-api-shape.md)
- [ADR 27 — Modular built-ins](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
- [ADR 54 — Lifecycle bridge & render context](../../docs/proposals/v2/blueprint/54-lifecycle-bridge-and-render-context.md)
- [ADR 55 — Render-context seam](../../docs/proposals/v2/blueprint/55-render-context-seam.md)
- [ADR 56 — Tree-declared model per tick](../../docs/proposals/v2/blueprint/56-tree-declared-model-per-tick.md)
- [ADR 57 — Executor input currency](../../docs/proposals/v2/blueprint/57-executor-input-currency.md)
- [The full v2 blueprint](../../docs/proposals/v2/blueprint/)
  </content>
