/**
 * `@agentick/skills/testing` — stub factory for tests.
 *
 * Per ADR 27, each harness package ships its own `/testing` subpath
 * with a stub factory. Adopters compose their test bridges by
 * importing from each harness's testing subpath.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type { SkillsRegisterInput } from "@agentick/spec";

import { SkillsHarness } from "../harness.js";

/**
 * Build a {@link SkillsHarness} with its own in-memory substrate
 * (journal/bus/inbox). `initial` seeds skills via the async
 * `register` path so adopters writing tests can preload a known
 * skill library.
 */
export async function stubSkillsHarness(
  initial: readonly SkillsRegisterInput[] = [],
): Promise<SkillsHarness> {
  const harness = new SkillsHarness(
    `stub:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  for (const skill of initial) {
    await harness.register(skill);
  }
  return harness;
}
