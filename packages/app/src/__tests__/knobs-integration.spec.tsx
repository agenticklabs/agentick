/**
 * ADR 26 Step 2.5 — KnobsHarness wired through a real session.
 *
 * End-to-end smoke test proving the dormant code from Steps 1/2 is no
 * longer dormant: createApp constructs a session; the session's
 * `bridges.knobs` slot is a real `KnobsHarness` (not a separate
 * in-memory bridge implementation); useKnob inside an agent component
 * reaches it via useBridges; host-side mutations and reads work
 * through the harness's async/sync surfaces.
 *
 * The substrate-level flow (Operation envelopes, inbox addressability,
 * envelope phase contract) is verified in
 * `@agentick/runtime/__tests__/harness-plumbing.spec.ts` and
 * `@agentick/knobs/__tests__/harness.spec.ts`. Here we only prove the
 * end-to-end wiring through createApp + createSession.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { KnobsHarness } from "@agentick/knobs";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { useKnob } from "@agentick/knobs/react";
import type { ContentBlock } from "@agentick/spec";

import { createApp } from "../react.js";

async function mkExecutor() {
  const exec = new FakeLanguageModelExecutor(
    "knobs-int-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "ok" } satisfies ContentBlock],
            stopReason: "end",
          },
        },
      ],
    },
  );
  await exec.ready;
  return exec;
}

describe("KnobsHarness — session integration", () => {
  it("session.bridges.knobs IS a KnobsHarness instance (no parallel bridge impl)", async () => {
    function Agent() {
      useKnob("verbose", false);
      return React.createElement("message", { role: "user" }, "hello");
    }

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
    });
    const session = await app.createSession();

    const knobs = (session as unknown as { bridges: { knobs: unknown } }).bridges.knobs;
    expect(knobs).toBeInstanceOf(KnobsHarness);

    await app.closeApp();
  });

  it("useKnob's register reaches the session's harness; host-side set is visible", async () => {
    function Agent() {
      useKnob<string>("mood", "curious");
      return React.createElement("message", { role: "user" }, "ok");
    }

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
    });
    const session = await app.createSession();
    const knobs = (session as unknown as { bridges: { knobs: KnobsHarness } }).bridges.knobs;

    // Run a tick — the agent's useKnob fires register via useEffect.
    const handle = await session.send({ messages: [{ role: "user", content: "ping" }] });
    await handle.result;

    // Register has reached the harness.
    const mood = knobs.list().find((d) => d.id === "mood");
    expect(mood).toBeDefined();
    expect(mood?.value).toBe("curious");

    // Host-side mutation goes through the harness's async Operation.
    await knobs.set({ id: "mood", value: "decisive" });
    expect(knobs.get("mood")).toBe("decisive");

    await app.closeApp();
  });

  it("multiple sessions get their own KnobsHarness (no shared state)", async () => {
    function Agent() {
      useKnob("verbose", false);
      return React.createElement("message", { role: "user" }, "ok");
    }

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
    });
    const s1 = await app.createSession();
    const s2 = await app.createSession();

    const k1 = (s1 as unknown as { bridges: { knobs: KnobsHarness } }).bridges.knobs;
    const k2 = (s2 as unknown as { bridges: { knobs: KnobsHarness } }).bridges.knobs;
    expect(k1).not.toBe(k2);

    await k1.set({ id: "shared-name", value: "session-1" });
    await k2.set({ id: "shared-name", value: "session-2" });
    expect(k1.get("shared-name")).toBe("session-1");
    expect(k2.get("shared-name")).toBe("session-2");

    await app.closeApp();
  });
});
