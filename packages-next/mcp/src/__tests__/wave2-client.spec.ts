/**
 * Wave 2 (#146) — client protocol completeness conformance.
 *
 * Stands up a REAL in-memory MCP `Server` (SDK) with resource / prompt
 * / completion / sampling / roots / logging handlers wired, pairs it to
 * a REAL {@link McpClientHarness} over the linked in-memory transport,
 * and drives every restored client verb end-to-end. No fakes — these
 * are true client↔server round-trips through the SDK Protocol.
 *
 * Plus a `content-mapper` unit block: `structuredContent` / `isError` /
 * embedded-resource-block preservation.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 */

import { afterEach, describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  type CallToolResult,
  type CreateMessageRequest,
  type LoggingLevel,
} from "@modelcontextprotocol/sdk/types.js";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import { isResourceBlock } from "@agentick/spec-next";

import { InMemoryMcpTransport } from "../transport/in-memory.js";
import { McpClientHarness, NoneAuth } from "../client/index.js";
import type { McpLogMessage, McpRootsSource, McpSamplingHandler } from "../client/index.js";
import { mapCallToolResult, mcpContentToBlocks } from "../integration/content-mapper.js";

// ============================================================================
// Real in-memory server fixture
// ============================================================================

interface ServerFixture {
  readonly server: Server;
  /** Level captured by the server's `logging/setLevel` handler. */
  currentLevel(): LoggingLevel | undefined;
}

function makeServer(): { server: Server; fixture: ServerFixture } {
  let level: LoggingLevel | undefined;
  const server = new Server(
    { name: "wave2-test-server", version: "0.0.0" },
    { capabilities: { resources: {}, prompts: {}, completions: {}, logging: {} } },
  );

  // — Resources —
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "mem://doc.txt", name: "doc", mimeType: "text/plain", description: "a text doc" },
      { uri: "mem://pic.png", name: "pic", mimeType: "image/png" },
    ],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: "mem://users/{id}", name: "user", mimeType: "application/json" },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri === "mem://pic.png") {
      return { contents: [{ uri, mimeType: "image/png", blob: "YmluYXJ5" }] };
    }
    return { contents: [{ uri, mimeType: "text/plain", text: `body of ${uri}` }] };
  });

  // — Prompts —
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "greet",
        description: "greet someone",
        arguments: [{ name: "who", description: "the name", required: true }],
      },
    ],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const who = req.params.arguments?.who ?? "world";
    return {
      description: "a greeting",
      messages: [
        { role: "user", content: { type: "text", text: `Hello, ${who}!` } },
        {
          role: "assistant",
          content: {
            type: "resource",
            resource: { uri: "mem://greeting.txt", mimeType: "text/plain", text: "hi" },
          },
        },
      ],
    };
  });

  // — Completion —
  server.setRequestHandler(CompleteRequestSchema, async (req) => {
    if (req.params.ref.type === "ref/prompt") {
      return { completion: { values: ["alice", "alan"], total: 2, hasMore: false } };
    }
    return { completion: { values: ["42"], total: 1, hasMore: false } };
  });

  // — Logging —
  server.setRequestHandler(SetLevelRequestSchema, async (req) => {
    level = req.params.level;
    return {};
  });

  return { server, fixture: { server, currentLevel: () => level } };
}

interface Wired {
  readonly harness: McpClientHarness;
  readonly server: Server;
  readonly fixture: ServerFixture;
}

const active: Wired[] = [];

async function wire(options?: {
  readonly samplingHandler?: McpSamplingHandler;
  readonly roots?: McpRootsSource;
}): Promise<Wired> {
  const { server, fixture } = makeServer();
  const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
  await server.connect(serverTransport);

  const harness = new McpClientHarness(
    `mcp:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      serverId: "wave2",
      transport: clientTransport,
      auth: new NoneAuth(),
      ...(options?.samplingHandler ? { samplingHandler: options.samplingHandler } : {}),
      ...(options?.roots ? { roots: options.roots } : {}),
    },
  );
  await harness.connect();

  const wired = { harness, server, fixture };
  active.push(wired);
  return wired;
}

afterEach(async () => {
  while (active.length > 0) {
    const w = active.pop()!;
    await w.harness.close();
    await w.server.close();
  }
});

// ============================================================================
// Resources
// ============================================================================

describe("wave2 client — resources", () => {
  it("listResources returns the server's catalog", async () => {
    const { harness } = await wire();
    const page = await harness.listResources();
    expect(page.resources.map((r) => r.uri)).toEqual(["mem://doc.txt", "mem://pic.png"]);
    expect(page.resources[0]).toMatchObject({ name: "doc", mimeType: "text/plain" });
  });

  it("listResourceTemplates returns parameterized resources", async () => {
    const { harness } = await wire();
    const page = await harness.listResourceTemplates();
    expect(page.templates).toEqual([
      { uriTemplate: "mem://users/{id}", name: "user", mimeType: "application/json" },
    ]);
  });

  it("readResource maps text contents (text/blob typing)", async () => {
    const { harness } = await wire();
    const contents = await harness.readResource("mem://doc.txt");
    expect(contents).toEqual([
      { uri: "mem://doc.txt", mimeType: "text/plain", text: "body of mem://doc.txt" },
    ]);
  });

  it("readResource maps blob contents", async () => {
    const { harness } = await wire();
    const contents = await harness.readResource("mem://pic.png");
    expect(contents).toEqual([{ uri: "mem://pic.png", mimeType: "image/png", blob: "YmluYXJ5" }]);
  });
});

// ============================================================================
// Prompts
// ============================================================================

describe("wave2 client — prompts", () => {
  it("listPrompts returns the prompt catalog with arguments", async () => {
    const { harness } = await wire();
    const page = await harness.listPrompts();
    expect(page.prompts).toEqual([
      {
        name: "greet",
        description: "greet someone",
        arguments: [{ name: "who", description: "the name", required: true }],
      },
    ]);
  });

  it("getPrompt maps messages, including an embedded resource block", async () => {
    const { harness } = await wire();
    const result = await harness.getPrompt("greet", { who: "Ada" });
    expect(result.description).toBe("a greeting");
    expect(result.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello, Ada!" }],
    });
    const asstBlock = result.messages[1]!.content[0]!;
    expect(isResourceBlock(asstBlock)).toBe(true);
    expect(asstBlock).toEqual({
      type: "resource",
      resource: { uri: "mem://greeting.txt", mimeType: "text/plain", text: "hi" },
    });
  });
});

// ============================================================================
// Completion
// ============================================================================

describe("wave2 client — completion", () => {
  it("completePromptArgument returns prompt-arg completions", async () => {
    const { harness } = await wire();
    const values = await harness.completePromptArgument("greet", "who", "al");
    expect(values).toEqual(["alice", "alan"]);
  });

  it("completeResourceTemplate returns template-var completions", async () => {
    const { harness } = await wire();
    const values = await harness.completeResourceTemplate("mem://users/{id}", "id", "4");
    expect(values).toEqual(["42"]);
  });
});

// ============================================================================
// Sampling (server → client)
// ============================================================================

describe("wave2 client — sampling", () => {
  it("routes an inbound sampling/createMessage to the configured handler", async () => {
    let seen: CreateMessageRequest["params"] | undefined;
    const samplingHandler: McpSamplingHandler = async (params) => {
      seen = params;
      return {
        model: "test-model",
        role: "assistant",
        content: { type: "text", text: "sampled reply" },
      };
    };
    const { server } = await wire({ samplingHandler });

    // The server drives the round-trip: it asks the client to sample.
    const result = await server.createMessage({
      messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      maxTokens: 100,
    });

    // Handler saw the request…
    expect(seen).toBeDefined();
    expect(seen!.messages[0]!.content).toMatchObject({ type: "text", text: "hi" });
    // …and its response went back to the server.
    expect(result.model).toBe("test-model");
    expect(result.content).toMatchObject({ type: "text", text: "sampled reply" });
  });

  it("responds method-not-found when no sampling handler is configured", async () => {
    const { server } = await wire(); // no samplingHandler → capability not advertised
    await expect(
      server.createMessage({
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
        maxTokens: 10,
      }),
    ).rejects.toThrow(/method not found|not supported|-32601/i);
  });
});

// ============================================================================
// Roots (client → server request handler)
// ============================================================================

describe("wave2 client — roots", () => {
  it("returns the configured roots list on roots/list", async () => {
    const roots = [{ uri: "file:///workspace", name: "workspace" }];
    const { server } = await wire({ roots });
    const result = await server.listRoots();
    expect(result.roots).toEqual([{ uri: "file:///workspace", name: "workspace" }]);
  });

  it("re-evaluates a roots provider function on each request", async () => {
    let calls = 0;
    const roots: McpRootsSource = () => {
      calls++;
      return [{ uri: `file:///v${calls}` }];
    };
    const { server, harness } = await wire({ roots });
    const first = await server.listRoots();
    expect(first.roots).toEqual([{ uri: "file:///v1" }]);
    // notifyRootsListChanged is a client→server notification — smoke it.
    await harness.notifyRootsListChanged();
    const second = await server.listRoots();
    expect(second.roots).toEqual([{ uri: "file:///v2" }]);
  });
});

// ============================================================================
// Logging (server → client notification)
// ============================================================================

describe("wave2 client — logging", () => {
  it("setLoggingLevel reaches the server and log notifications surface", async () => {
    const { harness, server, fixture } = await wire();
    await harness.setLoggingLevel("info");
    expect(fixture.currentLevel()).toBe("info");

    const received: McpLogMessage[] = [];
    harness.onLogMessage((m) => received.push(m));

    await server.sendLoggingMessage({ level: "info", logger: "srv", data: "hello logs" });
    // Synchronous in-memory delivery; assert immediately.
    expect(received).toEqual([{ level: "info", logger: "srv", data: "hello logs" }]);
  });
});

// ============================================================================
// content-mapper unit — structuredContent / isError / resource block
// ============================================================================

describe("wave2 content-mapper", () => {
  it("mapCallToolResult preserves structuredContent and isError", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { rows: 3, ok: true },
      isError: true,
    };
    const mapped = mapCallToolResult(result);
    expect(mapped.content).toEqual([{ type: "text", text: "ok" }]);
    expect(mapped.structuredContent).toEqual({ rows: 3, ok: true });
    expect(mapped.isError).toBe(true);
  });

  it("omits absent structuredContent / isError", () => {
    const mapped = mapCallToolResult({ content: [{ type: "text", text: "x" }] });
    expect("structuredContent" in mapped).toBe(false);
    expect("isError" in mapped).toBe(false);
  });

  it("maps an embedded resource to a resource block (not text JSON)", () => {
    const blocks = mcpContentToBlocks([
      {
        type: "resource",
        resource: { uri: "mem://x.txt", mimeType: "text/plain", text: "body" },
      },
    ] as unknown as CallToolResult["content"]);
    expect(blocks).toEqual([
      {
        type: "resource",
        resource: { uri: "mem://x.txt", mimeType: "text/plain", text: "body" },
      },
    ]);
    expect(isResourceBlock(blocks[0]!)).toBe(true);
  });
});
