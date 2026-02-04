/**
 * @tentickle/react - React hooks and components for Tentickle
 *
 * Provides React bindings for connecting to Tentickle servers.
 * Wraps @tentickle/client with idiomatic React patterns.
 *
 * @example Quick start
 * ```tsx
 * import { TentickleProvider, useSession, useStreamingText } from '@tentickle/react';
 *
 * function App() {
 *   return (
 *     <TentickleProvider clientConfig={{ baseUrl: 'https://api.example.com' }}>
 *       <Chat />
 *     </TentickleProvider>
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
 *     <TentickleProvider
 *       clientConfig={{
 *         baseUrl: 'https://api.example.com',
 *         token,
 *       }}
 *     >
 *       <Chat />
 *     </TentickleProvider>
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
 * @module @tentickle/react
 */

// Provider
export { TentickleProvider } from "./context";

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
  TentickleProviderProps,
  TentickleContextValue,
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
  TentickleClient,
  ConnectionState,
  StreamEvent,
  SessionAccessor,
  SendInput,
  ClientExecutionHandle,
  SessionStreamEvent,
  ClientTransport,
} from "@tentickle/client";

// Re-export createClient for users who want to create a client manually
export { createClient } from "@tentickle/client";
