/**
 * Express handler factory for Tentickle (multiplexed sessions).
 *
 * @module @tentickle/express/router
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { App } from "@tentickle/core/app";
import type {
  Message,
  SendInput,
  StreamEvent,
  ToolConfirmationResponse,
  ChannelEvent,
  ChannelPublishRequest,
  ChannelSSEEvent,
} from "@tentickle/shared";
import { createSSEWriter, setSSEHeaders } from "@tentickle/server";
import type { TentickleHandlerOptions, TentickleRequest } from "./types";

type Connection<User> = {
  id: string;
  writer: ReturnType<typeof createSSEWriter>;
  subscriptions: Set<string>;
  user?: User;
  userId?: string;
  closed: boolean;
};

function parseSubscribeParam(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry).split(","))
      .map((id) => id.trim())
      .filter(Boolean);
  }
  return String(value)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function isSendInput(value: unknown): value is SendInput<Record<string, unknown>> {
  if (!value || typeof value !== "object") return false;
  const input = value as { message?: Message; messages?: Message[] };
  const hasMessage = !!input.message;
  const hasMessages = Array.isArray(input.messages);
  return (hasMessage && !hasMessages) || (!hasMessage && hasMessages);
}

export function createTentickleHandler<User = unknown>(
  app: App,
  options: TentickleHandlerOptions<User> = {},
): Router {
  const router = Router();

  const paths = {
    events: options.paths?.events ?? "/events",
    send: options.paths?.send ?? "/send",
    subscribe: options.paths?.subscribe ?? "/subscribe",
    abort: options.paths?.abort ?? "/abort",
    close: options.paths?.close ?? "/close",
    toolResponse: options.paths?.toolResponse ?? "/tool-response",
    channel: options.paths?.channel ?? "/channel",
  };

  const sseKeepaliveInterval = options.sseKeepaliveInterval ?? 15000;

  const connections = new Map<string, Connection<User>>();
  const sessionSubscribers = new Map<string, Set<string>>();
  const sessionListeners = new Map<string, (event: StreamEvent) => void>();
  // Track channel listeners per session: Map<sessionId, Map<channelName, unsubscribe>>
  const sessionChannelListeners = new Map<string, Map<string, () => void>>();

  const getUserContext = async (req: Request) => {
    const user = options.authenticate ? await options.authenticate(req) : undefined;
    const userId = options.getUserId ? await options.getUserId(req, user) : undefined;
    return { user, userId };
  };

  const authorize = async (req: Request, user: User | undefined, sessionId: string) => {
    if (!options.authorize) return true;
    return await options.authorize(user, sessionId, req);
  };

  const ensureSessionListener = (sessionId: string) => {
    if (sessionListeners.has(sessionId)) return;
    const session = app.session(sessionId);
    const listener = (event: StreamEvent) => {
      const subscribers = sessionSubscribers.get(sessionId);
      if (!subscribers) return;
      for (const connectionId of subscribers) {
        const connection = connections.get(connectionId);
        if (!connection || connection.closed) continue;
        connection.writer.writeEvent({ ...event, sessionId });
      }
    };
    session.on("event", listener);
    session.once("close", () => {
      sessionListeners.delete(sessionId);
      sessionSubscribers.delete(sessionId);
      // Clean up channel listeners for this session
      const channelListeners = sessionChannelListeners.get(sessionId);
      if (channelListeners) {
        for (const unsubscribe of channelListeners.values()) {
          unsubscribe();
        }
        sessionChannelListeners.delete(sessionId);
      }
    });
    sessionListeners.set(sessionId, listener);
  };

  /**
   * Ensure we're subscribed to a specific channel on a session.
   * Channel events are forwarded to all connections subscribed to the session.
   */
  const ensureChannelListener = (sessionId: string, channelName: string) => {
    let channelListeners = sessionChannelListeners.get(sessionId);
    if (!channelListeners) {
      channelListeners = new Map();
      sessionChannelListeners.set(sessionId, channelListeners);
    }
    if (channelListeners.has(channelName)) return;

    const session = app.session(sessionId);
    const channel = session.channel(channelName);
    const unsubscribe = channel.subscribe((event: ChannelEvent) => {
      const subscribers = sessionSubscribers.get(sessionId);
      if (!subscribers) return;
      const sseEvent: ChannelSSEEvent = {
        type: "channel",
        sessionId,
        channel: channelName,
        event,
      };
      for (const connectionId of subscribers) {
        const connection = connections.get(connectionId);
        if (!connection || connection.closed) continue;
        connection.writer.writeEvent(sseEvent);
      }
    });

    channelListeners.set(channelName, unsubscribe);
  };

  const subscribeConnection = async (
    connectionId: string,
    sessionId: string,
    req: Request,
    user: User | undefined,
  ) => {
    const connection = connections.get(connectionId);
    if (!connection || connection.closed) return;
    if (!(await authorize(req, user, sessionId))) {
      throw new Error("Unauthorized");
    }
    app.session(sessionId);
    ensureSessionListener(sessionId);
    connection.subscriptions.add(sessionId);
    const subscribers = sessionSubscribers.get(sessionId) ?? new Set<string>();
    subscribers.add(connectionId);
    sessionSubscribers.set(sessionId, subscribers);
  };

  const unsubscribeConnection = (connectionId: string, sessionId: string) => {
    const connection = connections.get(connectionId);
    if (!connection) return;
    connection.subscriptions.delete(sessionId);
    const subscribers = sessionSubscribers.get(sessionId);
    if (!subscribers) return;
    subscribers.delete(connectionId);
    if (subscribers.size === 0) {
      sessionSubscribers.delete(sessionId);
      const listener = sessionListeners.get(sessionId);
      if (listener && app.has(sessionId)) {
        const session = app.session(sessionId);
        session.off("event", listener);
      }
      sessionListeners.delete(sessionId);
    }
  };

  router.get(paths.events, async (req: TentickleRequest, res: Response, next: NextFunction) => {
    try {
      const { user, userId } = await getUserContext(req);
      req.tentickle = { user, userId };

      setSSEHeaders(res);
      const writer = createSSEWriter(res, { keepaliveInterval: sseKeepaliveInterval });

      const connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const connection: Connection<User> = {
        id: connectionId,
        writer,
        subscriptions: new Set<string>(),
        user,
        userId,
        closed: false,
      };
      connections.set(connectionId, connection);

      const initialSubscriptions = parseSubscribeParam(req.query.subscribe);
      for (const sessionId of initialSubscriptions) {
        await subscribeConnection(connectionId, sessionId, req, user);
      }

      writer.writeEvent({
        type: "connection",
        connectionId,
        subscriptions: Array.from(connection.subscriptions),
      });

      req.on("close", () => {
        connection.closed = true;
        for (const sessionId of connection.subscriptions) {
          unsubscribeConnection(connectionId, sessionId);
        }
        connections.delete(connectionId);
        writer.close();
      });
    } catch (err) {
      next(err);
    }
  });

  router.post(paths.subscribe, async (req: TentickleRequest, res: Response, next: NextFunction) => {
    try {
      const { user } = await getUserContext(req);
      const { connectionId, add, remove } = req.body ?? {};

      if (!connectionId) {
        res.status(400).json({ error: "INVALID_REQUEST", message: "connectionId is required" });
        return;
      }

      for (const sessionId of add ?? []) {
        await subscribeConnection(connectionId, sessionId, req, user);
      }
      for (const sessionId of remove ?? []) {
        unsubscribeConnection(connectionId, sessionId);
      }

      res.json({ success: true });
    } catch (err) {
      if (err instanceof Error && err.message === "Unauthorized") {
        res.status(403).json({ error: "UNAUTHORIZED", message: "Unauthorized" });
        return;
      }
      next(err);
    }
  });

  router.post(paths.send, async (req: TentickleRequest, res: Response, next: NextFunction) => {
    try {
      const { sessionId, ...rest } = req.body ?? {};
      if (!isSendInput(rest)) {
        res.status(400).json({
          error: "INVALID_REQUEST",
          message: "Provide either message or messages (but not both).",
        });
        return;
      }

      const handle = app.send(rest, { sessionId });
      setSSEHeaders(res);

      for await (const event of handle) {
        res.write(`data: ${JSON.stringify({ ...event, sessionId: handle.sessionId })}\n\n`);
      }
      res.end();
    } catch (err) {
      next(err);
    }
  });

  router.post(paths.abort, async (req: TentickleRequest, res: Response, next: NextFunction) => {
    try {
      const { sessionId, reason } = req.body ?? {};
      if (!sessionId || !app.has(sessionId)) {
        res.status(404).json({ error: "SESSION_NOT_FOUND", message: "Session not found" });
        return;
      }
      const session = app.session(sessionId);
      session.interrupt(undefined, reason);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.post(paths.close, async (req: TentickleRequest, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.body ?? {};
      if (!sessionId) {
        res.status(400).json({ error: "INVALID_REQUEST", message: "sessionId is required" });
        return;
      }
      await app.close(sessionId);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    paths.toolResponse,
    async (req: TentickleRequest, res: Response, next: NextFunction) => {
      try {
        const { sessionId, toolUseId, response } = req.body ?? {};
        if (!sessionId || !app.has(sessionId)) {
          res.status(404).json({ error: "SESSION_NOT_FOUND", message: "Session not found" });
          return;
        }
        if (!toolUseId || !response) {
          res
            .status(400)
            .json({ error: "INVALID_REQUEST", message: "toolUseId and response are required" });
          return;
        }
        const session = app.session(sessionId);
        await session.submitToolResult(toolUseId, response as ToolConfirmationResponse);
        res.json({ success: true });
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * Publish to a session channel.
   * This allows client → server channel communication.
   */
  router.post(paths.channel, async (req: TentickleRequest, res: Response, next: NextFunction) => {
    try {
      const { user } = await getUserContext(req);
      const body = req.body as ChannelPublishRequest | undefined;

      if (!body?.sessionId) {
        res.status(400).json({ error: "INVALID_REQUEST", message: "sessionId is required" });
        return;
      }
      if (!body?.channel) {
        res.status(400).json({ error: "INVALID_REQUEST", message: "channel is required" });
        return;
      }
      if (!body?.type) {
        res.status(400).json({ error: "INVALID_REQUEST", message: "type is required" });
        return;
      }

      // Authorize access to session
      if (!(await authorize(req, user, body.sessionId))) {
        res.status(403).json({ error: "UNAUTHORIZED", message: "Unauthorized" });
        return;
      }

      if (!app.has(body.sessionId)) {
        res.status(404).json({ error: "SESSION_NOT_FOUND", message: "Session not found" });
        return;
      }
      const session = app.session(body.sessionId);

      // Publish to the channel
      const event: ChannelEvent = {
        type: body.type,
        channel: body.channel,
        payload: body.payload,
        id: body.id,
        metadata: {
          timestamp: Date.now(),
          ...body.metadata,
        },
      };
      session.channel(body.channel).publish(event);

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Subscribe to a channel on a session.
   * This ensures server → client channel events are forwarded.
   */
  router.post(
    `${paths.channel}/subscribe`,
    async (req: TentickleRequest, res: Response, next: NextFunction) => {
      try {
        const { user } = await getUserContext(req);
        const { sessionId, channel: channelName } = req.body ?? {};

        if (!sessionId) {
          res.status(400).json({ error: "INVALID_REQUEST", message: "sessionId is required" });
          return;
        }
        if (!channelName) {
          res.status(400).json({ error: "INVALID_REQUEST", message: "channel is required" });
          return;
        }

        // Authorize access to session
        if (!(await authorize(req, user, sessionId))) {
          res.status(403).json({ error: "UNAUTHORIZED", message: "Unauthorized" });
          return;
        }

        // Get or create session (creates if doesn't exist)
        app.session(sessionId);

        // Set up channel listener for this session (uses session internally)
        ensureChannelListener(sessionId, channelName);

        res.json({ success: true });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
