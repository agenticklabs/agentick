/**
 * Tasks projection — server-side Pattern B over the MCP wire (#171d.3).
 *
 * Symmetric inbound counterpart to `mcp-next` (client) Pattern B
 * handling (#158 / #174). When a v2 server-side tool handler returns
 * a {@link TaskHandle} (Pattern B), this projection layer:
 *
 *   1. Converts the handle to a wire `CreateTaskResult` so the client
 *      receives a `task: { taskId, status }` response from
 *      `tools/call` instead of inline `content`.
 *   2. Registers the handle in a per-server task map so subsequent
 *      `tasks/get` / `tasks/result` / `tasks/cancel` / `tasks/list`
 *      requests from the client can drive the task lifecycle.
 *   3. Subscribes to the handle's `events()` stream and emits
 *      `notifications/tasks/status` over the SDK Server's notification
 *      channel as the task transitions.
 *
 * Adopter ergonomics — `createTool` handlers stay portable: a Pattern
 * B handler that does `ctx.tasks!.submit(...)` works in-process AND
 * on the v2 MCP server with no code change. The server harness wires
 * its own `TasksHarness` into `ctx.tasks` per request.
 */

import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CancelTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListTasksRequestSchema,
  type CancelTaskResult,
  type GetTaskResult,
  type ListTasksResult,
  type CreateTaskResult,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ContentBlock, TaskHandle, TaskInfo, TaskStatus } from "@agentick/spec-next";

import { TASK_STATUS_NOTIFICATION_METHOD } from "../../wire/task-codec.js";

// ============================================================================
// Wire-shape helpers
// ============================================================================

/**
 * Map a framework {@link TaskStatus} to the MCP wire status string.
 * The MCP spec uses `working / input_required / completed / failed /
 * cancelled` — identical to our internal enum, so this is currently
 * an identity map. Kept as a named function so a future MCP spec
 * extension that adds intermediate states only touches this one site.
 */
function toWireStatus(
  status: TaskStatus,
): "working" | "input_required" | "completed" | "failed" | "cancelled" {
  return status;
}

function wireTaskFromInfo(info: TaskInfo): {
  readonly taskId: string;
  readonly status: ReturnType<typeof toWireStatus>;
  readonly ttl: number | null;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly pollInterval?: number;
  readonly statusMessage?: string;
} {
  return {
    taskId: info.taskId,
    status: toWireStatus(info.status),
    ttl: info.ttl,
    createdAt: new Date(info.createdAt).toISOString(),
    lastUpdatedAt: new Date(info.lastUpdatedAt).toISOString(),
    ...(info.pollInterval !== undefined ? { pollInterval: info.pollInterval } : {}),
    ...(info.statusMessage !== undefined ? { statusMessage: info.statusMessage } : {}),
  };
}

function toCreateTaskResult(info: TaskInfo): CreateTaskResult {
  return { task: wireTaskFromInfo(info) };
}

function toGetTaskResult(info: TaskInfo): GetTaskResult {
  return wireTaskFromInfo(info);
}

function toListTasksResult(infos: readonly TaskInfo[]): ListTasksResult {
  return { tasks: infos.map(wireTaskFromInfo) };
}

// ============================================================================
// Handle registration
// ============================================================================

/**
 * Bookkeeping the projection layer carries on top of the harness's
 * {@link TasksHarnessProtocol}. The handle itself is enough to drive
 * `tasks/get` / `tasks/result` / `tasks/cancel`; we add a teardown
 * function so the projection can stop the notification fan-out when
 * the task reaches terminal (the events() iterator closes naturally,
 * but we want to be explicit + cancel-safe under transport close).
 */
interface RegisteredTask {
  readonly handle: TaskHandle<readonly ContentBlock[]>;
  /** Cleanup the notification-fanout subscription. */
  readonly stop: () => void;
}

export interface ServerTaskRegistry {
  /** Register a handle + start the notification fan-out. */
  readonly register: (handle: TaskHandle<readonly ContentBlock[]>) => void;
  /** Look up a registered task. */
  readonly get: (taskId: string) => TaskHandle<readonly ContentBlock[]> | undefined;
  /** Stop every fan-out + clear. Called on harness close / transport teardown. */
  readonly clear: () => void;
  /** Live snapshot of every registered task (for `tasks/list`). */
  readonly list: () => readonly TaskInfo[];
}

/**
 * Build a per-server task registry that emits
 * `notifications/tasks/status` over the supplied SDK Server. The
 * `tasks` harness is the source of truth for status — the registry
 * subscribes to handle event streams and translates each transition
 * to the wire notification.
 *
 * Notification fan-out runs per registered handle. When the handle's
 * events iterator completes (terminal status) the fan-out exits
 * naturally; `stop()` only short-circuits an in-flight iteration on
 * forced clear (harness close, transport down).
 */
export function createServerTaskRegistry(sdkServer: SdkServer): ServerTaskRegistry {
  const handles = new Map<string, RegisteredTask>();

  return {
    register(handle) {
      let stopped = false;
      const stop = (): void => {
        stopped = true;
      };
      handles.set(handle.taskId, { handle, stop });

      // Attach a no-op catch on the result promise so cancellation /
      // failure terminal states don't surface as unhandled rejections.
      // `tasks/result` callers explicitly await `handle.result`; this
      // sentinel doesn't interfere with that — Promise rejections
      // dispatch to every attached handler.
      void handle.result.catch(() => {
        /* terminal failure consumed via tasks/result (or cancel) */
      });

      // Notification fan-out. Best-effort: notification send errors
      // are swallowed (the server's wire is dead anyway, and the
      // task continues running locally).
      void (async () => {
        try {
          for await (const event of handle.events()) {
            if (stopped) return;
            if (event.kind === "status") {
              try {
                await sdkServer.notification({
                  method: TASK_STATUS_NOTIFICATION_METHOD,
                  params: {
                    taskId: handle.taskId,
                    status: toWireStatus(event.info.status),
                    ...(event.info.statusMessage !== undefined
                      ? { statusMessage: event.info.statusMessage }
                      : {}),
                  },
                });
              } catch {
                // Transport closed mid-task; nothing actionable.
              }
            }
            // Progress events translate to `notifications/progress`
            // when the request carried a progressToken; the harness
            // doesn't have one here (the task was created server-
            // side), so we drop them. Adopters who want client-side
            // progress hooks consume them via `tasks/get` polling.
          }
        } catch {
          // Iterator errored (cancelled, harness closed, etc.); fine.
        }
      })();
    },

    get(taskId) {
      return handles.get(taskId)?.handle;
    },

    clear() {
      for (const { stop } of handles.values()) stop();
      handles.clear();
    },

    list() {
      return Array.from(handles.values(), ({ handle }) => handle.info());
    },
  };
}

// ============================================================================
// Wire request handlers
// ============================================================================

export interface InstallTasksHandlersOptions {
  readonly sdkServer: SdkServer;
  readonly registry: ServerTaskRegistry;
}

/**
 * Install the four wire-method handlers on an SDK Server:
 *   - `tasks/get`     — return the current snapshot of a task
 *   - `tasks/result`  — return the final `CallToolResult` payload
 *   - `tasks/cancel`  — best-effort cancel
 *   - `tasks/list`    — enumerate every registered task
 *
 * Called once per connection at accept time, alongside the tools and
 * prompts projections.
 */
export function installTasksHandlers(options: InstallTasksHandlersOptions): void {
  const { sdkServer, registry } = options;

  sdkServer.setRequestHandler(GetTaskRequestSchema, async (request) => {
    const taskId = request.params.taskId;
    const handle = registry.get(taskId);
    if (!handle) throw new Error(`unknown task: ${taskId}`);
    return toGetTaskResult(handle.info());
  });

  sdkServer.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
    const taskId = request.params.taskId;
    const handle = registry.get(taskId);
    if (!handle) throw new Error(`unknown task: ${taskId}`);
    try {
      const blocks = await handle.result;
      const callResult: CallToolResult = {
        content: blocks as CallToolResult["content"],
        isError: false,
      };
      return callResult;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return {
        content: [{ type: "text", text: `task failed: ${reason}` }],
        isError: true,
      } as CallToolResult;
    }
  });

  sdkServer.setRequestHandler(CancelTaskRequestSchema, async (request) => {
    const taskId = request.params.taskId;
    const handle = registry.get(taskId);
    if (handle) {
      try {
        await handle.cancel();
      } catch {
        // best-effort
      }
      // After cancel, return the current task snapshot — the MCP
      // wire's CancelTaskResult IS structurally a task snapshot (per
      // the spec, the server reports the post-cancel task state).
      const info = handle.info();
      return wireTaskFromInfo(info) as CancelTaskResult;
    }
    // Unknown taskId — return a synthesized "cancelled" snapshot so
    // the client sees the requested terminal state without us
    // throwing a JSON-RPC protocol error.
    return {
      taskId,
      status: "cancelled" as const,
      ttl: null,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    } as CancelTaskResult;
  });

  sdkServer.setRequestHandler(ListTasksRequestSchema, async () => {
    return toListTasksResult(registry.list());
  });
}

// Re-export `toCreateTaskResult` so the tools projection can render a
// fresh `CreateTaskResult` immediately on `tools/call` when a handler
// returns a TaskHandle (Pattern B).
export { toCreateTaskResult };
