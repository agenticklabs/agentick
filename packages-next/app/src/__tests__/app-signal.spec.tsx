/**
 * PA1 — app-wide `signal` cascade.
 *
 * `createApp({ signal })` fans a single `AbortSignal` into every session.
 * Firing it is `closeApp()` in abort shape: a cascading cancel. These tests
 * pin the two halves of that claim:
 *
 *   1. New work is refused — `createSession` / `runOnce` throw once aborted,
 *      and the signal is fanned into EVERY session so a post-abort `send`
 *      on any of them resolves `aborted` without a model call.
 *   2. In-flight executions are torn down — an execution blocked mid-flight
 *      when the signal fires does not run to completion.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ContentBlock, ExecutionTarget } from "@agentick/spec-next";

import { createApp } from "../react.js";

function PlainAgent() {
  return React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    "You are a helpful agent.",
  );
}

function GatedAgent() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "section" as never,
      { id: "system", audience: "model" },
      "You are a helpful agent.",
    ),
    React.createElement("tool" as never, {
      id: "t.gate",
      name: "gate",
      description: "A tool that blocks until released",
      inputSchema: { type: "object", properties: {} },
      exposure: ["model"],
      handlerRef: "handlers/gate",
    }),
  );
}

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}

function plainScript(text = "ok") {
  return [
    {
      result: {
        specVersion: "2026-05-08" as const,
        output: [{ type: "text" as const, text }],
        stopReason: "end" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    },
  ];
}

function gateScript() {
  return [
    {
      result: {
        specVersion: "2026-05-08" as const,
        output: [{ type: "tool_use" as const, toolUseId: "tc-1", name: "gate", input: {} }],
        stopReason: "tool_use" as const,
        toolCalls: [{ id: "tc-1", name: "gate", input: {} }],
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      },
    },
    {
      result: {
        specVersion: "2026-05-08" as const,
        output: [{ type: "text" as const, text: "GATED-DONE" }],
        stopReason: "end" as const,
        usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
      },
    },
  ];
}

// ---------------------------------------------------------------------------

describe("PA1 — app signal cascade", () => {
  it("refuses new work at the app edge once aborted", async () => {
    const controller = new AbortController();
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("sig-exec-1", journal, bus, inbox, {
      scripted: plainScript(),
    });
    await executor.ready;

    const app = await createApp(React.createElement(PlainAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      signal: controller.signal,
    });

    controller.abort();

    await expect(app.createSession({ sessionId: "post-abort" })).rejects.toThrow(/closed/i);
    await expect(
      app.runOnce({ send: { messages: [{ role: "user", content: "hi" }] } }),
    ).rejects.toThrow(/closed/i);

    await app.closeApp();
  });

  it("fans the signal into every session — a post-abort send on any is aborted", async () => {
    const controller = new AbortController();
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("sig-exec-2", journal, bus, inbox, {
      scripted: plainScript(),
    });
    await executor.ready;

    const app = await createApp(React.createElement(PlainAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      signal: controller.signal,
    });

    // Sessions created BEFORE the abort — each holds the live app signal.
    const a = await app.createSession({ sessionId: "sig-A" });
    const b = await app.createSession({ sessionId: "sig-B" });
    const c = await app.createSession({ sessionId: "sig-C" });

    controller.abort();

    for (const s of [a, b, c]) {
      const result = await (await s.send({ messages: [{ role: "user", content: "x" }] })).result;
      expect(result.stopReason).toBe("aborted");
      expect(result.ticks).toBe(0); // no model call happened
      expect(result.response).toBe("");
    }

    await app.closeApp();
  });

  it("tears down an in-flight execution when the signal fires", async () => {
    const controller = new AbortController();
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("sig-exec-3", journal, bus, inbox, {
      scripted: gateScript(),
    });
    await executor.ready;

    let entered!: () => void;
    const started = new Promise<void>((res) => {
      entered = res;
    });
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const toolHandlers = new Map<string, (input: unknown) => Promise<ContentBlock[]>>([
      [
        "handlers/gate",
        async () => {
          entered();
          await gate;
          return [{ type: "text", text: "released" }];
        },
      ],
    ]);

    const app = await createApp(React.createElement(GatedAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      toolHandlers,
      signal: controller.signal,
    });

    const session = await app.createSession({ sessionId: "inflight" });
    const handle = await session.send({ messages: [{ role: "user", content: "go" }] });
    await started; // execution is mid-flight, blocked in the tool

    // Fire the app signal mid-flight, then let the tool finish. The loop's
    // tick-top abort check stops the execution before the second (text) tick.
    controller.abort();
    release();

    const result = await handle.result;
    expect(result.stopReason).toBe("aborted");
    expect(result.response).not.toContain("GATED-DONE"); // final tick never ran

    await app.closeApp();
  });
});
