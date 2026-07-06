/**
 * `RenderContext` envelope (ADR 55) — the augmentable render-input seam.
 * `useRenderContext` reads the whole envelope; `useContextInfo` reads its
 * seeded `.contextInfo` slot; both are SYNCHRONOUS render inputs (no
 * async lifecycle race).
 */

import { describe, expect, it } from "vitest";
import React from "react";
import type { RenderContext } from "@agentick/spec-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { fakeBridges } from "@agentick/reconciler-next";
import { ReconcilerHarness } from "../harness/reconciler-harness.js";
import { useRenderContext } from "../react/hooks/use-render-context.js";
import { useContextInfo, type ContextInfo } from "../react/hooks/use-context-info.js";
import { flush } from "../testing/flush.js";

// The seam's CENTRAL claim (ADR 55): a package can contribute a slot to
// `RenderContext` via module augmentation — spec doesn't hardcode them.
// This test-scoped augmentation stands in for a rider (activeModel /
// budget / caller); if `RenderContext` were ever closed to augmentation,
// this file stops compiling. Verified by "an augmented slot round-trips".
declare module "@agentick/spec-next" {
  interface RenderContext {
    readonly testCaller?: { readonly subject: string };
  }
}

async function makeHarness(id: string) {
  const harness = new ReconcilerHarness(
    id,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

describe("RenderContext envelope", () => {
  it("useRenderContext returns the envelope; useContextInfo reads its .contextInfo slot", async () => {
    const harness = await makeHarness("h_rc_1");
    let envelope: RenderContext | undefined;
    let info: ContextInfo | undefined;

    function App() {
      envelope = useRenderContext();
      info = useContextInfo();
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_rc",
      sessionId: "s",
      element: React.createElement(App),
      bridges: fakeBridges(),
      renderContext: { contextInfo: { contextWindow: 200000 } },
    });
    await flush();

    // (a) the whole envelope round-trips through the render-context seam.
    expect(envelope).toEqual({ contextInfo: { contextWindow: 200000 } });
    // (b) useContextInfo reads the seeded contextInfo slot synchronously.
    expect(info?.contextWindow).toBe(200000);
  });

  it("useRenderContext returns {} when no renderContext was provided", async () => {
    const harness = await makeHarness("h_rc_2");
    let envelope: RenderContext | undefined;

    function App() {
      envelope = useRenderContext();
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_rc2",
      sessionId: "s",
      element: React.createElement(App),
      bridges: fakeBridges(),
      // no renderContext
    });
    await flush();

    // (c) unmounted-from-runtime / no envelope → empty object, never null.
    expect(envelope).toEqual({});
  });

  it("an augmented slot round-trips (proves packages can extend the envelope)", async () => {
    const harness = await makeHarness("h_rc_3");
    let envelope: RenderContext | undefined;

    function App() {
      envelope = useRenderContext();
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_rc3",
      sessionId: "s",
      element: React.createElement(App),
      bridges: fakeBridges(),
      // `testCaller` exists ONLY via the module augmentation above — the
      // seam threads arbitrary augmented slots through with no per-slot
      // knowledge (the reconciler never names them).
      renderContext: { contextInfo: { contextWindow: 1000 }, testCaller: { subject: "u-42" } },
    });
    await flush();

    expect(envelope?.testCaller).toEqual({ subject: "u-42" });
    expect(envelope?.contextInfo).toEqual({ contextWindow: 1000 });
  });
});
