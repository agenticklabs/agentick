/**
 * Model-facing `session_tasks_*` tools — auto-registered by
 * {@link withTasks}.
 *
 * **Why the `session_` prefix.** The model doesn't know it's running
 * inside a framework, so the prefix can't be branded (`agentick.*`)
 * or jargon (`runtime.*`). It also can't collide with the broad set
 * of user-provided tools that manage "tasks" in some domain sense
 * (todos, project tasks, kanban). The `session_` prefix claims a
 * namespace for framework-native, model-visible operations scoped to
 * the current conversational session — natural, low-collision, and
 * future-proof for siblings like `session_knobs_*`,
 * `session_timeline_*`, etc.
 *
 * **Underscores, not dots.** Some providers historically rejected
 * dots in tool names (OpenAI's function-calling validator).
 * Underscores work universally across OpenAI, Anthropic, Google,
 * and MCP — no per-adapter quirk.
 *
 * **What these tools enable: Pattern B (model-visible task ref).**
 * A tool annotated with `taskSupport: "required"` returns a typed
 * `session_task_ref` content block instead of waiting for the work
 * to finish. The model uses the four tools below to manage the task
 * across subsequent ticks:
 *
 *   - `session_tasks_list`   — discover in-flight + recent tasks.
 *   - `session_tasks_get`    — poll one task's status.
 *   - `session_tasks_cancel` — abort an in-flight task.
 *   - `session_tasks_await`  — block this tick until completion
 *                              (escape hatch back to Pattern A).
 *
 * Without these, Pattern B is unusable: the model receives the ref
 * but has no way to act on it. With them, the agent can dispatch
 * concurrent long-running work, continue talking, and reconcile
 * results when ready.
 */

import { jsonSchema, toRegistration } from "@agentick/spec-next";
import type {
  ContentBlock,
  TaskInfo,
  ToolDeclaration,
  ToolHandler,
  ToolRegistration,
  UnknownTaskError,
} from "@agentick/spec-next";

import { EXTENSION_NAME } from "./extension-name.js";

// ============================================================================
// Tool names
// ============================================================================

export const SESSION_TASKS_LIST = "session_tasks_list";
export const SESSION_TASKS_GET = "session_tasks_get";
export const SESSION_TASKS_CANCEL = "session_tasks_cancel";
export const SESSION_TASKS_AWAIT = "session_tasks_await";

/**
 * Handler ref namespace. Includes the sessionId so cross-session
 * registrations on the shared HandlerResolver don't collide — same
 * pattern as `withMCP`'s per-server handler refs.
 */
function handlerRefFor(sessionId: string, suffix: string): string {
  return `@agentick/tasks-next:${sessionId}:${suffix}`;
}

// ============================================================================
// Tool declarations
// ============================================================================

const TOOLS_DESCRIPTION_PREAMBLE =
  "Manage framework-spawned background tasks for the current session. " +
  "These tools operate ONLY on tasks the framework created via long-running " +
  "tool calls (signalled by a `session_task_ref` content block in the prior " +
  "tool result). They are NOT for managing user-facing tasks like todos, " +
  "project tickets, or kanban items — use the appropriate domain tool for those.";

function listDeclaration(localName: string, handlerRef: string): ToolDeclaration {
  return {
    id: localName,
    name: localName,
    description:
      `${TOOLS_DESCRIPTION_PREAMBLE} ` +
      "List every framework background task known to this session — both " +
      "in-flight and recently terminal. Returns `{ tasks: TaskInfo[] }`. " +
      "Use this to discover tasks you may have started in earlier ticks but " +
      "whose ids you no longer have.",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    exposure: ["model", "dispatch"],
    handlerRef,
  };
}

function getDeclaration(localName: string, handlerRef: string): ToolDeclaration {
  return {
    id: localName,
    name: localName,
    description:
      `${TOOLS_DESCRIPTION_PREAMBLE} ` +
      "Fetch the current TaskInfo snapshot for a single framework background " +
      "task by id. Returns `{ task: TaskInfo }` on success, or " +
      "`{ error: 'unknown_task', taskId }` if the id is unknown.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    }),
    exposure: ["model", "dispatch"],
    handlerRef,
  };
}

function cancelDeclaration(localName: string, handlerRef: string): ToolDeclaration {
  return {
    id: localName,
    name: localName,
    description:
      `${TOOLS_DESCRIPTION_PREAMBLE} ` +
      "Cancel an in-flight framework background task. Idempotent: cancelling " +
      "a task that's already terminal is a no-op. Returns " +
      "`{ cancelled: taskId }` on success, or " +
      "`{ error: 'unknown_task', taskId }` if the id is unknown.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        taskId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["taskId"],
      additionalProperties: false,
    }),
    exposure: ["model", "dispatch"],
    handlerRef,
  };
}

function awaitDeclaration(localName: string, handlerRef: string): ToolDeclaration {
  return {
    id: localName,
    name: localName,
    description:
      `${TOOLS_DESCRIPTION_PREAMBLE} ` +
      "Block this tick until a framework background task reaches a terminal " +
      "state. On `completed`, returns the task's final content blocks " +
      "(the same shape the original tool would have returned in Pattern A). " +
      "On `failed` / `cancelled`, returns a structured failure block. Does " +
      "NOT cancel the underlying task if this tool itself is aborted — " +
      "use `session_tasks_cancel` for that.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    }),
    exposure: ["model", "dispatch"],
    handlerRef,
  };
}

// ============================================================================
// Handlers
// ============================================================================

function jsonBlock(payload: unknown): readonly ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(payload) } as ContentBlock];
}

function isUnknownTaskError(value: unknown): value is UnknownTaskError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "UnknownTaskError"
  );
}

interface TaskRejectionLike {
  readonly _tag: "TaskRejection";
  readonly taskId: string;
  readonly status: "failed" | "cancelled";
  readonly failure?: { readonly kind: string; readonly reason?: string };
}

function isTaskRejection(value: unknown): value is TaskRejectionLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "TaskRejection"
  );
}

const listHandler: ToolHandler = async (_input, { ctx }) => {
  const tasks = ctx.tasks?.list() ?? ([] as readonly TaskInfo[]);
  return jsonBlock({ tasks });
};

const getHandler: ToolHandler = async (input, { ctx }) => {
  const { taskId } = input as { readonly taskId: string };
  const task = ctx.tasks?.get(taskId);
  if (task === undefined) {
    return jsonBlock({ error: "unknown_task", taskId });
  }
  return jsonBlock({ task });
};

const cancelHandler: ToolHandler = async (input, { ctx }) => {
  const { taskId, reason } = input as { readonly taskId: string; readonly reason?: string };
  try {
    await ctx.tasks!.cancel(taskId, reason);
    return jsonBlock({ cancelled: taskId });
  } catch (cause) {
    if (isUnknownTaskError(cause)) {
      return jsonBlock({ error: "unknown_task", taskId });
    }
    throw cause;
  }
};

const awaitHandler: ToolHandler = async (input, { ctx }) => {
  const { taskId } = input as { readonly taskId: string };
  try {
    const blocks = await ctx.tasks!.result<readonly ContentBlock[]>(taskId);
    return blocks;
  } catch (cause) {
    if (isUnknownTaskError(cause)) {
      return jsonBlock({ error: "unknown_task", taskId });
    }
    if (isTaskRejection(cause)) {
      return jsonBlock({
        error: "task_failed",
        taskId: cause.taskId,
        status: cause.status,
        ...(cause.failure !== undefined ? { failure: cause.failure } : {}),
      });
    }
    throw cause;
  }
};

// ============================================================================
// Bundle
// ============================================================================

export interface SessionTasksToolsBundle {
  readonly registrations: readonly ToolRegistration[];
  /** Handler-ref → handler pairs to feed `installer.registerToolHandler`. */
  readonly handlers: ReadonlyArray<{
    readonly handlerRef: string;
    readonly handler: ToolHandler;
  }>;
}

/**
 * Build the four `session_tasks_*` tool registrations + their
 * handlers, scoped to a single session. Returned in a bundle so
 * `withTasks()` can register both surfaces in lockstep.
 */
export function buildSessionTasksTools(sessionId: string): SessionTasksToolsBundle {
  const listRef = handlerRefFor(sessionId, "list");
  const getRef = handlerRefFor(sessionId, "get");
  const cancelRef = handlerRefFor(sessionId, "cancel");
  const awaitRef = handlerRefFor(sessionId, "await");

  const binding = {
    scope: "extension",
    extensionName: EXTENSION_NAME,
    level: "session",
  } as const;

  return {
    registrations: [
      toRegistration(listDeclaration(SESSION_TASKS_LIST, listRef), binding),
      toRegistration(getDeclaration(SESSION_TASKS_GET, getRef), binding),
      toRegistration(cancelDeclaration(SESSION_TASKS_CANCEL, cancelRef), binding),
      toRegistration(awaitDeclaration(SESSION_TASKS_AWAIT, awaitRef), binding),
    ],
    handlers: [
      { handlerRef: listRef, handler: listHandler },
      { handlerRef: getRef, handler: getHandler },
      { handlerRef: cancelRef, handler: cancelHandler },
      { handlerRef: awaitRef, handler: awaitHandler },
    ],
  };
}
