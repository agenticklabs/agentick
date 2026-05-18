/**
 * `openai(modelId, options?)` — the ai-sdk-shaped factory function.
 *
 * Returns an `ExecutorFactory` that defers construction until the
 * AppHarness calls it with the app's substrate. This is what closes
 * the cross-session observability gap: the executor's events flow
 * through `app.events(...)` automatically because it shares the
 * journal/bus/inbox with every other harness.
 *
 * ```ts
 * const app = await createApp(<Agent />, {
 *   executor: openai("gpt-4o"),
 * });
 * ```
 *
 * For tests or standalone use where you need an `OpenAIExecutor`
 * instance (not a factory), construct it directly:
 *
 * ```ts
 * const exec = new OpenAIExecutor("test", journal, bus, inbox, opts);
 * ```
 *
 * @see docs/proposals/v2/IMPLEMENTATION-PLAN.md (current ordering, FAÇADE.3)
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
  OpenAIExecutor,
  type OpenAIExecutorOptions,
} from "./openai-executor.js";

/**
 * Options accepted by the `openai(...)` factory. Strict subset of
 * `OpenAIExecutorOptions` minus `model` (passed positionally) plus
 * optional substrate injection (only used when calling the factory
 * standalone — when passed to AppHarness, the app's substrate wins).
 */
export interface OpenAIFactoryOptions
  extends Omit<OpenAIExecutorOptions, "model"> {
  /**
   * Substrate injection for standalone use (calling the factory
   * directly outside an AppHarness). Ignored when the factory is
   * passed to `createApp({ executor: openai(...) })` — the app
   * supplies its own substrate.
   */
  readonly journal?: OperationJournal;
  readonly bus?: EventBus;
  readonly inbox?: MessageInbox;
  /** Stable scope id used as the executor's address suffix. */
  readonly scopeId?: string;
}

let counter = 0;

/**
 * Construct an `ExecutorFactory` advertising the given OpenAI model.
 * Defers actual executor construction until the parent harness calls
 * the factory with its substrate.
 *
 * Calling the returned factory directly (e.g., for testing) produces
 * a standalone `OpenAIExecutor` with a private in-memory substrate —
 * the factory falls back to local substrate when no parent supplies
 * one.
 */
export function openai(
  modelId: string,
  options: OpenAIFactoryOptions = {},
): ExecutorFactory {
  const factory = (deps?: ExecutorFactoryDeps): OpenAIExecutor => {
    const scopeId =
      deps?.scopeId ?? options.scopeId ?? `openai:${++counter}`;
    const journal = deps?.journal ?? options.journal ?? new MemoryJournal();
    const bus = deps?.bus ?? options.bus ?? new LocalEventBus();
    const inbox = deps?.inbox ?? options.inbox ?? new LocalInbox();

    // Strip factory-only fields before forwarding to the executor.
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

    return new OpenAIExecutor(scopeId, journal, bus, inbox, {
      ...executorOptions,
      model: modelId,
    });
  };

  // Stamp the marker so isExecutorFactory(factory) === true.
  return Object.assign(factory, { executorFactory: true as const });
}
