/**
 * The remote-parent policy — what to do with a caller's `_meta.traceparent`.
 *
 * A TRUST decision, so it lives at the wire boundary rather than in the span
 * machinery. The substrate applies whichever scope field this sets and knows
 * nothing about the policy; encoding the decision in WHICH field is what keeps
 * that separation.
 *
 * @see docs/proposals/v2/client-tools.md §"Wire propagation"
 */

import { formatTraceparent, parseTraceparent, type RemoteParentPolicy } from "@agentick/spec";

/**
 * `traceparent` to adopt the caller's span as parent, `traceLink` to link to
 * it, `{}` to drop it.
 *
 * Defaults to `link`. The caller is untrusted and the header is
 * caller-controlled: adopting it means inheriting a sampling decision made by a
 * browser, and a peer that can force sampling can drive someone else's
 * telemetry bill. A link keeps the traces joinable without that.
 */
export function remoteTrace(
  params: unknown,
  policy: RemoteParentPolicy | undefined,
): { traceparent?: string } | { traceLink?: string } {
  const mode = policy ?? "link";
  if (mode === "ignore") return {};
  const meta = (params as { _meta?: { traceparent?: string } } | undefined)?._meta;
  // Re-serialised from the PARSE rather than passed through: an unparseable
  // value never reaches the substrate, and a valid one arrives normalised.
  const remote = parseTraceparent(meta?.traceparent);
  if (remote === undefined) return {};
  const value = formatTraceparent(remote);
  return mode === "parent" ? { traceparent: value } : { traceLink: value };
}
