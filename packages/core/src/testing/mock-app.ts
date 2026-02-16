/**
 * Mock App, Session, and ExecutionHandle factories.
 *
 * Three layered factories for testing code that depends on App/Session/Handle
 * without requiring real reconciler, model, or engine infrastructure.
 *
 * Uses framework-agnostic spy tracking (matching createMockCom's `_recompileRequests` pattern)
 * — works with any test runner.
 *
 * @example
 * ```tsx
 * import { createMockApp, createMockSession, createMockExecutionHandle } from '@agentick/core/testing';
 *
 * // Full app mock
 * const app = createMockApp();
 * const session = await app.session("test");
 * const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
 * await handle.result; // SendResult
 *
 * // Session-level mock
 * const session = createMockSession();
 * const handle = await session.send({ messages: [] });
 * expect(session._sendCalls).toHaveLength(1);
 *
 * // Handle-level mock
 * const handle = createMockExecutionHandle({ response: "Hello!" });
 * const result = await handle.result;
 * expect(result.response).toBe("Hello!");
 * ```
 *
 * @module @agentick/core/testing
 */

import { EventEmitter } from "node:events";
import { EventBuffer, ExecutionHandleBrand, Channel } from "@agentick/kernel";
import { createTestProcedure } from "@agentick/kernel/testing";
import type { StreamEvent, UsageStats, Message } from "@agentick/shared";
import type {
  Session,
  SessionStatus,
  SessionExecutionHandle,
  SendResult,
  App,
  SendInput,
  RunInput,
  ComponentFunction,
  ExecutionOptions,
  SessionOptions,
  SessionSnapshot,
  SessionInspection,
  SessionRecording,
  RecordingMode,
  TickSnapshot,
} from "../app/types";
import type { COMInput } from "../com/types";

// ============================================================================
// Mock Execution Handle
// ============================================================================

export interface MockExecutionHandleOptions {
  /** Session ID (default: "mock-session") */
  sessionId?: string;
  /** Current tick number (default: 1) */
  currentTick?: number;
  /** Response text (default: "Mock response") */
  response?: string;
  /** Stream deltas (default: [response]) */
  streamDeltas?: string[];
  /** Tool calls to simulate */
  toolCalls?: Array<{ name: string; input: unknown; result: unknown }>;
  /** Error to throw */
  error?: Error;
  /** Delay before resolving in ms (default: 0) */
  delay?: number;
  /** Usage stats */
  usage?: UsageStats;
}

export interface MockSessionExecutionHandle extends SessionExecutionHandle {
  _queuedMessages: Message[];
  _toolResults: Array<{ toolUseId: string; response: any }>;
  _aborted: boolean;
  _abortReason?: string;
}

/**
 * Create a mock SessionExecutionHandle for testing.
 *
 * Uses a real EventBuffer for streaming. Supports delay, error, abort tracking.
 *
 * @example
 * ```tsx
 * const handle = createMockExecutionHandle({ response: "Hello!" });
 * const result = await handle.result;
 * expect(result.response).toBe("Hello!");
 *
 * // Stream events
 * for await (const event of handle) {
 *   console.log(event);
 * }
 * ```
 */
export function createMockExecutionHandle(
  options: MockExecutionHandleOptions = {},
): MockSessionExecutionHandle {
  const {
    sessionId = "mock-session",
    currentTick = 1,
    response = "Mock response",
    streamDeltas,
    toolCalls,
    error,
    delay = 0,
    usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  } = options;

  const eventBuffer = new EventBuffer<StreamEvent>();
  const queuedMessages: Message[] = [];
  const toolResults: Array<{ toolUseId: string; response: any }> = [];
  let aborted = false;
  let abortReason: string | undefined;
  let status: "running" | "completed" | "error" | "aborted" = "running";

  const sendResult: SendResult = {
    response,
    outputs: {},
    usage,
    raw: {
      timeline: [],
      system: [],
      sections: {},
      tools: [],
      metadata: {},
      ephemeral: [],
    } as COMInput,
  };

  // Push events and resolve asynchronously
  const init = async () => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (error) {
      status = "error";
      eventBuffer.error(error);
      return;
    }

    // Content deltas
    const deltas = streamDeltas ?? [response];
    for (const delta of deltas) {
      eventBuffer.push({ type: "content_delta", delta } as any);
    }

    // Tool calls
    if (toolCalls) {
      for (const call of toolCalls) {
        eventBuffer.push({ type: "tool_call_start", name: call.name, input: call.input } as any);
        eventBuffer.push({ type: "tool_result", name: call.name, result: call.result } as any);
      }
    }

    eventBuffer.push({ type: "message_end" } as any);
    status = "completed";
    eventBuffer.close();
  };

  const initPromise = init();

  const resultPromise = initPromise.then(() => {
    if (error) throw error;
    return sendResult;
  });

  const handle: MockSessionExecutionHandle = {
    [ExecutionHandleBrand]: true as const,
    sessionId,
    currentTick,
    traceId: "mock-trace",

    get status() {
      return status;
    },

    events: eventBuffer,
    result: resultPromise,

    queueMessage(message: Message) {
      queuedMessages.push(message);
    },

    submitToolResult(
      toolUseId: string,
      response: { approved: boolean; reason?: string; modifiedArguments?: Record<string, unknown> },
    ) {
      toolResults.push({ toolUseId, response });
    },

    abort(reason?: string) {
      aborted = true;
      abortReason = reason;
      status = "aborted";
      eventBuffer.close();
    },

    [Symbol.asyncIterator]() {
      return eventBuffer[Symbol.asyncIterator]();
    },

    // Spy arrays
    _queuedMessages: queuedMessages,
    _toolResults: toolResults,
    get _aborted() {
      return aborted;
    },
    get _abortReason() {
      return abortReason;
    },
  };

  return handle;
}

// ============================================================================
// Mock Session
// ============================================================================

export interface MockSessionOptions {
  /** Session ID (default: "mock-session") */
  id?: string;
  /** Initial status (default: "idle") */
  status?: SessionStatus;
  /** Default options for execution handles created by send/render/spawn */
  executionOptions?: MockExecutionHandleOptions;
  /** Parent session (default: null) */
  parent?: Session | null;
  /** Children sessions (default: []) */
  children?: readonly Session[];
}

export interface MockSession extends Session {
  _sendCalls: Array<{ input: any }>;
  _renderCalls: Array<{ props: any; options?: any }>;
  _queueCalls: Message[];
  _spawnCalls: Array<{ component: any; input?: any }>;
  _lastHandle: MockSessionExecutionHandle | null;
  /** Override execution options for the next send/render/spawn call */
  respondWith(options: MockExecutionHandleOptions): void;
}

/**
 * Create a mock Session for testing.
 *
 * All procedures (send, render, queue, spawn) are test procedures with spy tracking.
 * Extends EventEmitter directly — no manual delegation needed.
 *
 * @example
 * ```tsx
 * const session = createMockSession();
 * const handle = await session.send({ messages: [] });
 * expect(session._sendCalls).toHaveLength(1);
 * expect(session._lastHandle).toBeDefined();
 *
 * // Override next response
 * session.respondWith({ response: "Custom!" });
 * const handle2 = await session.send({ messages: [] });
 * const result = await handle2.result;
 * expect(result.response).toBe("Custom!");
 * ```
 */
export function createMockSession(options: MockSessionOptions = {}): MockSession {
  const {
    id = "mock-session",
    status: initialStatus = "idle",
    executionOptions = {},
    parent = null,
    children = [],
  } = options;

  let currentStatus: SessionStatus = initialStatus;
  let nextOptions: MockExecutionHandleOptions | null = null;

  const sendCalls: Array<{ input: any }> = [];
  const renderCalls: Array<{ props: any; options?: any }> = [];
  const queueCalls: Message[] = [];
  const spawnCalls: Array<{ component: any; input?: any }> = [];
  let lastHandle: MockSessionExecutionHandle | null = null;

  function getEffectiveOptions(): MockExecutionHandleOptions {
    const opts = nextOptions ?? executionOptions;
    nextOptions = null;
    return { ...opts, sessionId: opts.sessionId ?? id };
  }

  class MockSessionImpl extends EventEmitter implements MockSession {
    readonly id = id;
    readonly currentTick = 0;
    readonly isAborted = false;
    get isTerminal() {
      return currentStatus === "closed";
    }
    readonly parent = parent;
    readonly children = children;
    readonly queuedMessages: Message[] = [];
    readonly schedulerState = null;

    get status() {
      return currentStatus;
    }

    // Procedures
    queue = createTestProcedure({
      handler: async (message: Message) => {
        queueCalls.push(message);
      },
    }) as any;

    send = createTestProcedure({
      handler: (input: SendInput) => {
        sendCalls.push({ input });
        const handle = createMockExecutionHandle(getEffectiveOptions());
        lastHandle = handle;
        return handle;
      },
    }) as any;

    render = createTestProcedure({
      handler: (props: any, opts?: ExecutionOptions) => {
        renderCalls.push({ props, options: opts });
        const handle = createMockExecutionHandle(getEffectiveOptions());
        lastHandle = handle;
        return handle;
      },
    }) as any;

    spawn = createTestProcedure({
      handler: (component: ComponentFunction | React.ReactNode, input?: SendInput) => {
        spawnCalls.push({ component, input });
        const handle = createMockExecutionHandle(getEffectiveOptions());
        lastHandle = handle;
        return handle;
      },
    }) as any;

    dispatch = createTestProcedure({
      handler: async (_name: string, _input: Record<string, unknown>) => {
        return [{ type: "text" as const, text: "mock" }];
      },
    }) as any;

    interrupt() {}
    clearAbort() {}
    async mount() {}

    events() {
      return (async function* () {})();
    }

    snapshot(): SessionSnapshot {
      return {
        version: "1.0",
        sessionId: id,
        tick: 0,
        timeline: [],
        comState: {},
        dataCache: {},
        timestamp: Date.now(),
      };
    }

    inspect(): SessionInspection {
      return {
        id,
        status: currentStatus,
        currentTick: 0,
        queuedMessages: [],
        isAborted: false,
        lastOutput: null,
        lastModelOutput: null,
        lastToolCalls: [],
        lastToolResults: [],
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        tickCount: 0,
        components: { count: 0, names: [] },
        hooks: { count: 0, byType: {} },
      } as SessionInspection;
    }

    startRecording(_mode: RecordingMode) {}
    stopRecording() {}
    getRecording(): SessionRecording | null {
      return null;
    }
    getSnapshotAt(_tick: number): TickSnapshot | null {
      return null;
    }

    channel(name: string) {
      return new Channel(name);
    }

    submitToolResult() {}

    async close() {
      currentStatus = "closed";
    }

    // No teardown — close() handles it

    // Spy arrays
    get _sendCalls() {
      return sendCalls;
    }
    get _renderCalls() {
      return renderCalls;
    }
    get _queueCalls() {
      return queueCalls;
    }
    get _spawnCalls() {
      return spawnCalls;
    }
    get _lastHandle() {
      return lastHandle;
    }

    respondWith(opts: MockExecutionHandleOptions) {
      nextOptions = opts;
    }
  }

  return new MockSessionImpl();
}

// ============================================================================
// Mock App
// ============================================================================

export interface MockAppOptions {
  /** Default execution options for all sessions */
  executionOptions?: MockExecutionHandleOptions;
  /** Pre-created sessions keyed by ID */
  sessions?: Record<string, MockSession>;
}

export interface MockApp extends App {
  _sessions: Map<string, MockSession>;
  _closedSessions: string[];
  _sessionCreateHandlers: Array<(session: Session) => void>;
  _sessionCloseHandlers: Array<(sessionId: string) => void>;
}

/**
 * Create a mock App for testing.
 *
 * Sessions are created lazily and cached. Lifecycle handlers are tracked.
 *
 * @example
 * ```tsx
 * const app = createMockApp();
 * const session = await app.session("test");
 * expect(app.has("test")).toBe(true);
 * expect(app.sessions).toContain("test");
 *
 * await app.close("test");
 * expect(app._closedSessions).toContain("test");
 * ```
 */
export function createMockApp(options: MockAppOptions = {}): MockApp {
  const { executionOptions = {}, sessions: initialSessions = {} } = options;

  const sessionMap = new Map<string, MockSession>(Object.entries(initialSessions));
  const closedSessions: string[] = [];
  const sessionCreateHandlers: Array<(session: Session) => void> = [];
  const sessionCloseHandlers: Array<(sessionId: string) => void> = [];

  let sessionCounter = 0;

  function getOrCreateSession(id: string): MockSession {
    let session = sessionMap.get(id);
    if (!session) {
      session = createMockSession({ id, executionOptions });
      sessionMap.set(id, session);
      for (const handler of sessionCreateHandlers) {
        handler(session);
      }
    }
    return session;
  }

  const app: MockApp = {
    run: createTestProcedure({
      handler: (_input: RunInput) => {
        const id = `ephemeral-${++sessionCounter}`;
        getOrCreateSession(id);
        return createMockExecutionHandle({ ...executionOptions, sessionId: id });
      },
    }) as any,

    async send(input: SendInput, options?: { sessionId?: string }) {
      const id = options?.sessionId ?? `ephemeral-${++sessionCounter}`;
      getOrCreateSession(id);
      const session = sessionMap.get(id)!;
      return await session.send(input);
    },

    session: (async (idOrOptions?: string | SessionOptions) => {
      const id =
        typeof idOrOptions === "string"
          ? idOrOptions
          : (idOrOptions?.sessionId ?? `session-${++sessionCounter}`);
      return getOrCreateSession(id);
    }) as App["session"],

    async close(sessionId: string) {
      const session = sessionMap.get(sessionId);
      if (session) {
        await session.close();
        sessionMap.delete(sessionId);
        closedSessions.push(sessionId);
        for (const handler of sessionCloseHandlers) {
          handler(sessionId);
        }
      }
    },

    get sessions() {
      return Array.from(sessionMap.keys());
    },

    has(sessionId: string) {
      return sessionMap.has(sessionId);
    },

    onSessionCreate(handler: (session: Session) => void) {
      sessionCreateHandlers.push(handler);
      return () => {
        const idx = sessionCreateHandlers.indexOf(handler);
        if (idx >= 0) sessionCreateHandlers.splice(idx, 1);
      };
    },

    onSessionClose(handler: (sessionId: string) => void) {
      sessionCloseHandlers.push(handler);
      return () => {
        const idx = sessionCloseHandlers.indexOf(handler);
        if (idx >= 0) sessionCloseHandlers.splice(idx, 1);
      };
    },

    // Spy state
    _sessions: sessionMap,
    _closedSessions: closedSessions,
    _sessionCreateHandlers: sessionCreateHandlers,
    _sessionCloseHandlers: sessionCloseHandlers,
  };

  return app;
}
