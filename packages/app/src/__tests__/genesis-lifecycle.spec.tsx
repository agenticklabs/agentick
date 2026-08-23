/**
 * ADR 93 — the GENESIS lifecycle laws that only the app tier can hold, because
 * only it owns the session-creation boundary and a session's lineage.
 *
 *   1. **The top-level slot (§Top-level slots for every namespace).**
 *      `createApp({ timeline })` reaches the session's ONE timeline harness —
 *      with no `timeline?:` line anywhere in `@agentick/app` (the slot arrives by
 *      `NamespaceSlots` augmentation + `registerNamespaceSlot`, ADR 27).
 *   2. **Ordering (landmine 2).** Genesis runs before first render, so the first
 *      compile sees the resumed conversation.
 *   3. **Typed failure (landmine 2).** A throwing hydrator fails session
 *      CREATION with its typed error — no half-genesis session that only
 *      explodes at the first `send`.
 *   4. **Spawn-inherit skips genesis (landmine 1, as amended).** `hydrate` runs
 *      on CREATE and RESUME, never on SPAWN-inherit — a spawned child owns no
 *      durable scope to read. A FORK is the exception that proves it: the fork
 *      path branches the parent's scope onto the child's, so the child DOES
 *      genesis, over its own copy (checkpointing §5 — the ADR 93 fork law
 *      retired with the snapshot-blob transport that motivated it).
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { scriptedAdapter } from "@agentick/model/testing";
import {
  defineTimeline,
  hydrateTail,
  MemoryTimelineStore,
  type TimelineStore,
} from "@agentick/timeline";
import { TimelineHydrateFailed } from "@agentick/spec";
import type { TimelineEntry } from "@agentick/spec";

import { createApp } from "../react.js";

function MinimalAgent() {
  return React.createElement("message" as never, { role: "user" }, "ping");
}

function userEntry(id: string): TimelineEntry {
  return {
    kind: "message",
    message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
  } as unknown as TimelineEntry;
}

const idOf = (e: TimelineEntry): string => (e as { message: { id: string } }).message.id;

const mkApp = (timeline?: Parameters<typeof defineTimeline>[0]) =>
  createApp(React.createElement(MinimalAgent), {
    model: scriptedAdapter("ok"),
    ...(timeline !== undefined ? { timeline } : {}),
  });

describe("ADR 93 — the top-level `timeline` slot", () => {
  it("createApp({ timeline: defineTimeline({ store }) }) reaches the session's timeline", async () => {
    const store = new MemoryTimelineStore();
    await store.append("slot-A:timeline", [userEntry("p1"), userEntry("p2")], {} as never);
    const app = await mkApp(defineTimeline({ store }));
    // `createSession` awaits genesis, so the durable log is live on return.
    const session = await app.createSession({ sessionId: "slot-A" });
    expect(session.timeline.read().entries.map(idOf)).toEqual(["p1", "p2"]);
    await app.closeApp();
  });

  it("the slot takes an INLINE bag too — the definition IS the options", async () => {
    const store = new MemoryTimelineStore();
    await store.append("slot-B:timeline", [userEntry("p1")], {} as never);
    const app = await mkApp({ store });
    const session = await app.createSession({ sessionId: "slot-B" });
    expect(session.timeline.read().entries.map(idOf)).toEqual(["p1"]);
    await app.closeApp();
  });

  it("carries the genesis seam: hydrateTail bounds what the session opens on", async () => {
    const store = new MemoryTimelineStore();
    const many = Array.from({ length: 40 }, (_, i) => userEntry(`e${i}`));
    await store.append("slot-C:timeline", many, {} as never);
    const app = await mkApp(defineTimeline({ store, hydrate: hydrateTail(3) }));
    const session = await app.createSession({ sessionId: "slot-C" });
    expect(session.timeline.read().entries.map(idOf)).toEqual(["e37", "e38", "e39"]);
    await app.closeApp();
  });

  it("carries the shaping seam: the compact sugar drives the no-arg signal form", async () => {
    const app = await mkApp(defineTimeline({ compact: (entries) => entries.slice(0, 1) }));
    const session = await app.createSession({ sessionId: "slot-E" });
    await session.timeline.append(userEntry("a"), userEntry("b"));
    const result = await session.timeline.compact();
    expect(result).toMatchObject({ entriesAfter: 1 });
    await app.closeApp();
  });

  it("no slot ⇒ an empty in-memory timeline (the zero-config default is unchanged)", async () => {
    const app = await mkApp();
    const session = await app.createSession({ sessionId: "slot-D" });
    expect(session.timeline.read().entries).toEqual([]);
    await app.closeApp();
  });
});

describe("ADR 93 landmine 2 — genesis ordering + typed failure", () => {
  it("genesis completes BEFORE first render (the first compile sees the log)", async () => {
    const store = new MemoryTimelineStore();
    await store.append("order-A:timeline", [userEntry("resumed")], {} as never);
    const order: string[] = [];
    const app = await mkApp(
      defineTimeline({
        store,
        hydrate: async (ctx) => {
          order.push("genesis");
          return ctx.store.read(ctx.sessionId ?? "", ctx);
        },
      }),
    );
    const session = await app.createSession({ sessionId: "order-A" });
    await (session as unknown as { mountReady?: Promise<void> }).mountReady;
    order.push("mounted");
    expect(order).toEqual(["genesis", "mounted"]);
    expect(session.timeline.read().entries.map(idOf)).toEqual(["resumed"]);
    await app.closeApp();
  });

  it("a throwing hydrator FAILS createSession with the typed error", async () => {
    const app = await mkApp(
      defineTimeline({
        store: new MemoryTimelineStore(),
        hydrate: () => Promise.reject(new Error("catalog unreachable")),
      }),
    );
    await expect(app.createSession({ sessionId: "fail-A" })).rejects.toBeInstanceOf(
      TimelineHydrateFailed,
    );
    await app.closeApp();
  });
});

describe("ADR 93 landmine 1 — the fork/spawn law, as amended", () => {
  /** A definition whose hydrator counts its own invocations. */
  function countingDefinition(store: TimelineStore): {
    definition: ReturnType<typeof defineTimeline>;
    calls: () => number;
  } {
    let calls = 0;
    return {
      definition: defineTimeline({
        store,
        hydrate: async (ctx) => {
          calls += 1;
          return ctx.store.read(ctx.sessionId ?? "", ctx);
        },
      }),
      calls: () => calls,
    };
  }

  it("a FORK branches the parent's scope, then genesises over the COPY", async () => {
    const store = new MemoryTimelineStore();
    await store.append("fork-parent:timeline", [userEntry("p1")], {} as never);
    const { definition, calls } = countingDefinition(store);
    const app = await mkApp(definition);
    const parent = await app.createSession({ sessionId: "fork-parent" });
    expect(calls()).toBe(1); // the parent's own CREATE
    expect(parent.timeline.read().entries.map(idOf)).toEqual(["p1"]);

    const child = await parent.fork({ sessionId: "fork-child" });
    // THE LAW (checkpointing §5): the child's log is a store-layer COPY of the
    // parent's scope, and the hydrator runs over that copy — a second genesis,
    // against the child's own partition. Under the retired law the child
    // inherited an image through the snapshot blob and had to skip genesis.
    expect(calls()).toBe(2);
    expect(child.timeline.read().entries.map(idOf)).toEqual(["p1"]);
    // The copy is the CHILD's, in the child's own partition — not a shared read.
    expect((await store.read("fork-child:timeline", {} as never)).map(idOf)).toEqual(["p1"]);

    // Equal at the fork point, divergent after: an append on one is invisible
    // to the other, in memory and in the store.
    await child.timeline.append(userEntry("c1"));
    await parent.timeline.append(userEntry("q1"));
    expect(child.timeline.read().entries.map(idOf)).toEqual(["p1", "c1"]);
    expect(parent.timeline.read().entries.map(idOf)).toEqual(["p1", "q1"]);
    await app.closeApp();
  });

  it("a SPAWNed child does not run genesis", async () => {
    const store = new MemoryTimelineStore();
    await store.append("spawn-parent:timeline", [userEntry("p1")], {} as never);
    const { definition, calls } = countingDefinition(store);
    const app = await mkApp(definition);
    const parent = await app.createSession({ sessionId: "spawn-parent" });
    expect(calls()).toBe(1);
    // `spawn` returns the child unless `send` was supplied — narrow for the read.
    const child = (await parent.spawn({ sessionId: "spawn-child" })) as Awaited<
      ReturnType<typeof parent.fork>
    >;
    expect(calls()).toBe(1);
    // A spawned child is a NEW session: it inherits no conversation, and it
    // certainly does not re-read the parent's log.
    expect(child.timeline.read().entries).toEqual([]);
    await app.closeApp();
  });

  it("a RESUME (re-open of the same id in a fresh app) DOES run genesis", async () => {
    // The complement of the fork law — genesis is exactly "create or resume".
    const store = new MemoryTimelineStore();
    await store.append("resume-A:timeline", [userEntry("p1")], {} as never);
    const first = countingDefinition(store);
    const appA = await mkApp(first.definition);
    await appA.createSession({ sessionId: "resume-A" });
    expect(first.calls()).toBe(1);
    await appA.closeApp();

    const second = countingDefinition(store);
    const appB = await mkApp(second.definition);
    const resumed = await appB.createSession({ sessionId: "resume-A" });
    expect(second.calls()).toBe(1);
    expect(resumed.timeline.read().entries.map(idOf)).toEqual(["p1"]);
    await appB.closeApp();
  });
});
