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
 *
 * That rule governs the CLOSED capability set only. `capabilities.
 * extensions` (`McpServerOptions.extensions`) is an open namespace of
 * spec extensions whose surfaces the harness cannot see, so it is merged
 * verbatim and the adopter owns the truth of the claim.
 */

import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

import type { McpServerCapabilitiesOptions, McpServerExtensionsOptions } from "../config.js";

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
  /** True iff the `completions` slot carries at least one handler. */
  readonly completions: boolean;
  /** True iff structured logging is enabled (default ON). */
  readonly logging: boolean;
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
 *   4. `extensions` is merged VERBATIM under `capabilities.extensions`.
 *      Rules 1–3 do not apply: an extension's surface is invisible to the
 *      harness, so there is no wiring fact to check a claim against and
 *      the adopter owns its truth. Omitted entirely when absent or empty
 *      — an empty `extensions: {}` advertises nothing, so it stays off
 *      the wire.
 */
export function buildCapabilities(
  wired: WiredCapabilities,
  override: McpServerCapabilitiesOptions | undefined,
  extensions?: McpServerExtensionsOptions,
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

  // Tasks (#171d.3) — advertise server-side tasks capability when at
  // least one tool declares taskSupport: "required" | "supported". The
  // SDK's `assertRequestHandlerCapability` check (tasks/get + friends)
  // requires this key be present on the server. Pattern B clients gate
  // their `tools/call` task-mode opt-in on this advertisement.
  if (wired.tasks && override?.tasks !== false) {
    // The shape MUST mirror the SDK `ServerTasksCapabilitySchema`
    // (types.d.ts): `list` (tasks/list), `cancel` (tasks/cancel), and
    // `requests.tools.call` (task creation for tools/call). The last is
    // load-bearing: the SDK's `assertToolsCallTaskCapability` rejects a
    // task-augmented `tools/call` unless `tasks.requests.tools.call` is
    // present — an empty `{}` here made our OWN client's `callToolAsTask`
    // fail against our OWN server. All three request types the server
    // serves are advertised.
    (out as ServerCapabilities & { tasks?: Record<string, unknown> }).tasks = {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    };
  }

  // Completions — advertised when the `completions` slot carries at
  // least one argument handler. The SDK gates the `completion/complete`
  // request handler on this key. Empty shape per spec.
  if (wired.completions && override?.completions !== false) {
    out.completions = {};
  }

  // Logging — advertised by default (every request context gets a
  // `ctx.log` sink). The SDK gates both the `logging/setLevel` request
  // handler AND `notifications/message` emission on this key. Empty
  // shape per spec.
  if (wired.logging && override?.logging !== false) {
    out.logging = {};
  }

  // Spec extensions (`capabilities.extensions`) — adopter-declared, not
  // harness-derived. Copied rather than aliased so a later mutation of
  // the adopter's config object cannot retroactively change what an
  // already-negotiated connection advertised.
  if (extensions !== undefined && Object.keys(extensions).length > 0) {
    out.extensions = { ...extensions };
  }

  return out;
}
