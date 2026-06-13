/**
 * Verifies the formatter-registry slot on `ReconcilerHarnessOptions`:
 *   - Custom formatters can override the built-ins.
 *   - `defaultFormatterId` controls fallback when no scope is pinned.
 *   - Lookup falls back to `format` field when `id` doesn't match the
 *     registry (so adopters can pass `{ id: "xml", format: "xml" }`
 *     without knowing the canonical id).
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { defineFormatter, type DefinedFormatter } from "@agentick/formatters-next";

import { ReconcilerHarness } from "../harness/reconciler-harness.js";
import { fakeBridges } from "@agentick/reconciler-next";

async function makeHarness(options: ConstructorParameters<typeof ReconcilerHarness>[4] = {}) {
  const h = new ReconcilerHarness(
    "h_fmt",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    options,
  );
  await h.ready;
  return h;
}

describe("ReconcilerHarness — formatter registry slot", () => {
  it("uses custom formatters when supplied via options", async () => {
    const shoutFormatter: DefinedFormatter = defineFormatter({
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
