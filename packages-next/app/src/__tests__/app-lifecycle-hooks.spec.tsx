/**
 * AppHarness — app-edge lifecycle hooks (ADR 80/83). `app:create-session` and
 * `app:run-once` (ops `app:command:create-session` / `app:command:run-once`)
 * route through `runOperation`, so the `CommandRegistry` augmentation in
 * `harness.ts` mints `onBefore/After` hooks for each. `createApp({ hooks })`
 * registers them on the app's own `.use` chain, so they fire around the app's
 * own commands. This test proves both fire.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ContentBlock } from "@agentick/spec-next";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hello");

async function mkExecutor(): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    "lifecycle-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );
  await exec.ready;
  return exec;
}

describe("AppHarness — lifecycle hooks (ADR 83)", () => {
  it("onBeforeAppCreateSession fires when createSession() is called", async () => {
    let fired = 0;
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      hooks: {
        onBeforeAppCreateSession: () => {
          fired += 1;
        },
      },
    });

    await app.createSession();
    expect(fired).toBe(1);

    await app.closeApp();
  });

  it("onBeforeAppRunOnce fires when runOnce() runs an ephemeral send", async () => {
    let fired = 0;
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      hooks: {
        onBeforeAppRunOnce: () => {
          fired += 1;
        },
      },
    });

    await app.send("hi");
    expect(fired).toBe(1);

    await app.closeApp();
  });
});
