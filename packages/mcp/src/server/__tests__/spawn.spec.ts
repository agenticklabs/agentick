/**
 * `spawnStandaloneMcpServer` — Mode A entry-point smoke.
 *
 * Pins the spawn wrapper's ergonomics:
 *  - Accepts `CreatedTool[]` sugar (auto-builds registry + resolver)
 *  - Accepts the harness's full `McpServerToolsOptions` shape
 *  - Synthesizes a substrate, starts the harness, returns a handle
 *    whose `close()` drains everything
 *
 * Adopter API is FLAT — no `config: {}` nesting (post-ADR-40 amendment).
 */

import { describe, expect, it } from "vitest";
import { createTool } from "@agentick/tool";

import { inMemoryServerTransport, spawnStandaloneMcpServer } from "../index.js";

describe("spawnStandaloneMcpServer", () => {
  it("spawns from a CreatedTool[] sugar shape", async () => {
    const transport = inMemoryServerTransport();
    const handle = await spawnStandaloneMcpServer({
      name: "spawn-test",
      transports: [transport],
      tools: [
        createTool({
          name: "echo",
          description: "echo input",
          handler: async () => [{ type: "text", text: "echoed" }],
        }),
      ],
    });
    expect(handle.harness.name).toBe("spawn-test");
    expect(handle.harness.connections()).toHaveLength(0);
    await handle.close();
  });

  it("close() is idempotent + drains the harness", async () => {
    const handle = await spawnStandaloneMcpServer({
      name: "spawn-test",
      transports: [inMemoryServerTransport()],
    });
    await handle.close();
    await handle.close();
  });

  it("accepts the full McpServerToolsOptions shape", async () => {
    const handle = await spawnStandaloneMcpServer({
      name: "raw-tools",
      transports: [inMemoryServerTransport()],
      tools: {
        registry: [],
        resolveHandler: () => null,
      },
    });
    expect(handle.harness.name).toBe("raw-tools");
    await handle.close();
  });

  it("honors scopeId override", async () => {
    const handle = await spawnStandaloneMcpServer({
      scopeId: "srv:pinned",
      name: "x",
      transports: [inMemoryServerTransport()],
    });
    expect(handle.harness.id).toBe("srv:pinned");
    await handle.close();
  });
});
