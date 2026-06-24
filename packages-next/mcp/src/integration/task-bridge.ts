/**
 * `mcpTaskEffect` — the Effect adopters pass to
 * `ctx.tasks.submit(...)` for remote (MCP wire-backed) tasks.
 *
 * Encapsulates the full draft `tasks/*` wire dance behind a single
 * Effect, so callers don't think about: task-augmented vs inline
 * response branching, notification fan-out filtering, terminal-state
 * detection, cancel-on-interrupt cleanup. From the `TasksHarness`
 * perspective this is just another Effect submitted via the Phase D
 * Effect work overload — `Fiber.interrupt` propagates through this
 * effect's `onInterrupt` to send `tasks/cancel` on the wire.
 *
 * Lifecycle:
 *
 *   1. Send `tools/call` with `task: { ttl? }` params. Server decides:
 *      - Returns `CallToolResult` → server ran inline. Resolve the
 *        local task immediately with the content blocks. No further
 *        wire ops.
 *      - Returns `CreateTaskResult` → server created a task. Continue
 *        with notification stream + tasks/result fetch.
 *   2. Subscribe to `notifications/tasks/status` + `notifications/progress`
 *      scoped to the remote `taskId` via the harness's
 *      `taskNotifications(taskId)` stream.
 *   3. Fold each notification into the local `TaskWorkContext`:
 *        - progress → `workCtx.onProgress(...)`
 *        - status with non-terminal → `workCtx.setStatusMessage(...)`
 *        - status with terminal (`completed`/`failed`/`cancelled`) →
 *          break out of the loop; proceed to step 4.
 *   4. On terminal `completed` → send `tasks/result` to fetch payload,
 *      return the content blocks.
 *   5. On terminal `failed`/`cancelled` → throw a typed error so the
 *      harness's failure path engages and the local task transitions
 *      to `failed`/`cancelled` symmetrically.
 *   6. On local `Fiber.interrupt` (e.g., user cancels via
 *      `session_tasks_cancel`) → `Effect.onInterrupt(sendCancel)`
 *      sends `tasks/cancel(remoteTaskId)`. Best-effort: errors are
 *      swallowed because the local task has already transitioned.
 *
 * @see ./wire/task-codec.ts for the parsing layer.
 * @see ../client/harness.ts callToolAsTask / taskNotifications / cancelTask / getTaskResult
 */

import { Effect, Stream } from "effect";

import type { ContentBlock, TaskWorkContext } from "@agentick/spec-next";

import type { McpClientHarness } from "../client/harness.js";
import type { CallToolAsTaskOptions, Task } from "../wire/task-codec.js";

import { mcpContentToBlocks } from "./content-mapper.js";

// ============================================================================
// Errors
// ============================================================================

/**
 * The remote server transitioned the task to a non-completed
 * terminal. We surface a typed error so the `TasksHarness` failure
 * path emits a symmetric local `TaskRejection`.
 */
export interface McpRemoteTaskNonCompletedError {
  readonly _tag: "McpRemoteTaskNonCompletedError";
  readonly taskId: string;
  readonly status: "failed" | "cancelled";
  readonly statusMessage?: string;
}

// ============================================================================
// Public factory
// ============================================================================

export interface McpTaskEffectInput {
  readonly name: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly taskOptions?: CallToolAsTaskOptions;
}

/**
 * Build the Effect for one remote MCP task. Pass to
 * `ctx.tasks.submit(() => mcpTaskEffect(...))`. The returned Effect
 * carries the full lifecycle from `tools/call` send to terminal +
 * result fetch, with `Effect.onInterrupt` wiring local-cancel →
 * `tasks/cancel`.
 *
 * `workCtx` is the work-side context the local `TasksHarness` hands
 * to its submitted work — this Effect calls `workCtx.onProgress` and
 * `workCtx.setStatusMessage` so local subscribers see the remote
 * task's progress + statusMessage transitions in real time.
 */
export function mcpTaskEffect(
  client: McpClientHarness,
  input: McpTaskEffectInput,
  workCtx: TaskWorkContext,
): Effect.Effect<readonly ContentBlock[], unknown, never> {
  const { name, args, taskOptions } = input;
  return Effect.gen(function* () {
    // Step 1: send the task-augmented tools/call.
    const outcome = yield* Effect.tryPromise({
      try: () => client.callToolAsTask(name, args, taskOptions),
      catch: (cause) => cause,
    });

    // Server ran inline — no task created, no further wire ops.
    if (outcome._tag === "inline") {
      return mcpContentToBlocks(outcome.result.content);
    }

    // Server created a task. Reflect initial snapshot to local
    // subscribers, then drive notifications + result fetch +
    // cancel-on-interrupt via the helper.
    const remoteTaskId = outcome.result.task.taskId;
    if (outcome.result.task.statusMessage !== undefined) {
      workCtx.setStatusMessage(outcome.result.task.statusMessage);
    }

    return yield* foldUntilTerminal(client, remoteTaskId, workCtx).pipe(
      Effect.onInterrupt(() =>
        // Best-effort cancel — the local task has already committed
        // to `cancelled` by the time this finalizer runs; server
        // errors here aren't actionable.
        Effect.tryPromise({
          try: () => client.cancelTask(remoteTaskId),
          catch: () => undefined,
        }).pipe(Effect.ignore),
      ),
    );
  });
}

/**
 * Stream-fold helper — drives the notification loop until the remote
 * task reaches a terminal status. Centralized so the main Effect
 * stays readable.
 *
 *   - On terminal `completed` → fetch `tasks/result` and return blocks.
 *   - On terminal `failed`/`cancelled` → fail with
 *     `McpRemoteTaskNonCompletedError` so the local harness
 *     transitions to the symmetric local terminal.
 */
function foldUntilTerminal(
  client: McpClientHarness,
  remoteTaskId: string,
  workCtx: TaskWorkContext,
): Effect.Effect<readonly ContentBlock[], McpRemoteTaskNonCompletedError | unknown, never> {
  return Effect.gen(function* () {
    const events = client.taskNotifications(remoteTaskId);
    // Race the notification stream against the terminal exit. We
    // emit a synthetic "terminal" exit event by reading the stream
    // until a terminal status arrives, then short-circuit.
    const terminalStatus = yield* Stream.runFoldWhile(
      events,
      undefined as Task["status"] | undefined,
      (acc) => acc === undefined || !isTerminal(acc),
      (_, note) => {
        if (note.kind === "progress") {
          const p = note.notification.params;
          workCtx.onProgress({
            current: p.progress,
            ...(p.total !== undefined ? { total: p.total } : {}),
            ...(p.message !== undefined ? { message: p.message } : {}),
          });
          return undefined;
        }
        const params = note.notification.params;
        if (params.statusMessage !== undefined) {
          workCtx.setStatusMessage(params.statusMessage);
        }
        return params.status;
      },
    );

    if (terminalStatus === undefined || !isTerminal(terminalStatus)) {
      // Stream closed before a terminal arrived (e.g., transport
      // dropped). Treat as failed.
      return yield* Effect.fail<McpRemoteTaskNonCompletedError>({
        _tag: "McpRemoteTaskNonCompletedError",
        taskId: remoteTaskId,
        status: "failed",
        statusMessage: "Notification stream ended before terminal status",
      });
    }

    if (terminalStatus !== "completed") {
      return yield* Effect.fail<McpRemoteTaskNonCompletedError>({
        _tag: "McpRemoteTaskNonCompletedError",
        taskId: remoteTaskId,
        // Narrow: `isTerminal` returned true and we excluded `completed`,
        // so status is failed or cancelled.
        status: terminalStatus as "failed" | "cancelled",
      });
    }

    // Terminal "completed" → fetch the payload.
    const payload = yield* Effect.tryPromise({
      try: () => client.getTaskResult(remoteTaskId),
      catch: (cause) => cause,
    });
    return mcpContentToBlocks(payload.content);
  });
}

function isTerminal(status: Task["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
