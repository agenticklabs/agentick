/**
 * `isolateRuntimeInstance()` — resolve the session-blind {@link secureExec}
 * provider to a live {@link Runtime}, for tests and probes that drive the
 * isolate directly rather than through a session.
 *
 * `secureExec` ignores the installer and resolves synchronously, so this hands
 * back a runtime with no session in sight — the exact peer of code-host's
 * `hostRuntimeInstance`.
 */

import type { Runtime } from "@agentick/code";
import type { SessionInstaller } from "@agentick/spec";

import { secureExec } from "../runtime.js";
import type { SecureExecConfig } from "../capabilities.js";

const SESSION_BLIND = {} as SessionInstaller;

export function isolateRuntimeInstance(config: SecureExecConfig = {}): Runtime {
  return secureExec(config).resolve(SESSION_BLIND) as Runtime;
}
