/**
 * `@agentick/eval` — testing-shaped eval framework for Agentick (v1).
 *
 * ```ts
 * import { defineEval } from "@agentick/eval";
 *
 * const billEval = defineEval<{ model?: string }>({
 *   description: "bill extraction against known fixtures",
 *   app: async (o) => createMyAgent({ model: o?.model ?? "google/gemini-2.5-flash" }),
 *   test: async (t) => {
 *     await t.send([fileBlock, { type: "text", text: "Extract the bill." }]);
 *     t.calledTool("submit_extraction");
 *     const submitted = t.lastToolCall("submit_extraction")?.input as Record<string, unknown>;
 *     t.expect("subtotal matches", Number(submitted?.SubTotal) === 187.5);
 *   },
 * });
 *
 * // One run:
 * const result = await billEval();
 *
 * // Same document + expectations across models, compared per cell:
 * const sweep = await billEval.matrix({
 *   model: ["google/gemini-2.5-flash", "bedrock/us.amazon.nova-2-lite-v1:0"],
 * });
 * ```
 */

export { defineEval, cartesian, mapConcurrent } from "./define-eval.js";
export { runEval } from "./runner.js";
export type {
  AppFactory,
  AssertionKind,
  AssertionResult,
  CallableEval,
  DefaultAppOverrides,
  EvalApp,
  EvalContext,
  EvalDefinition,
  EvalMessage,
  EvalResult,
  EvalSendHandle,
  EvalSendInput,
  EvalSession,
  EvalTest,
  MatrixCell,
  MatrixOptions,
  MatrixResult,
  ObservedToolCall,
} from "./types.js";
