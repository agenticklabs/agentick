/**
 * Capability negotiation — what the server advertises in `initialize`.
 *
 * Harness-driven (per ADR 40 §8): only advertise what's actually
 * wired. For the MVP slice (#171c) this means `tools` only — prompts,
 * resources, elicitation, sampling, tasks land as their projection
 * modules are added in #171d+.
 *
 * Adopters can opt OUT of an otherwise-advertised capability via
 * `McpServerConfig.capabilities.<name> = false`. Setting `= true`
 * does NOT enable capabilities the framework can't actually serve —
 * the wire reflects what's plumbed, not what's wished for.
 */

import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerCapabilitiesConfig } from "@agentick/spec-next";

/**
 * What the projection layer has wired. Each flag answers "can the
 * server actually serve this MCP capability if a client asks?"
 */
export interface WiredCapabilities {
  readonly tools: boolean;
  readonly prompts: boolean;
  readonly resources: boolean;
  readonly elicitation: boolean;
  readonly sampling: boolean;
  readonly tasks: boolean;
}

/**
 * Build the SDK `ServerCapabilities` object advertised in `initialize`.
 *
 * Rules:
 *   1. Start from `wired` — only capabilities whose projection modules
 *      are actually attached.
 *   2. Adopter `override.X = false` removes the capability even if wired.
 *   3. Adopter `override.X = true` is a NO-OP when not wired (no lying
 *      on the wire).
 */
export function buildCapabilities(
  wired: WiredCapabilities,
  override: McpServerCapabilitiesConfig | undefined,
): ServerCapabilities {
  const out: ServerCapabilities = {};

  if (wired.tools && override?.tools !== false) {
    out.tools = { listChanged: true };
  }
  if (wired.prompts && override?.prompts !== false) {
    out.prompts = { listChanged: true };
  }
  if (wired.resources && override?.resources !== false) {
    out.resources = { listChanged: true, subscribe: true };
  }

  // NOTE: `sampling` and `elicitation` are CLIENT capabilities in MCP,
  // not server. The server uses them by issuing server-initiated
  // requests when the CLIENT has advertised support — there's no
  // server-side capability flag to set here. v2's `wired.elicitation`
  // / `wired.sampling` track whether the harness can ISSUE those when
  // appropriate, surfaced through ctx-side APIs (ctx.elicit /
  // ctx.sample) installed in #171d. The wire shape stays correct.

  // Tasks is era-aware — exposed via `_meta`/extension fields on the
  // wire rather than a top-level capability key in `2025-11-25`. Add
  // here when #171d wires tasks projection + we settle the era-codec.

  return out;
}
