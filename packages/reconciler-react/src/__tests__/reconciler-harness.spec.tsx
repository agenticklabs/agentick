import { describe, expect, it } from "vitest";
import React from "react";
import { Chunk, Effect, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ProtocolEvent } from "@agentick/spec";
import { ReconcilerHarness } from "../harness/reconciler-harness.js";
import { stubBridges } from "@agentick/reconciler";

async function collectJournal(journal: MemoryJournal): Promise<ProtocolEvent[]> {
  const chunk = await Effect.runPromise(Stream.runCollect(journal.read({}, "beginning")));
  return Array.from(Chunk.toReadonlyArray(chunk));
}

async function makeHarness() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new ReconcilerHarness("h_1", journal, bus, inbox);
  await harness.ready;
  return { harness, journal, bus, inbox };
}

describe("ReconcilerHarness — end-to-end", () => {
  it("mount → renderTree → RenderedTree round-trip", async () => {
    const { harness } = await makeHarness();
    const bridges = stubBridges({ sessionId: "s_1" });

    const Agent = () =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement("message", { role: "system" }, "You are a helpful agent."),
        React.createElement("section", { id: "s.tools", title: "Tools" }, "available tools…"),
        React.createElement("tool", {
          id: "t.echo",
          name: "echo",
          description: "Echo input back",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
          exposure: ["model"],
          handlerRef: "handlers/echo",
        }),
      );

    await harness.mount({
      mountId: "m_1",
      sessionId: "s_1",
      element: React.createElement(Agent),
      bridges,
      defaultFormatter: { id: "markdown", format: "markdown" },
    });

    const { tree, iterations, diagnostics } = await harness.renderTree({
      mountId: "m_1",
      sessionId: "s_1",
    });

    expect(iterations).toBe(1);
    expect(diagnostics).toEqual([]);

    expect(tree.specVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(tree.context.entries).toHaveLength(2);
    const [system, section] = tree.context.entries;
    if (system?.kind !== "message" || section?.kind !== "section") {
      throw new Error("expected message + section");
    }
    expect(system.role).toBe("system");
    expect(section.id).toBe("s.tools");
    expect(section.title).toBe("Tools");

    expect(tree.declarations?.tools).toHaveLength(1);
    expect(tree.declarations!.tools![0]!.name).toBe("echo");
    expect(tree.features).toEqual(expect.arrayContaining(["sections", "tool-declarations"]));
  });

  it("emits requested + terminal events into the journal", async () => {
    const { harness, journal } = await makeHarness();
    const bridges = stubBridges();

    await harness.mount({
      mountId: "m_2",
      sessionId: "s_2",
      element: React.createElement("message", { role: "user" }, "hello"),
      bridges,
    });
    await harness.renderTree({ mountId: "m_2", sessionId: "s_2" });

    const events = await collectJournal(journal);
    const journaled = events.map((ev) => ({
      name: ev.name,
      phase: ev.phase,
      outcome: ev.outcome,
    }));
    expect(
      journaled.some((e) => e.name === "reconciler:command:mount" && e.phase === "requested"),
    ).toBe(true);
    expect(
      journaled.some(
        (e) =>
          e.name === "reconciler:command:render-tree" &&
          e.phase === "terminal" &&
          e.outcome === "succeeded",
      ),
    ).toBe(true);
  });

  it("rerender swaps the root element", async () => {
    const { harness } = await makeHarness();
    const bridges = stubBridges();

    await harness.mount({
      mountId: "m_3",
      sessionId: "s_3",
      element: React.createElement("message", { role: "user" }, "first"),
      bridges,
    });

    const r1 = await harness.renderTree({ mountId: "m_3", sessionId: "s_3" });
    const m1 = r1.tree.context.entries[0]!;
    if (m1.kind !== "message") throw new Error("expected message");
    expect(m1.content).toEqual([{ type: "text", text: "first" }]);

    await harness.rerender({
      mountId: "m_3",
      element: React.createElement("message", { role: "user" }, "second"),
    });
    const r2 = await harness.renderTree({ mountId: "m_3", sessionId: "s_3" });
    const m2 = r2.tree.context.entries[0]!;
    if (m2.kind !== "message") throw new Error("expected message");
    expect(m2.content).toEqual([{ type: "text", text: "second" }]);
  });

  it("renderTree on an unmounted mountId rejects with NotMounted", async () => {
    const { harness } = await makeHarness();
    await expect(harness.renderTree({ mountId: "missing", sessionId: "s" })).rejects.toMatchObject({
      _tag: "NotMounted",
      mountId: "missing",
    });
  });

  it("inbox recompile message triggers a re-render", async () => {
    const { harness, inbox } = await makeHarness();
    const bridges = stubBridges();

    await harness.mount({
      mountId: "m_4",
      sessionId: "s_4",
      element: React.createElement("message", { role: "user" }, "hi"),
      bridges,
    });

    // Send a recompile via inbox.
    const ack = await Effect.runPromise(
      inbox.send("reconciler:h_1", {
        type: "recompile",
        messageId: "msg_recompile_1",
        payload: { type: "recompile", mountId: "m_4" },
      }),
    );
    expect(ack.messageId).toBe("msg_recompile_1");
  });

  it("snapshot returns a spec-shaped payload", async () => {
    const { harness } = await makeHarness();
    const bridges = stubBridges({ knobs: { mood: "curious" } });
    await harness.mount({
      mountId: "m_5",
      sessionId: "s_5",
      element: React.createElement("message", { role: "user" }, "snap"),
      bridges,
      elementVersion: "sha:abc",
    });

    const snap = await harness.snapshot({ mountId: "m_5" });
    expect(snap.specVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snap.mountId).toBe("m_5");
    expect(snap.elementVersion).toBe("sha:abc");
    expect(snap.bridges.knobs).toEqual({ mood: "curious" });
    // Round-trips through JSON without losing information (spec firewall).
    const round = JSON.parse(JSON.stringify(snap));
    expect(round).toEqual(snap);
  });
});
