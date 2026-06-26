/**
 * `defineEval(definition)` — the public entry point. Returns a
 * callable function: invoke with no args to run with the factory's
 * baked-in defaults, OR with overrides for one-off param swaps.
 *
 * @see EvalDefinition for the input shape, CallableEval for the return.
 * @see docs/proposals/v2/blueprint/37-eval-package-sketch.md
 */

import { runEval } from "./runner.js";
import type { CallableEval, DefaultAppOverrides, EvalDefinition } from "./types.js";

export function defineEval<O = DefaultAppOverrides, P = unknown>(
  definition: EvalDefinition<O, P>,
): CallableEval<O, P> {
  const callable = ((overrides?: O) => runEval<O, P>(definition, overrides)) as CallableEval<O, P>;
  Object.defineProperty(callable, "definition", {
    value: definition,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return callable;
}
