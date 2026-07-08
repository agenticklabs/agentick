/**
 * The wire shapes for the child-process executor's IPC (ADR 68 Build B).
 * Shared by {@link import("./child-executor.js").ChildProcessTaskExecutor}
 * (parent side) and {@link import("./worker.js").runTaskWorker} (child
 * side) so the two poles can't drift.
 *
 * Node's `child_process` IPC serializes with JSON by default. Every
 * shape here is structured-clone-trivial: a {@link TaskRecord} is
 * serializable by construction (ADR 68 — no live handles), and a
 * {@link TaskTransition} carries only strings / numbers / content
 * blocks. `TaskFailure.cause` is deliberately NOT sent across the
 * boundary (an arbitrary thrown value / Error doesn't round-trip through
 * JSON) — the worker lossy-encodes failures to `reason` only, matching
 * the same wire-boundary asymmetry the MCP codec documents.
 */

import type { TaskRecord, TaskTransition } from "@agentick/spec-next";

/** Parent → child. */
export type ParentToWorkerMessage =
  /** Begin work: the serializable descriptor (`handlerRef` + `input` live on it). */
  | { readonly t: "start"; readonly record: TaskRecord }
  /** Graceful cancel — the child aborts its local signal so work can clean up. */
  | { readonly t: "cancel"; readonly reason?: string };

/** Child → parent. */
export type WorkerToParentMessage =
  /** One reported transition — the child's projection of the uniform `report` seam. */
  { readonly t: "transition"; readonly transition: TaskTransition };
