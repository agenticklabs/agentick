/**
 * ElicitationBridge end-to-end — closes the loop from an MCP server
 * firing `elicitation/create` mid-tool-call, through the bridge's SDK
 * handler, into the session's `ElicitationHarness`, out to a simulated
 * client UI that responds, back through the harness's reply, and
 * finally back to the server which embeds the elicited value in its
 * tool result. The full round-trip MUST succeed for #133 to be done.
 *
 *   1. SDK Server with one tool `ask_name`. The handler calls
 *      `server.elicitInput(...)` with a JSON Schema for a `name`
 *      string. When the user replies, the server embeds the name in
 *      the tool's response text.
 *   2. `withMCP({ servers: [{transport: clientSide, ...}] })` wires
 *      the client side into an AppHarness whose substrate is a shared
 *      bus/inbox/journal we keep references to so the test can monitor
 *      the elicit request envelope.
 *   3. `app.createSession()` builds a session; the session's elicit
 *      harness is reachable via `session.elicitation` (module-augmented
 *      slot on `SessionHarnessProtocol`).
 *   4. Test subscribes to the bus before kicking off
 *      `session.dispatch("server__ask_name", {})`; the dispatch fires
 *      `tools/call` over the wire; the server's handler fires
 *      `elicitation/create`; the bridge routes through
 *      `session.elicitation.elicit(...)`; the harness publishes a
 *      `session:channel:elicitation` request envelope onto the bus.
 *   5. Test reads the envelope's `correlationId` and calls
 *      `session.elicitation.respond({ correlationId, outcome:
 *      "accepted", value: { name: "Alice" } })`.
 *   6. The bridge translates back to `{ action: "accept", content:
 *      { name: "Alice" } }`; the server's `elicitInput` resolves; the
 *      tool handler returns `"Hello, Alice"`; the dispatch resolves.
 */

import React from "react";
import { Chunk, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { createApp } from "@agentick/app-next/react";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { EventEnvelope } from "@agentick/spec-next";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { InMemoryMcpTransport, NoneAuth, withMCP } from "../index.js";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hello");

async function mkExecutor(): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    "mcp-elicit-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text" as const, text: "ok" }],
            stopReason: "end",
          },
        },
      ],
    },
  );
  await exec.ready;
  return exec;
}

async function mkElicitingServer(): Promise<{
  readonly server: Server;
  readonly clientTransport: InMemoryMcpTransport;
}> {
  const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
  const server = new Server(
    { name: "eliciting-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "ask_name",
        description: "asks the user for a name and greets them",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "ask_name") {
      return {
        content: [{ type: "text" as const, text: `unknown tool ${req.params.name}` }],
        isError: true,
      };
    }
    const elicitResult = await server.elicitInput({
      message: "What is your name?",
      requestedSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name" },
        },
        required: ["name"],
      },
    });
    if (elicitResult.action !== "accept") {
      return {
        content: [{ type: "text" as const, text: `no answer (${elicitResult.action})` }],
      };
    }
    const name = (elicitResult.content as { name?: string } | undefined)?.name ?? "stranger";
    return {
      content: [{ type: "text" as const, text: `Hello, ${name}` }],
    };
  });

  await server.connect(serverTransport);
  return { server, clientTransport };
}

interface EnvelopeWithMetadata extends EventEnvelope {
  readonly metadata?: Readonly<{ readonly correlationId?: string }>;
}

/**
 * Resolve once the bus emits the first `session:channel:elicitation`
 * request envelope and return its `correlationId`. Mirrors the helper
 * in `tool-executor/__tests__/confirmation.spec.ts` so the two
 * codepaths read identically.
 */
function nextElicitationCorrelationId(bus: LocalEventBus): Promise<string> {
  return Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact: "session:channel:elicitation" },
        }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>,
        1,
      ),
    ),
  ).then((chunk) => {
    const env = Array.from(Chunk.toReadonlyArray(chunk))[0]!;
    const id = env.metadata?.correlationId;
    if (typeof id !== "string") {
      throw new Error("expected correlationId on elicitation request envelope");
    }
    return id;
  });
}

describe("ElicitationBridge — server-to-client elicit routing (#133)", () => {
  it("routes inbound elicit/create through session.elicitation and returns the user's value", async () => {
    const bus = new LocalEventBus();
    const { server, clientTransport } = await mkElicitingServer();

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      bus,
      journal: new MemoryJournal(),
      inbox: new LocalInbox(),
      extensions: [
        withMCP({
          servers: [
            {
              serverId: "names",
              transport: clientTransport,
              auth: new NoneAuth(),
            },
          ],
        }),
      ],
    });

    const session = await app.createSession();

    // Race the elicit subscription against the dispatch — order is
    // critical: subscribe FIRST so the envelope from the dispatch's
    // elicit lands inside the subscription window.
    const correlationIdP = nextElicitationCorrelationId(bus);
    const dispatchP = session.dispatch("names__ask_name", {});

    const correlationId = await correlationIdP;
    await session.elicitation.respond({
      correlationId,
      outcome: "accepted",
      value: { name: "Alice" },
    });

    const content = await dispatchP;
    expect(content).toHaveLength(1);
    expect((content[0] as { text: string }).text).toBe("Hello, Alice");

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("returns 'no answer (decline)' when the user declines the elicit", async () => {
    const bus = new LocalEventBus();
    const { server, clientTransport } = await mkElicitingServer();

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      bus,
      journal: new MemoryJournal(),
      inbox: new LocalInbox(),
      extensions: [
        withMCP({
          servers: [{ serverId: "names", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });

    const session = await app.createSession();

    const correlationIdP = nextElicitationCorrelationId(bus);
    const dispatchP = session.dispatch("names__ask_name", {});

    const correlationId = await correlationIdP;
    await session.elicitation.respond({
      correlationId,
      outcome: "declined",
      reason: "user said no",
    });

    const content = await dispatchP;
    expect((content[0] as { text: string }).text).toBe("no answer (decline)");

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("returns 'no answer (cancel)' when the elicit is cancelled", async () => {
    const bus = new LocalEventBus();
    const { server, clientTransport } = await mkElicitingServer();

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      bus,
      journal: new MemoryJournal(),
      inbox: new LocalInbox(),
      extensions: [
        withMCP({
          servers: [{ serverId: "names", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });

    const session = await app.createSession();

    const correlationIdP = nextElicitationCorrelationId(bus);
    const dispatchP = session.dispatch("names__ask_name", {});

    const correlationId = await correlationIdP;
    await session.elicitation.respond({
      correlationId,
      outcome: "cancelled",
    });

    const content = await dispatchP;
    expect((content[0] as { text: string }).text).toBe("no answer (cancel)");

    await session.close();
    await app.closeApp();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// URL-mode bridge (#134a) — server fires `elicitation/create` with
// `mode: "url"`; the bridge forwards through the harness's URL-mode
// elicit; user consents (or declines/cancels); the SDK serializes the
// reply as a three-action ElicitResult.
// ---------------------------------------------------------------------------

async function mkUrlElicitingServer(): Promise<{
  readonly server: Server;
  readonly clientTransport: InMemoryMcpTransport;
}> {
  const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
  const server = new Server(
    { name: "url-eliciting-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "start_oauth",
        description: "starts an OAuth flow via a URL-mode elicitation",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async () => {
    const elicitResult = await server.elicitInput({
      mode: "url",
      message: "Open your bank's OAuth page to authorize",
      url: "https://example.com/oauth?state=abc",
      elicitationId: "oauth-flow-1",
    });
    return {
      content: [{ type: "text" as const, text: `oauth: ${elicitResult.action}` }],
    };
  });

  await server.connect(serverTransport);
  return { server, clientTransport };
}

describe("ElicitationBridge — capability + concurrency (#149)", () => {
  it("client advertises elicitation form + url modes by default", async () => {
    const bus = new LocalEventBus();
    const { server, clientTransport } = await mkElicitingServer();

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      bus,
      journal: new MemoryJournal(),
      inbox: new LocalInbox(),
      extensions: [
        withMCP({
          servers: [{ serverId: "caps", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });

    // #151: withMCP runs at SESSION construction; the initialize
    // handshake happens when the per-session McpClientHarness
    // connects. Create a session to trigger it before inspecting
    // server-side capabilities.
    const session = await app.createSession();

    const caps = server.getClientCapabilities();
    expect(caps?.elicitation).toEqual({ form: {}, url: {} });

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("two concurrent in-session elicits route by correlationId — no cross-talk", async () => {
    // Test the within-session concurrent path. Two callTool invocations
    // from the same session each fire elicits in parallel; harness's
    // correlation registry MUST route each user response to the right
    // pending call.
    const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
    const server = new Server(
      { name: "two-elicit-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "ask",
          inputSchema: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const q = (req.params.arguments as { q: string }).q;
      const r = await server.elicitInput({
        message: `elicit-for: ${q}`,
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      });
      if (r.action !== "accept") return { content: [{ type: "text" as const, text: "no" }] };
      const answer = (r.content as { answer: string }).answer;
      return { content: [{ type: "text" as const, text: `${q}=>${answer}` }] };
    });
    await server.connect(serverTransport);

    const bus = new LocalEventBus();
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      bus,
      journal: new MemoryJournal(),
      inbox: new LocalInbox(),
      extensions: [
        withMCP({
          servers: [{ serverId: "two", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });
    const session = await app.createSession();

    // Subscribe to every elicit envelope BEFORE firing the calls.
    const envelopes: EnvelopeWithMetadata[] = [];
    const sub = bus.subscribe({
      surface: "session",
      name: { exact: "session:channel:elicitation" },
    }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>;
    const collected = Effect.runPromise(Stream.runCollect(Stream.take(sub, 2))).then((c) => {
      envelopes.push(...Array.from(Chunk.toReadonlyArray(c)));
    });

    // Fire two parallel dispatches.
    const dispatchA = session.dispatch("two__ask", { q: "color" });
    const dispatchB = session.dispatch("two__ask", { q: "fruit" });

    await collected;
    // Order is racy; correlate by the envelope's payload message.
    const envFor = (suffix: string): EnvelopeWithMetadata => {
      const env = envelopes.find(
        (e) => (e.payload as { message?: string }).message === `elicit-for: ${suffix}`,
      );
      if (!env) throw new Error(`no envelope for ${suffix}`);
      return env;
    };
    const envA = envFor("color");
    const envB = envFor("fruit");
    expect(envA.metadata?.correlationId).not.toBe(envB.metadata?.correlationId);

    await session.elicitation.respond({
      correlationId: envA.metadata!.correlationId as string,
      outcome: "accepted",
      value: { answer: "blue" },
    });
    await session.elicitation.respond({
      correlationId: envB.metadata!.correlationId as string,
      outcome: "accepted",
      value: { answer: "apple" },
    });

    const [a, b] = await Promise.all([dispatchA, dispatchB]);
    expect((a[0] as { text: string }).text).toBe("color=>blue");
    expect((b[0] as { text: string }).text).toBe("fruit=>apple");

    await session.close();
    await app.closeApp();
    await server.close();
  });
});

describe("ElicitationBridge — URL mode (#134a)", () => {
  it("forwards URL-mode elicit through harness; accepted maps to action: 'accept'", async () => {
    const bus = new LocalEventBus();
    const { server, clientTransport } = await mkUrlElicitingServer();

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      bus,
      journal: new MemoryJournal(),
      inbox: new LocalInbox(),
      extensions: [
        withMCP({
          servers: [{ serverId: "oauth", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });

    const session = await app.createSession();

    const correlationIdP = nextElicitationCorrelationId(bus);
    const dispatchP = session.dispatch("oauth__start_oauth", {});

    const correlationId = await correlationIdP;
    // URL-mode accepted = user consented to navigate to the URL. No
    // value carried (consent-only terminal).
    await session.elicitation.respond({
      correlationId,
      outcome: "accepted",
    });

    const content = await dispatchP;
    expect((content[0] as { text: string }).text).toBe("oauth: accept");

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("URL-mode declined maps to action: 'decline'", async () => {
    const bus = new LocalEventBus();
    const { server, clientTransport } = await mkUrlElicitingServer();

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      bus,
      journal: new MemoryJournal(),
      inbox: new LocalInbox(),
      extensions: [
        withMCP({
          servers: [{ serverId: "oauth", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });

    const session = await app.createSession();

    const correlationIdP = nextElicitationCorrelationId(bus);
    const dispatchP = session.dispatch("oauth__start_oauth", {});

    const correlationId = await correlationIdP;
    await session.elicitation.respond({
      correlationId,
      outcome: "declined",
    });

    const content = await dispatchP;
    expect((content[0] as { text: string }).text).toBe("oauth: decline");

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("URL-mode wire payload carries url + elicitationId on the request envelope", async () => {
    const bus = new LocalEventBus();
    const { server, clientTransport } = await mkUrlElicitingServer();

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      bus,
      journal: new MemoryJournal(),
      inbox: new LocalInbox(),
      extensions: [
        withMCP({
          servers: [{ serverId: "oauth", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });

    const session = await app.createSession();

    // Subscribe to the elicit channel directly to capture the envelope
    // payload — proves the bridge translated the MCP `url` +
    // `elicitationId` fields onto the wire instead of cancelling.
    const envP = Effect.runPromise(
      Stream.runCollect(
        Stream.take(
          bus.subscribe({
            surface: "session",
            name: { exact: "session:channel:elicitation" },
          }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>,
          1,
        ),
      ),
    ).then((c) => Array.from(Chunk.toReadonlyArray(c))[0]!);

    const dispatchP = session.dispatch("oauth__start_oauth", {});

    const env = await envP;
    const payload = env.payload as {
      mode: string;
      url: string;
      elicitationId: string;
    };
    expect(payload.mode).toBe("url");
    expect(payload.url).toBe("https://example.com/oauth?state=abc");
    expect(payload.elicitationId).toBe("oauth-flow-1");

    await session.elicitation.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "cancelled",
    });
    await dispatchP;

    await session.close();
    await app.closeApp();
    await server.close();
  });
});
