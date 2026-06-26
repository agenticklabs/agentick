/**
 * `defineEval(definition)` — the public entry point. Returns a
 * callable function: invoke with no args to run with defaults
 * baked into the definition, OR with overrides for one-off
 * param swaps.
 *
 * See {@link EvalDefinition} for the input shape and
 * {@link CallableEval} for the return shape.
 *
 * @see docs/proposals/v2/blueprint/37-eval-package-sketch.md
 */

import { runEval } from "./runner.js";
import type { CallableEval, EvalDefinition, EvalInvocationOverrides } from "./types.js";

export function defineEval<P = unknown>(definition: EvalDefinition<P>): CallableEval<P> {
  const callable = ((overrides?: EvalInvocationOverrides<P>) =>
    runEval<P>(definition, overrides)) as CallableEval<P>;
  // Expose definition for tooling / future `.matrix` extensions.
  Object.defineProperty(callable, "definition", {
    value: definition,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return callable;
}
