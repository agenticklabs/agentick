/**
 * `stubTasks()` — canned-answer stub conforming to
 * {@link TasksHarnessProtocol}. No substrate, no registry. Useful
 * for tests that need to inject a `tasks` slot without spinning up
 * a real harness — wire-shape conformance checks, harness-consumer
 * unit tests, etc.
 *
 * Per the test-doubles convention: `stub*` for canned answers.
 */

import { omitUndefined } from "@agentick/utils-next";

import type { Effect } from "effect";

import type {
  ContentBlock,
  ProgressUpdate,
  TaskCreationInput,
  TaskEvent,
  TaskHandle,
  TaskInfo,
  TaskStatus,
  TaskWorkContext,
  TasksHarnessProtocol,
} from "@agentick/spec-next";
import { UnknownTaskError } from "@agentick/spec-next";

export interface StubTasksOptions {
  /** Identity surfaced as `id` / `scopeId` (`tasks:${id}`). */
  readonly id?: string;
  /**
   * Optional handler invoked whenever a caller calls `submit`. Lets
   * tests observe the work argument without exercising it. Receives
   * the work function as-is — Promise/sync or Effect — so observer
   * tests can branch on `Effect.isEffect(work)` if needed.
   */
  readonly onSubmit?: <T>(
    work: (ctx: TaskWorkContext) => Promise<T> | T | Effect.Effect<T, unknown, never>,
    opts?: TaskCreationInput,
  ) => void;
  /**
   * Canned result `submit` resolves with. Defaults to an empty
   * `ContentBlock[]`. Used as the resolved value of `result`.
   */
  readonly cannedResult?: readonly ContentBlock[];
}

export function stubTasks(options: StubTasksOptions = {}): TasksHarnessProtocol {
  const id = options.id ?? "stub-tasks";
  const cannedResult = options.cannedResult ?? [];
  const known = new Map<string, TaskInfo>();

  let counter = 0;
  const makeId = (): string => `task:stub:${counter++}`;

  function submitImpl<T = readonly ContentBlock[]>(
    workOrOpts:
      | ((ctx: TaskWorkContext) => Promise<T> | T | Effect.Effect<T, unknown, never>)
      | (TaskCreationInput & { handlerRef: string; executorKind: string })
      | undefined,
    maybeOpts: TaskCreationInput = {},
  ): TaskHandle<T> {
    // Mirror the harness's two call forms: closure (work, opts?) vs by-ref
    // (opts only). The stub runs nothing either way — it hands back a
    // canned terminal handle.
    const work = typeof workOrOpts === "function" ? workOrOpts : undefined;
    const opts: TaskCreationInput =
      typeof workOrOpts === "function" ? maybeOpts : (workOrOpts ?? maybeOpts);
    if (work !== undefined) options.onSubmit?.(work, opts);
    const taskId = makeId();
    const now = Date.now();
    const info: TaskInfo = {
      taskId,
      status: "completed",
      createdAt: now,
      lastUpdatedAt: now,
      ttl: opts.ttl ?? null,
      ...omitUndefined({ statusMessage: opts.statusMessage, pollInterval: opts.pollInterval }),
    };
    known.set(taskId, info);

    const result = Promise.resolve(cannedResult as unknown as T);
    const handle: TaskHandle<T> = {
      taskId,
      initialStatus: "completed",
      result,
      info: (): TaskInfo => info,
      events: (): AsyncIterable<TaskEvent> => ({
        // Pre-completed task — emit a single status event and close.
        [Symbol.asyncIterator]: (): AsyncIterator<TaskEvent> => {
          let yielded = false;
          return {
            next: async (): Promise<IteratorResult<TaskEvent>> => {
              if (!yielded) {
                yielded = true;
                return { value: { kind: "status", info } as TaskEvent, done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
      }),
      // Direct iteration is sugar over `events()` — ONE stream source.
      [Symbol.asyncIterator]: (): AsyncIterator<TaskEvent> =>
        handle.events()[Symbol.asyncIterator](),
      cancel: async (): Promise<void> => {
        // No-op — the canned task is already terminal.
      },
    };
    return handle;
  }

  // Silence unused-var hints for unused stub features.
  void ((_p: ProgressUpdate): void => {});

  return {
    id,
    address: `tasks:${id}`,
    ready: Promise.resolve(),
    submit: submitImpl,
    get: (taskId: string): TaskInfo | undefined => known.get(taskId),
    list: (): readonly TaskInfo[] => Array.from(known.values()),
    status: (taskId: string): TaskStatus | undefined => known.get(taskId)?.status,
    async result<T = readonly ContentBlock[]>(taskId: string): Promise<T> {
      if (!known.has(taskId)) {
        throw new UnknownTaskError({ taskId });
      }
      return cannedResult as unknown as T;
    },
    async cancel(taskId: string, _reason?: string): Promise<void> {
      if (!known.has(taskId)) {
        throw new UnknownTaskError({ taskId });
      }
      // canned tasks complete immediately — cancel is a no-op.
    },
    events(taskId: string): AsyncIterable<TaskEvent> {
      const info = known.get(taskId);
      if (!info) {
        throw new UnknownTaskError({ taskId });
      }
      return {
        [Symbol.asyncIterator]: (): AsyncIterator<TaskEvent> => {
          let yielded = false;
          return {
            next: async (): Promise<IteratorResult<TaskEvent>> => {
              if (!yielded) {
                yielded = true;
                return { value: { kind: "status", info } as TaskEvent, done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
    async close(): Promise<void> {
      // no-op
    },
  };
}
