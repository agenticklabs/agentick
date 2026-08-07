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
export function buildHandshakeInitializeResult(claimedClientId?: string): InitializeResult {
  return {
    protocolVersion: "v1",
    capabilities: {
      // Mirrors what the real dispatcher answers (`initialize` in
      // `@agentick/transport`): resume is not implemented server-side, so it
      // is never advertised — a stub that claimed it would teach tests to
      // feature-gate on a flag production never sets.
      cursorResume: false,
      subscriptions: true,
      progress: true,
      cancellation: true,
    },
    serverInfo: { name: "@agentick/transport-in-process", version: "0.0.0" },
    connectionId: `conn-inproc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    // Echoed back so a client sees the id it will be addressed by. The stub
    // binds whatever is claimed; a real server scopes the claim to a principal.
    clientId: claimedClientId ?? `client-inproc-${Date.now()}`,
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
  const initResult = overrides?.initialize;
  const listResult = overrides?.extensionsList ?? buildHandshakeExtensionsListResult();

  return async (req: JsonRpcRequest, sendNotification): Promise<JsonRpcResponse> => {
    if (req.method === "initialize") {
      // Echo the claimed id when there is no override, so a client here sees
      // the same value it will be addressed by — the stub's own binding.
      const claimed = (req.params as { clientId?: unknown } | undefined)?.clientId;
      return {
        jsonrpc: "2.0",
        id: req.id,
        result:
          initResult ??
          buildHandshakeInitializeResult(typeof claimed === "string" ? claimed : undefined),
      };
    }
    if (req.method === "_extensions/list") {
      return { jsonrpc: "2.0", id: req.id, result: listResult };
    }
    return inner(req, sendNotification);
  };
}
