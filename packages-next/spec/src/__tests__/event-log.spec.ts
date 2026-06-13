/**
 * Spec-level smoke tests for `EventLog<E>` and friends (ADR 29 Phase C.1).
 *
 * Type-surface only — no runtime impl exists yet. These tests lock the
 * shape so downstream packages can write against the contract while
 * C.2/C.3 land the concrete implementations.
 */

import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import {
  CursorEvictedError,
  type CompiledMatcher,
  type Cursor,
  type EventKey,
  type EventLog,
  type LogMetrics,
  type ProtocolEvent,
} from "../index.js";

describe("Cursor", () => {
  it("is a structurally-typed monotonic position", () => {
    const c: Cursor = { value: 0 };
    expect(c.value).toBe(0);
  });

  it("two cursors with the same value are equal by content (but not identity-comparable across logs)", () => {
    const a: Cursor = { value: 42 };
    const b: Cursor = { value: 42 };
    expect(a.value).toBe(b.value);
    // Note: this comparison is meaningful WITHIN one log only; the spec
    // intentionally does not make Cursor a branded type because cross-
    // log identity is not part of the contract.
  });
});

describe("CompiledMatcher<E>", () => {
  it("is a generic per-event predicate", () => {
    const protocolMatcher: CompiledMatcher<ProtocolEvent> = (e) => e.surface === "executor";
    const stringMatcher: CompiledMatcher<string> = (s) => s.startsWith("ok:");
    expect(stringMatcher("ok:1")).toBe(true);
    expect(stringMatcher("err:1")).toBe(false);
    // ProtocolEvent variant unused here; just lock the type.
    void protocolMatcher;
  });
});

describe("CursorEvictedError", () => {
  it("carries the requested + oldest-available cursors", () => {
    const requested: Cursor = { value: 100 };
    const oldest: Cursor = { value: 250 };
    const err = new CursorEvictedError(requested, oldest);
    expect(err._tag).toBe("CursorEvictedError");
    expect(err.requested).toBe(requested);
    expect(err.oldestAvailable).toBe(oldest);
    expect(err.message).toContain("100");
    expect(err.message).toContain("250");
  });

  it("is a real Error subclass (instanceof works)", () => {
    const err = new CursorEvictedError({ value: 0 }, { value: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CursorEvictedError);
  });
});

describe("LogMetrics", () => {
  it("structurally accepts a fresh-log snapshot", () => {
    const m: LogMetrics = {
      eventsPerSecond: 0,
      subscriberCount: 0,
      cursorLagP99: 0,
      dropRate: 0,
      retentionEvents: 0,
    };
    expect(m.eventsPerSecond).toBe(0);
  });

  it("structurally accepts a non-trivial snapshot", () => {
    const m: LogMetrics = {
      eventsPerSecond: 1234.5,
      subscriberCount: 3,
      cursorLagP99: 12.4,
      dropRate: 0.001,
      retentionEvents: 8192,
    };
    expect(m.subscriberCount).toBe(3);
    expect(m.dropRate).toBeGreaterThan(0);
    expect(m.dropRate).toBeLessThan(1);
  });
});

describe("EventLog<E> — structural shape", () => {
  it("a hand-written impl over a string log satisfies the interface", () => {
    // Minimal fake impl proves the shape compiles. C.2 ships the real
    // ring-buffer LocalEventBus impl over ProtocolEvent.
    class StringLog implements EventLog<string> {
      private readonly events: string[] = [];
      append(event: string): Effect.Effect<void, never, never> {
        return Effect.sync(() => {
          this.events.push(event);
        });
      }
      appendBatch(events: ReadonlyArray<string>): Effect.Effect<void, never, never> {
        return Effect.sync(() => {
          for (const e of events) this.events.push(e);
        });
      }
      read(
        _cursor: Cursor,
        _matcher: CompiledMatcher<string>,
      ): Stream.Stream<string, CursorEvictedError, never> {
        // Skeleton — real impls walk the ring buffer from the cursor.
        return Stream.empty as Stream.Stream<string, CursorEvictedError, never>;
      }
      hasSubscriberFor(_key: EventKey): boolean {
        return false;
      }
      metrics(): LogMetrics {
        return {
          eventsPerSecond: 0,
          subscriberCount: 0,
          cursorLagP99: 0,
          dropRate: 0,
          retentionEvents: this.events.length,
        };
      }
    }
    const log: EventLog<string> = new StringLog();
    expect(log.metrics().retentionEvents).toBe(0);
  });
});
