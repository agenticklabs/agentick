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
  getDeclaration(name: string): PromptDeclaration | undefined;
  has(name: string): boolean;
  list(): readonly PromptDeclaration[];
  register(input: PromptsRegisterInput): Promise<PromptDeclaration>;
  update(input: PromptsUpdateInput): Promise<PromptDeclaration>;
  remove(input: PromptsRemoveInput): Promise<void>;
  invoke(input: PromptsInvokeInput): Promise<PromptsGetResult>;
  get(input: PromptsGetInput): Promise<PromptsGetResult>;
  subscribe(name: string, listener: () => void): Unsubscribe;
  subscribeAll(listener: () => void): Unsubscribe;
}
