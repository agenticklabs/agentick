/**
 * Knob Tests
 *
 * Tests for knob() descriptor, isKnob() guard, useKnob() hook, and <Knobs /> component.
 */

import { describe, it, expect } from "vitest";
import {
  knob,
  isKnob,
  useKnob,
  Knobs,
  useKnobsContext,
  type KnobGroup,
  type KnobInfo,
} from "../../hooks";
import { createApp } from "../../app";
import { Model } from "../../jsx/components/primitives";
import { Section } from "../../jsx/components/primitives";
import { Timeline } from "../../jsx/components/timeline";
import { createTestAdapter } from "../../testing";
import { compileAgent } from "../../testing";
import { useContinuation } from "../../hooks";

// ============================================================================
// knob() Descriptor Tests
// ============================================================================

describe("knob()", () => {
  it("should return a branded descriptor detectable by isKnob()", () => {
    const desc = knob("broad", { description: "Operating mode" });
    expect(isKnob(desc)).toBe(true);
  });

  it("should infer correct valueType from defaultValue", () => {
    expect(knob("hello", { description: "s" }).valueType).toBe("string");
    expect(knob(42, { description: "n" }).valueType).toBe("number");
    expect(knob(true, { description: "b" }).valueType).toBe("boolean");
  });

  it("should store description, options, and default", () => {
    const desc = knob("gpt-4", { description: "Model to use", options: ["gpt-4", "gpt-5"] });
    expect(desc.description).toBe("Model to use");
    expect(desc.options).toEqual(["gpt-4", "gpt-5"]);
    expect(desc.defaultValue).toBe("gpt-4");
  });

  it("should store resolve callback", () => {
    const resolve = (v: string) => ({ model: v });
    const desc = knob("gpt-4", { description: "Model" }, resolve);
    expect(desc.resolve).toBe(resolve);
  });

  it("should not detect plain values as knobs", () => {
    expect(isKnob("foo")).toBe(false);
    expect(isKnob(42)).toBe(false);
    expect(isKnob(null)).toBe(false);
    expect(isKnob(undefined)).toBe(false);
    expect(isKnob({})).toBe(false);
  });

  it("should carry number constraints (min, max, step)", () => {
    const desc = knob(0.7, { description: "Temperature", min: 0, max: 2, step: 0.1 });
    expect(desc.min).toBe(0);
    expect(desc.max).toBe(2);
    expect(desc.step).toBe(0.1);
  });

  it("should carry string constraints (maxLength, pattern)", () => {
    const desc = knob("abc", { description: "Code", maxLength: 10, pattern: "^[a-z]+$" });
    expect(desc.maxLength).toBe(10);
    expect(desc.pattern).toBe("^[a-z]+$");
  });

  it("should carry group and required", () => {
    const desc = knob("quick", { description: "Mode", group: "Behavior", required: true });
    expect(desc.group).toBe("Behavior");
    expect(desc.required).toBe(true);
  });

  it("should carry custom validate function", () => {
    const validate = (v: string) => (v.length > 0 ? (true as const) : "Cannot be empty");
    const desc = knob("hello", { description: "Name", validate });
    expect(desc.validate).toBe(validate);
  });
});

// ============================================================================
// useKnob() + <Knobs /> Compilation Tests
// ============================================================================

describe("useKnob + Knobs (compilation)", () => {
  it("should render knob section with name, value, and description", async () => {
    function Agent() {
      useKnob("mode", "broad", { description: "Operating mode", options: ["broad", "deep"] });
      return <Knobs />;
    }

    const result = await compileAgent(Agent);
    expect(result.hasTool("set_knob")).toBe(true);

    const section = result.getSection("knobs");
    expect(section).toBeDefined();
    expect(section).toContain("mode");
    expect(section).toContain('"broad"');
    expect(section).toContain("Operating mode");
    expect(section).toContain('"deep"');
  });

  it("should register set_knob tool when knobs exist", async () => {
    function Agent() {
      useKnob("temperature", 0.7, { description: "Sampling temperature" });
      return <Knobs />;
    }

    const result = await compileAgent(Agent);
    expect(result.hasTool("set_knob")).toBe(true);
    expect(result.getTool("set_knob")?.description).toContain("Set a knob value");
  });

  it("should handle multiple knobs in one section and one tool", async () => {
    function Agent() {
      useKnob("mode", "broad", { description: "Operating mode", options: ["broad", "deep"] });
      useKnob("verbose", true, { description: "Verbose output" });
      return <Knobs />;
    }

    const result = await compileAgent(Agent);
    const section = result.getSection("knobs");
    expect(section).toContain("mode");
    expect(section).toContain("verbose");
    expect(section).toContain("true");
    expect(result.tools.filter((t) => t.name === "set_knob")).toHaveLength(1);
  });

  it("should render nothing when no knobs are registered", async () => {
    function Agent() {
      return <Knobs />;
    }

    const result = await compileAgent(Agent);
    expect(result.hasTool("set_knob")).toBe(false);
    expect(result.getSection("knobs")).toBeUndefined();
  });

  it("should render semantic type labels", async () => {
    function Agent() {
      useKnob("verbose", true, { description: "Verbose" });
      useKnob("temp", 0.7, { description: "Temperature", min: 0, max: 2 });
      useKnob("count", 5, { description: "Count" });
      useKnob("mode", "quick", { description: "Mode", options: ["quick", "deep"] });
      useKnob("name", "test", { description: "Name" });
      return <Knobs />;
    }

    const result = await compileAgent(Agent);
    const section = result.getSection("knobs")!;
    expect(section).toContain("[toggle]");
    expect(section).toContain("[range]");
    expect(section).toContain("[number]");
    expect(section).toContain("[select]");
    expect(section).toContain("[text]");
  });

  it("should render constraint hints in the section", async () => {
    function Agent() {
      useKnob("temp", 0.7, { description: "Temperature", min: 0, max: 2, step: 0.1 });
      useKnob("code", "abc", { description: "Code", maxLength: 10, pattern: "^[a-z]+$" });
      return <Knobs />;
    }

    const result = await compileAgent(Agent);
    const section = result.getSection("knobs")!;
    expect(section).toContain("0 - 2");
    expect(section).toContain("step 0.1");
    expect(section).toContain("max 10 chars");
    expect(section).toContain("pattern: ^[a-z]+$");
  });

  it("should group knobs with headers", async () => {
    function Agent() {
      useKnob("temp", 0.7, { description: "Temperature", group: "Model", min: 0, max: 2 });
      useKnob("mode", "quick", {
        description: "Mode",
        group: "Behavior",
        options: ["quick", "deep"],
      });
      useKnob("ungrouped", true, { description: "A toggle" });
      return <Knobs />;
    }

    const result = await compileAgent(Agent);
    const section = result.getSection("knobs")!;
    expect(section).toContain("### Model");
    expect(section).toContain("### Behavior");
    // Ungrouped knob should appear without a group header
    expect(section).toContain("ungrouped [toggle]");
  });
});

// ============================================================================
// useKnob() Integration Tests (with createApp + createTestAdapter)
// ============================================================================

describe("useKnob integration", () => {
  it("should return [value, setter] tuple", async () => {
    let capturedValue: string | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });

    function Agent() {
      const [mode] = useKnob("mode", "broad", { description: "Operating mode" });
      capturedValue = mode;

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.render({}).result;
    session.close();

    expect(capturedValue).toBe("broad");
  });

  it("should update value when model calls set_knob", async () => {
    let capturedValue: string | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "mode", value: "deep" } } }]);

    function Agent() {
      const [mode] = useKnob("mode", "broad", {
        description: "Operating mode",
        options: ["broad", "deep"],
      });
      capturedValue = mode;

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Set mode" }] }],
    }).result;
    session.close();

    expect(capturedValue).toBe("deep");
  });

  it("should reject invalid option values", async () => {
    let toolResultText: string | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "mode", value: "invalid" } } }]);

    function Agent() {
      useKnob("mode", "broad", { description: "Operating mode", options: ["broad", "deep"] });

      useContinuation((result) => {
        if (result.toolResults.length > 0) {
          const content = result.toolResults[0].content;
          if (content?.[0]?.type === "text") {
            toolResultText = content[0].text;
          }
        }
        return false;
      });

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
    }).result;
    session.close();

    expect(toolResultText).toContain("Invalid value");
    expect(toolResultText).toContain('"broad"');
    expect(toolResultText).toContain('"deep"');
  });

  it("should resolve values through callback", async () => {
    let resolvedValue: { name: string } | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });

    function Agent() {
      const [item] = useKnob(
        "model",
        "gpt-4",
        { description: "Model to use", options: ["gpt-4", "gpt-5"] },
        (v) => ({ name: v }),
      );
      resolvedValue = item;

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.render({}).result;
    session.close();

    expect(resolvedValue).toEqual({ name: "gpt-4" });
  });

  it("should resolve default primitive on init", async () => {
    let resolvedOnInit: number | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });

    function Agent() {
      const [temp] = useKnob("temp", 0.7, { description: "Temperature" }, (v) => v * 100);
      resolvedOnInit = temp;

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.render({}).result;
    session.close();

    expect(resolvedOnInit).toBe(70);
  });

  it("should accept a KnobDescriptor as second argument", async () => {
    let capturedValue: string | undefined;

    const modeDescriptor = knob("broad", {
      description: "Operating mode",
      options: ["broad", "deep"],
    });

    const model = createTestAdapter({ defaultResponse: "Done" });

    function Agent() {
      const [mode] = useKnob("mode", modeDescriptor);
      capturedValue = mode;

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.render({}).result;
    session.close();

    expect(capturedValue).toBe("broad");
  });

  it("should reject values below min", async () => {
    let toolResultText: string | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "temp", value: -1 } } }]);

    function Agent() {
      useKnob("temp", 0.7, { description: "Temperature", min: 0, max: 2 });

      useContinuation((result) => {
        if (result.toolResults.length > 0) {
          const content = result.toolResults[0].content;
          if (content?.[0]?.type === "text") toolResultText = content[0].text;
        }
        return false;
      });

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
    }).result;
    session.close();

    expect(toolResultText).toContain(">= 0");
  });

  it("should reject values above max", async () => {
    let toolResultText: string | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "temp", value: 5 } } }]);

    function Agent() {
      useKnob("temp", 0.7, { description: "Temperature", min: 0, max: 2 });

      useContinuation((result) => {
        if (result.toolResults.length > 0) {
          const content = result.toolResults[0].content;
          if (content?.[0]?.type === "text") toolResultText = content[0].text;
        }
        return false;
      });

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
    }).result;
    session.close();

    expect(toolResultText).toContain("<= 2");
  });

  it("should reject strings exceeding maxLength", async () => {
    let toolResultText: string | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([
      { tool: { name: "set_knob", input: { name: "code", value: "toolongstring" } } },
    ]);

    function Agent() {
      useKnob("code", "abc", { description: "Code", maxLength: 5 });

      useContinuation((result) => {
        if (result.toolResults.length > 0) {
          const content = result.toolResults[0].content;
          if (content?.[0]?.type === "text") toolResultText = content[0].text;
        }
        return false;
      });

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
    }).result;
    session.close();

    expect(toolResultText).toContain("max length");
    expect(toolResultText).toContain("5");
  });

  it("should reject strings not matching pattern", async () => {
    let toolResultText: string | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "code", value: "ABC123" } } }]);

    function Agent() {
      useKnob("code", "abc", { description: "Code", pattern: "^[a-z]+$" });

      useContinuation((result) => {
        if (result.toolResults.length > 0) {
          const content = result.toolResults[0].content;
          if (content?.[0]?.type === "text") toolResultText = content[0].text;
        }
        return false;
      });

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
    }).result;
    session.close();

    expect(toolResultText).toContain("pattern");
  });

  it("should reject values failing custom validate", async () => {
    let toolResultText: string | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "name", value: "bad" } } }]);

    function Agent() {
      useKnob("name", "good", {
        description: "Name",
        validate: (v) => (v !== "bad" ? true : "Value cannot be 'bad'"),
      });

      useContinuation((result) => {
        if (result.toolResults.length > 0) {
          const content = result.toolResults[0].content;
          if (content?.[0]?.type === "text") toolResultText = content[0].text;
        }
        return false;
      });

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
    }).result;
    session.close();

    expect(toolResultText).toContain("Value cannot be 'bad'");
  });

  it("should accept valid constrained values", async () => {
    let capturedValue: number | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "temp", value: 1.5 } } }]);

    function Agent() {
      const [temp] = useKnob("temp", 0.7, { description: "Temperature", min: 0, max: 2 });
      capturedValue = temp;

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
    }).result;
    session.close();

    expect(capturedValue).toBe(1.5);
  });

  it("should provide a working setter", async () => {
    let setterCalled = false;

    const model = createTestAdapter({ defaultResponse: "Done" });

    function Agent() {
      const [mode, setMode] = useKnob("mode", "broad", {
        description: "Operating mode",
        options: ["broad", "deep"],
      });

      // Programmatic set on mount
      if (mode === "broad" && !setterCalled) {
        setMode("deep");
        setterCalled = true;
      }

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.render({}).result;
    session.close();

    expect(setterCalled).toBe(true);
  });
});

// ============================================================================
// Knobs Provider Pattern Tests
// ============================================================================

describe("Knobs render prop", () => {
  it("should render custom section via render prop + register tool", async () => {
    function Agent() {
      useKnob("mode", "broad", { description: "Operating mode", options: ["broad", "deep"] });
      return (
        <Knobs>
          {(groups) => (
            <Section id="custom-knobs" audience="model">
              {`Custom: ${groups
                .flatMap((g) => g.knobs)
                .map((k) => k.name)
                .join(", ")}`}
            </Section>
          )}
        </Knobs>
      );
    }

    const result = await compileAgent(Agent);
    expect(result.hasTool("set_knob")).toBe(true);
    // Custom section should appear, not the default "knobs" section
    const customSection = result.getSection("custom-knobs");
    expect(customSection).toBeDefined();
    expect(customSection).toContain("Custom: mode");
    expect(result.getSection("knobs")).toBeUndefined();
  });

  it("should pass grouped data to render prop", async () => {
    let receivedGroups: KnobGroup[] = [];

    function Agent() {
      useKnob("temp", 0.7, { description: "Temperature", group: "Model", min: 0, max: 2 });
      useKnob("verbose", true, { description: "Verbose output" });
      return (
        <Knobs>
          {(groups) => {
            receivedGroups = groups;
            return (
              <Section id="custom-knobs" audience="model">
                {groups.map((g) => `${g.name || "ungrouped"}:${g.knobs.length}`).join(",")}
              </Section>
            );
          }}
        </Knobs>
      );
    }

    await compileAgent(Agent);
    expect(receivedGroups).toHaveLength(2);
    // Ungrouped first
    expect(receivedGroups[0].name).toBe("");
    expect(receivedGroups[0].knobs[0].name).toBe("verbose");
    expect(receivedGroups[0].knobs[0].semanticType).toBe("toggle");
    // Then grouped
    expect(receivedGroups[1].name).toBe("Model");
    expect(receivedGroups[1].knobs[0].name).toBe("temp");
    expect(receivedGroups[1].knobs[0].semanticType).toBe("range");
  });
});

describe("Knobs.Provider + Controls", () => {
  it("should render default section via Knobs.Controls", async () => {
    function Agent() {
      useKnob("mode", "broad", { description: "Operating mode", options: ["broad", "deep"] });
      return (
        <Knobs.Provider>
          <Knobs.Controls />
        </Knobs.Provider>
      );
    }

    const result = await compileAgent(Agent);
    expect(result.hasTool("set_knob")).toBe(true);
    const section = result.getSection("knobs");
    expect(section).toBeDefined();
    expect(section).toContain("mode");
    expect(section).toContain('"broad"');
  });

  it("should support custom renderKnob in Controls", async () => {
    function Agent() {
      useKnob("mode", "broad", { description: "Operating mode" });
      useKnob("verbose", true, { description: "Verbose" });
      return (
        <Knobs.Provider>
          <Knobs.Controls
            renderKnob={(knob: KnobInfo) => (
              <Section id={`knob-${knob.name}`} audience="model">
                {`${knob.name}=${knob.value}`}
              </Section>
            )}
          />
        </Knobs.Provider>
      );
    }

    const result = await compileAgent(Agent);
    expect(result.hasTool("set_knob")).toBe(true);
    expect(result.getSection("knob-mode")).toContain("mode=broad");
    expect(result.getSection("knob-verbose")).toContain("verbose=true");
    // No default "knobs" section
    expect(result.getSection("knobs")).toBeUndefined();
  });

  it("should support custom renderGroup in Controls", async () => {
    function Agent() {
      useKnob("temp", 0.7, { description: "Temperature", group: "Model" });
      useKnob("verbose", true, { description: "Verbose" });
      return (
        <Knobs.Provider>
          <Knobs.Controls
            renderGroup={(group: KnobGroup) => (
              <Section id={`group-${group.name || "default"}`} audience="model">
                {`${group.name || "ungrouped"}:${group.knobs.map((k) => k.name).join(",")}`}
              </Section>
            )}
          />
        </Knobs.Provider>
      );
    }

    const result = await compileAgent(Agent);
    expect(result.getSection("group-default")).toContain("ungrouped:verbose");
    expect(result.getSection("group-Model")).toContain("Model:temp");
  });

  it("should expose knob data via useKnobsContext", async () => {
    let contextData: { knobs: KnobInfo[]; groups: KnobGroup[] } | null = null;

    function KnobConsumer() {
      const ctx = useKnobsContext();
      contextData = { knobs: ctx.knobs, groups: ctx.groups };
      return (
        <Section id="consumer" audience="model">
          {`Found ${ctx.knobs.length} knobs, mode=${ctx.get("mode")?.value}`}
        </Section>
      );
    }

    function Agent() {
      useKnob("mode", "broad", { description: "Operating mode", options: ["broad", "deep"] });
      useKnob("verbose", true, { description: "Verbose" });
      return (
        <Knobs.Provider>
          <KnobConsumer />
        </Knobs.Provider>
      );
    }

    const result = await compileAgent(Agent);
    expect(result.hasTool("set_knob")).toBe(true);
    expect(contextData).not.toBeNull();
    expect(contextData!.knobs).toHaveLength(2);
    expect(contextData!.knobs[0].name).toBe("mode");
    expect(contextData!.groups.length).toBeGreaterThan(0);

    const section = result.getSection("consumer");
    expect(section).toContain("Found 2 knobs");
    expect(section).toContain("mode=broad");
  });

  it("should render children with no tool/context when no knobs exist", async () => {
    function Agent() {
      return (
        <Knobs.Provider>
          <Section id="child" audience="model">
            Hello
          </Section>
        </Knobs.Provider>
      );
    }

    const result = await compileAgent(Agent);
    expect(result.hasTool("set_knob")).toBe(false);
    expect(result.getSection("child")).toContain("Hello");
  });
});

describe("Knobs provider integration", () => {
  it("should allow set_knob to work with render prop mode", async () => {
    let capturedValue: string | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "mode", value: "deep" } } }]);

    function Agent() {
      const [mode] = useKnob("mode", "broad", {
        description: "Operating mode",
        options: ["broad", "deep"],
      });
      capturedValue = mode;

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs>
            {(groups) => (
              <Section id="custom-knobs" audience="model">
                {groups
                  .flatMap((g) => g.knobs)
                  .map((k) => `${k.name}=${k.value}`)
                  .join(", ")}
              </Section>
            )}
          </Knobs>
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Set mode" }] }],
    }).result;
    session.close();

    expect(capturedValue).toBe("deep");
  });

  it("should allow set_knob to work with Provider mode", async () => {
    let capturedValue: string | undefined;

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "mode", value: "deep" } } }]);

    function Agent() {
      const [mode] = useKnob("mode", "broad", {
        description: "Operating mode",
        options: ["broad", "deep"],
      });
      capturedValue = mode;

      return (
        <>
          <Model model={model} />
          <Timeline />
          <Knobs.Provider>
            <Knobs.Controls />
          </Knobs.Provider>
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Set mode" }] }],
    }).result;
    session.close();

    expect(capturedValue).toBe("deep");
  });
});
