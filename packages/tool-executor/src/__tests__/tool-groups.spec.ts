/**
 * The capability-tree PROSE registry (`toolExecutor.groups`) — upsert by path,
 * ordered listing. The paths themselves live on tools (`ToolDeclaration.group`);
 * this registry only carries what a renderer says ABOUT each path.
 */
import { describe, expect, it } from "vitest";
import type { ToolGroupInfo } from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";

import { ToolExecutorHarness } from "../harness.js";

async function mkExecutor(groups?: readonly ToolGroupInfo[]) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const elicitation = new ElicitationHarness("g:elicitation", journal, bus, inbox);
  const harness = new ToolExecutorHarness("g:tools", journal, bus, inbox, {
    elicitation,
    ...(groups !== undefined ? { initialToolGroups: groups } : {}),
  });
  await harness.ready;
  return harness;
}

describe("toolExecutor.groups", () => {
  it("seeds from initialToolGroups and lists order-then-path", async () => {
    const ex = await mkExecutor([
      { path: ["zeta"], title: "Z", summary: "last: no order sorts after every set order" },
      { path: ["writes"], title: "Writes", summary: "…", order: 2 },
      { path: ["reads"], title: "Reads", summary: "…", order: 1 },
    ]);
    expect(ex.groups.list().map((g) => g.title)).toEqual(["Reads", "Writes", "Z"]);
  });

  it("register is an UPSERT by path — re-registration replaces, never duplicates", async () => {
    const ex = await mkExecutor([{ path: ["memory"], title: "Memory", summary: "v1" }]);
    ex.groups.register([{ path: ["memory"], title: "Memory", summary: "v2" }]);
    const listed = ex.groups.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.summary).toBe("v2");
  });

  it("list(root) scopes to the subtree, the root's own declaration included", async () => {
    const ex = await mkExecutor([
      { path: ["writes"], title: "Writes", summary: "…" },
      { path: ["writes", "service"], title: "Service", summary: "…" },
      { path: ["writes-not"], title: "Prefix trap", summary: "segment match, not string prefix" },
      { path: ["reads"], title: "Reads", summary: "…" },
    ]);
    expect(ex.groups.list(["writes"]).map((g) => g.title)).toEqual(["Writes", "Service"]);
  });

  it("nested paths key independently of their parents", async () => {
    const ex = await mkExecutor();
    ex.groups.register([
      { path: ["writes"], title: "Writes", summary: "…" },
      { path: ["writes", "service"], title: "Service", summary: "…" },
    ]);
    expect(ex.groups.list().map((g) => g.path.join("/"))).toEqual(["writes", "writes/service"]);
  });
});

describe("aliases cannot orphan the lookup doors", () => {
  it("subscribe by an ALIAS fires when the canonical registration changes", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const elicitation = new ElicitationHarness("s:elicitation", journal, bus, inbox);
    const harness = new ToolExecutorHarness("s:tools", journal, bus, inbox, {
      elicitation,
      initialTools: [
        {
          declaration: {
            name: "svc__create",
            aliases: ["create"],
            description: "d",
            inputSchema: { type: "object" },
          },
          handlerRef: "h",
          binding: { scope: "runtime" },
        } as never,
      ],
    });
    await harness.ready;
    let fired = 0;
    harness.tools.subscribe("create", () => {
      fired += 1;
    });
    (
      harness as unknown as { registry: { add: (r: never, replace: boolean) => void } }
    ).registry.add(
      {
        declaration: {
          name: "svc__create",
          aliases: ["create"],
          description: "d2",
          inputSchema: { type: "object" },
        },
        handlerRef: "h",
        binding: { scope: "runtime" },
      } as never,
      true,
    );
    expect(fired).toBe(1);
  });
});
