/**
 * `withReactPrompts()` — convenience over `withPrompts({ renderers: [reactPromptRenderer] })`.
 *
 * Use this when the adopter's prompt library is React-only. For
 * multi-framework libraries (e.g., React + Angular), use `withPrompts`
 * directly and pass the per-framework renderers explicitly.
 */

import type { SessionExtension } from "@agentick/spec-next";
import { withPrompts, type WithPromptsOptions } from "@agentick/prompts-next";

import { reactPromptRenderer } from "./renderer.js";

export interface WithReactPromptsOptions extends Omit<WithPromptsOptions, "renderers"> {
  /**
   * Extra renderers stacked on top of `reactPromptRenderer`. Use this
   * when registering domain-specific custom renderers alongside the
   * React default; for multi-framework libraries prefer `withPrompts`
   * directly so renderer ordering is explicit.
   */
  readonly extraRenderers?: WithPromptsOptions["renderers"];
}

export function withReactPrompts(options: WithReactPromptsOptions = {}): SessionExtension {
  const { extraRenderers, ...rest } = options;
  return withPrompts({
    ...rest,
    renderers: [reactPromptRenderer, ...(extraRenderers ?? [])],
  });
}
