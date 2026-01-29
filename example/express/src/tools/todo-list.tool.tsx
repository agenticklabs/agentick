/**
 * TodoList Tool
 *
 * A tool for managing todo items with channel-based state sync.
 * Demonstrates:
 * - Tool with multiple actions (CRUD operations)
 * - Channel subscription for external updates
 * - JSX render function for showing current state to model
 */

import { createTool } from "@tentickle/core/tool";
import { useChannel, useOnMount, useTickStart } from "@tentickle/core/hooks";
import { Section } from "@tentickle/core/jsx";
import { z } from "zod";
import { TodoListService, type TodoItem } from "../services/todo-list.service.js";

/**
 * Channel name for todo list state synchronization.
 */
export const TODO_CHANNEL = "todo-list";

/**
 * Zod schema for todo list actions.
 */
const todoActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
  }),
  z.object({
    action: z.literal("create"),
    title: z.string().optional().describe("The title of the new todo item"),
    task: z.string().optional().describe("Alias for title"),
    task_name: z.string().optional().describe("Alias for title"),
  }),
  z.object({
    action: z.literal("complete"),
    id: z.number().describe("The ID of the todo item to mark as completed"),
  }),
  z.object({
    action: z.literal("update"),
    id: z.number().describe("The ID of the todo item to update"),
    title: z.string().optional().describe("New title for the todo item"),
    completed: z.boolean().optional().describe("New completed status"),
  }),
  z.object({
    action: z.literal("delete"),
    id: z.number().describe("The ID of the todo item to delete"),
  }),
]);

type TodoAction = z.infer<typeof todoActionSchema>;

/**
 * Format todos for display.
 */
function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return "No tasks yet.";
  }

  return todos
    .map((t) => {
      const status = t.completed ? "✓" : "○";
      return `${status} [${t.id}] ${t.title}`;
    })
    .join("\n");
}

/**
 * Get sessionId from context metadata.
 * During tool execution, the session ID is available in the context.
 */
function getSessionId(): string {
  // For this example, we use a default session ID
  // In a real app, you'd get this from Context.get().sessionId
  // but that requires being in a proper execution context
  return "default";
}

/**
 * TodoList Tool for managing tasks.
 *
 * @example
 * ```tsx
 * function TaskAgent() {
 *   return (
 *     <>
 *       <TodoListTool />
 *       <Model />
 *     </>
 *   );
 * }
 * ```
 */
export const TodoListTool = createTool({
  name: "todo_list",
  description:
    "Manage a todo list. Actions: list (show all), create (add new), complete (mark done), update (modify), delete (remove).",
  input: todoActionSchema,

  handler: async (input: TodoAction) => {
    // Get session ID - in a real implementation this would come from context
    const sessionId = getSessionId();

    switch (input.action) {
      case "list": {
        const todos = TodoListService.list(sessionId);
        return [
          {
            type: "text" as const,
            text: `Current tasks:\n${formatTodos(todos)}`,
          },
        ];
      }

      case "create": {
        const title = input.title ?? input.task ?? input.task_name;
        if (!title) {
          return [
            {
              type: "text" as const,
              text: "Missing title for the new task.",
            },
          ];
        }

        const todo = TodoListService.create(sessionId, title);
        const todos = TodoListService.list(sessionId);
        return [
          {
            type: "text" as const,
            text: `Created task #${todo.id}: "${todo.title}"\n\nCurrent tasks:\n${formatTodos(todos)}`,
          },
        ];
      }

      case "complete": {
        const todo = TodoListService.complete(sessionId, input.id);
        if (!todo) {
          return [
            {
              type: "text" as const,
              text: `Task #${input.id} not found.`,
            },
          ];
        }
        const todos = TodoListService.list(sessionId);
        return [
          {
            type: "text" as const,
            text: `Completed task #${todo.id}: "${todo.title}"\n\nCurrent tasks:\n${formatTodos(todos)}`,
          },
        ];
      }

      case "update": {
        const todo = TodoListService.update(sessionId, input.id, {
          title: input.title,
          completed: input.completed,
        });
        if (!todo) {
          return [
            {
              type: "text" as const,
              text: `Task #${input.id} not found.`,
            },
          ];
        }
        const todos = TodoListService.list(sessionId);
        return [
          {
            type: "text" as const,
            text: `Updated task #${todo.id}: "${todo.title}" (${todo.completed ? "completed" : "pending"})\n\nCurrent tasks:\n${formatTodos(todos)}`,
          },
        ];
      }

      case "delete": {
        const deleted = TodoListService.delete(sessionId, input.id);
        if (!deleted) {
          return [
            {
              type: "text" as const,
              text: `Task #${input.id} not found.`,
            },
          ];
        }
        const todos = TodoListService.list(sessionId);
        return [
          {
            type: "text" as const,
            text: `Deleted task #${input.id}.\n\nCurrent tasks:\n${formatTodos(todos)}`,
          },
        ];
      }
    }
  },

  /**
   * Render current state to the model on each tick.
   * This ensures the model always sees the latest todo state.
   */
  render: () => {
    const sessionId = getSessionId();
    const todos = TodoListService.list(sessionId);

    // Only show if there are tasks
    if (todos.length === 0) {
      return null;
    }

    return (
      <Section id="current-tasks" audience="model">
        Current tasks in the todo list:
        {formatTodos(todos)}
      </Section>
    );
  },
});
