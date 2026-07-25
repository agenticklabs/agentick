/**
 * `session/timeline_history` — the cursored, bounded wire read over
 * `TimelineStore.history` (§6.3, friction #2). Proven at the gateway seam with
 * a REAL `TimelineHarness` (bundled `MemoryTimelineStore`) behind a stub
 * session, so the handler's fromSeq/limit threading, `nextFromSeq` cursor math,
 * and the seq-tag → wire-row mapping are exercised end to end.
 *
 * Covers: full read; `limit` bounds a page; forward pagination via
 * `nextFromSeq` reconstructs the whole ordered log; the tail page carries NO
 * `nextFromSeq`; and the cursor-alongside-seq shape (§6.4) — every row carries
 * `seq`, and `cursor` is absent for the memory store (the honest gap).
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { TimelineHarness } from "@agentick/timeline";
import type {
  AppHarnessProtocol,
  GatewayHarnessProtocol,
  SessionHarnessProtocol,
  SessionTimelineHistoryParams,
  SessionTimelineHistoryResult,
  TimelineEntry,
  WireExtensionContext,
} from "@agentick/spec";

import { sessionWireExtension } from "../session-extension.js";

const SESSION_ID = "sess-th";

function messageEntry(id: string): TimelineEntry {
  return {
    kind: "message",
    message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
  } as unknown as TimelineEntry;
}

async function makeTimeline(): Promise<TimelineHarness> {
  const harness = new TimelineHarness(
    SESSION_ID,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

function stubCtx(timeline: TimelineHarness): WireExtensionContext {
  const session = { id: SESSION_ID, timeline } as unknown as SessionHarnessProtocol;
  const app = {
    getSession: (id: string) => (id === SESSION_ID ? session : undefined),
  } as unknown as AppHarnessProtocol;
  const gateway = { apps: () => [app] } as unknown as GatewayHarnessProtocol;
  return { gateway } as unknown as WireExtensionContext;
}

const timelineHistory = sessionWireExtension.methods["session/timeline_history"]!;

async function call(
  ctx: WireExtensionContext,
  params: SessionTimelineHistoryParams,
): Promise<SessionTimelineHistoryResult> {
  return (await timelineHistory(params, ctx)) as SessionTimelineHistoryResult;
}

const idsOf = (res: SessionTimelineHistoryResult): string[] =>
  res.entries.map((e) => (e.entry as { message: { id: string } }).message.id);

describe("session/timeline_history (§6.3 — cursored wire read)", () => {
  it("full read returns every entry seq-tagged, in order, with no nextFromSeq", async () => {
    const timeline = await makeTimeline();
    for (const id of ["e1", "e2", "e3"]) await timeline.append(messageEntry(id));
    const ctx = stubCtx(timeline);

    const res = await call(ctx, { sessionId: SESSION_ID });
    expect(idsOf(res)).toEqual(["e1", "e2", "e3"]);
    // seq is strictly increasing (the LogStore ordering identity).
    const seqs = res.entries.map((e) => e.seq);
    expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!)).toBe(true);
    // No limit → the page reached the tail → no continuation cursor.
    expect(res.nextFromSeq).toBeUndefined();

    // §6.4 — cursor-alongside-seq shape: every row carries a numeric seq; the
    // bundled MemoryTimelineStore co-locates no bus cursor, so `cursor` is
    // absent (the honest gap, not a unification).
    for (const e of res.entries) {
      expect(typeof e.seq).toBe("number");
      expect(e.cursor).toBeUndefined();
    }
    await timeline.close();
  });

  it("bounds a page by `limit` and hands back a nextFromSeq cursor", async () => {
    const timeline = await makeTimeline();
    for (const id of ["a", "b", "c", "d", "e"]) await timeline.append(messageEntry(id));
    const ctx = stubCtx(timeline);

    const page = await call(ctx, { sessionId: SESSION_ID, limit: 2 });
    expect(idsOf(page)).toEqual(["a", "b"]);
    // A FULL page (length === limit) MAY have more → nextFromSeq = lastSeq + 1.
    expect(page.nextFromSeq).toBe(page.entries[1]!.seq + 1);
    await timeline.close();
  });

  it("pages forward via nextFromSeq and reconstructs the whole ordered log", async () => {
    const timeline = await makeTimeline();
    const allIds = ["a", "b", "c", "d", "e"];
    for (const id of allIds) await timeline.append(messageEntry(id));
    const ctx = stubCtx(timeline);

    const collected: string[] = [];
    let fromSeq: number | undefined;
    let guard = 0;
    for (;;) {
      const page: SessionTimelineHistoryResult = await call(ctx, {
        sessionId: SESSION_ID,
        limit: 2,
        ...(fromSeq !== undefined ? { fromSeq } : {}),
      });
      collected.push(...idsOf(page));
      if (page.nextFromSeq === undefined) break;
      fromSeq = page.nextFromSeq;
      if (++guard > 10) throw new Error("pagination did not terminate");
    }
    expect(collected).toEqual(allIds);
    await timeline.close();
  });

  it("the tail page (short of `limit`) carries NO nextFromSeq", async () => {
    const timeline = await makeTimeline();
    for (const id of ["a", "b", "c"]) await timeline.append(messageEntry(id));
    const ctx = stubCtx(timeline);

    // First page fills the limit → has a cursor.
    const first = await call(ctx, { sessionId: SESSION_ID, limit: 2 });
    expect(first.nextFromSeq).toBeDefined();
    // Second page returns the single tail entry (< limit) → no cursor.
    const tail = await call(ctx, { sessionId: SESSION_ID, limit: 2, fromSeq: first.nextFromSeq });
    expect(idsOf(tail)).toEqual(["c"]);
    expect(tail.nextFromSeq).toBeUndefined();
    await timeline.close();
  });
});
