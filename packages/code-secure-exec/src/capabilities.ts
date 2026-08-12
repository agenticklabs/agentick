/**
 * What the isolate can be held to.
 *
 * Unlike the host engine — where `memoryMb` depends on whether the running
 * engine honors a heap flag — a V8 isolate ALWAYS carries a memory ceiling, so
 * both `timeMs` (the `script.run` timeout) and `memoryMb` (the isolate's
 * `memoryLimit`) are genuinely enforced. `outputBytes` is not: the isolate
 * captures narration but does not cut it, so the budget is left undeclared and
 * the harness refuses it rather than pretending.
 */

import type { CodeBudgetKey, CodeCapabilities } from "@agentick/code";

import type { IsolateLanguage } from "./language.js";

/** The isolate's heap ceiling when a context sets no `memoryMb` budget. */
export const DEFAULT_MEMORY_LIMIT_MB = 128;

export interface SecureExecConfig {
  /**
   * What programs are written in. Default `"javascript"`. `"typescript"` STRIPS
   * types rather than checking them; see the README on checking before running.
   */
  readonly language?: IsolateLanguage;
  /**
   * The isolate's heap ceiling, in MB, for contexts that set no `memoryMb`
   * budget. Default {@link DEFAULT_MEMORY_LIMIT_MB}. A per-context `memoryMb`
   * budget overrides it.
   */
  readonly memoryLimitMb?: number;
}

const ENFORCES: readonly CodeBudgetKey[] = ["timeMs", "memoryMb"];

export function isolateCapabilities(config: SecureExecConfig = {}): CodeCapabilities {
  return {
    name: `isolate${config.language === "typescript" ? "+ts" : ""}`,
    enforces: ENFORCES,
    persistentContext: true,
  };
}
