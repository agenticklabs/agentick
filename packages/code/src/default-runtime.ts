/**
 * The default provider, resolved at install.
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
 * does not, which is the whole contract. The telemetry-OTLP autodiscovery in
 * `@agentick/app` is the same pattern.
 */

import type { Runtime } from "./contract.js";

export const DEFAULT_RUNTIME_PACKAGE = "@agentick/code-host";

/** The default provider, or `undefined` if it is not installed. Never throws. */
export async function resolveDefaultRuntime(): Promise<Runtime | undefined> {
  const specifier = DEFAULT_RUNTIME_PACKAGE;
  try {
    const mod = (await import(specifier)) as { hostRuntime: () => Runtime };
    return mod.hostRuntime();
  } catch {
    return undefined;
  }
}
