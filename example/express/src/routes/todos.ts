/**
 * Todo REST Routes
 *
 * REST endpoints for direct todo manipulation outside of agent context.
 * Broadcasts state changes to connected clients via channels.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import type { SessionHandler, EventBridge } from "@tentickle/server";
import { TodoListService, type TodoItem } from "../services/todo-list.service.js";
import { TODO_CHANNEL } from "../tools/index.js";

/**
 * Broadcast todo state to all clients connected to a session.
 */
function broadcastTodoState(
  sessionHandler: SessionHandler,
  sessionId: string,
  todos: TodoItem[]
): void {
  const session = sessionHandler.getSession(sessionId);
  if (!session) return;

  // Publish state change to the todo channel
  session.channel(TODO_CHANNEL).publish({
    type: "state_changed",
    channel: TODO_CHANNEL,
    payload: { todos },
  });
}

/**
 * Create todo routes.
 *
 * @param sessionHandler - Session handler for accessing sessions
 * @param eventBridge - Event bridge (not used directly, but available for custom events)
 */
export function todoRoutes(
  sessionHandler: SessionHandler,
  eventBridge: EventBridge
): Router {
  const router = Router();

  /**
   * GET /api/tasks - List all todos for a session
   *
   * Query: ?sessionId=xxx
   */
  router.get("/", (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = (req.query.sessionId as string) || "default";
      const todos = TodoListService.list(sessionId);
      res.json({ todos });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/tasks - Create a new todo
   *
   * Body: { title: string, sessionId?: string }
   */
  router.post("/", (req: Request, res: Response, next: NextFunction) => {
    try {
      const { title, sessionId = "default" } = req.body;

      if (!title || typeof title !== "string") {
        res.status(400).json({ error: "title is required" });
        return;
      }

      const todo = TodoListService.create(sessionId, title);
      const todos = TodoListService.list(sessionId);

      // Broadcast state change
      broadcastTodoState(sessionHandler, sessionId, todos);

      res.status(201).json({ todo, todos });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PATCH /api/tasks/:id - Update a todo
   *
   * Body: { title?: string, completed?: boolean, sessionId?: string }
   */
  router.patch("/:id", (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { title, completed, sessionId = "default" } = req.body;

      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid task ID" });
        return;
      }

      const todo = TodoListService.update(sessionId, id, { title, completed });

      if (!todo) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      const todos = TodoListService.list(sessionId);

      // Broadcast state change
      broadcastTodoState(sessionHandler, sessionId, todos);

      res.json({ todo, todos });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/tasks/:id/complete - Mark a todo as complete
   *
   * Body: { sessionId?: string }
   */
  router.post("/:id/complete", (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { sessionId = "default" } = req.body;

      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid task ID" });
        return;
      }

      const todo = TodoListService.complete(sessionId, id);

      if (!todo) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      const todos = TodoListService.list(sessionId);

      // Broadcast state change
      broadcastTodoState(sessionHandler, sessionId, todos);

      res.json({ todo, todos });
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /api/tasks/:id - Delete a todo
   *
   * Query: ?sessionId=xxx
   */
  router.delete("/:id", (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      const sessionId = (req.query.sessionId as string) || "default";

      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid task ID" });
        return;
      }

      const deleted = TodoListService.delete(sessionId, id);

      if (!deleted) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      const todos = TodoListService.list(sessionId);

      // Broadcast state change
      broadcastTodoState(sessionHandler, sessionId, todos);

      res.json({ deleted: true, todos });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
