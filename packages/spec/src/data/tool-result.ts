/**
 * Tool result currency (ADR 70).
 *
 * A tool handler's synchronous/promised/Effect return is a small
 * message-input-style currency — a bare string (sugar for one text
 * block), a `ContentBlock[]`, or a full {@link ToolResultEnvelope} that
 * additionally carries `structuredContent` (the `outputSchema`-validated
 * machine result) and `isError` (a soft, model-visible domain error).
 * All three normalize to ONE internal {@link NormalizedToolResult} at
 * dispatch via {@link normalizeToolResult}.
 *
 * The three shapes are DISCRIMINABLE (string / array / object-with-
 * `content`), so a wrong-shape return is a *type error*, not a silent
 * reinterpretation. Plain-object → `JsonBlock` guessing is deliberately
 * NOT supported (it would collide with the envelope and destroy
 * compile-time safety) — structured data goes through `structuredContent`.
 *
 * Pure type + normalizer declarations — no runtime deps, browser-safe.
 * The `outputSchema` validation of `structuredContent` lives in the tool
 * executor (`@agentick/tool-executor`), next to `inputSchema`
 * validation; this file only shapes + normalizes.
 *
 * @see docs/proposals/v2/blueprint/70-tool-result-currency.md
 */

import type { ContentBlock } from "./content-blocks.js";
import { toContentBlocks } from "./content-blocks.js";

// ============================================================================
// Currency shapes
// ============================================================================

/**
 * The optional full return form. `content` is the model/human-readable
 * display (string sugar accepted here too); `structuredContent` is the
 * typed machine result validated against the tool's `outputSchema`;
 * `isError` flags a SOFT/domain error (distinct from a thrown/rejected
 * dispatch — the HARD failure path); `metadata` is free-form.
 */
export interface ToolResultEnvelope {
  readonly content: string | readonly ContentBlock[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The three discriminable top-level return shapes a handler may resolve
 * to (before the Promise / Effect / TaskHandle wrappers). String is
 * sugar for one text block; the array is today's shape; the envelope is
 * the opt-in full form.
 */
export type ToolResultInput = string | readonly ContentBlock[] | ToolResultEnvelope;

/**
 * The ONE internal result every {@link ToolResultInput} normalizes to at
 * dispatch. Feeds `DispatchResult.{content, structuredContent, isError}`
 * and the MCP `CallToolResult` mapping.
 */
export interface NormalizedToolResult {
  readonly content: readonly ContentBlock[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Normalization
// ============================================================================

/**
 * Type guard for the envelope form of {@link ToolResultInput}. An
 * envelope is a plain object carrying `content` — distinct from both the
 * `string` and the `ContentBlock[]` (array) forms.
 */
export function isToolResultEnvelope(v: ToolResultInput): v is ToolResultEnvelope {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Normalize the tool-result currency to ONE internal result:
 *
 *   - `string`            → `{ content: [{ type: "text", text }] }`
 *   - `ContentBlock[]`    → `{ content }` (identity on the array)
 *   - `ToolResultEnvelope`→ `{ content: normalize(content), structuredContent, isError, metadata }`
 *
 * The envelope's `content` gets the same string-sugar treatment via
 * {@link toContentBlocks}. `structuredContent` / `isError` / `metadata`
 * are carried through only when present (undefined stays absent, so the
 * bare-array path is behavior-identical to before ADR 70).
 */
export function normalizeToolResult(result: ToolResultInput): NormalizedToolResult {
  if (typeof result === "string") return { content: toContentBlocks(result) };
  if (Array.isArray(result)) return { content: result };
  const env = result as ToolResultEnvelope;
  return {
    content: toContentBlocks(env.content),
    ...(env.structuredContent !== undefined ? { structuredContent: env.structuredContent } : {}),
    ...(env.isError !== undefined ? { isError: env.isError } : {}),
    ...(env.metadata !== undefined ? { metadata: env.metadata } : {}),
  };
}
