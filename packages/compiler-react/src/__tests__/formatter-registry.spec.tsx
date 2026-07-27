/**
 * Verifies the formatter-registry slot on `CompilerHarnessOptions`:
 *   - Custom formatters can override the built-ins.
 *   - `defaultFormatterId` controls fallback when no scope is pinned.
 *   - Lookup falls back to `format` field when `id` doesn't match the
 *     registry (so adopters can pass `{ id: "xml", format: "xml" }`
 *     without knowing the canonical id).
 *   - A ref that matches NEITHER an id NOR a format is a REPORTED
 *     fallback, not a silent one (`formatter-unresolved` diagnostic).
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { createFormatter, type DefinedFormatter } from "@agentick/formatters";
import type { ReconcileDiagnostic } from "@agentick/spec";

import { CompilerHarness } from "../harness/compiler-harness.js";
import { FormatScope } from "../react/components/format-scope.js";
import { fakeBridges } from "@agentick/compiler";

async function makeHarness(options: ConstructorParameters<typeof CompilerHarness>[4] = {}) {
  const h = new CompilerHarness(
    "h_fmt",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    options,
  );
  await h.ready;
  return h;
}

describe("CompilerHarness — formatter registry slot", () => {
  it("uses custom formatters when supplied via options", async () => {
    const shoutFormatter: DefinedFormatter = createFormatter({
      id: "shout",
      format: "markdown",
      render: (blocks) =>
        blocks.map((b) => (b.type === "text" ? { type: "text", text: b.text.toUpperCase() } : b)),
    });

    const harness = await makeHarness({
      formatters: new Map([[shoutFormatter.__identity.id, shoutFormatter]]),
      defaultFormatterId: shoutFormatter.__identity.id,
    });
    await harness.mount({
      mountId: "m_shout",
      sessionId: "s",
      element: React.createElement("section", { id: "s" }, "hello"),
      bridges: fakeBridges(),
      defaultFormatter: { id: "shout", format: "markdown" },
    });
    const { payload } = await harness.renderToString({ mountId: "m_shout" });
    expect(payload.text).toContain("HELLO");
  });

  it("falls back from a missing id to a matching format", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_fallback",
      sessionId: "s",
      element: React.createElement("section", { id: "s" }, "body"),
      bridges: fakeBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    // The caller passes `id: "xml"` — not the canonical `formatter.xml`.
    // The resolver should match by format and dispatch to the XML formatter.
    const { payload } = await harness.renderToString({
      mountId: "m_fallback",
      formatter: { id: "xml", format: "xml" },
    });
    expect(payload.text).toContain('<section id="s"');
  });

  it("markdown is the default when no formatter is supplied", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_default",
      sessionId: "s",
      element: React.createElement("section", { id: "s", title: "T" }, "body"),
      bridges: fakeBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({ mountId: "m_default" });
    expect(payload.text).toContain("## T");
  });
});

describe("CompilerHarness — unresolvable formatter refs are REPORTED", () => {
  /** Mount a tree whose subtree pins `ref`, then render and return the result. */
  async function renderWithScope(mountId: string, ref: { id: string; format?: string }) {
    const harness = await makeHarness();
    await harness.mount({
      mountId,
      sessionId: "s",
      element: React.createElement(
        FormatScope,
        { formatter: ref },
        React.createElement("section", { id: "s" }, "body"),
      ),
      bridges: fakeBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    return harness.renderTree({ mountId, sessionId: "s" });
  }

  const unresolved = (diagnostics: readonly ReconcileDiagnostic[]) =>
    diagnostics.filter((d) => d.code === "formatter-unresolved");

  it("an id that matches no formatter AND no format is reported, not silently defaulted", async () => {
    const { diagnostics } = await renderWithScope("m_ghost", { id: "shout-loud" });
    const hits = unresolved(diagnostics);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ severity: "warning", code: "formatter-unresolved" });
    expect(hits[0]!.message).toContain("shout-loud");
    // The fallback formatter that actually ran is named, so the adopter can
    // see WHAT rendered instead of what they asked for.
    expect(hits[0]!.message).toContain("formatter.markdown");
  });

  it("an unknown format hint is reported too (nothing in the registry can serve it)", async () => {
    const { diagnostics } = await renderWithScope("m_ghost_fmt", {
      id: "shout-loud",
      format: "yaml",
    });
    const hits = unresolved(diagnostics);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain("yaml");
  });

  it("the report is emitted ONCE per distinct ref, not once per entry", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_ghost_many",
      sessionId: "s",
      element: React.createElement(
        FormatScope,
        { formatter: { id: "shout-loud" } },
        React.createElement("section", { id: "a" }, "one"),
        React.createElement("section", { id: "b" }, "two"),
        React.createElement("section", { id: "c" }, "three"),
      ),
      bridges: fakeBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { tree, diagnostics } = await harness.renderTree({
      mountId: "m_ghost_many",
      sessionId: "s",
    });
    expect(tree.context.entries).toHaveLength(3);
    expect(unresolved(diagnostics)).toHaveLength(1);
  });

  it("the tree still renders through the default — a bad ref degrades, never throws", async () => {
    const { tree } = await renderWithScope("m_ghost_out", { id: "shout-loud" });
    const first = tree.context.entries[0]!;
    if (first.kind !== "section") throw new Error("expected a section entry");
    expect(first.content).toEqual([{ type: "text", text: "body" }]);
  });

  it("an id miss that a FORMAT hint rescues is NOT reported (the documented path)", async () => {
    const { diagnostics } = await renderWithScope("m_fmt_ok", { id: "xml", format: "xml" });
    expect(unresolved(diagnostics)).toHaveLength(0);
  });

  it("an exact id match is NOT reported", async () => {
    const { diagnostics } = await renderWithScope("m_id_ok", { id: "formatter.text" });
    expect(unresolved(diagnostics)).toHaveLength(0);
  });

  it("a caller-pinned renderToString formatter that resolves to nothing is reported", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_str_ghost",
      sessionId: "s",
      element: React.createElement("section", { id: "s" }, "body"),
      bridges: fakeBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload, diagnostics } = await harness.renderToString({
      mountId: "m_str_ghost",
      formatter: { id: "no-such-formatter" },
    });
    expect(unresolved(diagnostics)).toHaveLength(1);
    expect(unresolved(diagnostics)[0]!.message).toContain("no-such-formatter");
    // Still produced output.
    expect(payload.text).toContain("body");
  });
});
