/**
 * `session.dryRun()` — compile what a tick WOULD send, without sending it.
 *
 * The rungs are the ones the loop walks (`compiler.renderTree` →
 * `executor.project` → `adapter.prepareRequest`), stopped one step short of the
 * provider call. Tested at the adopter's entry point, because the claim is about
 * what a caller gets from a session they built the normal way.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ExecutionTarget } from "@agentick/spec";

import { createApp } from "../react.js";

function Agent() {
  return React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    "You are a helpful agent.",
  );
}

const mkTarget = (): ExecutionTarget =>
  ({ kind: "language-model", provider: "fake", modelId: "m", capabilities: {} }) as ExecutionTarget;

async function mkApp(id: string) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor(id, journal, bus, inbox, {
    scripted: [{ kind: "text", text: "ok" }] as never,
  });
  await executor.ready;
  const app = await createApp(React.createElement(Agent), {
    modelExecutor: executor,
    target: mkTarget(),
    journal,
    bus,
    inbox,
  });
  return { app, executor };
}

describe("session.dryRun", () => {
  it("returns the tree and the model input", async () => {
    const { app } = await mkApp("dry-1");
    const session = await app.createSession({ sessionId: "dry-1" });
    try {
      const preview = await session.dryRun();

      expect(preview.tree).toBeDefined();
      expect(preview.input).toBeDefined();
      // The system section the agent renders reaches the model input.
      expect(JSON.stringify(preview.input)).toContain("helpful agent");
    } finally {
      await app.close();
    }
  });

  it("sends nothing and leaves the timeline alone", async () => {
    const { app } = await mkApp("dry-2");
    const session = await app.createSession({ sessionId: "dry-2" });
    try {
      const before = JSON.stringify(await session.snapshot());
      await session.dryRun();
      await session.dryRun();

      // Two previews leave the durable state byte-identical: nothing appended,
      // no tick counted, no execution recorded.
      expect(JSON.stringify(await session.snapshot())).toBe(before);
    } finally {
      await app.close();
    }
  });

  it("compile() is the rung that needs no model", async () => {
    const { app } = await mkApp("dry-3");
    const session = await app.createSession({ sessionId: "dry-3" });
    try {
      const tree = await session.compile();
      expect(tree).toBeDefined();
      // And project() builds on it rather than re-rendering.
      const input = await session.project(tree);
      expect(JSON.stringify(input)).toContain("helpful agent");
    } finally {
      await app.close();
    }
  });
});
