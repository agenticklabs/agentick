/**
 * In-process ChannelPublisher implementation.
 *
 * Maintains a per-channel monotonic sequence counter and routes
 * channel events through the `EventBus` via `publishLazy` — the lazy
 * subscriber-aware path. Without subscribers, channel emission costs
 * one map lookup + one counter increment (no envelope construction).
 *
 * **Scope today:** sequence assignment + bus dispatch. Retention,
 * replay-from-offset, durable persistence are session-harness
 * responsibilities (Phase 4e). When the session harness lands, it
 * implements `ChannelPublisher` itself and harnesses depending on
 * this interface switch over with no API change.
 *
 * @see docs/proposals/v2/blueprint/10-events-handlers-inbox.md §Channels
 */

import { Effect } from "effect";
import type {
  ChannelEvent,
  ChannelPublishError,
  ChannelPublisher,
  ChannelSeed,
  EventBus,
  EventScope,
  ProtocolEvent,
} from "@agentick/spec";
import { ChannelPublisherClosed, ChannelSequenceOverflow } from "@agentick/spec";

import { ulid } from "./ulid.js";
import { omitUndefined } from "@agentick/utils";

export interface LocalChannelPublisherOptions {
  /**
   * Default scope merged into channel events when the seed's `scope` is
   * undefined or partial. Useful when the publisher is created in a
   * known context (e.g., per-session).
   */
  readonly defaultScope?: EventScope;
}

export class LocalChannelPublisher implements ChannelPublisher {
  private readonly sequences = new Map<string, number>();
  private readonly defaultScope: EventScope;
  private closed = false;

  constructor(
    private readonly bus: EventBus,
    options: LocalChannelPublisherOptions = {},
  ) {
    this.defaultScope = options.defaultScope ?? {};
  }

  publish<T = unknown>(seed: ChannelSeed<T>): Effect.Effect<void, ChannelPublishError, never> {
    return Effect.suspend((): Effect.Effect<void, ChannelPublishError, never> => {
      if (this.closed) {
        return Effect.fail(new ChannelPublisherClosed());
      }
      const name = `session:channel:${seed.channel}` as const;
      const next = (this.sequences.get(seed.channel) ?? 0) + 1;
      if (!Number.isSafeInteger(next)) {
        return Effect.fail(new ChannelSequenceOverflow({ channel: seed.channel }));
      }

      // Probe the bus subscriber index before materializing — channels
      // are a canonical hot path (e.g., tool progress streams) where
      // many emissions will land on no listener.
      const willEmit = this.bus.hasSubscriberFor({ surface: "session", name, phase: "terminal" });
      if (!willEmit) {
        // Increment the sequence anyway so replay-from-offset would see
        // a continuous stream when a subscriber later attaches AND
        // someone re-publishes through a retention-aware publisher.
        // For the local publisher today, the increment is monotonic
        // and unaffected by subscriber presence — keeps semantics
        // identical whether or not anyone is listening.
        this.sequences.set(seed.channel, next);
        return Effect.void;
      }

      this.sequences.set(seed.channel, next);
      const envelope = this.buildEnvelope(seed, name, next);
      return this.bus.append(envelope);
    });
  }

  /** Diagnostic: current sequence for a channel (0 if unused). */
  sequenceOf(channel: string): number {
    return this.sequences.get(channel) ?? 0;
  }

  /** Close: subsequent publishes fail with ChannelPublisherClosed. */
  close(): void {
    this.closed = true;
  }

  // ────────── helpers ──────────

  private buildEnvelope<T>(
    seed: ChannelSeed<T>,
    name: `session:channel:${string}`,
    sequence: number,
  ): ChannelEvent<T> {
    const scope: EventScope = { ...this.defaultScope, ...(seed.scope ?? {}) };
    const envelope: ChannelEvent<T> = {
      id: ulid(),
      surface: "session",
      name,
      phase: "terminal",
      timestamp: Date.now(),
      scope,
      payload: seed.payload,
      channelSequence: sequence,
      ...omitUndefined({ opId: seed.parentOpId }),
    };
    return envelope;
  }
}

// The bus accepts ProtocolEvent — ChannelEvent extends EventEnvelope = ProtocolEvent,
// so the publish call type-checks. This assertion just documents that intent.
void (undefined as unknown as ProtocolEvent);
