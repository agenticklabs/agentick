import type { AgentickClient } from "@agentick/client";
import type {
  ConnectorConfig,
  ConnectorPlatform,
  ConnectorBridge,
  ConnectorStatus,
  ConnectorStatusEvent,
} from "./types.js";
import { ConnectorSession } from "./connector-session.js";

export interface ConnectorHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly status: ConnectorStatus;
  onStatus(handler: (event: ConnectorStatusEvent) => void): () => void;
}

/**
 * Wire a platform adapter to an Agentick session.
 *
 * Creates a ConnectorSession, builds the bridge, and hands it to the platform.
 * Returns start/stop controls with status reporting.
 */
export function createConnector(
  client: AgentickClient,
  platform: ConnectorPlatform,
  config: ConnectorConfig,
): ConnectorHandle {
  let session: ConnectorSession | null = null;

  // Own listener set — survives start/stop cycles, unsubs always work
  const statusListeners = new Set<(event: ConnectorStatusEvent) => void>();

  return {
    async start() {
      session = new ConnectorSession(client, config);

      // Fan out session status events to our own listeners
      session.onStatus((event) => {
        for (const listener of statusListeners) {
          listener(event);
        }
      });

      const bridge: ConnectorBridge = {
        send(text, source) {
          session?.send(text, source);
        },
        sendInput(input) {
          session?.sendInput(input);
        },
        onDeliver(handler) {
          if (!session) return () => {};
          return session.onDeliver(handler);
        },
        onConfirmation(handler) {
          if (!session) return () => {};
          return session.onConfirmation(handler);
        },
        reportStatus(status, error) {
          session?.reportStatus(status, error);
        },
        onExecutionStart(handler) {
          if (!session) return () => {};
          return session.onExecutionStart(handler);
        },
        onExecutionEnd(handler) {
          if (!session) return () => {};
          return session.onExecutionEnd(handler);
        },
        abort(reason) {
          session?.abort(reason);
        },
        destroy() {
          session?.destroy();
          session = null;
        },
      };

      try {
        await platform.start(bridge);
      } catch (err) {
        session.reportStatus("error", err as Error);
        session.destroy();
        session = null;
        throw err;
      }
    },

    async stop() {
      await platform.stop();
      session?.destroy();
      session = null;
    },

    get status(): ConnectorStatus {
      return session?.status ?? "disconnected";
    },

    onStatus(handler: (event: ConnectorStatusEvent) => void): () => void {
      statusListeners.add(handler);
      return () => statusListeners.delete(handler);
    },
  };
}
