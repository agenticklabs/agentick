/**
 * `@agentick/formatters-next` — reference content formatters for Agentick v2.
 *
 * Three pure functions that turn `SemanticContentBlock[]` (the
 * reconciler's intermediate IR after the collect walker, with semantic
 * sidecars on each block) into wire-ready `ContentBlock[]` for the model.
 *
 *   - {@link markdownFormatter} — DEFAULT
 *   - {@link xmlFormatter}
 *   - {@link textFormatter}
 *
 * Custom formatters compose via {@link defineFormatter}.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D2
 */

export {
  defineFormatter,
  refOf,
  type DefineFormatterInput,
  type DefinedFormatter,
} from "./define-formatter.js";

export { markdownFormatter } from "./markdown.js";
export { xmlFormatter } from "./xml.js";
export { textFormatter } from "./text.js";

import { markdownFormatter as md } from "./markdown.js";
import { xmlFormatter as xml } from "./xml.js";
import { textFormatter as txt } from "./text.js";
import type { DefinedFormatter } from "./define-formatter.js";

/**
 * Built-in formatter registry. Pass into `ReconcilerHarnessOptions.formatters`
 * to enable the reference set; markdown is the default lookup key.
 */
export function builtInFormatters(): ReadonlyMap<string, DefinedFormatter> {
  return new Map<string, DefinedFormatter>([
    [md.__identity.id, md],
    [xml.__identity.id, xml],
    [txt.__identity.id, txt],
  ]);
}
