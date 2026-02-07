/**
 * Mark II Entry Points
 *
 * The app (JSX tree) IS the application. It handles state,
 * conversation history, and application logic. The framework
 * takes props, runs the app, returns output.
 *
 * All sessions are persistent sessions. Ephemeral execution
 * creates a session, ticks until complete, then closes.
 *
 * ```typescript
 * const MyAgent = ({ query, context }) => (
 *   <>
 *     <System>You are helpful. {context}</System>
 *     <Timeline />
 *     <User>{query}</User>
 *   </>
 * );
 *
 * const app = createApp(MyAgent, { model });
 *
 * // Ephemeral: create → run → close
 * // app.run() returns SessionExecutionHandle (AsyncIterable)
 * const result = await app.run({ props: { query: "Hello!" }, messages: [...] });
 *
 * // Streaming (same API - handle is AsyncIterable)
 * for await (const event of app.run({ props: { query: "Hello!" }, messages: [...] })) {
 *   console.log(event);
 * }
 *
 * // Persistent session
 * const session = app.session();
 * await session.render({ query: "Hello!" });
 * await session.render({ query: "Follow up" });
 * session.close();
 *
 * // Named session (get-or-create by ID)
 * const conv = app.session('conv-123');
 * ```
 *
 * @module tentickle/app
 */

// ============================================================================
// Re-export createApp and run from @tentickle/instance
// ============================================================================
import { createApp, Tentickle, TentickleInstance, run } from "./tentickle-instance";
export { createApp, Tentickle, TentickleInstance, run };
export { createAgent } from "./agent";
export type { AgentConfig } from "./agent";
export type {
  MiddlewareKey,
  TentickleInstanceCreateOptions,
  MiddlewareRegistry,
} from "./tentickle-instance";

// ============================================================================
// Convenience Functions
// ============================================================================

import type { RunInput, AppOptions, SessionExecutionHandle, ComponentFunction } from "./app/types";

/**
 * Execute a component with input (ephemeral session).
 *
 * Returns SessionExecutionHandle (AsyncIterable, not PromiseLike):
 * - `await handle.result` → SendResult
 * - `for await (const event of handle)` → StreamEvent
 *
 * @example Get result
 * ```typescript
 * const handle = await runComponent(MyAgent, {
 *   props: { systemPrompt: "Be helpful" },
 *   messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
 * }, { model });
 * const result = await handle.result;
 * ```
 *
 * @example Stream events
 * ```typescript
 * const handle = await runComponent(MyAgent, {
 *   props: { systemPrompt: "Be helpful" },
 *   messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
 * }, { model });
 * for await (const event of handle) {
 *   console.log(event);
 * }
 * ```
 */
export async function runComponent<P extends Record<string, unknown>>(
  Component: ComponentFunction<P>,
  input: RunInput<P>,
  options: AppOptions = {},
): Promise<SessionExecutionHandle> {
  // Import synchronously since we're not doing dynamic import

  const { createApp: createAppFn } = require("./tentickle-instance") as {
    createApp: typeof createApp;
  };
  return await createAppFn(Component, options).run(input);
}

// ============================================================================
// Re-exports
// ============================================================================

export type {
  App,
  RunInput,
  AppOptions,
  StreamEvent,
  SessionOptions,
  Session,
  SessionSnapshot,
  SessionStatus,
  SessionInspection,
  ExecutionPhase,
  HookType,
  SendResult,
  SendInput,
  ComponentFunction,
  // Session management
  SessionStore,
  SessionManagementOptions,
  StoreConfig,
  SqliteStoreConfig,
  // Tick snapshots (time-travel debugging)
  RecordingMode,
  TickSnapshot,
  SessionRecording,
  SerializedFiberNode,
  SerializedHookState,
  SerializedError,
  SnapshotToolDefinition,
  RecordedInput,
} from "./app/types";

export { SessionImpl } from "./app/session";
export { MemorySessionStore } from "./app/session-store";
export {
  SqliteSessionStore,
  createSessionStore,
  isSqliteAvailable,
  type SqliteSessionStoreConfig,
} from "./app/sqlite-session-store";
