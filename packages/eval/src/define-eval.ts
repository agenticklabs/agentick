/**
 * `defineEval(definition)` — the public entry point. Returns a
 * callable function: invoke with no args to run with the factory's
 * baked-in defaults, OR with overrides for one-off param swaps.
 *
 * The returned callable also carries `.matrix(axes, opts?)` for
 * cartesian-product parameter sweeps — the multi-model comparison
 * surface: run the same eval (same document, same expected output)
 * across every axis combination and compare per-cell results.
 *
 * @see EvalDefinition for the input shape, CallableEval for the return.
 * @see packages-next/eval (v2 origin)
 */

import { runEval } from "./runner.js";
import type {
  CallableEval,
  DefaultAppOverrides,
  EvalDefinition,
  MatrixCell,
  MatrixOptions,
  MatrixResult,
} from "./types.js";

export function defineEval<O = DefaultAppOverrides>(
  definition: EvalDefinition<O>,
): CallableEval<O> {
  const callable = ((overrides?: O) => runEval<O>(definition, overrides)) as CallableEval<O>;
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
    ): Promise<MatrixResult<O>> => runMatrix<O>(definition, axes, opts)) as unknown,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return callable;
}

// ============================================================================
// Matrix
// ============================================================================

async function runMatrix<O>(
  definition: EvalDefinition<O>,
  axes: Record<string, ReadonlyArray<unknown>>,
  opts: MatrixOptions | undefined,
): Promise<MatrixResult<O>> {
  const started = Date.now();
  const concurrency = Math.max(1, opts?.concurrency ?? 1);

  const productCells = cartesian(axes) as Array<O>;
  if (productCells.length === 0) {
    return { cells: [], passed: true, elapsedMs: Date.now() - started };
  }

  const cells: MatrixCell<O>[] = await mapConcurrent(productCells, concurrency, async (cell) => {
    const result = await runEval<O>(definition, cell);
    return { axes: cell, result };
  });

  const passed = cells.every((c) => c.result.passed);
  return { cells, passed, elapsedMs: Date.now() - started };
}

/**
 * Cartesian product of axis values. `{}` → one empty cell. Any axis
 * with an empty array → zero cells (mathematical product).
 */
export function cartesian(
  axes: Record<string, ReadonlyArray<unknown>>,
): Array<Record<string, unknown>> {
  const keys = Object.keys(axes);
  if (keys.length === 0) return [{}];

  let cells: Array<Record<string, unknown>> = [{}];
  for (const key of keys) {
    const values = axes[key] ?? [];
    const next: Array<Record<string, unknown>> = [];
    for (const cell of cells) {
      for (const value of values) {
        next.push({ ...cell, [key]: value });
      }
    }
    cells = next;
  }
  return cells;
}

/** Run `fn` over `items` with at most `limit` in flight, order-preserving. */
export async function mapConcurrent<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!, index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
