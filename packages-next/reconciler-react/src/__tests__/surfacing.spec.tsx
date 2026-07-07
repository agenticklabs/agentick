/**
 * ADR 63 — compiler surfacing mechanism.
 *
 * Exercises the harness projection model end-to-end through the real
 * `ReconcilerHarness`: default-on surfacing, lazy default suppression on
 * override, and provenance tagging. These use the compiler-general
 * primitives (`<Project>` + the `tools`/`timeline` defaults) WITHOUT the
 * `@agentick/timeline-next` package — the timeline is seeded structurally
 * via `fakeBridges`.
 */

import { describe, expect, it } from "vitest";
import React from "react";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { fakeBridges } from "@agentick/reconciler-next";
import type { TimelineEntry } from "@agentick/spec-next";
import { extractText } from "@agentick/spec-next";

import { ReconcilerHarness } from "../harness/reconciler-harness.js";
import { Project } from "../react/components/index.js";

async function makeHarness(scope = `surf-${Math.random()}`) {
  const harness = new ReconcilerHarness(
    scope,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

function messageEntry(text: string, role = "user", id = `m_${Math.random()}`): TimelineEntry {
  return {
    kind: "message",
    message: { id, role, content: [{ type: "text", text }], ts: Date.now() },
  } as TimelineEntry;
}

async function render(element: React.ReactNode, timeline?: readonly TimelineEntry[]) {
  const harness = await makeHarness();
  const mountId = `m_${Math.random()}`;
  await harness.mount({
    mountId,
    sessionId: "s",
    element,
    bridges: timeline ? fakeBridges({ timeline }) : fakeBridges(),
  });
  return harness.renderTree({ mountId, sessionId: "s" });
}

// ============================================================================
// Timeline default (default-on)
// ============================================================================

describe("timeline default projection", () => {
  it("surfaces the conversation when no <Timeline> overrides it (default-on)", async () => {
    const { tree } = await render(React.createElement("section", { id: "sys" }, "system"), [
      messageEntry("hello", "user"),
      messageEntry("hi", "assistant"),
    ]);

    const messages = tree.context.entries.filter((e) => e.kind === "message");
    expect(messages.map((m) => (m.kind === "message" ? extractText(m.content) : ""))).toEqual([
      "hello",
      "hi",
    ]);
    // Default-produced, tagged default:timeline; the section is authored.
    expect(tree.provenance?.entries).toContain("default:timeline");
    expect(tree.provenance?.entries).toContain("authored:content");
  });

  it("does NOT run the default fold when a projection overrides timeline (lazy)", async () => {
    // Seed 3 timeline entries, but override the `timeline` projection with
    // a single custom message. If the default had ALSO run, we'd see the
    // 3 seeded entries too (double-fold). We must see ONLY the override.
    const { tree } = await render(
      React.createElement(
        Project,
        { projectionKey: "timeline" },
        React.createElement("message", { role: "user" }, "CUSTOM"),
      ),
      [messageEntry("a"), messageEntry("b"), messageEntry("c")],
    );

    const messages = tree.context.entries.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.kind === "message" && extractText(messages[0]!.content)).toBe("CUSTOM");
    // Override → authored:timeline, and NO default:timeline anywhere.
    expect(tree.provenance?.entries).toContain("authored:timeline");
    expect(tree.provenance?.entries ?? []).not.toContain("default:timeline");
  });
});

// ============================================================================
// Tools default
// ============================================================================

describe("tools default projection", () => {
  it("advertises registered <tool>s by default and tags them default:tools", async () => {
    const { tree } = await render(
      React.createElement("tool", {
        name: "add",
        description: "Add two numbers",
        inputSchema: { type: "object" },
        exposure: ["model"],
        handlerRef: "h/add",
      }),
    );

    expect(tree.declarations?.tools).toHaveLength(1);
    expect(tree.declarations!.tools![0]!.name).toBe("add");
    expect(tree.features).toContain("tool-declarations");
    expect(tree.provenance?.tools).toEqual(["default:tools"]);
  });

  it("surfaces no tool declarations when none are registered", async () => {
    const { tree } = await render(React.createElement("section", { id: "sys" }, "system"));
    expect(tree.declarations?.tools).toBeUndefined();
    expect(tree.provenance?.tools).toBeUndefined();
  });
});

// ============================================================================
// Invariant — IR = only what the compiler produced
// ============================================================================

describe("surfacing invariant", () => {
  it("produces every context entry through the collect/assemble path (nothing injected)", async () => {
    // A bare tree with a seeded timeline: the ONLY entries are the
    // authored section + the default-folded timeline. No stray entries.
    const { tree } = await render(React.createElement("section", { id: "sys" }, "system"), [
      messageEntry("only"),
    ]);
    // provenance array is index-aligned 1:1 with context.entries.
    expect(tree.provenance?.entries).toHaveLength(tree.context.entries.length);
    // section (authored:content) precedes the appended default timeline.
    expect(tree.provenance?.entries).toEqual(["authored:content", "default:timeline"]);
  });
});
