/**
 * RenderedTree — the canonical IR produced by the compiler harness and
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
 * Canonical tool-choice directive — how the model MUST treat the tool set.
 * Mirrors `LanguageModelToolChoice` on the executor's canonical parameters
 * (the wire-facing twin); the compiler lifts `SpecConfig.toolChoice` into
 * `LanguageModelInput.parameters.toolChoice`, and each adapter TRANSLATES
 * that one normalized value into its provider dialect under the
 * normalize-translate-escape-hatch rule (`providerOptions.<ns>` spreads
 * LAST, so a provider-specific override always wins).
 *
 * - `"auto"` — model decides whether to call a tool (provider default).
 * - `"none"` — model MUST NOT call a tool this tick.
 * - `"required"` — model MUST call at least one tool (any of them).
 * - `{ tool }` — model MUST call THIS tool, named by framework tool name.
 *
 * The multi-tool restriction some providers support (e.g. Google's plural
 * `allowedFunctionNames`) is deliberately NOT part of the canonical form —
 * reach for `providerOptions.<ns>`.
 */
export type ToolChoice = "auto" | "none" | "required" | { readonly tool: string };

/**
 * Cross-provider generation knobs. Provider-specific escapes go in
 * {@link ProviderOptions}.
 */
export interface SpecConfig {
  readonly model?: ModelSelection;
  readonly responseFormat?: ResponseFormat;
  /**
   * Canonical tool-choice directive — see {@link ToolChoice}. Authorable via
   * `<config>` AND injectable via the loop's per-tick config overlay (the
   * injection point a forced wrap-up tick uses).
   */
  readonly toolChoice?: ToolChoice;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly stopSequences?: ReadonlyArray<string>;
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
 * // in @agentick/model-openai-next
 * declare module "@agentick/spec-next" {
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

/**
 * Merge two {@link ProviderOptions} bags with `patch` winning per
 * provider-namespace key (one-level-deep, so two adopters decorating
 * the same block under different namespaces never collide, and the
 * same namespace's keys shallow-merge with the patch on top).
 *
 * The single canonical merge for the layered provider-escape channel:
 *   - the compiler folds multiple `<ProviderOptions>` declarations
 *     during tree collection;
 *   - projection folds `RenderedTree.providerOptions` **over**
 *     `ExecutionTarget.providerOptions` into `LanguageModelInput`
 *     (#176 — tree/per-render wins);
 *   - adapters fold `input.providerOptions` over `target.providerOptions`
 *     defensively in `buildParams`.
 *
 * All four call sites share these semantics — do not hand-roll.
 */
export function mergeProviderOptions(
  base: ProviderOptions | undefined,
  patch: ProviderOptions | undefined,
): ProviderOptions | undefined {
  if (!base) return patch ? { ...patch } : undefined;
  if (!patch) return { ...base };
  // ProviderOptions is a module-augmentable empty-seed interface — it
  // can't be indexed generically at the type level, so cast to a record
  // for the per-namespace merge.
  const out = { ...base } as Record<string, Record<string, unknown> | undefined>;
  const patchRec = patch as Record<string, Record<string, unknown> | undefined>;
  for (const [k, v] of Object.entries(patchRec)) {
    if (v === undefined) continue;
    out[k] = { ...(out[k] ?? {}), ...v };
  }
  return out as ProviderOptions;
}

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
// Surfacing provenance (ADR 63)
// ============================================================================

/**
 * Which surfacing layer produced a contribution, and under which harness
 * key. ADR 63: every context entry and tool declaration in the IR is
 * traceable to either a **default** projection (framework-supplied,
 * ran because the tree did not override that harness's projection) or an
 * **authored** contribution (a component the adopter wrote).
 *
 * The key is the surfacing-capable harness's key — `"timeline"`,
 * `"tools"`, … — or `"content"` for the raw append stream
 * (`<Message>` / `<Section>` / `<Text>` written directly, not through a
 * projection).
 *
 * @example `"default:timeline"` — the timeline default fold ran (no
 *          `<Timeline>` in the tree).
 * @example `"authored:timeline"` — an adopter's `<Timeline>` overrode the
 *          default projection.
 * @example `"authored:content"` — a bare `<Section>` / `<Message>`.
 */
export type SurfacingProvenance = `authored:${string}` | `default:${string}`;

/**
 * Provenance sidecar for a {@link RenderedTree}. Index-aligned with the
 * wire arrays it annotates — `entries[i]` tags `context.entries[i]`;
 * `tools[i]` tags `declarations.tools[i]`. Lives OUTSIDE the wire shapes
 * (`ContextEntry` / `ToolDeclaration`) so provenance never leaks to a
 * provider — it is IR-inspection metadata devtools reads to answer "what
 * did the model see, and which layer put it there?" (ADR 49's
 * inspectable-IR invariant under ADR 63 defaults).
 *
 * The alignment survives the harness's post-collect formatter pass
 * (which maps `context.entries` 1:1) and is never reordered.
 */
export interface RenderedTreeProvenance {
  /** Provenance per context entry, index-aligned with `context.entries`. */
  readonly entries?: readonly SurfacingProvenance[];
  /** Provenance per tool declaration, index-aligned with `declarations.tools`. */
  readonly tools?: readonly SurfacingProvenance[];
}

// ============================================================================
// RenderedTree
// ============================================================================

/**
 * The canonical IR. Produced by the compiler harness's `renderTree`
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

  /**
   * Surfacing provenance (ADR 63) — which layer (default vs authored)
   * produced each context entry / tool declaration. Omitted when the
   * producing compiler does not track provenance. Never sent to a
   * provider; inspection-only.
   */
  readonly provenance?: RenderedTreeProvenance;
}
