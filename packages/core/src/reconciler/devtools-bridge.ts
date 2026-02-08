/**
 * DevTools Bridge
 *
 * Enables connection to React DevTools for Agentick component tree inspection.
 * Uses react-devtools-core for standalone DevTools connection.
 */

let connected = false;
let connectToDevTools: ((options?: Record<string, unknown>) => void) | null = null;

/**
 * Enable connection to React DevTools.
 *
 * This connects to the standalone React DevTools application (npx react-devtools).
 * Call this before creating any sessions to enable component tree inspection.
 *
 * @param options - Configuration options for DevTools connection
 * @param options.host - DevTools host (default: 'localhost')
 * @param options.port - DevTools port (default: 8097)
 *
 * @example
 * ```typescript
 * import { enableReactDevTools } from '@agentick/core';
 *
 * // Before creating sessions
 * enableReactDevTools();
 *
 * // Or with custom host/port
 * enableReactDevTools({ host: '192.168.1.1', port: 9000 });
 * ```
 */
export function enableReactDevTools(options?: { host?: string; port?: number }): void {
  if (connected) {
    console.warn("[Agentick] React DevTools already connected");
    return;
  }

  // Dynamically import react-devtools-core to avoid issues if not installed
  try {
    // Try to require react-devtools-core

    const devToolsCore = require("react-devtools-core");
    connectToDevTools = devToolsCore.connectToDevTools;
  } catch {
    console.warn(
      "[Agentick] react-devtools-core not installed. " +
        "Install it with: pnpm add -D react-devtools-core",
    );
    return;
  }

  if (!connectToDevTools) {
    console.warn("[Agentick] Could not load react-devtools-core");
    return;
  }

  try {
    // Connect to standalone React DevTools
    connectToDevTools({
      host: options?.host ?? "localhost",
      port: options?.port ?? 8097,
      resolveRNStyle: null,
      isAppActive: () => true,
    });

    connected = true;
    console.log(
      `[Agentick] Connected to React DevTools at ${options?.host ?? "localhost"}:${options?.port ?? 8097}`,
    );
  } catch (error) {
    console.warn("[Agentick] Failed to connect to React DevTools:", error);
  }
}

/**
 * Check if React DevTools is connected.
 */
export function isReactDevToolsConnected(): boolean {
  return connected;
}

/**
 * Disconnect from React DevTools.
 */
export function disconnectReactDevTools(): void {
  // Note: react-devtools-core doesn't expose a disconnect method
  // This just marks our connection state as false
  connected = false;
}
