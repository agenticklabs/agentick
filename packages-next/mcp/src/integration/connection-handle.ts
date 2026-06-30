/**
 * `createConnectionHandle` — builds an {@link McpClientHandle} backed
 * by a real status FSM + change-notification fan-out, on top of an
 * `McpClientHarness` factory that can be re-invoked across
 * disconnect/reconnect cycles.
 *
 * Status transitions (#277 locked design):
 *
 *   disconnected → connecting →
 *      transport ready  → connected
 *      anything else    → error              (transport / network)
 *
 * `credentials-missing` / `credentials-expired` are reachable once
 * the credentials harness wire-through lands (#277b's follow-up
 * slice — for now, all connect failures bucket into `error`).
 *
 * `reauthenticate()` is intentionally still a throwing stub. It
 * requires the OAuth provider to write through to the substrate
 * credentials harness, which is its own concern — separate from the
 * lifecycle work shipped here.
 */

import { createNotifier, type Notifier } from "@agentick/pubsub-next";

import type { McpClientHarness } from "../client/harness.js";
import type { McpConnectionStatus, StatusUnsubscribe } from "../client/connection-status.js";

import type { McpClientHandle } from "./with-mcp.js";

/**
 * Recreate the underlying harness — invoked by `connect()` /
 * `reconnect()`. Each invocation MUST produce a fresh `McpClientHarness`
 * bound to a fresh transport (factory-backed transports satisfy this
 * automatically; pre-built single-use transports cannot be reconnected
 * and will fail on the second invocation — adopters who need
 * reconnect support use a `TransportFactory`).
 */
export type ClientHarnessFactory = () => Promise<McpClientHarness>;

export interface ConnectionHandleOptions {
  readonly serverId: string;
  readonly makeHarness: ClientHarnessFactory;
  /**
   * Optional hook invoked after a successful `connect()` (status
   * just transitioned to `connected`). The install path uses this to
   * discover tools + register them with the session's ToolExecutor.
   * Receives the freshly-constructed harness.
   */
  readonly onConnected?: (harness: McpClientHarness) => Promise<void> | void;
}

/**
 * Internal record paired with each handle — holds the currently-live
 * harness reference (or undefined when disconnected) for the install
 * path's cleanup and tool-discovery use. Returned alongside the
 * handle so the install loop can drive the right harness reference.
 */
export interface ConnectionHandleBundle {
  readonly handle: McpClientHandle;
  /** Currently-mounted harness, if any — `undefined` after disconnect/error. */
  readonly current: () => McpClientHarness | undefined;
  /** Tear down the handle's state + close the live harness. */
  readonly dispose: () => Promise<void>;
}

export function createConnectionHandle(opts: ConnectionHandleOptions): ConnectionHandleBundle {
  let status: McpConnectionStatus = { kind: "disconnected" };
  let live: McpClientHarness | undefined;
  let inFlightConnect: Promise<void> | undefined;
  let disposed = false;

  const changes: Notifier<McpConnectionStatus> = createNotifier<McpConnectionStatus>();

  const setStatus = (next: McpConnectionStatus): void => {
    if (disposed) return;
    status = next;
    changes.notify(next);
  };

  const reasonOf = (err: unknown): string => {
    if (err instanceof Error) return err.message;
    return String(err);
  };

  const connect = async (): Promise<void> => {
    if (disposed) {
      throw new Error(
        `McpClientHandle ${opts.serverId}: cannot connect after dispose; handle is terminal`,
      );
    }
    if (status.kind === "connected") return;
    if (inFlightConnect) return inFlightConnect;

    setStatus({ kind: "connecting" });
    inFlightConnect = (async () => {
      try {
        const harness = await opts.makeHarness();
        await harness.connect();
        live = harness;
        setStatus({ kind: "connected" });
        if (opts.onConnected) {
          // Run the post-connect hook OUTSIDE the inFlightConnect
          // guard — if the hook errors, we still consider the
          // connection itself successful (tools failing to discover
          // is a degraded mode, not a connection failure). Adopter
          // can subscribe to bus envelopes for that signal.
          try {
            await opts.onConnected(harness);
          } catch {
            // Swallow — connection itself succeeded; tool-discovery
            // failures are a separate concern.
          }
        }
      } catch (err) {
        // 277b minimum: any failure → error. Credentials-aware
        // bucketing (credentials-missing / credentials-expired)
        // lands when the OAuth provider write-through to
        // bridges.credentials ships.
        setStatus({ kind: "error", reason: reasonOf(err) });
        throw err;
      } finally {
        inFlightConnect = undefined;
      }
    })();
    return inFlightConnect;
  };

  const disconnect = async (): Promise<void> => {
    if (status.kind === "disconnected") return;
    // Cancel any in-flight connect — its outcome is moot.
    inFlightConnect = undefined;
    const harness = live;
    live = undefined;
    setStatus({ kind: "disconnected" });
    if (harness) {
      try {
        await harness.close();
      } catch {
        // Close errors are diagnostic, not actionable — we've
        // already moved the handle to disconnected; surfacing a
        // throw here would only confuse adopters.
      }
    }
  };

  const reconnect = async (): Promise<void> => {
    await disconnect();
    await connect();
  };

  const reauthenticate = async (): Promise<void> => {
    throw new Error(
      `McpClientHandle ${opts.serverId}: reauthenticate — not yet implemented; lands with #277b OAuth provider write-through to bridges.credentials`,
    );
  };

  const handle: McpClientHandle = {
    serverId: opts.serverId,
    get harness(): McpClientHarness {
      if (!live) {
        throw new Error(
          `McpClientHandle ${opts.serverId}: harness reference not available — status is "${status.kind}". Call connect() first.`,
        );
      }
      return live;
    },
    get status(): McpConnectionStatus {
      return status;
    },
    onStatusChange(listener: (s: McpConnectionStatus) => void): StatusUnsubscribe {
      return changes.subscribe(listener);
    },
    connect,
    disconnect,
    reconnect,
    reauthenticate,
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    inFlightConnect = undefined;
    const harness = live;
    live = undefined;
    changes.clear();
    if (harness) {
      try {
        await harness.close();
      } catch {
        // See disconnect() — close errors are non-actionable here.
      }
    }
  };

  return {
    handle,
    current: () => live,
    dispose,
  };
}
