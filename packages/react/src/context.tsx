/**
 * React context for Tentickle client.
 *
 * @module @tentickle/react/context
 */

import { createContext, useContext, useMemo, useEffect } from "react";
import { createClient, type TentickleClient } from "@tentickle/client";
import type { TentickleProviderProps, TentickleContextValue } from "./types.js";

// ============================================================================
// Context
// ============================================================================

const TentickleContext = createContext<TentickleContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

/**
 * Provider for Tentickle client context.
 *
 * Either provide a pre-configured client or clientConfig to create one.
 *
 * @example With client config
 * ```tsx
 * import { TentickleProvider } from '@tentickle/react';
 *
 * function App() {
 *   return (
 *     <TentickleProvider
 *       clientConfig={{
 *         baseUrl: 'https://api.example.com',
 *         token: 'my-token',
 *       }}
 *     >
 *       <Chat />
 *     </TentickleProvider>
 *   );
 * }
 * ```
 *
 * @example With pre-configured client
 * ```tsx
 * import { TentickleProvider } from '@tentickle/react';
 * import { createClient } from '@tentickle/client';
 *
 * const client = createClient({
 *   baseUrl: 'https://api.example.com',
 *   token: 'my-token',
 * });
 *
 * function App() {
 *   return (
 *     <TentickleProvider client={client}>
 *       <Chat />
 *     </TentickleProvider>
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
 *       <TentickleProvider clientConfig={{ baseUrl: '/api/support-agent' }}>
 *         <SupportChat />
 *       </TentickleProvider>
 *
 *       <TentickleProvider clientConfig={{ baseUrl: '/api/sales-agent' }}>
 *         <SalesChat />
 *       </TentickleProvider>
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
 *       <TentickleProvider client={sharedClient}>
 *         <MainChat />
 *       </TentickleProvider>
 *
 *       {/* Both providers share the same client and connection * /}
 *       <TentickleProvider client={sharedClient}>
 *         <ChatSidebar />
 *       </TentickleProvider>
 *     </>
 *   );
 * }
 * ```
 */
export function TentickleProvider({
  client: providedClient,
  clientConfig,
  children,
}: TentickleProviderProps) {
  // Create client from config if not provided
  const client = useMemo(() => {
    if (providedClient) {
      return providedClient;
    }

    if (!clientConfig) {
      throw new Error(
        "TentickleProvider requires either a client or clientConfig prop",
      );
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

  const value = useMemo<TentickleContextValue>(() => ({ client }), [client]);

  return (
    <TentickleContext.Provider value={value}>
      {children}
    </TentickleContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Access the Tentickle client from context.
 *
 * @throws If used outside of TentickleProvider
 *
 * @example
 * ```tsx
 * import { useClient } from '@tentickle/react';
 *
 * function MyComponent() {
 *   const client = useClient();
 *
 *   // Direct client access for advanced use cases
 *   const handleCustomChannel = () => {
 *     const channel = client.channel('custom');
 *     channel.publish('event', { data: 'value' });
 *   };
 *
 *   return <button onClick={handleCustomChannel}>Send</button>;
 * }
 * ```
 */
export function useClient(): TentickleClient {
  const context = useContext(TentickleContext);

  if (!context) {
    throw new Error("useClient must be used within a TentickleProvider");
  }

  return context.client;
}
