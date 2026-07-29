/**
 * `stdioTransport()` — server-side stdio transport factory.
 *
 * Wraps the MCP SDK's `StdioServerTransport`. One connection per
 * process (stdin / stdout pair). The factory's `listen` immediately
 * yields the single connection via the accept callback then resolves.
 *
 * Use for Mode A standalone servers and for spawned subprocess
 * deployments.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { ServerTransport } from "./types.js";

export function stdioTransport(): ServerTransport {
  let sdkTransport: StdioServerTransport | null = null;
  let closed = false;

  return {
    kind: "stdio",
    async listen(accept) {
      if (closed) {
        throw new Error("stdioTransport: cannot listen after close()");
      }
      sdkTransport = new StdioServerTransport();
      // Single-connection transport: emit the one connection
      // synchronously after listen() resolves.
      // We don't `await accept(...)` here because that would block
      // the listen() resolution; instead we kick off the accept and
      // let the harness wire it up in its own time. The SDK Server
      // will be connected to `sdkTransport` by the harness.
      void accept(sdkTransport, {
        transportKind: "stdio",
        remoteAddress: "stdio",
        // One pipe, no per-message credentials — nothing to re-authenticate against.
        credentialsPerRequest: false,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (sdkTransport) {
        await sdkTransport.close();
        sdkTransport = null;
      }
    },
  };
}
