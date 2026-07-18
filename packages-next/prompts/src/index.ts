/**
 * `@agentick/prompts-next` — durable parameterized prompt library
 * harness. Per ADR 32 Shape 1.
 *
 * The core handles two content shapes natively:
 *   - `string` → wrapped as a single `system`-role MessageEntry
 *   - `readonly MessageEntry[]` → used as-is
 *
 * Framework-specific content (React JSX, Solid JSX, etc.) flows through
 * pluggable `PromptRenderer` instances. The React binding lives at
 * `@agentick/prompts-react-next` and ships `reactPromptRenderer` +
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
export { isMessageEntryArray, stringToSystemMessage, type PromptRenderer } from "./renderer.js";
// Store archetype (data-layer plan §6-C — the definition-library archetype's
// first AUGMENTED instance: skills' pure record PLUS a non-serializable
// `{ template, render }` sidecar). The bundled in-memory default holds the
// serializable `PromptDeclarationRecord` slice only; the `PromptStore` /
// `PromptStoreQuery` ports live in `@agentick/spec-next`. A durable adapter
// conforms to the SAME port later.
export { InMemoryPromptStore, matchesPromptQuery } from "./store.js";
export {
  runPromptStoreConformance,
  type PromptStoreConformanceOptions,
} from "./store-conformance.js";
