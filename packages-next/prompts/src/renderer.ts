/**
 * `PromptRenderer` — pluggable content → MessageEntry[] projection.
 *
 * The prompts harness handles two content shapes natively:
 *  - `string`              → wrapped as a single `system` MessageEntry
 *  - `readonly MessageEntry[]` → used as-is
 *
 * Anything else (React JSX, Solid JSX, custom IR shapes) flows through
 * a `PromptRenderer`. Each renderer advertises which content shapes it
 * handles via the `handles` predicate; the harness dispatches to the
 * first matching renderer. Framework bindings (e.g.,
 * `@agentick/prompts-react-next`) ship their own renderer + a
 * convenience `withXPrompts()` extension that pre-registers it.
 *
 * Adopters wanting cross-framework prompts in one library construct
 * `withPrompts({ renderers: [reactPromptRenderer, angularPromptRenderer, ...] })`.
 */

import type { MessageEntry } from "@agentick/spec-next";

export interface PromptRenderer {
  /**
   * Diagnostic-friendly name (e.g., `"react"`, `"angular"`). Surfaces
   * in error messages when dispatch fails.
   */
  readonly name: string;
  /**
   * Predicate: does this renderer handle the given content shape?
   * Called for every prompt content the harness can't handle
   * natively. First-match-wins; renderers should be specific.
   */
  handles(content: unknown): boolean;
  /**
   * Render the content to MessageEntry[]. Receives the args used at
   * invoke (already validated against the prompt's argument schemas).
   * Throw to fail the invocation with `PromptRenderFailed`.
   */
  render(
    content: unknown,
    args: Readonly<Record<string, unknown>>,
  ): Promise<readonly MessageEntry[]>;
}

// ─────────── Built-in native content handlers ───────────

/**
 * `true` iff `value` is `readonly MessageEntry[]` — a literal array
 * where every element is a `{ kind: "message", role, content }` object.
 */
export function isMessageEntryArray(value: unknown): value is readonly MessageEntry[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      (e as { kind?: unknown }).kind === "message" &&
      typeof (e as { role?: unknown }).role === "string" &&
      Array.isArray((e as { content?: unknown }).content),
  );
}

/**
 * Wrap loose text as a single `system`-role MessageEntry. Used by
 * the harness when a prompt's content is a bare string.
 */
export function stringToSystemMessage(text: string): MessageEntry {
  return {
    kind: "message",
    role: "system",
    content: [{ type: "text", text }],
  };
}
