/**
 * The whole reason `timelineCompiler()` exists rather than `fakeCompiler()` is
 * that the conversation must REACH the model. Its consumers — the ADR 99
 * recovery conformance factories — compare provider requests for byte
 * identity, and two EMPTY requests are byte-identical too. So a regression to
 * an empty tree would leave every one of them green while proving nothing;
 * these assertions are what stands between that and false confidence.
 */

import { describe, expect, it } from "vitest";

import type { HookBridges, TimelineEntry } from "@agentick/spec";

import { fakeBridges } from "../testing/fake-bridges.js";
import { timelineCompiler } from "../testing/timeline-compiler.js";

function messageEntry(id: string, role: string, text: string, visibility?: string): TimelineEntry {
  return {
    kind: "message",
    id,
    message: { id, role, content: [{ type: "text", text }] },
    ...(visibility !== undefined ? { visibility } : {}),
  } as unknown as TimelineEntry;
}

async function render(bridges: HookBridges) {
  const compiler = timelineCompiler()();
  await compiler.ready;
  const { mountId } = await compiler.mount({ element: null, sessionId: "s1", bridges });
  const result = await compiler.renderTree({ mountId, sessionId: "s1" });
  return result.tree.context.entries;
}

describe("timelineCompiler", () => {
  it("folds message entries into context entries, in order", async () => {
    const entries = await render(
      fakeBridges({
        timeline: [
          messageEntry("m1", "user", "what is on her schedule?"),
          messageEntry("m2", "assistant", "checking"),
        ],
      }),
    );

    expect(entries).toEqual([
      {
        kind: "message",
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "what is on her schedule?" }],
      },
      {
        kind: "message",
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "checking" }],
      },
    ]);
  });

  it("drops log-visibility entries, as the React default projection does", async () => {
    const entries = await render(
      fakeBridges({
        timeline: [
          messageEntry("m1", "user", "kept"),
          messageEntry("m2", "user", "dropped", "log"),
        ],
      }),
    );

    expect(entries.map((e) => (e as { id?: string }).id)).toEqual(["m1"]);
  });

  it("renders an empty context when no timeline bridge is mounted", async () => {
    expect(await render({} as HookBridges)).toEqual([]);
  });
});
