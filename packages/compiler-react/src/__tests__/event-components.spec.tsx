import { describe, expect, it } from "vitest";
import React from "react";
import {
  createContainer,
  createHostScope,
  collect,
  createBuiltInRegistry,
} from "@agentick/compiler";
import { createCompiler } from "../react/compiler.js";
import { Event, SystemEvent, StateChange, User, UserAction } from "../react/components/index.js";

/**
 * Position-aware event components: at the top level each forms its own
 * event-role entry; inside a message it contributes just the block. Both
 * positions lower to the same structured wire record — never a TextBlock.
 */

function renderAndCollect(element: React.ReactNode) {
  const container = createContainer({
    mountId: "ev",
    rootScope: createHostScope({ formatter: { id: "markdown", format: "markdown" } }),
  });
  const compiler = createCompiler({ container, idPrefix: "ev" });
  const root = compiler.createRoot();
  compiler.render(element, root);
  return collect({
    roots: container.children,
    registry: createBuiltInRegistry(),
    rootScope: container.rootScope,
  });
}

describe("event components — position aware", () => {
  it("top-level <SystemEvent> forms its own event entry with the structured block", () => {
    const { tree } = renderAndCollect(
      <SystemEvent event="compaction" source="timeline" data={{ entries: 42 }} />,
    );
    const entry = tree.context.entries[0]!;
    expect(entry.role).toBe("event");
    expect(entry.content[0]).toMatchObject({
      type: "system_event",
      event: "compaction",
      source: "timeline",
      data: { entries: 42 },
    });
  });

  it("inside <Event>, components contribute blocks to the ONE entry — no nesting", () => {
    const { tree } = renderAndCollect(
      <Event>
        <SystemEvent event="job-sync" source="scheduler" />
        <StateChange entity="job-113" field="status" from="draft" to="active" />
      </Event>,
    );
    expect(tree.context.entries).toHaveLength(1);
    const entry = tree.context.entries[0]!;
    expect(entry.role).toBe("event");
    expect(entry.content.map((b) => (b as { type: string }).type)).toEqual([
      "system_event",
      "state_change",
    ]);
  });

  it("inside a non-event message, contributes the block to THAT entry", () => {
    const { tree } = renderAndCollect(
      <User>
        approve this
        <UserAction action="approved_invoice" />
      </User>,
    );
    expect(tree.context.entries).toHaveLength(1);
    const entry = tree.context.entries[0]!;
    expect(entry.role).toBe("user");
    expect(entry.content.some((b) => (b as { type: string }).type === "user_action")).toBe(true);
  });
});
