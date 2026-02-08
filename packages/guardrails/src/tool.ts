import { createGuard } from "@agentick/kernel";
import type { Middleware } from "@agentick/kernel";
import type { ToolGuardrailConfig } from "./types";
import { GuardrailDenied } from "./errors";
import { evaluateRules } from "./policy";

/**
 * Create middleware that gates tool execution with static rules and/or a classifier.
 *
 * Evaluation order:
 * 1. Static rules (first-match-wins). If a rule matches:
 *    - `deny` → throw `GuardrailDenied`
 *    - `allow` → skip classifier, proceed
 * 2. Classifier (if no rule matched). If it returns `{ action: "deny" }`:
 *    - throw `GuardrailDenied`
 * 3. Default: allow
 *
 * Only intercepts procedures with `operationName === "tool:run"`.
 * Other procedures pass through unmodified.
 *
 * @example
 * ```typescript
 * import { toolGuardrail, deny, allow } from "@agentick/guardrails";
 *
 * const guardrail = toolGuardrail({
 *   rules: [
 *     deny("file_delete", "exec_*"),
 *     allow("file_read", "file_write"),
 *   ],
 *   classify: async (call) => {
 *     if (call.input?.dangerous) return { action: "deny", reason: "Dangerous input" };
 *     return null; // allow by default
 *   },
 * });
 *
 * app.use(guardrail);
 * ```
 */
export function toolGuardrail(config: ToolGuardrailConfig): Middleware {
  const { rules = [], classify, onDeny } = config;

  return createGuard({ name: "tool-guardrail", guardType: "guardrail" }, async (envelope) => {
    if (envelope.operationName !== "tool:run") return true;

    const toolName = (envelope.metadata?.toolName ?? "") as string;
    const toolInput = envelope.args[0];

    // Tier 1: Static rules (first-match-wins)
    const matched = evaluateRules(toolName, rules);
    if (matched) {
      if (matched.action === "deny") {
        const reason = matched.reason ?? "denied by rule";
        onDeny?.(toolName, reason);
        throw new GuardrailDenied(toolName, reason);
      }
      // allow — skip classifier
      return true;
    }

    // Tier 2: Classifier
    if (classify) {
      const decision = await classify({ name: toolName, input: toolInput }, envelope);
      if (decision?.action === "deny") {
        const reason = decision.reason ?? "denied by classifier";
        onDeny?.(toolName, reason);
        throw new GuardrailDenied(toolName, reason);
      }
    }

    return true;
  });
}
