/**
 * @agentick/completions — argument completion as a first-class seam.
 *
 * A registry of `name → resolver` bindings plus one `resolve` door, and the
 * `complete*` sugar family for authoring the resolvers. It owns no data:
 * candidates come from wherever they already live (a tenant DB, a store, a
 * static list). `resolve` deliberately mints NO journaled operation — completion
 * fires per keystroke and is an ephemeral query, not a thing that happened.
 *
 * ```ts
 * import { defineCompletions, completeDependent, completeFromAsync } from "@agentick/completions";
 *
 * export default defineCompletions({
 *   sources: {
 *     "knowify.jobs": completeFromAsync((value, ctx) => jobsApi.search(value, ctx)),
 *     "knowify.phases": completeDependent({ requires: ["job"] }, (v, { job }) =>
 *       phasesApi.search(v, job)),
 *   },
 * });
 * ```
 *
 * @see docs/proposals/v2/completions.md
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

// Side-effect import — registers the `completions` slot on `HookBridges`,
// `NamespaceSlots`, `SessionHarnessProtocol`, and `ToolHandlerCtxExtensions` via
// TypeScript module augmentation. Per ADR 27, every harness package owns its own
// slot declaration.
import "./augment.js";

export { CompletionsHarness, type CompletionsHarnessOptions } from "./harness.js";
export { withCompletions, type WithCompletionsOptions } from "./extension.js";
export {
  defineCompletion,
  defineCompletions,
  isCompletionsDefinition,
  isNamedCompletionResolver,
  sourcesMapOf,
  type BrandedCompletionsDefinition,
  type CompletionSources,
  type CompletionsConfig,
  type CompletionsDefinition,
  type NamedCompletionResolver,
} from "./definition.js";
export {
  completeDependent,
  completeFromAsync,
  completeFromEnum,
  completeFromList,
  completePrefixMatch,
  isDependentResolver,
  normalizeCompletionResult,
  type DependentCompletionResolver,
} from "./builders.js";
