/**
 * Confirmation formatting + parsing — pure functions ported from v1
 * `@agentick/connector/text-utils`.
 *
 * The connector observes elicitation requests on the bus, formats them
 * for the platform (a yes/no prompt or a URL prompt), and maps the
 * user's free-text reply back to an elicitation outcome.
 *
 * The v1 model was strictly yes/no tool confirmation. v2 elicitation is
 * richer (form/url + typed values); the base connector maps a platform
 * reply to the confirmation outcome (accepted/declined). Schema-aware
 * free-form value replies (a reply text used AS the accepted value)
 * are a platform-port concern — see the TODO below.
 */

// ============================================================================
// Parsing (platform reply → decision)
// ============================================================================

export interface ConfirmationDecision {
  readonly approved: boolean;
  /** Full reply text, so the model can read nuance ("yes but skip tests"). */
  readonly reason: string;
}

/**
 * Parse a natural-language confirmation reply. Common affirmatives
 * approve; everything else denies. The raw text is always kept as
 * `reason`.
 */
export function parseTextConfirmation(text: string): ConfirmationDecision {
  const lower = text.trim().toLowerCase();
  const approved =
    lower === "yes" ||
    lower === "y" ||
    lower === "ok" ||
    lower === "okay" ||
    lower === "approve" ||
    lower === "approved" ||
    lower === "go" ||
    lower === "go ahead" ||
    lower === "do it" ||
    lower.startsWith("yes ") ||
    lower.startsWith("approve ");

  return { approved, reason: text.trim() };
}

// ============================================================================
// Formatting (elicitation request → platform prompt)
// ============================================================================

/**
 * Format an elicitation request as a human-readable prompt. Mirrors v1
 * `formatConfirmationMessage`: the message plus a compact argument
 * summary when the request carries structured hints/metadata.
 */
export function formatConfirmationMessage(request: {
  readonly message: string;
  readonly url?: string;
  readonly arguments?: Record<string, unknown>;
}): string {
  const lines: string[] = [request.message];

  if (request.arguments && Object.keys(request.arguments).length > 0) {
    const argSummary = Object.entries(request.arguments)
      .map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        const short = val.length > 80 ? `${val.slice(0, 80)}...` : val;
        return `  ${k}: ${short}`;
      })
      .join("\n");
    lines.push("", argSummary);
  }

  if (request.url) {
    lines.push("", request.url);
  }

  return lines.join("\n");
}
