/**
 * Frame validator — turns untrusted JSON into a typed `JsonRpcFrame` or
 * a `JsonRpcError` describing why the input is malformed.
 *
 * Type guards in `json-rpc.ts` narrow already-well-formed frames; this
 * function validates frames coming off the wire (transports MUST call
 * this before treating decoded JSON as a `JsonRpcFrame`).
 *
 * Validation matches the JSON-RPC 2.0 spec strictly:
 *   - `jsonrpc` must equal the literal `"2.0"`
 *   - request: requires `id` (string|number) + `method` (string)
 *   - notification: requires `method` (string), forbids `id`
 *   - response: requires `id` (string|number|null) + exactly one of
 *     `result` / `error`
 *
 * Returns a typed result discriminated by `ok`.
 *
 * @see https://www.jsonrpc.org/specification
 */

import { ErrorCode } from "./errors.js";
import type { JsonRpcBatch, JsonRpcError, JsonRpcFrame, JsonRpcId } from "./json-rpc.js";

export type ValidateResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: JsonRpcError };

/**
 * Validate a single frame OR a batch. Per JSON-RPC 2.0, a top-level
 * array is a batch; anything else is a single frame.
 */
export function validateJsonRpcInput(input: unknown): ValidateResult<JsonRpcFrame | JsonRpcBatch> {
  if (Array.isArray(input)) {
    if (input.length === 0) {
      return invalidRequest("empty batch");
    }
    const out: JsonRpcFrame[] = [];
    for (let i = 0; i < input.length; i++) {
      const r = validateJsonRpcFrame(input[i]);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  return validateJsonRpcFrame(input);
}

/**
 * Validate a single JSON-RPC frame.
 */
export function validateJsonRpcFrame(input: unknown): ValidateResult<JsonRpcFrame> {
  if (!isObject(input)) {
    return invalidRequest("frame must be an object");
  }
  if ((input as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
    return invalidRequest('missing or invalid `jsonrpc: "2.0"`');
  }

  const hasId = "id" in input;
  const hasMethod = "method" in input;
  const hasResult = "result" in input;
  const hasError = "error" in input;

  // Response — has id (possibly null) and exactly one of result/error
  if (hasId && (hasResult || hasError) && !hasMethod) {
    return validateResponse(input);
  }

  // Request — has id and method
  if (hasId && hasMethod && !hasResult && !hasError) {
    return validateRequest(input);
  }

  // Notification — has method but no id
  if (!hasId && hasMethod && !hasResult && !hasError) {
    return validateNotification(input);
  }

  return invalidRequest("frame does not match request, response, or notification shape");
}

function validateRequest(input: Record<string, unknown>): ValidateResult<JsonRpcFrame> {
  const id = input.id;
  if (typeof id !== "string" && typeof id !== "number") {
    return invalidRequest("request `id` must be string or number");
  }
  if (typeof input.method !== "string") {
    return invalidRequest("request `method` must be a string");
  }
  if ("params" in input) {
    const p = input.params;
    if (p !== undefined && !isObject(p) && !Array.isArray(p)) {
      return invalidRequest("`params` must be an object or array");
    }
  }
  return {
    ok: true,
    value: {
      jsonrpc: "2.0",
      id: id as JsonRpcId,
      method: input.method as string,
      params: input.params,
    },
  };
}

function validateNotification(input: Record<string, unknown>): ValidateResult<JsonRpcFrame> {
  if (typeof input.method !== "string") {
    return invalidRequest("notification `method` must be a string");
  }
  if ("params" in input) {
    const p = input.params;
    if (p !== undefined && !isObject(p) && !Array.isArray(p)) {
      return invalidRequest("`params` must be an object or array");
    }
  }
  return {
    ok: true,
    value: {
      jsonrpc: "2.0",
      method: input.method as string,
      params: input.params,
    },
  };
}

function validateResponse(input: Record<string, unknown>): ValidateResult<JsonRpcFrame> {
  const id = input.id;
  if (id !== null && typeof id !== "string" && typeof id !== "number") {
    return invalidRequest("response `id` must be string, number, or null");
  }
  const hasResult = "result" in input;
  const hasError = "error" in input;
  if (hasResult === hasError) {
    return invalidRequest(
      hasResult
        ? "response cannot carry both `result` and `error`"
        : "response must carry `result` or `error`",
    );
  }
  if (hasError) {
    const err = input.error;
    if (!isObject(err)) {
      return invalidRequest("response `error` must be an object");
    }
    if (typeof (err as { code?: unknown }).code !== "number") {
      return invalidRequest("response `error.code` must be a number");
    }
    if (typeof (err as { message?: unknown }).message !== "string") {
      return invalidRequest("response `error.message` must be a string");
    }
    return {
      ok: true,
      value: {
        jsonrpc: "2.0",
        id: id as JsonRpcId,
        error: err as unknown as JsonRpcError,
      },
    };
  }
  // Success response — `result` may be anything (including null)
  return {
    ok: true,
    value: {
      jsonrpc: "2.0",
      id: id as JsonRpcId,
      result: input.result,
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function invalidRequest(reason: string): ValidateResult<never> {
  return {
    ok: false,
    error: {
      code: ErrorCode.InvalidRequest,
      message: "invalid JSON-RPC frame",
      data: { reason },
    },
  };
}
