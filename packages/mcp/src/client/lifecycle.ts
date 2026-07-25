/**
 * `McpLifecycle` — connection state machine + reconnect logic.
 *
 * Pure bookkeeping: holds the current state, exposes transitions, runs
 * the exponential-backoff reconnect timer. Doesn't know about MCP
 * protocol semantics — the harness owns those and feeds back state
 * changes (`onConnected`, `onDisconnected`) so the lifecycle can
 * decide what to do.
 *
 * State machine:
 *
 *   idle ──connect()──▶ connecting ──ready───▶ ready
 *                            │                   │
 *                            └──fail──┐          │ onDisconnected
 *                                     │          │
 *                                     ▼          ▼
 *                                  (max-attempts hit) ─▶ degraded
 *                                     ▲          │
 *                                     │          ▼
 *                                  ┌─reconnecting (backoff)
 *                                  │
 *                                  └──fail──┘
 *
 *   close() at any state → closed (terminal)
 *
 * `close()` is terminal — once a client is closed it cannot
 * reconnect. Adopters who want the connection back construct a fresh
 * `McpClientHarness`.
 */

import type { McpClientState, ReconnectPolicy } from "./types.js";

const DEFAULT_POLICY: Required<ReconnectPolicy> = {
  maxAttempts: 10,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
};

export interface McpLifecycleOptions {
  /** Reconnect policy. Omit to disable reconnect entirely. */
  readonly reconnect?: ReconnectPolicy;
  /**
   * Called when the lifecycle decides to reconnect. The harness owns
   * the actual connect logic — lifecycle just signals "now".
   * Returning a rejecting Promise is treated as a failed attempt and
   * schedules another retry (or transitions to `degraded`).
   */
  readonly onReconnect: () => Promise<void>;
  /**
   * Called on every state transition. The harness wires this to a bus
   * publish so subscribers observe state changes.
   */
  readonly onStateChange?: (state: McpClientState) => void;
}

export class McpLifecycle {
  private _state: McpClientState = "idle";
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private readonly policy: Required<ReconnectPolicy> | undefined;
  private readonly onReconnect: () => Promise<void>;
  private readonly onStateChange?: (state: McpClientState) => void;

  constructor(options: McpLifecycleOptions) {
    this.policy = options.reconnect ? { ...DEFAULT_POLICY, ...options.reconnect } : undefined;
    this.onReconnect = options.onReconnect;
    if (options.onStateChange) this.onStateChange = options.onStateChange;
  }

  get state(): McpClientState {
    return this._state;
  }

  /** Transition to `connecting`. Called by the harness when `connect()` starts. */
  markConnecting(): void {
    this.setState("connecting");
  }

  /**
   * Transition to `ready`. Resets the reconnect attempt counter so a
   * later disconnect starts a fresh backoff curve.
   */
  markReady(): void {
    this.reconnectAttempts = 0;
    this.setState("ready");
  }

  /**
   * Transition to `disconnected` (mid-flight transport drop). When a
   * reconnect policy is configured, schedules an attempt; otherwise
   * goes straight to `degraded`.
   *
   * No-op if the lifecycle is already `closed` (we don't reconnect a
   * client the user asked us to shut down).
   */
  markDisconnected(): void {
    if (this._state === "closed") return;
    if (!this.policy) {
      this.setState("degraded");
      return;
    }
    this.scheduleReconnect();
  }

  /**
   * Terminal shutdown. Cancels any pending reconnect timer and
   * transitions to `closed`. Idempotent.
   */
  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this._state !== "closed") this.setState("closed");
  }

  /**
   * User-initiated soft pause — distinct from `close()` (terminal)
   * and `markDisconnected()` (drops via the reconnect-with-backoff
   * curve). Cancels any pending reconnect timer, resets the attempt
   * counter, and transitions to `idle` so a subsequent
   * `markConnecting()` works without bouncing through `degraded`.
   *
   * Used by `McpClientHarness.disconnect()` to support the
   * adopter-driven "pause this connection, I'll reconnect when I
   * want" verb without firing the auto-reconnect curve.
   */
  pause(): void {
    if (this._state === "closed") return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;
    if (this._state !== "idle") this.setState("idle");
  }

  /** Test-only — fires the pending reconnect timer immediately. */
  triggerReconnectNow(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      void this.runReconnectAttempt();
    }
  }

  // ─────────── internals ───────────

  private scheduleReconnect(): void {
    if (!this.policy) return;
    if (this.reconnectAttempts >= this.policy.maxAttempts) {
      this.setState("degraded");
      return;
    }
    const delay = Math.min(
      this.policy.initialDelayMs * Math.pow(2, this.reconnectAttempts),
      this.policy.maxDelayMs,
    );
    this.reconnectAttempts++;
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.runReconnectAttempt();
    }, delay);
    // Don't keep the event loop alive purely for the reconnect timer.
    if (typeof this.reconnectTimer === "object" && "unref" in this.reconnectTimer) {
      (this.reconnectTimer as { unref(): void }).unref();
    }
  }

  private async runReconnectAttempt(): Promise<void> {
    if (this._state === "closed") return;
    try {
      await this.onReconnect();
      // Success — harness will call markReady().
    } catch {
      // Failed — schedule another (or escalate to degraded).
      this.scheduleReconnect();
    }
  }

  private setState(state: McpClientState): void {
    if (this._state === state) return;
    this._state = state;
    this.onStateChange?.(state);
  }
}
