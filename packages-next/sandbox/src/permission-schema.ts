/**
 * Standard-Schema describing the structured reply the harness expects
 * from the elicitation client for a sandbox-permission prompt. This
 * schema is what the elicitation harness re-validates the client's
 * response value against; clients render UI by introspecting the wire
 * JSON-Schema projection.
 *
 * Decisions mirror the historical `SandboxPermissionResponse` union —
 * a discriminated set covering one-shot allow, session-allow,
 * pattern-allow, and the two deny modes. The harness's
 * `applyDecision()` switches on `decision` to update the session ACL.
 *
 * `pattern` is required when `decision === "allow-session-pattern"`
 * (the harness uses it as the literal allow rule); ignored otherwise.
 * `reason` is free-form, surfaces on denial telemetry.
 */

import { jsonSchema } from "@agentick/spec-next";
import type { StandardSchemaV1 } from "@agentick/spec-next";

export interface SandboxPermissionReply {
  readonly decision:
    | "allow-once"
    | "allow-session"
    | "allow-session-pattern"
    | "deny"
    | "deny-session";
  readonly pattern?: string;
  readonly reason?: string;
}

const ALLOWED_DECISIONS: ReadonlySet<SandboxPermissionReply["decision"]> = new Set([
  "allow-once",
  "allow-session",
  "allow-session-pattern",
  "deny",
  "deny-session",
]);

export const SANDBOX_PERMISSION_REPLY_SCHEMA: StandardSchemaV1<unknown, SandboxPermissionReply> =
  jsonSchema<SandboxPermissionReply>(
    {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["allow-once", "allow-session", "allow-session-pattern", "deny", "deny-session"],
        },
        pattern: { type: "string" },
        reason: { type: "string" },
      },
      required: ["decision"],
      additionalProperties: true,
    },
    {
      vendor: "agentick.sandbox-permission",
      validator: (raw) => {
        if (raw === null || typeof raw !== "object") {
          return { issues: [{ message: "sandbox permission reply must be an object" }] };
        }
        const r = raw as Record<string, unknown>;
        if (typeof r.decision !== "string" || !ALLOWED_DECISIONS.has(r.decision as never)) {
          return {
            issues: [
              {
                message: `decision must be one of ${[...ALLOWED_DECISIONS].join(" | ")}`,
                path: ["decision"],
              },
            ],
          };
        }
        const decision = r.decision as SandboxPermissionReply["decision"];
        if (decision === "allow-session-pattern" && typeof r.pattern !== "string") {
          return {
            issues: [
              {
                message: "`pattern` is required when decision === 'allow-session-pattern'",
                path: ["pattern"],
              },
            ],
          };
        }
        if (r.pattern !== undefined && typeof r.pattern !== "string") {
          return {
            issues: [{ message: "`pattern` must be a string if present", path: ["pattern"] }],
          };
        }
        if (r.reason !== undefined && typeof r.reason !== "string") {
          return {
            issues: [{ message: "`reason` must be a string if present", path: ["reason"] }],
          };
        }
        const reply: SandboxPermissionReply = {
          decision,
          ...(r.pattern !== undefined ? { pattern: r.pattern as string } : {}),
          ...(r.reason !== undefined ? { reason: r.reason as string } : {}),
        };
        return { value: reply };
      },
    },
  );

/** `hints.kind` value clients use to dispatch to a sandbox-permission renderer. */
export const SANDBOX_PERMISSION_KIND = "sandbox_permission" as const;
