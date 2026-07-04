/**
 * `run()` — one-shot execution (v1 parity, #171). The middle rung of
 * the ergonomics ladder:
 *
 *   generate({ model, messages })   — one model call, no tree, no loop
 *   run(<Agent/>, { model, ... })   — one EXECUTION: tree + loop + tools,
 *                                     nothing persists
 *   createApp + session             — persistent
 *
 * Spins up a temporary app + session, sends once, and tears everything
 * down when the execution settles. The returned handle is awaitable
 * three ways, mirroring v1:
 *
 * ```ts
 * const result = await run(<Agent />, { model: openai("gpt-4o"), messages }).result;
 *
 * const handle = await run(<Agent />, { model, messages });
 * for await (const event of handle) render(event);
 *
 * for await (const event of run(<Agent />, { model, messages })) render(event);
 * ```
 */

import type {
  SendMessageInput,
  SendResult,
  SessionExecutionHandle,
  StreamEvent,
  TimelineEntry,
} from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

import { MemoryTimelineStore } from "@agentick/timeline-next";
import { ulid } from "@agentick/utils-next";

import { createApp, type CreateAppOptions } from "./create-app.js";

/**
 * Options for {@link run}: everything `createApp` accepts plus the
 * send-level fields for the single execution.
 */
export interface RunOptions<P = unknown> extends CreateAppOptions<P> {
  /** Messages queued for the single execution. */
  readonly messages?: ReadonlyArray<SendMessageInput>;
  /**
   * Seed the session's timeline before the run (#187) — the replay /
   * eval loop: `snapshot().timeline` from a previous session goes in
   * here verbatim. Implemented as a pre-populated store handed to the
   * ADR 49 hydration path (no bespoke seeding machinery).
   */
  readonly history?: ReadonlyArray<TimelineEntry>;
  /** Component props for the run (SendInput.props). */
  readonly props?: P;
  /** Tick bound for the single execution. */
  readonly maxTicks?: number;
  /** Abort the in-flight execution (the app still tears down). */
  readonly signal?: AbortSignal;
}

/**
 * The value `run()` returns: a promise of the live
 * `SessionExecutionHandle`, augmented so `.result` and `for await`
 * work without the intermediate `await` (v1 `ProcedurePromise`
 * ergonomics).
 */
export type RunHandle = Promise<SessionExecutionHandle> &
  AsyncIterable<StreamEvent> & {
    readonly result: Promise<SendResult>;
  };

/**
 * Execute an agent element once. Creates a temporary app + session,
 * sends, and auto-closes the app when the execution settles — stream
 * events are delivered during the execution, so iteration completes
 * before teardown.
 *
 * Note: breaking out of the `for await` early does NOT abort the run —
 * teardown is tied to the execution settling, not to iterator completion,
 * so the execution runs to completion and then tears down. To cancel
 * early, pass `signal`.
 */
export function run<P = unknown>(rootElement: unknown, options: RunOptions<P>): RunHandle {
  const { messages, props, maxTicks, signal, history, ...appOptions } = options;

  const handlePromise = (async (): Promise<SessionExecutionHandle> => {
    let finalOptions = appOptions as CreateAppOptions<P>;
    const sessionId = `run:${ulid()}`;
    if (history !== undefined && history.length > 0) {
      // Pre-populate a store under the run's session id and hand it to
      // the ADR 49 hydration path — seeding IS resuming.
      const store = new MemoryTimelineStore();
      // The timeline harness keys the store by its scopeId — `${sessionId}:timeline`.
      await store.append(`${sessionId}:timeline`, history);
      finalOptions = {
        ...finalOptions,
        session: {
          ...finalOptions.session,
          timeline: { ...finalOptions.session?.timeline, store },
        },
      };
    }
    const app = await createApp(rootElement, finalOptions);
    try {
      const session = await app.createSession({ sessionId });
      const handle = await session.send({
        ...omitUndefined({ messages, props, maxTicks, signal }),
      });
      // Auto-teardown once the execution settles (success, error, or
      // abort). Errors are the caller's to observe via handle.result;
      // teardown itself must never mask them.
      void handle.result
        .catch(() => {})
        .finally(() => {
          void app.close().catch(() => {});
        });
      return handle;
    } catch (cause) {
      await app.close().catch(() => {});
      throw cause;
    }
  })();

  const result = handlePromise.then((h) => h.result);
  // A caller iterating the stream (or only awaiting the handle) never
  // touches `.result` — keep its rejection from surfacing as an
  // unhandled rejection. The promise handed to the caller still
  // rejects when awaited.
  void result.catch(() => {});

  return Object.assign(handlePromise, {
    result,
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      const iterPromise = handlePromise.then((h) => h[Symbol.asyncIterator]());
      return {
        async next(): Promise<IteratorResult<StreamEvent>> {
          return (await iterPromise).next();
        },
      };
    },
  }) as RunHandle;
}
