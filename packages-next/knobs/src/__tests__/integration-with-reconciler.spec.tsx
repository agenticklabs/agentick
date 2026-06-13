/**
 * `<Knobs />` and `useKnob` integration against the KnobsHarness.
 *
 * Per ADR 26, knobs is a full harness. Bridge-level validation tests
 * live in `@agentick/knobs-next/src/__tests__/harness.spec.ts` (conformance
 * suite + concrete behavior). The tests here cover the reconciler-side
 * integration: useKnob's descriptor registration, momentary reset
 * semantics via lifecycle, `<Knobs />` section rendering, and the
 * set_knob tool round-trip.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { extractText } from "@agentick/spec-next";
import type { HookBridges, LifecycleExecutionEnd, SectionEntry } from "@agentick/spec-next";

import { ReconcilerHarness } from "@agentick/reconciler-react-next";
import { stubBridges, mockKnobsHarness } from "@agentick/reconciler-next";
import { useKnob } from "@agentick/knobs-next/react";
import { Knobs } from "@agentick/knobs-next/react";
import { flush } from "@agentick/reconciler-react-next/testing";

async function makeHarness() {
  const harness = new ReconcilerHarness(
    "h_knobs",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

function sectionOf(
  tree: { context: { entries: readonly { kind: string }[] } },
  id: string,
): SectionEntry | undefined {
  return tree.context.entries.find(
    (e): e is SectionEntry => e.kind === "section" && (e as SectionEntry).id === id,
  );
}

// Local alias for the canonical `extractText` so call sites still read
// `textOf(section.content)`. Use the canonical helper directly in new
// tests.
const textOf = extractText;

// ============================================================================

describe("useKnob — descriptor registration", () => {
  it("registers a descriptor with description + options + valueType", async () => {
    const knobs = mockKnobsHarness();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();

    function App() {
      useKnob<string>("mood", "curious", {
        description: "Agent mood",
        options: ["curious", "decisive", "playful"],
        group: "personality",
      });
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_reg",
      sessionId: "s",
      element: React.createElement(App),
      bridges,
    });
    await harness.renderTree({ mountId: "m_reg", sessionId: "s" });

    const list = knobs.list();
    const mood = list.find((k) => k.id === "mood");
    expect(mood).toMatchObject({
      id: "mood",
      value: "curious",
      description: "Agent mood",
      valueType: "string",
      options: ["curious", "decisive", "playful"],
      group: "personality",
    });
  });

  it("infers valueType from initial when not explicit", async () => {
    const knobs = mockKnobsHarness();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();

    function App() {
      useKnob("verbose", false);
      useKnob("limit", 10);
      useKnob("name", "x");
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_inf",
      sessionId: "s",
      element: React.createElement(App),
      bridges,
    });
    await harness.renderTree({ mountId: "m_inf", sessionId: "s" });

    const list = knobs.list();
    expect(list.find((k) => k.id === "verbose")?.valueType).toBe("boolean");
    expect(list.find((k) => k.id === "limit")?.valueType).toBe("number");
    expect(list.find((k) => k.id === "name")?.valueType).toBe("string");
  });

  it("preserves an existing value on re-registration", async () => {
    const knobs = mockKnobsHarness();
    await knobs.set({ id: "mood", value: "playful" }); // Set BEFORE useKnob renders.
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();

    function App() {
      useKnob<string>("mood", "curious");
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_pres",
      sessionId: "s",
      element: React.createElement(App),
      bridges,
    });
    await harness.renderTree({ mountId: "m_pres", sessionId: "s" });

    expect(knobs.get("mood")).toBe("playful");
  });
});

describe("useKnob — momentary semantics", () => {
  it("resets value to initial at execution-end when momentary", async () => {
    const knobs = mockKnobsHarness();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();

    function App() {
      useKnob<boolean>("trigger", false, { momentary: true });
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_mom",
      sessionId: "s",
      element: React.createElement(App),
      bridges,
    });
    await harness.renderTree({ mountId: "m_mom", sessionId: "s" });

    // Model fires the trigger.
    await knobs.set({ id: "trigger", value: true });
    expect(knobs.get("trigger")).toBe(true);

    // Execution ends → momentary resets via useOnExecutionEnd handler.
    const event: LifecycleExecutionEnd = {
      kind: "execution-end",
      executionId: "e1",
      outcome: "ok",
    };
    await harness.notifyLifecycle({ mountId: "m_mom", event });
    await flush();
    // The momentary handler fires `void knobs.set(...)`; let the
    // Operation resolve.
    await new Promise((r) => setImmediate(r));
    expect(knobs.get("trigger")).toBe(false);
  });

  it("does NOT reset non-momentary knobs", async () => {
    const knobs = mockKnobsHarness();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();

    function App() {
      useKnob<string>("mood", "curious");
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_per",
      sessionId: "s",
      element: React.createElement(App),
      bridges,
    });
    await harness.renderTree({ mountId: "m_per", sessionId: "s" });

    await knobs.set({ id: "mood", value: "decisive" });
    await harness.notifyLifecycle({
      mountId: "m_per",
      event: { kind: "execution-end", executionId: "e1", outcome: "ok" },
    });
    await flush();
    expect(knobs.get("mood")).toBe("decisive");
  });
});

// ============================================================================
// <Knobs /> — section rendering
// ============================================================================

describe("<Knobs /> — default rendering", () => {
  it("returns null when no knobs are registered", async () => {
    const knobs = mockKnobsHarness();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();

    await harness.mount({
      mountId: "m_empty",
      sessionId: "s",
      element: React.createElement(Knobs),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_empty", sessionId: "s" });
    expect(tree.context.entries).toEqual([]);
  });

  it("renders the knobs section + set_knob tool when knobs are registered", async () => {
    const knobs = mockKnobsHarness();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();

    function App() {
      useKnob<string>("mood", "curious", {
        description: "Agent mood",
        options: ["curious", "decisive"],
      });
      useKnob<boolean>("verbose", false, {
        description: "Verbose output",
        group: "output",
      });
      return React.createElement(Knobs);
    }

    await harness.mount({
      mountId: "m_render",
      sessionId: "s",
      element: React.createElement(App),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_render", sessionId: "s" });

    const section = sectionOf(tree, "knobs");
    expect(section).toBeTruthy();
    const text = textOf(section!.content);
    expect(text).toContain("set_knob tool");
    expect(text).toContain("mood [select]");
    expect(text).toContain('"curious"');
    expect(text).toContain("Agent mood");
    expect(text).toContain('options: "curious", "decisive"');
    expect(text).toContain("### output");
    expect(text).toContain("verbose [toggle]");

    const setKnobDecl = tree.declarations?.tools?.find((t) => t.name === "set_knob");
    expect(setKnobDecl).toBeTruthy();
  });

  it("hides inline knobs from the section", async () => {
    const knobs = mockKnobsHarness();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();

    function App() {
      useKnob<string>("visible", "x", { description: "Visible knob" });
      useKnob<string>("hidden", "y", { description: "Hidden knob", inline: true });
      return React.createElement(Knobs);
    }

    await harness.mount({
      mountId: "m_inline",
      sessionId: "s",
      element: React.createElement(App),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_inline", sessionId: "s" });

    const text = textOf(sectionOf(tree, "knobs")!.content);
    expect(text).toContain("visible");
    expect(text).not.toContain("hidden [");
    expect(text).toContain("Inline knobs");
  });
});

describe("<Knobs /> — render prop", () => {
  it("delegates section rendering to the children function", async () => {
    const knobs = mockKnobsHarness();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();

    function App() {
      useKnob<boolean>("verbose", false);
      return React.createElement(Knobs, {
        children: (groups) =>
          React.createElement(
            "section" as never,
            { id: "custom-knobs", title: "Custom" },
            `Got ${groups.flatMap((g) => g.knobs).length} knob(s)`,
          ),
      });
    }

    await harness.mount({
      mountId: "m_rp",
      sessionId: "s",
      element: React.createElement(App),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_rp", sessionId: "s" });

    const custom = sectionOf(tree, "custom-knobs");
    expect(custom).toBeTruthy();
    expect(textOf(custom!.content)).toBe("Got 1 knob(s)");
    expect(sectionOf(tree, "knobs")).toBeUndefined();
    expect(tree.declarations?.tools?.some((t) => t.name === "set_knob")).toBe(true);
  });
});

describe("<Knobs /> — reactivity", () => {
  it("section reflects external knob mutations after subscribeAll fires", async () => {
    const knobs = mockKnobsHarness();
    const bridges: HookBridges = { ...stubBridges(), knobs };
    const harness = await makeHarness();

    function App() {
      useKnob<string>("mood", "curious", {
        description: "Agent mood",
        options: ["curious", "decisive"],
      });
      return React.createElement(Knobs);
    }

    await harness.mount({
      mountId: "m_dispatch",
      sessionId: "s",
      element: React.createElement(App),
      bridges,
    });
    const r1 = await harness.renderTree({ mountId: "m_dispatch", sessionId: "s" });
    expect(textOf(sectionOf(r1.tree, "knobs")!.content)).toContain('mood [select]: "curious"');

    // Simulate external mutation (set_knob tool firing).
    await knobs.set({ id: "mood", value: "decisive" });
    await flush();

    const r2 = await harness.renderTree({ mountId: "m_dispatch", sessionId: "s" });
    expect(textOf(sectionOf(r2.tree, "knobs")!.content)).toContain('mood [select]: "decisive"');
  });
});
