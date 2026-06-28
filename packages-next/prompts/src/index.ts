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
