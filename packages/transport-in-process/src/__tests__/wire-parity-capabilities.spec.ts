/**
 * `capabilities.binaryFrames` tells the truth in BOTH modes.
 *
 * Default mode hands frames to the server side by reference, so a `Uint8Array`
 * arrives intact — binary frames genuinely work. `wireParity: true` routes every
 * frame through `JSON.parse(JSON.stringify(...))` on purpose, and a typed array
 * does not survive that: it arrives as a plain index-keyed object. The
 * capability was hardcoded `true` regardless, so a parity-mode client feature-
 * detecting `binaryFrames` was told yes and then handed mangled bytes.
 *
 * A capability is a promise about behavior. These tests assert the promise and
 * the behavior together, in each mode, so the two cannot drift apart again.
 */

import { describe, expect, it } from "vitest";
import type { JsonRpcRequest, JsonRpcResponse } from "@agentick/spec";

import { inProcessTransport, withHandshake } from "../index.js";

/** A stub handler that records the params exactly as the server side saw them. */
function recordingHandler(): {
  readonly handler: (
    req: JsonRpcRequest,
    send: (n: { method: string; params?: unknown }) => void,
  ) => Promise<JsonRpcResponse>;
  readonly seen: unknown[];
} {
  const seen: unknown[] = [];
  return {
    seen,
    handler: withHandshake(async (req) => {
      seen.push(req.params);
      return { jsonrpc: "2.0", id: req.id, result: {} };
    }),
  };
}

const BYTES = new Uint8Array([1, 2, 3]);

describe("in-process capabilities — binaryFrames reflects the mode", () => {
  it("default mode ADVERTISES binary frames and carries them intact", async () => {
    const { handler, seen } = recordingHandler();
    const transport = inProcessTransport({ handler });
    expect(transport.capabilities.binaryFrames).toBe(true);

    await transport.connect();
    await transport.request("ping", { bytes: BYTES } as never);

    const params = seen.at(-1) as { bytes: unknown };
    expect(params.bytes).toBeInstanceOf(Uint8Array);
    expect(params.bytes).toBe(BYTES);

    await transport.close();
  });

  it("wireParity mode does NOT advertise binary frames — because it mangles them", async () => {
    const { handler, seen } = recordingHandler();
    const transport = inProcessTransport({ handler, wireParity: true });
    expect(transport.capabilities.binaryFrames).toBe(false);

    await transport.connect();
    await transport.request("ping", { bytes: BYTES } as never);

    // The behavior the capability is now honest about: JSON turns the typed
    // array into a plain index-keyed object, exactly as a JSON wire would.
    const params = seen.at(-1) as { bytes: unknown };
    expect(params.bytes).not.toBeInstanceOf(Uint8Array);
    expect(params.bytes).toEqual({ 0: 1, 1: 2, 2: 3 });

    await transport.close();
  });

  it("every other capability is unchanged by the mode", async () => {
    const { handler } = recordingHandler();
    const plain = inProcessTransport({ handler });
    const parity = inProcessTransport({ handler, wireParity: true });

    const withoutBinary = ({
      binaryFrames: _binaryFrames,
      ...rest
    }: typeof plain.capabilities): Omit<typeof plain.capabilities, "binaryFrames"> => rest;

    expect(withoutBinary(parity.capabilities)).toEqual(withoutBinary(plain.capabilities));
  });
});
