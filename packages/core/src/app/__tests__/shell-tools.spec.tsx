/**
 * session.shell() and session.tools.<name> proxy tests.
 *
 * The "agent harness" surface — programmatic access to tools registered in the
 * tree. session.shell(cmd) is sugar for dispatch("bash", { command: cmd }).
 * session.tools.<name>(input) is sugar for dispatch(name, input). Both support
 * nested namespacing via dot-paths.
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { z } from "zod";
import { createApp } from "../../app.js";
import { System } from "../../jsx/components/messages.js";
import { Model } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { createTestAdapter } from "../../testing/index.js";
import { createTool } from "../../tool/tool.js";

const FakeBash = createTool({
  name: "bash",
  description: "Fake bash for tests",
  input: z.object({ command: z.string() }),
  audience: "user",
  handler: async ({ command }) => [{ type: "text" as const, text: `ran: ${command}` }],
});

const NestedSearch = createTool({
  name: "knowify.search",
  description: "Namespaced tool",
  input: z.object({ q: z.string() }),
  audience: "user",
  handler: async ({ q }) => [{ type: "text" as const, text: `hit:${q}` }],
});

const FlatTool = createTool({
  name: "echo",
  description: "Flat tool",
  input: z.object({ msg: z.string() }),
  audience: "user",
  handler: async ({ msg }) => [{ type: "text" as const, text: msg }],
});

function HarnessAgent() {
  return (
    <>
      <FakeBash />
      <NestedSearch />
      <FlatTool />
      <Model model={createTestAdapter({ defaultResponse: "ok" })} />
      <System>Test harness</System>
      <Timeline />
    </>
  );
}

// ============================================================================
// session.shell()
// ============================================================================

describe("session.shell()", () => {
  it("dispatches the bash tool and returns text content", async () => {
    const app = createApp(HarnessAgent, { maxTicks: 1 });
    const session = await app.session();

    const text = await session.shell("ls -la");
    expect(text).toBe("ran: ls -la");

    await session.close();
  });

  it("auto-mounts before dispatch", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    function Agent() {
      return (
        <>
          <FakeBash />
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const text = await session.shell("pwd");
    expect(text).toBe("ran: pwd");
    expect(model.getCapturedInputs()).toHaveLength(0);

    await session.close();
  });

  it("throws when no bash tool is registered", async () => {
    function NoBashAgent() {
      return (
        <>
          <Model model={createTestAdapter({ defaultResponse: "ok" })} />
          <System>No bash</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(NoBashAgent, { maxTicks: 1 });
    const session = await app.session();

    await expect(session.shell("ls")).rejects.toThrow(
      /session\.shell\(\) requires a <Bash> tool to be mounted/,
    );
    await expect(session.shell("ls")).rejects.toThrow(/@agentick\/sandbox/);

    await session.close();
  });
});

// ============================================================================
// session.tools.<name>
// ============================================================================

describe("session.tools proxy", () => {
  it("dispatches a flat tool via session.tools.<name>(input)", async () => {
    const app = createApp(HarnessAgent, { maxTicks: 1 });
    const session = await app.session();

    const result = await session.tools.echo({ msg: "hello" });
    expect(result).toEqual([{ type: "text", text: "hello" }]);

    await session.close();
  });

  it("dispatches a namespaced tool via session.tools.<ns>.<name>(input)", async () => {
    const app = createApp(HarnessAgent, { maxTicks: 1 });
    const session = await app.session();

    const result = await session.tools.knowify.search({ q: "ledger" });
    expect(result).toEqual([{ type: "text", text: "hit:ledger" }]);

    await session.close();
  });

  it("supports calling bash via session.tools.bash", async () => {
    const app = createApp(HarnessAgent, { maxTicks: 1 });
    const session = await app.session();

    const result = await session.tools.bash({ command: "echo hi" });
    expect(result).toEqual([{ type: "text", text: "ran: echo hi" }]);

    await session.close();
  });

  it("throws for unknown tool names", async () => {
    const app = createApp(HarnessAgent, { maxTicks: 1 });
    const session = await app.session();

    await expect(session.tools.nonexistent({})).rejects.toThrow(/Unknown command: nonexistent/);

    await session.close();
  });

  it("deep namespace paths join with dots", async () => {
    const DeepTool = createTool({
      name: "a.b.c",
      description: "Deep",
      input: z.object({}),
      audience: "user",
      handler: async () => [{ type: "text" as const, text: "deep" }],
    });
    function Agent() {
      return (
        <>
          <DeepTool />
          <Model model={createTestAdapter({ defaultResponse: "ok" })} />
          <System>Deep</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const result = await session.tools.a.b.c({});
    expect(result).toEqual([{ type: "text", text: "deep" }]);

    await session.close();
  });

  it("does not interfere with thenable detection (proxy is not awaitable)", async () => {
    const app = createApp(HarnessAgent, { maxTicks: 1 });
    const session = await app.session();

    // If `then` were not stripped, awaiting session.tools.echo would hang or
    // call dispatch with weird args. The proxy must look like a plain object
    // to Promise.resolve.
    const ns = session.tools.echo;
    const resolved = await Promise.resolve(ns);
    // resolved should be the proxy itself (not the result of calling it)
    expect(typeof resolved).toBe("function");

    await session.close();
  });
});
