/**
 * ADR 82 — the hook cascade wired end-to-end through the construction fold.
 *
 * Proves that `createApp({ hooks })` and `createSession({ hooks })` reach a
 * real tool dispatch: the app folds its declarative `CommandHooks` into its
 * resolved `Hooks` layer, `createSessionBody` extends it with the session's
 * own layer, and the resolved value threads into the per-session
 * `ToolExecutorHarness`. `tool:dispatch` routes through `runOperation`, so the
 * folded hooks fire as middleware around the dispatch body — the handler sees
 * the reshaped input.
 *
 * `tool:dispatch` is (today) the ONLY command with a `CommandRegistry`
 * augmentation, so `onBefore/AfterToolDispatch` are the only type-safe hook
 * keys. The other per-session harnesses (knobs / tasks / resources) receive the
 * same resolved `Hooks` VALUE and route through `runOperation`, but stay
 * TYPE-dormant until they augment `CommandRegistry` — see the package report.
 *
 * @see docs/proposals/v2/blueprint/82-hooks-cascade-as-construction-fold.md
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ContentBlock, ToolDeclaration, ToolHandler } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hello");

async function mkExecutor(): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    "hooks-exec",
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

const ECHO_REF = "h.echo";

/** A dispatch-exposed tool whose handler echoes back the `value` it received. */
function echoTool(): ToolDeclaration {
  return {
    id: "t.echo",
    name: "echo",
    description: "echoes its input.value",
    inputSchema: jsonSchema({ type: "object" }),
    exposure: ["model", "dispatch"],
    handlerRef: ECHO_REF,
  };
}

/** Records + echoes the arguments the handler was actually invoked with. */
function makeEchoHandler(seen: { value?: unknown }): ToolHandler {
  return async (input) => {
    const value = (input as { value?: unknown }).value;
    seen.value = value;
    return [{ type: "text", text: String(value) } satisfies ContentBlock];
  };
}

describe("ADR 82 — hook cascade wired end-to-end (tool:dispatch)", () => {
  it("createApp({ hooks: { onBeforeToolDispatch } }) reshapes the dispatched input", async () => {
    const seen: { value?: unknown } = {};
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler(seen)]]),
      hooks: {
        onBeforeToolDispatch: (input) => ({
          ...input,
          input: { ...(input.input as Record<string, unknown>), value: "reshaped-by-app" },
        }),
      },
    });

    const session = await app.createSession();
    const result = await session.dispatch("echo", { value: "original" });

    // The app-level before-hook fired around the real dispatch body: both the
    // handler AND the returned content reflect the reshaped input.
    expect(seen.value).toBe("reshaped-by-app");
    expect((result[0] as { text: string }).text).toBe("reshaped-by-app");

    await app.closeApp();
  });

  it("createSession({ hooks }) COMPOSES on top of app hooks (both fire, app outer)", async () => {
    const seen: { value?: unknown } = {};
    // Each before-hook APPENDS a marker. If both fire and the app layer is
    // outer, the handler sees the app suffix applied before the session suffix.
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler(seen)]]),
      hooks: {
        onBeforeToolDispatch: (input) => ({
          ...input,
          input: {
            ...(input.input as Record<string, unknown>),
            value: `${(input.input as { value: string }).value}|app`,
          },
        }),
      },
    });

    const session = await app.createSession({
      hooks: {
        onBeforeToolDispatch: (input) => ({
          ...input,
          input: {
            ...(input.input as Record<string, unknown>),
            value: `${(input.input as { value: string }).value}|session`,
          },
        }),
      },
    });

    const result = await session.dispatch("echo", { value: "x" });

    // Compose, not override: BOTH ran. Outer-first ordering → app before session.
    expect(seen.value).toBe("x|app|session");
    expect((result[0] as { text: string }).text).toBe("x|app|session");

    await app.closeApp();
  });

  it("onAfterToolDispatch fires around the dispatch (app layer, observe)", async () => {
    const seen: { value?: unknown } = {};
    let afterRan = 0;
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler(seen)]]),
      hooks: {
        // Observe (return void → passthrough). The `tool:dispatch` command's
        // runtime output is the richer dispatch-result object, so we assert the
        // hook FIRED rather than reshaping a shape the registry under-declares.
        onAfterToolDispatch: () => {
          afterRan++;
        },
      },
    });

    const session = await app.createSession();
    const result = await session.dispatch("echo", { value: "untouched" });

    // The handler ran unchanged; the after-hook fired exactly once around it.
    expect(seen.value).toBe("untouched");
    expect(afterRan).toBe(1);
    expect((result[0] as { text: string }).text).toBe("untouched");

    await app.closeApp();
  });

  it("behavior-preserving: no hooks → the handler sees the raw input", async () => {
    const seen: { value?: unknown } = {};
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler(seen)]]),
    });

    const session = await app.createSession();
    const result = await session.dispatch("echo", { value: "verbatim" });

    expect(seen.value).toBe("verbatim");
    expect((result[0] as { text: string }).text).toBe("verbatim");

    await app.closeApp();
  });
});
