/**
 * `aisdk({ model, target? })` — factory function for the AI SDK bridge.
 *
 * Returns an `ExecutorFactory` ready to plug into
 * `createApp({ executor: aisdk({ model }) })`. The app supplies its
 * substrate at construction time, so `app.events(...)` sees the
 * executor's envelopes by default.
 *
 * ```ts
 * import { openai } from "@ai-sdk/openai";
 * import { aisdk } from "@agentick/executor-ai-sdk";
 *
 * const app = await createApp(<Agent />, {
 *   executor: aisdk({ model: openai("gpt-4o") }),
 * });
 * ```
 *
 * MVP scope: model-only. Tool extraction from a future
 * `aisdk({ tools: {...} })` slot lands in a follow-up — for now,
 * tools defined in JSX / via `createTool` flow through Agentick's
 * tool-executor harness as usual.
 */

import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
} from "@agentick/runtime";
import type {
  EventBus,
  ExecutorFactory,
  ExecutorFactoryDeps,
  MessageInbox,
  OperationJournal,
} from "@agentick/spec";

import {
  AISDKExecutor,
  type AISDKExecutorOptions,
} from "./ai-sdk-executor.js";

export interface AISDKFactoryOptions extends AISDKExecutorOptions {
  /**
   * Substrate injection for standalone use (calling the factory
   * directly outside an AppHarness). Ignored when passed to
   * `createApp({ executor: aisdk(...) })` — the app supplies its own.
   */
  readonly journal?: OperationJournal;
  readonly bus?: EventBus;
  readonly inbox?: MessageInbox;
  readonly scopeId?: string;
}

let counter = 0;

/**
 * Construct an `ExecutorFactory` that wraps an AI SDK `LanguageModel`
 * as our `LanguageModelExecutor`. Defers construction until the parent
 * harness (typically `AppHarness`) provides its substrate.
 */
export function aisdk(options: AISDKFactoryOptions): ExecutorFactory {
  const factory = (deps?: ExecutorFactoryDeps): AISDKExecutor => {
    const scopeId =
      deps?.scopeId ?? options.scopeId ?? `aisdk:${++counter}`;
    const journal = deps?.journal ?? options.journal ?? new MemoryJournal();
    const bus = deps?.bus ?? options.bus ?? new LocalEventBus();
    const inbox = deps?.inbox ?? options.inbox ?? new LocalInbox();

    const {
      journal: _j,
      bus: _b,
      inbox: _i,
      scopeId: _s,
      ...executorOptions
    } = options;
    void _j;
    void _b;
    void _i;
    void _s;

    return new AISDKExecutor(scopeId, journal, bus, inbox, executorOptions);
  };

  return Object.assign(factory, { executorFactory: true as const });
}
