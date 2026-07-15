/**
 * A coding-agent eval — the forcing function for the v2 eval surface.
 *
 * Shows what makes eval-next uniquely useful for agents:
 *   - EXECUTABLE scoring: `t.file` / `t.sh` (the workspace plugin) grade by
 *     RUNNING the code the agent wrote, not by string-matching (SWE-bench model).
 *   - TRAJECTORY: `t.calledTool` / `t.completed` grade HOW it solved it.
 *   - BUDGET: `t.result` exposes ticks/tokens for cost assertions.
 *   - LLM-as-JUDGE: `t.judge` grades quality with a model (the judge plugin).
 *
 * The agent runs HEADLESS (`setAutoApproveWrites(true)`) — an eval has no
 * client to answer `write_file`'s elicitation. Evaluating the human-in-the-loop
 * path itself is a `t.onElicit` follow-on (TODO).
 */

import "dotenv/config";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import React from "react";
import { createApp, run } from "@agentick/app-next/react";
import { System } from "@agentick/reconciler-react-next";
import { Timeline } from "@agentick/timeline-next/react";
import { aisdk } from "@agentick/model-ai-sdk-next";
import { openai } from "@ai-sdk/openai";
import { defineEval } from "@agentick/eval-next";
import { workspace } from "@agentick/eval-next/plugins/workspace";
import { judge } from "@agentick/eval-next/plugins/judge";

import { CodingAgent } from "../agent.js";
import { setAutoApproveWrites, setWorkspaceRoot } from "../tools.js";

/** One workspace, re-seeded per run so matrix cells start from a known state. */
export const workspaceDir = nodePath.join(os.tmpdir(), "coding-eval-workspace");

async function seedWorkspace(): Promise<void> {
  await fs.rm(workspaceDir, { recursive: true, force: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    nodePath.join(workspaceDir, "greeting.js"),
    "exports.greet = (name) => `Hello, ${name}!`;\n",
    "utf8",
  );
}

const gpt4oMini = () => aisdk(openai("gpt-4o-mini"));
type Overrides = { model?: ReturnType<typeof aisdk> };

/** LLM-as-judge `generate` — a one-shot grader model call via `run()`. */
const Grader = (): React.ReactElement => (
  <>
    <System>You are a strict grader. Reply with exactly and only what the user asks for.</System>
    <Timeline />
  </>
);
async function grade(prompt: string): Promise<string> {
  const result = await run(<Grader />, {
    model: gpt4oMini(),
    messages: [{ role: "user", content: prompt }],
  }).result;
  return result.response;
}

export const codingEval = defineEval<Overrides>({
  description: "adds a working farewell() export to greeting.js",
  app: async (o) => {
    await seedWorkspace();
    setWorkspaceRoot(workspaceDir);
    setAutoApproveWrites(true); // headless — no client to confirm writes
    return createApp(<CodingAgent />, { model: o?.model ?? gpt4oMini() });
  },
  plugins: [workspace({ dir: workspaceDir }), judge({ generate: grade })],
  async test(t) {
    await t.send(
      "Add a `farewell(name)` export to greeting.js that returns `Goodbye, <name>.` — " +
        "keep greet working and keep the existing CommonJS module style.",
    );

    // process / trajectory
    t.completed();
    t.calledTool("write_file");

    // executable outcome — grade by RUNNING the result
    const src = await t.file("greeting.js");
    t.expect("farewell exported", /farewell/.test(src));
    t.expect(
      "greet + farewell both run",
      (await t.sh("node -e \"const m=require('./greeting');m.greet('A');m.farewell('B')\"")).ok,
    );

    // budget — raw run access
    t.expect("within tick budget", (t.result?.ticks ?? 99) <= 6);
    t.score("tokens", t.result?.usage.totalTokens ?? 0);

    // quality — LLM-as-judge
    await t.judge(
      "greeting.js exports a correct farewell(name) returning 'Goodbye, <name>.' and greet still works.",
    );
  },
});
