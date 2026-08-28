/**
 * ADR 100 — session branching: the `from` bag + the `internal` disposition.
 *
 * The five-case matrix is pinned at the seam where this package's verbs hand
 * the bag to the app's create door, because that bag IS the record: nothing
 * between here and the store reinterprets it. The laws are pinned against real
 * harnesses over real stores — the branch fan-out is a store-layer copy, so a
 * double would pin nothing.
 *
 * The `SpawnContext` fixture below stands in for the app's create door: it
 * resolves the anchor's store `seq` and hands the COMPLETE `SessionFrom` to the
 * child's construction options, following the door's own two-layer rule for an
 * absent `entryId` (arriving: the source's tip; on the record: the source had
 * nothing to anchor on).
 *
 * @see docs/proposals/v2/blueprint/100-conversation-branches.md
 */

import { describe, expect, it } from "vitest";

import { CompilerHarness } from "@agentick/compiler-react";
import { ElicitationHarness } from "@agentick/elicitation";
import { createKnobStore, type KnobStore } from "@agentick/knobs";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { MemoryTimelineStore } from "@agentick/timeline";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { stubStoreCtx } from "@agentick/store";
import { omitUndefined } from "@agentick/utils";
import type {
  ExecutionTarget,
  SessionFrom,
  SessionHarnessProtocol,
  SpawnContext,
  SpawnContextChildInput,
  TimelineEntry,
} from "@agentick/spec";
import { BranchSourceEntryNotFoundError, relation } from "@agentick/spec";

import { SessionHarness } from "../harness.js";
import { InMemorySessionStore } from "../session-store.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

function entry(id: string): TimelineEntry {
  return {
    kind: "message",
    message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
  } as unknown as TimelineEntry;
}

const messageIds = (entries: readonly TimelineEntry[]): string[] =>
  entries.map((e) => (e as { message: { id: string } }).message.id);

/**
 * A store whose writes land a turn LATE. An in-memory store applies a write
 * before anyone can observe the gap, which makes a flush barrier invisible —
 * this is what a durable adapter behaves like, and what the barrier is for.
 */
function deferredWrites(inner: KnobStore): KnobStore {
  return {
    backend: "deferred",
    query: (q, ctx) => inner.query(q, ctx),
    mutate: (m, ctx) =>
      new Promise((resolve, reject) => {
        setTimeout(() => void inner.mutate(m, ctx).then(resolve, reject), 0);
      }),
  };
}

/** One app's worth of durable stores, shared by every session in a test. */
interface Stores {
  readonly timeline: MemoryTimelineStore;
  readonly knobs: KnobStore;
  readonly sessions: InMemorySessionStore;
}

function stores(): Stores {
  return {
    timeline: new MemoryTimelineStore(),
    knobs: createKnobStore(),
    sessions: new InMemorySessionStore(),
  };
}

interface Options {
  readonly from?: SessionFrom;
  readonly internal?: boolean;
  readonly parentSessionId?: string;
  readonly initialKnobs?: Readonly<Record<string, unknown>>;
  readonly spawnContext?: SpawnContext;
}

async function mkSession(id: string, db: Stores, opts: Options = {}): Promise<SessionHarness> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const suffix = `${id}-${Math.random()}`;
  const compiler = new CompilerHarness(`br-r-${suffix}`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`br-l-${suffix}`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`br-e-${suffix}`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`br-t-${suffix}`, journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor(
    `br-x-${suffix}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: id,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    sessionStore: db.sessions,
    timeline: { store: db.timeline, writePolicy: "behind" },
    knobs: { store: db.knobs },
    ...omitUndefined({
      from: opts.from,
      internal: opts.internal,
      parentSessionId: opts.parentSessionId,
      initialKnobs: opts.initialKnobs,
      spawnContext: opts.spawnContext,
    }),
  });
  await session.ready;
  await session.mountReady;
  return session;
}

/**
 * The app's create door, as far as this package can see it: it records what it
 * was handed, resolves the anchor's `seq` against the source, and builds the
 * child on the same stores.
 */
function appDoor(db: Stores, source: () => SessionHarness) {
  const seen: SpawnContextChildInput[] = [];
  const children: SessionHarness[] = [];
  const ctx: SpawnContext = {
    disposeChildSession: async () => undefined,
    abortSubtree: async () => 0,
    createChildSession: async (input) => {
      seen.push(input);
      const from = input.from;
      const child = await mkSession(input.sessionId ?? `child-${seen.length}`, db, {
        ...omitUndefined({
          internal: input.internal,
          parentSessionId: input.parentSessionId,
          from: from === undefined ? undefined : { ...from, seq: await resolveSeq(source(), from) },
        }),
      });
      children.push(child);
      return child as unknown as SessionHarnessProtocol;
    },
  };
  return { ctx, seen, children };
}

/**
 * Position the anchor, exactly as the app's create door does: an `entryId`
 * ARRIVING absent means the source's tip (the fork-button gesture), and only a
 * source with nothing anchorable resolves to `-1`, the empty prefix. Those are
 * two different questions and the door answers both here — the verbs in this
 * file only ever produce the second, but the fixture must not teach a rule the
 * real door does not have.
 */
async function resolveSeq(source: SessionHarness, from: { readonly entryId?: string }) {
  const anchors = (await source.timeline.history()).flatMap((row) => {
    const id = (row.entry as { message?: { id: string } }).message?.id;
    return id === undefined ? [] : [{ id, seq: row.seq }];
  });
  const anchor =
    from.entryId === undefined
      ? anchors[anchors.length - 1]
      : anchors.find((candidate) => candidate.id === from.entryId);
  return anchor?.seq ?? -1;
}

describe("ADR 100 — the five-case matrix", () => {
  it("every verb hands the door exactly the bag its row calls for", async () => {
    const db = stores();
    let source!: SessionHarness;
    const door = appDoor(db, () => source);
    source = await mkSession("s-matrix", db, { spawnContext: door.ctx });
    await source.timeline.append(entry("m1"), entry("m2"));

    await source.fork();
    await source.reply("m1");
    await source.spawn({});
    await source.spawn({ branch: "m1" });

    const [forked, replied, worker, forkedWorker] = door.seen;
    // row 2 — fork: a new direction from the tip, unanchored, visible.
    expect(forked?.from).toEqual({
      sessionId: "s-matrix",
      entryId: "m2",
      inherited: true,
      anchored: false,
    });
    expect(forked?.internal).toBeUndefined();
    // row 3 — reply: a side-thread that STAYS at its entry.
    expect(replied?.from).toEqual({
      sessionId: "s-matrix",
      entryId: "m1",
      inherited: true,
      anchored: true,
    });
    expect(replied?.internal).toBeUndefined();
    // row 4 — spawn: a worker, internal, carrying no transcript.
    expect(worker?.from).toEqual({
      sessionId: "s-matrix",
      entryId: "m2",
      inherited: false,
      anchored: false,
    });
    expect(worker?.internal).toBe(true);
    // row 5 — spawn with a branch: a worker CONTINUING the transcript.
    expect(forkedWorker?.from).toEqual({
      sessionId: "s-matrix",
      entryId: "m1",
      inherited: true,
      anchored: false,
    });
    expect(forkedWorker?.internal).toBe(true);

    await source.close();
  });

  it("relation() names each row from the bag alone", async () => {
    const db = stores();
    let source!: SessionHarness;
    const door = appDoor(db, () => source);
    source = await mkSession("s-relation", db, { spawnContext: door.ctx });
    await source.timeline.append(entry("m1"));

    await source.fork();
    await source.reply("m1");
    await source.spawn({});
    await source.spawn({ branch: "m1" });

    const named = door.seen.map((i) =>
      relation({ ...omitUndefined({ internal: i.internal }), from: { ...i.from!, seq: 0 } }),
    );
    expect(named).toEqual(["fork", "reply", "worker", "forked-worker"]);
    // row 1 — a root session has no bag at all.
    expect(relation({})).toBe("conversation");

    await source.close();
  });

  it("a spawn cannot be declared non-internal — there is no option to ask", async () => {
    const db = stores();
    let source!: SessionHarness;
    const door = appDoor(db, () => source);
    source = await mkSession("s-forced", db, { spawnContext: door.ctx });

    // @ts-expect-error — ADR 100 reconciliation 1: `SpawnInput` has no
    // `internal`. A visible agent-created session is a fork or a reply.
    await source.spawn({ internal: false });
    expect(door.seen[0]?.internal).toBe(true);

    await source.close();
  });

  it("branches off an INTERNAL session stay internal — plumbing does not sprout a conversation", async () => {
    const db = stores();
    let source!: SessionHarness;
    const door = appDoor(db, () => source);
    source = await mkSession("s-plumbing", db, { spawnContext: door.ctx, internal: true });
    await source.timeline.append(entry("m1"));

    await source.fork();
    expect(door.seen[0]?.internal).toBe(true);

    await source.close();
  });

  it("a branch is enlisted as a LIVE child of its source — today's lifecycle, not the ADR's", async () => {
    // TODO(adr100-branch-lifecycle): ADR 100 says a branch is subordinate to
    // nothing, so this edge (which also enlists the new conversation in its
    // source's teardown cascade) is wrong for a fork. Pinned because it is the
    // behavior that shipped before the rename, so the change is a decision
    // someone makes rather than a rename's side effect. Flip this pin with the
    // matching TODO in `createBranchSession`.
    const db = stores();
    let source!: SessionHarness;
    const door = appDoor(db, () => source);
    source = await mkSession("s-lifecycle", db, { spawnContext: door.ctx });
    await source.timeline.append(entry("m1"));

    await source.fork();
    expect(door.seen[0]?.parentSessionId).toBe("s-lifecycle");

    await source.close();
  });

  it("a branch off an empty timeline records lineage with no anchor", async () => {
    const db = stores();
    let source!: SessionHarness;
    const door = appDoor(db, () => source);
    source = await mkSession("s-empty", db, { spawnContext: door.ctx });

    await source.spawn({});
    expect(door.seen[0]?.from).toEqual({
      sessionId: "s-empty",
      inherited: false,
      anchored: false,
    });

    await source.close();
  });

  it("naming an entry the source does not have fails the branch", async () => {
    const db = stores();
    let source!: SessionHarness;
    const door = appDoor(db, () => source);
    source = await mkSession("s-missing", db, { spawnContext: door.ctx });
    await source.timeline.append(entry("m1"));

    await expect(source.reply("nope")).rejects.toBeInstanceOf(BranchSourceEntryNotFoundError);
    // …and nothing was created: an anchor that cannot be resolved is a failed
    // branch, never a silent fork from the tip.
    expect(door.seen).toHaveLength(0);

    await source.close();
  });
});

describe("ADR 100 law 1 — an inherited branch reads source[..seq] ++ its own", () => {
  it("inherits the timeline up to AND INCLUDING the anchor, and nothing after it", async () => {
    const db = stores();
    let source!: SessionHarness;
    const door = appDoor(db, () => source);
    source = await mkSession("s-law1", db, { spawnContext: door.ctx });
    await source.timeline.append(entry("m1"), entry("m2"), entry("m3"));

    await source.fork({ entryId: "m2", sessionId: "s-law1-fork" });
    const child = door.children[0]!;

    expect(messageIds(child.timeline.read().entries)).toEqual(["m1", "m2"]);
    // …and the two diverge from there.
    await child.timeline.append(entry("c1"));
    expect(messageIds(child.timeline.read().entries)).toEqual(["m1", "m2", "c1"]);
    expect(messageIds(source.timeline.read().entries)).toEqual(["m1", "m2", "m3"]);

    await source.close();
    await child.close();
  });

  it("inherits KNOB VALUES too — a forked conversation keeps its settings", async () => {
    const db = stores();
    let source!: SessionHarness;
    const door = appDoor(db, () => source);
    source = await mkSession("s-knobs", db, {
      spawnContext: door.ctx,
      initialKnobs: { tone: "brisk" },
    });
    await source.timeline.append(entry("m1"));

    await source.fork();
    const child = door.children[0]!;

    expect(child.knobs.get("tone")).toBe("brisk");
    await source.close();
    await child.close();
  });

  it("a NON-inherited spawn takes nothing — a worker starts clean", async () => {
    const db = stores();
    let source!: SessionHarness;
    const door = appDoor(db, () => source);
    source = await mkSession("s-clean", db, {
      spawnContext: door.ctx,
      initialKnobs: { tone: "brisk" },
    });
    await source.timeline.append(entry("m1"));

    await source.spawn({});
    const child = door.children[0]!;

    expect(child.timeline.read().entries).toEqual([]);
    expect(child.knobs.get("tone")).toBeUndefined();
    await source.close();
    await child.close();
  });

  it("SNAPSHOT FIRST: the branch sees a write still in the source's write-behind buffer", async () => {
    // The flush barrier (checkpointing §5) is the whole reason the verb takes a
    // snapshot before creating anything: the child copies from the STORE, so a
    // value that has not drained yet would vanish from the branch. Knobs are
    // what proves it — resolving the anchor already flushes the TIMELINE, so
    // only a scope nothing else touches can fail this.
    const db = { ...stores(), knobs: deferredWrites(createKnobStore()) };
    let source!: SessionHarness;
    const door = appDoor(db, () => source);
    source = await mkSession("s-barrier", db, { spawnContext: door.ctx });
    await source.timeline.append(entry("m1"));
    await source.knobs.set({ id: "tone", value: "urgent" });

    await source.fork();
    const child = door.children[0]!;

    expect(child.knobs.get("tone")).toBe("urgent");
    await source.close();
    await child.close();
  });
});

describe("ADR 100 law 3 — persistence", () => {
  it("an INTERNAL session has its row at genesis: lineage is not speculative", async () => {
    const db = stores();
    const worker = await mkSession("s-worker", db, { internal: true });

    const record = await db.sessions.get("s-worker", stubStoreCtx());
    expect(record?.internal).toBe(true);
    await worker.close();
  });

  it("a conversation earns its row later — an abandoned one leaves nothing", async () => {
    const db = stores();
    const conversation = await mkSession("s-lazy", db);

    expect(await db.sessions.get("s-lazy", stubStoreCtx())).toBeUndefined();
    await conversation.close();
    expect(await db.sessions.get("s-lazy", stubStoreCtx())).toBeUndefined();
  });

  it("the record carries the whole bag, and the list predicates read it", async () => {
    const db = stores();
    const worker = await mkSession("s-branch-worker", db, {
      internal: true,
      parentSessionId: "s-source",
      from: { sessionId: "s-source", entryId: "m1", seq: 0, inherited: true, anchored: false },
    });

    const record = await db.sessions.get("s-branch-worker", stubStoreCtx());
    expect(record?.from).toEqual({
      sessionId: "s-source",
      entryId: "m1",
      seq: 0,
      inherited: true,
      anchored: false,
    });
    expect(relation(record!)).toBe("forked-worker");
    expect(
      (await db.sessions.list({ fromSessionId: "s-source" }, stubStoreCtx())).map((r) => r.id),
    ).toEqual(["s-branch-worker"]);
    // …and it is exactly what the conversation list excludes.
    expect(await db.sessions.list({ internal: false, anchored: false }, stubStoreCtx())).toEqual(
      [],
    );

    await worker.close();
  });
});
