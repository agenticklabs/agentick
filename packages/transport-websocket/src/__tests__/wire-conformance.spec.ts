import { runWireConformance } from "@agentick/spec-conformance";
import { encodeFrame } from "../shared/codec.js";

/**
 * WS codec — JSON encode/decode. We expose the raw JSON pair to the
 * conformance suite (validation runs on the suite side); the production
 * `decodeFrame` in `shared/codec.ts` additionally validates and is
 * exercised by the smoke tests.
 */
runWireConformance({
  encode: (frame) => encodeFrame(frame),
  decode: (wire) => JSON.parse(wire as string),
});
