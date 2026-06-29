/**
 * End-to-end smoke for server-side `ctx.elicit.*` sugar (#171d.2.1).
 *
 * Drives: server config opts into the `elicit` slot → server advertises
 * `elicitation` capability → client connects advertising elicit
 * support → server tool handler calls `ctx.elicit.text(...)` → request
 * round-trips via `sdkServer.request("elicitation/create")` → client
 * stub responds with accept/decline/cancel → handler resolves with the
 * typed value or throws ElicitationDeclined/Cancelled.
 *
 * Pins:
 *  - `elicitation` capability advertised iff `options.elicit` is opted in
 *  - `ctx.elicit` is undefined when slot wired but client capability missing
 *  - `text` / `confirm` / `boolean` / `number` / `select` / `multiSelect`
 *    all round-trip an accept payload into the correct typed value
 *  - Decline → `ElicitationDeclined` thrown
 *  - Cancel → `ElicitationCancelled` thrown
 *  - Method on a server without elicit-wired returns `undefined` ctx.elicit
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { ContentBlock, ToolDeclaration } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import {
  ElicitationCancelled,
  ElicitationDeclined,
  ElicitationNotSupported,
  inMemoryServerTransport,
  McpServerHarness,
  UrlElicitationRequired,
  type ToolHandlerResolver,
} from "../index.js";

const emptySchema = jsonSchema({ type: "object", properties: {} });

function tool(name: string): ToolDeclaration {
  return {
    id: name,
    name,
    description: `desc:${name}`,
    inputSchema: emptySchema,
    exposure: ["model"],
    handlerRef: `handler:${name}`,
  };
}

interface ServerSetup {
  readonly harness: McpServerHarness;
  readonly transport: ReturnType<typeof inMemoryServerTransport>;
}

async function makeElicitServer(
  handlers: Readonly<
    Record<
      string,
      (
        input: unknown,
        ctx: import("@agentick/spec-next").McpRequestContext,
      ) => Promise<ContentBlock[]>
    >
  >,
  options: { readonly elicitWired?: boolean } = {},
): Promise<ServerSetup> {
  const transport = inMemoryServerTransport();
  const resolveHandler: ToolHandlerResolver = (ref) => {
    const handler = handlers[ref];
    if (!handler) return null;
    return async (input, ctx) => ({ kind: "inline", content: await handler(input, ctx) });
  };
  const harness = new McpServerHarness(
    `srv:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "elicit-srv",
      transports: [transport],
      tools: {
        registry: Object.keys(handlers).map((ref) => tool(ref.replace(/^handler:/, ""))),
        resolveHandler,
      },
      ...(options.elicitWired ? { elicit: true } : {}),
      serverInfo: { name: "test", version: "0.0.0" },
    },
  );
  await harness.ready;
  await harness.start();
  return { harness, transport };
}

async function makeElicitClient(
  transport: Awaited<ReturnType<ReturnType<typeof inMemoryServerTransport>["connect"]>>,
  respond: (req: {
    params: { message: string; requestedSchema: Readonly<Record<string, unknown>> };
  }) => {
    action: "accept" | "decline" | "cancel";
    content?: Readonly<Record<string, unknown>>;
  },
  clientCapabilities: Readonly<Record<string, unknown>> = { elicitation: { form: {} } },
): Promise<McpClient> {
  const client = new McpClient(
    { name: "test-client", version: "0.0.0" },
    { capabilities: clientCapabilities },
  );
  // The SDK gates `setRequestHandler` on the matching capability being
  // advertised. Only install the elicit handler when this client opted
  // in — otherwise the client's role is "doesn't support elicitation".
  if ("elicitation" in clientCapabilities) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const out = respond(
        req as {
          params: { message: string; requestedSchema: Readonly<Record<string, unknown>> };
        },
      );
      return out as Awaited<ReturnType<NonNullable<Parameters<McpClient["setRequestHandler"]>[1]>>>;
    });
  }
  await client.connect(transport);
  return client;
}

describe("elicitation projection — ctx.elicit presence", () => {
  // Note: elicitation is a CLIENT capability in MCP, not server.
  // The server doesn't advertise an `elicitation` flag — it just issues
  // `elicitation/create` requests when the connected client advertised
  // the capability. The presence/absence contract is therefore
  // observed via `ctx.elicit` in the handler, not via
  // `client.getServerCapabilities()`.
  it("ctx.elicit is defined when server wires elicit AND client advertises", async () => {
    let elicitPresent: boolean | null = null;
    const { harness, transport } = await makeElicitServer(
      {
        "handler:probe": async (_input, ctx) => {
          elicitPresent = ctx.elicit !== undefined;
          return [{ type: "text", text: "ok" }];
        },
      },
      { elicitWired: true },
    );
    const clientTransport = await transport.connect();
    const client = await makeElicitClient(clientTransport, () => ({ action: "cancel" }));

    await client.callTool({ name: "probe", arguments: {} }, CallToolResultSchema);
    expect(elicitPresent).toBe(true);

    await client.close();
    await harness.close();
  });

  it("ctx.elicit is undefined when server wires but client does NOT advertise", async () => {
    let elicitPresent: boolean | null = null;
    const { harness, transport } = await makeElicitServer(
      {
        "handler:probe": async (_input, ctx) => {
          elicitPresent = ctx.elicit !== undefined;
          return [{ type: "text", text: "ok" }];
        },
      },
      { elicitWired: true },
    );
    const clientTransport = await transport.connect();
    // Client connects WITHOUT advertising elicitation capability.
    const client = await makeElicitClient(clientTransport, () => ({ action: "cancel" }), {});

    await client.callTool({ name: "probe", arguments: {} }, CallToolResultSchema);
    expect(elicitPresent).toBe(false);

    await client.close();
    await harness.close();
  });

  it("ctx.elicit is defined by default when the slot is absent (elicit ON by default)", async () => {
    // Default behavior: ctx.elicit available whenever client supports.
    let elicitPresent: boolean | null = null;
    const { harness, transport } = await makeElicitServer({
      "handler:probe": async (_input, ctx) => {
        elicitPresent = ctx.elicit !== undefined;
        return [{ type: "text", text: "ok" }];
      },
    });
    const clientTransport = await transport.connect();
    const client = await makeElicitClient(clientTransport, () => ({ action: "cancel" }));

    await client.callTool({ name: "probe", arguments: {} }, CallToolResultSchema);
    expect(elicitPresent).toBe(true);

    await client.close();
    await harness.close();
  });

  it("ctx.elicit is undefined when the server explicitly opts out with `elicit: false`", async () => {
    let elicitPresent: boolean | null = null;
    const transport = inMemoryServerTransport();
    const harness = new McpServerHarness(
      `srv:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        name: "elicit-opt-out-srv",
        transports: [transport],
        elicit: false,
        tools: {
          registry: [tool("probe")],
          resolveHandler: () => async (_input, ctx) => {
            elicitPresent = ctx.elicit !== undefined;
            return { kind: "inline", content: [{ type: "text", text: "ok" }] };
          },
        },
        serverInfo: { name: "test", version: "0.0.0" },
      },
    );
    await harness.ready;
    await harness.start();
    const clientTransport = await transport.connect();
    const client = await makeElicitClient(clientTransport, () => ({ action: "cancel" }));

    await client.callTool({ name: "probe", arguments: {} }, CallToolResultSchema);
    expect(elicitPresent).toBe(false);

    await client.close();
    await harness.close();
  });

  it("server.elicitEnabled reports the policy flag", async () => {
    const { harness: onByDefault } = await makeElicitServer({});
    expect(onByDefault.elicitEnabled).toBe(true);
    await onByDefault.close();

    const transport = inMemoryServerTransport();
    const optedOut = new McpServerHarness(
      `srv:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        name: "x",
        transports: [transport],
        elicit: false,
        serverInfo: { name: "test", version: "0.0.0" },
      },
    );
    await optedOut.ready;
    expect(optedOut.elicitEnabled).toBe(false);
    await optedOut.close();
  });
});

describe("elicitation projection — round-trip happy paths", () => {
  async function runWith<T>(
    method: (ctx: import("@agentick/spec-next").McpRequestContext) => Promise<T>,
    respond: Parameters<typeof makeElicitClient>[1],
  ): Promise<T> {
    let captured: T | null = null;
    let caught: unknown = null;
    const { harness, transport } = await makeElicitServer(
      {
        "handler:run": async (_input, ctx) => {
          try {
            captured = await method(ctx);
          } catch (err) {
            caught = err;
          }
          return [{ type: "text", text: "done" }];
        },
      },
      { elicitWired: true },
    );
    const clientTransport = await transport.connect();
    const client = await makeElicitClient(clientTransport, respond);
    await client.callTool({ name: "run", arguments: {} }, CallToolResultSchema);
    await client.close();
    await harness.close();
    if (caught !== null) throw caught;
    return captured as T;
  }

  it("text — accept returns the string", async () => {
    const value = await runWith(
      (ctx) => ctx.elicit!.text("What is your name?"),
      () => ({ action: "accept", content: { value: "Ada" } }),
    );
    expect(value).toBe("Ada");
  });

  it("confirm — accept returns the boolean", async () => {
    const value = await runWith(
      (ctx) => ctx.elicit!.confirm("Proceed?"),
      () => ({ action: "accept", content: { value: true } }),
    );
    expect(value).toBe(true);
  });

  it("number — accept returns the number", async () => {
    const value = await runWith(
      (ctx) => ctx.elicit!.number("Pick a number"),
      () => ({ action: "accept", content: { value: 42 } }),
    );
    expect(value).toBe(42);
  });

  it("select — accept returns one of the choices", async () => {
    const value = await runWith(
      (ctx) => ctx.elicit!.select("Choose", ["red", "green", "blue"] as const),
      () => ({ action: "accept", content: { value: "green" } }),
    );
    expect(value).toBe("green");
  });

  it("multiSelect — accept returns an array of choices", async () => {
    const value = await runWith(
      (ctx) => ctx.elicit!.multiSelect("Pick", ["a", "b", "c"] as const),
      () => ({ action: "accept", content: { value: ["a", "c"] } }),
    );
    expect(value).toEqual(["a", "c"]);
  });
});

describe("elicitation projection — decline + cancel", () => {
  async function expectThrows<E extends Error>(
    method: (ctx: import("@agentick/spec-next").McpRequestContext) => Promise<unknown>,
    respond: Parameters<typeof makeElicitClient>[1],
    errorClass: new (...args: never[]) => E,
  ): Promise<void> {
    let caught: unknown = null;
    const { harness, transport } = await makeElicitServer(
      {
        "handler:run": async (_input, ctx) => {
          try {
            await method(ctx);
          } catch (err) {
            caught = err;
          }
          return [{ type: "text", text: "done" }];
        },
      },
      { elicitWired: true },
    );
    const clientTransport = await transport.connect();
    const client = await makeElicitClient(clientTransport, respond);
    await client.callTool({ name: "run", arguments: {} }, CallToolResultSchema);
    await client.close();
    await harness.close();
    expect(caught).toBeInstanceOf(errorClass);
  }

  it("decline throws ElicitationDeclined", async () => {
    await expectThrows(
      (ctx) => ctx.elicit!.text("?"),
      () => ({ action: "decline" }),
      ElicitationDeclined,
    );
  });

  it("cancel throws ElicitationCancelled", async () => {
    await expectThrows(
      (ctx) => ctx.elicit!.text("?"),
      () => ({ action: "cancel" }),
      ElicitationCancelled,
    );
  });
});

describe("elicitation projection — try* variants return ElicitOutcome (no throw)", () => {
  async function runWith<T>(
    method: (ctx: import("@agentick/spec-next").McpRequestContext) => Promise<T>,
    respond: Parameters<typeof makeElicitClient>[1],
  ): Promise<T> {
    let captured: T | null = null;
    const { harness, transport } = await makeElicitServer({
      "handler:run": async (_input, ctx) => {
        captured = await method(ctx);
        return [{ type: "text", text: "done" }];
      },
    });
    const clientTransport = await transport.connect();
    const client = await makeElicitClient(clientTransport, respond);
    await client.callTool({ name: "run", arguments: {} }, CallToolResultSchema);
    await client.close();
    await harness.close();
    return captured as T;
  }

  it("tryText accept returns { status: 'accept', value }", async () => {
    const outcome = await runWith(
      (ctx) => ctx.elicit!.tryText("?"),
      () => ({ action: "accept", content: { value: "Ada" } }),
    );
    expect(outcome).toEqual({ status: "accept", value: "Ada" });
  });

  it("tryConfirm decline returns { status: 'decline' } (no throw)", async () => {
    const outcome = await runWith(
      (ctx) => ctx.elicit!.tryConfirm("?"),
      () => ({ action: "decline" }),
    );
    expect(outcome).toEqual({ status: "decline" });
  });

  it("tryNumber cancel returns { status: 'cancel' } (no throw)", async () => {
    const outcome = await runWith(
      (ctx) => ctx.elicit!.tryNumber("?"),
      () => ({ action: "cancel" }),
    );
    expect(outcome).toEqual({ status: "cancel" });
  });

  it("trySelect accept returns the chosen option", async () => {
    const outcome = await runWith(
      (ctx) => ctx.elicit!.trySelect("?", ["a", "b"] as const),
      () => ({ action: "accept", content: { value: "b" } }),
    );
    expect(outcome).toEqual({ status: "accept", value: "b" });
  });

  it("tryMultiSelect accept returns the chosen options", async () => {
    const outcome = await runWith(
      (ctx) => ctx.elicit!.tryMultiSelect("?", ["x", "y", "z"] as const),
      () => ({ action: "accept", content: { value: ["x", "z"] } }),
    );
    expect(outcome).toEqual({ status: "accept", value: ["x", "z"] });
  });
});

describe("elicitation projection — URL mode", () => {
  it("url accept resolves void; tryUrl returns the outcome", async () => {
    let resolved = false;
    let tryOutcome: unknown = null;
    const { harness, transport } = await makeElicitServer(
      {
        "handler:both": async (_input, ctx) => {
          await ctx.elicit!.url({ message: "Sign in", url: "https://example.com/auth" });
          resolved = true;
          tryOutcome = await ctx.elicit!.tryUrl({
            message: "Approve",
            url: "https://example.com/approve",
          });
          return [{ type: "text", text: "ok" }];
        },
      },
      { elicitWired: true },
    );
    const clientTransport = await transport.connect();
    const client = await makeElicitClient(clientTransport, () => ({ action: "accept" }), {
      elicitation: { form: {}, url: {} },
    });

    await client.callTool({ name: "both", arguments: {} }, CallToolResultSchema);
    expect(resolved).toBe(true);
    expect(tryOutcome).toEqual({ status: "accept" });

    await client.close();
    await harness.close();
  });

  it("url throws ElicitationNotSupported when client only advertises form", async () => {
    let caught: unknown = null;
    const { harness, transport } = await makeElicitServer(
      {
        "handler:run": async (_input, ctx) => {
          try {
            await ctx.elicit!.url({ message: "x", url: "https://x" });
          } catch (err) {
            caught = err;
          }
          return [{ type: "text", text: "done" }];
        },
      },
      { elicitWired: true },
    );
    const clientTransport = await transport.connect();
    const client = await makeElicitClient(
      clientTransport,
      () => ({ action: "accept" }),
      { elicitation: { form: {} } }, // form-only, no url
    );

    await client.callTool({ name: "run", arguments: {} }, CallToolResultSchema);
    expect(caught).toBeInstanceOf(ElicitationNotSupported);
    expect((caught as ElicitationNotSupported).mode).toBe("url");

    await client.close();
    await harness.close();
  });

  it("url decline throws ElicitationDeclined", async () => {
    let caught: unknown = null;
    const { harness, transport } = await makeElicitServer(
      {
        "handler:run": async (_input, ctx) => {
          try {
            await ctx.elicit!.url({ message: "x", url: "https://x" });
          } catch (err) {
            caught = err;
          }
          return [{ type: "text", text: "done" }];
        },
      },
      { elicitWired: true },
    );
    const clientTransport = await transport.connect();
    const client = await makeElicitClient(clientTransport, () => ({ action: "decline" }), {
      elicitation: { url: {} },
    });

    await client.callTool({ name: "run", arguments: {} }, CallToolResultSchema);
    expect(caught).toBeInstanceOf(ElicitationDeclined);

    await client.close();
    await harness.close();
  });
});

describe("elicitation projection — requireUrls (deferred auth)", () => {
  it("throws UrlElicitationRequired with the URL specs + jsonRpcCode -32042", async () => {
    let caught: unknown = null;
    const { harness, transport } = await makeElicitServer(
      {
        "handler:run": async (_input, ctx) => {
          try {
            ctx.elicit!.requireUrls([
              { message: "Sign in", url: "https://example.com/oauth" },
              { message: "Authorize", url: "https://example.com/authorize" },
            ]);
            // Unreachable — requireUrls returns `never`.
            return [{ type: "text", text: "should not reach" }];
          } catch (err) {
            caught = err;
            // Re-throw so the tools/call path surfaces it on the wire.
            throw err;
          }
        },
      },
      { elicitWired: true },
    );
    const clientTransport = await transport.connect();
    const client = await makeElicitClient(clientTransport, () => ({ action: "cancel" }));

    // The handler throws — tools/call returns isError: true.
    const result = await client.callTool({ name: "run", arguments: {} }, CallToolResultSchema);
    expect(result.isError).toBe(true);

    expect(caught).toBeInstanceOf(UrlElicitationRequired);
    const required = caught as UrlElicitationRequired;
    expect(required.jsonRpcCode).toBe(-32042);
    expect(required.elicitations).toHaveLength(2);
    expect(required.elicitations[0]).toMatchObject({
      mode: "url",
      url: "https://example.com/oauth",
      message: "Sign in",
    });
    expect(required.elicitations[1]).toMatchObject({
      mode: "url",
      url: "https://example.com/authorize",
      message: "Authorize",
    });

    await client.close();
    await harness.close();
  });
});
