/**
 * `@agentick/client-extensions-next` — first-party extensions
 * (middleware) for `@agentick/client-next`.
 *
 * Adopters typically opt into individual behaviors via the subpath
 * exports — tree-shakeable, dependency-isolated:
 *
 * ```ts
 * import { retry } from "@agentick/client-extensions-next/retry";
 * import { telemetry } from "@agentick/client-extensions-next/telemetry";
 * import { cache } from "@agentick/client-extensions-next/cache";
 * import { offline } from "@agentick/client-extensions-next/offline";
 * ```
 *
 * The root barrel re-exports each behavior for adopters who prefer a
 * single import site. Prefer subpaths for explicit dependency boundaries
 * and minimal bundle impact.
 *
 * Naming convention: `{layer}-extensions-next` for first-party
 * middleware bundles per layer (client, gateway, harness, ...).
 * Third-party extensions name themselves freely.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export * from "./retry/index.js";
export * from "./telemetry/index.js";
export * from "./cache/index.js";
export * from "./offline/index.js";
