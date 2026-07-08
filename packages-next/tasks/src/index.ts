/**
 * @agentick/tasks-next — TasksHarness.
 *
 * Substrate-level "long-running tool" primitive. Every managed
 * execution — slow shell commands, deploy steps, MCP server tasks
 * (2025-11-25 core / draft extension), multi-tick LLM completions
 * — funnels through this one protocol so the lifecycle FSM,
 * progress envelope, correlation engine, and cancellation semantics
 * live in exactly one place.
 *
 * Private workspace package. Bundled into the `agentick` metapackage;
 * not published independently.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md §Tasks
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

// Side-effect import — registers the `bridges.tasks` slot on
// `HookBridges` via TypeScript module augmentation. Per ADR 27, every
// harness package owns its own slot declaration.
import "./augment.js";

export { TasksHarness, type TasksHarnessOptions } from "./harness.js";
export { withTasks, type WithTasksOptions } from "./extension.js";
// ADR 68 — record-as-source-of-truth durability. The CRUD store port +
// bundled in-memory default + its conformance suite, and the default
// in-process executor. A `@agentick/tasks-postgres-next` store and a
// child-process executor conform to the SAME spec-next ports later.
export { InMemoryTaskStore } from "./store.js";
export { runTaskStoreConformance, type TaskStoreConformanceOptions } from "./store-conformance.js";
export { InProcessTaskExecutor } from "./executor.js";
// Re-export the ports from the same package as the bundled impls so store
// / executor adapters get the contract + reference from one dep.
export type {
  TaskExecution,
  TaskExecutor,
  TaskRecord,
  TaskReport,
  TaskStore,
  TaskStoreQuery,
  TaskTransition,
  TaskWork,
} from "@agentick/spec-next";
export { EXTENSION_NAME as TASKS_EXTENSION_NAME } from "./extension-name.js";
export {
  SESSION_TASKS_LIST,
  SESSION_TASKS_GET,
  SESSION_TASKS_CANCEL,
  SESSION_TASKS_AWAIT,
  buildSessionTasksTools,
  type SessionTasksToolsBundle,
} from "./tools.js";
export {
  runTasksHarnessConformance,
  type TasksConformanceFactory,
  type TasksConformanceFactoryInput,
  type TasksConformanceShell,
} from "./conformance.js";
export {
  TASK_PROGRESS_CHANNEL,
  TASK_PROGRESS_CHANNEL_FQN,
  TASK_STATUS_CHANNEL,
  TASK_STATUS_CHANNEL_FQN,
  type TaskProgressChannelName,
  type TaskStatusChannelName,
} from "./channel.js";
export {
  TASKS_CANCEL_MESSAGE_TYPE,
  TASKS_GET_MESSAGE_TYPE,
  TASKS_RESULT_MESSAGE_TYPE,
  type TasksCancelInboxPayload,
  type TasksCancelMessageType,
  type TasksGetInboxPayload,
  type TasksGetMessageType,
  type TasksResultInboxPayload,
  type TasksResultMessageType,
  type TasksResultReply,
} from "./inbox-protocol.js";
