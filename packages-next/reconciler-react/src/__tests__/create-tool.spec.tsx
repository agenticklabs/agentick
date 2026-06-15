/**
 * React-flavored `createTool` — verifies:
 *   - the `use()` hook fires during the Tool component's render
 *   - the handler closes over the most recently captured deps
 *   - the Tool component registers/unregisters with the ToolBridge
 *   - the `<tool>` declaration is contributed to the rendered tree
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  HookBridges,
  ToolBridge,
  ToolHandler,
  Unsubscribe,
  Validator,
} from "@agentick/spec-next";

import { createTool } from "../react/create-tool.js";
import { fakeBridges } from "@agentick/reconciler-next";
import { ReconcilerHarness } from "../harness/reconciler-harness.js";

interface RegisteredHandler {
  readonly ref: string;
  readonly handler: ToolHandler;
  readonly validator?: Validator;
}

function makeToolBridge(): { bridge: ToolBridge; registered: RegisteredHandler[] } {
  const registered: RegisteredHandler[] = [];
  const bridge: ToolBridge = {
    register(ref, handler, validator): Unsubscribe {
      const entry: RegisteredHandler = validator ? { ref, handler, validator } : { ref, handler };
      registered.push(entry);
      return () => {
        const i = registered.findIndex((e) => e.ref === ref);
        if (i >= 0) registered.splice(i, 1);
      };
    },
    unregister(ref) {
      const i = registered.findIndex((e) => e.ref === ref);
      if (i >= 0) registered.splice(i, 1);
    },
  };
  return { bridge, registered };
}

async function makeHarness() {
  const harness = new ReconcilerHarness(
    "h_create_tool",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

function fakeCtx() {
  return {
    toolCallId: "tc-1",
    signal: new AbortController().signal,
    setState: () => undefined,
    emit: () => undefined,
  };
}

describe("reconciler-react createTool — bundle shape", () => {
  it("returns CreatedTool fields plus Tool component", () => {
    const t = createTool({
      name: "ping",
      description: "ping",
      handler: async () => [{ type: "text", text: "pong" }],
    });
    expect(t.declaration.name).toBe("ping");
    expect(typeof t.handler).toBe("function");
    expect(typeof t.validator.validate).toBe("function");
    expect(typeof t.Tool).toBe("function");
    expect(t.Tool.displayName).toBe("Tool(ping)");
  });
});

describe("reconciler-react createTool — render-time wiring", () => {
  it("contributes a <tool> declaration and registers via ToolBridge", async () => {
    const { bridge, registered } = makeToolBridge();
    const bridges: HookBridges = { ...fakeBridges(), tools: bridge };

    const tool = createTool({
      name: "echo",
      description: "echo input",
      inputSchema: z.object({ text: z.string() }),
      handler: async ({ text }) => [{ type: "text", text }],
    });

    const harness = await makeHarness();
    await harness.mount({
      mountId: "m1",
      sessionId: "s1",
      element: React.createElement(tool.Tool),
      bridges,
    });
    const { tree, diagnostics } = await harness.renderTree({
      mountId: "m1",
      sessionId: "s1",
    });

    expect(diagnostics).toEqual([]);
    expect(tree.declarations?.tools?.[0]?.name).toBe("echo");
    expect(registered).toHaveLength(1);
    expect(registered[0]!.ref).toBe(tool.handlerRef);
    expect(registered[0]!.validator).toBe(tool.validator);
  });

  it("handler sees deps captured by spec.use() during render", async () => {
    const { bridge, registered } = makeToolBridge();
    const bridges: HookBridges = { ...fakeBridges(), tools: bridge };

    const tool = createTool<{ word: string }, { tag: string }>({
      name: "tagged",
      description: "echo with tag",
      use: () => ({ tag: "ALPHA" }),
      handler: async ({ word }, { use }) => [{ type: "text", text: `${use.tag}:${word}` }],
    });

    const harness = await makeHarness();
    await harness.mount({
      mountId: "m2",
      sessionId: "s2",
      element: React.createElement(tool.Tool),
      bridges,
    });
    await harness.renderTree({ mountId: "m2", sessionId: "s2" });

    expect(registered).toHaveLength(1);
    const result = await registered[0]!.handler({ word: "hello" }, { ctx: fakeCtx(), use: {} });
    expect(result).toEqual([{ type: "text", text: "ALPHA:hello" }]);
  });

  it("treats omitted use() as empty deps", async () => {
    const { bridge, registered } = makeToolBridge();
    const bridges: HookBridges = { ...fakeBridges(), tools: bridge };

    const tool = createTool({
      name: "no-deps",
      description: "no deps",
      handler: async (_input, { use }) => [{ type: "text", text: JSON.stringify(use) }],
    });

    const harness = await makeHarness();
    await harness.mount({
      mountId: "m3",
      sessionId: "s3",
      element: React.createElement(tool.Tool),
      bridges,
    });
    await harness.renderTree({ mountId: "m3", sessionId: "s3" });

    const result = await registered[0]!.handler({}, { ctx: fakeCtx(), use: {} });
    expect(result).toEqual([{ type: "text", text: "{}" }]);
  });

  it("renders the <tool> declaration even when no ToolBridge is wired", async () => {
    const bridges: HookBridges = fakeBridges();
    const tool = createTool({
      name: "stub",
      description: "stub",
      handler: async () => [],
    });

    const harness = await makeHarness();
    await harness.mount({
      mountId: "m4",
      sessionId: "s4",
      element: React.createElement(tool.Tool),
      bridges,
    });
    const { tree, diagnostics } = await harness.renderTree({
      mountId: "m4",
      sessionId: "s4",
    });

    expect(diagnostics).toEqual([]);
    expect(tree.declarations?.tools?.[0]?.name).toBe("stub");
  });
});
