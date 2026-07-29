/**
 * `inMemoryServerTransport()` — the in-process transport.
 *
 * Differs from `InMemoryMcpTransport.createLinkedPair()` in
 * `@agentick/mcp/transport`: that one is a pure pair of `Transport` instances.
 * This one is a `ServerTransport` (listener shape) the harness mounts through
 * its normal `start()` path, with a `connect()` helper handing the client side
 * back to the caller.
 *
 * **Not only for tests.** It is also how an app hosts an MCP server *in its own
 * process* — no subprocess, no HTTP, no loopback socket. One shared harness
 * serves every connection (the harness keys per-connection state by
 * `connectionId`, each with its own SDK `Server`), and each `connect()` yields a
 * fresh pair, so a session-scoped `withMCP` transport factory can call it per
 * session and stay safe under concurrency.
 *
 * ## Identity on a trusted transport
 *
 * There is no HTTP crossing here, so no auth pre-gate runs and no header carries
 * a bearer token. The caller knows who it is instead, and says so:
 * `connect({ authenticatedUser })` FORWARD-DERIVES that identity onto the info
 * handed to `accept`, which is the same path the HTTP pre-gate uses — so
 * `ctx.mcp.user` seeds from it and tool handlers see the full record, token
 * included.
 *
 * That record reaching handlers is deliberate and is the common shape: a handler
 * calling the host's own API needs to call it AS the user. What must never carry
 * it is the journaled `IngressIdentity`, which is narrowed independently by
 * `McpServerOptions.identityProjection` — see `toIngressIdentity`. The two
 * channels are separate on purpose, and
 * `__tests__/in-memory-identity.spec.ts` pins the separation with a canary.
 */

import { omitUndefined } from "@agentick/utils";

import type { McpAuthenticatedUser } from "@agentick/spec";
import { InMemoryMcpTransport } from "../../transport/in-memory.js";

import type { ServerTransport, AcceptHandler } from "./types.js";

/**
 * Construct an in-memory server transport plus a `connect()` helper.
 * Each `connect()` call yields a fresh linked pair: the server side
 * is handed to the harness via `accept`; the client side is returned
 * to the caller for SDK Client construction.
 */
/**
 * What an in-process caller may state about a connection it is opening. Every field
 * is optional; the defaults describe an anonymous in-memory crossing.
 */
export interface InMemoryConnectOptions {
  /**
   * The authenticated caller, forward-derived onto `accept` exactly as the HTTP
   * pre-gate does — so `ctx.mcp.user` seeds from it and handlers see the full
   * record. `null` states an explicitly anonymous crossing; omitted leaves the
   * server to run its own authenticator, which on a transport with no headers
   * will find nothing.
   */
  readonly authenticatedUser?: McpAuthenticatedUser | null;
  /**
   * Metadata to surface as connection headers. There is no wire here, so this is
   * for a `ConnectionGuard` or an authorizer that branches on the same fields it
   * would over HTTP.
   */
  readonly headers?: Readonly<Record<string, string | undefined>>;
}

export interface InMemoryServerTransportHandle extends ServerTransport {
  /**
   * Open a connection: emits the server-side transport via `accept` and returns
   * the client side for an SDK `Client` to consume. Each call is an independent
   * connection, so calling it per session is the supported multi-session shape.
   */
  readonly connect: (
    options?: InMemoryConnectOptions,
  ) => Promise<InstanceType<typeof InMemoryMcpTransport>>;
}

export function inMemoryServerTransport(): InMemoryServerTransportHandle {
  let acceptCallback: AcceptHandler | null = null;
  let closed = false;

  return {
    kind: "in-memory",
    async listen(accept) {
      if (closed) {
        throw new Error("inMemoryServerTransport: cannot listen after close()");
      }
      acceptCallback = accept;
    },
    async close() {
      closed = true;
      acceptCallback = null;
    },
    async connect(options?: InMemoryConnectOptions) {
      if (closed) {
        throw new Error("inMemoryServerTransport: closed");
      }
      if (!acceptCallback) {
        throw new Error("inMemoryServerTransport: listen() not yet called");
      }
      const [clientSide, serverSide] = InMemoryMcpTransport.createLinkedPair();
      await acceptCallback(serverSide, {
        transportKind: "in-memory",
        remoteAddress: "in-memory",
        // No wire, so no per-message credential material: the identity stated at
        // `connect()` is authoritative for every crossing on this connection.
        credentialsPerRequest: false,
        // Spread only what was stated: `authenticatedUser: undefined` and an ABSENT
        // `authenticatedUser` mean different things downstream — absent lets the
        // server run its own authenticator, present-but-`null` asserts anonymity.
        ...omitUndefined({ headers: options?.headers }),
        ...("authenticatedUser" in (options ?? {})
          ? { authenticatedUser: options?.authenticatedUser }
          : {}),
      });
      return clientSide;
    },
  };
}
