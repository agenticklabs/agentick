/**
 * `@agentick/prompts-react` — React binding for the Prompts harness.
 *
 * Pairs with `@agentick/prompts`. The core handles `string` and
 * `MessageEntry[]` content natively; this binding adds a renderer for
 * React JSX. Co-existence with other framework renderers is supported
 * via `withPrompts({ renderers: [reactPromptRenderer, ...others] })`.
 */

export {
  createReactPromptRenderer,
  reactPromptRenderer,
  type ReactPromptRendererOptions,
} from "./renderer.js";
export { withReactPrompts, type WithReactPromptsOptions } from "./extension.js";
