/**
 * Testing helpers — `fakeTasks()` + `stubTasks()`.
 *
 * `fakeTasks()` wraps a real `TasksHarness` on a fresh in-memory
 * substrate, returning a bundle that includes the harness + its bus
 * + a `close()`. Use in tests that exercise the full lifecycle.
 *
 * `stubTasks()` returns a canned-answer stub that satisfies
 * {@link TasksHarnessProtocol} for tests that consume the protocol
 * but don't need a real registry.
 */

export { fakeTasks, type FakeTasksBundle, type FakeTasksOptions } from "./fake-tasks.js";
export { stubTasks, type StubTasksOptions } from "./stub-tasks.js";

// ────────── Conformance suite (imports vitest — testing-only) ──────────
export { runTaskStoreConformance, type TaskStoreConformanceOptions } from "../store-conformance.js";
export {
  runTaskExecutorConformance,
  type TaskExecutorCase,
  type TaskExecutorConformanceHarness,
  type TaskExecutorConformanceOptions,
} from "../executor-conformance.js";
export {
  runTasksHarnessConformance,
  type TasksConformanceFactory,
  type TasksConformanceFactoryInput,
  type TasksConformanceShell,
} from "../conformance.js";
