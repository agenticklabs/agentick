/**
 * TUI Smoke Test
 *
 * Creates a minimal agent with a calculator tool and runs it in the TUI.
 *
 * Usage:
 *   OPENAI_API_KEY=... npx tsx packages/tui/test/smoke.tsx
 */

import { createApp, createTool, Model, Timeline, Section } from "@agentick/core";
import { openai } from "@agentick/openai";
import { z } from "zod";
import { createTUI } from "../src/index.js";

// Simple calculator tool
const CalculatorTool = createTool({
  name: "calculator",
  description: "Evaluates a mathematical expression and returns the result.",
  input: z.object({
    expression: z.string().describe("The mathematical expression to evaluate"),
  }),
  handler: async ({ expression }) => {
    try {
      const result = new Function(`"use strict"; return (${expression})`)();
      return [{ type: "text" as const, text: `${expression} = ${result}` }];
    } catch (error) {
      return [{ type: "text" as const, text: `Error: ${error}` }];
    }
  },
});

// Minimal agent component
function SmokeAgent() {
  const model = openai({ model: "gpt-4o-mini" });
  return (
    <>
      <Model model={model} />
      <Section id="system" audience="model">
        You are a helpful assistant. You have access to a calculator tool. Keep responses concise.
      </Section>
      <Timeline />
      <CalculatorTool />
    </>
  );
}

// Create app and start TUI
const app = createApp(SmokeAgent);

console.log("Starting Agentick TUI smoke test...");
console.log("Type a message to chat, /exit to quit.\n");

createTUI({ app }).start();
