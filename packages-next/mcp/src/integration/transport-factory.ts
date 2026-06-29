/**
 * `TransportFactory` — deferred-construction transport for `withMCP`
 * (#154). Lets adopters synthesize a transport at session-install
 * time using session-bound resources (the elicit binding, the
 * harness's substrate scope, etc.) without writing the plumbing
 * themselves.
 *
 * The canonical use case is OAuth-over-HTTP: the SDK's HTTP transport
 * accepts an `OAuthClientProvider` whose `redirectToAuthorization`
 * needs to surface the auth URL through the session's elicit harness
 * (#134b). Pre-factory, adopters had to construct the
 * `DefaultOAuthProvider` themselves and pass `elicit: installer.elicitation.elicit`
 * into it — boilerplate they shouldn't write per session. The factory
 * pattern moves the wiring into `withMCP`'s install path.
 *
 * Non-OAuth transports still work — adopters who pre-construct a
 * stdio / in-memory / pre-authenticated HTTP transport pass it as
 * before; the factory is purely additive.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ElicitationResult, UrlElicitationRequest } from "@agentick/spec-next";

/**
 * Session-bound resources a {@link TransportFactory} can read at
 * mount time. The factory uses these to wire transport-level deps
 * (most commonly `DefaultOAuthProvider.elicit`) to the live session
 * surfaces.
 *
 * Stable shape — additive evolution only. Adopters destructure what
 * they need.
 */
export interface TransportFactoryDeps {
  /**
   * Issue a URL-mode elicit through the session's elicit harness.
   * Matches `DefaultOAuthProvider.elicit`'s signature so a factory
   * can pass it through verbatim:
   *
   *     transport: ({ elicit }) =>
   *       new StreamableHTTPClientTransport(url, {
   *         authProvider: new DefaultOAuthProvider({ elicit, ... }),
   *       }),
   */
  readonly elicit: (request: UrlElicitationRequest) => Promise<ElicitationResult<undefined>>;

  /**
   * The session's `serverId` for this MCP server (the
   * {@link McpServerConfig.serverId} the factory is constructing the
   * transport for). Lets factories namespace their internal state
   * across servers (e.g., one OAuthCallbackServer per serverId).
   */
  readonly serverId: string;
}

/**
 * Deferred transport construction. The factory runs once per session
 * during `withMCP`'s install, receives the session-bound deps, and
 * returns the SDK `Transport` for the harness to mount.
 *
 * Sync or async — adopters whose factory needs to await something
 * (e.g., starting an `OAuthCallbackServer` to allocate a port)
 * return a Promise; cheaper factories return synchronously.
 */
export type TransportFactory = (deps: TransportFactoryDeps) => Promise<Transport> | Transport;

/**
 * Structural type guard distinguishing a {@link TransportFactory}
 * (callable) from a pre-built {@link Transport} (an object with
 * `start` / `send` / `close` methods).
 *
 * Transport instances are not callable; factories are. Function-
 * typed-ness is sufficient to discriminate.
 */
export function isTransportFactory(value: Transport | TransportFactory): value is TransportFactory {
  return typeof value === "function";
}
