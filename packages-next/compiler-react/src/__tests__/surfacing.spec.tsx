/**
 * ADR 63 — compiler surfacing mechanism.
 *
 * Exercises the harness projection model end-to-end through the real
 * `CompilerHarness`: default-on surfacing, lazy default suppression on
 * override, tree-order assembly, and provenance tagging. Uses the
 * compiler-general primitives (`<Project>` + the `tools`/`timeline`
 * defaults) WITHOUT the `@agentick/timeline-next` package — the timeline
 * is seeded structurally via `fakeBridges`.
 *
 * Assertions are exact (full ordered arrays, not `toContain`) so a
 * regression in ordering, double-folding, or provenance alignment fails
 * loudly.
 */

import { describe, expect, it } from "vitest";
import React from "react";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { fakeBridges } from "@agentick/compiler-next";
import type { SurfacingProvenance, TimelineEntry } from "@agentick/spec-next";
import { extractText } from "@agentick/spec-next";

import { CompilerHarness } from "../harness/compiler-harness.js";
import { Project } from "../react/components/index.js";

async function makeHarness(scope = `surf-${Math.random()}`) {
  const harness = new CompilerHarness(
    scope,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

let seq = 0;
function msg(text: string, role = "user"): TimelineEntry {
  return {
    kind: "message",
    message: { id: `m${seq++}`, role, content: [{ type: "text", text }], ts: seq },
  } as TimelineEntry;
}
function logMsg(text: string): TimelineEntry {
  return {
    kind: "message",
    visibility: "log",
    message: { id: `m${seq++}`, role: "user", content: [{ type: "text", text }], ts: seq },
  } as TimelineEntry;
}
function boundary(): TimelineEntry {
  return {
    kind: "boundary",
    boundary: { executionId: `e${seq++}`, outcome: "succeeded" },
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

/** Ordered `[label, provenance]` pairs — the exact, index-aligned view. */
function entryRows(tree: {
  context: { entries: readonly unknown[] };
  provenance?: { entries?: readonly SurfacingProvenance[] };
}): Array<[string, SurfacingProvenance | undefined]> {
  return tree.context.entries.map((e, i) => {
    const entry = e as { kind: string; title?: string; content: never };
    const label =
      entry.kind === "message" ? extractText(entry.content) : `section:${entry.title ?? "?"}`;
    return [label, tree.provenance?.entries?.[i]];
  });
}

// ============================================================================
// Timeline default (default-on) + ordering
// ============================================================================

describe("timeline default projection", () => {
  it("surfaces the conversation AFTER authored content when no <Timeline> overrides it", async () => {
    // System section is authored; the seeded conversation folds by
    // default and appends after — exact order + provenance.
    const { tree } = await render(
      React.createElement("section", { id: "sys", title: "sys" }, "system"),
      [msg("hello", "user"), msg("hi", "assistant")],
    );

    expect(entryRows(tree)).toEqual([
      ["section:sys", "authored:content"],
      ["hello", "default:timeline"],
      ["hi", "default:timeline"],
    ]);
  });

  it("excludes visibility:log and non-message (boundary) entries from the default fold", async () => {
    const { tree } = await render(React.createElement(React.Fragment, null), [
      msg("keep-me"),
      logMsg("drop-log"),
      boundary(),
    ]);

    // Only the one model-visible message surfaces.
    expect(entryRows(tree)).toEqual([["keep-me", "default:timeline"]]);
  });

  it("does NOT run the default fold when a projection overrides timeline (lazy)", async () => {
    // Seed 3 entries; override with a single custom message. A double-fold
    // would show the 3 seeded entries too — we must see ONLY the override.
    const { tree } = await render(
      React.createElement(
        Project,
        { projectionKey: "timeline" },
        React.createElement("message", { role: "user" }, "CUSTOM"),
      ),
      [msg("a"), msg("b"), msg("c")],
    );

    expect(entryRows(tree)).toEqual([["CUSTOM", "authored:timeline"]]);
  });

  it("an EMPTY override still suppresses the default (suppression keys on presence, not count)", async () => {
    // The sharpest lazy proof: seed 3 entries, override with NOTHING. If
    // suppression depended on the override producing entries, the default
    // would leak the 3 seeded messages back in. It must not.
    const { tree } = await render(React.createElement(Project, { projectionKey: "timeline" }), [
      msg("a"),
      msg("b"),
      msg("c"),
    ]);

    expect(tree.context.entries).toHaveLength(0);
    expect(tree.provenance?.entries ?? []).not.toContain("default:timeline");
  });

  it("places an authored <Project> at its tree position, interleaved with content", async () => {
    const { tree } = await render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement("section", { id: "a", title: "A" }, "a"),
        React.createElement(
          Project,
          { projectionKey: "timeline" },
          React.createElement("message", { role: "user" }, "MID"),
        ),
        React.createElement("section", { id: "b", title: "B" }, "b"),
      ),
      [msg("unused")], // seeded but overridden → never folded
    );

    expect(entryRows(tree)).toEqual([
      ["section:A", "authored:content"],
      ["MID", "authored:timeline"],
      ["section:B", "authored:content"],
    ]);
  });
});

// ============================================================================
// Tools default
// ============================================================================

describe("tools default projection", () => {
  function tool(name: string) {
    return React.createElement("tool", {
      key: name,
      name,
      description: `${name} tool`,
      inputSchema: { type: "object" },
      exposure: ["model"],
      handlerRef: `h/${name}`,
    });
  }

  it("advertises registered <tool>s by default, preserving order, tagged default:tools", async () => {
    const { tree } = await render(
      React.createElement(React.Fragment, null, tool("alpha"), tool("beta")),
    );

    expect(tree.declarations?.tools?.map((t) => t.name)).toEqual(["alpha", "beta"]);
    expect(tree.features).toContain("tool-declarations");
    expect(tree.provenance?.tools).toEqual(["default:tools", "default:tools"]);
  });

  it("surfaces no tool declarations (and no tools provenance) when none are registered", async () => {
    const { tree } = await render(React.createElement("section", { id: "sys" }, "system"));
    expect(tree.declarations?.tools).toBeUndefined();
    expect(tree.provenance?.tools).toBeUndefined();
  });
});

// ============================================================================
// Contract — <project> without a key
// ============================================================================

describe("<project> contract", () => {
  it("emits a MISSING_PROJECTION_KEY diagnostic when projectionKey is absent", async () => {
    // Bypass the typed <Project> wrapper to hit the contributor's guard.
    const { tree, diagnostics } = await render(
      React.createElement(
        "project",
        {},
        React.createElement("message", { role: "user" }, "orphan"),
      ),
      [msg("seeded")],
    );

    expect(diagnostics.some((d) => d.code === "MISSING_PROJECTION_KEY")).toBe(true);
    // A keyless <project> does NOT override anything → the timeline
    // default still runs (the seeded message surfaces), and the orphaned
    // child contributes nothing itself.
    expect(entryRows(tree)).toEqual([["seeded", "default:timeline"]]);
  });
});

// ============================================================================
// Invariant — IR = only what the compiler produced
// ============================================================================

describe("surfacing invariant", () => {
  it("keeps provenance index-aligned 1:1 with context.entries (no injected entries)", async () => {
    const { tree } = await render(
      React.createElement("section", { id: "sys", title: "sys" }, "system"),
      [msg("only")],
    );
    expect(tree.provenance?.entries).toHaveLength(tree.context.entries.length);
    expect(tree.provenance?.entries).toEqual(["authored:content", "default:timeline"]);
  });

  it("emits no provenance sidecar for a truly empty tree", async () => {
    const { tree } = await render(React.createElement(React.Fragment, null));
    expect(tree.context.entries).toEqual([]);
    expect(tree.provenance).toBeUndefined();
  });
});
