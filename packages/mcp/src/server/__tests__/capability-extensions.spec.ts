/**
 * `capabilities.extensions` — advertising MCP spec extensions in the
 * `initialize` result.
 *
 * The closed capability set is harness-verified ("no lying on the wire":
 * `capabilities.X = true` is a no-op when X isn't wired). Extensions are
 * the opposite: their surfaces are invisible to the harness, so the
 * adopter declares them and owns the truth of the claim. These pins hold
 * that asymmetry in place.
 *
 * Pins:
 *  - options validation: shape of the bag, non-empty keys, object values,
 *    and the DELIBERATE non-enforcement of a key format.
 *  - `buildCapabilities` merges verbatim, omits when absent/empty, copies
 *    rather than aliases, and does not resurrect an unwired capability.
 *  - over a real client on the in-memory pair, the extension reaches
 *    `getServerCapabilities().extensions` — using the MCP Apps `ui`
 *    negotiation shape, which conformant hosts require before they will
 *    render a `ui://` resource.
 *  - regression guard: absent option → advertised capabilities identical
 *    to before, with no `extensions` key on the wire.
 *  - the client harness surfaces extensions through `serverInfo`.
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import { McpServerConfigInvalid } from "@agentick/spec";

import {
  buildCapabilities,
  inMemoryServerTransport,
  McpServerHarness,
  validateOptions,
  type McpServerExtensionsOptions,
  type McpServerOptions,
  type WiredCapabilities,
} from "../index.js";
import { McpClientHarness, NoneAuth } from "../../index.js";

/**
 * The MCP Apps negotiation object. A conformant host refuses to render a
 * `ui://` resource unless the server advertised exactly this.
 */
const UI_EXTENSION = {
  "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
} as const satisfies McpServerExtensionsOptions;

const baseOptions: McpServerOptions = {
  name: "ext",
  transports: [inMemoryServerTransport()],
};

// ────────────────────────── options validation ──────────────────────────

describe("extensions — options validation", () => {
  it("accepts the MCP Apps ui extension", () => {
    expect(() => validateOptions({ ...baseOptions, extensions: UI_EXTENSION })).not.toThrow();
  });

  it("accepts an empty bag (advertises nothing, but is not an error)", () => {
    expect(() => validateOptions({ ...baseOptions, extensions: {} })).not.toThrow();
  });

  it("does NOT enforce a key format — reverse-DNS is convention, not grammar", () => {
    expect(() =>
      validateOptions({ ...baseOptions, extensions: { anything: {}, "x/y/z": {}, "42": {} } }),
    ).not.toThrow();
  });

  it("rejects a non-object bag", () => {
    for (const bad of ["nope", 7, null, () => {}]) {
      expect(() =>
        validateOptions({
          ...baseOptions,
          extensions: bad as unknown as McpServerExtensionsOptions,
        }),
      ).toThrow(McpServerConfigInvalid);
    }
  });

  it("rejects an array bag (a JSON array can never key extensions)", () => {
    expect(() =>
      validateOptions({ ...baseOptions, extensions: [] as unknown as McpServerExtensionsOptions }),
    ).toThrow(McpServerConfigInvalid);
  });

  it("rejects an empty-string key", () => {
    expect(() => validateOptions({ ...baseOptions, extensions: { "": {} } })).toThrow(
      McpServerConfigInvalid,
    );
  });

  it("rejects non-object values", () => {
    for (const bad of ["yes", true, null, [], () => {}]) {
      expect(() =>
        validateOptions({
          ...baseOptions,
          extensions: { "vendor/ext": bad } as unknown as McpServerExtensionsOptions,
        }),
      ).toThrow(McpServerConfigInvalid);
    }
  });

  it("reports the offending key on the error path", () => {
    try {
      validateOptions({
        ...baseOptions,
        extensions: { "vendor/ext": "nope" } as unknown as McpServerExtensionsOptions,
      });
      expect.unreachable("expected McpServerConfigInvalid");
    } catch (err) {
      expect(err).toBeInstanceOf(McpServerConfigInvalid);
      expect(String(err)).toContain("vendor/ext");
    }
  });
});

// ────────────────────────── buildCapabilities ──────────────────────────

const NOTHING_WIRED: WiredCapabilities = {
  tools: false,
  prompts: false,
  resources: false,
  elicitation: false,
  sampling: false,
  tasks: false,
  completions: false,
  logging: false,
};

const ALL_WIRED: WiredCapabilities = {
  tools: true,
  prompts: true,
  resources: true,
  elicitation: true,
  sampling: true,
  tasks: true,
  completions: true,
  logging: true,
};

describe("buildCapabilities — extensions merge", () => {
  it("merges the extensions bag verbatim", () => {
    const caps = buildCapabilities(NOTHING_WIRED, undefined, UI_EXTENSION);
    expect(caps.extensions).toEqual(UI_EXTENSION);
  });

  it("leaves the closed set byte-identical when extensions are absent", () => {
    // The regression guard: the two-arg call every pre-existing call site
    // makes must produce exactly what it produced before the slot existed.
    const before = buildCapabilities(ALL_WIRED, undefined);
    const after = buildCapabilities(ALL_WIRED, undefined, undefined);
    expect(after).toEqual(before);
    expect(before).not.toHaveProperty("extensions");
    expect(Object.keys(before)).toEqual([
      "tools",
      "prompts",
      "resources",
      "tasks",
      "completions",
      "logging",
    ]);
  });

  it("omits the key for an empty bag — an empty extensions map advertises nothing", () => {
    const caps = buildCapabilities(ALL_WIRED, undefined, {});
    expect(caps).not.toHaveProperty("extensions");
    expect(caps).toEqual(buildCapabilities(ALL_WIRED, undefined));
  });

  it("adds extensions WITHOUT disturbing the closed set", () => {
    const withExt = buildCapabilities(ALL_WIRED, { logging: false }, UI_EXTENSION);
    const without = buildCapabilities(ALL_WIRED, { logging: false });
    expect(withExt).toEqual({ ...without, extensions: UI_EXTENSION });
  });

  it("does not let an extension resurrect an unwired capability", () => {
    // Extensions live in their OWN namespace — no path from
    // `extensions.tools` to `capabilities.tools`.
    const caps = buildCapabilities(
      NOTHING_WIRED,
      { tools: true },
      { tools: { listChanged: true } },
    );
    expect(caps.tools).toBeUndefined();
    expect(caps.extensions).toEqual({ tools: { listChanged: true } });
  });

  it("copies the bag — a later mutation cannot rewrite a negotiated result", () => {
    const live: Record<string, object> = { "vendor/ext": { v: 1 } };
    const caps = buildCapabilities(NOTHING_WIRED, undefined, live);
    live["vendor/other"] = { v: 2 };
    expect(Object.keys(caps.extensions ?? {})).toEqual(["vendor/ext"]);
  });
});

// ────────────────────────── over the wire ──────────────────────────

async function connectInMemory(
  extensions: McpServerExtensionsOptions | undefined,
): Promise<{ client: McpClient; cleanup: () => Promise<void> }> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    `srv:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "ext",
      transports: [transport],
      serverInfo: { name: "test", version: "0.0.0" },
      ...(extensions !== undefined ? { extensions } : {}),
    },
  );
  await harness.ready;
  await harness.start();
  const client = new McpClient({ name: "c", version: "0.0.0" }, { capabilities: {} });
  await client.connect(await transport.connect());
  return {
    client,
    cleanup: async () => {
      await client.close();
      await harness.close();
    },
  };
}

describe("extensions — projected into a real client's initialize result", () => {
  it("surfaces the MCP Apps ui extension in getServerCapabilities()", async () => {
    const { client, cleanup } = await connectInMemory(UI_EXTENSION);
    expect(client.getServerCapabilities()?.extensions).toEqual({
      "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
    });
    await cleanup();
  });

  it("advertises nothing extra when the slot is absent, and only extensions when present", async () => {
    const bare = await connectInMemory(undefined);
    const baseline = bare.client.getServerCapabilities();
    expect(baseline).not.toHaveProperty("extensions");
    await bare.cleanup();

    const declared = await connectInMemory(UI_EXTENSION);
    // Identical to the baseline in every negotiated capability — the ONLY
    // delta is the extensions bag.
    expect(declared.client.getServerCapabilities()).toEqual({
      ...baseline,
      extensions: UI_EXTENSION,
    });
    await declared.cleanup();
  });

  it("advertises on EVERY connection, not just the first", async () => {
    const first = await connectInMemory(UI_EXTENSION);
    const second = await connectInMemory(UI_EXTENSION);
    expect(first.client.getServerCapabilities()?.extensions).toEqual(UI_EXTENSION);
    expect(second.client.getServerCapabilities()?.extensions).toEqual(UI_EXTENSION);
    await first.cleanup();
    await second.cleanup();
  });
});

// ────────────────────────── client-harness passthrough ──────────────────────────

describe("extensions — visible through the client harness", () => {
  it("carries extensions on McpServerInfo.capabilities", async () => {
    const transport = inMemoryServerTransport();
    const server = new McpServerHarness(
      `srv:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        name: "ext-client",
        transports: [transport],
        serverInfo: { name: "test", version: "0.0.0" },
        extensions: UI_EXTENSION,
      },
    );
    await server.ready;
    await server.start();

    const client = new McpClientHarness(
      "ext-client",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        serverId: "ext-client",
        transport: await transport.connect(),
        auth: new NoneAuth(),
      },
    );
    await client.ready;
    await client.connect();

    expect(client.serverInfo.capabilities?.extensions).toEqual(UI_EXTENSION);

    await client.close();
    await server.close();
  });
});
