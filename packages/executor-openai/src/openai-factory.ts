/**
 * `openai(modelId, options?)` — the ai-sdk-shaped factory function.
 *
 * Hides the substrate constructor args of `OpenAIExecutor` so the
 * common case is one line:
 *
 * ```ts
 * const app = await createApp(<Agent />, {
 *   executor: openai("gpt-4o"),
 * });
 * ```
 *
 * The factory constructs a default in-memory substrate when called
 * directly. When the App harness adopts factory-form executor slots
 * (FAÇADE.3), it will instead pass the app's substrate so events flow
 * through `app.events(...)`. Until then, callers wanting cross-session
 * observability should construct the substrate themselves and pass it
 * via `options.journal/bus/inbox`.
 *
 * @see docs/proposals/v2/IMPLEMENTATION-PLAN.md (current ordering, FAÇADE)
 */

import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
} from "@agentick/runtime";
import type { EventBus, MessageInbox, OperationJournal } from "@agentick/spec";

import {
  OpenAIExecutor,
  type OpenAIExecutorOptions,
} from "./openai-executor.js";

/**
 * Options accepted by the `openai(...)` factory. Strict subset of
 * `OpenAIExecutorOptions` minus `model` (passed positionally as the
 * first arg) plus optional substrate injection slots.
 */
export interface OpenAIFactoryOptions
  extends Omit<OpenAIExecutorOptions, "model"> {
  /** Substrate injection — defaults to fresh in-memory locals. */
  readonly journal?: OperationJournal;
  readonly bus?: EventBus;
  readonly inbox?: MessageInbox;
  /** Stable scope id used as the executor's address suffix. */
  readonly scopeId?: string;
}

let counter = 0;

/**
 * Construct an `OpenAIExecutor` advertising itself as the given model.
 * One line replaces the verbose four-arg constructor + manual substrate.
 *
 * ```ts
 * executor: openai("gpt-4o", { apiKey: process.env.OPENAI_API_KEY })
 * ```
 */
export function openai(
  modelId: string,
  options: OpenAIFactoryOptions = {},
): OpenAIExecutor {
  const {
    journal = new MemoryJournal(),
    bus = new LocalEventBus(),
    inbox = new LocalInbox(),
    scopeId = `openai:${++counter}`,
    ...rest
  } = options;

  return new OpenAIExecutor(scopeId, journal, bus, inbox, {
    ...rest,
    model: modelId,
  });
}
