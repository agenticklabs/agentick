/**
 * Context entries — model-input portion of a {@link RenderedTree}.
 *
 * Tree order is canonical. There is no `position` field; ordering is
 * implicit in array order. Both subkinds are discriminated by `kind`.
 *
 * `[V1-REPLACED]` of v1's `Map<string, CompiledSection>` and
 * `CompiledTimelineEntry[]`. Sections are first-class entries — not a
 * separate map and not authoring-only.
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md §ContextSpec
 */

import type { ContentBlock, MessageRole } from "./content-blocks.js";
import type { FormatterRef, FormatTrace } from "./formatter.js";

// ============================================================================
// Caching hint
// ============================================================================

/**
 * Cross-provider caching intent. The reconciler MUST NOT reorder context
 * for caching; the executor maps this hint to provider mechanics
 * (Anthropic `cache_control`, OpenAI prefix caching, Gemini
 * `cachedContents`).
 */
export interface CacheHint {
  readonly ttl?: "5m" | "1h" | (string & {});
  /** `[PLACEHOLDER]` — exact semantics pending sign-off. */
  readonly scope?: "prefix" | "block";
  readonly [key: string]: unknown;
}

// ============================================================================
// MessageEntry
// ============================================================================

export interface MessageMetadata {
  readonly cache?: CacheHint;
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
  /**
   * Provenance convention (NOT a typed field — see below). Messages
   * entering a session from an external chat surface carry their
   * origin under `metadata.source`, typed against the module-augmentable
   * {@link MessageSource} empty-seed interface. It lives in the open bag
   * (this index signature) rather than as a declared field so a
   * connector-provenance concept is never hardcoded into the
   * foundational message shape (ADR 27 / ADR 58 §MessageSource). Readers
   * cast `metadata.source as MessageSource`.
   */
  readonly [key: string]: unknown;
}

/**
 * Role-bearing context entry. `role` is an Agentick semantic role; mapping
 * to provider role vocabulary is the executor's job during projection.
 */
export interface MessageEntry {
  readonly kind: "message";
  readonly role: MessageRole;
  readonly content: readonly ContentBlock[];
  readonly renderedWith?: FormatterRef;
  readonly renderTrace?: readonly FormatTrace[];
  readonly id?: string;
  readonly metadata?: MessageMetadata;
}

// ============================================================================
// SectionEntry
// ============================================================================

export interface SectionMetadata {
  /** Hint to executors that may reorder. */
  readonly priority?: number;
  readonly cache?: CacheHint;
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/**
 * Structured context entry. Stable `id` survives recompiles.
 */
export interface SectionEntry {
  readonly kind: "section";
  readonly id: string;
  readonly title?: string;
  readonly content: readonly ContentBlock[];
  readonly renderedWith?: FormatterRef;
  readonly renderTrace?: readonly FormatTrace[];
  readonly metadata?: SectionMetadata;
}

// ============================================================================
// Union + ContextSpec
// ============================================================================

export type ContextEntry = MessageEntry | SectionEntry;

export interface ContextSpec {
  readonly entries: readonly ContextEntry[];
}
