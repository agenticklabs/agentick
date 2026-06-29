/**
 * `spawnStandaloneMcpServer` — Mode A entry-point smoke.
 *
 * The full end-to-end flow (transport mount, projection, request/
 * response) is covered by `end-to-end.spec.ts` against the harness
 * directly. This file pins the spawn wrapper's two ergonomic features:
 *
 *  - Accepts `CreatedTool[]` sugar (auto-builds registry + resolver)
 *  - Synthesizes a substrate, starts the harness, returns a working
 *    handle whose `close()` drains everything
 */

import { describe, expect, it } from "vitest";
import { createTool } from "@agentick/tool-next";

import { inMemoryServerTransport, spawnStandaloneMcpServer } from "../index.js";

describe("spawnStandaloneMcpServer", () => {
  it("spawns from a CreatedTool[] sugar shape", async () => {
    const transport = inMemoryServerTransport();
    const handle = await spawnStandaloneMcpServer({
      config: {
        name: "spawn-test",
        transports: [{ kind: "in-memory" }],
      },
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
      config: {
        name: "spawn-test",
        transports: [{ kind: "in-memory" }],
      },
      transports: [inMemoryServerTransport()],
    });
    await handle.close();
    await handle.close();
    // No expectation beyond "doesn't throw".
  });

  it("accepts the harness-raw { registry, resolveHandler } tools shape", async () => {
    const handle = await spawnStandaloneMcpServer({
      config: {
        name: "raw-tools",
        transports: [{ kind: "in-memory" }],
      },
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
      config: {
        name: "x",
        transports: [{ kind: "in-memory" }],
      },
      transports: [inMemoryServerTransport()],
    });
    expect(handle.harness.id).toBe("srv:pinned");
    await handle.close();
  });
});
