/**
 * `@agentick/eval-next/plugins/judge` — LLM-as-judge scoring.
 *
 * Grades the last run's output against a rubric with a model. Model-agnostic
 * by design (capability, not opinion): you inject a `generate(prompt) => text`
 * function wired to whatever model you want — a raw adapter, an agentick
 * `run(...)`, or a remote endpoint. `t.judge` builds the grading prompt from
 * the rubric + the run transcript, calls `generate`, and records a pass/fail
 * assertion PLUS a numeric score.
 *
 * ```ts
 * import { judge } from "@agentick/eval-next/plugins/judge";
 * defineEval({
 *   plugins: [judge({ generate: (p) => myModel.complete(p) })],
 *   async test(t) {
 *     await t.send("...");
 *     await t.judge("The answer is correct and cites a source.");
 *   },
 * });
 * ```
 */

import type { EvalPlugin, EvalRunContext } from "../types.js";

declare module "@agentick/eval-next" {
  interface EvalContextExtensions {
    /**
     * Grade the last `t.send` against `rubric` with the injected model.
     * Records a pass/fail assertion + a `judge:<rubric>` score (0..1).
     * Returns whether it passed.
     */
    judge(rubric: string, opts?: { readonly label?: string }): Promise<boolean>;
  }
}

export interface JudgeOptions {
  /** Generate a completion for the grading prompt. Wire to any model. */
  readonly generate: (prompt: string) => Promise<string>;
  /** Override the grading-prompt builder (rubric + transcript → prompt). */
  readonly prompt?: (args: {
    rubric: string;
    response: string;
    tools: readonly string[];
  }) => string;
}

interface Verdict {
  readonly pass: boolean;
  readonly score: number;
  readonly reason: string;
}

const defaultPrompt = (args: {
  rubric: string;
  response: string;
  tools: readonly string[];
}): string =>
  [
    "You are grading an AI agent's work against a rubric. Be strict and fair.",
    "",
    `RUBRIC: ${args.rubric}`,
    "",
    `AGENT FINAL RESPONSE:\n${args.response || "(empty)"}`,
    `TOOLS THE AGENT CALLED: ${args.tools.length ? args.tools.join(", ") : "(none)"}`,
    "",
    'Respond with ONLY a JSON object: {"pass": boolean, "score": number between 0 and 1, "reason": "one sentence"}.',
  ].join("\n");

/** Parse the model's grade leniently — JSON first, PASS/FAIL keyword fallback. */
function parseVerdict(raw: string): Verdict {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as Partial<Verdict>;
      const pass = Boolean(obj.pass);
      const score = typeof obj.score === "number" ? obj.score : pass ? 1 : 0;
      return { pass, score, reason: String(obj.reason ?? "") };
    } catch {
      // fall through to keyword parse
    }
  }
  const pass = /\bpass\b/i.test(raw) && !/\bfail\b/i.test(raw);
  return { pass, score: pass ? 1 : 0, reason: raw.slice(0, 200).trim() };
}

export function judge(opts: JudgeOptions): EvalPlugin {
  const buildPrompt = opts.prompt ?? defaultPrompt;
  return (rc: EvalRunContext) => ({
    async judge(rubric: string, judgeOpts?: { readonly label?: string }): Promise<boolean> {
      const label = judgeOpts?.label ?? `judge: ${rubric}`;
      const result = rc.result();
      const raw = await opts.generate(
        buildPrompt({
          rubric,
          response: result?.response ?? "",
          tools: rc.toolCalls.map((c) => c.name),
        }),
      );
      const verdict = parseVerdict(raw);
      rc.record({ label, passed: verdict.pass, message: verdict.reason, details: verdict });
      rc.score(label, verdict.score, verdict);
      return verdict.pass;
    },
  });
}
