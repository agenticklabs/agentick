/**
 * `@agentick/formatters` — reference content formatters for Agentick v2.
 *
 * Three pure functions that turn `SemanticContentBlock[]` (the
 * compiler's intermediate IR after the collect walker, with semantic
 * sidecars on each block) into wire-ready `ContentBlock[]` for the model.
 *
 *   - {@link markdownFormatter} — DEFAULT
 *   - {@link xmlFormatter}
 *   - {@link textFormatter}
 *
 * Custom formatters compose via {@link createFormatter}.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D2
 * @see docs/proposals/v2/blueprint/36-define-vs-create-convention.md
 */

export {
  createFormatter,
  refOf,
  type CreateFormatterInput,
  type DefinedFormatter,
} from "./create-formatter.js";

export { markdownFormatter } from "./markdown.js";
export { xmlFormatter } from "./xml.js";
export { textFormatter } from "./text.js";

// The ONE section → content-blocks lowering (ADR 94). A `<Section>` is
// content, not an entry: the compiler calls this for a section inside a
// message AND for a free-floating one (which becomes an anonymous
// `grounding` message wrapping exactly these blocks).
export {
  lowerSection,
  sectionTagName,
  SECTION_STAMP,
  type SectionSource,
} from "./section-lowering.js";

// Content-reduction policies (v2 home of v1's connector content-pipeline).
export {
  textOnlyFormatter,
  summarizedFormatter,
  createSummarizedFormatter,
  createToolSummarizer,
  type ToolSummarizer,
} from "./content-policy.js";

// Tree-level IR → string serialization. The single entry point for
// "I have a RenderedTree, give me the final formatted string."
// Both `CompilerHarness.renderToString` and
// `@agentick/compiler-react`'s `renderTemplate` should
// delegate here.
export { formatTree } from "./format-tree.js";
export type { FormatTreeOptions } from "./format-tree.js";

// The single `FormatterRef → DefinedFormatter` lookup, shared by `formatTree`
// and by the compiler harness's per-entry formatter pass. Reports HOW it
// matched so callers with a diagnostics channel can surface an unresolvable
// ref instead of silently rendering in the wrong format.
export {
  describeUnresolvedFormatter,
  resolveFormatterRef,
  type FormatterMatch,
  type FormatterResolution,
} from "./resolve-formatter.js";

import { markdownFormatter as md } from "./markdown.js";
import { xmlFormatter as xml } from "./xml.js";
import { textFormatter as txt } from "./text.js";
import type { DefinedFormatter } from "./create-formatter.js";

/**
 * Built-in formatter registry. Pass into `CompilerHarnessOptions.formatters`
 * to enable the reference set; markdown is the default lookup key.
 */
export function builtInFormatters(): ReadonlyMap<string, DefinedFormatter> {
  return new Map<string, DefinedFormatter>([
    [md.__identity.id, md],
    [xml.__identity.id, xml],
    [txt.__identity.id, txt],
  ]);
}
