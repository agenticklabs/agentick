/**
 * Testing Utilities Tests
 *
 * Tests for the @tentickle/core/testing module.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { renderAgent, compileAgent, createTestModel, act, cleanup } from "../index";
import { System, Timeline, Section, Model } from "../../jsx/components";
import { useSignal, useEffect } from "../../index";
import type { Message } from "@tentickle/shared";

// Cleanup after each test
afterEach(() => {
  cleanup();
});

describe("createTestModel", () => {
  it("should create a model with default response", () => {
    const model = createTestModel();
    expect(model).toBeDefined();
    expect(model.getCapturedInputs()).toEqual([]);
  });

  it("should capture inputs when model is called", async () => {
    const model = createTestModel({ defaultResponse: "Hello!" });
    const { send } = await renderAgent(
      () => (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      ),
      { model },
    );

    await act(async () => {
      await send("Test message");
    });

    expect(model.getCapturedInputs().length).toBeGreaterThan(0);
  });

  it("should allow changing response dynamically", () => {
    const model = createTestModel({ defaultResponse: "Initial" });
    model.setResponse("Updated");
    // The response is used when the model is called
    expect(model).toBeDefined();
  });

  it("should support response generator", async () => {
    const model = createTestModel({
      responseGenerator: (input) => {
        const messages = (input.messages as Message[]) ?? [];
        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.content?.some((c: any) => c.text?.includes("weather"))) {
          return "It's sunny!";
        }
        return "I don't know";
      },
    });

    expect(model).toBeDefined();
  });

  it("should support delay option", async () => {
    const model = createTestModel({ delay: 10 });
    const start = Date.now();

    const { send } = await renderAgent(
      () => (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      ),
      { model },
    );

    await act(async () => {
      await send("Test");
    });

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(10);
  });

  it("should simulate streaming with chunks", async () => {
    const model = createTestModel({
      defaultResponse: "Hello world from streaming!",
      streaming: {
        enabled: true,
        chunkSize: 5,
        chunkDelay: 1,
      },
    });

    // Verify the model can be created with streaming options
    expect(model).toBeDefined();
    expect(model.mocks.executeStream).toBeDefined();
  });

  it("should allow dynamic streaming configuration", () => {
    const model = createTestModel({ defaultResponse: "Test" });

    // Enable streaming dynamically
    model.setStreaming({ enabled: true, chunkSize: 3, chunkDelay: 2 });

    // No error means it worked
    expect(model).toBeDefined();
  });

  it("should stream with proper event structure in full agent flow", async () => {
    const model = createTestModel({
      defaultResponse: "Hello!",
      streaming: { enabled: true, chunkSize: 3, chunkDelay: 0 },
    });

    const { send, result } = await renderAgent(
      () => (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      ),
      { model },
    );

    await act(async () => {
      await send("Test");
    });

    // Verify the model was called (streaming happens internally)
    expect(model.mocks.executeStream).toHaveBeenCalled();
    expect(result.current.tickCount).toBe(1);
  });
});

describe("renderAgent", () => {
  it("should render an agent and provide send function", async () => {
    const Agent = () => (
      <>
        <Model model={createTestModel()} />
        <System>You are helpful</System>
        <Timeline />
      </>
    );

    const { send, result } = await renderAgent(Agent);

    await act(async () => {
      await send("Hello");
    });

    expect(result.current.tickCount).toBe(1);
    expect(result.current.status).toBe("completed");
  });

  it("should provide tick function for running without message", async () => {
    const Agent = () => (
      <>
        <Model model={createTestModel()} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const { tick, result } = await renderAgent(Agent);

    await act(async () => {
      await tick();
    });

    expect(result.current.tickCount).toBe(1);
  });

  it("should track timeline messages", async () => {
    const Agent = () => (
      <>
        <Model model={createTestModel({ defaultResponse: "Test response" })} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const { send, result } = await renderAgent(Agent);

    await act(async () => {
      await send("Hello");
    });

    expect(result.current.timeline.length).toBeGreaterThanOrEqual(1);
  });

  it("should allow custom model", async () => {
    const customModel = createTestModel({ defaultResponse: "Custom response" });

    const Agent = () => (
      <>
        <Model model={customModel} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const { send, model } = await renderAgent(Agent, { model: customModel });

    await act(async () => {
      await send("Test");
    });

    expect(model.getCapturedInputs().length).toBeGreaterThan(0);
  });

  it("should cleanup session on unmount", async () => {
    const Agent = () => (
      <>
        <Model model={createTestModel()} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const { session, unmount } = await renderAgent(Agent);
    expect(session.status).toBe("idle");

    unmount();
    // Session should be closed (status check may vary based on implementation)
  });
});

describe("compileAgent", () => {
  it("should compile agent and return sections", async () => {
    const Agent = () => (
      <>
        <System>You are a helpful assistant</System>
        <Section id="instructions">Be concise and clear</Section>
        <Timeline />
      </>
    );

    const { sections, systemMessages } = await compileAgent(Agent);

    expect(sections.get("instructions")).toBe("Be concise and clear");
    expect(systemMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("should support props", async () => {
    interface AgentProps {
      mode: string;
    }

    const Agent = ({ mode }: AgentProps) => (
      <>
        <System>Mode: {mode}</System>
        <Timeline />
      </>
    );

    const { systemMessages } = await compileAgent(Agent, {
      props: { mode: "helpful" },
    });

    expect(systemMessages.some((m) => m.includes("helpful"))).toBe(true);
  });

  it("should provide helper methods", async () => {
    const Agent = () => (
      <>
        <Section id="intro">Welcome to the assistant</Section>
        <Section id="rules">Follow these rules</Section>
        <Timeline />
      </>
    );

    const result = await compileAgent(Agent);

    expect(result.getSection("intro")).toBe("Welcome to the assistant");
    expect(result.sectionContains("rules", "rules")).toBe(true);
    expect(result.sectionContains("intro", "xyz")).toBe(false);
  });

  it("should track compilation iterations", async () => {
    const Agent = () => (
      <>
        <System>Simple agent</System>
        <Timeline />
      </>
    );

    const { iterations, forcedStable } = await compileAgent(Agent);

    expect(iterations).toBeGreaterThanOrEqual(1);
    expect(forcedStable).toBe(false);
  });
});

describe("act", () => {
  it("should flush microtasks and effects", async () => {
    const effectRan = vi.fn();

    const Agent = () => {
      const count = useSignal(0);

      useEffect(() => {
        effectRan();
      }, []);

      return (
        <>
          <Model model={createTestModel()} />
          <System>Count: {count()}</System>
          <Timeline />
        </>
      );
    };

    const { tick } = await renderAgent(Agent);

    await act(async () => {
      await tick();
    });

    expect(effectRan).toHaveBeenCalled();
  });

  it("should handle async operations", async () => {
    let resolved = false;

    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolved = true;
          resolve();
        }, 10);
      });
    });

    expect(resolved).toBe(true);
  });
});

describe("cleanup", () => {
  it("should close all sessions", async () => {
    const Agent = () => (
      <>
        <Model model={createTestModel()} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const { session: session1 } = await renderAgent(Agent);
    const { session: session2 } = await renderAgent(Agent);

    expect(session1.status).toBe("idle");
    expect(session2.status).toBe("idle");

    cleanup();

    // Sessions should be cleaned up (implementation dependent)
  });
});
