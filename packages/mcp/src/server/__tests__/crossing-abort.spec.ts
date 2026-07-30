/**
 * #254 — a crossing's `ctx.signal` IS the caller's cancellation.
 *
 * Before this, both ctx mint sites handed handlers a fresh
 * `new AbortController().signal` that nothing ever aborted: a client that
 * gave up on a `tools/call` left the handler running to completion
 * against a dead peer, and `ctx.signal` was decorative.
 *
 * Driven over the real wire — in-memory transport pair, a real SDK
 * `Client` issuing the cancel — because the signal originates in the SDK's
 * `RequestHandlerExtra` and the point is that the projection threads it.
 *
 * Pins:
 *  - A client cancelling an in-flight `tools/call` aborts the handler's
 *    `ctx.signal`, carrying the client's reason.
 *  - Connection close aborts an in-flight handler too (the SDK aborts
 *    every live request handler on close — the same seam, no extra wiring).
 *  - A crossing that is never cancelled leaves `ctx.signal` un-aborted.
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type { McpRequestContext, ToolDeclaration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { inMemoryServerTransport, McpServerHarness } from "../index.js";

const emptySchema = jsonSchema({ type: "object", properties: {}, additionalProperties: true });

const SLOW_TOOL: ToolDeclaration = {
  id: "slow",
  name: "slow",
  description: "Runs until its ctx.signal aborts.",
  inputSchema: emptySchema,
  exposure: ["model"],
  handlerRef: "handler:slow",
};

interface Rig {
  readonly harness: McpServerHarness;
  readonly connect: () => Promise<McpClient>;
  /** The `ctx.signal` the slow handler received, once it is running. */
  seen: AbortSignal | undefined;
  readonly stop: () => Promise<void>;
}

/**
 * A server whose one tool parks until its `ctx.signal` fires — so the
 * test's assertion is exactly "the handler learned the caller left".
 */
async function rig(): Promise<Rig> {
  const transport = inMemoryServerTransport();
  const state: { seen: AbortSignal | undefined } = { seen: undefined };
  const harness = new McpServerHarness(
    `srv:${ulid()}`,
    new MemoryJournal({ capacity: 256 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "abort-test",
      transports: [transport],
      tools: {
        registry: [SLOW_TOOL],
        resolveHandler: () => async (_input: unknown, ctx: McpRequestContext) => {
          state.seen = ctx.signal;
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) {
              resolve();
              return;
            }
            ctx.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { kind: "inline" as const, content: [{ type: "text" as const, text: "done" }] };
        },
      },
    },
  );
  await harness.ready;
  await harness.start();

  const clients: McpClient[] = [];
  return {
    harness,
    get seen(): AbortSignal | undefined {
      return state.seen;
    },
    connect: async (): Promise<McpClient> => {
      const clientTransport = await transport.connect();
      const client = new McpClient({ name: "c", version: "0.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);
      clients.push(client);
      return client;
    },
    stop: async (): Promise<void> => {
      for (const c of clients) await c.close().catch(() => {});
      await harness.close();
    },
  };
}

function callSlow(client: McpClient, signal?: AbortSignal): Promise<unknown> {
  return client.request(
    { method: "tools/call", params: { name: "slow", arguments: {} } },
    CallToolResultSchema,
    signal ? { signal } : {},
  );
}

let active: Rig | undefined;
afterEach(async () => {
  await active?.stop();
  active = undefined;
});

describe("crossing ctx.signal — the caller's cancellation", () => {
  it("aborts the running handler when the client cancels, forwarding the reason", async () => {
    const r = (active = await rig());
    const client = await r.connect();

    const cancel = new AbortController();
    const call = callSlow(client, cancel.signal);
    // Wait until the handler is actually running — otherwise the cancel
    // would race the request and prove nothing.
    const signal = await waitFor(() => r.seen, { description: "slow handler started" });
    expect(signal.aborted).toBe(false);

    cancel.abort("user closed the tab");
    await expect(call).rejects.toThrow(/user closed the tab/);

    await waitFor(() => signal.aborted, { description: "handler ctx.signal aborted" });
    expect(String(signal.reason)).toContain("user closed the tab");
  });

  it("aborts the running handler when the connection closes", async () => {
    const r = (active = await rig());
    const client = await r.connect();

    const call = callSlow(client);
    const signal = await waitFor(() => r.seen, { description: "slow handler started" });
    expect(signal.aborted).toBe(false);

    await client.close();
    await waitFor(() => signal.aborted, { description: "handler ctx.signal aborted on close" });
    await expect(call).rejects.toThrow(/closed/i);
  });

  it("leaves ctx.signal un-aborted for a crossing nobody cancelled", async () => {
    const r = (active = await rig());
    const client = await r.connect();

    const cancel = new AbortController();
    const call = callSlow(client, cancel.signal);
    const signal = await waitFor(() => r.seen, { description: "slow handler started" });

    // Nothing cancelled: the signal stays quiet, and the handler keeps
    // running (it only completes when the signal fires).
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(signal.aborted).toBe(false);

    cancel.abort("cleanup");
    await expect(call).rejects.toThrow(/cleanup/);
  });
});
