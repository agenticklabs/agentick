/**
 * JSON-RPC 2.0 envelopes.
 *
 * Plain JSON-RPC 2.0 — no agentick-specific shape changes. The wire is
 * deliberately aligned with the MCP 2025-03-26 spec so a single endpoint
 * can host both protocols simultaneously (disjoint method namespaces;
 * see ADR 33 §"Method namespaces").
 *
 * @see https://www.jsonrpc.org/specification — JSON-RPC 2.0 baseline
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic — MCP wire conventions
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { SpanContext } from "../data/observability.js";

/**
 * Discriminator literal carried on every JSON-RPC frame.
 */
export type JsonRpcVersion = "2.0";

/**
 * Frame id. Spec permits string, number, or null; null is reserved for
 * responses to invalid requests so we exclude it from request types.
 */
export type JsonRpcId = string | number;

/**
 * Client → server request frame. `id` correlates the response.
 */
export interface JsonRpcRequest<P = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: P;
}

/**
 * Server → client response frame. Carries either `result` OR `error`,
 * never both. `id` matches the request's `id`.
 */
export interface JsonRpcSuccessResponse<R = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly id: JsonRpcId;
  readonly result: R;
  /** Disallowed — JSON-RPC 2.0 forbids `result` and `error` on the same frame. */
  readonly error?: never;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: JsonRpcVersion;
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcError;
  /** Disallowed — JSON-RPC 2.0 forbids `result` and `error` on the same frame. */
  readonly result?: never;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccessResponse<R> | JsonRpcErrorResponse;

/**
 * Server → client or client → server notification frame. No `id`; no
 * response expected. Used for event streaming, lifecycle signals,
 * cancellation, keepalive.
 */
export interface JsonRpcNotification<P = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly method: string;
  readonly params?: P;
}

/**
 * Standard JSON-RPC 2.0 error object. `data` carries application-specific
 * detail; agentick uses it for cursor positions, challenge metadata, etc.
 */
export interface JsonRpcError<D = unknown> {
  readonly code: number;
  readonly message: string;
  readonly data?: D;
}

/**
 * Discriminated union of every JSON-RPC frame an agentick wire emits.
 * Use `isJsonRpcRequest` / `isJsonRpcResponse` / `isJsonRpcNotification`
 * for narrowing.
 */
export type JsonRpcFrame = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/**
 * JSON-RPC 2.0 batch — array of frames sent atomically. Server responds
 * with an array of matching response frames (order need not match).
 *
 * Notifications inside a batch have no corresponding response. A batch
 * containing only notifications produces no response array.
 */
export type JsonRpcBatch = readonly JsonRpcFrame[];

/**
 * Meta-object on request params. The `_meta` key is the MCP convention
 * for carrying out-of-band hints; we use it for the LSP `$/progress`
 * pattern's progress token.
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic#meta
 */
export interface RequestMeta {
  /**
   * Client-allocated token for long-running RPCs. Server streams
   * `notifications/progress` frames correlated by this token while the
   * RPC is in flight. The final result returns on the original request's
   * `id`.
   */
  readonly progressToken?: string;
  /**
   * W3C Trace Context `traceparent` for the span this request was made inside —
   * `00-<32 hex trace>-<16 hex span>-<2 hex flags>`.
   *
   * On `_meta` rather than as a transport header so it survives every transport
   * identically: a WebSocket frame and an in-process call have nowhere to put an
   * HTTP header, and a client in another language has one place to look.
   *
   * A server that traces SHOULD parent its operation span under this, which is
   * what makes one trace span the whole turn instead of leaving a client tree
   * and a server tree to be aligned on timestamps. Absent means "no span was
   * active" — never an error, and never a reason to refuse the request.
   *
   * @see https://www.w3.org/TR/trace-context/#traceparent-header
   */
  readonly traceparent?: string;
}

// ============================================================================
// Type guards
// ============================================================================

export function isJsonRpcRequest(frame: JsonRpcFrame): frame is JsonRpcRequest {
  return "id" in frame && "method" in frame && !("result" in frame || "error" in frame);
}

export function isJsonRpcNotification(frame: JsonRpcFrame): frame is JsonRpcNotification {
  return "method" in frame && !("id" in frame);
}

export function isJsonRpcResponse(frame: JsonRpcFrame): frame is JsonRpcResponse {
  return "id" in frame && ("result" in frame || "error" in frame);
}

export function isJsonRpcSuccess<R>(frame: JsonRpcResponse<R>): frame is JsonRpcSuccessResponse<R> {
  return "result" in frame;
}

export function isJsonRpcError(frame: JsonRpcResponse): frame is JsonRpcErrorResponse {
  return "error" in frame;
}

// ============================================================================
// W3C Trace Context
// ============================================================================

/** A remote span, parsed from a `traceparent`. */
export type RemoteSpanContext = SpanContext;

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZERO_TRACE = "0".repeat(32);
const ALL_ZERO_SPAN = "0".repeat(16);

/**
 * Parse a W3C `traceparent`, or `undefined` when it is malformed.
 *
 * Lenient about VERSION and strict about everything else, per the spec: a
 * future version with extra trailing fields is still readable, so `00` is a
 * floor rather than an equality check — but `ff` is reserved and invalid.
 * All-zero ids are rejected because the spec defines them as "no span", and a
 * server that parented under one would produce a trace nobody can join.
 *
 * Total, never throws. This runs on **untrusted input** — a browser's header —
 * and a malformed value is a fact about the caller, not an error worth failing
 * their request over.
 */
export function parseTraceparent(value: string | undefined): RemoteSpanContext | undefined {
  if (value === undefined) return undefined;
  const m = TRACEPARENT.exec(value.trim().toLowerCase());
  if (m === null) return undefined;
  const [, version, traceId, spanId, flags] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version === "ff") return undefined;
  if (traceId === ALL_ZERO_TRACE || spanId === ALL_ZERO_SPAN) return undefined;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 0x01) === 1 };
}

/** Format a span context as a `traceparent`. The inverse of {@link parseTraceparent}. */
export function formatTraceparent(ctx: RemoteSpanContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}
