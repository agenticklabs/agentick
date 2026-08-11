/**
 * `@agentick/code-host` — run model-authored code in a subprocess of the
 * engine the host app already runs.
 *
 * ```ts
 * import { withCode } from "@agentick/code";
 * import { hostRuntime } from "@agentick/code-host";
 *
 * const app = createApp(Agent, { extensions: [withCode({ runtime: hostRuntime() })] });
 * ```
 *
 * The engine is `process.execPath` — node or bun, whichever is running — and
 * the difference between them is declared as a capability difference, not
 * hidden. This is not a jail: see the README on placement.
 */

export { hostRuntime, type HostRuntimeConfig } from "./host-runtime.js";
export { detectEngine, hostCapabilities, type HostEngine } from "./engine.js";
export {
  childProcessPort,
  type HostProcess,
  type HostProcessPort,
  type HostSpawnRequest,
} from "./host-process-port.js";
