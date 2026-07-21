/**
 * Core additions (t.result / t.expect / t.score) + the plugin seam
 * (per-eval `plugins`, workspace `t.sh`/`t.file`, judge `t.judge`).
 *
 * Reuses the calculator fake-app scaffold shape from define-eval.spec.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import React from "react";
import { createApp } from "@agentick/app-next/react";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ExecutionTarget } from "@agentick/spec-next";
import { afterEach, describe, expect, it } from "vitest";

import { defineEval } from "../index.js";
import { workspace } from "../plugins/workspace.js";
import { judge } from "../plugins/judge.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: false },
};

const Agent = (): React.ReactElement =>
  React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    "You are a helpful agent.",
  );

function mkExecutor(): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    "eval-plugins-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "the answer is 42." }],
            stopReason: "end",
            usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
          },
        },
      ],
    },
  );
}

const app = () => createApp(React.createElement(Agent), { modelExecutor: mkExecutor(), target });

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("core: t.result / t.expect / t.score", () => {
  it("exposes the full SendResult after t.send", async () => {
    let seen: { tokens?: number; stop?: string } = {};
    const result = await defineEval({
      description: "result exposed",
      app,
      async test(t) {
        await t.send("hi");
        seen = { tokens: t.result?.usage.totalTokens, stop: t.result?.stopReason };
      },
    })();
    expect(result.passed).toBe(true);
    expect(seen.tokens).toBe(16);
    expect(seen.stop).toBe("end");
  });

  it("t.expect records labeled assertions and gates passed", async () => {
    const result = await defineEval({
      description: "expect gates",
      app,
      async test(t) {
        await t.send("hi");
        t.expect("has answer", (t.result?.response ?? "").includes("42"));
        t.expect("impossible", false);
      },
    })();
    expect(result.passed).toBe(false); // the false expect fails the eval
    const labels = result.assertions.filter((a) => a.kind === "expect").map((a) => a.label);
    expect(labels).toEqual(["has answer", "impossible"]);
    expect(result.assertions.find((a) => a.label === "has answer")?.passed).toBe(true);
  });

  it("t.score records numeric scores without gating passed", async () => {
    const result = await defineEval({
      description: "score",
      app,
      async test(t) {
        await t.send("hi");
        t.score("quality", 0.75);
      },
    })();
    expect(result.passed).toBe(true); // scores don't gate
    expect(result.scores).toEqual([{ label: "quality", value: 0.75 }]);
  });
});

describe("plugin seam", () => {
  it("workspace plugin: t.sh runs in the dir; t.file reads it", async () => {
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "eval-ws-"));
    tmpDirs.push(dir);
    await fs.writeFile(nodePath.join(dir, "note.txt"), "hello-from-workspace", "utf8");

    const result = await defineEval({
      description: "workspace",
      app,
      plugins: [workspace({ dir })],
      async test(t) {
        const sh = await t.sh("echo ok");
        t.expect("sh ok", sh.ok && sh.stdout.includes("ok"));
        const contents = await t.file("note.txt");
        t.expect("file read", contents.includes("hello-from-workspace"));
      },
    })();
    expect(result.passed).toBe(true);
  });

  it("judge plugin: grades via injected generate; records assertion + score", async () => {
    const captured: string[] = [];
    const generate = async (prompt: string): Promise<string> => {
      captured.push(prompt);
      return '{"pass": true, "score": 0.9, "reason": "answer present"}';
    };

    const result = await defineEval({
      description: "judge",
      app,
      plugins: [judge({ generate })],
      async test(t) {
        await t.send("what is the answer?");
        const passed = await t.judge("The response states an answer.");
        t.expect("judge passed", passed);
      },
    })();

    expect(result.passed).toBe(true);
    expect(captured[0]).toContain("The response states an answer."); // rubric in prompt
    expect(captured[0]).toContain("the answer is 42."); // transcript in prompt
    expect(result.scores.find((s) => s.label.startsWith("judge:"))?.value).toBe(0.9);
  });
});
