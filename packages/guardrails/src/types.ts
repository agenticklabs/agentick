import type { ProcedureEnvelope } from "@agentick/kernel";

export type GuardrailAction = "allow" | "deny";

export interface GuardrailRule {
  patterns: string[];
  action: GuardrailAction;
  reason?: string;
}

export interface GuardrailDecision {
  action: GuardrailAction;
  reason?: string;
}

export interface ToolGuardrailCall {
  name: string;
  input: unknown;
}

export type GuardrailClassifier = (
  call: ToolGuardrailCall,
  envelope: ProcedureEnvelope<any[]>,
) => GuardrailDecision | null | undefined | Promise<GuardrailDecision | null | undefined>;

export interface ToolGuardrailConfig {
  rules?: GuardrailRule[];
  classify?: GuardrailClassifier;
  onDeny?: (toolName: string, reason: string) => void;
}
