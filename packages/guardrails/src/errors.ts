import { GuardError } from "@tentickle/shared";

/**
 * Error thrown when a guardrail denies a tool execution.
 */
export class GuardrailDenied extends GuardError {
  constructor(
    public readonly toolName: string,
    reason: string,
  ) {
    super(`Tool "${toolName}" denied: ${reason}`, "guardrail", { toolName });
    this.name = "GuardrailDenied";
  }
}
