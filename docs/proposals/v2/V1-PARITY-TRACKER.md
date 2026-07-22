# v1 → v2 Adapter Parity Tracker

**Status:** open. Updated as gaps close.

This document tracks the feature gap between v1's provider adapters
(`@agentick/openai`, `@agentick/anthropic`, `@agentick/google`,
`@agentick/ai-sdk` in v1) and v2's executors / adapters
(`@agentick/executor-openai-next`, `@agentick/executor-ai-sdk-next` today;
future `@agentick/anthropic`, `@agentick/google` adapters under the
ModelAdapter architecture).

**v2 MUST reach feature parity with v1 before 1.0.** Any gap left
open is a regression for adopters migrating from v1.

Source audit performed: 2026-05-28 (read v1 OpenAI ~668 LOC,
Anthropic ~700 LOC, AI SDK ~956 LOC against v2's
`executor-openai/src/openai-executor.ts` and
`executor-ai-sdk/src/ai-sdk-executor.ts`).

---

## Decision: ModelAdapter architecture is NOT a blocker

**Resolved:** the gaps below can land in the current
`@agentick/executor-openai-next` / `@agentick/executor-ai-sdk-next` packages
TODAY without waiting for the ModelAdapter rename/reshape. Reason:
the translation code (provider request → response, chunk → AdapterDelta,
ContentBlock ↔ provider shapes) is concrete provider-layer work.
Whether that layer is called `ExecutorOpenAI` today or
`OpenAIAdapter` tomorrow, the translation logic moves with the
package when we reshape.

The reshape touches package names + the `@agentick/model-executor-next`
consumer (which gets a `ModelAdapter` slot instead of being itself
the executor). The translation code is invariant. So fix the gaps
where they live now.

Confidence: high.

---

## Gaps by priority

Status legend: `[ ]` open, `[~]` in progress, `[x]` closed, `[deferred]`
intentional scope, `[blocked]` waiting on prerequisite.

### Critical (block v1 → v2 migration; close immediately) — **ALL CLOSED**

- [x] **G1. Sampling parameters incomplete.** _Closed 2026-05-28
      (commit `8257bdbf`)._
      `LanguageModelParameters` now carries `topP`, `frequencyPenalty`,
      `presencePenalty`. Plumbed through both OpenAI's `toOpenAIParams`
      and AI SDK's `toAISDKInput`.

- [x] **G2. Cache tokens missing on streaming path.** _Closed
      2026-05-28 (commit `2b9fabb4`)._ OpenAI executeStream + the
      StreamAccumulator + mapChunkToAdapterDeltas all forward
      `prompt_tokens_details.cached_tokens` as `cachedInputTokens`.
      AI SDK finish event reads `cachedInputTokens` +
      `cacheCreationTokens`; non-streaming normalize() also picks
      them up from `raw.usage`.

- [x] **G3. Reasoning content from non-standard fields.** _Closed
      2026-05-28 (commit `2b9fabb4`)._ OpenAI reads
      `delta.reasoning_content` (vLLM) and `delta.reasoning`
      (LM Studio) via duck-typing — emits
      reasoning-start/delta/end/summary deltas, accumulates across
      chunks, normalize() surfaces a `ReasoningBlock` in the
      ContentBlock output for both streaming and non-streaming paths.

- [x] **G4. Base64 image source silently broken.** _Closed
      2026-05-28 (commit `8257bdbf`)._ `defaultProject` in
      `define-executor.ts` maps `Base64Source` →
      `data:${mime};base64,${data}` (and S3/GCS/Reference → canonical
      URIs). OpenAI's `toOpenAIMessages` passes the data URL through.
      The `[binary]` placeholder is gone.

- [x] **G5. `providerOptions` spread for adopter escape hatch.**
      _Closed 2026-05-28 (commits `8257bdbf` + `10a4d2e2`)._ OpenAI
      reads `target.providerOptions.openai` and spreads onto the
      request body. AI SDK forwards `target.providerOptions` directly
      as the SDK's `providerOptions` (already per-provider keyed by
      AI SDK convention). **Also**: `ProviderOptions` converted from
      a flat type alias to an empty seed interface adapter packages
      augment via `declare module "@agentick/spec-next"` — matches v1's
      typed pattern. `executor-openai` contributes the typed `openai`
      slot.

- [x] **G6. Bus envelopes for deltas on streaming path.** _Closed
      2026-05-28 (commit `2b9fabb4`)._ Both `executeStream` impls
      construct a per-stream Operation and mirror every emit(delta)
      through `emitDeltaLazy` (fire-and-forget so iterator hot path
      isn't gated on subscriber latency). Observability subscribers
      see the same deltas as iterator consumers.

- [x] **G15. responseFormat.name for json_schema mode.** _Closed
      2026-05-28 (commit `8257bdbf`, free-ride with G1)._ Spec's
      `responseFormat` now carries optional `name`. OpenAI executor
      passes it through (was previously hardcoded to `"response"`).
      Was Medium priority; folded into the G1 spec touch.

### High (close before 1.0)

- [x] **G7. ThinkTagParser for inline `<think>` tags.** _Closed
      2026-05-28 (commit landing G7 originally + the G12 refactor)._
      Now implemented as a preset configuration on the shared
      `StreamTagParser` primitive — `parseThinkTags: true` is
      equivalent to declaring a `think` tag that routes to the
      reasoning stream. Same parser handles both G7 and G12.

- [x] **G8. Native Anthropic executor / adapter.** _Closed 2026-05-28
      by sub-agent run using `skills/create-adapter`._
      `@agentick/executor-anthropic-next` ships full streaming + non-streaming
      via `client.messages.create({ stream: true })`, cache token
      surfacing (`cache_read_input_tokens` + `cache_creation_input_tokens`
      → `cachedInputTokens` + `cacheCreationTokens`), native reasoning
      via `thinking` blocks, system extraction + alternation coalescing,
      `max_tokens` defaulting, silent-drop of unsupported sampling
      params, `target.providerOptions.anthropic` typed via module
      augmentation, parseThinkTags + customBlocks via shared
      StreamTagParser. 47/47 tests passing (15 conformance + 28
      provider-specific + 4 factory). **Deferred from this pass**:
      multi-turn extended-thinking signature delta round-tripping
      (single-turn works; multi-turn with tools requires sidecar
      mechanism), `redacted_thinking` opaque data round-trip (currently
      surfaces as `[redacted]` placeholder), document blocks (upstream
      gap — v2 spec doesn't carry them to the executor boundary).

- [x] **G9. Native Google executor / adapter.** _Closed 2026-06-02
      via `@agentick/executor-google-next`._ Full streaming + non-streaming
      via `client.models.generateContentStream` + `generateContent`,
      Vertex AI + Gemini Developer API paths via
      `clientOptions: GoogleGenAIOptions`. **thoughtSignature
      round-trip (Gemini 3+ thinking)** — opaque signature flows
      `ContentBlock` ↔ SDK part via
      `providerMetadata.google.thoughtSignature` (required for
      multi-turn tool use with thinking models — without it Gemini
      returns `MISSING_THOUGHT_SIGNATURE`). `part.thought === true`
      (Gemini 2.5+) routes to the reasoning channel. Single-pass
      stream accumulator builds `ContentBlock[]` directly during
      streaming (no synthesized-raw → re-walk pattern). Full
      FinishReason → LanguageModelStopReason map (STOP, MAX*TOKENS,
      SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, SPII,
      MALFORMED_FUNCTION_CALL, MISSING_THOUGHT_SIGNATURE, IMAGE*\*
      etc.). `thoughtsTokenCount` → `reasoningTokens`,
      `cachedContentTokenCount` → `cachedInputTokens`.
      `sanitizeSchemaForGemini` ported from v1 (strips `$ref`,
      `$defs`, `additionalItems`, `propertyNames`; simplifies mixed
      `anyOf`/`oneOf`). parseThinkTags + customBlocks via the shared
      `StreamTagParser`. Env-var fallbacks (`GOOGLE_API_KEY`,
      `GEMINI_API_KEY`, `GOOGLE_GENAI_BASE_URL`). 54/54 tests in
      package (35 provider-specific + 15 conformance + 4 factory).
      **Architecture upgrade landed alongside**: layered
      providerOptions (three augmentable spec interfaces —
      `ProviderClientOptions`, `ProviderOptions`,
      `ProviderToolOptions` — all typed with the SDK's actual config
      types, not hand-rolled subsets). Adopted across all four
      executors; Anthropic's `cacheControl` meta-knob removed in
      favor of per-block `providerMetadata.anthropic.cacheControl`.

- [ ] **G10. Embedding API support.**
      v1 OpenAI adapter exposes `embed()` for text embeddings. v2
      `ExecutorProtocol` has no embedding surface. Adopters building
      RAG / retrieval can't use the v2 executor for embeddings. - Plan: requires protocol-level work. Either a separate
      `EmbeddingExecutorProtocol` (cleaner — embeddings ARE a
      different operation than chat completions) OR a new
      `kind: "embedding"` `ExecutionTarget` discriminant. Lean
      toward separate protocol; same package can implement both. - Files: new protocol type in spec; embeddingExecutor surface
      on adapters that support it (OpenAI, AI SDK, Google).

### Medium (close pre-1.0; not migration-blocking)

- [x] **G11. Tool definition `providerOptions`.** _Closed 2026-06-02
      via the layered providerOptions architecture._ Spec gained
      `ProviderToolOptions {}` empty-seed interface (sibling to the
      existing `ProviderOptions` and the new `ProviderClientOptions`);
      `ToolDeclaration.providerOptions?: ProviderToolOptions` lands
      on the tool projection. Each adapter contributes its slot via
      module augmentation typed against the SDK's actual config types
      (no hand-rolled subsets): OpenAI → `Partial<FunctionDefinition>`
      so adopters set `strict: true` on the inner function; Anthropic
      → `Partial<AnthropicTool>` for per-tool `cache_control`; Google
      → `Partial<FunctionDeclaration>` for SDK-specific overrides.
      `buildTools` in every executor forwards `t.providerOptions`
      through projection.

- [x] **G12. customBlocks parsing from stream.** _Closed 2026-05-28._
      Adopter-declared `customBlocks: { tagName: { ... } }` option on
      OpenAIExecutorOptions extracts XML-like tags from the text
      stream and emits them as `custom-block-*` AdapterDelta events
      (newly added to the spec). Built on the shared `StreamTagParser`
      primitive — same parser drives G7 (`parseThinkTags`).
      Per-tag handlers (`onStart`/`onContent`/`onSelfClosing`)
      support side-effecting integration. Both options compose; an
      executor can run `parseThinkTags: true` AND
      `customBlocks: { citation: { ... } }` simultaneously.

- [ ] **G13. deltaTransform extension point.**
      v1 lets adopters supply a transform applied to deltas. v2 has
      none. Lower urgency than G7/G12 — explicit extension hook for
      advanced adopters. - Design needed: where the transform plugs in
      (executor-package-internal? executor protocol option?).

- [ ] **G14. `messageTransformation` capability.**
      v1 has elaborate per-provider role mapping: GPT-4/o1/o3 get
      `developer` role for ephemeral / event messages; Claude gets
      XML-preferred rendering vs Markdown for OpenAI. v2 has nothing
      — same `system/user/assistant/tool` regardless of provider. - Touches reconciler (it currently produces canonical messages
      without provider awareness). Bigger architectural piece. - Plan: revisit during ModelAdapter work, where adapter
      advertises capability metadata that the loop / reconciler
      consults.

- [ ] **G15. responseFormat `name` for json_schema mode.**
      v1 uses `rf.name ?? "response"`. v2 hardcodes `"response"`.
      Minor — adopters using OpenAI structured outputs can't name
      their schema. - Files: `packages/spec/src/protocol/executor.ts`
      (`responseFormat` shape — add `name?: string`),
      OpenAI + AI SDK executors pass it through.

- [ ] **G16. `OPENAI_ORGANIZATION` env var fallback.**
      v1 reads `OPENAI_ORGANIZATION` env var alongside the API key.
      v2 doesn't. Minor — affects enterprise adopters using
      organization-scoped API keys. - Files: `packages/executor-openai/src/openai-executor.ts`
      client construction.

### Deferred (intentional scope; revisit later)

- [deferred] **G17. Model capability discovery via /v1/models.**
  v1 OpenAI's `discoverModels` queries `/v1/models` and registers
  context window + reasoning type. Connects to the deferred
  ModelAdapter + model-catalog work. Pick up when the catalog
  lands. The same architectural pass also picks up auto-compaction
  (uses context window from the catalog), multimodal validation
  (uses `supportsVision` from capabilities), cost routing
  (uses `pricePerInputToken`).

- [deferred] **G18. ModelAdapter rename + native executor architecture.**
  Conceptual reshape from "executor-openai" (provider pretending
  to be an executor) to "openai adapter consumed by the
  framework's native executor." Same translation code; cleaner
  conceptual hierarchy. Captured in REFACTOR-SCRATCHPAD.md
  "2026-05-27 — Model-catalog / ModelAdapter architecture".

- [low-value] **G19. v1's `Logger.for("OpenAIAdapter")` wrapper.**
  v1 wrapped its own logger abstraction. v2 uses the substrate
  envelope system + `app.events()` for observability. Different
  shape, not a real gap — the v2 path is cleaner.

---

## Skill: adapter-generator (sub-agent task)

**Goal:** standardize the steps to create a new provider adapter so
sub-agents can produce one autonomously following the established
shape.

**Trigger phrases:** "create an adapter for X", "add a new provider
adapter", "spin off an adapter for Y".

**Required inputs:** provider name, base SDK package name + import
path, model/chunk type names, stop-reason mapping, message format
(messages vs other shape), special features (cache headers,
reasoning blocks, image source quirks, etc.).

**Skill outline:**

1. **Read these references before starting:**
   - `packages/executor-openai/src/openai-executor.ts` — reference
     implementation (BaseHarness + executeStream + run paths).
   - `packages/executor-ai-sdk/src/ai-sdk-executor.ts` — wrapper-style
     reference.
   - `packages/spec/src/protocol/executor.ts` — protocol contract.
   - `packages/spec/src/data/streaming.ts` — AdapterDelta union.
   - `docs/proposals/v2/V1-PARITY-TRACKER.md` — this doc; list of
     features every adapter must support.

2. **Scaffold the package:**
   - Create `packages/executor-<provider>/` (or
     `packages/<provider>/` under the ModelAdapter naming).
   - package.json: workspace deps on `@agentick/spec-next`,
     `@agentick/runtime-next`, the provider SDK; optional peer dep on
     React only if the adapter has a `/react` subpath.
   - tsconfig.json + tsconfig.build.json extending root.
   - Add to `.changeset/config.json` linked list.
   - Add to `website/typedoc.json` entry points.
   - Add to `website/.vitepress/config.mts` PACKAGE_GROUPS.
   - README following the executor package convention.

3. **Implement the executor class:**
   - `class ProviderExecutor extends BaseHarness<"model"> implements LanguageModelExecutor`
   - Required methods: `project`, `execute`, `executeStream`,
     `normalize`, `run`, `abort`.
   - `project` should be reusable via shared `defaultProject` from
     `@agentick/model-executor-next` unless the provider needs custom logic.
   - Self-described `target: ExecutionTarget` property with
     `capabilities: { supportsTools, supportsStreaming,
supportsVision, supportsReasoning, contextWindow,
maxOutputTokens }` populated for the model.

4. **Translation tables to implement:**
   - `to<Provider>Messages(LanguageModelMessage[])` —
     ContentBlock → provider message format.
     **MUST handle:** text, image (URL **and base64** — G4),
     tool_use, tool_result blocks.
   - `to<Provider>Tools(LanguageModelTool[])` — declaration →
     provider tool shape. **MUST honor** tool-level
     `providerOptions.<provider>` (G11).
   - `to<Provider>Params(LanguageModelInput)` — params + tools
     into provider's request shape. **MUST include** all sampling
     params (G1: temperature, maxOutputTokens, topP,
     frequencyPenalty, presencePenalty, stopSequences,
     responseFormat). **MUST spread**
     `target.providerOptions.<provider>` for adopter escape
     hatch (G5).
   - `mapChunkToAdapterDeltas(chunk, state)` — 1:1 translation
     from provider stream chunk to AdapterDelta. State tracks
     block index / tool call ids / etc. across chunks. **MUST
     handle** reasoning content from non-standard fields where
     applicable (G3).
   - Post-stream summary emission: `content`, `tool-call`,
     `message`, plus close-events (`content-end`, `tool-call-end`).
     **MUST surface** `cachedInputTokens` / `cacheCreationTokens`
     (G2) when the provider supports it.
   - `mapFinishReason(providerReason) → LanguageModelStopReason`.
   - `normalize(providerOutput) → LanguageModelExecutionResult`
     — non-streaming path; same content-block translation.

5. **Bus envelope mirror:**
   - Every `emit(adapterDelta)` in `executeStream` MUST also call
     `this.emitDeltaLazy(op, () => adapterDelta)` so observability
     subscribers see the stream (G6).

6. **Env var fallbacks:**
   - API key, base URL, organization (if applicable). Follow v1
     conventions: `<PROVIDER>_API_KEY`, `<PROVIDER>_BASE_URL`,
     `<PROVIDER>_ORGANIZATION` (G16-style).

7. **Tests:**
   - Mock-based unit tests for chunk mapping (provider chunk →
     AdapterDelta translation).
   - Mock-based round-trip test for project → execute → normalize.
   - Optional: msw-backed integration test against the SDK's
     test utilities if available.
   - Use `runExecutorConformance` from `@agentick/spec-conformance-next`
     (when implemented) for protocol conformance.

8. **Factory function + `ExecutorFactory` marker:**
   - `provider(modelId, options?): ExecutorFactory` — same shape as
     `openai()`, `aisdk()`. Returns a factory that AppHarness
     invokes with shared substrate at construction.

9. **Verify against V1-PARITY-TRACKER.md gap list:**
   - Walk through each Critical + High gap; check the new adapter
     addresses it.
   - Update this tracker: change `[ ]` → `[x]` for items now
     supported by the new adapter; if a gap remains
     adapter-specific, note it in the gap entry.

**Adapter creation goes through this skill. Do not free-hand new
adapters — the parity contract is too easy to miss.**

---

## Action plan (next session)

1. **Fix critical gaps G1–G6** in current `executor-openai` +
   `executor-ai-sdk`. Spec changes for G1 + G5. Single focused
   commit per gap (or grouped if cohesive).
2. **Port ThinkTagParser (G7)** to v2 as a follow-up commit.
3. **customBlocks parser plumbing (G12)** — shares transform
   stage with G7. Same commit or follow-up.
4. **Author + ship the adapter-generator skill** so sub-agents can
   produce G8 (Anthropic) + G9 (Google) following the parity
   contract.
5. **Native Anthropic adapter (G8)** via sub-agent using the skill.
6. **Native Google adapter (G9)** via sub-agent using the skill.
7. **Embedding API protocol surface (G10).** Separate design
   discussion before implementing.
8. **Medium gaps (G11, G13–G16)** as polish.

ModelAdapter rename (G18) lands when the catalog architecture
work happens — does NOT block the parity fixes.

---

## Update log

- 2026-05-28: initial audit (this document).
- 2026-05-28: closed all 6 Critical gaps (G1–G6) plus G15
  (responseFormat name, free-ride with G1). Spec changes: typed
  ProviderOptions as module-augmentable interface (matches v1
  pattern); `executor-openai` contributes its typed slot via
  `declare module "@agentick/spec-next"`. Commits: `8257bdbf` (G1, G4, G5,
  G15), `10a4d2e2` (ProviderOptions module augmentation), `2b9fabb4`
  (G2, G3, G6). 5337 tests passing, full typecheck clean.
- 2026-05-28 (later): closed G7 + G12 together via shared
  StreamTagParser primitive. AdapterDelta gains
  custom-block-start/-delta/-end/-summary events. parseThinkTags
  refactored to be a preset configuration on the same parser
  customBlocks uses (one bug surface, both compose). 5364 tests
  passing.
- 2026-05-28 (later still): extended ExecutorProtocol conformance
  suite with parity tests (base64 image, sampling params,
  providerOptions, executeStream surface, AdapterDelta type
  validity, bus envelope dual-emit, result-equivalence). Conformance
  count went 6 → 15 tests per adapter. Caught real bugs in all
  three existing executors (duplicate `messagePartFromBlock` with
  `[binary]` placeholder, mock executor missing emitDeltaLazy,
  stubs missing streaming path). 5391 tests passing.
- 2026-05-28 (evening): closed G8 via sub-agent run.
  `@agentick/executor-anthropic-next` produced from the
  `create-adapter` skill. 47/47 tests passing in the new package;
  no workspace regressions. 5438 tests passing total. Sub-agent
  flagged 6 additional skill bugs from the first run + a few new
  ones from this run — fixed in skills/create-adapter/SKILL.md.
- 2026-06-02: closed G9 (`@agentick/executor-google-next`) and G11
  (per-tool providerOptions) via a coordinated layered-providerOptions
  refactor across all four executors. Spec gained two new empty-seed
  augmentable interfaces (`ProviderClientOptions`, `ProviderToolOptions`)
  joining the existing `ProviderOptions`. Each executor's three slots
  now type to the SDK's actual config types — `OpenAI.ClientOptions` /
  `Partial<ChatCompletionCreateParams>` / `Partial<FunctionDefinition>`,
  `Anthropic.ClientOptions` / `Partial<MessageCreateParams>` /
  `Partial<AnthropicTool>`, `GoogleGenAIOptions` /
  `GenerateContentConfig` / `Partial<FunctionDeclaration>`.
  `providerMetadata?` lifted from `ToolUseBlock` onto
  `BaseContentBlock` so every block carries per-block round-trip
  data. Anthropic `cacheControl` meta-knob removed entirely in
  favor of per-block `providerMetadata.anthropic.cacheControl` and
  per-tool `tool.providerOptions.anthropic.cache_control`. Google
  ships with thoughtSignature round-trip (Gemini 3+ thinking),
  `part.thought` → reasoning routing (Gemini 2.5+), single-pass
  stream accumulator, full FinishReason map, sanitizeSchemaForGemini
  ported from v1. Adapter benchmarks added at
  `packages/executor-{openai,anthropic,google}/src/__bench__/streaming.bench.ts`;
  numbers in REFACTOR-SCRATCHPAD §2026-06-02. 313/313 tests across
  five executor packages + spec + spec-conformance.

---

# 2026-07-22 — Full-surface parity audit (beyond adapters)

**Precedent.** The tool-config parity audit (2026-05) found the v2
rewrite had silently dropped 15 tool-config fields, 4 of them
callable→static **seam violations** — all since restored. That audit
had never been run over the _other_ v2 surfaces. This section is that
sweep: **App/session construction · ExecutionRunner · Guards/Gates ·
Hooks/Middleware · Spawn/sub-agents · Dispatch/audience/aliases ·
Adapter capabilities · orphaned v1 exports.** Read-only; no production
code touched.

**Method.** Field-by-field read of v1 (`packages/core`, `shared`,
`gateway`, `client`, `kernel`) against v2 (`packages-next/`). Every
"LOST" claim was steel-manned by grepping v2 thoroughly first (v2
renamed heavily: reconciler→compiler, executor→model-executor,
runner→loop+interceptors, audience→exposure).

**Severity order:** seam-violation > capability-loss > ergonomic.
A deliberate architectural replacement (runner→interceptors,
audience→exposure) is **not** a loss when the capability survives —
only genuine gaps where v2 cannot express the v1 behavior are flagged.

## Headline

- **Seam-violations: 0.** Every v1 callback that survived stayed a
  dynamic seam (`onBeforeSend`→`onBeforeSessionSend` command hook,
  `onToolConfirmation`→elicitation gate+`guard`, `createGuard`→four-verdict
  interceptor). Nothing degraded callback→static config. The 2026-05
  seam-violation class did **not** recur on these surfaces.
- **Capability-loss: ~22** (of which ~15 are genuinely silent — no ADR/
  STATUS/blueprint justification found). Concentrated in three clusters:
  **session persist/restore hooks**, **session-registry lifecycle
  (eviction)**, and **spawn/sub-agent hardening**.
- **Ergonomic: ~12** — clean renames adopters must relearn, plus a few
  in-tree React hook forms not yet re-exposed.
- Guards/Gates and Hooks/Middleware came back **at parity or superset** —
  zero gaps. Dispatch/audience/aliases **clean** (already restored).
  Adapter surface **unchanged** since 2026-06-02 (G10/G13/G14 remain the
  open adapter gaps).

Status legend as above: `[ ]` open, `[x]` closed, `[deferred]`
intentional, `[tracked]` already filed elsewhere.

---

## Surface 1 — App / Session construction options

v1: `packages/core/src/app/types.ts` (`AppOptions`, `SessionOptions`,
`SpawnOptions`). v2: `packages-next/app/src/harness.ts`
(`AppHarnessOptions`), `packages-next/session/src/harness.ts`
(`SessionHarnessOptions`), `packages-next/spec/src/protocol/{app-harness,session-harness}.ts`.

### Silently LOST (no justification found) — capability-loss

| #    | v1 surface                                                                                                      | v2 status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | severity               | recovery pass                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| PA1  | `AppOptions.signal?: AbortSignal` — app-wide cascade ("all sessions respect this")                              | **[x] CLOSED (recovery pass #2).** `AppHarnessOptions.signal` fanned into every session as its construction signal (also lights up the previously-declared-but-dead `CreateSessionInput.signal`). The session merges it with each `SendInput.signal` into the ONE loop execution signal — mid-run abort tears down in-flight work, an already-aborted signal makes new sends resolve `aborted` (0 ticks, no model call). `assertOpen` refuses `createSession`/`runOnce` once aborted (closeApp-in-abort-shape). Reuses the existing per-send abort plumbing (`mergeAbortSignals` lifted to `@agentick/utils-next`, dedup with loop-executor).              | closed                 | —                                                                                                     |
| PA2  | `AppOptions.sessions.maxActive?: number` — LRU cap on in-memory sessions                                        | **[x] CLOSED (recovery pass #2).** `sessions.maxActive` — soft LRU cap. A `createSession` over the cap pages out the least-recently-active EVICTABLE session (`enforceMaxActive`). In-flight sessions are NEVER evicted (`session.hasInFlightExecution` guard = reservation ∪ persisted execution id); soft cap restored at the next create/sweep once work settles. Eviction is PAGING not deletion — `disposeSession(id, "evict")` frees the live harness but keeps the durable `SessionRecord` + timeline store; `createSession(sameId)` rehydrates via ADR-49 open-or-rehydrate (does NOT fire app-level `onSessionClose`). Ephemeral sessions exempt. | closed                 | —                                                                                                     |
| PA3  | `AppOptions.sessions.idleTimeout?: number` — idle eviction                                                      | **[x] CLOSED (recovery pass #2).** `sessions.idleTimeout` — an `unref`'d background sweep (`sweepIdle`) pages out every evictable session idle past the threshold, so a quiet app still releases memory. Activity (`lastActiveAt`) refreshed off a `requested`-phase bus subscription (send/dispatch/snapshot/…) wired ONLY when eviction is configured (zero overhead otherwise); torn down + timer cleared in `closeApp`. Same paging semantics + in-flight guard as PA2.                                                                                                                                                                                | closed                 | —                                                                                                     |
| PA4  | `AppOptions.onBeforePersist?: (session, snapshot) => false\|snapshot\|void`                                     | **[x] CLOSED (recovery pass #1).** `onBeforeSessionSnapshot` command hook — veto (throw) or observe before the capture. (The continuous E11 store write stays off-critical-path by design; the veto/augment seam lives on the explicit snapshot command, the serialization boundary.)                                                                                                                                                                                                                                                                                                                                                                      | closed                 | —                                                                                                     |
| PA5  | `AppOptions.onAfterPersist?: (sessionId, snapshot) => void`                                                     | **[x] CLOSED (recovery pass #1).** `onAfterSessionSnapshot` command hook — observe or transform (augment/redact) the captured `SessionSnapshot`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | closed                 | —                                                                                                     |
| PA6  | `AppOptions.onBeforeRestore?: (sessionId, snapshot) => false\|snapshot\|void` — **includes snapshot migration** | **[x] CLOSED (recovery pass #1).** `onBeforeSessionRestore` command hook + the dedicated typed `migrateSnapshot(snapshot, { from, to })` seam (construction-bound on session/app), invoked at the restore version-check decision point; `SnapshotVersionMismatch` throws fail-closed when a skew has no migrator.                                                                                                                                                                                                                                                                                                                                          | closed                 | —                                                                                                     |
| PA7  | `AppOptions.onAfterRestore?: (session, snapshot) => void`                                                       | **[x] CLOSED (recovery pass #1).** `onAfterSessionRestore` command hook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | closed                 | —                                                                                                     |
| PA8  | `AppOptions.sessionResolver?: (msg) => string\|null` — routes `app.receive()` inbound → sessionId               | **LOST.** No `sessionResolver`/`app.receive` in v2; routing implicitly a gateway concern but nothing documents the migration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | capability-loss        | resolver seam on the app inbox consumer, or document gateway routing as replacement                   |
| PA9  | `AppOptions.resolve?: ResolveConfig` — Layer-2 async preload keyed for `useResolved`                            | **LOST as options slot.** `useResolved` cache still referenced (`blueprint/08-session-harness.md`) but no `resolve` config; arbitrary resolve-key preload has no home                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | capability-loss        | `resolve`/preload slot feeding the `useResolved` cache, or document Class-B reconstruct-from-timeline |
| PA10 | `AppOptions.maxTimelineEntries?: number` — auto-trim oldest each tick                                           | **LOST as a config knob.** Closest is `timeline.compact(strategy)` (user-driven, not an automatic bound)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | capability-loss (mild) | wire a `timeline.maxEntries` trim policy or document `compact` as replacement                         |
| PA11 | `SpawnOptions.model?: EngineModel` — per-child model override                                                   | **LOST.** `SpawnInput` carries no `model`/`modelExecutor`; child inherits app model. Per-send `modelExecutor` exists but not at spawn-time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | capability-loss (mild) | add `model?`/`modelExecutor?` to `SpawnInput` (see SP1)                                               |

### Partial / acknowledged

| #    | v1 surface                                                                             | v2 status                                                                                                                                                                                                              | severity                  | recovery pass                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| PA12 | `runner.transformCompiled(COMInput, tools)` — mutate compiled context pre-model        | **Partial.** Nearest is `onBeforeModelRun`/`onBeforeModelProject` command hooks (reshape `ProjectInput.compiled` + `ExecuteInput.tools`) + tool-visibility filtering at `compileForTick`. No single 1:1 seam; see RUN1 | capability-loss (partial) | audit real `transformCompiled` use-cases; add a per-tick compiled-transform hook to `LoopExecutorProtocol` or a compiler contributor pass |
| PA13 | `SessionOptions.recording?: RecordingMode` + `TickSnapshot`/`getRecording` time-travel | **Deferred (acknowledged, not silent).** `blueprint/09-app-harness.md` lists it "carried from v1; still TBD". No v2 home; `OperationJournal` is the closest primitive                                                  | capability-loss           | decide recording taxonomy; rebuild time-travel on `OperationJournal` replay, or formally cut                                              |

### Present — renamed / reshaped (no loss)

| v1 surface                                                                            | v2 home                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onEvent`/`onTickStart`/`onTickEnd`/`onComplete`/`onError` (LifecycleCallbacks)       | `app.events(filter)` async-iterable bus + `onAfterSessionSend` command hook                                                                                     |
| `model` / `tools` / `maxTicks`                                                        | `AppHarnessOptions.model` (adapter) + `modelExecutor` twin / `tools: ToolDeclaration[]` / `defaultMaxTicks`                                                     |
| `mcpServers`                                                                          | `extensions: [withMCP(...)]` (optional extension, ADR 23/27)                                                                                                    |
| `runner`                                                                              | decomposed → `loop` (`LoopExecutorProtocol`/`defineLoop`) + interceptors (`use`/`guard`) + command hooks + tool-executor (`blueprint/09` L253 "runner removed") |
| `sessions.store` / `inbox`                                                            | `AppHarnessOptions.sessions.store: SessionStore` / `inbox: MessageInbox` substrate slot (verify durable write+FIFO-pending+markDone survive)                    |
| `onSessionCreate` / `onSessionClose`                                                  | `AppHarnessProtocol.onSessionCreate/onSessionClose(handler)` (create can veto)                                                                                  |
| `onBeforeSend` / `onAfterSend`                                                        | `onBeforeSessionSend` / `onAfterSessionSend` command hooks                                                                                                      |
| `onToolConfirmation`                                                                  | `ElicitationHarness` confirmation gate + tool-dispatch `guard` (callback→seam, **not** callback→static; verify a programmatic auto-approve path via `guard`)    |
| `sessionId`/`parentSessionId`/`metadata`/`tools`/`maxTicks`/`signal` (SessionOptions) | `CreateSessionInput.*` (idempotent open-or-rehydrate)                                                                                                           |
| `skillRegistry`                                                                       | `@agentick/skills-next` (`withSkills`) via `extensions`                                                                                                         |
| `devTools?: boolean`                                                                  | **justified-drop** — bus always-on; DevTools observes via `events()`                                                                                            |
| `inheritDefaults?: boolean`                                                           | **justified-drop** — no global `Agentick` singleton in v2 (ADR 23/83); nothing to inherit                                                                       |

---

## Surface 2 — ExecutionRunner hooks

v1: `ExecutionRunner` (call sites in `packages/core/src/app/session.ts`).
v2: replaced by app-shared loop/model/tool executors + interceptors +
command hooks (`blueprint/05-loop-executor.md` maps each hook).

| #    | v1 hook                                                           | v2 seam                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | severity  | recovery pass                                                      |
| ---- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| RUN1 | `transformCompiled(compiled, tools) => compiled`                  | **Present** (term rename COMInput→RenderedTree). `onBeforeModelRun`/`onBeforeModelProject` transform-form `BeforeHook` reshaping `ProjectInput.compiled` + `ExecuteInput.tools`; `model-executor` command-ifies `model:run`/`project`/`generate` + `.use()` around-chain; tool-visibility at `replaceCompilerTools`/`compileForTick`                                                                                                                                                                                                    | none      | none — register via `createApp({ hooks })` or `app.use()`          |
| RUN2 | `executeToolCall(call, tool, next)`                               | **Present, near-identical.** Tool-executor around-middleware `toolExecutor.fx.use((input, next) => …)` (proven in `tool-executor/src/__tests__/middleware-and-hooks.spec.ts`) + declarative `onBefore/AfterToolDispatch` + `.guardDispatch` veto. Both `via:"model"` and `via:"dispatch"` route through it                                                                                                                                                                                                                              | none      | none                                                               |
| RUN3 | `onSessionInit(session)` — once per session                       | **Present** (no named registrar). Session mounts agent once at construction → `onBeforeCompilerMount`/`onAfterCompilerMount` fire once; extension harnesses run constructor at wiring, register teardown via `parent.onClose(h)`                                                                                                                                                                                                                                                                                                        | ergonomic | optional `onInit` sugar over `onAfterCompilerMount`                |
| RUN4 | `onPersist(session, snapshot) => snapshot` — augment the snapshot | **[x] CLOSED (recovery pass #1).** `session.snapshot()` is now the `session:snapshot` command (async), minting `onAfterSessionSnapshot` — the transform-form after-hook IS the v1 `onPersist` augment/redact seam. Step 6 built: `snapshot()` folds every `SnapshotCapable` bridge generically via `isSnapshotCapable` feature-detection (mirrors the channel `snapshotProviders()` scan); `SessionSnapshot.bridges` replaces the hardcoded `timeline`/`knobs`. Proven with a fake extension bridge picked up with zero session change. | closed    | —                                                                  |
| RUN5 | `onRestore(session, snapshot)` — restore runner state             | **[x] CLOSED (recovery pass #1).** New `session.restore(input)` = the `session:restore` command, minting `onBefore/AfterSessionRestore`. Generic `importSnapshot()` fan-out over `snapshot.bridges` (feature-detected) + tick/usage accounting restore. Migration seam runs at the version-check decision point.                                                                                                                                                                                                                        | closed    | —                                                                  |
| RUN6 | `onDestroy(session)` — clean up                                   | **Present, improved.** `session.close()` tears down mount + closes every bridge; `BaseHarness.onClose(handler)` gives per-harness cleanup in **LIFO with error isolation** — strictly richer than v1's single hook                                                                                                                                                                                                                                                                                                                      | none      | none                                                               |
| RUN7 | `SpawnOptions.runner` inheritance (child inherits parent runner)  | **Present, reshaped.** Runner object gone; loop/model/tool executors are app-shared substrate inherited structurally by `createChildSession`; `app.use()`/`hooks` propagate to children by construction. Per-spawn executor override moves onto the child's first `send` (`SendInput.modelExecutor`/`target`)                                                                                                                                                                                                                           | ergonomic | optional: add `modelExecutor?`/`target?` to `SpawnInput` (see SP1) |

**Note:** RUN4/RUN5 and PA4–PA7 are the **same persist/restore cluster**
viewed from two angles — RUN4/5 = arbitrary harness snapshot
composition (unbuilt Step 6 SnapshotHarness, code-acknowledged);
PA4–PA7 = the app-level before/after/migration _hooks_ around store
writes (silently absent). Recover together.

---

## Surface 3 — Guards / Gates _(clean — parity or superset)_

v1: `packages/core/src/hooks/gate.ts`, `packages/kernel/src/guard.ts`.
v2: `packages-next/gates/`, guard as the four-verdict interceptor
(ADR 83, `packages-next/spec/src/data/outcomes.ts`, `runtime/src/substrate/op-signals.ts`).

| v1 surface                                             | v2 status                                                                                                                                                        | severity  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `gate()` + `useGate` + `GateState`                     | **PARITY++** — `gates-next` adds programmatic `session.gates` register/list, host `override()` with audit, ADR-34 parent-layer cascade                           | —         |
| `LatchGateDescriptor` / `VerifiedGateDescriptor`       | **PARITY++** — identical shape; v2 `satisfied` throw is **fail-closed** (engages gate) vs v1 fail-open                                                           | —         |
| Tick arbitration: explicit `stop()` beats `continue()` | **PARITY (verify).** Gate calls `continueAfterTick`; stop-beats-continue now lives in session's `TickEndForwardDecision`, not co-located with the gate           | ergonomic |
| `createGuard(fn) => Middleware` (boolean allow/deny)   | **PARITY++** — collapsed into the one interceptor primitive (`kind:"guard"`); `HandlerVerdict = proceed\|veto\|defer\|replace` (v1 boolean is the strict subset) | —         |

Only residue (GG1, ergonomic): confirm a session test asserts a budget
`stopAfterTick` overrides a gate `continueAfterTick` in the same tick;
add it if absent (the invariant moved packages).

---

## Surface 4 — Hooks / Middleware _(clean — parity or superset)_

v1: `model-hooks.ts`, `tool-hooks.ts`, `component-hooks.ts`,
`lifecycle.ts`, `Agentick.use()`. v2: command hooks (ADR 80/82/83) +
projected `useOn*` React hooks + per-harness `.use`/`.fx.use`.

| v1 surface                                                                           | v2 status                                                                                                                                                                                                                              | severity  |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Model hooks `fromEngineState`/`generate`/`stream`/`toEngineState`                    | **PARITY** — `model:project`/`model:generate`/`model:generate_stream` commands → `onBefore/AfterModel*` hooks                                                                                                                          | —         |
| Tool hook `"run"` + `.fx.use` rewrite                                                | **PARITY** — `tool:dispatch` command → `onBefore/AfterToolDispatch` + `.use`/`.fx.use`                                                                                                                                                 | —         |
| Component hooks `onMount/onUnmount/onStart/onTickStart/onTickEnd/onComplete/onError` | **PARITY++** — projected `useOnMount`/`useOnExecutionStart`/`useOnTickStart/End`/`useOnExecutionEnd`/`useOnError` + new `useOnToolStart/End`, `useOnModelGenerateStart/End`. v2 wires `onError` (v1 had a binding but **no producer**) | —         |
| `useContinuation(cb)`                                                                | **PARITY** — `useLoopControl(): { continueAfterTick, stopAfterTick }`                                                                                                                                                                  | —         |
| `Agentick.use(key, ...mw)` global glob-keyed middleware (`'*'`, `'tool:*'`)          | **PARITY (reshaped).** Global singleton gone; replaced by per-harness `.use`/`.fx.use` + `app.use/guard/hook` + `createApp({ hooks })` across ADR-76 tiers. Superset (v1 was global-only)                                              | ergonomic |
| `Model/Tool/BaseHookRegistry` (three disjoint vocabularies)                          | **JUSTIFIED-DROP** — exactly what ADR 80 collapses into `CommandRegistry`→`CommandHooks` derivation                                                                                                                                    | —         |

Residue (all ergonomic):

- **HM1** — `useAfterCompile((compiled, ctx) => …; ctx.requestRecompile())`
  in-tree hook has no React twin. Capability exists host-side
  (`onAfterCompilerRenderTree` + `compiler:rerender`); the in-tree form
  is missing. Recovery: add a `useAfterCompile` hook wrapping them.
- **HM2** — ADR-80 mandated `tool:dispatch`→`tool:execute` command
  rename is unlanded (registry still emits `tool:dispatch`). Land it or
  strike the mandate from ADR 80.

---

## Surface 5 — Spawn / sub-agents

v1: `session.spawn(component, input?, options?)` + `SpawnOptions` +
`MAX_SPAWN_DEPTH`. v2: `spawn(input: SpawnInput)` (spec
`session-harness.ts:577`, tagged `[V1-INHERITED]`; 1 agent : 1 session
per `data-layer-plan.md`). The method survives (justified reshaping),
but hardening trails it.

| #   | v1 surface                                                                                                  | v2 status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | severity                      | recovery pass                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| SP1 | `SpawnOptions.model` — per-child model override                                                             | **LOST** at spawn-time (dup of PA11). Only oblique via `send.modelExecutor`/`send.target` on the immediate-send form, or post-hoc `session.model.setModel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | capability-loss (recoverable) | thread `modelExecutor?`/`target?` through `SpawnInput` → `SpawnContextChildInput` → `createChildSession` |
| SP2 | `SpawnOptions.runner` — per-child runner override                                                           | **LOST as per-spawn override.** `LoopExecutorProtocol` is app-shared; no `loop`/`runner` field on `SpawnInput` (primitive swap justified; the per-child override is silently gone)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | capability-loss               | decide if per-child loop override is in scope; if yes add `loop?` to `SpawnInput`                        |
| SP3 | **Parent-inheritance semantics** — v1 child inherits parent's _live_ model/runner/maxTicks via `??` cascade | **Divergent.** v2 child gets **app defaults**, not the parent's live/swapped model. A parent that `setModel`'d does NOT pass it to its child                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | capability-loss (subtle)      | document explicitly; decide whether child inherits parent's live model executor                          |
| SP4 | `MAX_SPAWN_DEPTH = 10` recursion guard + `_spawnDepth`                                                      | **[x] CLOSED (recovery pass #3).** `createApp({ sessions: { maxSpawnDepth } })` (default 10, v1 parity) stamped app-uniformly onto every session. `spawn()` fails closed with the new typed `SpawnDepthExceededError` (`{ depth, maxDepth }`, thrown synchronously — excluded from `SessionErrorChannel` like `ModelExecutorBuilderMissingError`) when the parent's lineage is already at the ceiling. Depth is `spawnPath.length` — no separate `_spawnDepth` field (one source of truth).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | closed                        | —                                                                                                        |
| SP5 | Child event forwarding w/ `spawnPath` tagging + `spawn_start`/`spawn_end` lifecycle events                  | **[x] CLOSED (recovery pass #3).** `spawnPath` (ancestor lineage, root-first; `length` = depth) threaded from `spawn()` → `SpawnContextChildInput` → `createChildSession` → `SessionHarnessOptions`. Stamped on THREE surfaces: the child's `SessionRecord.spawnPath` (identity / sessions-list attribution), the loop `run-execution` + `tick` `EventScope` (bus/journal envelopes — sub-agent work attribution), and the per-execution handle stream (`StreamEventBase.spawnPath`). NOTE: v1's manual child→parent event forwarding is obsolete — v2 sessions share one bus, so tagging (not forwarding) is the mechanism. `spawn_start`/`spawn_end` lifecycle events NOT reintroduced (session graph + `parentSessionId` + `spawnPath` capture the spawn DAG; no separate lifecycle-event need surfaced). // TODO(spawn-lifecycle): revisit dedicated `spawn_start`/`spawn_end` envelopes if a consumer needs spawn-boundary timing beyond the session record. | closed                        | —                                                                                                        |
| SP6 | Parent-abort → child teardown propagation                                                                   | **[x] CLOSED (recovery pass #3).** The parent's construction signal is fanned into each child at spawn (reuses PA1 `mergeAbortSignals`-into-execution plumbing) — a parent abort tears down the child's in-flight work. The parent tracks its children and disposes them on close (`onClose`) AND on construction-signal abort, via the new `SpawnContext.disposeChildSession` (registry removal + `session.close()`). Abort-driven disposal awaits child quiescence (`SessionHarness.whenQuiescent`) so closing never unmounts the compiler mid-tick. Children dispose their own children transitively → whole sub-tree collapses.                                                                                                                                                                                                                                                                                                                               | closed                        | —                                                                                                        |
| —   | `SpawnOptions.maxTicks`/`metadata`                                                                          | **Present** on `SpawnInput` (+ new `initialProps`/`initialKnobs`, net gain)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                             | none                                                                                                     |
| —   | `SpawnOptions.label`                                                                                        | Dropped, folds into `metadata`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ergonomic                     | optional typed slot if UI needs it                                                                       |

---

## Surface 6 — Dispatch / audience / aliases _(clean — already restored)_

| v1 surface                                           | v2 status                                                                                                                                         | severity           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `session.dispatch(name, input)`                      | **Present, superset** — `session/harness.ts:1073` → `toolExecutor.dispatch`; spec adds `DispatchOptions.task: "auto"\|"ref"\|"inline"`            | —                  |
| Resolve by name, then alias                          | **Present** — `tool-executor/src/registry.ts` `aliasToName` index, name-first then alias (comment cites v1 parity)                                | —                  |
| `audience:"user"` (dispatch-only, hidden from model) | **Present, renamed** `[V1-REPLACED]` → `ToolExposure = "model"\|"dispatch"\|"runtime"` (v1 `"user"`→`"dispatch"`, `"all"`→`["model","dispatch"]`) | ergonomic (rename) |
| Audience filtering                                   | **Present** — `tool/src/transforms/filter.ts` `onlyExposingTo(audience)`                                                                          | —                  |
| Tool `aliases`                                       | **Present** — `tool/src/create-tool.ts` threads `aliases` → `ToolDeclaration.aliases`                                                             | —                  |

---

## Surface 7 — Adapter capabilities _(unchanged since 2026-06-02)_

v1 `createAdapter` (`packages/core/src/model/adapter.ts`) round-trips
cleanly onto v2 `LanguageModelAdapter`
(`packages-next/model/src/language-model-adapter.ts`, ADR 52):
`prepareInput`→`buildParams`, `execute`→`call`,
`executeStream`→`openStream`, `mapChunk`/`reconstructRaw`/
`extractMetadata`/`customBlocks`/`adapterTransform`→`adapterTransforms`
all present. No drift. Open adapter gaps stay **G10** (embed / no
`EmbeddingExecutorProtocol`), **G13** (user-facing `deltaTransform` — v2
has only `adapterTransforms`), **G14** (`messageTransformation`
per-provider role mapping). One untracked minor:

| #   | v1 surface                                                              | v2 status                                                                                                                                  | severity  | recovery pass                                                                       |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------- |
| AD1 | Adapter `onMount`/`onUnmount` (JSX `<Model>` component lifecycle hooks) | **LOST on the adapter.** v2 `LanguageModelAdapter` has no `onMount`/`onUnmount`; a model-as-JSX concern, not a translation-capability loss | ergonomic | fold into the model-as-JSX component surface if/when it lands; else document as cut |

---

## Surface 8 — Orphaned v1 exports (catch-all sweep)

v1 `core`/`shared`/`gateway`/`client` index exports vs any v2 home.
**No seam-violations, no surprise orphans** — every gap has a
documented v2 decision. The one genuinely-untracked risk is the client
chat-UX cluster.

| #   | v1 concept                                                                                                                                    | v2 status                                                                                                                                                                                                                            | severity                     | recovery pass                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| SW1 | Agentick DevTools event stream — `DevToolsEvent` union, `devToolsEmitter`, `DEVTOOLS_CHANNEL` (`shared/devtools.ts`) + `packages/devtools` UI | **LOST / [tracked]** — zero v2 hits; filed STATUS workstream (C), `V1-GATEWAY-PARITY-TRACKER` GD1–GD2, `CUT-GAP-AUDIT` #158. (React DevTools _bridge_ survives at `compiler-react/src/react/devtools-bridge.ts` — different concept) | capability-loss              | port event union+emitter as `@agentick/observability-next` (or fold into pubsub channels + eval); wire `@agentick/client-devtools` (#158)          |
| SW2 | Embeddings — `EmbedInput`/`EmbedResult` (`shared/embeddings.ts`) + OpenAI `embed()`                                                           | **LOST / [tracked]** — G10 / #153                                                                                                                                                                                                    | capability-loss              | land `EmbeddingExecutorProtocol` (see G10)                                                                                                         |
| SW3 | Gateway config system — `FileConfig`/`ConfigStore`/`bindConfig`/`loadConfig`/`interpolateConfig` (`gateway/src/config*.ts`)                   | **DEFERRED (deliberate)** — `V1-GATEWAY-PARITY-TRACKER` GC1/GC2: "adopters bring their own config layer unless a structural need appears"                                                                                            | capability-loss              | decide GC1: config-store gateway-extension vs adopter-owned                                                                                        |
| SW4 | `openaiCompatPlugin` (`gateway/src/plugins/openai-compat.ts`)                                                                                 | **DEFERRED (reshape) / [tracked]** — GP2 → planned `@agentick/gateway-openai-compat` after #254                                                                                                                                      | capability-loss              | build `gateway-openai-compat` gateway-extension                                                                                                    |
| SW5 | Client chat-UX: `MessageLog`, `ChatSession`, `MessageSteering` (`packages/client/src/`)                                                       | **LOST / reshaped** — `blueprint/58-connectors.md`/`CUT-GAP-AUDIT`: client-next is low-level RPC; steering moved server-side (`session:channel` + verbs)                                                                             | capability-loss              | rebuild as app/TUI-layer primitives over `client-core-next` views (wire-client backlog)                                                            |
| SW6 | Client chat-UX: **`LineEditor`, `AttachmentManager`, `chat-transforms`** (`timelineToMessages`/`extractToolCalls`)                            | **LOST — WEAKEST-TRACKED.** Appear in **no** v2 doc found; `client-core-next` is RPC/handles/views, `client-extensions-next` is only cache/offline/retry/telemetry. **Silent-drop risk before v2.0 cut**                             | capability-loss              | **enumerate explicitly in the wire-client/TUI backlog issue now**, before they drift-to-drop unrecorded (LineEditor = workstream C terminal tools) |
| SW7 | `ToolConfirmations` client class (`packages/client`)                                                                                          | **Reshaped (retired)** — confirmations flow as `session:channel:elicitation` envelopes via the elicitation harness                                                                                                                   | capability-loss (seam moved) | connector/UI subscribes to elicitation channel + routes replies to the harness address                                                             |
| SW8 | `serveStatic` (`gateway/src/serve-static.ts`) / `loggingPlugin`                                                                               | **DEFERRED / reshaped** — GF1 → `gateway-http-sse`; logging subsumed by gateway-extensions (#254) + `client-extensions-next/telemetry`                                                                                               | ergonomic                    | fold into HTTP transport / confirm a server logging gateway-extension post-#254                                                                    |

**Present (no loss), verified this sweep:** Secrets→`credentials-next`
(drop-in for v1 `@agentick/secrets`); Channels→`spec-next/channels.ts` +
`pubsub`/`subscriptions`/`client-core`; Compaction/token-budget/
`TokenEstimator`/`useContextInfo`→`compiler-react` projections + `model-next/model-info`;
COM types→compiler IR (ADR 49); Formatters→`formatters-next` (ADR 22);
persistence/snapshot/stores→`session`+`store`+`timeline-fs`+`timeline-postgres`
(ADR 49); all `use*` hooks, `gate`/`knob`, transports, `split-message`,
ulid/uuid, model-catalog, MCP server plugin → present.

---

## Consolidated recovery ranking (top 5, most valuable first)

1. **Persist/restore hook quartet + snapshot-migration seam + SnapshotHarness**
   (PA4–PA7 + RUN4/RUN5). The single highest-value cluster: no
   before/after-persist or before/after-restore hooks, **no
   snapshot-migration seam** (a real regression for schema evolution),
   and `session.snapshot()` still hardcodes timeline+knobs instead of
   folding every `SnapshotCapable` bridge (code-acknowledged "Step 6").
   The contract + generic-scan pattern already exist (proven for
   channels) — wiring is the gap. Fixes two surfaces at once.

2. **Session-registry eviction pair** (PA2 `maxActive` + PA3
   `idleTimeout`). The app `registry` is an unbounded `Map` → a memory
   leak in any long-lived deployment. Clear correctness/ops bug;
   evicted sessions already rehydrate via open-or-rehydrate, so the
   recovery is bounded.

3. **Spawn hardening** (SP4 `MAX_SPAWN_DEPTH` + SP6 parent-abort→child
   teardown + SP5 `spawnPath` event forwarding). Unbounded spawn
   recursion is a crash vector; missing abort propagation leaks child
   sessions on parent teardown; the `spawnPath` field survives but its
   plumbing doesn't, so nested sub-agent observability is dark. Safety-
   critical for any sub-agent tree.

4. **App-level `signal` cascade** (PA1). A single `AbortSignal` that
   fans into every session/send — cheap to add, and the only way to
   express "abort the whole app" short of `closeApp()` teardown.

5. **File the client chat-UX cluster before the v2.0 cut** (SW6, also
   SW5). `LineEditor`/`AttachmentManager`/`chat-transforms` appear in
   **no** v2 doc — the one genuinely-untracked drift-to-drop risk in the
   whole audit. Cheap (a backlog issue), time-sensitive (must land
   before the cut records the surface as intentionally empty).

Runner-ups: PA9 `resolve` preload, SP1/PA11 per-spawn model override,
PA8 `sessionResolver`, PA13 recording/time-travel, HM1 `useAfterCompile`
twin, HM2 `tool:execute` rename, GG1 stop-beats-continue test.

## Update log

- 2026-07-22: full-surface parity audit (this section). Eight surfaces
  swept App/Session · Runner · Guards/Gates · Hooks · Spawn · Dispatch ·
  Adapter · orphan-exports. **0 seam-violations** (the 2026-05 class did
  not recur), ~22 capability-loss (~15 silently lost), ~12 ergonomic.
  Highest-value cluster: session persist/restore hooks + SnapshotHarness
  wiring. Read-only; no production code changed.
- 2026-07-22: **recovery pass #1 — persist/restore cluster CLOSED**
  (PA4–PA7 + RUN4/RUN5, recovered together as one cluster). `session.snapshot()`
  became the async `session:snapshot` command and `session.restore(input)` the
  new `session:restore` command — the persist/restore hook quartet
  (`onBefore/AfterSessionSnapshot`, `onBefore/AfterSessionRestore`) falls out of
  the ADR-80 CommandRegistry derivation. Step 6 (ADR 27) built: both fold every
  `SnapshotCapable` bridge generically via a new spec `isSnapshotCapable` guard
  (sibling to `isChannelSnapshotProvider`) — `SessionSnapshot.bridges` replaces
  the hardcoded `timeline`/`knobs` (single source of truth per bridge). New
  typed `migrateSnapshot(snapshot, { from, to })` migration seam
  (construction-bound on session, threaded from `AppHarnessOptions`), invoked at
  the restore version-check decision point; `SnapshotVersionMismatch` throws
  fail-closed with no migrator. Threading: spec (`SessionSnapshot` reshape,
  `SnapshotMigration`, `RestoreSnapshotInput`, `SnapshotVersionMismatch`,
  `isSnapshotCapable`), session (`harness.ts`, `session-state.ts` tick/usage
  setters, `define-session.ts` callback surface), app (`migrateSnapshot`
  cascade). `kill-resume` acceptance extended with a snapshot→restore
  round-trip; new `snapshot-command.spec.tsx` (7 tests) proves hooks fire,
  migration runs on skew + throws without it, and a fake extension bridge
  round-trips with zero session change. Conformance updated + extended
  (async snapshot, generic `bridges` fold, restore round-trip). All gates
  green (typecheck 152/152; session/spec/spec-conformance/knobs/timeline
  suites; oxfmt + oxlint clean). Still open in the cluster's neighborhood:
  PA1–PA3 (app signal cascade, registry eviction), the spawn-hardening
  cluster (SP4–SP6) — separate passes.
- 2026-07-22: **recovery pass #2 — app-harness operational cluster CLOSED**
  (PA1–PA3). The unbounded live `registry` `Map` (the motivating memory leak)
  is now bounded by `createApp({ sessions: { maxActive, idleTimeout } })`:
  soft-LRU cap (`enforceMaxActive`) + `unref`'d idle sweep (`sweepIdle`), both
  guarding on `session.hasInFlightExecution` (never evict active work) and
  paging out via `disposeSession(id, "evict")` — teardown of the live harness
  WITHOUT deleting the durable record, so `createSession(sameId)` rehydrates
  transparently (ADR-49). Activity tracked off a `requested`-phase bus
  subscription, wired only when eviction is configured. PA1: `AppHarnessOptions.signal`
  fanned into every session (merged into each send's loop signal via
  `mergeAbortSignals`, lifted to `@agentick/utils-next` + dedup'd with
  loop-executor) — aborts in-flight work + refuses new (`assertOpen` +
  already-aborted sends resolve `aborted`). Also lit up the dead
  `CreateSessionInput.signal`. Threading: utils (`abort-signals.ts` + test),
  loop-executor (import the lifted helper), session (`signal` option,
  `hasInFlightExecution` getter, send-signal merge), app (options + eviction +
  cascade). New `session-eviction.spec.tsx` (4) + `app-signal.spec.tsx` (3).
  All gates green (typecheck 152/152; app/session/spec-conformance suites incl.
  verbatim kill/resume; oxfmt + oxlint clean). Neighborhood still open:
  spawn-hardening cluster (SP4–SP6).
- 2026-07-22: **recovery pass #3 — spawn-hardening cluster CLOSED**
  (SP4–SP6). SP4: `createApp({ sessions: { maxSpawnDepth } })` (default 10,
  v1 `MAX_SPAWN_DEPTH` parity) bounds recursive spawn; `spawn()` fails closed
  with the new typed `SpawnDepthExceededError` when the parent's lineage is at
  the ceiling. Depth = `spawnPath.length` (no separate `_spawnDepth` — one
  source of truth). SP5: `spawnPath` (ancestor session ids, root-first)
  threaded `spawn()` → `SpawnContextChildInput` → `createChildSession` →
  `SessionHarnessOptions`, and STAMPED on three surfaces — the child's
  `SessionRecord.spawnPath`, the loop `run-execution` + `tick` `EventScope`
  (bus/journal), and the per-execution handle stream (`StreamEventBase`). v2's
  shared bus makes tagging (not v1's manual child→parent forwarding) the
  mechanism; the session graph (`parentSessionId` + `spawnPath`) captures the
  spawn DAG directly, so `spawn_start`/`spawn_end` were NOT reintroduced (loud
  TODO left). SP6: the parent's construction signal is fanned into each child
  (PA1 plumbing → parent abort tears down child in-flight work) and the parent
  disposes its children on close AND on abort via the new
  `SpawnContext.disposeChildSession` (registry removal + `close()`), awaiting
  child quiescence (`SessionHarness.whenQuiescent`) so disposal never unmounts a
  compiler mid-tick; sub-trees collapse transitively. Threading: spec
  (`SpawnDepthExceededError` + channel/index/re-exports, `SpawnContext` +`disposeChildSession`, `SpawnContextChildInput` +`spawnPath`/`signal`,
  `RunExecutionInput`/`TickInput` +`spawnPath`, `SessionRecord` +`spawnPath`),
  loop-executor (`run-execution`/`tick` scope factories + `TickInput` forward),
  session (`spawnPath`/`maxSpawnDepth` options + fields, depth guard, lineage
  extension, signal fan-in, `_children` tracking + `disposeChildren` +
  `whenQuiescent`, runtime + handle stamping), app (`sessions.maxSpawnDepth`
  option + field, overrides thread `spawnPath`/`signal`, `createChildSession`
  forward, `disposeChildSession` impl). New `spawn-hardening.spec.tsx` (7:
  2 SP4, 3 SP5, 2 SP6). All gates green (typecheck 152/152 force; app/session/
  spec-conformance verbatim; the 2 documented app-harness 30s flakes verified
  pre-existing on stash; oxfmt + oxlint clean).
