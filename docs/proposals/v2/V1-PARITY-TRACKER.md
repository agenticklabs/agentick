# v1 → v2 Adapter Parity Tracker

**Status:** open. Updated as gaps close.

This document tracks the feature gap between v1's provider adapters
(`@agentick/openai`, `@agentick/anthropic`, `@agentick/google`,
`@agentick/ai-sdk` in v1) and v2's executors / adapters
(`@agentick/executor-openai`, `@agentick/executor-ai-sdk` today;
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
`@agentick/executor-openai` / `@agentick/executor-ai-sdk` packages
TODAY without waiting for the ModelAdapter rename/reshape. Reason:
the translation code (provider request → response, chunk → AdapterDelta,
ContentBlock ↔ provider shapes) is concrete provider-layer work.
Whether that layer is called `ExecutorOpenAI` today or
`OpenAIAdapter` tomorrow, the translation logic moves with the
package when we reshape.

The reshape touches package names + the `@agentick/executor`
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
      augment via `declare module "@agentick/spec"` — matches v1's
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

- [ ] **G7. ThinkTagParser for inline `<think>` tags.**
      v1 has 108 LOC parser handling LM Studio / ollama / other local
      servers that emit raw `<think>...</think>` in delta.content
      instead of separate reasoning fields. Config-gated via
      `parseThinkTags`. v2 has nothing.
      - Files: port `packages/adapters/openai/src/think-tag-parser.ts`
        to v2 (likely `packages/executor-openai/src/think-tag-parser.ts`);
        adapter-internal transform stage applied to text deltas
        before they emit.

- [ ] **G8. Native Anthropic executor / adapter.**
      v1 has full Anthropic adapter; v2 only has the ai-sdk wrapper.
      Adopters wanting tighter envelope fidelity (no AI SDK middleman,
      direct streaming, native cache control headers) have no path.
      - Plan: new `@agentick/executor-anthropic` (or `@agentick/anthropic`
        under ModelAdapter naming). Port from v1's anthropic adapter:
        chunk mapping, message format, content-block translation
        including `thinking` block type, cache token surfacing,
        executeStream.

- [ ] **G9. Native Google executor / adapter.**
      Same shape as G8 for Google's Gemini. v1 has it; v2 doesn't.
      - Plan: `@agentick/executor-google` (or `@agentick/google`).

- [ ] **G10. Embedding API support.**
      v1 OpenAI adapter exposes `embed()` for text embeddings. v2
      `ExecutorProtocol` has no embedding surface. Adopters building
      RAG / retrieval can't use the v2 executor for embeddings.
      - Plan: requires protocol-level work. Either a separate
        `EmbeddingExecutorProtocol` (cleaner — embeddings ARE a
        different operation than chat completions) OR a new
        `kind: "embedding"` `ExecutionTarget` discriminant. Lean
        toward separate protocol; same package can implement both.
      - Files: new protocol type in spec; embeddingExecutor surface
        on adapters that support it (OpenAI, AI SDK, Google).

### Medium (close pre-1.0; not migration-blocking)

- [ ] **G11. Tool definition `providerOptions`.**
      v1 tool definitions can carry `tool.providerOptions.openai`
      that merges into the OpenAI tool shape (e.g., for OpenAI's
      `strict: true` JSON schema mode). v2's `ToolDeclaration` has
      no equivalent. Adopters using strict-mode tool calls can't.
      - Files: `packages/spec/src/data/declarations.ts` (extend
        `ToolDeclaration`), OpenAI/AI SDK executors merge into
        provider tool shape.

- [ ] **G12. customBlocks parsing from stream.**
      v1 supports application-level custom block parsing from the
      text stream — e.g., extracting `<answer>...</answer>` tags as
      `custom_block_*` events. v2 has the events in the AdapterDelta
      union (already shipped in Layer 1) but no parser plumbing.
      - Plan: adapter-internal transform stage. Same plumbing as G7
        (ThinkTagParser) — both are text-stream-to-extra-deltas
        transforms.

- [ ] **G13. deltaTransform extension point.**
      v1 lets adopters supply a transform applied to deltas. v2 has
      none. Lower urgency than G7/G12 — explicit extension hook for
      advanced adopters.
      - Design needed: where the transform plugs in
        (executor-package-internal? executor protocol option?).

- [ ] **G14. `messageTransformation` capability.**
      v1 has elaborate per-provider role mapping: GPT-4/o1/o3 get
      `developer` role for ephemeral / event messages; Claude gets
      XML-preferred rendering vs Markdown for OpenAI. v2 has nothing
      — same `system/user/assistant/tool` regardless of provider.
      - Touches reconciler (it currently produces canonical messages
        without provider awareness). Bigger architectural piece.
      - Plan: revisit during ModelAdapter work, where adapter
        advertises capability metadata that the loop / reconciler
        consults.

- [ ] **G15. responseFormat `name` for json_schema mode.**
      v1 uses `rf.name ?? "response"`. v2 hardcodes `"response"`.
      Minor — adopters using OpenAI structured outputs can't name
      their schema.
      - Files: `packages/spec/src/protocol/executor.ts`
        (`responseFormat` shape — add `name?: string`),
        OpenAI + AI SDK executors pass it through.

- [ ] **G16. `OPENAI_ORGANIZATION` env var fallback.**
      v1 reads `OPENAI_ORGANIZATION` env var alongside the API key.
      v2 doesn't. Minor — affects enterprise adopters using
      organization-scoped API keys.
      - Files: `packages/executor-openai/src/openai-executor.ts`
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
   - package.json: workspace deps on `@agentick/spec`,
     `@agentick/runtime`, the provider SDK; optional peer dep on
     React only if the adapter has a `/react` subpath.
   - tsconfig.json + tsconfig.build.json extending root.
   - Add to `.changeset/config.json` linked list.
   - Add to `website/typedoc.json` entry points.
   - Add to `website/.vitepress/config.mts` PACKAGE_GROUPS.
   - README following the executor package convention.

3. **Implement the executor class:**
   - `class ProviderExecutor extends BaseHarness<"executor"> implements LanguageModelExecutor`
   - Required methods: `project`, `execute`, `executeStream`,
     `normalize`, `run`, `abort`.
   - `project` should be reusable via shared `defaultProject` from
     `@agentick/executor` unless the provider needs custom logic.
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
   - Use `runExecutorConformance` from `@agentick/spec-conformance`
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
  `declare module "@agentick/spec"`. Commits: `8257bdbf` (G1, G4, G5,
  G15), `10a4d2e2` (ProviderOptions module augmentation), `2b9fabb4`
  (G2, G3, G6). 5337 tests passing, full typecheck clean.
