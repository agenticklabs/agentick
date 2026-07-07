/**
 * Runtime signal family (ADR 64) — `BaseHarness.emitLog` /
 * `emitProgress` + the cross-surface subscriber query.
 *
 * Load-bearing invariants pinned here:
 *  - `emitLog` produces ONE bus event with the canonical
 *    `<surface>:signal:log` name, phase `terminal`, a `LogEventPayload`,
 *    and the caller's scope (plus the harness principal).
 *  - `emitProgress` likewise, with `<surface>:signal:progress`.
 *  - Signals are STRUCTURALLY bus-only — never journaled — even though
 *    phase `terminal` is `alwaysJournal` per `DEFAULT_JOURNALING_POLICY`.
 *  - `logEventQuery()` / `progressEventQuery()` match names emitted from
 *    ≥2 different surfaces and do NOT cross-match log↔progress.
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Fiber, Stream } from "effect";
import type {
  EventScope,
  LogEventPayload,
  MessageEnvelope,
  MessageHandlerError,
  ProgressEventPayload,
  ProtocolEvent,
} from "@agentick/spec-next";
import {
  logEventName,
  logEventQuery,
  progressEventName,
  progressEventQuery,
} from "@agentick/spec-next";

import { BaseHarness } from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";
import { compileQuery } from "../substrate/query.js";

class SignalHarness extends BaseHarness<"tool"> {
  constructor(
    scopeId: string,
    journal: MemoryJournal,
    bus: LocalEventBus,
    inbox: LocalInbox,
    principal?: string,
  ) {
    super("tool", scopeId, journal, bus, inbox, principal !== undefined ? { principal } : {});
  }

  logIt(scope: EventScope, level: LogEventPayload["level"], data: unknown, logger?: string) {
    return Effect.runPromise(this.emitLog(scope, level, data, logger));
  }

  progressIt(scope: EventScope, p: ProgressEventPayload) {
    return Effect.runPromise(this.emitProgress(scope, p));
  }

  // A normal always-journaled discrete terminal event — the control
  // case proving the journal path works while signals bypass it.
  pingJournaled(scope: EventScope) {
    return Effect.runPromise(
      this.emit({
        opId: undefined,
        name: "tool:test:ping",
        phase: "terminal",
        outcome: "succeeded",
        scope,
        payload: { hello: "world" },
      }),
    );
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.succeed(undefined);
  }
}

function harness(principal?: string): {
  h: SignalHarness;
  bus: LocalEventBus;
  journal: MemoryJournal;
} {
  const journal = new MemoryJournal({ capacity: 1024 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const h = new SignalHarness("sig-1", journal, bus, inbox, principal);
  return { h, bus, journal };
}

/** Collect the next `count` bus events matching `query`. */
async function collect(bus: LocalEventBus, count: number, run: () => Promise<void>) {
  const collected: ProtocolEvent[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe({}), (e) =>
      Effect.sync(() => {
        collected.push(e);
      }),
    ),
  );
  // Let the subscription establish before emitting.
  await new Promise((r) => setTimeout(r, 5));
  await run();
  await new Promise((r) => setTimeout(r, 10));
  await Effect.runPromise(Fiber.interrupt(fiber));
  return collected.slice(0, count === Infinity ? collected.length : count);
}

describe("BaseHarness.emitLog / emitProgress (ADR 64)", () => {
  it("emitLog produces one canonical `tool:signal:log` bus event with the LogEventPayload + scope", async () => {
    const { h, bus } = harness();
    const scope: EventScope = { sessionId: "s1", executionId: "e1", tickId: "t1" };
    const events = await collect(bus, Infinity, () =>
      h.logIt(scope, "warning", { code: 42 }, "my-logger"),
    );
    const logs = events.filter((e) => e.name === logEventName("tool"));
    expect(logs).toHaveLength(1);
    const ev = logs[0]!;
    expect(ev.surface).toBe("tool");
    expect(ev.phase).toBe("terminal");
    expect(ev.payload).toEqual({ level: "warning", data: { code: 42 }, logger: "my-logger" });
    expect(ev.scope).toMatchObject({ sessionId: "s1", executionId: "e1", tickId: "t1" });
  });

  it("emitLog omits `logger` from the payload when not supplied", async () => {
    const { h, bus } = harness();
    const events = await collect(bus, Infinity, () => h.logIt({ sessionId: "s1" }, "info", "hi"));
    const ev = events.find((e) => e.name === logEventName("tool"))!;
    expect(ev.payload).toEqual({ level: "info", data: "hi" });
  });

  it("emitProgress produces one canonical `tool:signal:progress` bus event", async () => {
    const { h, bus } = harness();
    const scope: EventScope = { sessionId: "s1", executionId: "e1" };
    const events = await collect(bus, Infinity, () =>
      h.progressIt(scope, { token: "tok-1", progress: 3, total: 10, message: "working" }),
    );
    const prog = events.filter((e) => e.name === progressEventName("tool"));
    expect(prog).toHaveLength(1);
    expect(prog[0]!.payload).toEqual({
      token: "tok-1",
      progress: 3,
      total: 10,
      message: "working",
    });
  });

  it("stamps the harness principal onto the signal scope", async () => {
    const { h, bus } = harness("acme/user-42");
    const events = await collect(bus, Infinity, () => h.logIt({ sessionId: "s1" }, "error", "x"));
    const ev = events.find((e) => e.name === logEventName("tool"))!;
    expect(ev.scope.principal).toBe("acme/user-42");
  });

  it("is structurally bus-only — signals are NEVER journaled (control ping IS)", async () => {
    const { h, bus, journal } = harness();
    // A subscriber must exist so the emit isn't short-circuited by the
    // subscriber probe.
    const drain = Effect.runFork(Stream.runDrain(bus.subscribe({})));
    await new Promise((r) => setTimeout(r, 5));

    await h.logIt({ sessionId: "s1" }, "info", "log-line");
    await h.progressIt({ sessionId: "s1" }, { token: 1, progress: 1 });
    await h.pingJournaled({ sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 10));

    const journaled = Chunk.toReadonlyArray(
      await Effect.runPromise(Stream.runCollect(journal.readByQuery({}, "beginning"))),
    );
    const names = journaled.map((e) => e.name);
    expect(names).toContain("tool:test:ping"); // control: always-journal terminal
    expect(names).not.toContain(logEventName("tool"));
    expect(names).not.toContain(progressEventName("tool"));

    await Effect.runPromise(Fiber.interrupt(drain));
  });

  it("emitLog is a cheap no-op when nobody is subscribed (subscriber probe)", async () => {
    const { h, journal } = harness();
    // No subscriber → emitSignal returns Effect.void without appending.
    await h.logIt({ sessionId: "s1" }, "info", "nobody-listening");
    const journaled = Chunk.toReadonlyArray(
      await Effect.runPromise(Stream.runCollect(journal.readByQuery({}, "beginning"))),
    );
    expect(journaled).toHaveLength(0);
  });
});

describe("logEventQuery / progressEventQuery cross-surface matching (ADR 64)", () => {
  const logMatch = compileQuery(logEventQuery());
  const progressMatch = compileQuery(progressEventQuery());

  function ev(name: string): ProtocolEvent {
    return {
      id: "x",
      surface: "tool",
      name,
      phase: "terminal",
      timestamp: 0,
      scope: {},
    };
  }

  it("logEventQuery matches log names across ≥2 surfaces", () => {
    expect(logMatch(ev(logEventName("tool")))).toBe(true);
    expect(logMatch(ev(logEventName("mcp")))).toBe(true);
    expect(logMatch(ev(logEventName("session")))).toBe(true);
  });

  it("progressEventQuery matches progress names across ≥2 surfaces", () => {
    expect(progressMatch(ev(progressEventName("tool")))).toBe(true);
    expect(progressMatch(ev(progressEventName("mcp")))).toBe(true);
  });

  it("does not cross-match log ↔ progress", () => {
    expect(logMatch(ev(progressEventName("tool")))).toBe(false);
    expect(progressMatch(ev(logEventName("tool")))).toBe(false);
  });

  it("does not match unrelated names on the signal domain shape", () => {
    expect(logMatch(ev("tool:command:run"))).toBe(false);
    expect(logMatch(ev("tool:signal:log:extra"))).toBe(false); // 4 segments, pattern is 3
  });
});
