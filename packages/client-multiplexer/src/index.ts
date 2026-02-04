/**
 * @tentickle/client-multiplexer
 *
 * Multi-tab connection multiplexer for Tentickle client.
 *
 * Reduces server connections by electing a leader tab that maintains
 * the SSE connection while other tabs communicate via BroadcastChannel.
 *
 * Features:
 * - Leader election using Web Locks API (instant, reliable)
 * - BroadcastChannel fallback for older browsers
 * - Automatic failover when leader tab closes
 * - Per-tab subscription filtering (each tab only receives its events)
 * - Subscription aggregation (leader subscribes to union of all tabs' sessions)
 *
 * @example
 * ```typescript
 * import { createClient } from '@tentickle/client';
 * import { createSharedTransport } from '@tentickle/client-multiplexer';
 *
 * // Create client with shared transport
 * const client = createClient({
 *   baseUrl: '/api',
 *   transport: createSharedTransport({ baseUrl: '/api', token: 'your-token' }),
 * });
 *
 * // Use exactly like a regular client
 * const session = client.session('main');
 * session.subscribe(); // Subscribe to events
 * session.onEvent((event) => console.log(event));
 *
 * // Send a message
 * const handle = session.send('Hello!');
 * await handle.result;
 *
 * // Check leadership status (optional, for debugging/UI)
 * const transport = client.getTransport() as SharedTransport | undefined;
 * console.log('Is leader:', transport?.isLeader);
 * ```
 */

export {
  SharedTransport,
  createSharedTransport,
  type SharedTransportConfig,
} from "./shared-transport.js";
export { createLeaderElector, type LeaderElector } from "./leader-elector.js";
export {
  createBroadcastBridge,
  type BroadcastBridge,
  type BridgeMessage,
} from "./broadcast-bridge.js";
