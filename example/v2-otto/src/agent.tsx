/**
 * Example v2 agent — a small assistant with three inline tools + one
 * runtime knob. The model can flip the knob via `knob_set`; the agent
 * re-renders and its system prompt changes accordingly.
 *
 * Tools:
 *   - `calculator` — synchronous (Pattern A in the trivial sense; no
 *     `submit` involved).
 *   - `slow_compute` — submits a `ctx.tasks.submit(...)` task with
 *     `taskSupport` *unspecified* (Pattern A). The executor awaits the
 *     handle transparently; the model sees the final blocks. Demonstrates
 *     progress emission without exposing the task to the model.
 *   - `deploy_branch` — submits a task with `taskSupport: "required"`
 *     (Pattern B). The executor returns a `session_task_ref` JSON block
 *     to the model IMMEDIATELY; the model manages the task across ticks
 *     via the auto-registered `task_list / get / cancel / await`
 *     tools.
 *
 * No substrate (journal, bus, inbox, FiberRef) appears here.
 */

import React from "react";
import { z } from "zod";
import { System, createTool } from "@agentick/compiler-react-next";
import { Knobs, useKnob } from "@agentick/knobs-next/react";
import { Timeline } from "@agentick/timeline-next/react";
import type { ContentBlock } from "@agentick/spec-next";

// ─────────────────────────────────────────────────────────────────────
// `calculator` — straightforward synchronous tool.
// ─────────────────────────────────────────────────────────────────────

const Calculator = createTool({
  name: "calculator",
  description:
    "Evaluate a JavaScript arithmetic expression and return the result. Example inputs: '2 + 2', '47 * 23', '(100 - 7) / 3'.",
  inputSchema: z.object({
    expression: z
      .string()
      .describe("A JavaScript arithmetic expression. Whitespace and parens are fine."),
  }),
  handler: async ({ expression }) => {
    try {
      // Demo-quality eval — DO NOT use in production. Real adopters
      // wire a real expression parser or sandbox.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const result = new Function(`"use strict"; return (${expression})`)();
      return [{ type: "text" as const, text: `${expression} = ${result}` }];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [{ type: "text" as const, text: `Error evaluating "${expression}": ${message}` }];
    }
  },
});

// ─────────────────────────────────────────────────────────────────────
// `slow_compute` — Pattern A demo. Submits a task via ctx.tasks.submit;
// the executor awaits handle.result transparently and surfaces the
// final blocks to the model. The model never sees a taskId.
// ─────────────────────────────────────────────────────────────────────

const SlowCompute = createTool({
  name: "slow_compute",
  description:
    "Perform a deliberately slow numeric computation (factorial-style accumulation over `steps` iterations). " +
    "Returns the final result. Use this when the user asks for something computationally expensive — " +
    "the framework will manage progress reporting and cancellation for you.",
  inputSchema: z.object({
    steps: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe("Number of iterations. Each iteration takes ~50ms."),
  }),
  handler: async ({ steps }, { ctx }) => {
    return ctx.tasks!.submit(
      async ({ signal, onProgress }) => {
        let acc = 1;
        for (let i = 1; i <= steps; i++) {
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
          await new Promise<void>((r) => setTimeout(r, 50));
          acc = acc * i;
          onProgress({ current: i, total: steps, message: `step ${i}/${steps} (acc=${acc})` });
        }
        return [{ type: "text", text: `slow_compute(${steps}) = ${acc}` } as ContentBlock];
      },
      { statusMessage: "computing" },
    );
  },
});

// ─────────────────────────────────────────────────────────────────────
// `deploy_branch` — Pattern B demo. `taskSupport: "required"` flips
// the executor into ref-returning mode: the model gets a
// `session_task_ref` JSON block back and uses
// `task_get / cancel / await` to drive the task across ticks.
// ─────────────────────────────────────────────────────────────────────

const DeployBranch = createTool({
  name: "deploy_branch",
  description:
    "Kick off a (simulated) branch deployment that runs ~2s in the background. " +
    "Returns immediately with a session_task_ref — the model receives a task id it can poll, " +
    "cancel, or await using the task_* tools. Use this whenever the user wants to " +
    "deploy or run something that takes meaningful time and they may want to continue the " +
    "conversation while it runs.",
  inputSchema: z.object({
    branch: z.string().describe("The branch name to deploy, e.g., 'main' or 'feat/new-ui'."),
    environment: z
      .enum(["dev", "staging", "prod"])
      .default("dev")
      .describe("Target deployment environment."),
  }),
  annotations: { taskSupport: "required" },
  handler: async ({ branch, environment }, { ctx }) => {
    return ctx.tasks!.submit(
      async ({ signal, onProgress, setStatusMessage }) => {
        const stages = [
          ["building", 400],
          ["uploading-artifacts", 600],
          ["draining-old-instances", 400],
          ["routing-traffic", 400],
          ["smoke-tests", 200],
        ] as const;
        let elapsed = 0;
        const total = stages.reduce((sum, [, ms]) => sum + ms, 0);
        for (const [stage, ms] of stages) {
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
          setStatusMessage(stage);
          await new Promise<void>((r) => setTimeout(r, ms));
          elapsed += ms;
          onProgress({ current: elapsed, total, message: stage });
        }
        return [
          {
            type: "text",
            text: `Deployed branch '${branch}' to ${environment} successfully.`,
          } as ContentBlock,
        ];
      },
      { statusMessage: "queued", ttl: 10 * 60_000 },
    );
  },
});

// ─────────────────────────────────────────────────────────────────────
// Agent — system prompt + tools + a `verbose` knob the model can flip.
// ─────────────────────────────────────────────────────────────────────

export function Agent() {
  const [verbose] = useKnob<boolean>("verbose", false, {
    description: "When true, the assistant gives detailed step-by-step explanations.",
    valueType: "boolean",
  });

  return (
    <>
      <System>
        You are a concise, helpful assistant. You have access to a calculator tool — use it whenever
        the user asks for arithmetic. You also have a `deploy_branch` tool that runs deployments in
        the background and returns a task reference; use the `task_*` tools to manage in-flight
        deployments (poll status, await, cancel) when the user asks about them.
        {verbose
          ? " VERBOSE MODE: explain your reasoning step by step and show all intermediate values."
          : " Be terse — give the answer with at most one sentence of context."}
      </System>

      {/* Tools registered with the session's tool executor at mount. */}
      <Calculator.Tool />
      <SlowCompute.Tool />
      <DeployBranch.Tool />

      {/* Auto-renders the knob_set tool + the current knob values as a Section the model sees. */}
      <Knobs />

      {/* THE CONVERSATION — timeline reaches the model only via this render. */}
      <Timeline />
    </>
  );
}
