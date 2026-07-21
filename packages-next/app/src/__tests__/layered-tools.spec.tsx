/**
 * Slice-6 (#140) — app-layer wiring for the layered-tools plan.
 *
 * Verifies:
 *   - `createApp({ tools: [...] })` registers app-bound tools that
 *     reach every session the app creates.
 *   - `createSession({ tools })` (session-bound) overrides app-bound
 *     on name collision (precedence ladder: session > app).
 *   - App-bound tools share precedence with extension@app on tie
 *     (slice 2 verifies first-inserted wins; here we just verify
 *     both are visible when names differ).
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ContentBlock, ToolDeclaration, ToolExecutorProtocol } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

const Agent = () => React.createElement("message", { role: "user" }, "hello");

async function mkExecutor() {
  const exec = new FakeLanguageModelExecutor(
    "app-tools-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "ok" } satisfies ContentBlock],
            stopReason: "end",
          },
        },
      ],
    },
  );
  await exec.ready;
  return exec;
}

function tool(name: string, description = name): ToolDeclaration {
  return {
    id: `t.${name}`,
    name,
    description,
    inputSchema: jsonSchema({ type: "object" }),
    exposure: ["model"],
    handlerRef: `h.${name}`,
  };
}

describe("AppHarness — layered tools (#140)", () => {
  it("registers app-bound tools so every session sees them via compileForTick", async () => {
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      tools: [tool("search")],
    });

    const session = await app.createSession();
    // Peek at the toolExecutor through the session's narrow types.
    // The session's toolExecutor is the per-session ToolExecutorHarness
    // constructed with our app-level tools as initialTools.
    const internals = session as unknown as { toolExecutor: ToolExecutorProtocol };
    const compiled = await internals.toolExecutor.compileForTick({ exposure: "model" });
    expect(compiled.map((t) => t.name)).toContain("search");

    await app.closeApp();
  });

  it("app-bound tools persist across multiple sessions of the same app", async () => {
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      tools: [tool("ping")],
    });
    const s1 = await app.createSession();
    const s2 = await app.createSession();
    const intA = s1 as unknown as { toolExecutor: ToolExecutorProtocol };
    const intB = s2 as unknown as { toolExecutor: ToolExecutorProtocol };
    const a = await intA.toolExecutor.compileForTick({ exposure: "model" });
    const b = await intB.toolExecutor.compileForTick({ exposure: "model" });
    expect(a.map((t) => t.name)).toContain("ping");
    expect(b.map((t) => t.name)).toContain("ping");
    await app.closeApp();
  });

  it("session-bound tool overrides app-bound tool of the same name", async () => {
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      tools: [tool("calc", "app calc")],
    });
    const session = await app.createSession({
      tools: [tool("calc", "session calc")],
    });
    const internals = session as unknown as { toolExecutor: ToolExecutorProtocol };
    const compiled = await internals.toolExecutor.compileForTick({ exposure: "model" });
    const calc = compiled.find((t) => t.name === "calc");
    expect(calc?.description).toBe("session calc");
    await app.closeApp();
  });
});
