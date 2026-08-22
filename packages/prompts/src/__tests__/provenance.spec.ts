/**
 * Materialization provenance — `invoke` stamps WHO put this in the timeline.
 *
 * The problem being pinned: a chat UI showing a full rendered prompt as if the
 * user typed it. Every entry `invoke` queues carries `metadata.source.prompt` —
 * the declaration name, the args, the invoking op, and the adopter's declared
 * `version` when there is one. Nothing derived, nothing hashed.
 *
 * Pins:
 *  - stamp present on invoke-queued entries: name / args / opId
 *  - the stamped `opId` IS the invoking operation's (read off the render ctx)
 *  - `version` present iff declared
 *  - `render()` queues nothing and stamps nothing
 *  - pre-existing message metadata is MERGED, not clobbered
 *  - a message that already carries its own `source` is NOT overwritten
 *  - a declared `version` survives register → list → snapshot → import
 *
 * @see docs/proposals/v2/materialization-provenance.md §3, §8-A
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { MessageEntry, MessageSource, TimelineEntry } from "@agentick/spec";

import { PromptsHarness, type TimelineAppendCapability } from "../harness.js";
import type { PromptMessageSource } from "../message-source.js";

/**
 * A capture double for the ONE capability `invoke` needs from the timeline. Typed
 * against {@link TimelineAppendCapability} rather than cast, so narrowing the seam
 * (or widening what `invoke` uses) breaks this at compile time.
 */
function captureTimeline(): {
  readonly appended: TimelineEntry[];
  readonly timeline: TimelineAppendCapability;
} {
  const appended: TimelineEntry[] = [];
  return {
    appended,
    timeline: {
      append: async (...entries: TimelineEntry[]): Promise<void> => {
        appended.push(...entries);
      },
    },
  };
}

async function makeHarness(timeline?: TimelineAppendCapability): Promise<PromptsHarness> {
  const id = `prov:${generateId()}`;
  const h = new PromptsHarness(
    id,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { parentScope: { sessionId: id }, ...(timeline ? { timeline } : {}) },
  );
  await h.ready;
  return h;
}

/** The documented reader path: cast `metadata.source` to `MessageSource`, then key. */
function promptSourceOf(entry: TimelineEntry): PromptMessageSource | undefined {
  if (entry.kind !== "message") return undefined;
  return (entry.message.metadata?.source as MessageSource | undefined)?.prompt;
}

describe("prompts — materialization provenance", () => {
  it("stamps name / args / opId on every entry invoke queues", async () => {
    const { appended, timeline } = captureTimeline();
    const h = await makeHarness(timeline);
    // The declaration's own ctx is the ground truth for "the invoking op" — the
    // render runs inside the very operation whose id the stamp claims.
    let renderOpId: string | undefined;
    await h.register({
      declaration: {
        name: "quoting_report",
        description: "Quoting report",
        render: (_args, ctx): readonly MessageEntry[] => {
          renderOpId = ctx?.opId;
          return [
            { kind: "message", role: "user", content: [{ type: "text", text: "line one" }] },
            { kind: "message", role: "user", content: [{ type: "text", text: "line two" }] },
          ];
        },
      },
    });

    await h.invoke({ name: "quoting_report", args: { period: "2026-01" } });

    expect(appended).toHaveLength(2);
    for (const entry of appended) {
      const source = promptSourceOf(entry);
      expect(source).toBeDefined();
      expect(source?.name).toBe("quoting_report");
      expect(source?.args).toEqual({ period: "2026-01" });
      expect(source?.opId).toBe(renderOpId);
    }
    expect(typeof renderOpId).toBe("string");

    await h.close();
  });

  it("omits args when the invoke passed none", async () => {
    const { appended, timeline } = captureTimeline();
    const h = await makeHarness(timeline);
    await h.register({ declaration: { name: "p", description: "p", template: "body" } });

    await h.invoke({ name: "p" });

    expect(promptSourceOf(appended[0]!)).toEqual({
      name: "p",
      opId: expect.any(String) as unknown as string,
    });

    await h.close();
  });

  it("carries a declared version, and omits it when none is declared", async () => {
    const { appended, timeline } = captureTimeline();
    const h = await makeHarness(timeline);
    await h.register({
      declaration: { name: "versioned", description: "v", template: "body", version: "2026-01-14" },
    });
    await h.register({ declaration: { name: "bare", description: "b", template: "body" } });

    await h.invoke({ name: "versioned" });
    await h.invoke({ name: "bare" });

    expect(promptSourceOf(appended[0]!)?.version).toBe("2026-01-14");
    expect(promptSourceOf(appended[1]!)).not.toHaveProperty("version");

    await h.close();
  });

  it("render() queues nothing and stamps nothing — nothing entered the timeline", async () => {
    const { appended, timeline } = captureTimeline();
    const h = await makeHarness(timeline);
    await h.register({
      declaration: { name: "p", description: "p", template: "body", version: "1" },
    });

    const result = await h.render({ name: "p", args: { a: 1 } });

    expect(appended).toHaveLength(0);
    expect(result.messages[0]?.metadata?.source).toBeUndefined();

    await h.close();
  });

  it("MERGES into existing message metadata rather than replacing it", async () => {
    const { appended, timeline } = captureTimeline();
    const h = await makeHarness(timeline);
    await h.register({
      declaration: {
        name: "cached",
        description: "c",
        render: (): readonly MessageEntry[] => [
          {
            kind: "message",
            role: "user",
            content: [{ type: "text", text: "body" }],
            metadata: { cache: { ttl: "1h" }, adopterKey: 7 },
          },
        ],
      },
    });

    await h.invoke({ name: "cached" });

    const metadata = appended[0]!.kind === "message" ? appended[0]!.message.metadata : undefined;
    expect(metadata?.cache).toEqual({ ttl: "1h" });
    expect(metadata?.adopterKey).toBe(7);
    expect(promptSourceOf(appended[0]!)?.name).toBe("cached");

    await h.close();
  });

  it("does NOT overwrite a source the render fn stamped itself", async () => {
    const { appended, timeline } = captureTimeline();
    const h = await makeHarness(timeline);
    await h.register({
      declaration: {
        name: "quoting",
        description: "q",
        // A render fn replaying an inbound platform message knows what that
        // message IS — the closer authority wins over the invoke's coarser claim.
        render: (): readonly MessageEntry[] => [
          {
            kind: "message",
            role: "user",
            content: [{ type: "text", text: "quoted" }],
            metadata: { source: { telegram: { chatId: 42 } } },
          },
        ],
      },
    });

    await h.invoke({ name: "quoting" });

    expect(promptSourceOf(appended[0]!)).toBeUndefined();
    const source =
      appended[0]!.kind === "message"
        ? (appended[0]!.message.metadata?.source as Record<string, unknown>)
        : undefined;
    expect(source?.telegram).toEqual({ chatId: 42 });

    await h.close();
  });
});

describe("prompts — declared version rides the record", () => {
  it("survives register → get → list → the record slice", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: { name: "p", description: "d", template: "body", version: "1.4.0" },
    });

    expect(h.get("p")?.version).toBe("1.4.0");
    expect(h.list()[0]?.version).toBe("1.4.0");
    // The record is what the store and the wire carry — the version must be on it.
    expect(h.record("p")?.version).toBe("1.4.0");

    await h.close();
  });

  it("update patches the version and leaves it alone when the patch is silent", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: { name: "p", description: "d", template: "body", version: "1" },
    });

    expect((await h.update({ name: "p", declaration: { version: "2" } })).version).toBe("2");
    expect((await h.update({ name: "p", declaration: { description: "d2" } })).version).toBe("2");

    await h.close();
  });
});
