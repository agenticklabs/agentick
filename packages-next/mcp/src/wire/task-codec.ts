/**
 * Wire codec for the MCP draft `tasks/*` extension (per spec revision
 * 2025-11-25; tracked by SEP-2663 in the SDK as a permanent interop
 * surface even after the SDK's own server-side implementation was
 * removed). Pure helpers — no runtime side-effects, no harness
 * dependencies. Consumed by `task-bridge.ts` and `McpClientHarness`.
 *
 * **What this codec knows:**
 *
 *   - `tools/call` may carry a `task: { ttl?, pollInterval? }` hint in
 *     `params`. Servers that support task creation respond with a
 *     `CreateTaskResult` ({ task: Task }) instead of `CallToolResult`.
 *   - Servers push `notifications/tasks/status` with `params` merged
 *     from `TaskSchema`. Other notifications (`notifications/progress`,
 *     `notifications/message`, etc.) MAY carry
 *     `_meta["io.modelcontextprotocol/related-task"] = { taskId }`
 *     to associate themselves with a parent task.
 *   - Client → server task management: `tasks/get` (snapshot),
 *     `tasks/result` (final payload of a `tools/call` task — returns
 *     the original `CallToolResult` shape), `tasks/cancel`, `tasks/list`.
 *
 * **What this codec does NOT know:**
 *
 *   - The `McpClientHarness` runtime, the `TasksHarness`, our internal
 *     `TaskInfo` shape. Translation between wire `Task` ↔ our local
 *     `TaskInfo` lives in `task-bridge.ts` so the codec stays a thin
 *     vocab layer over the SDK schemas.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md §Tasks
 * @see https://github.com/modelcontextprotocol/typescript-sdk
 *      (`packages/core/src/types/schemas.ts` — Tasks section)
 */

import { omitUndefined } from "@agentick/utils-next";

import {
  CallToolResultSchema,
  CancelTaskResultSchema,
  CreateTaskResultSchema,
  GetTaskPayloadResultSchema,
  GetTaskResultSchema,
  RELATED_TASK_META_KEY,
  TaskStatusNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  CancelTaskResult,
  CreateTaskResult,
  GetTaskPayloadResult,
  GetTaskResult,
  ProgressNotification,
  Task,
  TaskStatusNotification,
} from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// Request builders
// ============================================================================

/**
 * Build the params for a task-augmented `tools/call`. The server
 * decides whether to honor (returning a {@link CreateTaskResult}) or
 * execute inline (returning a regular {@link CallToolResult}).
 *
 *   - `ttl` — milliseconds the server keeps the task around after
 *     terminal status. `null` = no expiry. Default per spec is
 *     server-defined; we pass `undefined` here when the caller didn't
 *     ask, so the server's default applies.
 *   - `pollInterval` — hint to the server (and other clients sharing
 *     the task) for minimum gap between `tasks/get` calls.
 */
export interface CallToolAsTaskOptions {
  readonly ttl?: number;
  readonly pollInterval?: number;
}

export function buildCallToolAsTaskParams(
  name: string,
  args: Readonly<Record<string, unknown>> | undefined,
  opts: CallToolAsTaskOptions = {},
): {
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly task: { readonly ttl?: number; readonly pollInterval?: number };
} {
  return {
    name,
    ...omitUndefined({ arguments: args }),
    task: {
      ...omitUndefined({ ttl: opts.ttl, pollInterval: opts.pollInterval }),
    },
  };
}

export const TASKS_GET_METHOD = "tasks/get";
export const TASKS_RESULT_METHOD = "tasks/result";
export const TASKS_CANCEL_METHOD = "tasks/cancel";
export const TASKS_LIST_METHOD = "tasks/list";

/** Notification method names emitted server-side. Useful for transport-level filtering. */
export const TASK_STATUS_NOTIFICATION_METHOD = "notifications/tasks/status";
export const PROGRESS_NOTIFICATION_METHOD = "notifications/progress";

// ============================================================================
// Response discrimination — inline vs task-created
// ============================================================================

/**
 * Discriminated outcome of a task-augmented `tools/call`. The server
 * either ran the call inline (returning a {@link CallToolResult}) or
 * created a task (returning a {@link CreateTaskResult}). The codec
 * normalizes both into a single discriminated union so callers branch
 * uniformly.
 *
 * `CallToolResult` and `CreateTaskResult` are disjoint at the wire
 * level: the latter has a `task: Task` field, the former carries
 * `content: ContentBlock[]`. We discriminate on the presence of
 * `task` to avoid ambiguity in adopter-overloaded extra fields.
 */
export type CallToolOrTaskOutcome =
  | { readonly _tag: "inline"; readonly result: CallToolResult }
  | { readonly _tag: "task"; readonly result: CreateTaskResult };

/**
 * Discriminate a `tools/call` response on its structural shape, then
 * parse against the matching schema with `parse` (not `safeParse`).
 *
 *   - `"task"` field present → must parse as `CreateTaskResult`.
 *     Malformed shape (e.g. `task` missing required subfields) throws
 *     with field-level Zod detail.
 *   - `"content"` field present → must parse as `CallToolResult`.
 *   - Both present (illegal per spec) → CreateTaskResult wins; an
 *     adopter-side server bug is more interesting to see than to
 *     silently accept the content blocks.
 *   - Neither present → throw with a clear "unrecognized shape" error
 *     instead of "neither schema matched."
 *
 * The earlier impl chained `safeParse(CreateTaskResultSchema)` ->
 * `safeParse(CallToolResultSchema)` and threw a generic message when
 * both failed. That swallowed field-level errors and gave adopters
 * no signal when their server returned something malformed.
 */
export function discriminateCallToolResponse(raw: unknown): CallToolOrTaskOutcome {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`MCP task codec: tools/call response is not an object (got ${typeof raw}).`);
  }
  const obj = raw as Record<string, unknown>;
  const hasTask = "task" in obj && typeof obj.task === "object" && obj.task !== null;
  const hasContent = "content" in obj;

  if (hasTask) {
    // Strict parse — surfaces field-level errors when `task` is
    // present but malformed (missing taskId, bad status enum, etc.).
    return { _tag: "task", result: CreateTaskResultSchema.parse(raw) };
  }
  if (hasContent) {
    return { _tag: "inline", result: CallToolResultSchema.parse(raw) };
  }
  throw new Error(
    "MCP task codec: tools/call response has neither `task` (CreateTaskResult) " +
      "nor `content` (CallToolResult). Adopter / server bug — check the wire payload.",
  );
}

// ============================================================================
// Notification routing — taskId match via RELATED_TASK_META_KEY
// ============================================================================

/**
 * Test whether a `notifications/tasks/status` envelope concerns the
 * given taskId. The status notification carries `params.taskId`
 * directly (per the merged TaskSchema in
 * `TaskStatusNotificationParamsSchema`).
 *
 * Returns `null` if `raw` doesn't parse as a TaskStatusNotification.
 */
export function matchTaskStatusNotification(
  raw: unknown,
  taskId: string,
): TaskStatusNotification | null {
  const parsed = TaskStatusNotificationSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.params.taskId !== taskId) return null;
  return parsed.data;
}

/**
 * Test whether a `notifications/progress` envelope is tagged for the
 * given taskId via the standardized
 * `_meta["io.modelcontextprotocol/related-task"].taskId` association.
 *
 * Returns `null` when the notification isn't progress-shaped or
 * doesn't carry a matching related-task meta key.
 */
export function matchProgressNotificationForTask(
  raw: unknown,
  taskId: string,
): ProgressNotification | null {
  if (!isProgressShape(raw)) return null;
  // The notification's params (and its _meta block) is where the
  // related-task association lives. We accept either `params._meta`
  // or top-level `_meta` for forwards compatibility with servers that
  // shove the meta key at the envelope root.
  const paramsMeta = readRelatedTaskMeta(raw.params);
  if (paramsMeta === taskId) return raw;
  const topMeta = readRelatedTaskMeta(raw);
  if (topMeta === taskId) return raw;
  return null;
}

function isProgressShape(
  raw: unknown,
): raw is ProgressNotification & { readonly params: Record<string, unknown> } {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as { method?: unknown; params?: unknown };
  return (
    r.method === PROGRESS_NOTIFICATION_METHOD && typeof r.params === "object" && r.params !== null
  );
}

/**
 * Extract the related-task `taskId` from a progress notification, or
 * `null` if absent / malformed. Inspects both `params._meta` and the
 * top-level `_meta` to mirror {@link matchProgressNotificationForTask}.
 *
 * Lets callers publish a notification to a one-shot bus keyed by
 * taskId without iterating every active subscriber.
 */
export function extractRelatedTaskId(raw: unknown): string | null {
  if (!isProgressShape(raw)) return null;
  const paramsMeta = readRelatedTaskMeta(raw.params);
  if (paramsMeta !== undefined) return paramsMeta;
  const topMeta = readRelatedTaskMeta(raw);
  if (topMeta !== undefined) return topMeta;
  return null;
}

function readRelatedTaskMeta(envelope: unknown): string | undefined {
  if (typeof envelope !== "object" || envelope === null) return undefined;
  const meta = (envelope as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const related = (meta as Record<string, unknown>)[RELATED_TASK_META_KEY];
  if (typeof related !== "object" || related === null) return undefined;
  const taskId = (related as { taskId?: unknown }).taskId;
  return typeof taskId === "string" ? taskId : undefined;
}

// ============================================================================
// Result parsing — type-safe wrappers around the SDK schemas
// ============================================================================

export function parseGetTaskResult(raw: unknown): GetTaskResult {
  return GetTaskResultSchema.parse(raw);
}

export function parseGetTaskPayloadResult(raw: unknown): GetTaskPayloadResult {
  return GetTaskPayloadResultSchema.parse(raw);
}

export function parseCancelTaskResult(raw: unknown): CancelTaskResult {
  return CancelTaskResultSchema.parse(raw);
}

/**
 * The payload of a `tasks/result` request against a `tools/call`
 * task IS the original `CallToolResult` shape. The SDK declares
 * `GetTaskPayloadResult` as a loose Result so callers can re-parse
 * against the original request's result schema. This wrapper does
 * that re-parse for `tools/call`-task payloads.
 */
export function parseTaskPayloadAsCallToolResult(raw: unknown): CallToolResult {
  return CallToolResultSchema.parse(raw);
}

// ============================================================================
// Re-exports for adopter convenience
// ============================================================================

export { RELATED_TASK_META_KEY };
export type {
  CallToolResult,
  CancelTaskResult,
  CreateTaskResult,
  GetTaskPayloadResult,
  GetTaskResult,
  ProgressNotification,
  Task,
  TaskStatusNotification,
};
