/**
 * Testing utilities for @agentick/client.
 *
 * Provides mock factories for unit testing code that depends on
 * AgentickClient, SessionAccessor, or ClientExecutionHandle.
 *
 * Framework-agnostic — pass `vi.fn` (vitest) or `jest.fn` (jest) as `fn`
 * to get spy-wrapped methods. Without it, methods are plain no-ops.
 */

import type { AgentickClient, SessionAccessor } from "./client.js";
import type {
  StreamEvent,
  ClientExecutionHandle,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SessionToolConfirmationHandler,
} from "./types.js";

type SpyFactory = <T extends (...args: any[]) => any>(impl?: T) => T;

const identity: SpyFactory = <T extends (...args: any[]) => any>(impl?: T) =>
  (impl ?? (() => {})) as T;

const noop = () => {};
const asyncNoop = async () => {};

export function createMockHandle(): ClientExecutionHandle {
  return {
    sessionId: "test-session",
    executionId: "exec-1",
    status: "completed",
    result: Promise.resolve({
      response: "ok",
      outputs: {},
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
    abort: noop,
    queueMessage: noop,
    submitToolResult: noop,
    async *[Symbol.asyncIterator]() {},
  } as any;
}

export function makeEvent(type: string): StreamEvent {
  return {
    type,
    id: `evt-${Date.now()}`,
    sequence: 1,
    timestamp: new Date().toISOString(),
  } as unknown as StreamEvent;
}

interface MockClient extends AgentickClient {
  _emitSessionEvent: (sessionId: string, event: StreamEvent) => void;
  _emitToolConfirmation: (
    sessionId: string,
    request: ToolConfirmationRequest,
    respond?: (response: ToolConfirmationResponse) => void,
  ) => void;
  getAccessor: (id: string) => SessionAccessor;
}

/**
 * Create a mock AgentickClient for unit tests.
 *
 * Pass `vi.fn` (vitest) or `jest.fn` (jest) as `fn` to get spy-wrapped
 * methods that support `.toHaveBeenCalledWith()` etc. Without it, methods
 * are plain no-ops.
 *
 * @example
 * ```ts
 * const client = createMockClient(vi.fn);
 * expect(client.send).toHaveBeenCalledWith(...);
 * ```
 */
export function createMockClient(fn: SpyFactory = identity): MockClient {
  const sessionEventHandlers = new Map<string, Set<(event: StreamEvent) => void>>();
  const sessionConfirmationHandlers = new Map<string, Set<SessionToolConfirmationHandler>>();

  const getSessionHandlers = (id: string) => {
    if (!sessionEventHandlers.has(id)) {
      sessionEventHandlers.set(id, new Set());
    }
    return sessionEventHandlers.get(id)!;
  };

  const getConfirmationHandlers = (id: string) => {
    if (!sessionConfirmationHandlers.has(id)) {
      sessionConfirmationHandlers.set(id, new Set());
    }
    return sessionConfirmationHandlers.get(id)!;
  };

  const createAccessor = (id: string): SessionAccessor =>
    ({
      sessionId: id,
      isSubscribed: false,
      subscribe: fn(() => {}),
      unsubscribe: fn(() => {}),
      send: fn(() => createMockHandle()),
      abort: fn(async () => {}),
      interrupt: fn(async () => createMockHandle()),
      close: fn(async () => {}),
      submitToolResult: fn(() => {}),
      onEvent: fn((handler: (event: StreamEvent) => void) => {
        const handlers = getSessionHandlers(id);
        handlers.add(handler);
        return () => handlers.delete(handler);
      }),
      onResult: fn(() => noop),
      onToolConfirmation: fn((handler: SessionToolConfirmationHandler) => {
        const handlers = getConfirmationHandlers(id);
        handlers.add(handler);
        return () => handlers.delete(handler);
      }),
      channel: fn(() => ({})),
      invoke: fn(async () => ({})),
      stream: fn(async function* () {}),
    }) as unknown as SessionAccessor;

  const accessorCache = new Map<string, SessionAccessor>();
  const getAccessor = (id: string): SessionAccessor => {
    if (!accessorCache.has(id)) {
      accessorCache.set(id, createAccessor(id));
    }
    return accessorCache.get(id)!;
  };

  const client: MockClient = {
    _emitSessionEvent(sessionId: string, event: StreamEvent) {
      const handlers = getSessionHandlers(sessionId);
      for (const handler of handlers) handler(event);
    },

    _emitToolConfirmation(
      sessionId: string,
      request: ToolConfirmationRequest,
      respond?: (response: ToolConfirmationResponse) => void,
    ) {
      const handlers = getConfirmationHandlers(sessionId);
      const respondFn = respond ?? noop;
      for (const handler of handlers) handler(request, respondFn);
    },

    send: fn(() => createMockHandle()),
    abort: fn(asyncNoop),
    interrupt: fn(async () => createMockHandle()),
    session: fn((id: string) => getAccessor(id)),
    getAccessor,
    destroy: fn(noop),
  } as unknown as MockClient;

  return client;
}
