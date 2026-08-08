/**
 * ADR 93 — `definePrompts`: identity, brand, inertness, and the DICHOTOMY the
 * `prompts` slot accepts.
 *
 * Laws pinned here:
 *   - `definePrompts` is IDENTITY + BRAND — it returns its argument, stamped, and
 *     the brand is non-enumerable so the definition stays a plain data bag;
 *   - definitions are INERT until install: no harness, no store touch, no
 *     hydrator run at `definePrompts(...)` time;
 *   - the definition IS the options — the inline bag and the branded definition
 *     are the same type, and `withPrompts` takes either;
 *   - the second arm is a LIVE INSTANCE, not a nested `use:` slot;
 *   - the slot is REGISTERED by this package (ADR 27), with the `toExtension` arm
 *     extension-installed namespaces need;
 *   - `store` EXISTS here (ADR 93 rendered-moot #4 — the asymmetry with skills is
 *     over).
 */

import { describe, expect, it, vi } from "vitest";
import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  namespaceSlotExtensions,
  registeredNamespaceSlots,
  generateId,
} from "@agentick/runtime";
import type {
  CollectionMutation,
  PromptDeclarationRecord,
  PromptStoreQuery,
  Store,
} from "@agentick/spec";

import { PromptsHarness } from "../harness.js";
import { definePrompts, isPromptsDefinition } from "../definition.js";
import { hydrateFrom, hydrateFromStore } from "../hydrators.js";
import { withPrompts } from "../extension.js";
// The slot registration is a side effect of the package's `augment.ts`.
import "../augment.js";

async function liveHarness(): Promise<PromptsHarness> {
  const h = new PromptsHarness(
    `test:${generateId()}`,
    new MemoryJournal({ capacity: 64 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await h.ready;
  return h;
}

describe("definePrompts — identity + brand", () => {
  it("returns the SAME object it was given", () => {
    const options = { exposeAsResources: false as const };
    expect(definePrompts(options)).toBe(options);
  });

  it("stamps a brand that `isPromptsDefinition` recognizes", () => {
    expect(isPromptsDefinition(definePrompts({}))).toBe(true);
  });

  it("the brand is NON-ENUMERABLE — the definition stays a plain data bag", () => {
    const definition = definePrompts({ exposeAsResources: false });
    expect(Object.keys(definition)).toEqual(["exposeAsResources"]);
    expect({ ...definition }).toEqual({ exposeAsResources: false });
    expect(JSON.parse(JSON.stringify(definition))).toEqual({ exposeAsResources: false });
  });

  it("an INLINE bag is a valid definition and is NOT branded", () => {
    expect(isPromptsDefinition({ exposeAsResources: false })).toBe(false);
    expect(isPromptsDefinition(undefined)).toBe(false);
    expect(isPromptsDefinition(null)).toBe(false);
  });

  it("definePrompts() with no argument is a valid empty definition", () => {
    expect(isPromptsDefinition(definePrompts())).toBe(true);
  });
});

describe("definePrompts — INERTNESS (ADR 93 timing law)", () => {
  it("touches neither the store nor the hydrator", () => {
    const query = vi.fn(async () => []);
    const mutate = vi.fn(async () => {});
    const store: Store<
      PromptDeclarationRecord,
      PromptStoreQuery,
      CollectionMutation<PromptDeclarationRecord>
    > = { backend: "spy", query, mutate };
    const hydrate = vi.fn(async () => []);

    definePrompts({ store, hydrate });

    expect(query).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("`withPrompts(definition)` still constructs nothing — install does", () => {
    const hydrate = vi.fn(async () => []);
    const extension = withPrompts(definePrompts({ hydrate }));
    expect(extension).toMatchObject({ name: "@agentick/prompts", target: "session" });
    expect(hydrate).not.toHaveBeenCalled();
  });
});

describe("the prompts slot — the ADR-42 dichotomy, no third form", () => {
  it("takes a branded DEFINITION", () => {
    expect(withPrompts(definePrompts({ hydrate: hydrateFrom([]) })).target).toBe("session");
  });

  it("takes the identical INLINE bag — the definition IS the options", () => {
    expect(withPrompts({ hydrate: hydrateFrom([]) }).target).toBe("session");
  });

  it("takes a LIVE INSTANCE", async () => {
    const harness = await liveHarness();
    expect(withPrompts(harness).target).toBe("session");
    await harness.close();
  });

  it("takes no argument at all", () => {
    expect(withPrompts().target).toBe("session");
  });
});

describe("the store-option asymmetry is over (ADR 93 rendered-moot #4)", () => {
  it("`store` is part of the prompts definition, exactly as it is for skills", async () => {
    const { InMemoryPromptStore } = await import("../store.js");
    const store = new InMemoryPromptStore();
    const definition = definePrompts({ store, hydrate: hydrateFromStore() });
    expect(definition.store).toBe(store);
    // And it reaches the harness through the one options shape.
    const h = new PromptsHarness(
      `test:${generateId()}`,
      new MemoryJournal({ capacity: 64 }),
      new LocalEventBus(),
      new LocalInbox(),
      definition,
    );
    await h.ready;
    await h.register({ declaration: { name: "p", description: "P", template: "t" } });
    expect((await store.list(undefined, {} as never)).map((r) => r.name)).toEqual(["p"]);
    await h.close();
  });
});

describe("the top-level `prompts` slot registration (ADR 93 + ADR 27)", () => {
  it("this package lights the slot on import — the app names no namespace", () => {
    expect(registeredNamespaceSlots()).toContain("prompts");
  });

  it("carries the `toExtension` arm, so a slot value mints its own install", () => {
    const definition = definePrompts({ hydrate: hydrateFrom([]) });
    const extensions = namespaceSlotExtensions({ prompts: definition });
    expect(extensions).toHaveLength(1);
    expect(extensions[0]).toMatchObject({ name: "@agentick/prompts", target: "session" });
  });

  it("an ABSENT slot mints nothing (the omitted-slot default survives)", () => {
    expect(namespaceSlotExtensions({})).toEqual([]);
  });
});
