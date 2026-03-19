/**
 * @agentick/sandbox-secure-exec
 *
 * V8 isolate sandbox provider using secure-exec.
 * ~3.4MB per sandbox, 16ms cold start, persistent runtime across exec() calls.
 */

export { secureExecProvider } from "./provider.js";
export type { SecureExecProviderConfig, PersistenceAdapter } from "./types.js";
export { ExecJS, SecureExecTools } from "./tools.js";
