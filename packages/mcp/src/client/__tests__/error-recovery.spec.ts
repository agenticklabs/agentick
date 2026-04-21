/**
 * Client Error Recovery Tests (C7)
 *
 * Tests configurable tool call timeouts, structured error handling via
 * MCPClientError, and circuit breaker for consistently failing servers.
 */

import { describe, it, expect } from "vitest";
import { MCPClient } from "../client.js";
import { MCPClientError } from "../types.js";
import { MCPServer } from "../../server/server.js";
import { InMemoryTransport } from "../../transport/index.js";
import { z } from "zod";

// ============================================================================
// Helpers
// ============================================================================

async function createPairWithClient(
  tools: any[],
  clientOptions?: ConstructorParameters<typeof MCPClient>[0],
) {
  const server = new MCPServer({ name: "test", version: "1.0.0", tools });
  const client = new MCPClient(clientOptions);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect({
    serverName: "test",
    transport: "in-process",
    connection: { transport: clientTransport },
  });
  return {
    server,
    client,
    cleanup: async () => {
      await client.disconnectAll();
      await server.close();
    },
  };
}

// ============================================================================
// Timeout
// ============================================================================

describe("MCPClient — tool call timeout", () => {
  it("should timeout with MCPClientError when tool exceeds timeoutMs", async () => {
    const { client, cleanup } = await createPairWithClient(
      [
        {
          name: "slow",
          description: "Slow tool",
          inputSchema: z.object({}),
          handler: async () => {
            await new Promise((r) => setTimeout(r, 5000));
            return { content: [{ type: "text" as const, text: "done" }] };
          },
        },
      ],
      { toolCallTimeoutMs: 100 },
    );

    try {
      await client.callTool("test", "slow", {});
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MCPClientError);
      const detail = (err as MCPClientError).detail;
      expect(detail.type).toBe("timeout");
      expect(detail.serverName).toBe("test");
      expect(detail.toolName).toBe("slow");
    }

    await cleanup();
  });

  it("should respect per-call timeoutMs override", async () => {
    const { client, cleanup } = await createPairWithClient(
      [
        {
          name: "medium",
          description: "Medium tool",
          inputSchema: z.object({}),
          handler: async () => {
            await new Promise((r) => setTimeout(r, 5000));
            return { content: [{ type: "text" as const, text: "done" }] };
          },
        },
      ],
      { toolCallTimeoutMs: 60000 }, // default is long
    );

    try {
      await client.callTool("test", "medium", {}, { timeoutMs: 100 }); // override short
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MCPClientError);
      expect((err as MCPClientError).detail.type).toBe("timeout");
    }

    await cleanup();
  });

  it("should NOT timeout when tool completes within timeoutMs", async () => {
    const { client, cleanup } = await createPairWithClient(
      [
        {
          name: "fast",
          description: "Fast tool",
          inputSchema: z.object({}),
          handler: async () => ({
            content: [{ type: "text" as const, text: "quick" }],
          }),
        },
      ],
      { toolCallTimeoutMs: 5000 },
    );

    const result = await client.callTool("test", "fast", {});
    expect(result.content[0].text).toBe("quick");

    await cleanup();
  });
});

// ============================================================================
// Structured Errors
// ============================================================================

describe("MCPClient — structured errors", () => {
  it("should throw MCPClientError with type 'connection_lost' for disconnected server", async () => {
    const { client, server } = await createPairWithClient([
      {
        name: "ping",
        description: "Ping",
        inputSchema: z.object({}),
        handler: async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
      },
    ]);

    await client.disconnect("test");

    try {
      await client.callTool("test", "ping", {});
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MCPClientError);
      expect((err as MCPClientError).detail.type).toBe("connection_lost");
    }

    await server.close();
  });

  it("should throw MCPClientError with type 'server_error' for tool failures", async () => {
    const { client, cleanup } = await createPairWithClient([
      {
        name: "fail",
        description: "Always fails",
        inputSchema: z.object({}),
        handler: async () => {
          throw new Error("Intentional failure");
        },
      },
    ]);

    // Tool errors return as isError content, not thrown — only protocol errors throw
    // So we test with a non-existent tool which triggers a method_not_found error
    try {
      await client.callTool("test", "nonexistent_tool", {});
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MCPClientError);
      const detail = (err as MCPClientError).detail;
      expect(detail.type).toBe("server_error");
      expect(detail.serverName).toBe("test");
      expect(detail.toolName).toBe("nonexistent_tool");
    }

    await cleanup();
  });
});

// ============================================================================
// Circuit Breaker
// ============================================================================

describe("MCPClient — circuit breaker", () => {
  it("should open circuit after failureThreshold consecutive failures", async () => {
    const { client, cleanup } = await createPairWithClient(
      [
        {
          name: "ping",
          description: "Ping",
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
        },
      ],
      {
        circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 5000 },
      },
    );

    // Cause 3 failures by calling a non-existent tool
    for (let i = 0; i < 3; i++) {
      try {
        await client.callTool("test", "nonexistent", {});
      } catch {
        // Expected
      }
    }

    // 4th call should be circuit_open — doesn't even reach the server
    try {
      await client.callTool("test", "ping", {});
      expect.fail("Should have thrown circuit_open");
    } catch (err) {
      expect(err).toBeInstanceOf(MCPClientError);
      expect((err as MCPClientError).detail.type).toBe("circuit_open");
    }

    await cleanup();
  });

  it("should allow probe request after resetTimeoutMs (half-open)", async () => {
    const { client, cleanup } = await createPairWithClient(
      [
        {
          name: "ping",
          description: "Ping",
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
        },
      ],
      {
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 100 },
      },
    );

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      try {
        await client.callTool("test", "nonexistent", {});
      } catch {
        // Expected
      }
    }

    // Verify it's open
    try {
      await client.callTool("test", "ping", {});
      expect.fail("Should be circuit_open");
    } catch (err) {
      expect((err as MCPClientError).detail.type).toBe("circuit_open");
    }

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 150));

    // Half-open: should allow the probe — ping exists and works
    const result = await client.callTool("test", "ping", {});
    expect(result.content[0].text).toBe("pong");

    await cleanup();
  });

  it("should reset failure count on successful call", async () => {
    const { client, cleanup } = await createPairWithClient(
      [
        {
          name: "ping",
          description: "Ping",
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
        },
      ],
      {
        circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 5000 },
      },
    );

    // 2 failures (under threshold)
    for (let i = 0; i < 2; i++) {
      try {
        await client.callTool("test", "nonexistent", {});
      } catch {
        // Expected
      }
    }

    // 1 success — resets counter
    await client.callTool("test", "ping", {});

    // 2 more failures — still under threshold because counter was reset
    for (let i = 0; i < 2; i++) {
      try {
        await client.callTool("test", "nonexistent", {});
      } catch {
        // Expected
      }
    }

    // Should NOT be circuit_open — we only had 2 consecutive failures
    // (the success in the middle reset it)
    try {
      await client.callTool("test", "nonexistent", {});
    } catch (err) {
      // This is the 3rd consecutive failure — NOW it should trip
      expect(err).toBeInstanceOf(MCPClientError);
      expect((err as MCPClientError).detail.type).toBe("server_error");
    }

    await cleanup();
  });

  it("should not use circuit breaker when not configured", async () => {
    const { client, cleanup } = await createPairWithClient([
      {
        name: "ping",
        description: "Ping",
        inputSchema: z.object({}),
        handler: async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
      },
    ]);

    // Many failures — should all be server_error, never circuit_open
    for (let i = 0; i < 10; i++) {
      try {
        await client.callTool("test", "nonexistent", {});
      } catch (err) {
        expect(err).toBeInstanceOf(MCPClientError);
        expect((err as MCPClientError).detail.type).not.toBe("circuit_open");
      }
    }

    // ping should still work
    const result = await client.callTool("test", "ping", {});
    expect(result.content[0].text).toBe("pong");

    await cleanup();
  });
});
