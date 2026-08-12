/**
 * The default engine, resolved LAZILY at first use.
 *
 * `@agentick/code-host` runs a program in a subprocess of the engine the host
 * app already runs, which is why it can be the default: it adds no trust
 * boundary that was not already there. What is refused is a default that
 * ESCALATES — an implicit jail would imply containment nobody built, and an
 * implicit isolate would imply a tier nobody chose.
 *
 * The specifier is a VARIABLE, so the compiler does not make `code-host` a
 * build dependency of this package. It must not be one: `code-host` depends on
 * `code`, and a manifest edge back would be a cycle. The bare specifier
 * resolves for anyone who has the package — the workspace, the metapackage,
 * and any adopter who installed it — and resolves to nothing for anyone who
 * does not. The telemetry-OTLP autodiscovery in `@agentick/app` is the same
 * pattern.
 *
 * The dynamic import is deferred to `resolve` — the first `createContext` on
 * the session — so a `code: {}` app costs nothing at install and the absence of
 * the package surfaces at the point a program actually runs, naming the install.
 */

import type { RuntimeProvider } from "./contract.js";
import { CodeProviderMissing } from "./errors.js";

export const DEFAULT_RUNTIME_PACKAGE = "@agentick/code-host";

interface CodeHostModule {
  hostRuntime: () => RuntimeProvider;
}

/**
 * A {@link RuntimeProvider} that dynamically imports `@agentick/code-host`. The
 * import is deferred (never a build dependency — `code-host` deps this package,
 * so an edge back would be a cycle) and shared between the two entry points:
 * `capabilities()` runs at install, `resolve()` at the first program. Throws
 * {@link CodeProviderMissing} — naming the package — when it is not installed.
 */
export function resolveDefaultRuntime(): RuntimeProvider {
  let host: Promise<RuntimeProvider> | undefined;
  const load = (): Promise<RuntimeProvider> =>
    (host ??= (async () => {
      try {
        const mod = (await import(DEFAULT_RUNTIME_PACKAGE)) as CodeHostModule;
        return mod.hostRuntime();
      } catch (cause) {
        host = undefined;
        throw new CodeProviderMissing({ cause });
      }
    })());
  return {
    capabilities: async () => (await load()).capabilities(),
    resolve: async (installer) => (await load()).resolve(installer),
  };
}
