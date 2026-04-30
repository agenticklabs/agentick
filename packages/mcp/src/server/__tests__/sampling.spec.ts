/**
 * Phase 4 — Sampling
 *
 * Tests `MCPServer.requestSampling()` outbound primitive and the
 * `ctx.sample.*` sugar surface — text, message, structured, image,
 * audio, withTools (spec-defined tool-use loop).
 *
 * Adversarial: capability gating, includeContext scrubbing, structured
 * retry exhaustion, tool-loop iteration bound, toolUseId matching,
 * tool-results-only constraint, unknown tool name, handler errors.
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { InMemoryTransport } from "../../transport/index.js";
import { MCPServer, SessionNotFoundError } from "../server.js";
import type { MCPToolDefinition, SamplingResult } from "../../protocol/types.js";

// ============================================================================
// Helpers
// ============================================================================

interface SetupOpts {
  /** Client capabilities object — pass `false` to omit `sampling` entirely. */
  capabilities?: Record<string, unknown> | false;
  /** Optional handler for sampling/createMessage. */
  samplingHandler?: (params: any) => Promise<any>;
  tools?: MCPToolDefinition[];
}

async function setup(opts: SetupOpts = {}): Promise<{
  server: MCPServer;
  client: Client;
  sessionId: string;
  cleanup: () => Promise<void>;
}> {
  const server = new MCPServer({
    name: "sampling-test",
    version: "1.0.0",
    tools: opts.tools,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const caps = opts.capabilities === false ? {} : (opts.capabilities ?? { sampling: {} });
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: caps });

  if (opts.samplingHandler) {
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      return opts.samplingHandler!(request.params);
    });
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

/** Exec a tool that captures `ctx.sample` for downstream assertions. */
async function captureSampleAPI<T>(
  opts: SetupOpts,
  fn: (api: import("../../protocol/types.js").SampleAPI | undefined) => Promise<T>,
): Promise<T> {
  let captured!: T;
  let handlerError: unknown = null;
  const tool: MCPToolDefinition = {
    name: "probe",
    inputSchema: {},
    handler: async (_input, ctx) => {
      try {
        captured = await fn(ctx.sample);
      } catch (err) {
        handlerError = err;
        throw err;
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  };

  const { client, cleanup } = await setup({ ...opts, tools: [tool] });
  const result = await client.callTool({ name: "probe", arguments: {} });
  await cleanup();

  if (handlerError) throw handlerError;
  if (result.isError) {
    const text = (result.content as Array<{ text?: string }>)[0]?.text;
    throw new Error(`tool error: ${text}`);
  }
  return captured;
}

// ============================================================================
// MCPServer.requestSampling — outbound primitive
// ============================================================================

describe("MCPServer.requestSampling — outbound primitive", () => {
  it("issues sampling/createMessage and returns the SamplingResult", async () => {
    const { server, sessionId, cleanup } = await setup({
      capabilities: { sampling: {} },
      samplingHandler: async () => ({
        role: "assistant",
        content: { type: "text", text: "hello back" },
        model: "test-model-1",
        stopReason: "endTurn",
      }),
    });

    const result: SamplingResult = await server.requestSampling(sessionId, {
      messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      maxTokens: 50,
    });

    expect(result.role).toBe("assistant");
    expect(result.model).toBe("test-model-1");
    expect(result.stopReason).toBe("endTurn");
    expect(Array.isArray(result.content) ? result.content[0] : result.content).toMatchObject({
      type: "text",
      text: "hello back",
    });

    await cleanup();
  });

  it("throws SessionNotFoundError for unknown session", async () => {
    const { server, cleanup } = await setup({ capabilities: { sampling: {} } });
    await expect(
      server.requestSampling("ghost", {
        messages: [{ role: "user", content: { type: "text", text: "x" } }],
        maxTokens: 10,
      }),
    ).rejects.toThrow(SessionNotFoundError);
    await cleanup();
  });

  it("propagates timeout when client never responds", async () => {
    const { server, sessionId, cleanup } = await setup({
      capabilities: { sampling: {} },
      samplingHandler: () =>
        new Promise(() => {
          /* hang */
        }),
    });

    await expect(
      server.requestSampling(
        sessionId,
        {
          messages: [{ role: "user", content: { type: "text", text: "x" } }],
          maxTokens: 10,
        },
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow(/timed out|timeout/i);

    await cleanup();
  });
});

// ============================================================================
// ctx.sample — capability gating
// ============================================================================

describe("ctx.sample — capability gating", () => {
  it("ctx.sample is undefined when client did not advertise sampling", async () => {
    const out = await captureSampleAPI({ capabilities: false }, async (api) => api);
    expect(out).toBeUndefined();
  });

  it("ctx.sample is defined when client advertised sampling: {}", async () => {
    const out = await captureSampleAPI({ capabilities: { sampling: {} } }, async (api) => api);
    expect(out).toBeDefined();
    expect(typeof out!.text).toBe("function");
    expect(typeof out!.message).toBe("function");
    expect(typeof out!.structured).toBe("function");
    expect(typeof out!.withTools).toBe("function");
  });

  it("canUseTools is false when client only advertises basic sampling", async () => {
    const out = await captureSampleAPI({ capabilities: { sampling: {} } }, async (api) =>
      api!.canUseTools(),
    );
    expect(out).toBe(false);
  });

  it("canUseTools is true when client advertises sampling.tools", async () => {
    const out = await captureSampleAPI({ capabilities: { sampling: { tools: {} } } }, async (api) =>
      api!.canUseTools(),
    );
    expect(out).toBe(true);
  });

  it("canIncludeContext gates on sampling.context sub-capability", async () => {
    const without = await captureSampleAPI({ capabilities: { sampling: {} } }, async (api) =>
      api!.canIncludeContext(),
    );
    expect(without).toBe(false);

    const withCtx = await captureSampleAPI(
      { capabilities: { sampling: { context: {} } } },
      async (api) => api!.canIncludeContext(),
    );
    expect(withCtx).toBe(true);
  });
});

// ============================================================================
// ctx.sample.text — simplest sugar
// ============================================================================

describe("ctx.sample.text", () => {
  it("returns plain text from a simple prompt", async () => {
    let received: any = null;
    const out = await captureSampleAPI(
      {
        capabilities: { sampling: {} },
        samplingHandler: async (params) => {
          received = params;
          return {
            role: "assistant",
            content: { type: "text", text: "summarized" },
            model: "m",
            stopReason: "endTurn",
          };
        },
      },
      async (api) => api!.text("Summarize this", { maxTokens: 100 }),
    );

    expect(out).toBe("summarized");
    expect(received.messages).toHaveLength(1);
    expect(received.messages[0].role).toBe("user");
    expect(received.maxTokens).toBe(100);
  });

  it("works without explicit maxTokens (sugar applies a sensible default)", async () => {
    const out = await captureSampleAPI(
      {
        capabilities: { sampling: {} },
        samplingHandler: async () => ({
          role: "assistant",
          content: { type: "text", text: "ok" },
          model: "m",
          stopReason: "endTurn",
        }),
      },
      async (api) => api!.text("hi"),
    );
    expect(out).toBe("ok");
  });
});

// ============================================================================
// ctx.sample.message — full control
// ============================================================================

describe("ctx.sample.message", () => {
  it("passes messages and systemPrompt through", async () => {
    let received: any = null;
    await captureSampleAPI(
      {
        capabilities: { sampling: {} },
        samplingHandler: async (params) => {
          received = params;
          return {
            role: "assistant",
            content: { type: "text", text: "ack" },
            model: "m",
            stopReason: "endTurn",
          };
        },
      },
      async (api) =>
        api!.message({
          messages: [
            { role: "user", content: { type: "text", text: "first" } },
            { role: "assistant", content: { type: "text", text: "first reply" } },
            { role: "user", content: { type: "text", text: "second" } },
          ],
          systemPrompt: "You are a helper",
          maxTokens: 200,
        }),
    );

    expect(received.messages).toHaveLength(3);
    expect(received.systemPrompt).toBe("You are a helper");
  });

  it("scrubs includeContext when client lacks sampling.context", async () => {
    let received: any = null;
    await captureSampleAPI(
      {
        capabilities: { sampling: {} },
        samplingHandler: async (params) => {
          received = params;
          return {
            role: "assistant",
            content: { type: "text", text: "" },
            model: "m",
          };
        },
      },
      async (api) =>
        api!.message({
          messages: [{ role: "user", content: { type: "text", text: "x" } }],
          maxTokens: 10,
          includeContext: "thisServer",
        }),
    );

    // includeContext should have been removed (or "none") to avoid sending an
    // option the client did not advertise support for.
    expect(received.includeContext).toBeUndefined();
  });

  it("preserves includeContext when client advertises sampling.context", async () => {
    let received: any = null;
    await captureSampleAPI(
      {
        capabilities: { sampling: { context: {} } },
        samplingHandler: async (params) => {
          received = params;
          return {
            role: "assistant",
            content: { type: "text", text: "" },
            model: "m",
          };
        },
      },
      async (api) =>
        api!.message({
          messages: [{ role: "user", content: { type: "text", text: "x" } }],
          maxTokens: 10,
          includeContext: "thisServer",
        }),
    );

    expect(received.includeContext).toBe("thisServer");
  });
});

// ============================================================================
// ctx.sample.structured — Zod-validated JSON output with auto-retry
// ============================================================================

describe("ctx.sample.structured", () => {
  it("returns parsed value typed by the schema", async () => {
    const out = await captureSampleAPI(
      {
        capabilities: { sampling: {} },
        samplingHandler: async () => ({
          role: "assistant",
          content: { type: "text", text: '{"total":42,"status":"open"}' },
          model: "m",
          stopReason: "endTurn",
        }),
      },
      async (api) =>
        api!.structured("Return JSON", {
          schema: z.object({ total: z.number(), status: z.enum(["open", "closed"]) }),
          maxTokens: 100,
        }),
    );

    expect(out).toEqual({ total: 42, status: "open" });
  });

  it("retries on JSON parse failure", async () => {
    let attempt = 0;
    const out = await captureSampleAPI(
      {
        capabilities: { sampling: {} },
        samplingHandler: async () => {
          attempt++;
          if (attempt === 1) {
            return {
              role: "assistant",
              content: { type: "text", text: "this is not json" },
              model: "m",
              stopReason: "endTurn",
            };
          }
          return {
            role: "assistant",
            content: { type: "text", text: '{"value":"ok"}' },
            model: "m",
            stopReason: "endTurn",
          };
        },
      },
      async (api) =>
        api!.structured("Return JSON", {
          schema: z.object({ value: z.string() }),
          maxTokens: 50,
          maxRetries: 2,
        }),
    );

    expect(out).toEqual({ value: "ok" });
    expect(attempt).toBe(2);
  });

  it("retries on Zod validation failure", async () => {
    let attempt = 0;
    const out = await captureSampleAPI(
      {
        capabilities: { sampling: {} },
        samplingHandler: async () => {
          attempt++;
          if (attempt === 1) {
            return {
              role: "assistant",
              content: { type: "text", text: '{"count":"not-a-number"}' },
              model: "m",
              stopReason: "endTurn",
            };
          }
          return {
            role: "assistant",
            content: { type: "text", text: '{"count":7}' },
            model: "m",
            stopReason: "endTurn",
          };
        },
      },
      async (api) =>
        api!.structured("Return JSON", {
          schema: z.object({ count: z.number() }),
          maxTokens: 50,
          maxRetries: 2,
        }),
    );

    expect(out).toEqual({ count: 7 });
    expect(attempt).toBe(2);
  });

  it("throws after maxRetries exhausted", async () => {
    let attempt = 0;
    await expect(
      captureSampleAPI(
        {
          capabilities: { sampling: {} },
          samplingHandler: async () => {
            attempt++;
            return {
              role: "assistant",
              content: { type: "text", text: "still not json" },
              model: "m",
              stopReason: "endTurn",
            };
          },
        },
        async (api) =>
          api!.structured("Return JSON", {
            schema: z.object({ x: z.string() }),
            maxTokens: 50,
            maxRetries: 2,
          }),
      ),
    ).rejects.toThrow(/parse|invalid|exhausted|structured/i);

    expect(attempt).toBe(3); // initial + 2 retries
  });

  it("extracts JSON from a fenced code block", async () => {
    const out = await captureSampleAPI(
      {
        capabilities: { sampling: {} },
        samplingHandler: async () => ({
          role: "assistant",
          content: {
            type: "text",
            text: 'Here is the result:\n\n```json\n{"answer":42}\n```',
          },
          model: "m",
          stopReason: "endTurn",
        }),
      },
      async (api) =>
        api!.structured("Return JSON", {
          schema: z.object({ answer: z.number() }),
          maxTokens: 50,
        }),
    );

    expect(out).toEqual({ answer: 42 });
  });
});

// ============================================================================
// ctx.sample.image / .audio
// ============================================================================

describe("ctx.sample.image", () => {
  it("returns image content block when host model produces one", async () => {
    const out = await captureSampleAPI(
      {
        capabilities: { sampling: {} },
        samplingHandler: async () => ({
          role: "assistant",
          content: { type: "image", data: "BASE64IMAGE", mimeType: "image/png" },
          model: "m",
          stopReason: "endTurn",
        }),
      },
      async (api) => api!.image({ prompt: "draw a cat" }),
    );

    expect(out.data).toBe("BASE64IMAGE");
    expect(out.mimeType).toBe("image/png");
  });

  it("throws when the response has no image content", async () => {
    await expect(
      captureSampleAPI(
        {
          capabilities: { sampling: {} },
          samplingHandler: async () => ({
            role: "assistant",
            content: { type: "text", text: "I can't make images" },
            model: "m",
            stopReason: "endTurn",
          }),
        },
        async (api) => api!.image({ prompt: "draw a cat" }),
      ),
    ).rejects.toThrow(/image|content/i);
  });
});

describe("ctx.sample.audio", () => {
  it("returns audio content block when host model produces one", async () => {
    const out = await captureSampleAPI(
      {
        capabilities: { sampling: {} },
        samplingHandler: async () => ({
          role: "assistant",
          content: { type: "audio", data: "BASE64AUDIO", mimeType: "audio/mpeg" },
          model: "m",
          stopReason: "endTurn",
        }),
      },
      async (api) => api!.audio({ prompt: "speak hello" }),
    );

    expect(out.data).toBe("BASE64AUDIO");
    expect(out.mimeType).toBe("audio/mpeg");
  });

  it("throws when the response has no audio content", async () => {
    await expect(
      captureSampleAPI(
        {
          capabilities: { sampling: {} },
          samplingHandler: async () => ({
            role: "assistant",
            content: { type: "text", text: "no audio" },
            model: "m",
            stopReason: "endTurn",
          }),
        },
        async (api) => api!.audio({ prompt: "speak hello" }),
      ),
    ).rejects.toThrow(/audio|content/i);
  });
});

// ============================================================================
// ctx.sample.withTools — spec-defined tool-use loop
// ============================================================================

describe("ctx.sample.withTools — tool-use loop", () => {
  it("single round-trip when model returns no tool_use", async () => {
    const out = await captureSampleAPI(
      {
        capabilities: { sampling: { tools: {} } },
        samplingHandler: async () => ({
          role: "assistant",
          content: [{ type: "text", text: "no tools needed" }],
          model: "m",
          stopReason: "endTurn",
        }),
      },
      async (api) =>
        api!.withTools({
          prompt: "do thing",
          tools: [
            {
              name: "search",
              description: "search",
              input: z.object({ q: z.string() }),
              handler: async () => ({ results: [] }),
            },
          ],
        }),
    );

    expect(out.finalText).toBe("no tools needed");
    expect(out.toolCalls).toEqual([]);
  });

  it("invokes the tool handler and feeds tool_result back", async () => {
    let turn = 0;
    let receivedSecondMessages: any[] | null = null;

    const out = await captureSampleAPI(
      {
        capabilities: { sampling: { tools: {} } },
        samplingHandler: async (params) => {
          turn++;
          if (turn === 1) {
            return {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call-1",
                  name: "search",
                  input: { q: "anything" },
                },
              ],
              model: "m",
              stopReason: "toolUse",
            };
          }
          // turn 2: tool_result fed back
          receivedSecondMessages = params.messages;
          return {
            role: "assistant",
            content: [{ type: "text", text: "search returned 3 hits" }],
            model: "m",
            stopReason: "endTurn",
          };
        },
      },
      async (api) =>
        api!.withTools({
          prompt: "find things",
          tools: [
            {
              name: "search",
              description: "search",
              input: z.object({ q: z.string() }),
              handler: async (input: any) => ({ hits: [`for-${input.q}`] }),
            },
          ],
        }),
    );

    expect(out.finalText).toBe("search returned 3 hits");
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toMatchObject({ name: "search", input: { q: "anything" } });

    // Verify the second-turn message contains a tool_result with matching id
    expect(receivedSecondMessages).toBeTruthy();
    const lastMsg = receivedSecondMessages![receivedSecondMessages!.length - 1];
    expect(lastMsg.role).toBe("user");
    const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : [lastMsg.content];
    const toolResultBlocks = blocks.filter((b: any) => b.type === "tool_result");
    expect(toolResultBlocks).toHaveLength(1);
    expect(toolResultBlocks[0].toolUseId).toBe("call-1");
  });

  it("tool-result-only message constraint — no mixed content", async () => {
    let turn = 0;
    let receivedSecondMessages: any[] | null = null;

    await captureSampleAPI(
      {
        capabilities: { sampling: { tools: {} } },
        samplingHandler: async (params) => {
          turn++;
          if (turn === 1) {
            return {
              role: "assistant",
              content: [
                { type: "text", text: "let me check" },
                {
                  type: "tool_use",
                  id: "call-x",
                  name: "ping",
                  input: {},
                },
              ],
              model: "m",
              stopReason: "toolUse",
            };
          }
          receivedSecondMessages = params.messages;
          return {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            model: "m",
            stopReason: "endTurn",
          };
        },
      },
      async (api) =>
        api!.withTools({
          prompt: "go",
          tools: [
            {
              name: "ping",
              description: "ping",
              input: z.object({}),
              handler: async () => "pong",
            },
          ],
        }),
    );

    const lastMsg = receivedSecondMessages![receivedSecondMessages!.length - 1];
    const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : [lastMsg.content];
    // Per spec: a user message containing tool results MUST contain ONLY tool results.
    const allToolResults = blocks.every((b: any) => b.type === "tool_result");
    expect(allToolResults).toBe(true);
  });

  it("multiple tool_use blocks in one assistant turn — all get matched results", async () => {
    let turn = 0;
    let secondMessages: any[] | null = null;

    const out = await captureSampleAPI(
      {
        capabilities: { sampling: { tools: {} } },
        samplingHandler: async (params) => {
          turn++;
          if (turn === 1) {
            return {
              role: "assistant",
              content: [
                { type: "tool_use", id: "a", name: "n", input: { i: 1 } },
                { type: "tool_use", id: "b", name: "n", input: { i: 2 } },
                { type: "tool_use", id: "c", name: "n", input: { i: 3 } },
              ],
              model: "m",
              stopReason: "toolUse",
            };
          }
          secondMessages = params.messages;
          return {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            model: "m",
            stopReason: "endTurn",
          };
        },
      },
      async (api) =>
        api!.withTools({
          prompt: "go",
          tools: [
            {
              name: "n",
              description: "noop",
              input: z.object({ i: z.number() }),
              handler: async (input: any) => ({ doubled: input.i * 2 }),
            },
          ],
        }),
    );

    expect(out.toolCalls).toHaveLength(3);

    const lastMsg = secondMessages![secondMessages!.length - 1];
    const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : [lastMsg.content];
    const ids = blocks.map((b: any) => b.toolUseId).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("respects maxIterations bound", async () => {
    let turn = 0;
    await expect(
      captureSampleAPI(
        {
          capabilities: { sampling: { tools: {} } },
          samplingHandler: async () => {
            turn++;
            // Always return a tool_use → loop never terminates organically
            return {
              role: "assistant",
              content: [{ type: "tool_use", id: `t-${turn}`, name: "n", input: {} }],
              model: "m",
              stopReason: "toolUse",
            };
          },
        },
        async (api) =>
          api!.withTools({
            prompt: "go",
            tools: [
              {
                name: "n",
                description: "n",
                input: z.object({}),
                handler: async () => "ok",
              },
            ],
            maxIterations: 3,
          }),
      ),
    ).rejects.toThrow(/maxIterations|iteration|exhausted/i);

    expect(turn).toBeLessThanOrEqual(4);
  });

  it("unknown tool name in tool_use produces a clear error to the model (not a crash)", async () => {
    // Spec doesn't strictly say what to do, but the cleanest behavior is
    // to surface an error tool_result back so the model can self-correct.
    let turn = 0;
    let secondMessages: any[] | null = null;

    await captureSampleAPI(
      {
        capabilities: { sampling: { tools: {} } },
        samplingHandler: async (params) => {
          turn++;
          if (turn === 1) {
            return {
              role: "assistant",
              content: [{ type: "tool_use", id: "ghost", name: "does-not-exist", input: {} }],
              model: "m",
              stopReason: "toolUse",
            };
          }
          secondMessages = params.messages;
          return {
            role: "assistant",
            content: [{ type: "text", text: "I'll stop" }],
            model: "m",
            stopReason: "endTurn",
          };
        },
      },
      async (api) =>
        api!.withTools({
          prompt: "x",
          tools: [
            {
              name: "real",
              description: "x",
              input: z.object({}),
              handler: async () => "ok",
            },
          ],
        }),
    );

    const lastMsg = secondMessages![secondMessages!.length - 1];
    const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : [lastMsg.content];
    const errorResult = blocks.find(
      (b: any) => b.type === "tool_result" && b.toolUseId === "ghost",
    );
    expect(errorResult).toBeDefined();
    expect(errorResult.isError).toBe(true);
  });

  it("handler that throws is surfaced as an error tool_result (not a crash)", async () => {
    let turn = 0;
    let secondMessages: any[] | null = null;

    await captureSampleAPI(
      {
        capabilities: { sampling: { tools: {} } },
        samplingHandler: async (params) => {
          turn++;
          if (turn === 1) {
            return {
              role: "assistant",
              content: [{ type: "tool_use", id: "t1", name: "fail", input: {} }],
              model: "m",
              stopReason: "toolUse",
            };
          }
          secondMessages = params.messages;
          return {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            model: "m",
            stopReason: "endTurn",
          };
        },
      },
      async (api) =>
        api!.withTools({
          prompt: "x",
          tools: [
            {
              name: "fail",
              description: "fail",
              input: z.object({}),
              handler: async () => {
                throw new Error("specific handler error");
              },
            },
          ],
        }),
    );

    const lastMsg = secondMessages![secondMessages!.length - 1];
    const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : [lastMsg.content];
    const result = blocks.find((b: any) => b.type === "tool_result" && b.toolUseId === "t1");
    expect(result.isError).toBe(true);
    const txt = Array.isArray(result.content)
      ? (result.content[0] as any).text
      : (result.content as any).text;
    expect(txt).toMatch(/specific handler error/);
  });

  it("throws typed CapabilityNotSupported when client lacks sampling.tools", async () => {
    await expect(
      captureSampleAPI(
        {
          capabilities: { sampling: {} },
          samplingHandler: async () => ({
            role: "assistant",
            content: [{ type: "text", text: "" }],
            model: "m",
          }),
        },
        async (api) =>
          api!.withTools({
            prompt: "x",
            tools: [
              { name: "n", description: "n", input: z.object({}), handler: async () => "ok" },
            ],
          }),
      ),
    ).rejects.toThrow(/sampling\.tools|capability/i);
  });
});
