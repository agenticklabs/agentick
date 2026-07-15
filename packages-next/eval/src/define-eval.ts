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
import { cellStats } from "./stats.js";
import type {
  CallableEval,
  DefaultAppOverrides,
  EvalDefinition,
  EvalResult,
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
  const trials = Math.max(1, Math.trunc(opts?.trials ?? 1));

  // cartesian() produces one combination per cell. The TYPE here is
  // sloppy (Record<string, unknown>) but we cast at the boundary —
  // CallableEval.matrix's signature pins the shape for the adopter.
  const productCells = cartesian(axes) as Array<O>;
  if (productCells.length === 0) {
    return { cells: [], passed: true, elapsedMs: Date.now() - started };
  }

  // Flatten to (cellIndex, trial) units so concurrency spans trials too —
  // N stochastic runs per cell should parallelize like any other work.
  const units = productCells.flatMap((axesCell, cellIndex) =>
    Array.from({ length: trials }, () => ({ axesCell, cellIndex })),
  );
  const runs = await mapConcurrent(units, concurrency, async ({ axesCell }) =>
    runEval<O, P>(definition, axesCell),
  );

  // Regroup by cell (units were emitted cell-major, so slice in order).
  const cells: MatrixCell<O>[] = productCells.map((axesCell, cellIndex) => {
    const cellRuns: EvalResult[] = runs.slice(cellIndex * trials, (cellIndex + 1) * trials);
    return { axes: axesCell, trials: cellRuns, stats: cellStats(cellRuns, opts?.k) };
  });

  // A cell "passes" if a majority of its trials passed — a single flaky run
  // no longer flips the whole matrix.
  const passed = cells.every((c) => c.stats.passRate > 0.5);
  return { cells, passed, elapsedMs: Date.now() - started };
}
