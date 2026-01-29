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
 *   const { isConnected, send } = useSession();
 *   const { text, isStreaming } = useStreamingText();
 *   const [input, setInput] = useState('');
 *
 *   const handleSend = async () => {
 *     await send(input);
 *     setInput('');
 *   };
 *
 *   if (!isConnected) return <div>Connecting...</div>;
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
 * @example Manual connection control
 * ```tsx
 * function Chat() {
 *   const { connect, disconnect, isConnected } = useSession({ autoConnect: false });
 *
 *   if (!isConnected) {
 *     return <button onClick={() => connect()}>Start Chat</button>;
 *   }
 *
 *   return (
 *     <div>
 *       <ChatInterface />
 *       <button onClick={disconnect}>End Chat</button>
 *     </div>
 *   );
 * }
 * ```
 *
 * ## Hooks
 *
 * | Hook | Purpose |
 * |------|---------|
 * | `useClient()` | Direct client access |
 * | `useSession(opts?)` | Session lifecycle (connect, send, tick) |
 * | `useConnectionState()` | Connection state subscription |
 * | `useEvents(opts?)` | Stream event subscription |
 * | `useStreamingText(opts?)` | Accumulated text from deltas |
 * | `useResult()` | Execution result subscription |
 * | `useChannel(name)` | Custom channel access |
 *
 * @module @tentickle/react
 */

// Provider and context
export { TentickleProvider, useClient } from "./context.js";

// Hooks
export {
  useSession,
  useConnectionState,
  useEvents,
  useStreamingText,
  useResult,
  useChannel,
} from "./hooks.js";

// Types
export type {
  // Provider types
  TentickleProviderProps,
  TentickleContextValue,

  // Hook types
  UseSessionOptions,
  UseSessionResult,
  UseEventsOptions,
  UseEventsResult,
  UseStreamingTextOptions,
  UseStreamingTextResult,

  // Re-exports from client
  TentickleClient,
  ConnectionState,
  StreamEvent,
} from "./types.js";
