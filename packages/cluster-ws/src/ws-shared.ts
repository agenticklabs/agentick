/**
 * Shared types and constants for the WebSocket cluster wire.
 *
 * The subprotocol name + the listener-mode discriminated union live
 * here so listener / connector / cluster modules all agree on the
 * same negotiation key without copy-paste constants.
 */

import type { Server as HttpServer } from "node:http";

/**
 * WebSocket subprotocol negotiated on the HTTP upgrade handshake.
 * Forward-compatible — when the cluster wire protocol evolves
 * incompatibly, the version suffix moves to `v2` and the broker
 * rejects v1 upgrade requests with a 426 Upgrade Required.
 */
export const AGENTICK_CLUSTER_SUBPROTOCOL = "agentick-cluster-v1";

export type WsListenerOptions =
  | {
      /**
       * Mount on an adopter-supplied HTTP server. The listener
       * attaches an upgrade handler scoped to `path`; the adopter
       * keeps ownership of every other route on the server.
       *
       * Gateway-level deployment scenario per ADR 35.
       */
      readonly httpServer: HttpServer;
      readonly path?: string;
      readonly allowedOrigins?: readonly string[];
      readonly onDiagnostic?: (name: string, payload?: unknown) => void;
      readonly host?: undefined;
      readonly port?: undefined;
    }
  | {
      /**
       * Standalone mode — the listener owns its own
       * `http.Server` bound to `host:port`. App-level fallback
       * for adopters without an existing HTTP surface.
       */
      readonly host?: string;
      readonly port: number;
      readonly path?: string;
      readonly allowedOrigins?: readonly string[];
      readonly onDiagnostic?: (name: string, payload?: unknown) => void;
      readonly httpServer?: undefined;
    };
