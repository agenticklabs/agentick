/**
 * runTransportConformance against the in-process transport.
 *
 * Covers the universal behavioral surface (state machine, RPC
 * correlation, multiplexed concurrent RPCs, notifications/cancelled
 * emit, subscription routing, progress streams, eviction). Wire-
 * specific tests (e.g., wireParity roundtrip) stay in smoke.spec.ts.
 */

import {
  runTransportConformance,
  type TransportConformanceFactory,
} from "@agentick/spec-conformance";

import { inProcessTransport } from "../index.js";

const factory: TransportConformanceFactory = {
  async setup(handler) {
    const transport = inProcessTransport({ handler });
    return {
      transport,
      teardown: async () => {
        /* in-process needs no server-side teardown */
      },
    };
  },
};

runTransportConformance("in-process transport", factory);
