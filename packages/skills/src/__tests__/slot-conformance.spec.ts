/**
 * `withSkills` slot conformance via `runHarnessSlotConformance` —
 * ADR 42 Slice 4 (#267). Verifies the executable rows of the audit
 * checklist (rows 1, 2, 3 + the row-7 rejection paths) against the
 * skills slot.
 *
 * Companion to the detailed `slot-trichotomy.spec.ts` — the
 * conformance helper provides a uniform suite across packages; the
 * detailed spec covers skills-specific edge cases (alternative config
 * shapes, the `loaders` field, etc.).
 *
 * Closes the executable side of #267; rows 4/5/6 of the audit are
 * static / docs concerns verified by the @verifiedBy citations on
 * `Skills` (spec-next) + the README §"The withSkills slot — three
 * accepted shapes" + the SessionHarnessProtocol.skills getter.
 */

import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";

import { runHarnessSlotConformance } from "@agentick/spec-conformance";

import { SkillsHarness } from "../harness.js";
import { fromArray } from "../loaders.js";
import { resolveSlot, withSkills, type WithSkillsOptions } from "../extension.js";
import type { Skills, SkillsRegisterInput } from "@agentick/spec";

runHarnessSlotConformance<Skills, SkillsRegisterInput, WithSkillsOptions>({
  name: "@agentick/skills withSkills",
  resolveSlot,
  factory: withSkills,
  makeDeclaration: () => ({ name: "x", description: "x", content: "x" }),
  makeInstance: async () => {
    const harness = new SkillsHarness(
      `test:${ulid()}`,
      new MemoryJournal({ capacity: 64 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;
    return { instance: harness, close: () => harness.close() };
  },
  shorthandKey: "initial",
  useConflicts: ["initial", "loaders"],
  useConflictSamples: {
    initial: [{ name: "x", description: "x", content: "x" }],
    loaders: [fromArray([{ name: "x", description: "x", content: "x" }])],
  },
});
