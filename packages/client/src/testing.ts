/**
 * Testing utilities for @agentick/client.
 *
 * Provides mock factories for unit testing code that depends on
 * AgentickClient, SessionAccessor, or ClientExecutionHandle.
 */

import { vi } from "vitest";
import type { AgentickClient } from "./client.js";
import type {
  StreamEvent,
  ClientExecutionHandle,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SessionToolConfirmationHandler,
} from "./types.js";

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
    abort: vi.fn(),
    queueMessage: vi.fn(),
    submitToolResult: vi.fn(),
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

export function createMockClient() {
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

  const createAccessor = (id: string) => ({
    sessionId: id,
    isSubscribed: false,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    send: vi.fn(() => createMockHandle()),
    abort: vi.fn(async () => {}),
    interrupt: vi.fn(async () => createMockHandle()),
    close: vi.fn(async () => {}),
    submitToolResult: vi.fn(),
    onEvent: vi.fn((handler: (event: StreamEvent) => void) => {
      const handlers = getSessionHandlers(id);
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    onResult: vi.fn(() => () => {}),
    onToolConfirmation: vi.fn((handler: SessionToolConfirmationHandler) => {
      const handlers = getConfirmationHandlers(id);
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    channel: vi.fn(() => ({})),
    invoke: vi.fn(async () => ({})),
    stream: vi.fn(async function* () {}),
  });

  const accessorCache = new Map<string, ReturnType<typeof createAccessor>>();
  const getAccessor = (id: string) => {
    if (!accessorCache.has(id)) {
      accessorCache.set(id, createAccessor(id));
    }
    return accessorCache.get(id)!;
  };

  const client = {
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
      const respondFn = respond ?? vi.fn();
      for (const handler of handlers) handler(request, respondFn);
    },

    send: vi.fn(() => createMockHandle()),
    abort: vi.fn(async () => {}),
    interrupt: vi.fn(async () => createMockHandle()),
    session: vi.fn((id: string) => getAccessor(id)),
    getAccessor,
    destroy: vi.fn(),
  } as any;

  return client as AgentickClient & {
    _emitSessionEvent: (sessionId: string, event: StreamEvent) => void;
    _emitToolConfirmation: (
      sessionId: string,
      request: ToolConfirmationRequest,
      respond?: (response: ToolConfirmationResponse) => void,
    ) => void;
    getAccessor: (id: string) => ReturnType<typeof createAccessor>;
  };
}
