import { useContext } from "react";
import type { AgentickClient } from "@agentick/client";
import { AgentickContext } from "../context";

// ============================================================================
// useClient
// ============================================================================

/**
 * Access the Agentick client from context.
 *
 * @throws If used outside of AgentickProvider
 *
 * @example
 * ```tsx
 * import { useClient } from '@agentick/react';
 *
 * function MyComponent() {
 *   const client = useClient();
 *
 *   // Direct client access for advanced use cases
 *   const handleCustomChannel = () => {
 *     const session = client.session('conv-123');
 *     const channel = session.channel('custom');
 *     channel.publish('event', { data: 'value' });
 *   };
 *
 *   return <button onClick={handleCustomChannel}>Send</button>;
 * }
 * ```
 */
export function useClient(): AgentickClient {
  const context = useContext(AgentickContext);

  if (!context) {
    throw new Error("useClient must be used within a AgentickProvider");
  }

  return context.client;
}
