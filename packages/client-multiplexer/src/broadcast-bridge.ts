/**
 * Broadcast Bridge
 *
 * Handles inter-tab communication via BroadcastChannel.
 * Used for forwarding requests from followers to leader and events back.
 */

import type { TransportEventData } from "@tentickle/client";
import type { SendInput, ChannelEvent, ToolConfirmationResponse } from "@tentickle/client";

// ============================================================================
// Message Types
// ============================================================================

export type BridgeMessage =
  // Leadership coordination
  | { type: "leader:collecting_subscriptions"; tabId: string } // Leader asking for subscriptions (not ready yet)
  | { type: "leader:transport_ready"; tabId: string } // Leader's transport is connected and ready
  | { type: "ping:leader"; tabId: string } // Follower asking if there's a ready leader
  | { type: "pong:leader"; tabId: string } // Leader responding (only sent if transport ready)
  | { type: "subscriptions:announce"; tabId: string; sessions: string[]; channels: string[] }

  // Request forwarding (follower → leader)
  | { type: "request:send"; requestId: string; tabId: string; sessionId: string; input: SendInput }
  | { type: "request:subscribe"; requestId: string; tabId: string; sessionId: string }
  | { type: "request:unsubscribe"; requestId: string; tabId: string; sessionId: string }
  | { type: "request:abort"; requestId: string; tabId: string; sessionId: string; reason?: string }
  | { type: "request:close"; requestId: string; tabId: string; sessionId: string }
  | {
      type: "request:toolResult";
      requestId: string;
      tabId: string;
      sessionId: string;
      toolUseId: string;
      result: ToolConfirmationResponse;
    }
  | {
      type: "request:channelSubscribe";
      requestId: string;
      tabId: string;
      sessionId: string;
      channel: string;
    }
  | {
      type: "request:channelPublish";
      requestId: string;
      tabId: string;
      sessionId: string;
      channel: string;
      event: ChannelEvent;
    }

  // Responses (leader → specific follower)
  | { type: "response"; requestId: string; ok: true; result?: unknown }
  | { type: "response"; requestId: string; ok: false; error: string }

  // Event broadcasting (leader → all)
  | { type: "event"; event: TransportEventData }

  // Send stream events (leader → specific follower)
  | { type: "stream:event"; requestId: string; event: TransportEventData }
  | { type: "stream:end"; requestId: string }
  | { type: "stream:error"; requestId: string; error: string };

export type MessageHandler = (message: BridgeMessage) => void;

// ============================================================================
// Broadcast Bridge
// ============================================================================

export interface BroadcastBridge {
  readonly tabId: string;

  /** Send a message to all tabs */
  broadcast(message: BridgeMessage): void;

  /** Register handler for incoming messages */
  onMessage(handler: MessageHandler): () => void;

  /**
   * Collect responses from all tabs within a timeout.
   * Useful for gathering subscription announcements during failover.
   */
  collectResponses<T extends BridgeMessage>(messageType: T["type"], timeout: number): Promise<T[]>;

  /** Close the bridge */
  close(): void;
}

export function createBroadcastBridge(channelName: string, tabId: string): BroadcastBridge {
  const channel = new BroadcastChannel(`tentickle:bridge:${channelName}`);
  const handlers = new Set<MessageHandler>();

  channel.onmessage = (event) => {
    const message = event.data as BridgeMessage;
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (e) {
        console.error("Error in bridge message handler:", e);
      }
    }
  };

  return {
    get tabId() {
      return tabId;
    },

    broadcast(message: BridgeMessage): void {
      channel.postMessage(message);
    },

    onMessage(handler: MessageHandler): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    collectResponses<T extends BridgeMessage>(
      messageType: T["type"],
      timeout: number,
    ): Promise<T[]> {
      return new Promise((resolve) => {
        const responses: T[] = [];

        const cleanup = this.onMessage((msg) => {
          if (msg.type === messageType) {
            responses.push(msg as T);
          }
        });

        setTimeout(() => {
          cleanup();
          resolve(responses);
        }, timeout);
      });
    },

    close(): void {
      channel.close();
      handlers.clear();
    },
  };
}

// ============================================================================
// Request Helper
// ============================================================================

let requestIdCounter = 0;

export function generateRequestId(tabId: string): string {
  return `${tabId}-${++requestIdCounter}`;
}
