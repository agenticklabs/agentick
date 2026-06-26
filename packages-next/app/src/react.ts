/**
 * `@agentick/app-next/react` — React-defaulted `createApp` entry point.
 *
 * Thin wrapper over `@agentick/app-next`'s `createApp` that defaults
 * `options.reconciler` to `reactReconciler()` when not supplied.
 * Adopters writing React agents do:
 *
 * ```ts
 * import { createApp } from "@agentick/app-next/react";
 *
 * const app = await createApp(<Agent />, {
 *   executor: openai("gpt-4o"),
 * });
 * ```
 *
 * Zero ceremony, React reconciler wired automatically. Adopters who
 * want to customize the reconciler (custom contributors, devtools opt-in,
 * etc.) pass an explicit `reconciler: reactReconciler({ ... })` to
 * override the default.
 *
 * Adopters using a non-React reconciler import directly from
 * `@agentick/app-next` and pass their own reconciler factory; the React-
 * specific wiring stays out of their dependency graph.
 *
 * Everything else from `@agentick/app-next` is re-exported here for
 * single-import convenience.
 */

import { reactReconciler } from "@agentick/reconciler-react-next";

import {
  createApp as baseCreateApp,
  type AppHarnessOptions,
  type CreateAppOptions,
} from "./create-app.js";
import { AppHarness } from "./harness.js";

export async function createApp<P = unknown>(
  rootElement: unknown,
  options: Omit<CreateAppOptions<P>, "reconciler"> &
    Partial<Pick<CreateAppOptions<P>, "reconciler">>,
): Promise<AppHarness<P>> {
  return baseCreateApp(rootElement, {
    reconciler: reactReconciler(),
    ...options,
  } as CreateAppOptions<P>);
}

// Re-export the rest of the public surface so adopters can pull
// everything from this subpath.
export { AppHarness, type AppHarnessOptions } from "./harness.js";
export { type CreateAppOptions } from "./create-app.js";
