/**
 * ADR 95 — surfacing components put framework-known context AT A TREE POSITION.
 *
 * The defect these exist for: the `resources` / `mcpServerInfo` default
 * projections are appended after the tree-order stream, so ~35 KB of grounding
 * landed as the final content before generation in a real app. The model
 * continued that document instead of answering — measured twice, and the app's
 * tree had deliberately ordered question-last.
 *
 * Two claims, and both must hold or the escape hatch is useless:
 *
 *   1. Rendering `<Resources />` / `<McpServers />` moves the content to where
 *      it was written — before later tree content.
 *   2. The content is byte-identical to the default. If repositioning silently
 *      changed what the model sees, nobody could use it.
 *
 * (`surfacing.spec.tsx` covers the ADR 63 projection MECHANISM; this covers the
 * ADR 95 components built on it.)
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { fakeBridges } from "@agentick/compiler";
import type { HookBridges } from "@agentick/spec";

import { CompilerHarness } from "../harness/compiler-harness.js";
import { Resources, McpServers } from "../react/components/surfacing.js";

/** Bridges carrying a small resource catalog + one connected MCP server. */
function bridgesWithCatalog(): HookBridges {
  return {
    ...fakeBridges(),
    resources: {
      snapshot: () => ({
        resources: [
          { uri: "app://a", name: "alpha", description: "the first", mimeType: "text/plain" },
          { uri: "app://b", name: "beta", description: "the second" },
        ],
        templates: [],
      }),
    },
    // `withMCP` publishes `{ client, clients }`; each client exposes a sync
    // `serverInfo` snapshot. Shape verified against `readMcpServerInfos` —
    // an invented shape here would have made the test pass vacuously.
    mcp: {
      clients: [
        {
          serverInfo: {
            serverId: "knowify",
            status: { kind: "connected" },
            implementation: { name: "knowify", version: "0.0.4" },
            capabilities: { tools: {}, resources: {} },
          },
        },
      ],
    },
  } as unknown as HookBridges;
}

interface Entry {
  readonly role?: string;
  readonly content: readonly { readonly text?: string }[];
}

async function render(element: React.ReactElement, id: string): Promise<readonly Entry[]> {
  const h = new CompilerHarness(id, new MemoryJournal(), new LocalEventBus(), new LocalInbox());
  await h.ready;
  await h.mount({ mountId: id, sessionId: "s", element, bridges: bridgesWithCatalog() });
  const { tree } = await h.renderTree({ mountId: id, sessionId: "s" });
  return (tree as unknown as { context: { entries: readonly Entry[] } }).context.entries;
}

const textOf = (e: Entry): string => e.content.map((c) => c.text ?? "").join("");

const msg = (role: string, body: string) => React.createElement("message", { role }, body);

describe("ADR 95 — surfacing components", () => {
  it("the DEFAULT lands after the conversation — this is the defect", async () => {
    const entries = await render(
      React.createElement(React.Fragment, null, msg("system", "sys"), msg("user", "the question")),
      "m-default",
    );
    const texts = entries.map(textOf);
    const question = texts.findIndex((t) => t.includes("the question"));
    const catalog = texts.findIndex((t) => t.includes("Readable resources"));

    expect(question).toBeGreaterThanOrEqual(0);
    expect(catalog).toBeGreaterThanOrEqual(0);
    // Framework grounding sits AFTER the user's question, so it is the last
    // thing the model reads before generating.
    expect(catalog).toBeGreaterThan(question);
  });

  it("rendering the component moves it BEFORE the question", async () => {
    const entries = await render(
      React.createElement(
        React.Fragment,
        null,
        msg("system", "sys"),
        React.createElement(Resources, null),
        React.createElement(McpServers, null),
        msg("user", "the question"),
      ),
      "m-placed",
    );
    const texts = entries.map(textOf);
    const question = texts.findIndex((t) => t.includes("the question"));
    const catalog = texts.findIndex((t) => t.includes("Readable resources"));
    const servers = texts.findIndex((t) => t.includes("Connected MCP servers"));

    expect(catalog).toBeGreaterThanOrEqual(0);
    expect(servers).toBeGreaterThanOrEqual(0);
    expect(catalog).toBeLessThan(question);
    expect(servers).toBeLessThan(question);
    // The generation seat belongs to the conversation.
    expect(question).toBe(texts.length - 1);
  });

  it("content is byte-identical to the default — repositioning changes only WHERE", async () => {
    const def = await render(
      React.createElement(React.Fragment, null, msg("system", "sys")),
      "m-bytes-default",
    );
    const placed = await render(
      React.createElement(
        React.Fragment,
        null,
        msg("system", "sys"),
        React.createElement(Resources, null),
        React.createElement(McpServers, null),
      ),
      "m-bytes-placed",
    );
    const pick = (es: readonly Entry[], needle: string) =>
      es.map(textOf).find((t) => t.includes(needle));

    // If these differed, "override to reposition" would silently change what
    // the model sees — which is exactly what makes an escape hatch unusable.
    expect(pick(placed, "Readable resources")).toBe(pick(def, "Readable resources"));
    expect(pick(placed, "Connected MCP servers")).toBe(pick(def, "Connected MCP servers"));
  });

  it("a render prop returning null suppresses the default rather than letting it fire", async () => {
    const entries = await render(
      React.createElement(
        React.Fragment,
        null,
        msg("system", "sys"),
        <Resources>{() => null}</Resources>,
      ),
      "m-suppressed",
    );
    // "I rendered this and chose nothing" must beat "you rendered nothing, so
    // I appended the catalog after your conversation".
    expect(entries.map(textOf).some((t) => t.includes("Readable resources"))).toBe(false);
  });
});
