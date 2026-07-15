/**
 * Run the coding-agent eval and print a scorecard.
 *
 *   pnpm --filter example-v2-coding-agent eval
 *
 * Needs OPENAI_API_KEY (real model). Exits non-zero if the eval fails, so it
 * drops into CI as a gate.
 */

import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { formatResult, formatMatrix, renderHtmlReport } from "@agentick/eval-next";
import { aisdk } from "@agentick/model-ai-sdk-next";
import { openai } from "@ai-sdk/openai";

import { codingEval } from "./coding.eval.js";

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  console.log("Running coding-agent eval…\n");
  const result = await codingEval();
  console.log(formatResult(result));

  // The same definition is a benchmark: EVAL_MATRIX=1 compares models over
  // several trials each (so the numbers are distributions, not coin flips) and
  // writes a self-contained HTML report.
  if (process.env.EVAL_MATRIX) {
    console.log("\nBenchmark across models (3 trials/cell):\n");
    const matrix = await codingEval.matrix(
      { model: [aisdk(openai("gpt-4o-mini")), aisdk(openai("gpt-4o"))] },
      { trials: 3, k: 2, concurrency: 2 },
    );
    console.log(formatMatrix(matrix));
    await writeFile("eval-report.html", renderHtmlReport(matrix, { title: "Coding agent" }));
    console.log("\nwrote eval-report.html");
  }

  process.exit(result.passed ? 0 : 1);
}

main().catch((err) => {
  console.error("\nEval failed to run:", err);
  process.exit(1);
});
