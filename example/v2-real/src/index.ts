/**
 * Agentick v2 end-to-end example — real model edition.
 *
 * Wires a JSX agent into a real OpenAI model via the AI SDK adapter
 * and runs a single send-and-print round trip. The purpose:
 *
 *   1. Validate ergonomics end-to-end with a real provider.
 *   2. Demonstrate the canonical user surface
 *      (`createApp` + `aisdk` + `<Agent/>` + `app.send`).
 *   3. Catch every awkward seam the framework still has — the example
 *      is the forcing function for API improvements.
 *
 * Run:
 *   1. cp .env.example .env  (then fill in OPENAI_API_KEY)
 *   2. pnpm --filter example-v2-real dev
 */

import "dotenv/config";
import React from "react";
import { createApp } from "@agentick/app-next/react";
import { aisdk } from "@agentick/executor-ai-sdk-next";
import { openai } from "@ai-sdk/openai";

import { Agent } from "./agent.js";

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set. Copy .env.example to .env and fill in your key.");
    process.exit(1);
  }

  const app = await createApp(React.createElement(Agent), {
    executor: aisdk(openai("gpt-4o-mini")),
  });

  const session = await app.createSession();

  await session.timeline.append({
    kind: "message",
    message: {
      id: "demo-1",
      ts: Date.now(),
      role: "user",
      content: [
        { type: "text", text: "What's 47 * 23, and tell me a fun fact about that number?" },
      ],
    },
  });

  try {
    console.log("→ User: What's 47 * 23, and tell me a fun fact about that number?\n");
    const result = await app.send("What's 47 * 23, and tell me a fun fact about that number?");
    console.log("← Assistant:", result.response);
    console.log(
      `\n[${result.ticks} tick(s), ${result.usage.totalTokens} tokens, stop=${result.stopReason}]`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exit(1);
});
