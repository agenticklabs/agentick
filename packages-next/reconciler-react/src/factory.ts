/**
 * `reactReconciler` — `ReconcilerFactory` factory for the React reference
 * reconciler. The canonical way to wire React's reconciler into an
 * `AppHarness` so its events flow through the shared substrate.
 *
 * ```ts
 * import { createApp } from "@agentick/app-next";
 * import { reactReconciler } from "@agentick/reconciler-react-next";
 *
 * const app = await createApp(<Agent />, {
 *   executor: openai("gpt-4o"),
 *   reconciler: reactReconciler({ contributors: [...customContributors] }),
 * });
 * ```
 *
 * Or use the ergonomic `@agentick/app-next/react` subpath which defaults
 * `reconciler` to `reactReconciler()` automatically:
 *
 * ```ts
 * import { createApp } from "@agentick/app-next/react";
 * const app = await createApp(<Agent />, { executor: openai("gpt-4o") });
 * ```
 */

import type { ReconcilerFactory, ReconcilerFactoryDeps } from "@agentick/spec-next";
import { ReconcilerHarness, type ReconcilerHarnessOptions } from "./harness/reconciler-harness.js";

export function reactReconciler(options: ReconcilerHarnessOptions = {}): ReconcilerFactory {
  const factory = (deps: ReconcilerFactoryDeps) =>
    new ReconcilerHarness(deps.scopeId, deps.journal, deps.bus, deps.inbox, options);
  return Object.assign(factory, { reconcilerFactory: true as const });
}
