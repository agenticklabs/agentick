/**
 * Wire conformance — any transport that round-trips JSON-RPC frames
 * passes this suite. Validates frame parsing, mutual-exclusion, batch
 * handling, and that the transport produces frames the spec validator
 * accepts.
 *
 * Transports invoke this from their own test file:
 *
 * ```ts
 * import { runWireConformance } from "@agentick/spec-conformance-next";
 * import { encodeFrame, decodeFrame } from "../src/codec";
 *
 * runWireConformance({ encode: encodeFrame, decode: decodeFrame });
 * ```
 *
 * The factory takes an encode/decode pair so each transport is exercised
 * in its native serialization (WS JSON frames, SSE `data:` lines,
 * Unix-socket newline-delimited JSON, in-process direct pass).
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  validateJsonRpcFrame,
  validateJsonRpcInput,
  type JsonRpcFrame,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  type JsonRpcNotification,
} from "@agentick/spec-next";

/**
 * Transport codec under test. `encode` serializes a frame for the wire;
 * `decode` parses it back. For text-based transports, both are JSON.
 * For in-process direct-pass, both are identity functions.
 */
export interface WireCodec {
  encode(frame: JsonRpcFrame): string | unknown;
  decode(wire: string | unknown): unknown;
}

/**
 * Run the wire conformance suite against a transport's codec. Mounts
 * a `describe` block named "wire conformance" with all test cases.
 */
export function runWireConformance(codec: WireCodec): void {
  describe("wire conformance", () => {
    // Representative frames covering all four frame kinds.
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: {},
    };
    const success: JsonRpcSuccessResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    };
    const errorRes: JsonRpcErrorResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: ErrorCode.MethodNotFound, message: "no such method" },
    };
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    };

    const sampleFrames: ReadonlyArray<JsonRpcFrame> = [
      request,
      success,
      errorRes,
      notification,
    ];

    describe("roundtrip — encode then decode survives validation", () => {
      for (const frame of sampleFrames) {
        it(`roundtrips ${frameLabel(frame)}`, () => {
          const wire = codec.encode(frame);
          const decoded = codec.decode(wire);
          const validated = validateJsonRpcFrame(decoded);
          expect(validated.ok).toBe(true);
          if (validated.ok) {
            expect(validated.value).toEqual(frame);
          }
        });
      }
    });

    describe("validator integration", () => {
      it("rejects a frame missing jsonrpc version after roundtrip", () => {
        const decoded = codec.decode(codec.encode({ id: 1, method: "ping" } as unknown as JsonRpcFrame));
        const v = validateJsonRpcFrame(decoded);
        expect(v.ok).toBe(false);
      });

      it("rejects a response with both result and error", () => {
        const malformed = {
          jsonrpc: "2.0",
          id: 1,
          result: {},
          error: { code: -32000, message: "x" },
        };
        const v = validateJsonRpcFrame(malformed);
        expect(v.ok).toBe(false);
      });
    });

    describe("batches", () => {
      it("validates a heterogeneous batch", () => {
        const batch = [request, notification];
        const v = validateJsonRpcInput(batch);
        expect(v.ok).toBe(true);
        if (v.ok) expect(Array.isArray(v.value)).toBe(true);
      });

      it("rejects an empty batch", () => {
        const v = validateJsonRpcInput([]);
        expect(v.ok).toBe(false);
      });
    });
  });
}

function frameLabel(frame: JsonRpcFrame): string {
  if ("result" in frame && !("error" in frame)) return "success response";
  if ("error" in frame && !("result" in frame)) return "error response";
  if ("id" in frame && "method" in frame) return `request (${frame.method})`;
  if ("method" in frame) return `notification (${frame.method})`;
  return "unknown";
}
