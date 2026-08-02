/**
 * Context entries — model-input portion of a {@link RenderedTree}.
 *
 * A model call is system instructions plus ordered messages. Nothing else
 * exists at the wire, so nothing else exists here: `entries` is a flat,
 * ordered list of {@link MessageEntry}. Tree order is canonical — there is
 * no `position` field and no reorder hint.
 *
 * A `<Section>` is CONTENT, not an entry. Inside a message it lowers into
 * that message's content blocks; free-floating it becomes an anonymous
 * `role: "grounding"` message at its own position (ADR 94 — container
 * decides role, position decides order).
 *
 * @see docs/proposals/v2/blueprint/94-positional-sections.md
 * @see docs/proposals/v2/blueprint/02-data-model.md §ContextSpec
 */

import type { CacheHint, ContentBlock, MessageRole } from "./content-blocks.js";
import type { FormatterRef, FormatTrace } from "./formatter.js";

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
// ContextSpec
// ============================================================================

export interface ContextSpec {
  readonly entries: readonly MessageEntry[];
}
