/**
 * `@agentick/client-extensions` — first-party extensions
 * (middleware) for `@agentick/client-core`.
 *
 * Adopters typically opt into individual behaviors via the subpath
 * exports — tree-shakeable, dependency-isolated:
 *
 * ```ts
 * import { retry } from "@agentick/client-extensions/retry";
 * import { telemetry } from "@agentick/client-extensions/telemetry";
 * import { cache } from "@agentick/client-extensions/cache";
 * import { offline } from "@agentick/client-extensions/offline";
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
