/**
 * Example v2 agent — a small assistant with one inline tool + one
 * runtime knob. The model can flip the knob via `set_knob`; the agent
 * re-renders and its system prompt changes accordingly.
 *
 * This file is the canonical user surface — JSX components for
 * context, `createTool` for tools-with-handlers-inline, `useKnob` for
 * reactive model-visible state. No substrate (journal, bus, inbox,
 * FiberRef) appears here.
 */

import React from "react";
import { z } from "zod";
import { System, createTool } from "@agentick/reconciler-react-next";
import { Knobs, useKnob } from "@agentick/knobs-next/react";

// ─────────────────────────────────────────────────────────────────────
// Tool — inline handler, schema-validated input, returns content blocks.
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
// Agent — system prompt + tool + a `verbose` knob the model can flip.
// ─────────────────────────────────────────────────────────────────────

export function Agent() {
  const [verbose] = useKnob<boolean>("verbose", false, {
    description: "When true, the assistant gives detailed step-by-step explanations.",
    valueType: "boolean",
  });

  return (
    <>
      <System>
        You are a concise, helpful assistant. You have access to a calculator tool — use it
        whenever the user asks for arithmetic.
        {verbose
          ? " VERBOSE MODE: explain your reasoning step by step and show all intermediate values."
          : " Be terse — give the answer with at most one sentence of context."}
      </System>

      {/* Tool declaration + handler — registered with the session's tool executor at mount. */}
      <Calculator.Tool />

      {/* Auto-renders the set_knob tool + the current knob values as a Section the model sees. */}
      <Knobs />
    </>
  );
}
