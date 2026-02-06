/**
 * Knob Tests
 *
 * Tests for knob() descriptor, isKnob() guard, useKnob() hook, and <Knobs /> component.
 */

import { describe, it, expect } from "vitest";
import { knob, isKnob, useKnob, Knobs } from "../../hooks";
import { createApp } from "../../app";
import { Model } from "../../jsx/components/primitives";
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
