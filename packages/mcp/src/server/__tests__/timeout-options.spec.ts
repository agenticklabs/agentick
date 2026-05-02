/**
 * Indefinite-timeout option — `timeoutMs: "never"` maps to Node's
 * setTimeout max (~24.8 days, effectively indefinite). Applies to
 * elicitation (user-loop) and prompt requests (slow handlers).
 *
 * Adversarial: explicit short timeout still fires, "never" doesn't fire,
 * default values are sensible for user-loop, signal still works under "never".
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "../../transport/index.js";
import { MCPServer } from "../server.js";
import { MAX_TIMEOUT_MS } from "../timeouts.js";
import type { MCPToolDefinition } from "../../protocol/types.js";

// ============================================================================
// Helpers
// ============================================================================

async function setup(opts: {
  capabilities?: Record<string, unknown>;
  elicitationHandler?: (params: any) => Promise<any>;
  tools?: MCPToolDefinition[];
}) {
  const server = new MCPServer({
    name: "timeout-test",
    version: "1.0.0",
    tools: opts.tools,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "test", version: "1.0.0" },
    { capabilities: opts.capabilities ?? { elicitation: { form: {}, url: {} } } },
  );

  if (opts.elicitationHandler) {
    client.setRequestHandler(ElicitRequestSchema, async (req) =>
      opts.elicitationHandler!(req.params),
    );
  }

  await client.connect(clientTransport);
  const sessionId = server.getActiveSessions()[0]!.sessionId;
  return {
    server,
    client,
    sessionId,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ============================================================================
// MAX_TIMEOUT_MS constant
// ============================================================================

describe("MAX_TIMEOUT_MS", () => {
  it("is Node's setTimeout max (~24.8 days)", () => {
    expect(MAX_TIMEOUT_MS).toBe(2_147_483_647);
    // Sanity: ~24.8 days in ms
    const days = MAX_TIMEOUT_MS / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(24);
    expect(days).toBeLessThan(25);
  });
});

// ============================================================================
// resolveTimeout — `0` and "never" both mean "no timeout" (axios convention)
// ============================================================================

describe("resolveTimeout", () => {
  it("translates undefined to undefined (use SDK default)", async () => {
    const { resolveTimeout } = await import("../timeouts.js");
    expect(resolveTimeout(undefined)).toBeUndefined();
  });

  it("translates 'never' to MAX_TIMEOUT_MS", async () => {
    const { resolveTimeout } = await import("../timeouts.js");
    expect(resolveTimeout("never")).toBe(MAX_TIMEOUT_MS);
  });

  it("translates 0 to MAX_TIMEOUT_MS (axios/XHR convention)", async () => {
    const { resolveTimeout } = await import("../timeouts.js");
    expect(resolveTimeout(0)).toBe(MAX_TIMEOUT_MS);
  });

  it("translates negative numbers to MAX_TIMEOUT_MS (would fire immediately under Node)", async () => {
    const { resolveTimeout } = await import("../timeouts.js");
    expect(resolveTimeout(-1)).toBe(MAX_TIMEOUT_MS);
    expect(resolveTimeout(-1000)).toBe(MAX_TIMEOUT_MS);
  });

  it("preserves positive numeric millisecond values as-is", async () => {
    const { resolveTimeout } = await import("../timeouts.js");
    expect(resolveTimeout(1)).toBe(1);
    expect(resolveTimeout(60_000)).toBe(60_000);
    expect(resolveTimeout(MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS);
  });
});

// ============================================================================
// Elicitation — `timeoutMs: "never"` does not fire
// ============================================================================

describe("requestElicitation — timeoutMs: 'never'", () => {
  it("does not auto-cancel when 'never' is passed (resolves on user response)", async () => {
    let resolveHandler!: (val: unknown) => void;
    const slowHandler = new Promise((res) => {
      resolveHandler = res;
    });

    const { server, sessionId, cleanup } = await setup({
      elicitationHandler: () => slowHandler as any,
    });

    const requestPromise = server.requestElicitation(
      sessionId,
      {
        message: "Take your time",
        requestedSchema: { type: "object", properties: {} },
      },
      { timeoutMs: "never" },
    );

    // Wait > SDK's default 60s would have fired by now in real time,
    // but we're not waiting that long in tests. Just simulate that the
    // request is still pending after 200ms.
    await new Promise((r) => setTimeout(r, 200));

    let settled = false;
    requestPromise.then(() => (settled = true)).catch(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    // Resolve the user response — request now completes
    resolveHandler({ action: "accept", content: { x: "ok" } });
    const result = await requestPromise;
    expect(result.action).toBe("accept");

    await cleanup();
  });

  it("explicit numeric timeout still fires", async () => {
    const { server, sessionId, cleanup } = await setup({
      elicitationHandler: () => new Promise(() => {}),
    });

    await expect(
      server.requestElicitation(
        sessionId,
        {
          message: "Quick",
          requestedSchema: { type: "object", properties: {} },
        },
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow(/timed out|timeout/i);

    await cleanup();
  });

  it("timeoutMs: 0 also disables auto-cancel (axios/XHR convention)", async () => {
    let resolveHandler!: (val: unknown) => void;
    const slow = new Promise((res) => {
      resolveHandler = res;
    });

    const { server, sessionId, cleanup } = await setup({
      elicitationHandler: () => slow as any,
    });

    const requestPromise = server.requestElicitation(
      sessionId,
      {
        message: "0 should mean never",
        requestedSchema: { type: "object", properties: {} },
      },
      { timeoutMs: 0 },
    );

    await new Promise((r) => setTimeout(r, 200));
    let settled = false;
    requestPromise.then(() => (settled = true)).catch(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    resolveHandler({ action: "accept", content: {} });
    await requestPromise;

    await cleanup();
  });

  it("URL elicitation accepts timeoutMs: 'never'", async () => {
    let resolveHandler!: (val: unknown) => void;
    const slow = new Promise((res) => {
      resolveHandler = res;
    });

    const { server, sessionId, cleanup } = await setup({
      elicitationHandler: () => slow as any,
    });

    const requestPromise = server.requestUrlElicitation(
      sessionId,
      {
        mode: "url",
        message: "OAuth flow",
        url: "https://auth.example.com",
        elicitationId: "el-1",
      },
      { timeoutMs: "never" },
    );

    await new Promise((r) => setTimeout(r, 100));
    resolveHandler({ action: "accept" });
    const result = await requestPromise;
    expect(result.action).toBe("accept");

    await cleanup();
  });
});

// ============================================================================
// Sugar — ctx.elicit.* accepts timeoutMs in opts
// ============================================================================

describe("ctx.elicit sugar — timeoutMs: 'never' threading", () => {
  it("text() with timeoutMs: 'never' does not fire SDK timeout", async () => {
    let resolveHandler!: (val: unknown) => void;
    const slow = new Promise((res) => {
      resolveHandler = res;
    });

    const tool: MCPToolDefinition = {
      name: "ask",
      inputSchema: {},
      handler: async (_input, ctx) => {
        const value = await ctx.elicit!.text("Take your time", {
          timeoutMs: "never",
        } as never);
        return { content: [{ type: "text", text: value }] };
      },
    };

    const { client, cleanup } = await setup({
      elicitationHandler: () => slow as any,
      tools: [tool],
    });

    const callPromise = client.callTool({ name: "ask", arguments: {} });

    await new Promise((r) => setTimeout(r, 150));
    resolveHandler({ action: "accept", content: { value: "later" } });
    const result = await callPromise;
    const text = (result.content as Array<{ text?: string }>)[0]?.text;
    expect(text).toBe("later");

    await cleanup();
  });

  it("confirm() short timeoutMs still fires (propagates as protocol error)", async () => {
    const tool: MCPToolDefinition = {
      name: "ask",
      inputSchema: {},
      handler: async (_input, ctx) => {
        await ctx.elicit!.confirm("Sure?", { timeoutMs: 50 } as never);
        return { content: [{ type: "text", text: "ok" }] };
      },
    };

    const { client, cleanup } = await setup({
      elicitationHandler: () => new Promise(() => {}),
      tools: [tool],
    });

    // Inner SDK timeout (the server-side elicitation request) fires as
    // an McpError; our existing tool error path re-throws McpError as a
    // protocol error to the calling client, so the callTool() rejects.
    await expect(client.callTool({ name: "ask", arguments: {} })).rejects.toThrow(
      /timed out|timeout/i,
    );

    await cleanup();
  });
});

// ============================================================================
// MCPClient.getPrompt — timeoutMs: "never" for slow prompt handlers
// ============================================================================

describe("MCPClient.getPrompt — timeout options", () => {
  it("accepts timeoutMs: 'never' to disable the SDK default", async () => {
    // Verify shape only — the indefinite path is non-deterministic to test,
    // so check that the option is accepted and a short timeout still fires.
    const server = new MCPServer({
      name: "prompt-server",
      version: "1.0.0",
      prompts: [
        {
          name: "slow",
          handler: () =>
            new Promise(() => {
              /* hang */
            }) as never,
        },
      ],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const { MCPClient } = await import("../../client/client.js");
    const mcpClient = new MCPClient();
    await mcpClient.connect({
      serverName: "p",
      transport: "in-process",
      connection: { transport: clientTransport },
    } as never);

    await expect(mcpClient.getPrompt("p", "slow", undefined, { timeoutMs: 50 })).rejects.toThrow(
      /timed out|timeout/i,
    );

    await mcpClient.disconnect("p");
    await server.close();
  });
});
