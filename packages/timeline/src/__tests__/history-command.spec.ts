/**
 * `timeline:history` — the standard READ as a declared, wire-exposable command
 * (ADR 93 §"The client read doors").
 *
 * The claim under test: a client's scroll-back does not get a bespoke gateway
 * method. It gets a COMMAND — one declaration that is simultaneously the inbox
 * message type, the op name, the authz scope label, and the `timeline/history`
 * wire method. Which buys three properties this file pins:
 *
 *   1. the DECLARATION — `exposure: "wire"`, enumerated by `commands()` (what the
 *      dynamic lane's deny-by-default check reads), and a payload validated once
 *      and NORMALIZED so a caller-supplied `sessionId` can't steer the read;
 *   2. the PAGE — cursor semantics (`nextFromSeq` present iff the page filled its
 *      limit, absent at the tail), the write-behind flush before reading, and the
 *      loud failure when the store implements no cursored read;
 *   3. the JOURNAL CLASS — a read is bus-only. Observable live, never durable,
 *      while writes on the same surface keep journaling.
 *
 * The inbox asks here are the same path the wire takes: the dynamic lane's
 * dispatch is exactly `inbox.ask(address, { type: verb, origin: "wire", payload })`.
 *
 * @see packages/gateway/src/__tests__/timeline-history-grant.spec.ts — the grant tier
 * @see packages/transport-in-process/src/__tests__/timeline-history-e2e.spec.ts — the wire
 */

import { afterEach, describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ProtocolEvent, TimelineEntry, TimelineStore } from "@agentick/spec";

import { MemoryTimelineStore } from "../store.js";
import { TimelineHarness, type TimelineHarnessOptions } from "../harness.js";
import type { TimelineHistoryInput, TimelineHistoryPage } from "../wire-augment.js";

const HISTORY_OP = "timeline:command:history";
const APPEND_OP = "timeline:command:append";
const SESSION_ID = "sess-history-1";
/** The harness's WORK identity — inbox address root + store key. */
const SCOPE_ID = `${SESSION_ID}:timeline`;

const entry = (id: string): TimelineEntry => ({
  kind: "message",
  message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
});

const ids = (page: TimelineHistoryPage): string[] =>
  page.entries.map((t) => (t.entry.kind === "message" ? t.entry.message.id : "boundary"));

/** A store missing the OPTIONAL cursored read — the loud-failure case. */
function storeWithoutHistory(): TimelineStore {
  const inner = new MemoryTimelineStore();
  return {
    backend: "no-history",
    append: (k, e, ctx) => inner.append(k, e, ctx),
    read: (k, ctx) => inner.read(k, ctx),
    keys: (ctx) => inner.keys(ctx),
    delete: (k, ctx) => inner.delete(k, ctx),
    query: (q, ctx) => inner.query(q, ctx),
    mutate: (m, ctx) => inner.mutate(m, ctx),
  };
}

interface Rig {
  readonly harness: TimelineHarness;
  readonly journal: MemoryJournal;
  /** Every envelope that reached the BUS. */
  readonly events: ProtocolEvent[];
  /** Drive the declared verb the way the wire lane does. */
  ask(payload: Record<string, unknown>): Promise<TimelineHistoryPage>;
  /** The same ask, surfacing the failure value instead of throwing. */
  askEither(payload: Record<string, unknown>): Promise<unknown>;
  readonly teardown: () => Promise<void>;
}

let active: Rig | undefined;

async function rig(options: TimelineHarnessOptions = {}): Promise<Rig> {
  const bus = new LocalEventBus();
  const journal = new MemoryJournal({ capacity: 10_000 });
  const inbox = new LocalInbox();
  const harness = new TimelineHarness(SCOPE_ID, journal, bus, inbox, {
    store: new MemoryTimelineStore(),
    // What `session-bridges` always passes. The two ids are deliberately different
    // here so a test cannot pass by conflating them.
    parentScope: { sessionId: SESSION_ID },
    ...options,
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

  const asked = (payload: Record<string, unknown>) =>
    inbox.ask<unknown, TimelineHistoryPage>(harness.address, {
      type: "timeline:history",
      origin: "wire",
      payload,
    });

  const r: Rig = {
    harness,
    journal,
    events,
    ask: (payload) => Effect.runPromise(asked(payload)),
    askEither: async (payload) => {
      const outcome = await Effect.runPromise(Effect.either(asked(payload)));
      return outcome._tag === "Left" ? outcome.left : undefined;
    },
    teardown: async () => {
      await harness.close().catch(() => undefined);
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
  active = r;
  return r;
}

afterEach(async () => {
  await active?.teardown();
  active = undefined;
});

/** Everything the JOURNAL retained under `name` (the durable spine). */
async function journaled(journal: MemoryJournal, name: string): Promise<readonly ProtocolEvent[]> {
  const out = await Effect.runPromise(
    Stream.runCollect(journal.readByQuery({ name: { exact: name } }, "beginning")),
  );
  return Array.from(out);
}

/** Settle the bus fan-out queue. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// ============================================================================
// 1 — the declaration
// ============================================================================

describe("timeline:history — the declaration", () => {
  it("is declared wire-exposed and enumerated (what deny-by-default reads)", async () => {
    const r = await rig();
    const row = r.harness.commands().find((c) => c.name === "timeline:history");
    expect(row).toMatchObject({ name: "timeline:history", exposure: "wire", hasInput: true });
    // The write verbs stay OFF the wire — exposure is per-verb curation, and the
    // dynamic lane reads exactly this to decide whether a verb exists at all.
    expect(r.harness.commands().find((c) => c.name === "timeline:append")?.exposure).toBe(
      "addressable",
    );
  });

  it("answers the page over its inbox message type (the wire lane's own path)", async () => {
    const r = await rig();
    await r.harness.append(entry("a"), entry("b"));

    const page = await r.ask({ fromSeq: 0, limit: 1 });
    expect(ids(page)).toEqual(["a"]);
    expect(page.nextFromSeq).toBe(1);
  });

  it("NORMALIZES the payload: the lane's sessionId (and any extra) never reaches the body", async () => {
    const r = await rig();
    await r.harness.append(entry("a"), entry("b"), entry("c"));

    // The dynamic wire lane forwards the whole params bag, addressing key
    // included. The harness reads its OWN scopeId; a caller-supplied session id
    // must not be able to steer the read.
    const page = await r.ask({ sessionId: "someone-elses-session", fromSeq: 2 });
    expect(ids(page)).toEqual(["c"]);
  });

  it("rejects a malformed cursor at the ONE validation site", async () => {
    const r = await rig();
    const failure = (await r.askEither({ fromSeq: -1 })) as { reason?: string } | undefined;
    expect(failure?.reason).toMatch(/fromSeq must be a non-negative integer/);
    const badLimit = (await r.askEither({ limit: 1.5 })) as { reason?: string } | undefined;
    expect(badLimit?.reason).toMatch(/limit must be a non-negative integer/);
    const badTo = (await r.askEither({ toSeq: -2 })) as { reason?: string } | undefined;
    expect(badTo?.reason).toMatch(/toSeq must be a non-negative integer/);
  });
});

// ============================================================================
// 2 — the page
// ============================================================================

describe("timeline:history — the page", () => {
  it("pages forward by seq and hands back the cursor only while capped", async () => {
    const r = await rig();
    await r.harness.append(entry("a"), entry("b"), entry("c"));

    // Forward paging declares its lower bound — that is what anchors `limit` at
    // the head (a bare `{ limit }` is the TAIL read; see below).
    const first = await r.ask({ fromSeq: 0, limit: 2 });
    expect(ids(first)).toEqual(["a", "b"]);
    // A FULL page may have more behind it — `lastSeq + 1`, valid in a sparse space.
    expect(first.nextFromSeq).toBe(2);

    const second = await r.ask({ fromSeq: first.nextFromSeq!, limit: 2 });
    expect(ids(second)).toEqual(["c"]);
    // Short page ⇒ the tail: no cursor, nothing left to ask for.
    expect(second.nextFromSeq).toBeUndefined();
  });

  it("a bare `{ limit }` is the TAIL read, and pages BACKWARD by nextToSeq", async () => {
    const r = await rig();
    await r.harness.append(entry("a"), entry("b"), entry("c"), entry("d"));

    // What every chat UI opens on: the newest n, ascending, in ONE round-trip.
    const newest = await r.ask({ limit: 2 });
    expect(ids(newest)).toEqual(["c", "d"]);
    // A full page may have more BELOW it — `firstSeq - 1`, the backward twin of
    // `nextFromSeq`, and the only cursor a tail-anchored read hands back.
    expect(newest.nextToSeq).toBe(1);
    expect(newest.nextFromSeq).toBeUndefined();

    const older = await r.ask({ toSeq: newest.nextToSeq!, limit: 2 });
    expect(ids(older)).toEqual(["a", "b"]);
    // Reached the log's head: seq 0 has nothing below it.
    expect(older.nextToSeq).toBeUndefined();
  });

  it("the upper bound is inclusive and composes with the lower one", async () => {
    const r = await rig();
    await r.harness.append(entry("a"), entry("b"), entry("c"), entry("d"));
    expect(ids(await r.ask({ toSeq: 1 }))).toEqual(["a", "b"]);
    expect(ids(await r.ask({ fromSeq: 1, toSeq: 2 }))).toEqual(["b", "c"]);
  });

  it("an uncapped read returns the whole log with no cursor", async () => {
    const r = await rig();
    await r.harness.append(entry("a"), entry("b"));
    const page = await r.ask({});
    expect(ids(page)).toEqual(["a", "b"]);
    expect(page.nextFromSeq).toBeUndefined();
  });

  it("flushes the write-behind buffer first — a just-appended entry is readable", async () => {
    const r = await rig();
    // No explicit flush: the append is still buffered in the pump.
    await r.harness.append(entry("just-now"));
    expect(ids(await r.ask({}))).toEqual(["just-now"]);
  });

  it("the in-process `history()` face runs the same body, minus the cursor", async () => {
    const r = await rig();
    await r.harness.append(entry("a"), entry("b"));
    const options: TimelineHistoryInput = { fromSeq: 1 };
    const rows = await r.harness.history(options);
    expect(rows.map((t) => t.seq)).toEqual([1]);
    await settle();
    // Same op, so the read's interceptors fire on both faces.
    expect(r.events.some((e) => e.name === HISTORY_OP)).toBe(true);
  });

  it("fails LOUDLY when the store implements no cursored read", async () => {
    const r = await rig({ store: storeWithoutHistory() });
    await r.harness.append(entry("a"));
    await expect(r.harness.history()).rejects.toThrow(/does not implement the optional/);
    // …and as an operation FAILURE, not a fiber death: the terminal records it.
    await settle();
    const terminal = r.events.find((e) => e.name === HISTORY_OP && e.phase === "terminal");
    expect(terminal?.outcome).toBe("failed");
  });
});

// ============================================================================
// 3 — the read is in the op grammar: hooks + guards
// ============================================================================

describe("timeline:history — hooks and guards, like any other verb", () => {
  it("mints the read's boundary hooks under drop-layer names", async () => {
    const seen: string[] = [];
    const r = await rig({
      hooks: {
        onBeforeHistory: (input) => {
          seen.push(`before:${input.limit ?? "all"}`);
        },
        onAfterHistory: (page) => {
          seen.push(`after:${page.entries.length}`);
        },
      },
    });
    await r.harness.append(entry("a"), entry("b"));
    await r.ask({ limit: 1 });
    expect(seen).toEqual(["before:1", "after:1"]);
  });

  it("a guard can VETO the read — the row-level / retention seam", async () => {
    const scopes: Array<string | undefined> = [];
    const r = await rig({
      guards: {
        // The shape an adopter needing something NARROWER than the ADR-48
        // same-principal rule writes: a verdict at the read itself.
        history: (input, ctx) => {
          scopes.push(ctx.sessionId);
          return (input.limit ?? Infinity) > 100
            ? { kind: "veto", reason: "page too large" }
            : undefined;
        },
      },
    });
    await r.harness.append(entry("a"));

    expect((await r.ask({ limit: 10 })).entries).toHaveLength(1);
    await expect(r.harness.history({ limit: 500 })).rejects.toMatchObject({
      outcome: "vetoed",
      terminal: { outcome: "vetoed", reason: "page too large" },
    });
    // The guard ctx carries the SESSION — the runtime coordinate, from the
    // harness's construction-bound `parentScope`. It used to carry the composed
    // scope key (`<sessionId>:timeline`) because every command hand-stamped
    // `sessionId: this.scopeId`, which is also why no session-scoped subscription
    // could ever match a timeline event. WHICH timeline is being guarded needs no
    // ctx field: a guard is registered on one harness and is static to it.
    //
    // It does NOT carry the calling principal: bridge harnesses are not
    // principal-stamped today, and cross-principal denial is the wire choke point's
    // job regardless.
    expect(scopes).toEqual([SESSION_ID, SESSION_ID]);
  });
});

// ============================================================================
// 4 — the journal class
// ============================================================================

describe("timeline:history — reads are bus-only", () => {
  it("reaches the bus but NEVER the journal, while writes stay journaled", async () => {
    const r = await rig();
    await r.harness.append(entry("a"));
    await r.ask({ limit: 1 });
    await settle();

    // Live observability: the op is on the bus, both phases.
    const onBus = r.events.filter((e) => e.name === HISTORY_OP).map((e) => e.phase);
    expect(onBus).toContain("requested");
    expect(onBus).toContain("terminal");

    // The recovery/audit spine holds nothing for it — a read changes nothing, so
    // there is nothing to replay.
    expect(await journaled(r.journal, HISTORY_OP)).toEqual([]);
    // Control: the write on the same surface IS journaled (the class is per-verb,
    // not a surface-wide opt-out).
    expect((await journaled(r.journal, APPEND_OP)).length).toBeGreaterThan(0);
  });

  it("an adopter policy layers OVER the read class rather than replacing it", async () => {
    const r = await rig({
      policy: {
        alwaysJournal: ["requested", "terminal"],
        busOnly: ["before", "delta"],
        overflow: "sliding",
        queueCapacity: 128,
        override: { [HISTORY_OP]: "always" },
      },
    });
    await r.harness.append(entry("a"));
    await r.ask({ limit: 1 });
    await settle();
    expect((await journaled(r.journal, HISTORY_OP)).length).toBeGreaterThan(0);
  });
});
