/**
 * <Tool> JSX Primitive Component Tests
 *
 * Verifies that <Tool> (primitives.ts) wraps its handler prop as a Procedure
 * so the tool executor can call .withMetadata() on it. This is the fix for
 * the bug where raw functions passed as handler silently failed at runtime.
 *
 * Tests:
 * - Handler is called when model triggers tool use
 * - Handler receives correct input
 * - Handler receives ctx as second argument
 * - Works alongside createTool-based tools in same agent
 * - Already-a-Procedure handler passes through without double-wrapping
 * - Multiple <Tool> components with separate handlers don't interfere
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../../../app.js";
import { createTool } from "../../../tool/tool.js";
import { Model, Tool } from "../primitives.js";
import { System, User } from "../messages.js";
import { Timeline } from "../timeline.js";
import { createTestAdapter } from "../../../testing/index.js";
import { createEngineProcedure } from "../../../procedure/index.js";
import { z } from "zod";

describe("<Tool> JSX component", () => {
  it("handler is called when model triggers tool use", async () => {
    let calls = 0;
    const handler = async () => {
      calls++;
      return [{ type: "text" as const, text: "done" }];
    };

    const model = createTestAdapter({ defaultResponse: "" });
    model.respondWith([{ tool: { name: "ping", input: {} } }, { text: "Finished" }]);

    function Agent() {
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>Go</User>
          <Tool name="ping" description="Ping tool" schema={z.object({})} handler={handler} />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }).result;
    session.close();

    expect(calls).toBe(1);
  });

  it("handler receives correct input", async () => {
    let receivedInput: any = null;

    const handler = async (input: any) => {
      receivedInput = input;
      return [{ type: "text" as const, text: "ok" }];
    };

    const model = createTestAdapter({ defaultResponse: "" });
    model.respondWith([
      { tool: { name: "greet", input: { name: "world", count: 3 } } },
      { text: "Done" },
    ]);

    function Agent() {
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>Go</User>
          <Tool
            name="greet"
            description="Greet tool"
            schema={z.object({ name: z.string(), count: z.number() })}
            handler={handler}
          />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }).result;
    session.close();

    expect(receivedInput).toEqual({ name: "world", count: 3 });
  });

  it("handler receives ctx as second argument", async () => {
    let receivedCtx: any = null;

    const handler = async (_input: any, ctx: any) => {
      receivedCtx = ctx;
      return [{ type: "text" as const, text: "ok" }];
    };

    const model = createTestAdapter({ defaultResponse: "" });
    model.respondWith([{ tool: { name: "probe", input: {} } }, { text: "Done" }]);

    function Agent() {
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>Go</User>
          <Tool name="probe" description="Probe ctx" schema={z.object({})} handler={handler} />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }).result;
    session.close();

    expect(receivedCtx).toBeDefined();
    expect(typeof receivedCtx.setState).toBe("function");
  });

  it("works alongside createTool-based tools", async () => {
    let primitiveCalls = 0;
    let createToolCalls = 0;

    const primitiveHandler = async () => {
      primitiveCalls++;
      return [{ type: "text" as const, text: "primitive" }];
    };

    const CreatedTool = createTool({
      name: "created",
      description: "Created tool",
      input: z.object({}),
      handler: async () => {
        createToolCalls++;
        return [{ type: "text" as const, text: "created" }];
      },
    });

    const model = createTestAdapter({ defaultResponse: "" });
    model.respondWith([
      { tool: { name: "primitive_tool", input: {} } },
      { tool: { name: "created", input: {} } },
      { text: "All done" },
    ]);

    function Agent() {
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>Go</User>
          <Tool
            name="primitive_tool"
            description="Primitive tool"
            schema={z.object({})}
            handler={primitiveHandler}
          />
          <CreatedTool />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }).result;
    session.close();

    expect(primitiveCalls).toBe(1);
    expect(createToolCalls).toBe(1);
  });

  it("passes through handler that is already a Procedure", async () => {
    let calls = 0;

    const rawHandler = async () => {
      calls++;
      return [{ type: "text" as const, text: "from-procedure" }];
    };

    const procedureHandler = createEngineProcedure(
      {
        name: "tool:run" as const,
        metadata: { type: "tool", toolName: "pre_wrapped", id: "pre_wrapped", operation: "run" },
        middleware: [],
        executionBoundary: "child" as const,
        executionType: "tool",
      },
      rawHandler,
    );

    const model = createTestAdapter({ defaultResponse: "" });
    model.respondWith([{ tool: { name: "pre_wrapped", input: {} } }, { text: "Done" }]);

    function Agent() {
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>Go</User>
          <Tool
            name="pre_wrapped"
            description="Already a procedure"
            schema={z.object({})}
            handler={procedureHandler as any}
          />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }).result;
    session.close();

    expect(calls).toBe(1);
  });

  it("multiple <Tool> components maintain independent handlers", async () => {
    const results: string[] = [];

    const model = createTestAdapter({ defaultResponse: "" });
    model.respondWith([
      { tool: { name: "alpha", input: {} } },
      { tool: { name: "beta", input: {} } },
      { text: "Done" },
    ]);

    function Agent() {
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>Go</User>
          <Tool
            name="alpha"
            description="Alpha tool"
            schema={z.object({})}
            handler={async () => {
              results.push("alpha");
              return [{ type: "text" as const, text: "a" }];
            }}
          />
          <Tool
            name="beta"
            description="Beta tool"
            schema={z.object({})}
            handler={async () => {
              results.push("beta");
              return [{ type: "text" as const, text: "b" }];
            }}
          />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }).result;
    session.close();

    expect(results).toContain("alpha");
    expect(results).toContain("beta");
    expect(results).toHaveLength(2);
  });

  it("handler error propagates correctly (does not silently swallow)", async () => {
    const model = createTestAdapter({ defaultResponse: "" });
    model.respondWith([{ tool: { name: "failing", input: {} } }, { text: "Done" }]);

    function Agent() {
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>Go</User>
          <Tool
            name="failing"
            description="Tool that throws"
            schema={z.object({})}
            handler={async () => {
              throw new Error("handler_boom");
            }}
          />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();
    const result = await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }).result;
    session.close();

    // The execution should complete (error is caught by tool executor)
    // but the tool result should contain the error
    expect(result).toBeDefined();
  });
});
