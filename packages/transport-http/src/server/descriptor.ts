/**
 * What this transport tells `initialize` callers about the wire they reached.
 * Shared by the two server edges — the `node:http` server and the
 * `fetch`-style handler — because both frame the same wire.
 *
 * `batch` is true because both edges decode JSON-RPC array bodies;
 * `streamableHttp` is true because a request carrying `_meta.progressToken`
 * is answered as an SSE stream terminated by the response frame.
 */

import type { WireServerDescriptor } from "@agentick/spec";

export const SERVER_DESCRIPTOR: WireServerDescriptor = Object.freeze({
  name: "@agentick/transport-http",
  version: "0.0.0",
  batch: true,
  streamableHttp: true,
});
