/**
 * `reactCompiler` — the `CompilerFactory` for the React reference compiler. The
 * canonical way to wire the JSX → IR pipeline into an `AppHarness` so its
 * operations ride the app's substrate (journal / bus / inbox) instead of a
 * private one.
 *
 * ```ts
 * import { createApp } from "@agentick/app";
 * import { reactCompiler } from "@agentick/compiler-react";
 *
 * const app = await createApp(<Agent />, {
 *   model: openai("gpt-4o"),
 *   compiler: reactCompiler(),
 * });
 * ```
 *
 * Or use the `@agentick/app/react` subpath, which defaults `compiler` to
 * `reactCompiler()`:
 *
 * ```ts
 * import { createApp } from "@agentick/app/react";
 * const app = await createApp(<Agent />, { model: openai("gpt-4o") });
 * ```
 *
 * The argument is the harness's own {@link CompilerHarnessOptions} — passed
 * through verbatim. Custom intrinsics go in through a `registry` (there is no
 * `contributors` array; the registry IS the collection, and registering after
 * the built-ins is what makes last-writer-wins overriding possible):
 *
 * ```ts
 * import { createBuiltInRegistry } from "@agentick/compiler";
 *
 * const registry = createBuiltInRegistry();
 * registry.register(myChartContributor); // claims <chart> in the walker
 *
 * const app = await createApp(<Agent />, {
 *   model: openai("gpt-4o"),
 *   compiler: reactCompiler({
 *     registry,
 *     // Formatter registry + the id used when an entry pins none.
 *     formatters: builtInFormatters(),
 *     defaultFormatterId: "formatter.markdown",
 *   }),
 * });
 * ```
 */

import type { CompilerFactory, CompilerFactoryDeps } from "@agentick/spec";
import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  inheritedFrom,
  generateId,
} from "@agentick/runtime";
import { CompilerHarness, type CompilerHarnessOptions } from "./harness/compiler-harness.js";

export function reactCompiler(options: CompilerHarnessOptions = {}): CompilerFactory {
  // `deps` is optional per `CompilerFactory`: a parent harness passes its
  // substrate (the normal path — that is the whole point of the factory form),
  // while a STANDALONE caller gets a private local substrate. Same fallback as
  // `defineCompiler` in `@agentick/compiler`.
  const factory = (deps?: CompilerFactoryDeps) =>
    new CompilerHarness(
      deps?.scopeId ?? `react-compiler:${generateId()}`,
      deps?.journal ?? new MemoryJournal(),
      deps?.bus ?? new LocalEventBus(),
      deps?.inbox ?? new LocalInbox(),
      // The host's cascade (ADR 93 landmine 11) — without it an app-declared
      // `onAfterCompilerRenderTree` never reaches this compiler.
      { ...options, ...inheritedFrom(deps) },
    );
  return Object.assign(factory, { compilerFactory: true as const });
}
