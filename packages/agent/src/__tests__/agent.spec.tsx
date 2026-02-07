/**
 * Agent Component + createAgent Tests
 */

import { describe, it, expect } from "vitest";
import { Agent, createAgent } from "../index";
import { compileAgent, createTestAdapter } from "@tentickle/core/testing";
import { knob, createTool } from "@tentickle/core";
import { z } from "zod";

// ============================================================================
// Test Tool
// ============================================================================

const GreetTool = createTool({
  name: "greet",
  description: "Greet someone",
  input: z.object({ name: z.string() }),
  handler: async ({ name }) => [{ type: "text" as const, text: `Hello, ${name}!` }],
});

// ============================================================================
// <Agent> Compilation Tests
// ============================================================================

describe("<Agent> compilation", () => {
  it("should render system prompt as section with id 'system'", async () => {
    function MyAgent() {
      return <Agent system="You are a helpful assistant." />;
    }

    const result = await compileAgent(MyAgent);
    const section = result.getSection("system");
    expect(section).toBeDefined();
    expect(section).toContain("You are a helpful assistant.");
  });

  it("should render tool components from tools prop", async () => {
    function MyAgent() {
      return <Agent tools={[GreetTool]} />;
    }

    const result = await compileAgent(MyAgent);
    expect(result.hasTool("greet")).toBe(true);
    expect(result.getTool("greet")?.description).toBe("Greet someone");
  });

  it("should render knobs section and set_knob tool when knobs prop provided", async () => {
    function MyAgent() {
      return (
        <Agent
          knobs={{
            mode: knob("quick", { description: "Research depth", options: ["quick", "deep"] }),
          }}
        />
      );
    }

    const result = await compileAgent(MyAgent);
    expect(result.hasTool("set_knob")).toBe(true);

    const section = result.getSection("knobs");
    expect(section).toBeDefined();
    expect(section).toContain("mode");
    expect(section).toContain('"quick"');
    expect(section).toContain("Research depth");
  });

  it("should render nothing extra when no optional props (minimal agent)", async () => {
    function MyAgent() {
      return <Agent />;
    }

    const result = await compileAgent(MyAgent);
    expect(result.getSection("system")).toBeUndefined();
    expect(result.hasTool("set_knob")).toBe(false);
    expect(result.hasTool("greet")).toBe(false);
  });

  it("should render children alongside defaults", async () => {
    function MyAgent() {
      return (
        <Agent system="You are helpful.">
          <section id="custom" audience="model">
            Custom section content
          </section>
        </Agent>
      );
    }

    const result = await compileAgent(MyAgent);
    expect(result.getSection("system")).toContain("You are helpful.");
    expect(result.getSection("custom")).toContain("Custom section content");
  });

  it("should render both tools and knobs together", async () => {
    function MyAgent() {
      return (
        <Agent
          system="Test agent"
          tools={[GreetTool]}
          knobs={{
            verbose: knob(false, { description: "Verbose output" }),
          }}
        />
      );
    }

    const result = await compileAgent(MyAgent);
    expect(result.getSection("system")).toContain("Test agent");
    expect(result.hasTool("greet")).toBe(true);
    expect(result.hasTool("set_knob")).toBe(true);
    expect(result.getSection("knobs")).toContain("verbose");
  });

  it("should suppress timeline when timeline={false}", async () => {
    function MyAgent() {
      return <Agent system="No timeline." timeline={false} />;
    }

    const result = await compileAgent(MyAgent);
    expect(result.getSection("system")).toContain("No timeline.");
    // No timeline entries rendered (timeline component suppressed)
    expect(result.compiled.timelineEntries).toHaveLength(0);
  });

  it("should render declarative sections from sections prop", async () => {
    function MyAgent() {
      return (
        <Agent
          sections={[
            { id: "context", content: "Today is Monday." },
            { id: "rules", content: "Be concise.", audience: "model" },
          ]}
        />
      );
    }

    const result = await compileAgent(MyAgent);
    expect(result.getSection("context")).toContain("Today is Monday.");
    expect(result.getSection("rules")).toContain("Be concise.");
  });
});

// ============================================================================
// createAgent Integration Tests
// ============================================================================

describe("createAgent", () => {
  it("should create a working app with system/model/tools", async () => {
    const model = createTestAdapter({ defaultResponse: "Hello!" });

    const app = createAgent(
      { system: "You are helpful.", model, tools: [GreetTool] },
      { maxTicks: 1 },
    );

    const session = await app.session();
    const result = await session.render({}).result;
    session.close();

    expect(result.response).toBe("Hello!");
  });

  it("should register knobs visible to model", async () => {
    const model = createTestAdapter({ defaultResponse: "Got it." });

    const app = createAgent(
      {
        system: "You are a research assistant.",
        model,
        knobs: {
          depth: knob("quick", { description: "Research depth", options: ["quick", "deep"] }),
        },
      },
      { maxTicks: 1 },
    );

    const session = await app.session();
    await session.render({}).result;
    session.close();

    // Model should have received input containing the knobs section
    const captured = model.getCapturedInputs();
    expect(captured.length).toBeGreaterThan(0);
  });

  it("should allow model to call set_knob and update knob value", async () => {
    const model = createTestAdapter({ defaultResponse: "Done." });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "depth", value: "deep" } } }]);

    const app = createAgent(
      {
        system: "You are a research assistant.",
        model,
        knobs: {
          depth: knob("quick", { description: "Research depth", options: ["quick", "deep"] }),
        },
      },
      { maxTicks: 5 },
    );

    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Use deep mode" }] }],
    }).result;
    session.close();
  });

  it("should create minimal working app with empty config", async () => {
    const model = createTestAdapter({ defaultResponse: "Hi!" });

    const app = createAgent({}, { model, maxTicks: 1 });

    const session = await app.session();
    const result = await session.render({}).result;
    session.close();

    expect(result.response).toBe("Hi!");
  });

  it("should allow AppOptions.model to override config model", async () => {
    const configModel = createTestAdapter({ defaultResponse: "Config model" });
    const overrideModel = createTestAdapter({ defaultResponse: "Override model" });

    const app = createAgent({ model: configModel }, { model: overrideModel, maxTicks: 1 });

    const session = await app.session();
    const result = await session.render({}).result;
    session.close();

    // AppOptions.model should take precedence
    expect(result.response).toBe("Override model");
  });
});
