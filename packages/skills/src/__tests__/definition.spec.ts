/**
 * ADR 93 — `defineSkills`: identity, brand, inertness, and the DICHOTOMY the
 * `skills` slot accepts.
 *
 * Laws pinned here:
 *   - `defineSkills` is IDENTITY + BRAND — it returns its argument, stamped, and
 *     the brand is non-enumerable so the definition stays a plain data bag;
 *   - definitions are INERT until install: no harness, no store touch, no
 *     hydrator run at `defineSkills(...)` time;
 *   - the definition IS the options — the inline bag and the branded definition
 *     are the same type, and `withSkills` takes either;
 *   - the second arm is a LIVE INSTANCE, not a nested `use:` slot;
 *   - the slot is REGISTERED by this package (ADR 27), with the `toExtension`
 *     arm extension-installed namespaces need.
 */

import { describe, expect, it, vi } from "vitest";
import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  namespaceSlotExtensions,
  registeredNamespaceSlots,
  ulid,
} from "@agentick/runtime";
import type { Skill, SkillStoreQuery, Store, CollectionMutation } from "@agentick/spec";

import { SkillsHarness } from "../harness.js";
import { defineSkills, isSkillsDefinition } from "../definition.js";
import { hydrateFrom, hydrateFromStore } from "../hydrators.js";
import { withSkills } from "../extension.js";
// The slot registration is a side effect of the package's `augment.ts`.
import "../augment.js";

async function liveHarness(): Promise<SkillsHarness> {
  const h = new SkillsHarness(
    `test:${ulid()}`,
    new MemoryJournal({ capacity: 64 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await h.ready;
  return h;
}

describe("defineSkills — identity + brand", () => {
  it("returns the SAME object it was given", () => {
    const options = { registerModelTools: false as const };
    expect(defineSkills(options)).toBe(options);
  });

  it("stamps a brand that `isSkillsDefinition` recognizes", () => {
    expect(isSkillsDefinition(defineSkills({}))).toBe(true);
  });

  it("the brand is NON-ENUMERABLE — the definition stays a plain data bag", () => {
    const definition = defineSkills({ registerModelTools: false });
    expect(Object.keys(definition)).toEqual(["registerModelTools"]);
    expect({ ...definition }).toEqual({ registerModelTools: false });
    expect(JSON.parse(JSON.stringify(definition))).toEqual({ registerModelTools: false });
  });

  it("an INLINE bag is a valid definition and is NOT branded", () => {
    // Which is exactly why slot discrimination uses `isSkillsInstance`, not the
    // brand — the brand answers "was this named?", not "is this a definition?".
    expect(isSkillsDefinition({ registerModelTools: false })).toBe(false);
    expect(isSkillsDefinition(undefined)).toBe(false);
    expect(isSkillsDefinition(null)).toBe(false);
  });

  it("defineSkills() with no argument is a valid empty definition", () => {
    expect(isSkillsDefinition(defineSkills())).toBe(true);
  });
});

describe("defineSkills — INERTNESS (ADR 93 timing law)", () => {
  it("touches neither the store nor the hydrator", () => {
    const query = vi.fn(async () => []);
    const mutate = vi.fn(async () => {});
    const store: Store<Skill, SkillStoreQuery, CollectionMutation<Skill>> = {
      backend: "spy",
      query,
      mutate,
    };
    const hydrate = vi.fn(async () => []);

    defineSkills({ store, hydrate });

    expect(query).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("`withSkills(definition)` still constructs nothing — install does", async () => {
    const hydrate = vi.fn(async () => []);
    const extension = withSkills(defineSkills({ hydrate }));
    expect(extension).toMatchObject({ name: "@agentick/skills", target: "session" });
    expect(hydrate).not.toHaveBeenCalled();
  });
});

describe("the skills slot — the ADR-42 dichotomy, no third form", () => {
  it("takes a branded DEFINITION", () => {
    expect(withSkills(defineSkills({ hydrate: hydrateFrom([]) })).target).toBe("session");
  });

  it("takes the identical INLINE bag — the definition IS the options", () => {
    expect(withSkills({ hydrate: hydrateFrom([]) }).target).toBe("session");
  });

  it("takes a LIVE INSTANCE", async () => {
    const harness = await liveHarness();
    expect(withSkills(harness).target).toBe("session");
    await harness.close();
  });

  it("takes no argument at all", () => {
    expect(withSkills().target).toBe("session");
  });

  it("a definition is PORTABLE — a test overrides one slot of a production plan", () => {
    // The point of naming a definition: import the production plan, swap the
    // source, keep every policy seam.
    const production = defineSkills({ hydrate: hydrateFromStore(), registerModelTools: false });
    const underTest = defineSkills({
      ...production,
      hydrate: hydrateFrom([{ name: "fixture", description: "f", content: "f" }]),
    });
    expect(underTest.registerModelTools).toBe(false);
    expect(underTest.hydrate).not.toBe(production.hydrate);
  });
});

describe("the top-level `skills` slot registration (ADR 93 + ADR 27)", () => {
  it("this package lights the slot on import — the app names no namespace", () => {
    expect(registeredNamespaceSlots()).toContain("skills");
  });

  it("carries the `toExtension` arm, so a slot value mints its own install", () => {
    const definition = defineSkills({ hydrate: hydrateFrom([]) });
    const extensions = namespaceSlotExtensions({ skills: definition });
    expect(extensions).toHaveLength(1);
    expect(extensions[0]).toMatchObject({ name: "@agentick/skills", target: "session" });
  });

  it("an ABSENT slot mints nothing (the omitted-slot default survives)", () => {
    expect(namespaceSlotExtensions({})).toEqual([]);
  });
});
