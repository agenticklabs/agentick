/**
 * `stubInbox` — canned-answer inbox double with call recording.
 *
 * Meszaros tiers for the substrate: the FAKES are the production
 * in-memory implementations themselves (`LocalInbox`, `LocalEventBus`,
 * `MemoryJournal` — real routing, real semantics). This is the STUB
 * tier: no routing, scripted replies keyed by message type or address,
 * every ask/send recorded for assertion.
 *
 * ```ts
 * const { inbox, asks } = stubInbox({
 *   replies: { "timeline:commands": { commands: [...] } },
 * });
 * // exercise code under test with `inbox`, then assert on `asks`.
 * ```
 */

import { Effect } from "effect";

import type { MessageAck, MessageInbox } from "@agentick/spec";

export interface StubInboxCall {
  readonly address: string;
  readonly type: string;
  readonly origin?: string;
  readonly payload?: unknown;
}

export interface StubInboxOptions {
  /**
   * Scripted replies. Resolution order: exact `"${address}::${type}"`
   * key, then bare `type` key, then the `fallback` fn, then a rejected
   * Effect (`no scripted reply`). A `Function` value is called with the
   * recorded call to compute the reply (or throw to script a failure).
   */
  readonly replies?: Readonly<Record<string, unknown | ((call: StubInboxCall) => unknown)>>;
  /** Last-resort reply factory. */
  readonly fallback?: (call: StubInboxCall) => unknown;
}

export function stubInbox(options: StubInboxOptions = {}): {
  inbox: MessageInbox;
  asks: StubInboxCall[];
  sends: StubInboxCall[];
} {
  const asks: StubInboxCall[] = [];
  const sends: StubInboxCall[] = [];

  const reply = (call: StubInboxCall): Effect.Effect<unknown, Error> => {
    const scripted =
      options.replies?.[`${call.address}::${call.type}`] ?? options.replies?.[call.type];
    const source = scripted ?? options.fallback;
    if (source === undefined) {
      return Effect.fail(
        new Error(`stubInbox: no scripted reply for "${call.type}" at "${call.address}"`),
      );
    }
    return Effect.try({
      try: () =>
        typeof source === "function" ? (source as (c: StubInboxCall) => unknown)(call) : source,
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
  };

  const record = (
    sink: StubInboxCall[],
    address: string,
    input: { type: string; origin?: string; payload?: unknown },
  ): StubInboxCall => {
    const call: StubInboxCall = {
      address,
      type: input.type,
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    };
    sink.push(call);
    return call;
  };

  const inbox = {
    ask: (address: string, input: { type: string; origin?: string; payload?: unknown }) =>
      reply(record(asks, address, input)),
    send: (address: string, input: { type: string; origin?: string; payload?: unknown }) => {
      record(sends, address, input);
      return Effect.succeed({ messageId: `stub-${sends.length}`, receivedAt: 0 } as MessageAck);
    },
    register: () => Effect.succeed(() => {}),
  } as unknown as MessageInbox;

  return { inbox, asks, sends };
}
