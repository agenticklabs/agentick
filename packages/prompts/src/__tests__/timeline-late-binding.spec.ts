/**
 * `invoke()` resolves its timeline at APPEND time, not at construction (#257).
 *
 * The harness is constructed by `withPrompts` during session-extension install —
 * which runs BEFORE the session and therefore before the session's timeline
 * exists. An eagerly-resolved timeline is therefore `undefined` forever, which is
 * exactly what shipped: every default deployment rendered its invoked prompts
 * into nothing. The provider arm of `TimelineAppendSource` is the fix, and these
 * are its rules.
 *
 * Pins:
 *  - a direct capability still works unchanged (the tests / BYO path)
 *  - a provider is read per invoke — a timeline that appears LATER starts working
 *  - a hit is cached; the provider is not re-read afterwards
 *  - the "no timeline wired" skip is no longer silent, and warns ONCE
 *
 * @see packages/app/src/__tests__/prompts-invoke-timeline.spec.tsx — the same
 *   fact through real `createApp` wiring
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import { logEventName } from "@agentick/spec";
import type { LogEventPayload, ProtocolEvent, TimelineEntry } from "@agentick/spec";

import {
  PromptsHarness,
  type TimelineAppendCapability,
  type TimelineAppendSource,
} from "../harness.js";

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

async function makeHarness(
  timeline?: TimelineAppendSource,
  bus: LocalEventBus = new LocalEventBus(),
): Promise<PromptsHarness> {
  const id = `late:${generateId()}`;
  const h = new PromptsHarness(id, new MemoryJournal({ capacity: 1024 }), bus, new LocalInbox(), {
    parentScope: { sessionId: id },
    ...(timeline ? { timeline } : {}),
  });
  await h.ready;
  await h.register({ declaration: { name: "p", description: "p", template: "body" } });
  return h;
}

describe("prompts — the timeline is resolved at append time", () => {
  it("a directly-injected capability appends, exactly as before", async () => {
    const { appended, timeline } = captureTimeline();
    const h = await makeHarness(timeline);

    await h.invoke({ name: "p" });

    expect(appended).toHaveLength(1);
    await h.close();
  });

  it("a provider that misses is RE-READ — a timeline wired later starts working", async () => {
    const { appended, timeline } = captureTimeline();
    let live: TimelineAppendCapability | undefined;
    let reads = 0;
    const h = await makeHarness(() => {
      reads += 1;
      return live;
    });

    // The session's timeline does not exist yet — render, skip, no cached miss.
    await h.invoke({ name: "p" });
    expect(appended).toHaveLength(0);
    expect(reads).toBe(1);

    // …the host publishes it, and the very next invoke lands.
    live = timeline;
    await h.invoke({ name: "p" });
    expect(appended).toHaveLength(1);
    expect(reads).toBe(2);

    // A hit is final: the provider is not consulted again.
    await h.invoke({ name: "p" });
    expect(appended).toHaveLength(2);
    expect(reads).toBe(2);

    await h.close();
  });

  it("warns ONCE when no timeline is wired — the skip is never silent again", async () => {
    const bus = new LocalEventBus();
    const collected: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(bus.subscribe({}), (e) =>
        Effect.sync(() => {
          collected.push(e);
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 5));

    const h = await makeHarness(() => undefined, bus);
    await h.invoke({ name: "p" });
    await h.invoke({ name: "p" });
    await new Promise((r) => setTimeout(r, 10));
    await Effect.runPromise(Fiber.interrupt(fiber));

    const warnings = collected.filter(
      (e) =>
        e.name === logEventName("prompts") &&
        (e.payload as LogEventPayload | undefined)?.level === "warning",
    );
    expect(warnings).toHaveLength(1);
    expect((warnings[0]!.payload as LogEventPayload).logger).toBe("@agentick/prompts");

    await h.close();
  });
});
