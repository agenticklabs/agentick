/**
 * `CompletionsHarness` — the conformance suite against the real harness, plus
 * the two claims that are specific to THIS implementation and cannot live in a
 * protocol-level suite:
 *
 *   - **`resolve` journals nothing.** The reason completion is not a tool
 *     (completions.md §5, refutation 1). Asserted against the fake's journal.
 *   - **the definition / extension dichotomy** — `defineCompletions` is identity
 *     + brand, `withCompletions` installs either arm.
 */

import { describe, expect, it, vi } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { isCompletionsInstance } from "@agentick/spec";

import { CompletionsHarness } from "../harness.js";
import { defineCompletions, isCompletionsDefinition } from "../definition.js";
import { withCompletions } from "../extension.js";
import { completeFromList } from "../builders.js";
import { fakeCompletions } from "../testing/fake-completions.js";
import { stubCompletions } from "../testing/stub-completions.js";
import { runCompletionsHarnessConformance } from "../conformance.js";

runCompletionsHarnessConformance("CompletionsHarness", async ({ harnessId, sessionId }) => {
  const journal = new MemoryJournal();
  const harness = new CompletionsHarness(
    harnessId,
    journal,
    new LocalEventBus(),
    new LocalInbox(),
    { parentScope: { sessionId } },
  );
  await harness.ready;
  return { harness, close: () => harness.close() };
});

describe("CompletionsHarness — resolve is not an operation", () => {
  it("writes NOTHING to the journal, however many times it runs", async () => {
    const { harness, journal, close } = await fakeCompletions();
    harness.register("jobs", completeFromList(["Miller", "Milton", "Nguyen"]));

    // One resolve per keystroke, the real usage shape.
    for (const typed of ["M", "Mi", "Mil"]) {
      const r = await harness.resolve("jobs", { value: typed });
      expect(r.values.length).toBeGreaterThan(0);
    }

    expect(journal.totalAppended()).toBe(0);
    await close();
  });
});

describe("defineCompletions", () => {
  it("is identity + brand — the same options back, brand non-enumerable", () => {
    const options = { sources: { "a.b": completeFromList(["x"]) } };
    const defined = defineCompletions(options);
    expect(defined).toBe(options);
    expect(isCompletionsDefinition(defined)).toBe(true);
    expect(Object.keys(defined)).toEqual(["sources"]);
  });

  it("an inline bag is a valid definition and is NOT branded", () => {
    expect(isCompletionsDefinition({ sources: { "a.b": completeFromList(["x"]) } })).toBe(false);
  });

  it("a definition is not mistaken for a live instance", () => {
    expect(
      isCompletionsInstance(defineCompletions({ sources: { "a.b": completeFromList(["x"]) } })),
    ).toBe(false);
    expect(isCompletionsInstance(stubCompletions())).toBe(true);
  });
});

describe("withCompletions", () => {
  /** Minimal installer surface the extension touches. */
  function spyInstaller(): {
    readonly installer: Parameters<ReturnType<typeof withCompletions>["install"]>[0];
    readonly namespaces: Map<string, unknown>;
    readonly closers: (() => void)[];
  } {
    const namespaces = new Map<string, unknown>();
    const closers: (() => void)[] = [];
    const installer = {
      hostId: "host-1",
      sessionId: "session-1",
      substrate: {
        journal: new MemoryJournal(),
        bus: new LocalEventBus(),
        inbox: new LocalInbox(),
      },
      registerNamespace: (name: string, value: unknown) => namespaces.set(name, value),
      onClose: (fn: () => void) => closers.push(fn),
    } as unknown as Parameters<ReturnType<typeof withCompletions>["install"]>[0];
    return { installer, namespaces, closers };
  }

  it("definition arm — constructs a harness, binds the map, owns teardown", async () => {
    const { installer, namespaces, closers } = spyInstaller();
    await withCompletions({ sources: { "knowify.jobs": completeFromList(["Miller"]) } }).install(
      installer,
    );

    const harness = namespaces.get("completions") as CompletionsHarness;
    expect(harness).toBeInstanceOf(CompletionsHarness);
    expect(harness.list()).toEqual(["knowify.jobs"]);
    expect(await harness.resolve("knowify.jobs", { value: "Mil" })).toEqual({
      values: ["Miller"],
    });
    // The resolver's ctx carries the installing session's scope.
    expect(closers).toHaveLength(1);
    await harness.close();
  });

  it("live-instance arm — registers the adopter's instance and does NOT close it", async () => {
    const { installer, namespaces, closers } = spyInstaller();
    const adopterOwned = stubCompletions({ values: { "a.b": ["x"] } });
    const close = vi.spyOn(adopterOwned, "close");

    await withCompletions(adopterOwned).install(installer);

    expect(namespaces.get("completions")).toBe(adopterOwned);
    expect(closers).toHaveLength(0);
    expect(close).not.toHaveBeenCalled();
  });

  it("threads the session scope onto the resolver ctx", async () => {
    const { installer, namespaces } = spyInstaller();
    let seenSessionId: string | undefined;
    await withCompletions({
      sources: {
        probe: (_value, ctx) => {
          seenSessionId = ctx.sessionId;
          return [];
        },
      },
    }).install(installer);

    const harness = namespaces.get("completions") as CompletionsHarness;
    await harness.resolve("probe", { value: "" });
    expect(seenSessionId).toBe("session-1");
    await harness.close();
  });
});
