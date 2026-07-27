/**
 * `reactCompiler` — `CompilerFactory` factory for the React reference
 * compiler. The canonical way to wire React's compiler into an
 * `AppHarness` so its events flow through the shared substrate.
 *
 * ```ts
 * import { createApp } from "@agentick/app";
 * import { reactCompiler } from "@agentick/compiler-react";
 *
 * const app = await createApp(<Agent />, {
 *   model: openai("gpt-4o"),
 *   compiler: reactCompiler({ contributors: [...customContributors] }),
 * });
 * ```
 *
 * Or use the ergonomic `@agentick/app/react` subpath which defaults
 * `compiler` to `reactCompiler()` automatically:
 *
 * ```ts
 * import { createApp } from "@agentick/app/react";
 * const app = await createApp(<Agent />, { model: openai("gpt-4o") });
 * ```
 */

import type { CompilerFactory, CompilerFactoryDeps } from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import { CompilerHarness, type CompilerHarnessOptions } from "./harness/compiler-harness.js";

export function reactCompiler(options: CompilerHarnessOptions = {}): CompilerFactory {
  // `deps` is optional per `CompilerFactory`: a parent harness passes its
  // substrate (the normal path — that is the whole point of the factory form),
  // while a STANDALONE caller gets a private local substrate. Same fallback as
  // `defineCompiler` in `@agentick/compiler`.
  const factory = (deps?: CompilerFactoryDeps) =>
    new CompilerHarness(
      deps?.scopeId ?? `react-compiler:${ulid()}`,
      deps?.journal ?? new MemoryJournal(),
      deps?.bus ?? new LocalEventBus(),
      deps?.inbox ?? new LocalInbox(),
      options,
    );
  return Object.assign(factory, { compilerFactory: true as const });
}
