/**
 * `SkillsHandle` — the user-facing surface of the skills harness as
 * exposed on `session.skills`.
 *
 * Curated subset of {@link SkillsHarnessProtocol}: hides `id`,
 * `ready`, `close`, snapshot import/export. Adopters read, register,
 * update, remove, search, and subscribe.
 *
 * Structural subset — no runtime wrapping. The harness class IS a
 * structural `SkillsHandle` because it satisfies the same method
 * shape.
 *
 * @see ./augment.ts (module augmentation onto `SessionHarnessProtocol`)
 */

import type {
  Skill,
  SkillsRegisterInput,
  SkillsRemoveInput,
  SkillsSearchInput,
  SkillsUpdateInput,
  Unsubscribe,
} from "@agentick/spec-next";

export interface SkillsHandle {
  get(name: string): Skill | undefined;
  has(name: string): boolean;
  list(): readonly Skill[];
  search(input: SkillsSearchInput): readonly Skill[];
  register(input: SkillsRegisterInput): Promise<Skill>;
  update(input: SkillsUpdateInput): Promise<Skill>;
  remove(input: SkillsRemoveInput): Promise<void>;
  subscribe(name: string, listener: () => void): Unsubscribe;
  subscribeAll(listener: () => void): Unsubscribe;
}
