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
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: JsonRpcVersion;
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcError;
}

export type JsonRpcResponse<R = unknown> =
  | JsonRpcSuccessResponse<R>
  | JsonRpcErrorResponse;

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
export type JsonRpcFrame =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification;

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
}

// ============================================================================
// Type guards
// ============================================================================

export function isJsonRpcRequest(frame: JsonRpcFrame): frame is JsonRpcRequest {
  return "id" in frame && "method" in frame && !("result" in frame || "error" in frame);
}

export function isJsonRpcNotification(
  frame: JsonRpcFrame,
): frame is JsonRpcNotification {
  return "method" in frame && !("id" in frame);
}

export function isJsonRpcResponse(frame: JsonRpcFrame): frame is JsonRpcResponse {
  return "id" in frame && ("result" in frame || "error" in frame);
}

export function isJsonRpcSuccess<R>(
  frame: JsonRpcResponse<R>,
): frame is JsonRpcSuccessResponse<R> {
  return "result" in frame;
}

export function isJsonRpcError(frame: JsonRpcResponse): frame is JsonRpcErrorResponse {
  return "error" in frame;
}
