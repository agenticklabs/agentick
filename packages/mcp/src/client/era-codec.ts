/**
 * Era codec — translates between MCP spec versions at the wire edge.
 *
 * The harness operates against ONE canonical shape (currently the
 * `draft` spec). Servers running older spec versions return shapes
 * that differ from canonical in field placement, type subsets, and
 * (rarely) semantics. An `EraCodec` adapts the wire shape to/from
 * canonical so the rest of the framework doesn't see the version
 * fan-out.
 *
 * For #2, only the `draft` codec exists — it's a passthrough since
 * canonical == draft. `2025-11-25` and `2024-11-05` codecs ship in
 * follow-up commits once we have concrete shape differences to
 * translate (the bulk of differences are minor field additions and
 * server capability declarations, NOT request/response payload
 * shape, so the codecs stay thin).
 *
 * Era selection happens AFTER `initialize` — the server's reported
 * `protocolVersion` picks the codec. Falls back to the
 * closest-older-supported when an exact match isn't available.
 */

import type { McpSpecEra, McpToolDescriptor } from "./types.js";
import { omitUndefined } from "@agentick/utils";

// ============================================================================
// EraCodec — the seam
// ============================================================================

/**
 * Codec for a specific MCP spec era. Implementations are stateless
 * pure functions — they hold no per-connection state and can be
 * shared across many McpClientHarness instances of the same era.
 */
export interface EraCodec {
  /** The MCP spec version this codec targets. */
  readonly era: McpSpecEra;

  /**
   * Decode a `tools/list` response's tool descriptor into canonical
   * form. The default `draft` codec is a passthrough; older eras may
   * remap `outputSchema` (added in 2025-11-25), drop `annotations`,
   * etc.
   */
  decodeTool(raw: Readonly<Record<string, unknown>>): McpToolDescriptor;
}

// ============================================================================
// Draft passthrough codec (default)
// ============================================================================

/**
 * Identity codec — assumes the wire shape matches our canonical
 * (draft) shape. Selected when the server reports `protocolVersion`
 * matching the draft era, or as a fallback when negotiation can't
 * narrow further.
 */
export const DraftPassthroughCodec: EraCodec = {
  era: "draft",
  decodeTool(raw) {
    const r = raw as {
      name?: unknown;
      description?: unknown;
      inputSchema?: Readonly<Record<string, unknown>>;
      outputSchema?: Readonly<Record<string, unknown>>;
      annotations?: Readonly<Record<string, unknown>>;
      execution?: { taskSupport?: "optional" | "required" | "forbidden" };
    };
    if (typeof r.name !== "string") {
      throw new Error("McpToolDescriptor: missing required `name`");
    }
    return {
      name: r.name,
      ...(typeof r.description === "string" ? { description: r.description } : {}),
      inputSchema: (r.inputSchema as Readonly<Record<string, unknown>>) ?? { type: "object" },
      ...omitUndefined({
        outputSchema: r.outputSchema,
        annotations: r.annotations,
        execution: r.execution,
      }),
    };
  },
};

// ============================================================================
// Era selection
// ============================================================================

/**
 * Pick a codec for a server-reported protocolVersion. Returns
 * `DraftPassthroughCodec` for unknown / future versions — the SDK
 * itself rejects egregiously incompatible servers at handshake time,
 * so anything we receive here is at least somewhat-compatible.
 *
 * Future eras register their codec by appending a case here. Keeping
 * the dispatch in one place avoids the polymorphic-dispatch trap of
 * "every era ships its own selector and they disagree on fallbacks."
 */
export function selectCodec(protocolVersion: string | undefined): EraCodec {
  switch (protocolVersion) {
    case "draft":
    case undefined:
      return DraftPassthroughCodec;
    // Older eras land here when their codecs ship:
    //   case "2025-11-25": return latestOfficialCodec;
    //   case "2024-11-05": return legacyCodec;
    default:
      return DraftPassthroughCodec;
  }
}
