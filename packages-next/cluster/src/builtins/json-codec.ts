/**
 * `jsonCodec()` — bundled JSON {@link ClusterCodec} factory. The
 * default codec when adopters don't specify one in
 * {@link defineCluster}.
 *
 * Encode: `new TextEncoder().encode(JSON.stringify(env))`
 * Decode: `JSON.parse(new TextDecoder().decode(raw))`
 *
 * Uniform `Uint8Array` interface across all transports — see ADR 35
 * §2 for the codec seam contract.
 */

import type { EventEnvelope, MessageEnvelope } from "@agentick/spec-next";

import type { ClusterCodec } from "../codec.js";
import type { ClusterCodecFactory } from "../factories.js";

/**
 * Construct the JSON codec factory. Stateless — produces a fresh
 * codec instance on every factory call. Adopters using JSON as the
 * default rarely need to instantiate this directly; it's the
 * default in {@link defineCluster} when no `codec` is supplied.
 */
export function jsonCodec(): ClusterCodecFactory {
  return () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const codec: ClusterCodec = {
      encode(env) {
        return encoder.encode(JSON.stringify(env));
      },
      decode(raw) {
        return JSON.parse(decoder.decode(raw)) as MessageEnvelope | EventEnvelope;
      },
    };
    return codec;
  };
}
