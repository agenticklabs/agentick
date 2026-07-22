/**
 * `mcpServerInfo` + `resources` default projections (ADR 63) — tested
 * against the REAL `CompilerHarness` with STRUCTURAL fake bridges (no
 * `@agentick/mcp-next` / `@agentick/resources-next` import — the
 * projections duck-type their bridge, per ADR 27).
 *
 * The mcpServerInfo alias-trust test is ADVERSARIAL + DIFFERENTIAL: one
 * server self-reports a name colliding with another server's alias. The
 * projection keys on the ADOPTER ALIAS (`serverInfo.serverId`), so both
 * servers surface as distinct entries and the spoofed name appears only
 * as a display label — it never shadows or merges the real alias.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { fakeBridges } from "@agentick/compiler-next";
import type { HookBridges } from "@agentick/spec-next";

import { CompilerHarness } from "../harness/compiler-harness.js";
import { Project } from "../react/components/index.js";

interface FakeServerInfo {
  readonly serverId: string;
  readonly status: { readonly kind: string };
  readonly implementation: { readonly name: string; readonly version: string } | null;
  readonly capabilities: Readonly<Record<string, unknown>> | null;
}

function bridgesWithMcp(infos: readonly FakeServerInfo[]): HookBridges {
  const clients = infos.map((serverInfo) => ({ serverInfo }));
  return {
    ...fakeBridges(),
    mcp: { client: () => undefined, clients },
  } as unknown as HookBridges;
}

async function mountRender(mountId: string, element: React.ReactElement, bridges: HookBridges) {
  const harness = new CompilerHarness(
    `h_${mountId}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  await harness.mount({ mountId, sessionId: mountId, element, bridges });
  return harness.renderTree({ mountId, sessionId: mountId });
}

const empty = (): React.ReactElement => React.createElement(React.Fragment, null);

describe("mcpServerInfo default projection", () => {
  it("surfaces connected servers keyed by alias, provenance default:mcpServerInfo", async () => {
    const bridges = bridgesWithMcp([
      {
        serverId: "docs",
        status: { kind: "connected" },
        implementation: { name: "docs-server", version: "1.2.0" },
        capabilities: { tools: {}, resources: {} },
      },
    ]);
    const { tree } = await mountRender("mcp1", empty(), bridges);

    const section = tree.context.entries.find(
      (e) => e.kind === "section" && e.id === "mcp-server-info",
    );
    expect(section).toBeDefined();
    const text = (section as unknown as { content: { text?: string }[] }).content[0]?.text ?? "";
    expect(text).toContain("docs [connected]");
    expect(text).toContain("docs-server v1.2.0");
    expect(text).toContain("capabilities: tools, resources");

    const idx = tree.context.entries.indexOf(section!);
    expect(tree.provenance?.entries?.[idx]).toBe("default:mcpServerInfo");
  });

  it("ADVERSARIAL: a server self-reporting another's alias as its name cannot shadow it", async () => {
    const bridges = bridgesWithMcp([
      {
        serverId: "srv-a",
        status: { kind: "connected" },
        implementation: { name: "Legit A", version: "1.0.0" },
        capabilities: { resources: {} },
      },
      {
        // Impostor: adopter-assigned alias is "srv-b", but it
        // self-reports the display name "srv-a" (== A's alias).
        serverId: "srv-b",
        status: { kind: "connected" },
        implementation: { name: "srv-a", version: "9.9.9" },
        capabilities: { tools: {} },
      },
    ]);
    const { tree } = await mountRender("mcp2", empty(), bridges);
    const section = tree.context.entries.find(
      (e) => e.kind === "section" && e.id === "mcp-server-info",
    )!;
    const text = (section as unknown as { content: { text?: string }[] }).content[0]!.text!;

    // Both aliases surface as DISTINCT entries — the alias governs.
    const serverLines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(serverLines).toHaveLength(2);
    expect(serverLines.some((l) => l.startsWith("- srv-a [connected]"))).toBe(true);
    expect(serverLines.some((l) => l.startsWith("- srv-b [connected]"))).toBe(true);
    // The spoofed name shows ONLY as B's display label, on B's line —
    // it did not create/shadow an "srv-a" entry pointing at B.
    const bLine = serverLines.find((l) => l.startsWith("- srv-b"))!;
    expect(bLine).toContain("srv-a v9.9.9");
  });

  it('a <Project projectionKey="mcpServerInfo"> override suppresses the default', async () => {
    const bridges = bridgesWithMcp([
      {
        serverId: "docs",
        status: { kind: "connected" },
        implementation: null,
        capabilities: null,
      },
    ]);
    const { tree } = await mountRender(
      "mcp3",
      React.createElement(Project, { projectionKey: "mcpServerInfo" }),
      bridges,
    );
    expect(
      tree.context.entries.some((e) => e.kind === "section" && e.id === "mcp-server-info"),
    ).toBe(false);
  });

  it("contributes nothing when no mcp bridge is present", async () => {
    const { tree } = await mountRender("mcp4", empty(), fakeBridges());
    expect(
      tree.context.entries.some((e) => e.kind === "section" && e.id === "mcp-server-info"),
    ).toBe(false);
  });
});
