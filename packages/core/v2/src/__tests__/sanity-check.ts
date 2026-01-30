/**
 * Sanity check - verify compiled output looks correct
 */
import React from "react";
import { FiberCompiler } from "../compiler/fiber-compiler";
import { markdownRenderer } from "../renderers/markdown";

const h = React.createElement;

// Create mock COM
const com = {
  id: "test",
  timeline: [],
  state: new Map(),
  get: (k: string) => undefined,
  set: (k: string, v: any) => {},
  requestRecompile: () => {},
};

// Create mock TickState
const tickState = {
  tick: 1,
  previous: null,
  current: null,
  stop: () => {},
  stopped: false,
};

// Create compiler
const compiler = new FiberCompiler(com as any);

// Build a realistic agent component
const Agent = () =>
  h(
    React.Fragment,
    null,
    h(
      "Section",
      { id: "system" },
      h("Text", { text: "You are a helpful assistant that can use tools." }),
    ),
    h("Tool", {
      name: "get_weather",
      description: "Get the current weather",
      schema: { type: "object", properties: { city: { type: "string" } } },
      handler: (args: any) => ({ temp: 72, condition: "sunny" }),
    }),
    h("Entry", { role: "user" }, h("Text", { text: "What's the weather in San Francisco?" })),
    h(
      "Section",
      { id: "context" },
      h("Text", { text: "Current date: 2024-01-15" }),
      h("Code", { code: "const API_KEY = '***'", language: "typescript" }),
    ),
  );

async function main() {
  const compiled = await compiler.compile(h(Agent), tickState as any);

  console.log("\n=== COMPILED STRUCTURE ===\n");

  console.log("SECTIONS:");
  for (const [id, section] of compiled.sections) {
    console.log(`  [${id}]:`);
    const rendered = markdownRenderer.renderBlocks(section.content);
    rendered.split("\n").forEach((line) => console.log(`    ${line}`));
  }

  console.log("\nTOOLS:");
  for (const tool of compiled.tools) {
    console.log(`  - ${tool.name}: ${tool.description}`);
    console.log(`    schema: ${JSON.stringify(tool.schema)}`);
  }

  console.log("\nTIMELINE ENTRIES:");
  for (const entry of compiled.timelineEntries) {
    const content = markdownRenderer.renderBlocks(entry.content);
    console.log(`  [${entry.role}]: ${content}`);
  }

  console.log("\n=== IT WORKS! ===\n");
}

main().catch(console.error);
