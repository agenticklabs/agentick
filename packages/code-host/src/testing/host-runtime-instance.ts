/**
 * `hostRuntimeInstance()` — resolve the session-blind {@link hostRuntime}
 * provider to a live {@link Runtime}, for tests and probes that drive the engine
 * directly rather than through a session.
 *
 * `hostRuntime` ignores the installer and resolves synchronously, so this hands
 * back a runtime without a session in sight. A PLACED engine (`sandboxHost`)
 * has no such shortcut — it must be reached through a real `withCode` install.
 */

import type { Runtime } from "@agentick/code";
import type { SessionInstaller } from "@agentick/spec";

import { hostRuntime, type HostRuntimeConfig } from "../host-runtime.js";

const SESSION_BLIND = {} as SessionInstaller;

export function hostRuntimeInstance(config: HostRuntimeConfig = {}): Runtime {
  return hostRuntime(config).resolve(SESSION_BLIND) as Runtime;
}
