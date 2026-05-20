/**
 * In-memory reference implementation of `MCPBridge`.
 *
 * Tracks live `MCPConnection` registrations from framework components.
 * A single global listener set fires on any registration change OR
 * when an existing connection's status/tools/resources mutate — the
 * component is responsible for re-registering (or calling
 * `notifyMutation`) when its tracked connection changes state.
 *
 * @see packages/spec/src/protocol/hook-bridges.ts §MCPBridge
 */

import type { MCPBridge, MCPConnection, Unsubscribe } from "@agentick/spec";

export interface InMemoryMCPBridge extends MCPBridge {
  /**
   * Signal that an already-registered connection's status or
   * tool/resource set changed. Framework components call this when
   * the underlying transport notifies them of a state change.
   */
  notifyMutation(id: string): void;
}

export function inMemoryMCPBridge(): InMemoryMCPBridge {
  const connections = new Map<string, MCPConnection>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    listeners.forEach((l) => l());
  };

  return {
    register(connection): Unsubscribe {
      connections.set(connection.declaration.id, connection);
      notify();
      return () => {
        if (connections.get(connection.declaration.id) === connection) {
          connections.delete(connection.declaration.id);
          notify();
        }
      };
    },
    unregister(id) {
      if (connections.delete(id)) notify();
    },
    get(id) {
      return connections.get(id);
    },
    list(): readonly MCPConnection[] {
      return [...connections.values()];
    },
    subscribe(listener): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notifyMutation(_id) {
      notify();
    },
  };
}
