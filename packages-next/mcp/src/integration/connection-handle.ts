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
import type { McpClientState } from "../client/types.js";

import type { McpClientHandle } from "./with-mcp.js";

/**
 * Lift a transport-level `McpClientState` (from the underlying
 * harness's lifecycle FSM) into the adopter-facing `McpConnectionStatus`.
 *
 * The two FSMs are at different abstraction layers:
 *
 *   - Harness state — wire-protocol-level: `idle / connecting / ready /
 *     degraded / reconnecting / closed`. Tracks the SDK Client's actual
 *     connection + the auto-reconnect-with-backoff machinery.
 *   - Handle status — adopter-facing: `disconnected / connecting /
 *     connected / credentials-missing / credentials-expired / error`.
 *     Layered concerns the harness doesn't know about (credential
 *     bucketing) live only on the handle.
 *
 * Mapping:
 *
 *     harness `ready`        → handle `connected`
 *     harness `connecting`   → handle `connecting`
 *     harness `reconnecting` → handle `connecting`  (visible as "trying again")
 *     harness `degraded`     → handle `error`       (transport drop, reconnect exhausted)
 *     harness `closed`       → handle `disconnected`
 *     harness `idle`         → handle `disconnected`
 *
 * Credential states (`credentials-missing` / `credentials-expired`)
 * are NOT reachable via this lift — they come from auth bucketing
 * during connect, which the harness's transport FSM doesn't see.
 * The connect path sets them explicitly before subscribing here.
 */
function harnessStateToStatus(state: McpClientState): McpConnectionStatus {
  switch (state) {
    case "ready":
      return { kind: "connected" };
    case "connecting":
    case "reconnecting":
      return { kind: "connecting" };
    case "degraded":
      return { kind: "error", reason: "transport drop; reconnect exhausted" };
    case "closed":
    case "idle":
      return { kind: "disconnected" };
  }
}

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
 * Pairs each handle with a `dispose` callback the install path uses
 * at session close to tear down the FSM + close the live harness.
 */
export interface ConnectionHandleBundle {
  readonly handle: McpClientHandle;
  /** Tear down the handle's state + close the live harness. */
  readonly dispose: () => Promise<void>;
}

export function createConnectionHandle(opts: ConnectionHandleOptions): ConnectionHandleBundle {
  let status: McpConnectionStatus = { kind: "disconnected" };
  let live: McpClientHarness | undefined;
  let inFlightConnect: Promise<void> | undefined;
  let disposed = false;
  // Unsubscribe from the live harness's state-change notifier. Set
  // after successful connect, cleared on disconnect/dispose so the
  // lift-mapping doesn't fire against a stale harness.
  let stateUnsubscribe: (() => void) | undefined;

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
      let pendingHarness: McpClientHarness | undefined;
      try {
        pendingHarness = await opts.makeHarness();
        await pendingHarness.connect();
        // Race check: a concurrent `disconnect()` / `dispose()` could
        // have moved status away from `connecting` while we awaited
        // makeHarness + harness.connect(). If it did, the user's
        // intent wins — close the late-arriving harness and bail
        // without touching status.
        if (status.kind !== "connecting") {
          try {
            await pendingHarness.close();
          } catch {
            /* close errors moot — handle already moved on */
          }
          return;
        }
        live = pendingHarness;
        // Run the post-connect hook BEFORE emitting `connected` so
        // subscribers reacting to the status see a fully-prepared
        // server (tools discovered, registrations applied). The hook
        // is wrapped in try/catch so discovery failure doesn't change
        // the connection-status outcome — the connection itself
        // succeeded; tool discovery is a separate concern.
        if (opts.onConnected) {
          try {
            await opts.onConnected(pendingHarness);
          } catch {
            // Tool-discovery failures are non-fatal for connection
            // status. Adopters watching for "tools registered"
            // subscribe to the ToolExecutor's registration stream,
            // not to this handle's status.
          }
        }
        // Race check again: onConnected can await arbitrarily long.
        if (status.kind !== "connecting") {
          try {
            await pendingHarness.close();
          } catch {
            /* close errors moot */
          }
          live = undefined;
          return;
        }
        setStatus({ kind: "connected" });
        // Lift subsequent transport-level transitions (mid-session
        // disconnects, auto-reconnect-with-backoff via the harness's
        // ReconnectPolicy) into the adopter-facing status. Without
        // this subscription, the handle would stay `connected`
        // forever even if the transport silently dropped.
        const subscribed = pendingHarness;
        stateUnsubscribe = subscribed.onStateChange((harnessState) => {
          if (disposed) return;
          const lifted = harnessStateToStatus(harnessState);
          if (lifted.kind === status.kind) return;
          setStatus(lifted);
        });
      } catch (err) {
        // Race-protected: only bump to `error` if status is still
        // `connecting`. A concurrent disconnect would have set
        // status to `disconnected`; don't clobber the user's intent.
        // 277b minimum: any failure → error. Credentials-aware
        // bucketing (credentials-missing / credentials-expired)
        // lands when the OAuth provider write-through to
        // bridges.credentials ships.
        if (status.kind === "connecting") {
          setStatus({ kind: "error", reason: reasonOf(err) });
        }
        throw err;
      } finally {
        inFlightConnect = undefined;
      }
    })();
    return inFlightConnect;
  };

  const disconnect = async (): Promise<void> => {
    if (status.kind === "disconnected") return;
    // Drop the harness-state subscription first — once we close the
    // harness, its terminal `closed` state would fire here and
    // re-overwrite the `disconnected` we set below.
    stateUnsubscribe?.();
    stateUnsubscribe = undefined;
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
    stateUnsubscribe?.();
    stateUnsubscribe = undefined;
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

  return { handle, dispose };
}
