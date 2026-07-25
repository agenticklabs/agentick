/**
 * Standard-Schema describing the structured reply the harness expects
 * from the elicitation client for a tool confirmation prompt. This
 * schema is what the elicitation harness re-validates the client's
 * response value against; clients render UI by introspecting the wire
 * JSON-Schema projection.
 *
 *   approved           — REQUIRED boolean. `true` = run the tool;
 *                        `false` = denial (same as outcome "declined"
 *                        but lets the client encode a deny through
 *                        the accepted+content path if they prefer).
 *   always             — Session-scoped allow-list flag. When true,
 *                        future dispatches of the same tool skip the
 *                        gate.
 *   modifiedArguments  — User edited the call before approving. The
 *                        harness re-validates these against the
 *                        tool's `inputSchema` before invoking the
 *                        handler; a validation failure converts the
 *                        approval into a `ToolValidationError`.
 *   reason             — Free-form explanation surfaced on denial.
 *
 * Validator is intentionally permissive: we accept any object that
 * carries a boolean `approved`. Clients that send extra fields
 * preserve them in `value` so future schema extensions don't break
 * older callers.
 */

import { jsonSchema } from "@agentick/spec";
import type { StandardSchemaV1 } from "@agentick/spec";

export interface ToolConfirmationReply {
  readonly approved: boolean;
  readonly always?: boolean;
  readonly modifiedArguments?: Readonly<Record<string, unknown>>;
  readonly reason?: string;
}

export const TOOL_CONFIRMATION_REPLY_SCHEMA: StandardSchemaV1<unknown, ToolConfirmationReply> =
  jsonSchema<ToolConfirmationReply>(
    {
      type: "object",
      properties: {
        approved: { type: "boolean" },
        always: { type: "boolean" },
        modifiedArguments: { type: "object" },
        reason: { type: "string" },
      },
      required: ["approved"],
      additionalProperties: true,
    },
    {
      vendor: "agentick.tool-confirmation",
      validator: (raw) => {
        if (raw === null || typeof raw !== "object") {
          return { issues: [{ message: "tool confirmation reply must be an object" }] };
        }
        const r = raw as Record<string, unknown>;
        if (typeof r.approved !== "boolean") {
          return {
            issues: [
              { message: "missing required boolean property `approved`", path: ["approved"] },
            ],
          };
        }
        if (r.always !== undefined && typeof r.always !== "boolean") {
          return {
            issues: [{ message: "`always` must be a boolean if present", path: ["always"] }],
          };
        }
        if (
          r.modifiedArguments !== undefined &&
          (r.modifiedArguments === null || typeof r.modifiedArguments !== "object")
        ) {
          return {
            issues: [
              {
                message: "`modifiedArguments` must be an object if present",
                path: ["modifiedArguments"],
              },
            ],
          };
        }
        if (r.reason !== undefined && typeof r.reason !== "string") {
          return {
            issues: [{ message: "`reason` must be a string if present", path: ["reason"] }],
          };
        }
        const reply: ToolConfirmationReply = {
          approved: r.approved,
          ...(r.always !== undefined ? { always: r.always as boolean } : {}),
          ...(r.modifiedArguments !== undefined
            ? { modifiedArguments: r.modifiedArguments as Record<string, unknown> }
            : {}),
          ...(r.reason !== undefined ? { reason: r.reason as string } : {}),
        };
        return { value: reply };
      },
    },
  );

/** `hints.kind` value clients use to dispatch to a confirm-dialog renderer. */
export const TOOL_CONFIRMATION_KIND = "tool_confirmation" as const;
