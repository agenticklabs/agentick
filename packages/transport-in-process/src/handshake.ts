/**
 * `withHandshake` — wraps a stub `InProcessGatewayHandler` with
 * canned responses for the two client-connect handshake RPCs:
 * `initialize` and `_extensions/list`.
 *
 * Since `#296` landed, `client.connect()` issues both RPCs
 * automatically. Stub handlers used by tests need to respond to them
 * or the client will fail to connect. This helper composes cleanly:
 *
 * ```ts
 * const client = await createClient({
 *   transport: inProcessTransport({ handler: withHandshake(myStubHandler) }),
 * });
 * await client.connect(); // initialize + _extensions/list handled
 * ```
 *
 * The canned responses come from
 * {@link buildHandshakeInitializeResult} and
 * {@link buildHandshakeExtensionsListResult}; override them by
 * passing custom responses to the second/third argument.
 */

import type {
  ExtensionsListResult,
  InitializeResult,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@agentick/spec";

import type { InProcessGatewayHandler } from "./transport.js";

/**
 * Default `initialize` response used by {@link withHandshake} when
 * the caller doesn't supply one.
 */
export function buildHandshakeInitializeResult(): InitializeResult {
  return {
    protocolVersion: "v1",
    capabilities: {
      cursorResume: true,
      subscriptions: true,
      progress: true,
      cancellation: true,
    },
    serverInfo: { name: "@agentick/transport-in-process", version: "0.0.0" },
    connectionId: `conn-inproc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

/**
 * Default `_extensions/list` response used by {@link withHandshake}
 * — empty extension list, mimicking an older-style server. Override
 * for tests that need to exercise the discovery pipeline.
 */
export function buildHandshakeExtensionsListResult(): ExtensionsListResult {
  return { extensions: [] };
}

export interface WithHandshakeOverrides {
  readonly initialize?: InitializeResult;
  readonly extensionsList?: ExtensionsListResult;
}

/**
 * Compose a stub handler with automatic handshake responses.
 * Handshake methods (`initialize`, `_extensions/list`) resolve
 * before the wrapped handler sees them; everything else falls
 * through unchanged.
 */
export function withHandshake(
  inner: InProcessGatewayHandler,
  overrides?: WithHandshakeOverrides,
): InProcessGatewayHandler {
  const initResult = overrides?.initialize ?? buildHandshakeInitializeResult();
  const listResult = overrides?.extensionsList ?? buildHandshakeExtensionsListResult();

  return async (req: JsonRpcRequest, sendNotification): Promise<JsonRpcResponse> => {
    if (req.method === "initialize") {
      return { jsonrpc: "2.0", id: req.id, result: initResult };
    }
    if (req.method === "_extensions/list") {
      return { jsonrpc: "2.0", id: req.id, result: listResult };
    }
    return inner(req, sendNotification);
  };
}
