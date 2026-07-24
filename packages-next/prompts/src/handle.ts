/**
 * `PromptsHandle` — user-facing surface of the prompts harness on
 * `session.prompts`. Curated subset of `PromptsHarnessProtocol`:
 * hides `id`, `ready`, `close`, snapshot import/export.
 *
 * @see ./augment.ts (module augmentation onto SessionHarnessProtocol)
 */

import type {
  PromptDeclaration,
  PromptsGetInput,
  PromptsGetResult,
  PromptsInvokeInput,
  PromptsRegisterInput,
  PromptsRemoveInput,
  PromptsUpdateInput,
  Unsubscribe,
} from "@agentick/spec-next";

export interface PromptsHandle {
  /** Look up a prompt declaration by name (sync family-grammar `get`). */
  get(name: string): PromptDeclaration | undefined;
  has(name: string): boolean;
  list(): readonly PromptDeclaration[];
  register(input: PromptsRegisterInput): Promise<PromptDeclaration>;
  update(input: PromptsUpdateInput): Promise<PromptDeclaration>;
  remove(input: PromptsRemoveInput): Promise<void>;
  invoke(input: PromptsInvokeInput): Promise<PromptsGetResult>;
  /** Render a prompt to messages WITHOUT queueing (the async render). */
  render(input: PromptsGetInput): Promise<PromptsGetResult>;
  subscribe(name: string, listener: () => void): Unsubscribe;
  subscribeAll(listener: () => void): Unsubscribe;

  /**
   * Re-run configured loaders, diff against current state, apply
   * adds + updates (and removes when `pruneMissing: true`).
   */
  reload(opts?: { pruneMissing?: boolean }): Promise<{
    readonly added: readonly string[];
    readonly updated: readonly string[];
    readonly removed: readonly string[];
  }>;

  /**
   * Lookup-on-miss read: returns the registered declaration if
   * present; otherwise asks each configured loader (and registers
   * the first hit). `null` if no source has the name. Note that
   * `invoke()` and `get()` already perform this lookup
   * transparently on cache miss — call `resolve()` directly when you
   * want the declaration without invoking it.
   */
  resolve(name: string): Promise<PromptDeclaration | null>;

  /**
   * Throw-on-miss sister of {@link resolve}. Same lookup path; throws
   * a `PromptNotFound`-tagged error when no source has the name. Use
   * when missing is a programming error (must-exist contract), not a
   * domain case. For "render this prompt" use `invoke()` — it
   * already throws `PromptNotFound` on miss.
   */
  require(name: string): Promise<PromptDeclaration>;
}
