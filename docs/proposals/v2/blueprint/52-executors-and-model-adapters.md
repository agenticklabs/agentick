# ADR 52 — Executors and model adapters: the split

**Status:** Draft · 2026-07-02 (ratified in design review; implementation pending)
**Builds on:** ADR 26 (Harness API shape), ADR 32 (extension shape
spectrum — harness vs part), ADR 48 (harness instance vs backing
resource; BYOK corollary), ADR 51 (invocation model; internal commands),
the Effect charter direction (Effect internal, Promise external)
**Touches:** `@agentick/executor-next` (the ONE executor + standalone
helpers), `executor-openai/-google/-anthropic/-ai-sdk-next` (reshaped
into model-adapter packages), `@agentick/app-next` (`model:` sugar),
spec (`LanguageModelAdapter` protocol, observation types unchanged)
**Resolves:** #103 (duplicated `define*` factory scaffolding — dies at
the root)

## TL;DR

**The current design fuses two things with different natures: the
executor (a harness — orchestration, opinion tier) and provider
normalization (a part — protocol tier).** `GoogleExecutor extends
BaseLanguageModelExecutor` entangles "how Google's SDK speaks" with
"how operations run on the substrate." Consequences, all shipped today:

- A one-shot model call (an OCR service) requires constructing a
  journal, bus, and inbox it never meaningfully uses. v1 adapters were
  standalone-usable SDK wrappers; v2 lost that.
- Every provider factory hand-rolls the same substrate-defaulting
  dance (`google-factory.ts`, `aisdk-factory.ts`, ...).
- Provider-adapter authors — a public implementer audience — must
  learn Effect to subclass the base.
- The `defineExecutor`/`defineLanguageModelExecutor` callback factories
  duplicate ~150 LOC compensating for subclass boilerplate (#103).

**The split:**

- **`LanguageModelAdapter`** — the part. A **Promise/AsyncIterable-
  shaped object** implementing exactly the hooks the base class already
  demands of subclasses (`buildParams` / `call` / `openStream` /
  `mapChunk` / `reconstructRaw` / `normalize` + the optional hooks). No
  harness, no substrate, no Effect. Standalone-usable. This is the v1
  adapter, reborn with the v2 currencies.
- **`LanguageModelExecutor`** — the harness. **One** reference
  implementation of `ExecutorProtocol`, taking `adapter` as a
  constructor part. Owns everything Effect: the streaming pipeline,
  backpressure, abort, operations, delta emission.
- **"Executor" means execution engine, not provider.** Alternative
  executors are alternative engines: `AiSdkExecutor` (delegates step
  control to ai-sdk with `stopWhen: stepCountIs(1)`, hands tool
  execution back to our tool executor), a future tanstack-ai executor.
  Providers are never executors.

This is **factoring, not invention** — the adapter contract already
exists as the subclass hook surface; it becomes an object interface.

## The contract

### `LanguageModelAdapter` (the part — protocol tier)

Signatures are the current subclass hooks, object-ified. Promise-shaped
throughout; the currencies are the existing canonical types
(`LanguageModelInput`, `AdapterDelta`, `LanguageModelExecutionResult`)
— **no new normalization layer** (see the guardrail below).

```ts
export interface LanguageModelAdapter<TRaw = unknown, TChunk = unknown> {
  /** Observability identity — "openai", "google", "ai-sdk", ... */
  readonly provider: string;

  // Required — the round trip:
  buildParams(input: LanguageModelInput, target: ExecutionTarget): unknown;
  call(params: unknown, signal: AbortSignal): Promise<TRaw>;
  openStream(params: unknown, signal: AbortSignal): AsyncIterable<TChunk>;
  mapChunk(chunk: TChunk, accum: StreamAccumulatorView): readonly AdapterDelta[];
  reconstructRaw(accum: StreamAccumulatorView, modelSeen: string | undefined): TRaw;
  normalize(raw: TRaw): LanguageModelExecutionResult;

  // Optional — provider quirks (defaults provided by the executor):
  project?(input: ProjectInput): LanguageModelInput;   // e.g. Anthropic per-section cache_control
  adapterTransforms?(): readonly DeltaTransform[];      // e.g. think-tag extraction
  finalizeStream?(accum: StreamAccumulatorView): readonly AdapterDelta[];
  extractMetadata?(raw: TRaw): Readonly<Record<string, unknown>>;
  isAbortError?(cause: unknown): boolean;
  mapProviderError?(cause: unknown): ExecuteErrorChannel;
}
```

Conformance: `runModelAdapterConformance(factory)` — runnable from
plain vitest, zero Effect imports. Test doubles:
`fakeModelAdapter({ scripted })` replaces the internals of
`FakeLanguageModelExecutor` (which becomes `LanguageModelExecutor` +
the fake adapter — one executor everywhere, including tests).

### `LanguageModelExecutor` (the harness — opinion tier)

```ts
new LanguageModelExecutor(scopeId, journal, bus, inbox, {
  adapter,            // the part
  // ...existing executor options (transforms, customBlocks, ...)
})
```

`ExecutorProtocol` is unchanged — the loop executor's contract is
untouched. The Effect.Stream pipeline, the bounded queue, fiber-abort
coordination, `emitDeltaLazy`, and the operation envelopes live here
and ONLY here. Adapter authors never see Effect — this closes the
implementer-audience leak the Effect charter flagged.

Internal operations (`executor:project`, `executor:normalize`, ...)
migrate to ADR 51 internal commands
(`this.command({ name, exposure: "internal", handler })`) — canonical
construction, enumeration for the audit, no hand-built Operation
literals.

### Standalone use (the v1 story, restored)

```ts
import { openai } from "@agentick/model-openai-next";
import { generate, generateStream } from "@agentick/executor-next";

const model = openai("gpt-5", { apiKey });
const result = await generate(model, { messages: [...] });   // OCR-service pattern
for await (const delta of generateStream(model, input)) { ... }
```

`generate`/`generateStream` are thin substrate-free helpers over the
adapter round trip (buildParams → call/openStream → mapChunk →
normalize). No journal, no bus, no harness — a model call is just a
model call.

**Normative (ratified 2026-07-03): these helpers are SINGLE-SHOT.**
One provider round trip; `generateStream` is delta transport for that
one turn. They never loop, never execute tools, never feed results
back — a `tool_use` response returns as data (`result.toolCalls`) and
the helper stops. Multi-turn belongs to the loop executor + session
tier (with its tool executor, capability policy, confirmation gates,
and journal) or to an alternative engine (`AiSdkExecutor`). Growing
these helpers a loop would create a second, ungoverned agent loop —
rejected permanently.

### App-level ergonomics (the quickstart payoff)

```ts
createApp({ agent: <MyAgent />, model: openai("gpt-5") });
```

`model:` is sugar: the app constructs the one `LanguageModelExecutor`
around the adapter on its substrate. The `executor:` slot remains the
protocol-typed escape hatch (inject an `AiSdkExecutor`, a custom
engine, a cluster-aware wrapper). Dichotomy, as always: shorthand vs
live instance.

### ai-sdk — both roles, deliberately

- **`aiSdkModelAdapter(model: LanguageModelV2)`** — an adapter wrapping
  ANY ai-sdk provider model. One wrapper inherits ai-sdk's entire
  provider catalog. This is what v1's ai-sdk adapter was.
- **`AiSdkExecutor`** — an alternative `ExecutorProtocol` engine that
  delegates to `streamText`/`generateText` with
  `stopWhen: stepCountIs(1)`, surrendering loop control to agentick
  (our loop executor ticks; our tool executor dispatches — capability
  policy and confirmation gates stay in force). Ships later; the
  adapter ships first.

## Guardrail — no double normalization

`LanguageModelInput`, `AdapterDelta`, and
`LanguageModelExecutionResult` are the ONLY currencies between adapter
and executor. The adapter normalizes provider shapes into them; the
executor consumes them raw. Any "executor-internal representation" that
adapters must additionally target is the failure mode of this split and
must be rejected in review.

## Packaging

Per `<role>-<discriminator>-next`, the role changed — the packages
rename (pre-ship window; git-mv + workspace sweep):

| Today | Becomes | Exports |
| --- | --- | --- |
| `executor-openai-next` | `model-openai-next` | `openai(modelId, opts)` → adapter |
| `executor-google-next` | `model-google-next` | `google(...)` → adapter |
| `executor-anthropic-next` | `model-anthropic-next` | `anthropic(...)` → adapter — **written adapter-first; the pending subclass body is never completed** |
| `executor-ai-sdk-next` | `model-ai-sdk-next` (+ a later `executor-ai-sdk-next` for the engine) | `aiSdkModelAdapter(model)` |
| `executor-next` | unchanged | `LanguageModelExecutor`, `generate`, `generateStream`, `runModelAdapterConformance`, `/testing` doubles |

The `define*` callback factories and the subclass extension points on
`BaseLanguageModelExecutor` are deleted (#103 resolved at the root);
the class collapses into the final `LanguageModelExecutor`.

## BYOK corollary (ADR 48 §5)

Per-principal model access becomes "one executor harness class,
per-principal **adapter** instance" — the checkout pattern applies to a
cheap Promise-shaped object holding an SDK client, not to a harness.

## Implementation plan (Opus-sized; mostly deletion)

1. Extract `LanguageModelAdapter` from the base-class hooks (signatures
   unchanged) + `StreamAccumulatorView` (read-only accumulator surface).
2. Collapse `BaseLanguageModelExecutor` → final `LanguageModelExecutor`
   consuming `options.adapter`; migrate its internal ops to internal
   commands (rides the ADR 51 slice-4 migration wave).
3. Convert openai/google/ai-sdk subclasses → adapter objects
   (mechanical: methods move, `this.spec` references become locals).
4. Write Anthropic as an adapter (the forcing deadline — before any
   further provider work).
5. Delete `defineExecutor`/`defineLanguageModelExecutor` + the four
   factory files' substrate dance; `openai(...)` etc. return adapters.
6. `createApp({ model })` sugar; `generate`/`generateStream` helpers;
   conformance + doubles; package renames last (one mechanical sweep).

## What this does NOT propose

- No change to `ExecutorProtocol` or the loop executor's contract.
- No adapter auto-registry — adapters are values, passed explicitly
  (strategy-values doctrine).
- No third normalization currency.
- No constraint that only one executor exists — one *reference*
  implementation; alternative engines are alternative protocol impls.

## Modalities (planned — additive capabilities)

The split's payoff compounds beyond text generation: **modalities are
optional capabilities on adapters, each with a standalone helper**,
mirroring the ai-sdk function vocabulary adopters already know:

```ts
// standalone helpers in @agentick/executor-next — feature-detected,
// substrate-free, same shape as generate/generateStream:
embed(adapter, input)            // ernesto's EmbeddingService need
embedMany(adapter, inputs)
transcribe(adapter, audio)
generateSpeech(adapter, input)
generateImage(adapter, input)
```

- Each capability is an **optional method group on the adapter**
  (`adapter.embed?`, `adapter.transcribe?`, ...) with its own
  wire-safe currency types in spec (`EmbeddingResult`,
  `TranscriptionResult`, ...). A provider adapter implements what its
  SDK offers; helpers throw a typed capability error otherwise.
- **Conformance rows are capability-conditional** — the suite tests
  what the adapter declares, nothing more.
- `aiSdkModelAdapter` forwards to the corresponding ai-sdk functions,
  inheriting their full modality coverage in one wrapper.
- None of this touches the executor: modality calls are adapter-level
  round trips (no tick loop, no streaming pipeline) unless/until a
  streaming modality earns executor involvement — decided then, per
  capability, never speculatively.

Sequencing: `embed`/`embedMany` land with the ernesto persona port
(the live consumer); the rest land per demand. The interface pattern is
pinned now so every modality lands the same way.

## Open questions

1. **Package role noun** — `model-*-next` (recommended; reads as
   `import { openai } from "@agentick/model-openai-next"`) vs
   `adapter-*-next` (too generic — store/wire adapters exist).
2. **`StreamAccumulatorView` surface** — RESOLVED 2026-07-03 (by
   audit): read-only accumulation state (usage, toolCalls, stopReason,
   text/reasoning buffers, `modelSeen`, `totalText()`,
   `toContentBlocks()`) **plus `providerExtra` as the sanctioned
   provider-owned mutable scratch slot** — the accumulator already
   documents it as such and openai/google both stash parser state
   there. Read-only-except-your-own-pocket.

## References

- `packages-next/executor/src/base-language-model-executor.ts` — the
  hook surface this ADR object-ifies
- `packages-next/executor-google/src/google-factory.ts` /
  `executor-ai-sdk/src/aisdk-factory.ts` — the substrate-dance
  boilerplate this deletes
- `packages/adapters/` (v1) — prior art: standalone-usable adapters;
  `nx-knowify .../ocr/ocr.service.ts` — the adopter pattern to restore
- ADR 51 §8 — internal commands (the `this.operation()` question)
