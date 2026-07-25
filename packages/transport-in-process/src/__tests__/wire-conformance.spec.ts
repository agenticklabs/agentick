import { runWireConformance } from "@agentick/spec-conformance";

/**
 * In-process transport's wire conformance. The codec is the identity
 * function for default mode (no serialization), and the JSON roundtrip
 * for `wireParity: true` mode. Both pass.
 */
runWireConformance({
  encode: (frame) => frame,
  decode: (wire) => wire,
});
