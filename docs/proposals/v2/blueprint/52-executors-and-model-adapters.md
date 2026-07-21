# ADR 52 — Executors and model adapters: the split

**Status:** Draft · 2026-07-02 (ratified in design review; implementation pending)
**Builds on:** ADR 26 (Harness API shape), ADR 32 (extension shape
spectrum — harness vs part), ADR 48 (harness instance vs backing
resource; BYOK corollary), ADR 51 (invocation model; internal commands),
the Effect charter direction (Effect internal, Promise external)
**Touches:** `@agentick/model-executor-next` (the ONE executor + standalone
helpers), `executor-openai/-google/-anthropic/-ai-sdk-next` (reshaped
into model-adapter packages), `@agentick/app-next` (`model:` sugar),
spec (`LanguageModelAdapter` protocol, observation types unchanged)
**Resolves:** #103 (duplicated `define*` factory scaffolding — dies at
the root)

## Amendment — 2026-07-03: as-shipped reconciliation (#150/#152/#171 landed)

The implementation landed green (typecheck 131/131, full suite passing);
this amendment reconciles the ADR to what shipped so spec/ADR/code stop
drifting. What holds exactly as designed: the executor/adapter split, the
zero-Effect **`model-next`** layer, single-shot `generate`/`generateStream`,
the no-double-normalization currencies, the collapsed **one**
`LanguageModelExecutor` (`define*`/`Base`/subclass tiers deleted), adapters
as values, the `model:` slot + `run()` ladder, and an adapter-first
Anthropic. Three deltas from the original text:

1. **The adapter contract grew** (interface block above updated to match):
   `target` is a first-class adapter **property** (not only a `buildParams`
   argument) — it is what powers the `model:` slot's capability defaults —
   plus `streamByDefault?`, `supportsStreaming?`, `customBlocks?`, and the
   `postProcessForNormalize?` round-trip hook. All optional-with-defaults
   except `target`; sound additions for real provider quirks.
2. **Conformance is executor-level, not standalone.** `runModelAdapterConformance`
   + `fakeModelAdapter` were not built; each adapter is certified via
   `runExecutorConformance` (real executor + adapter + stub provider client).
   The adapter *contract* stays zero-Effect (write + test with `generate()`
   alone); only the shared conformance runs through the executor. A thin
   standalone adapter-conformance is a deferred additive if zero-dep
   certification is ever demanded — not a regression.
3. **`FakeLanguageModelExecutor` remains a distinct class**, not collapsed
   into `LanguageModelExecutor` + a fake adapter. "One executor everywhere,
   including tests" is aspirational; the Fake stays for now.

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
  /**
   * Self-described execution target (provider + modelId + capabilities).
   * The executor advertises this as its own `target`; the app reads it for
   * capability-based defaults. This is what makes `model: openai("gpt-5")`
   * enough for the `model:` slot — the adapter carries its own target.
   */
  readonly target: ExecutionTarget;
  /** `execute()` drives the streaming call internally (bus deltas). Default false. */
  readonly streamByDefault?: boolean;
  /** Whether a streaming codepath exists at all (AI SDK splits the surface). Default true. */
  readonly supportsStreaming?: boolean;
  /** Adopter XML-tag custom-block extraction, compiled into the delta pipeline. */
  readonly customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;

  // Required — the round trip:
  buildParams(input: LanguageModelInput, target: ExecutionTarget): unknown;
  call(params: unknown, signal: AbortSignal | undefined): Promise<TRaw>;
  openStream(
    params: unknown,
    signal: AbortSignal | undefined,
  ): AsyncIterable<TChunk> | Promise<AsyncIterable<TChunk>>;
  mapChunk(chunk: TChunk, accum: StreamAccumulatorView): readonly AdapterDelta[];
  reconstructRaw(accum: StreamAccumulatorView, modelSeen: string | undefined): TRaw;
  normalize(raw: TRaw): LanguageModelExecutionResult;

  // Optional — provider quirks (defaults provided by the executor):
  project?(input: ProjectInput): LanguageModelInput;   // e.g. Anthropic per-section cache_control
  adapterTransforms?(): readonly DeltaTransform[];      // e.g. think-tag extraction
  postProcessForNormalize?(raw: TRaw): TRaw;            // mutate reconstructed raw before normalize
  finalizeStream?(accum: StreamAccumulatorView): readonly AdapterDelta[];
  extractMetadata?(raw: TRaw): Readonly<Record<string, unknown>> | undefined;
  isAbortError?(cause: unknown): boolean;
  mapProviderError?(cause: unknown): ExecuteErrorChannel;
}
```

Conformance (**as-shipped, reconciled 2026-07-03** — see the amendment
below): each provider adapter is certified by running
`runExecutorConformance` against the real `LanguageModelExecutor` + that
adapter + a stubbed provider client (`StubOpenAIClient`, …). This is
integration-level certification (executor ⇄ adapter), and it covers the
adapter-first Anthropic. The originally-proposed **standalone, zero-Effect
`runModelAdapterConformance(factory)` + `fakeModelAdapter({ scripted })`**
were NOT built — the adapter *contract* is zero-Effect (an author can
write and test an adapter with `generate()` alone), but its shared
conformance currently runs through the executor. `FakeLanguageModelExecutor`
also remains a distinct class (not collapsed into
`LanguageModelExecutor` + a fake adapter). These are deferred-additive,
not regressions; see the amendment.

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
import { generate, generateStream } from "@agentick/model-next";

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

## Packaging (amended 2026-07-03 — the model-layer carve-out, Ryan-ratified)

Per `<role>-<discriminator>-next` with `model` as the role. The
decisive improvement over the original table: **`@agentick/model-next`
is carved out as the base model layer** — the adapter contract, the
accumulator (+view), the single-shot `generate`/`generateStream`
helpers (options-bag signature: `generate({ model: openai("gpt-5.5"),
messages })`), future modality helpers, canonical projection + delta
transform + tag machinery, `fakeModelAdapter`, and
`runModelAdapterConformance`. The layer is **zero-Effect, zero-harness,
zero-substrate** — adapter packages and standalone consumers (the OCR
service) depend on it alone and never drag in the executor. Effect
begins at `executor-next` and nowhere below.

| Package | Contents |
| --- | --- |
| `model-next` (new) | contract + view + accumulator + helpers + projection/transform machinery + doubles + conformance |
| `model-openai-next` | `openai(modelId, opts)` → adapter |
| `model-google-next` | `google(...)` → adapter |
| `model-anthropic-next` | `anthropic(...)` → adapter — **written adapter-first; the pending subclass body is never completed** |
| `model-ai-sdk-next` | `aiSdkModel(languageModelV2)` → adapter (+ a later `executor-ai-sdk-next` for the engine) |
| `executor-next` | THE harness only: `LanguageModelExecutor` (+ Fake, lifecycle); depends on `model-next` |

The carve-out happens in the packaging commit at the end of the ADR 52
implementation (one commit: create `model-next`, move the model-layer
modules, rename `executor-<provider>` → `model-<provider>`, workspace
sweep per the new-package checklist).

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
// standalone helpers in @agentick/model-executor-next — feature-detected,
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
