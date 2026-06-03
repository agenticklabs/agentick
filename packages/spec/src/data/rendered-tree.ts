/**
 * RenderedTree — the canonical IR produced by the reconciler harness and
 * consumed by the loop executor and executor harness.
 *
 * `[V1-REPLACED]` of v1's `CompiledStructure`
 * (`packages/core/src/compiler/types.ts`) and `COMInput`
 * (`packages/core/src/com/types.ts`).
 *
 * Everything carried here is JSON-shaped. Renderer instances, tool
 * handlers, React fibers, Effect refs, provider SDK clients — none of
 * these may appear in this structure (the spec firewall).
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md §RenderedTree
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 */

import type { ContentBlock } from "./content-blocks.js";
import type { RuntimeDeclarations } from "./declarations.js";
import type { ContextSpec } from "./entries.js";
import type { FormatDiagnostics, FormatterRef, FormatTrace } from "./formatter.js";

// ============================================================================
// SpecConfig + ProviderOptions
// ============================================================================

/**
 * Normalized response-format directive. Generation-time provider knob.
 * `[V1-INHERITED]` from `packages/shared/src/models.ts`.
 */
export type ResponseFormat =
  | { readonly type: "text" }
  | { readonly type: "json" }
  | {
      readonly type: "json_schema";
      readonly schema: Record<string, unknown>;
      readonly name?: string;
    };

/**
 * Identifies a model — either a concrete id understood by the executor or
 * a reference resolved against a runtime registry.
 *
 * `[PLACEHOLDER]` — sign-off pending.
 */
export type ModelSelection =
  | { readonly kind: "by-id"; readonly id: string }
  | { readonly kind: "by-ref"; readonly ref: string };

/**
 * Cross-provider generation knobs. Provider-specific escapes go in
 * {@link ProviderOptions}.
 */
export interface SpecConfig {
  readonly model?: ModelSelection;
  readonly responseFormat?: ResponseFormat;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Provider-specific escapes — three tiers mirroring v1's
 * `ProviderClientOptions` / `ProviderGenerationOptions` /
 * `ProviderToolOptions` augmentable interfaces. All three are
 * **empty-seed interfaces**: each adapter package augments its own
 * slot via TypeScript module augmentation. The spec hardcodes no
 * provider shape.
 *
 * Adapters MUST type their slots as the SDK's actual config types —
 * not hand-rolled subsets. The point is that adopters writing
 * `target.providerOptions.openai` see the SAME shape they'd see
 * writing the OpenAI request directly.
 *
 * ```ts
 * // in @agentick/executor-openai
 * declare module "@agentick/spec" {
 *   interface ProviderClientOptions {
 *     openai?: OpenAI.ClientOptions;
 *   }
 *   interface ProviderOptions {
 *     openai?: Partial<OpenAI.Chat.Completions.ChatCompletionCreateParams>;
 *   }
 *   interface ProviderToolOptions {
 *     openai?: { strict?: boolean };
 *   }
 * }
 * ```
 *
 * Three structural levels:
 * - {@link ProviderClientOptions} — SDK client construction (apiKey,
 *   baseURL, organization, vertexai/project/location, dispatcher…).
 *   Consumed at executor construction time. Per-executor, not per-call.
 * - {@link ProviderOptions} — per-call/generation request shape
 *   (temperature, seed, safety, thinking, response_format, …). Lives
 *   on {@link RenderedTree.providerOptions} and
 *   {@link ExecutionTarget.providerOptions}.
 * - {@link ProviderToolOptions} — per-tool-definition (OpenAI strict
 *   mode, Anthropic per-tool cache_control, Gemini function-decl
 *   overrides). Lives on `ToolDeclaration.providerOptions`.
 *
 * For per-block metadata (Anthropic per-block `cache_control`, Gemini
 * `thoughtSignature` on a functionCall part), use
 * {@link BaseContentBlock.providerMetadata} — that is the fourth
 * informal channel and is keyed by the same provider namespaces.
 *
 * Same augmentation pattern as {@link HookBridges} (ADR 26/27): the
 * spec ships an empty surface, packages contribute slots, no central
 * registry of "known providers" exists in spec.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProviderClientOptions {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProviderOptions {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProviderToolOptions {}

// ============================================================================
// Feature registry (initial set, sign-off pending)
// ============================================================================

/**
 * Initial registry of optional features a {@link RenderedTree} may declare.
 * Adapters reject unsupported required features.
 *
 * `[PLACEHOLDER]` — extensible; tracked in 17-open-questions.md.
 */
export type SpecFeatureName =
  | "sections"
  | "tool-declarations"
  | "caching"
  | "provider-options"
  | "free-root-content"
  | "render-trace"
  | "outputs"
  | "mcp-declarations"
  | (string & {});

// ============================================================================
// RenderedTree
// ============================================================================

/**
 * The canonical IR. Produced by the reconciler harness's `renderTree`
 * command. The same shape carries both execution input (context +
 * declarations) and free-root rendering output (top-level `content` /
 * `text` / `mimeType`).
 */
export interface RenderedTree {
  /** Spec date version (e.g., `"2026-05-01"`). */
  readonly specVersion: string;

  /** Optional features declared by this tree. */
  readonly features?: readonly SpecFeatureName[];

  /** Model-input context. */
  readonly context: ContextSpec;

  /** Non-context runtime registrations. */
  readonly declarations?: RuntimeDeclarations;

  /** Cross-provider generation knobs. */
  readonly config?: SpecConfig;

  /** Provider-specific escapes. */
  readonly providerOptions?: ProviderOptions;

  // ────────── Free-root rendering channels (non-execution use cases) ──────────

  /** Top-level rendered content for resource/output rendering. */
  readonly content?: readonly ContentBlock[];
  /** Top-level rendered text (free-root). */
  readonly text?: string;
  /** Top-level rendered MIME type (free-root). */
  readonly mimeType?: string;
  /** Top-level formatter identity (free-root). */
  readonly renderedWith?: FormatterRef;
  /** Top-level render trace. */
  readonly renderTrace?: readonly FormatTrace[];

  // ────────── Bag-of-diagnostics + metadata ──────────

  readonly diagnostics?: FormatDiagnostics;
  readonly metadata?: Record<string, unknown>;
}
