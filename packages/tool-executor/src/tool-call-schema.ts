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

import { jsonSchema } from "@agentick/spec";
import type { StandardSchemaV1, ToolResultInput } from "@agentick/spec";

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
  /**
   * The connection this call is addressed to — the one the turn was asked from.
   *
   * The channel still broadcasts to every attached client; this is what lets
   * each of them decide. Without it four tabs run `navigate_to` and four tabs
   * navigate, and the respond race only dedupes the ANSWER — the side effect
   * already happened four times.
   *
   * Absent when the execution had no originating connection (an in-process
   * send, a cron trigger, a spawned child), which every client should read as
   * "not addressed to anyone in particular".
   */
  readonly target?: string;
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
 * One outstanding CLIENT-HANDLED tool call awaiting a response, as it appears
 * in the channel's opening SNAPSHOT frame (§6.1 — the Design-B watch-list).
 * Carries the fields a subscriber lifts off a LIVE relay delta
 * (`metadata.correlationId` / `.replyTo`, the wire `payload`), so a client
 * seeding from the snapshot reconstructs a pending call identical to a live
 * one. Only `requiresResponse` relays are pending (they register a
 * `request()`); fire-and-forget notifies have no pending state to enumerate.
 */
export interface PendingToolCall {
  readonly correlationId: string;
  readonly replyTo: string;
  readonly payload: unknown;
}

/**
 * Opening frame of the `tool_call` request channel (§6.1 / the K8s watch-list
 * model, twin of the elicitation snapshot frame). A fresh subscriber receives
 * this FIRST — every client-handled call currently awaiting a response —
 * before any live delta, so a client that connects mid-call renders the
 * outstanding call instead of only calls relayed after it joined (the
 * live-only defect fix). Discriminated by `kind: "snapshot"`; carries no
 * top-level `toolCallId`/`name`, so today's per-call client fold (which keys
 * on those) skips it untouched (additive wire shape; slice-3 consumes it).
 */
export interface ToolCallSnapshotFrame {
  readonly kind: "snapshot";
  readonly requests: readonly PendingToolCall[];
}

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
      target: { type: "string" },
    },
    required: ["toolCallId", "name", "input"],
    additionalProperties: true,
  });
