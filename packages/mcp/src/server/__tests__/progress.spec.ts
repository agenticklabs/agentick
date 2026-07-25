/**
 * MCP progress projection + client-token correlation (ADR 64 / A1) —
 * `ctx.progress` → bus → `installProgressProjection` →
 * `notifications/progress`, correlated to the CLIENT's request token.
 *
 * Real in-memory server↔client round-trip. A dispatched tool reads the
 * client-supplied `_meta.progressToken` off `ctx.mcp.progressToken` and
 * passes it to `ctx.progress(...)`; the per-connection progress
 * projection forwards the resulting bus event to the wire, echoing that
 * exact token. Two independent proofs of correlation:
 *
 *   1. Explicit token + wire capture — the client sets
 *      `_meta.progressToken` itself; the test overrides the SDK
 *      notification handler and asserts the wire `progressToken` is that
 *      exact value (deterministic token equality).
 *   2. Real SDK `onprogress` — the client passes `onprogress`; the SDK
 *      auto-generates a token, threads it, and (because the server
 *      echoes it back) correlates the notification to THIS request,
 *      firing `onprogress`. `onprogress` firing at all is the
 *      correlation proof — a wrong echoed token would never route.
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type { ContentBlock, ProgressToken, ToolDeclaration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import {
  inMemoryServerTransport,
  McpServerHarness,
  type McpServerOptions,
  type ToolHandlerResolver,
} from "../index.js";

async function makeConnectedClient(options: Omit<McpServerOptions, "transports">): Promise<{
  readonly client: McpClient;
  readonly cleanup: () => Promise<void>;
}> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    `srv:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { transports: [transport], serverInfo: { name: "test", version: "0.0.0" }, ...options },
  );
  await harness.ready;
  await harness.start();
  const clientTransport = await transport.connect();
  const client = new McpClient({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await harness.close();
    },
  };
}

function progressToolDeclaration(): ToolDeclaration {
  return {
    id: "do_work",
    name: "do_work",
    description: "emits progress correlated to the client's request token",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    exposure: ["model"],
    handlerRef: "handler:do_work",
  };
}

/**
 * Captures the token the handler observed on `ctx.mcp.progressToken`, so
 * a test can assert the server-side thread-through independently of the
 * wire echo. Reset per test via the closure.
 */
function makeResolver(seen: { token: ProgressToken | undefined }): ToolHandlerResolver {
  return (ref) => {
    if (ref !== "handler:do_work") return null;
    return async (_input, ctx) => {
      // A1 — the client's `_meta.progressToken` for THIS call is on
      // `ctx.mcp.progressToken`. Correlate by passing it straight to
      // `ctx.progress`.
      seen.token = ctx.mcp?.progressToken;
      const token = ctx.mcp!.progressToken!;
      ctx.progress(token, { progress: 1, total: 3, message: "step 1" });
      ctx.progress(token, { progress: 3, total: 3 });
      const content: ContentBlock[] = [{ type: "text", text: "done" }];
      return { kind: "inline", content };
    };
  };
}

describe("progress projection — client-token correlation (ADR 64 / A1)", () => {
  it("echoes the client's explicit _meta.progressToken on the wire (token equality)", async () => {
    const seen: { token: ProgressToken | undefined } = { token: undefined };
    const { client, cleanup } = await makeConnectedClient({
      name: "prog-explicit",
      tools: { registry: [progressToolDeclaration()], resolveHandler: makeResolver(seen) },
    });
    const received: Array<{
      progressToken: unknown;
      progress: number;
      total?: number;
      message?: string;
    }> = [];
    client.setNotificationHandler(ProgressNotificationSchema, async (n) => {
      received.push({
        progressToken: n.params.progressToken,
        progress: n.params.progress,
        total: n.params.total,
        message: n.params.message,
      });
    });

    const CLIENT_TOKEN = "client-tok-A";
    await client.callTool({
      name: "do_work",
      arguments: {},
      _meta: { progressToken: CLIENT_TOKEN },
    });
    await new Promise((r) => setTimeout(r, 20));

    // Server saw the client's token on ctx.mcp.progressToken …
    expect(seen.token).toBe(CLIENT_TOKEN);
    // … and echoed that EXACT token onto every wire frame.
    expect(received).toEqual([
      { progressToken: CLIENT_TOKEN, progress: 1, total: 3, message: "step 1" },
      { progressToken: CLIENT_TOKEN, progress: 3, total: 3, message: undefined },
    ]);
    await cleanup();
  });

  it("real SDK onprogress correlates (auto-generated token round-trips)", async () => {
    const seen: { token: ProgressToken | undefined } = { token: undefined };
    const { client, cleanup } = await makeConnectedClient({
      name: "prog-onprogress",
      tools: { registry: [progressToolDeclaration()], resolveHandler: makeResolver(seen) },
    });
    const received: Array<{ progress: number; total?: number; message?: string }> = [];

    // No custom notification handler — the SDK's DEFAULT progress routing
    // is exercised. It only fires `onprogress` when the notification's
    // token maps back to THIS in-flight request, so its firing proves the
    // server echoed the SDK-generated token verbatim.
    await client.callTool({ name: "do_work", arguments: {} }, undefined, {
      onprogress: (p) => {
        received.push({ progress: p.progress, total: p.total, message: p.message });
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    // The SDK generated a token and threaded it through `_meta`; the
    // handler observed it (non-empty), and onprogress correlated.
    expect(seen.token).toBeDefined();
    expect(received).toEqual([
      { progress: 1, total: 3, message: "step 1" },
      { progress: 3, total: 3, message: undefined },
    ]);
    await cleanup();
  });

  it("progress needs no capability gate — fires even with logging opted out", async () => {
    const seen: { token: ProgressToken | undefined } = { token: undefined };
    const { client, cleanup } = await makeConnectedClient({
      name: "prog-nolog",
      capabilities: { logging: false },
      tools: { registry: [progressToolDeclaration()], resolveHandler: makeResolver(seen) },
    });
    const received: unknown[] = [];
    client.setNotificationHandler(ProgressNotificationSchema, async (n) => {
      received.push(n.params);
    });

    await client.callTool({ name: "do_work", arguments: {}, _meta: { progressToken: "tok-Z" } });
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(2);
    await cleanup();
  });
});
