/**
 * WebSocket codec — JSON encode/decode with spec-validator integration.
 *
 * Untrusted decoded JSON MUST flow through `validateJsonRpcInput`
 * before the rest of the transport touches it. The codec layer
 * enforces this discipline; downstream code can treat outputs as
 * typed.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import {
  ErrorCode,
  validateJsonRpcInput,
  type JsonRpcBatch,
  type JsonRpcError,
  type JsonRpcFrame,
} from "@agentick/spec-next";

export const AGENTICK_SUBPROTOCOL = "agentick-rpc-v1";

export function encodeFrame(frame: JsonRpcFrame | JsonRpcBatch): string {
  return JSON.stringify(frame);
}

export type DecodeResult =
  | { readonly ok: true; readonly value: JsonRpcFrame | JsonRpcBatch }
  | { readonly ok: false; readonly error: JsonRpcError };

/**
 * Decode a raw WS text/binary message into a typed JSON-RPC frame
 * (or batch). Validates against the spec before returning.
 */
export function decodeFrame(raw: string | ArrayBuffer | Buffer | Uint8Array): DecodeResult {
  let text: string;
  try {
    if (typeof raw === "string") text = raw;
    else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
    else if (ArrayBuffer.isView(raw)) text = new TextDecoder().decode(raw as Uint8Array);
    else text = String(raw);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: ErrorCode.ParseError,
        message: "could not decode WS message to text",
        data: { reason: String(e) },
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: ErrorCode.ParseError,
        message: "invalid JSON",
        data: { reason: String(e) },
      },
    };
  }

  return validateJsonRpcInput(parsed);
}
