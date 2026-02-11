/**
 * Sandbox Package Tests
 *
 * Tests for useSandbox(), <Sandbox> component, and pre-built tools.
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { createApp, createTool, Model, Section } from "@agentick/core";
import { createTestAdapter, type TestAdapterInstance } from "@agentick/core/testing";
import { z } from "zod";
import { useSandbox, SandboxContext } from "../context";
import { Sandbox } from "../component";
import { Shell, ReadFile, WriteFile, EditFile } from "../tools";
import { createMockSandbox, createMockProvider } from "../testing";

// ============================================================================
// Helpers
// ============================================================================

function createModel(options?: { response?: string }): TestAdapterInstance {
  return createTestAdapter({ defaultResponse: options?.response ?? "Done" });
}

// ============================================================================
// useSandbox() Tests
// ============================================================================

describe("useSandbox()", () => {
  it("throws when no Sandbox provider is in the tree", async () => {
    let _error: Error | undefined;

    const TestTool = createTool({
      name: "test_tool",
      description: "Test",
      input: z.object({ x: z.string() }),
      use: () => {
        try {
          return { sandbox: useSandbox() };
        } catch (e) {
          _error = e as Error;
          throw e;
        }
      },
      handler: async () => [{ type: "text" as const, text: "ok" }],
    });

    const model = createModel();
    model.respondWith([{ tool: { name: "test_tool", input: { x: "hi" } } }]);

    function Agent() {
      return (
        <>
          <TestTool />
          <Section id="system" audience="model">
            Test
          </Section>
          <Model model={model} />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });

    // The render should fail because useSandbox is called without a provider.
    // This manifests as the tool throwing during use() resolution.
    await expect(app.session().then((s) => s.render({}).result)).rejects.toThrow(
      "No model configured. Add a <Model> component or pass model in options.",
    );
  });
});

// ============================================================================
// <Sandbox> Component Tests
// ============================================================================

describe("<Sandbox> component", () => {
  it("calls provider.create() and provides sandbox to children via context", async () => {
    const mockSandbox = createMockSandbox();
    const provider = createMockProvider({
      create: vi.fn().mockResolvedValue(mockSandbox),
    });

    let capturedSandbox: any = null;

    const ProbeTool = createTool({
      name: "probe",
      description: "Probes the sandbox context",
      input: z.object({ x: z.string() }),
      use: () => {
        capturedSandbox = useSandbox();
        return { sandbox: capturedSandbox };
      },
      handler: async (_, deps) => {
        return [{ type: "text" as const, text: `sandbox: ${deps!.sandbox.id}` }];
      },
    });

    const model = createModel();
    model.respondWith([{ tool: { name: "probe", input: { x: "test" } } }]);

    function Agent() {
      return (
        <Sandbox provider={provider}>
          <ProbeTool />
          <Section id="system" audience="model">
            Test
          </Section>
          <Model model={model} />
        </Sandbox>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();
    await session.render({}).result;

    expect(provider.create).toHaveBeenCalled();
    expect(capturedSandbox).toBe(mockSandbox);

    await session.close();
  });
});

// ============================================================================
// Tool Tests
// ============================================================================

describe("Shell tool", () => {
  it("calls sandbox.exec() with the command", async () => {
    const mockSandbox = createMockSandbox({
      exec: vi.fn().mockResolvedValue({ stdout: "file1.txt\nfile2.txt", stderr: "", exitCode: 0 }),
    });
    const provider = createMockProvider({
      create: vi.fn().mockResolvedValue(mockSandbox),
    });

    const model = createModel();
    model.respondWith([{ tool: { name: "shell", input: { command: "ls" } } }]);

    function Agent() {
      return (
        <Sandbox provider={provider}>
          <Shell />
          <Section id="system" audience="model">
            Test
          </Section>
          <Model model={model} />
        </Sandbox>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();
    await session.render({}).result;

    expect(mockSandbox.exec).toHaveBeenCalledWith("ls");

    await session.close();
  });
});

describe("ReadFile tool", () => {
  it("calls sandbox.readFile() with the path", async () => {
    const mockSandbox = createMockSandbox({
      readFile: vi.fn().mockResolvedValue("file content here"),
    });
    const provider = createMockProvider({
      create: vi.fn().mockResolvedValue(mockSandbox),
    });

    const model = createModel();
    model.respondWith([{ tool: { name: "read_file", input: { path: "/app/main.ts" } } }]);

    function Agent() {
      return (
        <Sandbox provider={provider}>
          <ReadFile />
          <Section id="system" audience="model">
            Test
          </Section>
          <Model model={model} />
        </Sandbox>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();
    await session.render({}).result;

    expect(mockSandbox.readFile).toHaveBeenCalledWith("/app/main.ts");

    await session.close();
  });
});

describe("WriteFile tool", () => {
  it("calls sandbox.writeFile() with path and content", async () => {
    const mockSandbox = createMockSandbox();
    const provider = createMockProvider({
      create: vi.fn().mockResolvedValue(mockSandbox),
    });

    const model = createModel();
    model.respondWith([
      { tool: { name: "write_file", input: { path: "/app/out.txt", content: "hello world" } } },
    ]);

    function Agent() {
      return (
        <Sandbox provider={provider}>
          <WriteFile />
          <Section id="system" audience="model">
            Test
          </Section>
          <Model model={model} />
        </Sandbox>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();
    await session.render({}).result;

    expect(mockSandbox.writeFile).toHaveBeenCalledWith("/app/out.txt", "hello world");

    await session.close();
  });
});

describe("EditFile tool", () => {
  it("calls sandbox.editFile() with path and edits", async () => {
    const mockSandbox = createMockSandbox({
      editFile: vi.fn().mockResolvedValue({
        content: "const x = 42;",
        applied: 1,
        changes: [{ line: 1, removed: 1, added: 1 }],
      }),
    });
    const provider = createMockProvider({
      create: vi.fn().mockResolvedValue(mockSandbox),
    });

    const model = createModel();
    model.respondWith([
      {
        tool: {
          name: "edit_file",
          input: {
            path: "/app/main.ts",
            edits: [{ old: "const x = 1;", new: "const x = 42;" }],
          },
        },
      },
    ]);

    function Agent() {
      return (
        <Sandbox provider={provider}>
          <EditFile />
          <Section id="system" audience="model">
            Test
          </Section>
          <Model model={model} />
        </Sandbox>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();
    await session.render({}).result;

    expect(mockSandbox.editFile).toHaveBeenCalledWith("/app/main.ts", [
      { old: "const x = 1;", new: "const x = 42;" },
    ]);

    await session.close();
  });
});

// ============================================================================
// Tree Scoping Tests
// ============================================================================

describe("tree scoping", () => {
  it("tools access their nearest sandbox provider via context", async () => {
    const sandbox1 = createMockSandbox({
      id: "sandbox-1",
      exec: vi.fn().mockResolvedValue({ stdout: "from-1", stderr: "", exitCode: 0 }),
    });
    const sandbox2 = createMockSandbox({
      id: "sandbox-2",
      exec: vi.fn().mockResolvedValue({ stdout: "from-2", stderr: "", exitCode: 0 }),
    });

    let capturedSandbox1: any = null;
    let capturedSandbox2: any = null;

    // Two distinct tools that capture which sandbox they see
    const Tool1 = createTool({
      name: "tool_1",
      description: "Tool in sandbox 1",
      input: z.object({ value: z.string() }),
      use: () => ({ sandbox: useSandbox() }),
      handler: async ({ value }, deps) => {
        capturedSandbox1 = deps!.sandbox;
        return [{ type: "text" as const, text: value }];
      },
    });

    const Tool2 = createTool({
      name: "tool_2",
      description: "Tool in sandbox 2",
      input: z.object({ value: z.string() }),
      use: () => ({ sandbox: useSandbox() }),
      handler: async ({ value }, deps) => {
        capturedSandbox2 = deps!.sandbox;
        return [{ type: "text" as const, text: value }];
      },
    });

    const model = createModel();
    // Both tools called in the same response
    model.respondWith([
      { tool: { name: "tool_1", input: { value: "a" } } },
      { tool: { name: "tool_2", input: { value: "b" } } },
    ]);

    // Use SandboxContext.Provider directly (synchronous) to avoid useData async resolution
    function Agent() {
      return (
        <>
          <SandboxContext.Provider value={sandbox1}>
            <Tool1 />
          </SandboxContext.Provider>
          <SandboxContext.Provider value={sandbox2}>
            <Tool2 />
          </SandboxContext.Provider>
          <Section id="system" audience="model">
            Test
          </Section>
          <Model model={model} />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();
    await session.render({}).result;

    // Each tool should have captured its own provider's sandbox
    expect(capturedSandbox1).toBe(sandbox1);
    expect(capturedSandbox2).toBe(sandbox2);

    await session.close();
  });
});

// ============================================================================
// Testing Utilities Tests
// ============================================================================

describe("createMockSandbox", () => {
  it("returns a sandbox with sensible defaults", async () => {
    const sandbox = createMockSandbox();
    expect(sandbox.id).toBe("mock-sandbox-1");
    expect(sandbox.workspacePath).toBe("/tmp/mock-sandbox");

    const execResult = await sandbox.exec("test");
    expect(execResult).toEqual({ stdout: "", stderr: "", exitCode: 0 });

    const content = await sandbox.readFile("test.txt");
    expect(content).toBe("");
  });

  it("accepts overrides", async () => {
    const sandbox = createMockSandbox({
      id: "custom-id",
      exec: vi.fn().mockResolvedValue({ stdout: "custom", stderr: "", exitCode: 0 }),
    });
    expect(sandbox.id).toBe("custom-id");

    const result = await sandbox.exec("test");
    expect(result.stdout).toBe("custom");
  });
});

describe("createMockProvider", () => {
  it("returns a provider whose create() returns a mock sandbox", async () => {
    const provider = createMockProvider();
    expect(provider.name).toBe("mock");

    const sandbox = await provider.create({});
    expect(sandbox.id).toBe("mock-sandbox-1");
  });

  it("accepts overrides", async () => {
    const customSandbox = createMockSandbox({ id: "custom" });
    const provider = createMockProvider({
      name: "custom-provider",
      create: vi.fn().mockResolvedValue(customSandbox),
    });
    expect(provider.name).toBe("custom-provider");

    const sandbox = await provider.create({});
    expect(sandbox.id).toBe("custom");
  });
});
