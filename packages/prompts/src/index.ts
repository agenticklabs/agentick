/**
 * `@agentick/prompts` — durable parameterized prompt library
 * harness. Per ADR 32 Shape 1.
 *
 * The core handles two content shapes natively:
 *   - `string` → wrapped as a single `system`-role MessageEntry
 *   - `readonly MessageEntry[]` → used as-is
 *
 * Framework-specific content (React JSX, Solid JSX, etc.) flows through
 * pluggable `PromptRenderer` instances. The React binding lives at
 * `@agentick/prompts-react` and ships `reactPromptRenderer` +
 * `withReactPrompts()`.
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 */

// Side-effect import — registers `bridges.prompts` + `session.prompts`
// slots via TypeScript module augmentation.
import "./augment.js";

export { PromptsHarness, type PromptsHarnessOptions } from "./harness.js";
export type { PromptsHandle } from "./handle.js";
export { withPrompts, type WithPromptsOptions } from "./extension.js";
// ADR 93 — the namespace definition: the store (the asymmetry with skills is
// over), the genesis seam, this namespace's shaping seams, and the `hooks:` /
// `guards:` bags. One object for both `createApp({ prompts })` and
// `withPrompts(...)`.
export {
  definePrompts,
  isPromptsDefinition,
  type BrandedPromptsDefinition,
  type PromptSeed,
  type PromptsConfig,
  type PromptsDefinition,
  type PromptsHydrateCtx,
  type PromptsHydrator,
  type PromptsStore,
} from "./definition.js";
// The named hydrators — the genesis-seam library, and the ONE source vocabulary.
// Narrower than skills' by design: only a module import carries a prompt's
// `render` function across a load boundary.
export {
  composeHydrators,
  hydrateFrom,
  hydrateFromModule,
  hydrateFromStaticUrl,
  hydrateFromStore,
  type HydrateFromModuleOptions,
  type HydrateFromStaticUrlOptions,
} from "./hydrators.js";
// `prompt://<name>` projection (three-audiences-plan §0) — the uniform-addressing
// door onto the prompt catalog. Wired by `withPrompts`. Content served honestly:
// string template as text, else a declaration document (never a serialized fn).
export { promptUri, wirePromptProjection } from "./projection.js";
export { isMessageEntryArray, stringToSystemMessage, type PromptRenderer } from "./renderer.js";
// Store archetype (data-layer plan §6-C — the definition-library archetype's
// first AUGMENTED instance: skills' pure record PLUS a non-serializable
// `{ template, render }` sidecar). The bundled in-memory default holds the
// serializable `PromptDeclarationRecord` slice only; the `PromptStore` /
// `PromptStoreQuery` ports live in `@agentick/spec`. A durable adapter
// conforms to the SAME port later.
export { InMemoryPromptStore, matchesPromptQuery } from "./store.js";
