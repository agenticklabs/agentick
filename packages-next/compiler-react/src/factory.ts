/**
 * `reactCompiler` — `CompilerFactory` factory for the React reference
 * compiler. The canonical way to wire React's compiler into an
 * `AppHarness` so its events flow through the shared substrate.
 *
 * ```ts
 * import { createApp } from "@agentick/app-next";
 * import { reactCompiler } from "@agentick/compiler-react-next";
 *
 * const app = await createApp(<Agent />, {
 *   model: openai("gpt-4o"),
 *   compiler: reactCompiler({ contributors: [...customContributors] }),
 * });
 * ```
 *
 * Or use the ergonomic `@agentick/app-next/react` subpath which defaults
 * `compiler` to `reactCompiler()` automatically:
 *
 * ```ts
 * import { createApp } from "@agentick/app-next/react";
 * const app = await createApp(<Agent />, { model: openai("gpt-4o") });
 * ```
 */

import type { CompilerFactory, CompilerFactoryDeps } from "@agentick/spec-next";
import { CompilerHarness, type CompilerHarnessOptions } from "./harness/compiler-harness.js";

export function reactCompiler(options: CompilerHarnessOptions = {}): CompilerFactory {
  const factory = (deps: CompilerFactoryDeps) =>
    new CompilerHarness(deps.scopeId, deps.journal, deps.bus, deps.inbox, options);
  return Object.assign(factory, { compilerFactory: true as const });
}
