/**
 * React context for Agentick client.
 *
 * @module @agentick/react/context
 */

import { createContext, useMemo, useEffect } from "react";
import { createClient } from "@agentick/client";
import type { AgentickProviderProps, AgentickContextValue } from "./types";

// ============================================================================
// Context
// ============================================================================

export const AgentickContext = createContext<AgentickContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

/**
 * Provider for Agentick client context.
 *
 * Either provide a pre-configured client or clientConfig to create one.
 *
 * @example With client config
 * ```tsx
 * import { AgentickProvider } from '@agentick/react';
 *
 * function App() {
 *   return (
 *     <AgentickProvider
 *       clientConfig={{
 *         baseUrl: 'https://api.example.com',
 *         token: 'my-token',
 *       }}
 *     >
 *       <Chat />
 *     </AgentickProvider>
 *   );
 * }
 * ```
 *
 * @example With pre-configured client
 * ```tsx
 * import { AgentickProvider } from '@agentick/react';
 * import { createClient } from '@agentick/client';
 *
 * const client = createClient({
 *   baseUrl: 'https://api.example.com',
 *   token: 'my-token',
 * });
 *
 * function App() {
 *   return (
 *     <AgentickProvider client={client}>
 *       <Chat />
 *     </AgentickProvider>
 *   );
 * }
 * ```
 *
 * @example Multiple agents with separate instances
 * ```tsx
 * // Each provider creates its own client and connection
 * function App() {
 *   return (
 *     <div className="dashboard">
 *       <AgentickProvider clientConfig={{ baseUrl: '/api/support-agent' }}>
 *         <SupportChat />
 *       </AgentickProvider>
 *
 *       <AgentickProvider clientConfig={{ baseUrl: '/api/sales-agent' }}>
 *         <SalesChat />
 *       </AgentickProvider>
 *     </div>
 *   );
 * }
 * ```
 *
 * @example Sharing a client between components
 * ```tsx
 * // Create one client, share across multiple providers
 * const sharedClient = createClient({ baseUrl: '/api/agent' });
 *
 * function App() {
 *   return (
 *     <>
 *       <AgentickProvider client={sharedClient}>
 *         <MainChat />
 *       </AgentickProvider>
 *
 *       {/* Both providers share the same client and connection * /}
 *       <AgentickProvider client={sharedClient}>
 *         <ChatSidebar />
 *       </AgentickProvider>
 *     </>
 *   );
 * }
 * ```
 */
export function AgentickProvider({
  client: providedClient,
  clientConfig,
  children,
}: AgentickProviderProps) {
  // Create client from config if not provided
  const client = useMemo(() => {
    if (providedClient) {
      return providedClient;
    }

    if (!clientConfig) {
      throw new Error("AgentickProvider requires either a client or clientConfig prop");
    }

    return createClient(clientConfig);
  }, [providedClient, clientConfig]);

  // Cleanup on unmount (only if we created the client)
  useEffect(() => {
    // Only destroy if we created it (not provided)
    if (!providedClient) {
      return () => {
        client.destroy();
      };
    }
  }, [client, providedClient]);

  const value = useMemo<AgentickContextValue>(() => ({ client }), [client]);

  return <AgentickContext.Provider value={value}>{children}</AgentickContext.Provider>;
}
