/**
 * @agentick/react - React hooks and components for Agentick
 *
 * Provides React bindings for connecting to Agentick servers.
 * Wraps @agentick/client with idiomatic React patterns.
 *
 * @example Quick start
 * ```tsx
 * import { AgentickProvider, useSession, useStreamingText } from '@agentick/react';
 *
 * function App() {
 *   return (
 *     <AgentickProvider clientConfig={{ baseUrl: 'https://api.example.com' }}>
 *       <Chat />
 *     </AgentickProvider>
 *   );
 * }
 *
 * function Chat() {
 *   const { send } = useSession({ sessionId: 'my-session' });
 *   const { text, isStreaming } = useStreamingText();
 *   const [input, setInput] = useState('');
 *
 *   const handleSend = async () => {
 *     await send(input);
 *     setInput('');
 *   };
 *
 *   return (
 *     <div>
 *       <div className="response">
 *         {text}
 *         {isStreaming && <span className="cursor">|</span>}
 *       </div>
 *       <input value={input} onChange={(e) => setInput(e.target.value)} />
 *       <button onClick={handleSend}>Send</button>
 *     </div>
 *   );
 * }
 * ```
 *
 * @example With authentication
 * ```tsx
 * function App() {
 *   const { token } = useAuth();
 *
 *   return (
 *     <AgentickProvider
 *       clientConfig={{
 *         baseUrl: 'https://api.example.com',
 *         token,
 *       }}
 *     >
 *       <Chat />
 *     </AgentickProvider>
 *   );
 * }
 * ```
 *
 * ## Hooks
 *
 * | Hook | Purpose |
 * |------|---------|
 * | `useClient()` | Direct client access |
 * | `useConnection()` | SSE connection state |
 * | `useSession(opts?)` | Session accessor (send, abort, close) |
 * | `useConnectionState()` | Connection state subscription |
 * | `useEvents(opts?)` | Stream event subscription |
 * | `useStreamingText(opts?)` | Accumulated text from deltas |
 * | `useEvents(opts?)` | Stream event subscription |
 *
 * @module @agentick/react
 */

// Provider
export { AgentickProvider } from "./context";

// Hooks
export {
  useClient,
  useConnection,
  useSession,
  useConnectionState,
  useEvents,
  useStreamingText,
  useContextInfo,
  type ContextInfo,
  type UseContextInfoOptions,
  type UseContextInfoResult,
} from "./hooks";

// Types
export type {
  // Provider types
  AgentickProviderProps,
  AgentickContextValue,
  TransportConfig,

  // Hook types
  UseConnectionOptions,
  UseConnectionResult,
  UseSessionOptions,
  UseSessionResult,
  UseEventsOptions,
  UseEventsResult,
  UseStreamingTextOptions,
  UseStreamingTextResult,
} from "./types.js";

// Re-export client types and factory for convenience
export type {
  AgentickClient,
  ConnectionState,
  StreamEvent,
  SessionAccessor,
  SendInput,
  ClientExecutionHandle,
  SessionStreamEvent,
  ClientTransport,
} from "@agentick/client";

// Re-export createClient for users who want to create a client manually
export { createClient } from "@agentick/client";
