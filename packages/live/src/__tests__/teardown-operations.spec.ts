/**
 * ADR 92 §Family 2 item 6 — in-process live teardown IS an operation.
 *
 * The claim under test: `stop` / `close` no longer mutate the stream registry
 * as plain methods. They run as `live:command:{stop,close}` — so a turn
 * arbiter's local hangup is guardable, hookable, and audited exactly like the
 * remote one the wire path (ADR 90) already enveloped.
 *
 * Pins, one describe per contract clause:
 *
 *   1. `stop` emits the op with the `{ sessionId, streamId }` scope and
 *      journals both `requested` and `terminal`.
 *   2. A guard veto blocks a hangup — the stream stays live.
 *   3. `close` emits its op and produces a nested `stop` record per live
 *      stream (layered execution = layered journal records), and is BUS-ONLY
 *      per the house close-op policy.
 *   4. `start` is deliberately NOT an op (Family 3, the sync-return seam).
 *
 * @see docs/proposals/v2/blueprint/92-operation-grammar-completion.md
 */

import { afterEach, describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { LiveStream, MediaFrame, ProtocolEvent } from "@agentick/spec";

import { LIVE_STATE_CHANNEL_FQN, type LiveStateFrame } from "../channel.js";
import { LiveHarness } from "../harness.js";

// ============================================================================
// Fixtures
// ============================================================================

const SESSION_ID = "sess-live-1";
const STOP_OP = "live:command:stop";
const CLOSE_OP = "live:command:close";

function frame(seq: number): MediaFrame {
  return {
    kind: "audio",
    envelope: { format: "audio/pcm", sampleRate: 16000, timestamp: seq, seq },
    payload: new Uint8Array([seq]),
  };
}

interface Rig {
  readonly harness: LiveHarness;
  readonly journal: MemoryJournal;
  /** Every envelope on the bus — the live ops AND the session control channels. */
  readonly events: ProtocolEvent[];
  /** Every stream born through `start`, keyed by id (the `onStream` capture). */
  readonly streams: Map<string, LiveStream>;
  readonly teardown: () => Promise<void>;
}

let active: Rig | undefined;

async function rig(): Promise<Rig> {
  const bus = new LocalEventBus();
  const journal = new MemoryJournal({ capacity: 10_000 });
  const streams = new Map<string, LiveStream>();
  const harness = new LiveHarness(SESSION_ID, journal, bus, new LocalInbox(), {
    onStream: (s) => streams.set(s.ref.streamId, s),
  });
  await harness.ready;

  const events: ProtocolEvent[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe({}), (e) =>
      Effect.sync(() => {
        events.push(e);
      }),
    ),
  );

  let closed = false;
  const r: Rig = {
    harness,
    journal,
    events,
    streams,
    teardown: async () => {
      if (!closed) {
        closed = true;
        await harness.close().catch(() => undefined);
      }
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
  active = r;
  return r;
}

/** Settle the microtask + bus fan-out queue. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function opsNamed(events: readonly ProtocolEvent[], name: string): readonly ProtocolEvent[] {
  return events.filter((e) => e.name === name);
}

/** `live-state` channel frames announcing a stream reached `closed`. */
function closedFrames(events: readonly ProtocolEvent[]): readonly ProtocolEvent[] {
  return events.filter(
    (e) =>
      e.name === LIVE_STATE_CHANNEL_FQN &&
      (e.payload as LiveStateFrame | undefined)?.state === "closed",
  );
}

async function journaled(journal: MemoryJournal, name: string): Promise<readonly ProtocolEvent[]> {
  const out = await Effect.runPromise(
    Stream.runCollect(journal.readByQuery({ name: { exact: name } }, "beginning")),
  );
  return Array.from(out);
}

afterEach(async () => {
  await active?.teardown();
  active = undefined;
});

// ============================================================================
// 1 — the op, its scope, and its journal policy
// ============================================================================

describe("an in-process stop runs as live:command:stop", () => {
  it("emits the op with the sessionId + streamId scope", async () => {
    const r = await rig();
    r.harness.start("s-1");

    await r.harness.stop("s-1", { hard: true, reason: "user_hangup" });
    await settle();

    const ops = opsNamed(r.events, STOP_OP);
    expect(ops.length).toBeGreaterThan(0);
    for (const e of ops) {
      expect(e.surface).toBe("live");
      expect(e.scope.sessionId).toBe(SESSION_ID);
      expect(e.scope.streamId).toBe("s-1");
    }
    expect(ops.find((e) => e.phase === "terminal")?.outcome).toBe("succeeded");
  });

  it("journals BOTH requested and terminal, carrying the teardown reason", async () => {
    const r = await rig();
    r.harness.start("s-2");

    await r.harness.stop("s-2", { reason: "silence_timeout" });
    await settle();

    const rows = await journaled(r.journal, STOP_OP);
    expect(rows.map((e) => e.phase)).toEqual(expect.arrayContaining(["requested", "terminal"]));
    expect(rows.find((e) => e.phase === "requested")?.payload).toEqual({
      streamId: "s-2",
      reason: "silence_timeout",
    });
  });

  it("behavior is unchanged — the stream closes once and stop stays idempotent", async () => {
    const r = await rig();
    r.harness.start("s-3");

    await r.harness.stop("s-3");
    await r.harness.stop("s-3"); // idempotent — the second body is a no-op
    await settle();

    const terminals = opsNamed(r.events, STOP_OP).filter((e) => e.phase === "terminal");
    expect(terminals).toHaveLength(2);
    expect(terminals.every((e) => e.outcome === "succeeded")).toBe(true);
    // The op ran twice; the CLOSE announcement happened exactly once.
    expect(closedFrames(r.events)).toHaveLength(1);
  });
});

// ============================================================================
// 2 — the guard seam
// ============================================================================

describe("a guard veto blocks an in-process hangup", () => {
  it("the stream stays live and the terminal outcome is vetoed", async () => {
    const r = await rig();
    const uplink: MediaFrame[] = [];
    const ref = r.harness.start("s-keep");
    r.streams.get("s-keep")!.onFrame((f) => uplink.push(f));

    r.harness.guard(() => ({ kind: "veto", reason: "recording-in-progress" }));
    await expect(r.harness.stop("s-keep")).rejects.toBeTruthy();
    await settle();

    expect(opsNamed(r.events, STOP_OP).find((e) => e.phase === "terminal")?.outcome).toBe("vetoed");
    // The stream SURVIVED: nothing announced `closed`, and uplink still routes
    // to its listeners — the registry entry was never touched.
    expect(closedFrames(r.events)).toHaveLength(0);
    r.harness.push(ref, frame(1));
    expect(uplink).toHaveLength(1);
  });

  it("a guard reading the input can veto ONE stream and let a sibling through", async () => {
    const r = await rig();
    r.harness.start("protected");
    r.harness.start("ordinary");
    r.harness.guard<{ readonly streamId: string }>((input) =>
      input.streamId === "protected" ? { kind: "veto", reason: "policy" } : undefined,
    );

    await expect(r.harness.stop("protected")).rejects.toBeTruthy();
    await r.harness.stop("ordinary");
    await settle();

    const outcomes = opsNamed(r.events, STOP_OP)
      .filter((e) => e.phase === "terminal")
      .map((e) => [e.scope.streamId, e.outcome]);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        ["protected", "vetoed"],
        ["ordinary", "succeeded"],
      ]),
    );
  });
});

// ============================================================================
// 3 — close: its own op, layered stop records, bus-only policy
// ============================================================================

describe("close runs as live:command:close", () => {
  it("emits the op and a nested stop record per live stream", async () => {
    const r = await rig();
    r.harness.start("a");
    r.harness.start("b");

    await r.harness.close();
    await settle();

    const closeOps = opsNamed(r.events, CLOSE_OP);
    expect(closeOps.length).toBeGreaterThan(0);
    expect(closeOps.find((e) => e.phase === "terminal")?.outcome).toBe("succeeded");
    // Layered execution = layered journal records: close is one layer, each
    // stream teardown is another.
    const stopped = opsNamed(r.events, STOP_OP)
      .filter((e) => e.phase === "terminal")
      .map((e) => e.scope.streamId);
    expect(stopped).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("close is BUS-ONLY — its envelope never reaches the journal, its stops do", async () => {
    const r = await rig();
    r.harness.start("a");

    await r.harness.close();
    await settle();

    expect(await journaled(r.journal, CLOSE_OP)).toHaveLength(0);
    // The policy override is per-op-NAME, not a blanket suppression of
    // everything the close body does.
    expect((await journaled(r.journal, STOP_OP)).length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 4 — start is Family 3, deliberately not an op
// ============================================================================

describe("start is NOT an operation (ADR 92 Family 3, the sync-return seam)", () => {
  it("emits no live:command:start and cannot be vetoed", async () => {
    const r = await rig();
    r.harness.guard(() => ({ kind: "veto", reason: "would-block-start-if-it-were-an-op" }));

    const ref = r.harness.start("s-sync");
    await settle();

    expect(ref).toEqual({ sessionId: SESSION_ID, streamId: "s-sync" });
    expect(opsNamed(r.events, "live:command:start")).toHaveLength(0);
  });
});
