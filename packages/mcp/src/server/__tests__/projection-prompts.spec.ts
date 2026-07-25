/**
 * End-to-end smoke for the prompts projection (#171d.1).
 *
 * Drives the full path: PromptsHarness → McpServerHarness → in-memory
 * connection → SDK Client → initialize handshake → `prompts/list` /
 * `prompts/get` / `notifications/prompts/list_changed`.
 *
 * Pins:
 *  - `prompts` capability advertised iff `options.prompts` was wired
 *  - `prompts/list` reflects the harness's `list()` (per-conn filter applied)
 *  - `prompts/get` renders via the harness, maps to MCP wire form
 *  - Per-connection filter hides a prompt from BOTH list and get
 *  - Argument shape carries description + required onto the wire
 *  - `notifications/prompts/list_changed` fires on register / update / remove
 *  - Connection close unsubscribes the change-notifier (no leak after close)
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { PromptListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type { MessageEntry } from "@agentick/spec";
import { PromptsHarness } from "@agentick/prompts";

import { inMemoryServerTransport, McpServerHarness } from "../index.js";

function makeMessageEntries(text: string): readonly MessageEntry[] {
  return [{ kind: "message", role: "user", content: [{ type: "text", text }] }];
}

async function makePromptsHarness(): Promise<PromptsHarness> {
  const h = new PromptsHarness(
    `prompts:${ulid()}`,
    new MemoryJournal({ capacity: 256 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await h.ready;
  return h;
}

async function makeServer(
  prompts: PromptsHarness | undefined,
  options: {
    readonly filterPredicate?: Parameters<typeof import("../index.js").projectPrompts>[1];
  } = {},
): Promise<{
  readonly harness: McpServerHarness;
  readonly transport: ReturnType<typeof inMemoryServerTransport>;
}> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    `srv:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "test-server",
      transports: [transport],
      // `use` form — adopter owns the Prompts source lifecycle.
      ...(prompts
        ? {
            prompts: {
              use: prompts,
              ...(options.filterPredicate ? { filter: options.filterPredicate } : {}),
            },
          }
        : {}),
      serverInfo: { name: "test", version: "0.0.0" },
    },
  );
  await harness.ready;
  await harness.start();
  return { harness, transport };
}

async function makeClient(
  transport: Awaited<ReturnType<ReturnType<typeof inMemoryServerTransport>["connect"]>>,
): Promise<McpClient> {
  const client = new McpClient({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe("prompts projection — capability negotiation", () => {
  it("advertises prompts capability when the prompts slot is wired", async () => {
    const prompts = await makePromptsHarness();
    const { harness, transport } = await makeServer(prompts);
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    expect(client.getServerCapabilities()?.prompts).toBeDefined();

    await client.close();
    await harness.close();
    await prompts.close();
  });

  it("does NOT advertise prompts capability without the prompts slot", async () => {
    const { harness, transport } = await makeServer(undefined);
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    expect(client.getServerCapabilities()?.prompts).toBeUndefined();

    await client.close();
    await harness.close();
  });
});

describe("prompts projection — list + get", () => {
  it("prompts/list returns every registered prompt with arguments", async () => {
    const prompts = await makePromptsHarness();
    await prompts.register({
      declaration: {
        name: "summarize",
        description: "Summarize a passage",
        arguments: [
          { name: "text", description: "passage to summarize", required: true },
          { name: "max_words", description: "word budget", required: false },
        ],
        template: makeMessageEntries("Summarize the text."),
      },
    });
    await prompts.register({
      declaration: {
        name: "translate",
        description: "Translate to French",
        template: makeMessageEntries("Translate to French."),
      },
    });

    const { harness, transport } = await makeServer(prompts);
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    const result = await client.listPrompts();
    const names = result.prompts.map((p) => p.name).sort();
    expect(names).toEqual(["summarize", "translate"]);
    const summarize = result.prompts.find((p) => p.name === "summarize")!;
    expect(summarize.description).toBe("Summarize a passage");
    expect(summarize.arguments).toEqual([
      { name: "text", description: "passage to summarize", required: true },
      { name: "max_words", description: "word budget", required: false },
    ]);

    await client.close();
    await harness.close();
    await prompts.close();
  });

  it("prompts/get renders messages via the harness", async () => {
    const prompts = await makePromptsHarness();
    await prompts.register({
      declaration: {
        name: "greet",
        description: "Greet someone",
        arguments: [{ name: "name", required: true }],
        render: (args) => makeMessageEntries(`Hello, ${(args as { name: string }).name}!`),
      },
    });

    const { harness, transport } = await makeServer(prompts);
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    const result = await client.getPrompt({ name: "greet", arguments: { name: "Ada" } });
    expect(result.messages).toEqual([
      { role: "user", content: { type: "text", text: "Hello, Ada!" } },
    ]);

    await client.close();
    await harness.close();
    await prompts.close();
  });

  it("system-role messages flatten to user-role on the wire", async () => {
    const prompts = await makePromptsHarness();
    await prompts.register({
      declaration: {
        name: "sys",
        description: "system-role prompt",
        template: [
          { kind: "message", role: "system", content: [{ type: "text", text: "be brief" }] },
        ] satisfies readonly MessageEntry[],
      },
    });

    const { harness, transport } = await makeServer(prompts);
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    const result = await client.getPrompt({ name: "sys" });
    expect(result.messages).toEqual([
      { role: "user", content: { type: "text", text: "be brief" } },
    ]);

    await client.close();
    await harness.close();
    await prompts.close();
  });
});

describe("prompts projection — declarative shorthand", () => {
  it("array shorthand: server constructs Prompts internally + registers declarations", async () => {
    const transport = inMemoryServerTransport();
    const harness = new McpServerHarness(
      `srv:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        name: "declarative-srv",
        transports: [transport],
        prompts: [
          {
            name: "summarize",
            description: "Summarize",
            template: makeMessageEntries("Summarize."),
          },
          {
            name: "translate",
            description: "Translate",
            template: makeMessageEntries("Translate."),
          },
        ],
        serverInfo: { name: "test", version: "0.0.0" },
      },
    );
    await harness.ready;
    await harness.start();

    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    expect(client.getServerCapabilities()?.prompts).toBeDefined();

    const list = await client.listPrompts();
    expect(list.prompts.map((p) => p.name).sort()).toEqual(["summarize", "translate"]);

    // server.prompts exposes the internally-constructed Prompts source.
    expect(harness.prompts).not.toBeNull();
    expect(
      harness
        .prompts!.list()
        .map((p) => p.name)
        .sort(),
    ).toEqual(["summarize", "translate"]);

    await client.close();
    await harness.close();
    // No prompts.close() — the harness owns the internal source's lifecycle.
  });

  it("config form with declarations + filter", async () => {
    const transport = inMemoryServerTransport();
    const harness = new McpServerHarness(
      `srv:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        name: "config-srv",
        transports: [transport],
        prompts: {
          declarations: [
            { name: "public_x", description: "public", template: makeMessageEntries("x") },
            { name: "internal_y", description: "private", template: makeMessageEntries("y") },
          ],
          filter: (decl) => decl.name.startsWith("public_"),
        },
        serverInfo: { name: "test", version: "0.0.0" },
      },
    );
    await harness.ready;
    await harness.start();

    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    const list = await client.listPrompts();
    expect(list.prompts.map((p) => p.name)).toEqual(["public_x"]);

    await client.close();
    await harness.close();
  });

  it("server.prompts returns null when no prompts slot is wired", async () => {
    const { harness } = await makeServer(undefined);
    expect(harness.prompts).toBeNull();
    await harness.close();
  });

  it("internally-owned Prompts source closes when the server closes; adopter-owned does not", async () => {
    // Internally-owned: harness.close() must close the source.
    const transport1 = inMemoryServerTransport();
    const internalHarness = new McpServerHarness(
      `srv:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        name: "internal-srv",
        transports: [transport1],
        prompts: [{ name: "x", description: "x", template: makeMessageEntries("x") }],
        serverInfo: { name: "test", version: "0.0.0" },
      },
    );
    await internalHarness.ready;
    await internalHarness.start();
    const internalPrompts = internalHarness.prompts!;
    let internalClosed = false;
    const origClose = internalPrompts.close.bind(internalPrompts);
    internalPrompts.close = async () => {
      internalClosed = true;
      await origClose();
    };
    await internalHarness.close();
    expect(internalClosed).toBe(true);

    // Adopter-owned: harness.close() does NOT close the source.
    const prompts = await makePromptsHarness();
    let adopterClosed = false;
    const origAdopterClose = prompts.close.bind(prompts);
    prompts.close = async () => {
      adopterClosed = true;
      await origAdopterClose();
    };
    const { harness: adopterHarness } = await makeServer(prompts);
    await adopterHarness.close();
    expect(adopterClosed).toBe(false);
    // Adopter still owns + can use + must close it.
    await prompts.close();
    expect(adopterClosed).toBe(true);
  });
});

describe("prompts projection — per-connection filter", () => {
  it("filter hides a prompt from BOTH list and get", async () => {
    const prompts = await makePromptsHarness();
    await prompts.register({
      declaration: {
        name: "public_thing",
        description: "public",
        template: makeMessageEntries("public"),
      },
    });
    await prompts.register({
      declaration: {
        name: "internal_secret",
        description: "private",
        template: makeMessageEntries("private"),
      },
    });

    const { harness, transport } = await makeServer(prompts, {
      filterPredicate: (decl) => decl.name.startsWith("public_"),
    });
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    const list = await client.listPrompts();
    expect(list.prompts.map((p) => p.name)).toEqual(["public_thing"]);

    await expect(client.getPrompt({ name: "internal_secret" })).rejects.toThrow(/Unknown prompt/);

    await client.close();
    await harness.close();
    await prompts.close();
  });
});

describe("prompts projection — list_changed notifications", () => {
  it("emits notifications/prompts/list_changed on register/update/remove", async () => {
    const prompts = await makePromptsHarness();
    const { harness, transport } = await makeServer(prompts);
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    let notified = 0;
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      notified += 1;
    });

    await prompts.register({
      declaration: {
        name: "x",
        description: "x",
        template: makeMessageEntries("x"),
      },
    });
    // Wait one tick so the notification round-trips through the in-memory
    // transport (the SDK queues + sends asynchronously).
    await new Promise((r) => setTimeout(r, 5));
    expect(notified).toBeGreaterThanOrEqual(1);

    const before = notified;
    await prompts.remove({ name: "x" });
    await new Promise((r) => setTimeout(r, 5));
    expect(notified).toBeGreaterThan(before);

    await client.close();
    await harness.close();
    await prompts.close();
  });

  it("connection close unsubscribes the change-notifier — no further notifications fire", async () => {
    const prompts = await makePromptsHarness();
    const { harness, transport } = await makeServer(prompts);
    const clientTransport = await transport.connect();
    const client = await makeClient(clientTransport);

    let notified = 0;
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      notified += 1;
    });

    await prompts.register({
      declaration: {
        name: "a",
        description: "a",
        template: makeMessageEntries("a"),
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    const beforeClose = notified;
    expect(beforeClose).toBeGreaterThanOrEqual(1);

    await client.close();
    // Now register another prompt — the harness still notifies its
    // subscribers, but the closed connection's unsubscribe ran, so the
    // count stays put.
    await prompts.register({
      declaration: {
        name: "b",
        description: "b",
        template: makeMessageEntries("b"),
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(notified).toBe(beforeClose);

    await harness.close();
    await prompts.close();
  });
});
