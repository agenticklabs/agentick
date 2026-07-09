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

import type { SerializedAgentickError, TaskRecord, TaskTransition } from "@agentick/spec-next";

/**
 * A worker→parent elicit error, marshaled so the child can rethrow the
 * SAME class the parent's escalation threw (ADR 69 T2b). When the
 * escalation threw a tagged {@link import("@agentick/spec-next").AgentickError}
 * (e.g. `ElicitationDeclined`) the full serialized shape crosses via the
 * error codec — the child reconstructs the exact class WITH its domain
 * fields (`reason`, `elicitations`, …). An untagged throw crosses as a
 * plain `{ message }` the child rethrows as a bare `Error`.
 */
export type WireElicitError =
  | { readonly serialized: SerializedAgentickError }
  | { readonly message: string };

/** Parent → child. */
export type ParentToWorkerMessage =
  /** Begin work: the serializable descriptor (`handlerRef` + `input` live on it). */
  | { readonly t: "start"; readonly record: TaskRecord }
  /** Graceful cancel — the child aborts its local signal so work can clean up. */
  | { readonly t: "cancel"; readonly reason?: string }
  /**
   * Resolution of a child-issued `elicit-request` (ADR 69 T2b): the
   * parent reconstructed the live-schema request, escalated it through
   * the T1/T2a chain, and the client accepted — `result` is the sugar
   * method's return value (a `boolean` / `string` / … the child unwraps).
   */
  | { readonly t: "elicit-response"; readonly requestId: string; readonly result: unknown }
  /**
   * Failure of a child-issued `elicit-request` (ADR 69 T2b): the
   * escalation threw — user decline/cancel (a tagged `ElicitError`), a
   * denying ancestor interceptor, a transport failure, or "no escalation
   * configured". The child reconstructs + rethrows via {@link
   * WireElicitError}.
   */
  | { readonly t: "elicit-error"; readonly requestId: string; readonly error: WireElicitError };

/** Child → parent. */
export type WorkerToParentMessage =
  /** One reported transition — the child's projection of the uniform `report` seam. */
  | { readonly t: "transition"; readonly transition: TaskTransition }
  /**
   * A serializable elicit INTENT (ADR 69 T2b): the child's `ctx.elicit.*`
   * proxy marshals a single sugar method call `{method, args}` — NEVER the
   * live `StandardSchemaV1` (its `validate()` isn't cloneable). The parent
   * reconstructs the real request via `hooks.buildElicit(hooks.escalate)`
   * and escalates it in-runtime, where the live schema is fine. Correlated
   * back by `requestId`.
   */
  | {
      readonly t: "elicit-request";
      readonly requestId: string;
      readonly method: string;
      readonly args: readonly unknown[];
    };
