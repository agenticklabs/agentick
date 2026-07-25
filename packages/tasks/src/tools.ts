/**
 * Model-facing `task_*` tools — auto-registered by
 * {@link withTasks}.
 *
 * **Naming: `<harness-noun>_<verb>`** (three-audiences-plan §D). The
 * tasks harness owns the `task` noun; its model tools sort together in
 * the model's list under that prefix — `task_list`, `task_get`,
 * `task_cancel`, `task_await`. The noun is deliberately domain-neutral
 * prose the model already reasons about ("a background task"), not a
 * branded (`agentick.*`) or jargon (`runtime.*`) namespace, and the
 * descriptions below scope it explicitly to FRAMEWORK-spawned tasks so
 * it never reads as a user-domain todo/kanban verb.
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
 *   - `task_list`   — discover in-flight + recent tasks.
 *   - `task_get`    — poll one task's status.
 *   - `task_cancel` — abort an in-flight task.
 *   - `task_await`  — block this tick until completion
 *                    (escape hatch back to Pattern A).
 *
 * Without these, Pattern B is unusable: the model receives the ref
 * but has no way to act on it. With them, the agent can dispatch
 * concurrent long-running work, continue talking, and reconcile
 * results when ready.
 */

import { jsonSchema, toRegistration } from "@agentick/spec";
import type {
  ContentBlock,
  TaskInfo,
  ToolDeclaration,
  ToolHandler,
  ToolRegistration,
  UnknownTaskError,
} from "@agentick/spec";

import { EXTENSION_NAME } from "./extension-name.js";
import { omitUndefined } from "@agentick/utils";

// ============================================================================
// Tool names
// ============================================================================

export const TASK_LIST = "task_list";
export const TASK_GET = "task_get";
export const TASK_CANCEL = "task_cancel";
export const TASK_AWAIT = "task_await";

/**
 * Handler ref namespace. Includes the sessionId so cross-session
 * registrations on the shared HandlerResolver don't collide — same
 * pattern as `withMCP`'s per-server handler refs.
 */
function handlerRefFor(sessionId: string, suffix: string): string {
  return `@agentick/tasks:${sessionId}:${suffix}`;
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
      "List every framework background task known to this session — local " +
      "tasks (in-flight + recently terminal) PLUS tasks living on each " +
      "connected MCP server. Use this to discover tasks you may have started " +
      "in earlier ticks but whose ids you no longer have, or to enumerate " +
      "remote tasks spawned by sibling sessions sharing the server. " +
      "Returns `{ tasks: TaskInfo[], remote?: Array<{ serverId, tasks? | error }> }` " +
      "— `remote` is omitted when no MCP servers are connected; individual " +
      "server entries carry an `error` string when that server's tasks/list " +
      "query failed (server down, tasks-unsupported, etc).",
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
      "use `task_cancel` for that.",
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

/**
 * Structural shape of `bridges.mcp` — the slot withMCP populates. We
 * intentionally don't import from `@agentick/mcp` (this package
 * is a substrate primitive; depending on the MCP integration would be
 * a layering violation). The structural type captures only what the
 * list handler reads. Adopters wiring custom MCP-style integrations
 * can publish the same shape and get remote-task enumeration for free.
 */
interface RemoteTaskSummary {
  readonly taskId: string;
  readonly status: string;
  readonly statusMessage?: string;
  readonly ttl?: number;
  readonly createdAt?: string;
  readonly lastUpdatedAt?: string;
}
interface RemoteTaskSourceHandle {
  readonly serverId: string;
  readonly harness: {
    readonly listTasks?: () => Promise<{ readonly tasks: ReadonlyArray<RemoteTaskSummary> }>;
  };
}
interface RemoteTaskSourceBridge {
  readonly clients: ReadonlyArray<RemoteTaskSourceHandle>;
}

function asRemoteTaskBridge(value: unknown): RemoteTaskSourceBridge | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const bridge = value as { readonly clients?: unknown };
  if (!Array.isArray(bridge.clients)) return undefined;
  return bridge as RemoteTaskSourceBridge;
}

/**
 * Build the list handler closed over a per-session namespace lookup.
 * The handler reads `bridges.mcp` (or any other remote-task source
 * matching the structural {@link RemoteTaskSourceBridge} shape)
 * lazily — `withTasks` and `withMCP` can install in either order
 * because the lookup happens at call time, not install time.
 *
 * The response carries TWO lists: `tasks` (local) + `remote`
 * (per-server snapshots). Remote query failures are captured per
 * server (`error: string` slot) so a single down server doesn't
 * blank out the whole listing.
 */
function makeListHandler(getNamespace: (name: string) => unknown): ToolHandler {
  return async (_input, { ctx }) => {
    const local = ctx.tasks?.list() ?? ([] as readonly TaskInfo[]);
    const bridge = asRemoteTaskBridge(getNamespace("mcp"));
    if (bridge === undefined || bridge.clients.length === 0) {
      return jsonBlock({ tasks: local });
    }
    const remote = await Promise.all(
      bridge.clients.map(async (handle) => {
        if (typeof handle.harness.listTasks !== "function") {
          return { serverId: handle.serverId, error: "tasks-unsupported" as const };
        }
        try {
          const result = await handle.harness.listTasks();
          return { serverId: handle.serverId, tasks: result.tasks };
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          return { serverId: handle.serverId, error: reason };
        }
      }),
    );
    return jsonBlock({ tasks: local, remote });
  };
}

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
        ...omitUndefined({ failure: cause.failure }),
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
 * Build the four `task_*` tool registrations + their
 * handlers, scoped to a single session. Returned in a bundle so
 * `withTasks()` can register both surfaces in lockstep.
 *
 * @param sessionId — handler-ref namespace scope.
 * @param getNamespace — per-session bridge lookup (typically
 *   `installer.getNamespace.bind(installer)`). Used by the `list`
 *   handler to discover `bridges.mcp` (or any structurally-equivalent
 *   remote-task source) AT CALL TIME so the install order between
 *   `withTasks` and `withMCP` doesn't matter. When omitted (or when
 *   no MCP bridge is registered), the list handler returns local
 *   tasks only — backward-compatible behavior.
 */
export function buildSessionTasksTools(
  sessionId: string,
  getNamespace: (name: string) => unknown = () => undefined,
): SessionTasksToolsBundle {
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
      toRegistration(listDeclaration(TASK_LIST, listRef), binding),
      toRegistration(getDeclaration(TASK_GET, getRef), binding),
      toRegistration(cancelDeclaration(TASK_CANCEL, cancelRef), binding),
      toRegistration(awaitDeclaration(TASK_AWAIT, awaitRef), binding),
    ],
    handlers: [
      { handlerRef: listRef, handler: makeListHandler(getNamespace) },
      { handlerRef: getRef, handler: getHandler },
      { handlerRef: cancelRef, handler: cancelHandler },
      { handlerRef: awaitRef, handler: awaitHandler },
    ],
  };
}
