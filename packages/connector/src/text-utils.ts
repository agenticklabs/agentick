import type { ToolConfirmationResponse } from "@agentick/shared";

/**
 * Parse a natural language confirmation response.
 *
 * Accepts common affirmative phrases ("yes", "y", "ok", "go ahead", "do it")
 * and treats everything else as denial. The full text is always passed as
 * `reason` so the model can interpret nuanced responses like
 * "yes but skip the tests".
 */
export function parseTextConfirmation(text: string): ToolConfirmationResponse {
  const lower = text.trim().toLowerCase();
  const approved =
    lower === "yes" ||
    lower === "y" ||
    lower === "ok" ||
    lower === "approve" ||
    lower === "go" ||
    lower === "go ahead" ||
    lower === "do it" ||
    lower.startsWith("yes ");

  return {
    approved,
    reason: text.trim(),
  };
}

/**
 * Format a tool confirmation request as a human-readable message.
 */
export function formatConfirmationMessage(request: {
  name: string;
  message?: string;
  arguments: Record<string, unknown>;
}): string {
  const msg = request.message ?? `Allow ${request.name} to execute?`;
  const args = Object.entries(request.arguments);
  if (args.length === 0) return msg;

  const argSummary = args
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      const short = val.length > 80 ? val.slice(0, 80) + "..." : val;
      return `  ${k}: ${short}`;
    })
    .join("\n");

  return `${msg}\n\n${argSummary}`;
}
