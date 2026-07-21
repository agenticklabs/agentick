/**
 * Wire contract for CLIENT-HANDLED tool dispatch.
 *
 * A tool declared without a `handlerRef` has no server handler; the tool
 * executor relays the call to the client over the tool-call channel
 * (`session:channel:tool_call`) using the SAME correlated request/
 * response + one-way notify substrate the confirmation gate uses
 * (`BaseHarness.request` / `BaseHarness.notify`). This file is the
 * mirror of `confirmation-schema.ts`: the outbound REQUEST payload the
 * executor publishes, and the RESPONSE shape the client returns.
 *
 * The channel name is an implementation detail of WHERE this harness
 * publishes (not a cross-package protocol type), so — like
 * `ELICITATION_CHANNEL` — it lives in this package. Transport adapters,
 * devtools, and the client router (stages 2/3) subscribe by importing
 * these values verbatim.
 */

import { jsonSchema } from "@agentick/spec-next";
import type { StandardSchemaV1, ToolResultInput } from "@agentick/spec-next";

/**
 * Bare channel name passed to `BaseHarness.request` / `.notify` (they
 * prefix `session:channel:`). The confirmation flow reuses the
 * elicitation channel; client-tool dispatch gets its own.
 */
export const TOOL_CALL_CHANNEL = "tool_call" as const;

/** Fully-qualified channel name as it appears on the bus envelope. */
export const TOOL_CALL_CHANNEL_FQN = "session:channel:tool_call" as const;

/**
 * Outbound request the executor publishes for a client-handled tool.
 * The correlationId + replyTo travel in the envelope `metadata` (added
 * by `BaseHarness.request`), NOT in this payload.
 */
export interface ToolCallRequestPayload {
  readonly toolCallId: string;
  readonly name: string;
  /** The VALIDATED input (post inputSchema validation + any confirm edits). */
  readonly input: unknown;
}

/**
 * The client's answer to a `requiresResponse` tool-call request — the
 * ADR 70 result currency (`string` | `ContentBlock[]` | envelope). The
 * executor runs it through `normalizeToolResult`, so a bare array/string
 * is accepted. Delivered back as a `request-response` inbox envelope
 * keyed by the request's correlationId.
 */
export type ToolCallResponse = ToolResultInput;

/**
 * Wire JSON-Schema projection of {@link ToolCallRequestPayload} — the
 * introspectable contract stage-2/3 client routers render against.
 * Permissive on `input` (per-tool shape lives in the tool's own
 * `inputSchema`).
 */
export const TOOL_CALL_REQUEST_SCHEMA: StandardSchemaV1<unknown, ToolCallRequestPayload> =
  jsonSchema<ToolCallRequestPayload>({
    type: "object",
    properties: {
      toolCallId: { type: "string" },
      name: { type: "string" },
      input: {},
    },
    required: ["toolCallId", "name", "input"],
    additionalProperties: true,
  });
