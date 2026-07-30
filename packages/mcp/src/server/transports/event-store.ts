/**
 * Resumability storage for the Streamable HTTP transport — a bounded,
 * in-process reference {@link EventStore}.
 *
 * ## What an event store buys
 *
 * Streamable HTTP delivers server→client messages over SSE. When that
 * connection drops (a proxy timeout, a laptop lid, a flaky mobile link)
 * the client reconnects with `Last-Event-ID`. WITHOUT a store the server
 * has nothing to replay and every message sent during the gap is gone —
 * a long-running tool call's progress notifications and its final result
 * included. WITH one, the SDK replays the events the client missed and
 * the call completes as if nothing happened.
 *
 * Resumability is therefore OPT-IN CONFIG, never a silent default: a
 * store retains messages in memory, and a server that neither needs nor
 * budgets for that must not grow one behind the adopter's back.
 *
 *   httpTransport({ port: 3000, eventStore: inMemoryEventStore() })
 *
 * ## The bound
 *
 * This implementation keeps the most recent {@link
 * InMemoryEventStoreOptions.maxEvents} events ACROSS ALL STREAMS (default
 * {@link DEFAULT_MAX_EVENTS}) and drops the oldest beyond that. A client
 * reconnecting with an event id that has already aged out is told the id
 * is unknown; the SDK answers `400` and the client opens a fresh stream —
 * it loses the gap's messages, exactly as if no store were configured.
 * Size the cap against the largest burst a client could sleep through.
 *
 * It is a REFERENCE implementation: single-process, non-durable, and
 * therefore wrong for a multi-node deployment where a reconnect can land
 * on a different node. Implement the SDK's `EventStore` against Redis /
 * Postgres / your own log and pass that instead — the option takes any
 * conforming store.
 *
 * @see https://modelcontextprotocol.io/specification/basic/transports — resumability
 */

import type {
  EventId,
  EventStore,
  StreamId,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Events retained across all streams when no cap is configured. */
export const DEFAULT_MAX_EVENTS = 1000;

export interface InMemoryEventStoreOptions {
  /**
   * Maximum events retained across ALL streams. The oldest is dropped
   * when the store exceeds it. Defaults to {@link DEFAULT_MAX_EVENTS}.
   */
  readonly maxEvents?: number;
}

interface StoredEvent {
  readonly streamId: StreamId;
  readonly message: JSONRPCMessage;
}

/**
 * Build a bounded in-memory {@link EventStore}. Pass it as the HTTP
 * transport's `eventStore` to enable SSE resumability for that server.
 *
 * Event ids are `<streamId>:<sequence>` with a zero-padded, strictly
 * increasing sequence, so an id is opaque to clients but ordered and
 * unforgeable-by-accident here. Replay walks insertion order (a `Map`
 * preserves it) and emits only the anchor stream's events.
 *
 * @verifiedBy packages/mcp/src/server/transports/__tests__/event-store.spec.ts
 */
export function inMemoryEventStore(options: InMemoryEventStoreOptions = {}): EventStore {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  /** Insertion-ordered: iteration order IS chronological order. */
  const events = new Map<EventId, StoredEvent>();
  let sequence = 0;

  return {
    async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
      sequence += 1;
      const eventId = `${streamId}:${String(sequence).padStart(12, "0")}`;
      events.set(eventId, { streamId, message });
      // Drop from the front — `Map` iteration starts at the oldest entry.
      while (events.size > maxEvents) {
        const oldest = events.keys().next();
        if (oldest.done === true) break;
        events.delete(oldest.value);
      }
      return eventId;
    },

    /**
     * Exact lookup rather than parsing the id: an aged-out id resolves to
     * `undefined`, which is what tells the SDK to answer `400` instead of
     * replaying a stream the client never had.
     */
    async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
      return events.get(eventId)?.streamId;
    },

    async replayEventsAfter(
      lastEventId: EventId,
      { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
    ): Promise<StreamId> {
      const anchor = events.get(lastEventId);
      // Unknown / evicted anchor — nothing to replay, and no stream to
      // claim. The SDK's own reference store answers the same way.
      if (anchor === undefined) return "";
      let afterAnchor = false;
      for (const [eventId, event] of events) {
        if (eventId === lastEventId) {
          afterAnchor = true;
          continue;
        }
        if (!afterAnchor || event.streamId !== anchor.streamId) continue;
        await send(eventId, event.message);
      }
      return anchor.streamId;
    },
  };
}
