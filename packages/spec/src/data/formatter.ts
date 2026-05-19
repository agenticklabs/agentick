/**
 * Formatter protocol types — wire shapes for the formatter harness.
 *
 * The formatter harness turns semantic content into rendered content
 * (markdown / XML / text / JSON). Formatter identity is data
 * ({@link FormatterRef}); behavior lives behind the harness.
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md §Renderer protocol types
 * @see docs/proposals/v2/blueprint/04-formatters.md
 */

import type { ContentBlock } from "./content-blocks.js";
import type { SemanticContentBlock, SemanticType } from "./semantic.js";

/**
 * Identity reference to a formatter implementation. Crosses the wire;
 * resolved by the formatter harness to a concrete implementation.
 */
export interface FormatterRef {
  readonly id: string;
  readonly format?: "markdown" | "xml" | "text" | "json" | (string & {});
  readonly version?: string;
}

/**
 * Capabilities a formatter advertises to the runtime. Used by the loop
 * executor to pick a compatible formatter when the IR doesn't pin one.
 */
export interface FormatterCapabilities {
  readonly contentTypes?: readonly string[];
  readonly semanticTypes?: readonly SemanticType[];
  readonly outputFormats?: readonly string[];
  readonly streaming?: boolean;
}

/**
 * Why the formatter is being invoked. Drives format-specific defaults
 * (e.g., wrapping a section in `<section>` tags only when rendering for
 * the model context).
 */
export type FormatPurpose =
  | "context"
  | "message"
  | "section"
  | "free-root"
  | "resource"
  | "output";

/**
 * Pointer back to the IR entry whose content is being formatted. Carried
 * through into traces and diagnostics for debugging.
 */
export interface FormatSourceRef {
  readonly kind: "message" | "section" | "free-root" | "resource" | "output";
  readonly id?: string;
}

/**
 * Nested formatter switch. Allows a subtree of content to be rendered by
 * a different formatter (e.g., embed an XML island inside markdown).
 */
export interface FormatScope {
  readonly kind: "renderer-scope";
  readonly renderer: FormatterRef;
  readonly content: readonly FormattableContent[];
  readonly source?: FormatSourceRef;
  readonly options?: Record<string, unknown>;
}

/**
 * Anything the formatter accepts as input — a formattable block or a
 * scoped switch to another formatter.
 */
export type FormattableContent = SemanticContentBlock | FormatScope;

/**
 * Formatter input envelope.
 */
export interface FormatInput {
  readonly content: readonly FormattableContent[];
  readonly purpose: FormatPurpose;
  readonly source?: FormatSourceRef;
  readonly options?: Record<string, unknown>;
}

/**
 * Per-node trace of which formatter rendered which part of the tree.
 * Used by devtools and by the reconciler harness's `renderTrace` field.
 */
export interface FormatTrace {
  readonly renderer: FormatterRef;
  readonly source?: FormatSourceRef;
  readonly children?: readonly FormatTrace[];
  readonly metadata?: Record<string, unknown>;
}

/**
 * Single diagnostic emitted during formatting.
 */
export interface FormatDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly code?: string;
  readonly path?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Aggregate diagnostics bag (carried at the {@link RenderedTree} level).
 */
export interface FormatDiagnostics {
  readonly diagnostics: readonly FormatDiagnostic[];
}

/**
 * Direct output of the formatter harness. Inside a {@link RenderedTree},
 * the contribution is unpacked onto individual entries — `content` flows
 * into `MessageEntry.content` / `SectionEntry.content`; `text` / `mimeType`
 * / `renderedWith` are surfaced at the IR root for free-root rendering.
 */
export interface FormattedContent {
  readonly content: readonly ContentBlock[];
  readonly text?: string;
  readonly mimeType?: string;
  readonly renderedWith: FormatterRef;
  readonly renderTrace?: readonly FormatTrace[];
  readonly diagnostics?: readonly FormatDiagnostic[];
  readonly metadata?: Record<string, unknown>;
}

/**
 * Alias preserved for symmetry with the source proposals — `FormatResult`
 * and `FormattedContent` are the same shape; both names appear in the
 * blueprint and may be used interchangeably.
 */
export type FormatResult = FormattedContent;

// ============================================================================
// Formatter function
// ============================================================================

/**
 * Pure function that turns semantic content blocks into wire-ready
 * content blocks. Same shape as v1's `Formatter` (see
 * `packages/core/src/renderers/base.ts:8`) — the layer was proven there
 * and is preserved verbatim modulo v2's spec-firewall replacement of
 * `formatter: Formatter` on {@link SemanticNode} with `rendererRef: FormatterRef`.
 *
 * Implementations walk the input, resolve each block's `semanticNode`
 * subtree (when present), and emit wire-shape `ContentBlock[]`:
 *
 *   - Text/Reasoning blocks carrying a `semanticNode` → flattened TextBlock
 *     with the rendered string.
 *   - Native blocks (Image, Audio, Video, Document) → passed through.
 *   - Format-specific framing (markdown fences for CodeBlock, XML tags
 *     for table elements, etc.) is the formatter's call.
 *
 * Formatters are stateless. Middleware (caching, golden capture,
 * logging) composes via plain function wrappers — no harness needed.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D2
 * @see docs/proposals/v2/blueprint/04-formatters.md
 */
export type Formatter = (
  blocks: readonly SemanticContentBlock[],
) => readonly ContentBlock[];

/**
 * Identity metadata attached to a {@link Formatter} so it can be
 * registered + looked up via {@link FormatterRef}.
 *
 * `defineFormatter` ({@link `@agentick/reconciler-react`}) returns a
 * `Formatter` decorated with this metadata as non-enumerable properties.
 */
export interface FormatterIdentity {
  readonly id: string;
  readonly format: "markdown" | "xml" | "text" | "json" | (string & {});
  readonly version?: string;
}
