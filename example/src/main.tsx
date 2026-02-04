/**
 * Example app for testing DevTools
 *
 * This creates a simple agent with a mock model and runs multiple ticks
 * to generate events for DevTools visualization.
 *
 * Run with: pnpm dev (from example directory)
 * DevTools UI: http://localhost:3001
 */

// Load environment variables before any other imports
import { config as loadEnv } from "dotenv";
loadEnv();

import { createApp } from "@tentickle/core/app";
import { createModel, type ModelInput, type ModelOutput } from "@tentickle/core/model";
import { fromEngineState, toEngineState } from "@tentickle/core/model/utils/language-model";
import { useState, useEffect } from "@tentickle/core/hooks";
import type { MessageProps } from "@tentickle/core/jsx";
import { Timeline, Model, Section, Message } from "@tentickle/core/jsx";
import { startDevToolsServer } from "@tentickle/devtools";
import type {
  StreamEvent,
  MessageStartEvent,
  ContentStartEvent,
  ContentEndEvent,
  MessageEndEvent,
  ContentDeltaEvent,
} from "@tentickle/shared/streaming";
import { BlockType, StopReason } from "@tentickle/shared";

import { MyModel } from "./model/app-model";
import { CalculatorTool } from "./tools/calculator.tool";

// ============================================================================
// Mock Model
// ============================================================================

const responses = [
  "Hello! I'm a mock assistant running on Tentickle. How can I help you today?",
  "That's a great question! Let me think about it...",
  "I've processed your request. The answer is 42. Is there anything else you'd like to know?",
  "Of course! Here's some information for you. The Tentickle framework makes building AI agents easy.",
  "Thank you for testing the DevTools! This is tick {tick} of our conversation.",
  "I can help with many tasks. Just ask me anything!",
  "Interesting question! Let me provide a thoughtful response.",
  "That concludes our demo. The DevTools should now show all the events!",
];

let responseIndex = 0;
let tickCounter = 1;

function getNextResponse(): string {
  const template = responses[responseIndex % responses.length];
  responseIndex++;
  return template.replace("{tick}", String(tickCounter++));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a mock model that simulates streaming responses
 */
const mockModel = createModel<ModelInput, ModelOutput, ModelInput, ModelOutput, StreamEvent>({
  metadata: {
    id: "mock-model",
    provider: "test",
    description: "Mock model for DevTools testing",
    capabilities: [{ stream: true, toolCalls: false }],
  },
  executors: {
    execute: async (_input) => {
      const text = getNextResponse();
      await sleep(100); // Simulate network delay
      return {
        model: "mock-model",
        createdAt: new Date().toISOString(),
        message: { role: "assistant" as const, content: [{ type: "text" as const, text }] },
        usage: {
          inputTokens: 50,
          outputTokens: text.split(" ").length * 2,
          totalTokens: 50 + text.split(" ").length * 2,
        },
        stopReason: StopReason.STOP,
        raw: {},
      };
    },
    executeStream: async function* (_input) {
      const text = getNextResponse();
      const words = text.split(" ");
      const eventBase = {
        id: `evt-${Date.now()}`,
        tick: tickCounter,
        timestamp: new Date().toISOString(),
      };

      // Start message
      yield {
        ...eventBase,
        type: "message_start",
        messageId: `msg-${Date.now()}`,
        role: "assistant",
        model: "mock-model",
        startedAt: new Date().toISOString(),
      } as MessageStartEvent;

      yield {
        ...eventBase,
        type: "content_start",
        blockType: BlockType.TEXT,
        blockIndex: 0,
      } as ContentStartEvent;

      // Stream words as deltas
      for (let i = 0; i < words.length; i++) {
        await sleep(40); // Simulate streaming delay
        const delta = i === 0 ? words[i] : " " + words[i];
        yield {
          ...eventBase,
          type: "content_delta",
          blockType: BlockType.TEXT,
          blockIndex: 0,
          delta,
        } as ContentDeltaEvent;
      }

      yield {
        ...eventBase,
        type: "content_end",
        blockType: BlockType.TEXT,
        blockIndex: 0,
      } as ContentEndEvent;

      yield {
        ...eventBase,
        type: "message_end",
        stopReason: StopReason.STOP,
        usage: {
          inputTokens: 50,
          outputTokens: words.length * 2,
          totalTokens: 50 + words.length * 2,
        },
      } as MessageEndEvent;
    },
  },
  fromEngineState,
  toEngineState,
});

// ============================================================================
// Agent Component
// ============================================================================

interface AgentProps {
  query?: string;
  context?: string;
}

/**
 * A simple agent with state to test fiber serialization and DevTools
 */
function SimpleAgent({
  context = `You are a helpful assistant with access to a calculator tool.

IMPORTANT RULES:
1. When asked ANY math question, you MUST call the calculator tool
2. NEVER attempt to calculate math in your head
3. ALWAYS use the calculator function for calculations
4. After getting the calculator result, report it to the user

Example: If asked "what is 2+2?", you call calculator with expression "2 + 2"`,
}: AgentProps) {
  const [tickCount, setTickCount] = useState(0);

  // Track ticks
  useEffect(() => {
    setTickCount((prev) => prev + 1);
  }, []);

  return (
    <>
      <MyModel />
      <Section id="instructions" audience="model">
        {context}
      </Section>
      <CalculatorTool />
      <Timeline>
        {(history, pending = []) => {
          console.log("history", history);
          console.log("pending", pending);
          return (
            <>
              {history
                .filter((e) => e.message)
                .map((entry, i) => (
                  <Message key={i} {...entry.message} />
                ))}
              {pending.map((message, i) => (
                <Message key={i} {...(message.content as MessageProps)} />
              ))}
            </>
          );
        }}
      </Timeline>
    </>
  );
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("Starting DevTools example...\n");

  // Check if we have real API keys configured
  const hasRealModel = !!(
    process.env["OPENAI_API_KEY"] ||
    process.env["GOOGLE_API_KEY"] ||
    process.env["GCP_PROJECT_ID"]
  );

  if (hasRealModel) {
    console.log("Using real model from MyModel component (API keys detected)");
    console.log(
      `  USE_GOOGLE_MODEL: ${process.env["USE_GOOGLE_MODEL"] || "false (defaulting to OpenAI)"}`,
    );
    console.log(`  OPENAI_MODEL: ${process.env["OPENAI_MODEL"] || "gpt-4o-mini"}`);
    console.log(`  GOOGLE_MODEL: ${process.env["GOOGLE_MODEL"] || "gemini-2.0-flash"}\n`);
  } else {
    console.log("No API keys found - using mock model\n");
  }

  // Start DevTools server
  const devtools = startDevToolsServer({ port: 3001, debug: true });
  console.log(`DevTools UI: ${devtools.getUrl()}\n`);

  // Create app - use mockModel as fallback only when no real API keys
  const app = createApp(SimpleAgent, hasRealModel ? {} : { model: mockModel });

  // Create a persistent session with DevTools enabled
  const session = app.createSession({ recording: "full", devTools: true });
  console.log(`Created session: ${session.id}\n`);

  // Run a series of messages to generate DevTools events
  const messages = [
    "Use the calculator tool to compute 42 * 17. You MUST call the calculator function.",
    "Use the calculator to compute (123 + 456) * 2",
  ];

  for (const msg of messages) {
    console.log(`\n--- User: "${msg}" ---`);

    // Stream the response
    const handle = session.send({
      messages: [{ role: "user", content: [{ type: "text", text: msg }] }],
      props: { context: "Be helpful and brief." },
    });

    for await (const event of handle) {
      if (event.type === "content_delta") {
        process.stdout.write(event.delta);
      } else if (event.type === "tick_start") {
        console.log(`[tick ${event.tick} started]`);
      } else if (event.type === "tick_end") {
        console.log(`\n[tick ${event.tick} ended, continue: ${event.shouldContinue}]`);
      } else if (event.type === "tool_call") {
        const tc = event as any;
        const name = tc.toolCall?.name ?? tc.name;
        const input = tc.toolCall?.input ?? tc.input;
        console.log(`\n[TOOL CALL] ${name}(${JSON.stringify(input)})`);
      } else if (event.type === "tool_result") {
        const tr = event as any;
        console.log(`[TOOL RESULT] ${JSON.stringify(tr.content ?? tr.output)}`);
      }
    }

    const result = await handle.result;
    const responseText = result?.response || "(no response text)";
    console.log(
      `\nResponse: ${responseText.slice(0, 100)}${responseText.length > 100 ? "..." : ""}`,
    );
    console.log(`Tokens: ${result?.usage?.totalTokens ?? 0}`);

    // Small delay between messages
    await sleep(600);
  }

  // Inspect session state
  const inspection = session.inspect();
  console.log("\n=== Session Inspection ===");
  console.log(`Tick count: ${inspection.tickCount}`);
  console.log(`Total tokens: ${inspection.totalUsage.totalTokens}`);
  console.log(`Components: ${inspection.components.names.join(", ")}`);
  console.log(`Hooks: ${JSON.stringify(inspection.hooks.byType)}`);

  // Get recording
  const recording = session.getRecording();
  if (recording) {
    console.log("\n=== Recording ===");
    console.log(`Snapshots: ${recording.snapshots.length}`);
    console.log(`Duration: ${recording.summary.totalDuration}ms`);
  }

  // Keep running for DevTools
  console.log("\n\n========================================");
  console.log("DevTools server running at http://localhost:3001");
  console.log("Open this URL in your browser to see the DevTools UI");
  console.log("Press Ctrl+C to exit");
  console.log("========================================\n");

  // Keep process alive
  await new Promise(() => {});
}

main().catch(console.error);
