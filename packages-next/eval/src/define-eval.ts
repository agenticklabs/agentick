/**
 * `defineEval(definition)` — the public entry point. Returns a
 * callable function: invoke with no args to run with the factory's
 * baked-in defaults, OR with overrides for one-off param swaps.
 *
 * The returned callable also carries `.matrix(axes, opts?)` for
 * cartesian-product parameter sweeps — see {@link CallableEval}.
 *
 * @see EvalDefinition for the input shape, CallableEval for the return.
 * @see docs/proposals/v2/blueprint/37-eval-package-sketch.md
 */

import { cartesian, mapConcurrent } from "@agentick/utils-next";

import { runEval } from "./runner.js";
import type {
  CallableEval,
  DefaultAppOverrides,
  EvalDefinition,
  MatrixCell,
  MatrixOptions,
  MatrixResult,
} from "./types.js";

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
  Object.defineProperty(callable, "matrix", {
    value: ((
      axes: Record<string, ReadonlyArray<unknown>>,
      opts?: MatrixOptions,
    ): Promise<MatrixResult<O>> => runMatrix<O, P>(definition, axes, opts)) as unknown,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return callable;
}

async function runMatrix<O, P>(
  definition: EvalDefinition<O, P>,
  axes: Record<string, ReadonlyArray<unknown>>,
  opts: MatrixOptions | undefined,
): Promise<MatrixResult<O>> {
  const started = Date.now();
  const concurrency = opts?.concurrency ?? 1;

  // cartesian() produces one cell per combination. The TYPE here is
  // sloppy (Record<string, unknown>) but we cast at the boundary —
  // CallableEval.matrix's signature pins the shape for the adopter.
  const productCells = cartesian(axes) as Array<O>;
  if (productCells.length === 0) {
    return { cells: [], passed: true, elapsedMs: Date.now() - started };
  }

  const cells: MatrixCell<O>[] = await mapConcurrent(
    productCells,
    concurrency,
    async (axesCell) => {
      const result = await runEval<O, P>(definition, axesCell);
      return { axes: axesCell, result };
    },
  );

  const passed = cells.every((c) => c.result.passed);
  return { cells, passed, elapsedMs: Date.now() - started };
}
