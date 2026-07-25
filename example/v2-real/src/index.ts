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
import { createApp } from "@agentick/app/react";
import { aisdk } from "@agentick/model-ai-sdk";
import { openai } from "@ai-sdk/openai";

import { Agent } from "./agent.js";

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set. Copy .env.example to .env and fill in your key.");
    process.exit(1);
  }

  const app = await createApp(React.createElement(Agent), {
    model: aisdk(openai("gpt-4o-mini")),
  });

  // One session end to end — send() queues the message, drain moves it
  // onto the timeline, and the agent's <Timeline /> renders it into the
  // model context. (A previous version seeded a session and then called
  // app.send(), which runs an UNRELATED ephemeral session — the seed
  // never reached the model.)
  const session = await app.createSession();

  try {
    console.log("→ User: What's 47 * 23, and tell me a fun fact about that number?\n");
    const handle = await session.send({
      messages: [
        { role: "user", content: "What's 47 * 23, and tell me a fun fact about that number?" },
      ],
    });
    const result = await handle.result;
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
