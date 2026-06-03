/**
 * `google(modelId, options?)` — factory mirroring `anthropic(...)` and
 * `openai(...)`. Returns an `ExecutorFactory` that defers
 * `GoogleExecutor` construction until the AppHarness wires the
 * substrate (journal/bus/inbox).
 */

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  EventBus,
  ExecutorFactory,
  ExecutorFactoryDeps,
  MessageInbox,
  OperationJournal,
} from "@agentick/spec";

import { GoogleExecutor, type GoogleExecutorOptions } from "./google-executor.js";

export interface GoogleFactoryOptions extends Omit<GoogleExecutorOptions, "model"> {
  readonly journal?: OperationJournal;
  readonly bus?: EventBus;
  readonly inbox?: MessageInbox;
  readonly scopeId?: string;
}

let counter = 0;

export function google(
  modelId: string,
  options: GoogleFactoryOptions = {},
): ExecutorFactory {
  const factory = (deps?: ExecutorFactoryDeps): GoogleExecutor => {
    const scopeId = deps?.scopeId ?? options.scopeId ?? `google:${++counter}`;
    const journal = deps?.journal ?? options.journal ?? new MemoryJournal();
    const bus = deps?.bus ?? options.bus ?? new LocalEventBus();
    const inbox = deps?.inbox ?? options.inbox ?? new LocalInbox();

    const { journal: _j, bus: _b, inbox: _i, scopeId: _s, ...executorOptions } = options;
    void _j;
    void _b;
    void _i;
    void _s;

    return new GoogleExecutor(scopeId, journal, bus, inbox, {
      ...executorOptions,
      model: modelId,
    });
  };

  return Object.assign(factory, { executorFactory: true as const });
}
