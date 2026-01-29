/**
 * Session Handler - Orchestrates session lifecycle.
 *
 * The session handler provides core operations for managing sessions.
 * It does NOT define routes - your web framework routes call these methods.
 *
 * @module @tentickle/server/session-handler
 */

import { Logger } from "@tentickle/core/core";
import type { Session, App, SendResult } from "@tentickle/core/app";
import type { Message, StreamEvent } from "@tentickle/shared";
import type {
  SessionHandler,
  SessionHandlerConfig,
  SessionStore,
  CreateSessionInput,
  SendInput,
  SessionStateInfo,
} from "./types.js";
import { InMemorySessionStore } from "./session-store.js";

// Generate UUID (works in Node.js)
function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const logger = Logger.for("SessionHandler");

/**
 * Session Handler implementation.
 *
 * @example
 * ```typescript
 * // Create the handler
 * const sessionHandler = createSessionHandler({
 *   app: myApp,
 *   store: new InMemorySessionStore(),
 * });
 *
 * // Use in your routes
 * app.post('/sessions', async (req, res) => {
 *   const { sessionId } = await sessionHandler.create(req.body);
 *   res.json({ sessionId, status: 'created' });
 * });
 *
 * app.post('/sessions/:id/messages', async (req, res) => {
 *   const result = await sessionHandler.send(req.params.id, {
 *     messages: [req.body],
 *   });
 *   res.json(result);
 * });
 *
 * app.get('/sessions/:id/stream', async (req, res) => {
 *   res.setHeader('Content-Type', 'text/event-stream');
 *   for await (const event of sessionHandler.stream(req.params.id, {})) {
 *     res.write(`data: ${JSON.stringify(event)}\n\n`);
 *   }
 *   res.end();
 * });
 * ```
 */
export class SessionHandlerImpl implements SessionHandler {
  private app: App;
  private store: SessionStore;
  private defaultSessionOptions: Record<string, unknown>;

  constructor(config: SessionHandlerConfig) {
    this.app = config.app;
    this.store = config.store ?? new InMemorySessionStore();
    this.defaultSessionOptions = config.defaultSessionOptions ?? {};
  }

  /**
   * Create a new session.
   */
  async create(input: CreateSessionInput): Promise<{ sessionId: string; session: Session }> {
    const sessionId = input.sessionId ?? generateId();

    // Check if session already exists
    if (this.store.has(sessionId)) {
      const existing = this.store.get(sessionId)!;
      return { sessionId, session: existing };
    }

    // Create session from app
    const session = this.app.createSession({
      ...this.defaultSessionOptions,
    });

    // Store session
    this.store.set(sessionId, session);

    // Queue initial messages if provided
    if (input.messages && input.messages.length > 0) {
      for (const msg of input.messages) {
        session.queueMessage(msg);
      }
    }

    return { sessionId, session };
  }

  /**
   * Send to a session and wait for result.
   */
  async send(sessionId: string, input: SendInput): Promise<SendResult> {
    logger.info({ sessionId, input }, "send");
    const session = this.store.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    // Execute send and await the result
    const handle = session.send({
      message: input.message,
      messages: input.messages,
      props: input.props as any,
      metadata: input.metadata,
    });
    return await handle.result;
  }

  /**
   * Stream events from a session.
   */
  stream(sessionId: string, input: SendInput): AsyncIterable<StreamEvent> {
    logger.info({ sessionId, input }, "stream");
    const session = this.store.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    // Execute send and return event stream
    const handle = session.send({
      message: input.message,
      messages: input.messages,
      props: input.props as any,
      metadata: input.metadata,
    });

    // Return async iterable from handle
    return handle as AsyncIterable<StreamEvent>;
  }

  /**
   * Get session by ID.
   */
  getSession(sessionId: string): Session | undefined {
    return this.store.get(sessionId);
  }

  /**
   * Get session state.
   */
  getState(sessionId: string): SessionStateInfo | undefined {
    const session = this.store.get(sessionId);
    if (!session) {
      return undefined;
    }

    const inspection = session.inspect();

    return {
      sessionId,
      status: inspection.status,
      tick: inspection.currentTick,
      queuedMessages: inspection.queuedMessages.length,
    };
  }

  /**
   * Delete session.
   */
  delete(sessionId: string): boolean {
    return this.store.delete(sessionId);
  }

  /**
   * List all session IDs.
   */
  list(): string[] {
    return this.store.list();
  }
}

/**
 * Create a session handler.
 *
 * @example
 * ```typescript
 * const sessionHandler = createSessionHandler({
 *   app,
 *   store: new InMemorySessionStore(),
 * });
 * ```
 */
export function createSessionHandler(config: SessionHandlerConfig): SessionHandler {
  return new SessionHandlerImpl(config);
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Session not found error.
 */
export class SessionNotFoundError extends Error {
  readonly code = "SESSION_NOT_FOUND";

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

/**
 * Session closed error.
 */
export class SessionClosedError extends Error {
  readonly code = "SESSION_CLOSED";

  constructor(sessionId: string) {
    super(`Session is closed: ${sessionId}`);
    this.name = "SessionClosedError";
  }
}
