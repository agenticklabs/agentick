import type { AgentickClient } from "./client.js";
import type { ToolConfirmationResponse } from "./types.js";
import type { ToolConfirmationRequest } from "@agentick/shared";
import type {
  ToolConfirmationState,
  ToolConfirmationsOptions,
  ToolConfirmationsState,
  ConfirmationPolicy,
} from "./chat-types.js";

/**
 * Manages tool confirmation lifecycle with a configurable policy.
 *
 * Incoming confirmations are evaluated by the `ConfirmationPolicy`:
 * - `"approve"` / `"deny"` — auto-resolved, never surfaced to consumer.
 * - `"prompt"` (default) — stored as `pending` for consumer to resolve.
 *
 * **Standalone:** Self-subscribes to tool confirmations by default.
 * **Composed:** Pass `subscribe: false` and call `handleConfirmation()` from
 * a parent controller (e.g. ChatSession).
 */
export class ToolConfirmations {
  private _pending: ToolConfirmationState | null = null;
  private readonly _policy: ConfirmationPolicy;

  private _snapshot: ToolConfirmationsState;
  private _listeners = new Set<() => void>();
  private _unsubscribe: (() => void) | null = null;

  constructor(client: AgentickClient, options: ToolConfirmationsOptions = {}) {
    this._policy = options.policy ?? (() => ({ action: "prompt" as const }));
    this._snapshot = this._createSnapshot();

    if (options.subscribe !== false && options.sessionId) {
      const accessor = client.session(options.sessionId);
      this._unsubscribe = accessor.onToolConfirmation((request, respond) =>
        this.handleConfirmation(request, respond),
      );
    }
  }

  get state(): ToolConfirmationsState {
    return this._snapshot;
  }

  get pending(): ToolConfirmationState | null {
    return this._snapshot.pending;
  }

  /**
   * Handle an incoming tool confirmation. Called automatically when
   * self-subscribing, or manually by a parent controller.
   */
  handleConfirmation(
    request: ToolConfirmationRequest,
    respond: (response: ToolConfirmationResponse) => void,
  ): void {
    const decision = this._policy(request);

    if (decision.action === "approve") {
      respond({ approved: true });
      return;
    }

    if (decision.action === "deny") {
      respond({ approved: false, reason: decision.reason });
      return;
    }

    // Set new pending first, then deny the stale one.
    // Ordering matters: if staleCallback throws, new pending is still set.
    const staleCallback = this._pending?.respond;
    this._pending = { request, respond };
    if (staleCallback) {
      try {
        staleCallback({ approved: false, reason: "Superseded by new confirmation" });
      } catch (e) {
        console.error("Error auto-denying stale confirmation:", e);
      }
    }
    this._notify();
  }

  respond(response: ToolConfirmationResponse): void {
    if (!this._pending) return;
    const { respond: callback } = this._pending;
    this._pending = null;
    callback(response);
    this._notify();
  }

  onStateChange(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  destroy(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._listeners.clear();
  }

  private _createSnapshot(): ToolConfirmationsState {
    return {
      pending: this._pending,
    };
  }

  private _notify(): void {
    this._snapshot = this._createSnapshot();
    for (const listener of this._listeners) {
      try {
        listener();
      } catch (e) {
        console.error("Error in tool confirmations listener:", e);
      }
    }
  }
}
