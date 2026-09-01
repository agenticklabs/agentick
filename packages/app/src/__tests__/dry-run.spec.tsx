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
import { useRenderContext } from "@agentick/compiler-react";
import { jsonSchema } from "@agentick/spec";
import type { ToolDeclaration } from "@agentick/spec";

function Agent() {
  return React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    "You are a helpful agent.",
  );
}

const greet: ToolDeclaration = {
  id: "greet",
  name: "greet",
  description: "say hi",
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
  handlerRef: "h.greet",
};

/** Renders the catalog it was handed — the shape `<Toolboxes />` has. */
function CatalogAgent() {
  const tools = useRenderContext().tools ?? [];
  return React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    `tools: ${tools.map((t) => t.name).join(", ")}`,
  );
}

function GroupsAgent() {
  const groups = useRenderContext().toolGroups ?? [];
  return React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    `groups: ${groups.map((g) => g.title).join(", ")}`,
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

  it("compiles against the same render context a tick would supply", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("dry-4", journal, bus, inbox, {
      scripted: [{ kind: "text", text: "ok" }] as never,
    });
    await executor.ready;
    const app = await createApp(React.createElement(CatalogAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      tools: [greet],
    });
    const session = await app.createSession({ sessionId: "dry-4" });
    try {
      const tree = await session.compile();
      // A preview that renders no catalog is a preview of a prompt the model
      // never sees — the tick's render supplies one, so this must too.
      expect(JSON.stringify(tree)).toContain("tools: greet");
    } finally {
      await app.close();
    }
  });

  it("compiles against the same group prose a tick would supply", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("dry-5", journal, bus, inbox, {
      scripted: [{ kind: "text", text: "ok" }] as never,
    });
    await executor.ready;
    const app = await createApp(React.createElement(GroupsAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      tools: [{ ...greet, group: ["greetings"] }],
      toolExecutor: {
        initialToolGroups: [{ path: ["greetings"], title: "Greetings", summary: "hi" }],
      },
    });
    const session = await app.createSession({ sessionId: "dry-5" });
    try {
      const tree = await session.compile();
      expect(JSON.stringify(tree)).toContain("groups: Greetings");
      // And the full dry run hands the catalog rows + prose beside the input,
      // so a preview surface can file the flat tool list by its groups.
      const run = await session.dryRun();
      expect(run.catalog?.map((t) => [t.name, t.group?.join("/")])).toEqual([
        ["greet", "greetings"],
      ]);
      expect(run.toolGroups?.map((g) => g.title)).toEqual(["Greetings"]);
    } finally {
      await app.close();
    }
  });
});
