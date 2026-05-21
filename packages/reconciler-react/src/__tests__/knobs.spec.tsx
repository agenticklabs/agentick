/**
 * `<Knobs />` — set_knob tool registration + model-facing section.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { HookBridges, LifecycleExecutionEnd, SectionEntry } from "@agentick/spec";

import { ReconcilerHarness } from "../harness/reconciler-harness.js";
import { inMemoryKnobBridge, stubBridges } from "../bridges/stub-bridges.js";
import { useKnob } from "../react/hooks/use-knob.js";
import { Knobs, executeSetKnob } from "../react/components/knobs.js";
import { flush } from "../testing/flush.js";

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

function textOf(content: readonly { text?: string }[]): string {
  return content.map((c) => c.text ?? "").join("");
}

// ============================================================================

describe("useKnob — descriptor registration", () => {
  it("registers a descriptor with description + options + valueType", async () => {
    const knobs = inMemoryKnobBridge();
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
    const knobs = inMemoryKnobBridge();
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
    const knobs = inMemoryKnobBridge();
    knobs.set("mood", "playful"); // Set BEFORE useKnob renders.
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
    const knobs = inMemoryKnobBridge();
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
    await flush();

    // Model fires the trigger.
    knobs.set("trigger", true);
    expect(knobs.get("trigger")).toBe(true);

    // Execution ends → momentary resets.
    const event: LifecycleExecutionEnd = {
      kind: "execution-end",
      executionId: "e1",
      outcome: "ok",
    };
    await harness.notifyLifecycle({ mountId: "m_mom", event });
    await flush();

    expect(knobs.get("trigger")).toBe(false);
  });

  it("does NOT reset non-momentary knobs", async () => {
    const knobs = inMemoryKnobBridge();
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
    await flush();

    knobs.set("mood", "decisive");
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
    const knobs = inMemoryKnobBridge();
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
    const knobs = inMemoryKnobBridge();
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

    // set_knob tool surfaces in declarations.
    const setKnobDecl = tree.declarations.tools.find((t) => t.name === "set_knob");
    expect(setKnobDecl).toBeTruthy();
  });

  it("hides inline knobs from the section", async () => {
    const knobs = inMemoryKnobBridge();
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
    const knobs = inMemoryKnobBridge();
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
    expect(tree.declarations.tools.some((t) => t.name === "set_knob")).toBe(true);
  });
});

// ============================================================================
// set_knob — validation + dispatch (pure function tests)
// ============================================================================
//
// The full tool-dispatch path goes through the executor; here we test
// the validation pipeline directly against the exported helper. The
// "section reflects model changes" integration check below covers the
// reactivity round-trip through useKnob + subscribeAll + <Knobs />.

function firstText(blocks: readonly { text?: string }[]): string {
  return blocks[0]?.text ?? "";
}

describe("executeSetKnob — argument validation", () => {
  it("rejects when both name and group are supplied", () => {
    const bridge = inMemoryKnobBridge();
    const result = executeSetKnob(bridge, { name: "a", group: "g", value: 1 });
    expect(firstText(result)).toMatch(/either name or group, not both/);
  });

  it("rejects when neither name nor group is supplied", () => {
    const bridge = inMemoryKnobBridge();
    const result = executeSetKnob(bridge, { value: 1 });
    expect(firstText(result)).toMatch(/Provide either name or group/);
  });

  it("rejects unknown knob name with the list of available ids", () => {
    const bridge = inMemoryKnobBridge();
    bridge.register("a", { defaultValue: 1, valueType: "number" });
    bridge.register("b", { defaultValue: 2, valueType: "number" });
    const result = executeSetKnob(bridge, { name: "missing", value: 3 });
    expect(firstText(result)).toMatch(/Unknown knob "missing"/);
    expect(firstText(result)).toMatch(/a, b/);
  });
});

describe("executeSetKnob — value validation", () => {
  it("rejects type mismatches", () => {
    const bridge = inMemoryKnobBridge();
    bridge.register("count", { defaultValue: 0, valueType: "number" });
    const result = executeSetKnob(bridge, { name: "count", value: "five" });
    expect(firstText(result)).toMatch(/Expected number, got string/);
    expect(bridge.get("count")).toBe(0);
  });

  it("rejects values outside the options whitelist", () => {
    const bridge = inMemoryKnobBridge();
    bridge.register("mood", {
      defaultValue: "curious",
      valueType: "string",
      options: ["curious", "decisive"],
    });
    const result = executeSetKnob(bridge, { name: "mood", value: "playful" });
    expect(firstText(result)).toMatch(/Valid options/);
    expect(bridge.get("mood")).toBe("curious");
  });

  it("rejects values below min", () => {
    const bridge = inMemoryKnobBridge();
    bridge.register("level", { defaultValue: 1, valueType: "number", min: 0 });
    const result = executeSetKnob(bridge, { name: "level", value: -5 });
    expect(firstText(result)).toMatch(/must be >= 0/);
  });

  it("rejects values above max", () => {
    const bridge = inMemoryKnobBridge();
    bridge.register("level", { defaultValue: 1, valueType: "number", max: 10 });
    const result = executeSetKnob(bridge, { name: "level", value: 100 });
    expect(firstText(result)).toMatch(/must be <= 10/);
  });

  it("rejects strings longer than maxLength", () => {
    const bridge = inMemoryKnobBridge();
    bridge.register("name", { defaultValue: "x", valueType: "string", maxLength: 3 });
    const result = executeSetKnob(bridge, { name: "name", value: "hello" });
    expect(firstText(result)).toMatch(/exceeds max length of 3/);
  });

  it("rejects strings that don't match pattern", () => {
    const bridge = inMemoryKnobBridge();
    bridge.register("slug", {
      defaultValue: "abc",
      valueType: "string",
      pattern: "^[a-z]+$",
    });
    const result = executeSetKnob(bridge, { name: "slug", value: "ABC123" });
    expect(firstText(result)).toMatch(/does not match pattern/);
  });

  it("runs custom validate() and surfaces its error message", () => {
    const bridge = inMemoryKnobBridge();
    bridge.register("port", {
      defaultValue: 8080,
      valueType: "number",
      validate: (v) => (typeof v === "number" && v % 2 === 0 ? true : "must be even"),
    });
    const result = executeSetKnob(bridge, { name: "port", value: 3001 });
    expect(firstText(result)).toMatch(/Validation failed for "port": must be even/);
  });

  it("commits the value on success and returns a confirmation", () => {
    const bridge = inMemoryKnobBridge();
    bridge.register("mood", {
      defaultValue: "curious",
      valueType: "string",
      options: ["curious", "decisive"],
    });
    const result = executeSetKnob(bridge, { name: "mood", value: "decisive" });
    expect(firstText(result)).toMatch(/Set mood to "decisive"/);
    expect(bridge.get("mood")).toBe("decisive");
  });
});

describe("executeSetKnob — group dispatch", () => {
  it("sets every knob in the group on success", () => {
    const bridge = inMemoryKnobBridge();
    bridge.register("a", { defaultValue: false, valueType: "boolean", group: "gates" });
    bridge.register("b", { defaultValue: false, valueType: "boolean", group: "gates" });
    bridge.register("c", { defaultValue: false, valueType: "boolean", group: "other" });
    const result = executeSetKnob(bridge, { group: "gates", value: true });
    expect(firstText(result)).toMatch(/Set 2 knobs in group "gates"/);
    expect(bridge.get("a")).toBe(true);
    expect(bridge.get("b")).toBe(true);
    expect(bridge.get("c")).toBe(false);
  });

  it("rejects when no knobs in the group", () => {
    const bridge = inMemoryKnobBridge();
    bridge.register("a", { defaultValue: 1, valueType: "number" });
    const result = executeSetKnob(bridge, { group: "missing", value: 2 });
    expect(firstText(result)).toMatch(/No knobs found in group "missing"/);
  });

  it("rejects on type mismatch within the group", () => {
    const bridge = inMemoryKnobBridge();
    bridge.register("a", { defaultValue: 1, valueType: "number", group: "mixed" });
    bridge.register("b", { defaultValue: "x", valueType: "string", group: "mixed" });
    const result = executeSetKnob(bridge, { group: "mixed", value: 1 });
    expect(firstText(result)).toMatch(/Type mismatch in group "mixed"/);
    expect(bridge.get("b")).toBe("x");
  });
});

// ============================================================================
// Reactivity round-trip
// ============================================================================

describe("<Knobs /> — reactivity", () => {
  it("section reflects external knob mutations after subscribeAll fires", async () => {
    const knobs = inMemoryKnobBridge();
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

    // Simulate set_knob tool firing externally: bridge.set updates the
    // value, subscribeAll fires, <Knobs /> re-renders.
    knobs.set("mood", "decisive");
    await flush();

    const r2 = await harness.renderTree({ mountId: "m_dispatch", sessionId: "s" });
    expect(textOf(sectionOf(r2.tree, "knobs")!.content)).toContain('mood [select]: "decisive"');
  });
});
