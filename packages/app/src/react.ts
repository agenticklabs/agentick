/**
 * `@agentick/app/react` — React-defaulted `createApp` entry point.
 *
 * Thin wrapper over `@agentick/app`'s `createApp` that defaults
 * `options.compiler` to `reactCompiler()` when not supplied.
 * Adopters writing React agents do:
 *
 * ```ts
 * import { createApp } from "@agentick/app/react";
 *
 * const app = await createApp(<Agent />, {
 *   model: openai("gpt-4o"),
 * });
 * ```
 *
 * Zero ceremony, React compiler wired automatically. Adopters who
 * want to customize the compiler (custom contributors, devtools opt-in,
 * etc.) pass an explicit `compiler: reactCompiler({ ... })` to
 * override the default.
 *
 * Adopters using a non-React compiler import directly from
 * `@agentick/app` and pass their own compiler factory; the React-
 * specific wiring stays out of their dependency graph.
 *
 * Everything else from `@agentick/app` is re-exported here for
 * single-import convenience.
 */

import { reactCompiler } from "@agentick/compiler-react";

import {
  createApp as baseCreateApp,
  type AppHarnessOptions,
  type CreateAppOptions,
} from "./create-app.js";
import { AppHarness } from "./harness.js";
import { run as baseRun, type RunHandle, type RunOptions } from "./run.js";

export async function createApp<P = unknown>(
  rootElement: unknown,
  options: Omit<CreateAppOptions<P>, "compiler"> & Partial<Pick<CreateAppOptions<P>, "compiler">>,
): Promise<AppHarness<P>> {
  return baseCreateApp(rootElement, {
    compiler: reactCompiler(),
    ...options,
  } as CreateAppOptions<P>);
}

/**
 * React-defaulted `run()` — one-shot execution with the React
 * compiler wired automatically. See `@agentick/app`'s `run`.
 *
 * ```ts
 * const result = await run(<Agent />, { model: openai("gpt-4o"), messages }).result;
 * ```
 */
export function run<P = unknown>(
  rootElement: unknown,
  options: Omit<RunOptions<P>, "compiler"> & Partial<Pick<RunOptions<P>, "compiler">>,
): RunHandle {
  return baseRun(rootElement, {
    compiler: reactCompiler(),
    ...options,
  } as RunOptions<P>);
}

// Re-export the rest of the public surface so adopters can pull
// everything from this subpath.
export { AppHarness, type AppHarnessOptions } from "./harness.js";
export { type CreateAppOptions } from "./create-app.js";
export { type RunHandle, type RunOptions } from "./run.js";
export {
  createTelemetry,
  buildTelemetryExport,
  type BuiltTelemetryExport,
} from "./telemetry-wiring.js";
