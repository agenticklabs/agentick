/**
 * `@agentick/code-secure-exec` — run model-authored code in an in-process V8
 * isolate that contains BY CONSTRUCTION.
 *
 * ```ts
 * import { withCode } from "@agentick/code";
 * import { secureExec } from "@agentick/code-secure-exec";
 *
 * const app = createApp(Agent, {
 *   extensions: [withCode({ runtime: secureExec({ language: "typescript" }) })],
 * });
 * ```
 *
 * There is no filesystem, no network, no `require`, no `process`, no host global
 * inside the isolate — only the bindings you inject. That is why it needs no OS
 * jail: see the README on containment, and on what it does NOT contain (CPU and
 * memory are bounded by budgets, not removed).
 */

export { secureExec } from "./runtime.js";
export {
  isolateCapabilities,
  DEFAULT_MEMORY_LIMIT_MB,
  type SecureExecConfig,
} from "./capabilities.js";
export { compiler, type IsolateLanguage, type Compiled } from "./language.js";
