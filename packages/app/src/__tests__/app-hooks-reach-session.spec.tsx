/**
 * An app-level hook on a SESSION-surface command must reach the session.
 *
 * `hooks-cascade.spec.tsx` proves app hooks reach the tool-executor and the
 * knobs bridge. Nothing proved they reach the session's OWN commands
 * (`session:send`, `session:append`) — and that is the one surface where the
 * cascade could plausibly break, because `SessionHarnessFactoryDeps`
 * (`spec/protocol/session-harness.ts`) carries no interceptor handle, unlike
 * the compiler / executor / loop-executor / tool-executor factory deps which
 * all do.
 *
 * Written because the type-level gap was mistaken for a live defect. It is
 * NOT one on this path: `AppHarness.createSession` constructs `SessionHarness`
 * directly with `inheritedInterceptors` + `interceptorParent: this`, never
 * through the factory. This test pins that behavior so the distinction stops
 * being re-derived from types — reading a construction site tells you what was
 * INTENDED; only a probe tells you what happens.
 *
 * The factory's missing handle remains a latent hole for any caller that DOES
 * build a session through `defineSession(...)`'s deferred form; that is
 * recorded on the task, not asserted here.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ContentBlock } from "@agentick/spec";

const Agent = (): React.ReactElement => React.createElement("message", { role: "system" }, "hi");

async function mkExecutor(id: string): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    id,
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

describe("app hooks reach the session's own commands", () => {
  it("createApp({ hooks: { onBeforeSessionSend } }) fires on session.send()", async () => {
    const fired: string[] = [];
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor("ahrs-1"),
      hooks: {
        onBeforeSessionSend: (input) => {
          fired.push("before");
          return input;
        },
        onAfterSessionSend: (output) => {
          fired.push("after");
          return output;
        },
      },
    });

    const session = await app.createSession();
    await (
      await session.send({ messages: [{ role: "user", content: "ping" }] })
    ).result;

    // Asserted as a labelled string so a failure names WHICH half of the
    // cascade broke rather than reporting a bare array mismatch.
    expect(fired.includes("before") ? "before:ok" : "before:MISSING").toBe("before:ok");
    expect(fired.includes("after") ? "after:ok" : "after:MISSING").toBe("after:ok");

    await app.closeApp();
  });

  it("a hook registered AFTER createSession still reaches that session (live parent, ADR 83 §4)", async () => {
    const fired: string[] = [];
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor("ahrs-2"),
    });

    // Session exists FIRST — so a construction-time snapshot of interceptors
    // would miss this hook entirely. `interceptorParent` is what keeps the
    // inheritance live.
    const session = await app.createSession();
    app.hook({
      onBeforeSessionSend: (input) => {
        fired.push("late");
        return input;
      },
    });

    await (
      await session.send({ messages: [{ role: "user", content: "ping" }] })
    ).result;
    expect(fired.includes("late") ? "late:ok" : "late:MISSING").toBe("late:ok");

    await app.closeApp();
  });
});
