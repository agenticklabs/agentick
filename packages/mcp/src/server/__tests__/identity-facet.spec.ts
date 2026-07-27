/**
 * The in-fiber MCP boundary facet — the credential's LEGITIMATE home.
 *
 * The redaction law (`identity-redaction.spec.ts`) keeps the authenticated
 * record out of the serialized audit trail. It must not keep it out of the
 * handler seams that legitimately need it: a tool handler calling a downstream
 * API on the caller's behalf, a per-connection filter deciding visibility, a
 * completion handler scoping its query to the caller. Those seams need the FULL
 * record — bearer token included — reachable in-fiber, on the ctx, and NEVER on
 * an `EventScope`.
 *
 * `ctx.mcp` (`McpRequestExtras`) is that facet. This suite pins which seams
 * carry it, pins the two that do NOT (with the reason — see the
 * `TODO(adr91-boundary-facets)` markers in `../projection/prompts.ts` and
 * `../projection/resources.ts`), and re-asserts the redaction law WITH the facet
 * live on every seam — so the facet cannot have leaked through any serialization
 * path.
 *
 * @see docs/proposals/v2/blueprint/92-operation-grammar-completion.md
 * @see ./identity-redaction.spec.ts — the law this must not break
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type {
  ContentBlock,
  McpAuthenticatedUser,
  McpRequestContext,
  OperationCtx,
  ProtocolEvent,
  ResourceContents,
  ToolDeclaration,
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import { PromptsHarness } from "@agentick/prompts";
import { ResourcesHarness } from "@agentick/resources";

import {
  inMemoryServerTransport,
  McpServerHarness,
  type CompletionContext,
  type PromptsFilter,
  type ResourcesFilter,
  type ToolsFilter,
} from "../index.js";

// ============================================================================
// Fixtures
// ============================================================================

const emptySchema = jsonSchema({ type: "object", properties: {}, additionalProperties: true });

const BEARER = "SECRET_TOKEN_VALUE";
const BEARER_FRAGMENT = "SECRET_TOKEN";

const TOKEN_BEARING_USER: McpAuthenticatedUser = {
  id: "user-42",
  displayName: "Ada",
  scopes: ["read:all"],
  token: BEARER,
};

const alwaysAda = {
  authenticator: async (): Promise<{ authenticated: true; user: McpAuthenticatedUser }> => ({
    authenticated: true,
    user: TOKEN_BEARING_USER,
  }),
};

function toolDecl(name: string): ToolDeclaration {
  return {
    id: name,
    name,
    description: `desc:${name}`,
    inputSchema: emptySchema,
    exposure: ["model"],
    handlerRef: `handler:${name}`,
  };
}

/** Read the MCP boundary facet off a seam ctx that is not statically typed for it. */
function facetUser(ctx: OperationCtx | undefined): Record<string, unknown> | undefined {
  const mcp = (ctx as { mcp?: { user?: Record<string, unknown> | null } } | undefined)?.mcp;
  return mcp?.user ?? undefined;
}

interface Rig {
  readonly harness: McpServerHarness;
  readonly journal: MemoryJournal;
  readonly events: ProtocolEvent[];
  readonly connect: () => Promise<McpClient>;
  readonly stop: () => Promise<void>;
}

async function rig(
  options: {
    readonly prompts?: PromptsHarness;
    readonly resources?: ResourcesHarness;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly completions?: any;
    readonly toolsFilter?: ToolsFilter;
    readonly promptsFilter?: PromptsFilter;
    readonly resourcesFilter?: ResourcesFilter;
    readonly toolHandler?: (ctx: McpRequestContext) => void;
  } = {},
): Promise<Rig> {
  const bus = new LocalEventBus();
  const journal = new MemoryJournal({ capacity: 4096 });
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(`srv:${ulid()}`, journal, bus, new LocalInbox(), {
    name: "facet-test",
    serverInfo: { name: "facet-test", version: "0.0.0" },
    transports: [transport],
    tools: {
      registry: [toolDecl("echo")],
      resolveHandler: () => async (_input, ctx) => {
        options.toolHandler?.(ctx);
        return { kind: "inline", content: [{ type: "text", text: "ok" }] as ContentBlock[] };
      },
      ...(options.toolsFilter ? { filter: options.toolsFilter } : {}),
    },
    ...(options.prompts
      ? {
          prompts: {
            use: options.prompts,
            ...(options.promptsFilter ? { filter: options.promptsFilter } : {}),
          },
        }
      : {}),
    ...(options.resources
      ? {
          resources: {
            use: options.resources,
            ...(options.resourcesFilter ? { filter: options.resourcesFilter } : {}),
          },
        }
      : {}),
    ...(options.completions ? { completions: options.completions } : {}),
    auth: alwaysAda,
  });
  await harness.ready;
  await harness.start();

  const events: ProtocolEvent[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe({ surface: "mcpServer" }), (e) =>
      Effect.sync(() => {
        events.push(e);
      }),
    ),
  );

  const clients: McpClient[] = [];
  return {
    harness,
    journal,
    events,
    connect: async (): Promise<McpClient> => {
      const clientTransport = await transport.connect();
      const client = new McpClient({ name: "c", version: "0.0.0" }, { capabilities: {} });
      await client.connect(clientTransport as unknown as Transport);
      clients.push(client);
      return client;
    },
    stop: async (): Promise<void> => {
      for (const c of clients) await c.close().catch(() => {});
      await harness.close();
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function substrate(): [MemoryJournal, LocalEventBus, LocalInbox] {
  return [new MemoryJournal({}), new LocalEventBus(), new LocalInbox()];
}

async function journaled(journal: MemoryJournal): Promise<readonly ProtocolEvent[]> {
  const out = await Effect.runPromise(Stream.runCollect(journal.readByQuery({}, "beginning")));
  return Array.from(out);
}

let active: Rig | undefined;
afterEach(async () => {
  await active?.stop();
  active = undefined;
});

// ============================================================================
// 1 — the seams that carry the facet
// ============================================================================

describe("the mcp facet reaches the in-fiber seams", () => {
  it("a tool handler reads ctx.mcp.user.token over a real authenticated crossing", async () => {
    let seen: McpRequestContext | undefined;
    const r = (active = await rig({
      toolHandler: (ctx) => {
        seen = ctx;
      },
    }));
    const client = await r.connect();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await settle();

    // The trunk identity is the REDACTED projection …
    expect(seen?.identity?.principal).toBe("user-42");
    expect(seen?.identity?.user).not.toHaveProperty("token");
    // … and the facet is the full record, statically typed.
    expect(seen?.mcp?.user).toEqual(TOKEN_BEARING_USER);
  });

  it("a completion handler reads ctx.mcp.user.token over a real authenticated crossing", async () => {
    const prompts = new PromptsHarness("pr", ...substrate());
    await prompts.ready;
    await prompts.register({ declaration: { name: "greet", description: "g", template: "hi" } });

    let token: unknown;
    let seen: CompletionContext | undefined;
    const r = (active = await rig({
      prompts,
      completions: {
        prompts: {
          greet: {
            who: (_value: string, ctx: CompletionContext) => {
              seen = ctx;
              // Statically typed via `CompletionContext.mcp` — no cast.
              token = ctx.mcp?.user?.token;
              return { values: ["world"] };
            },
          },
        },
      },
    }));
    const client = await r.connect();
    await client.complete({
      ref: { type: "ref/prompt", name: "greet" },
      argument: { name: "who", value: "w" },
    });
    await settle();

    expect(seen?.identity?.principal).toBe("user-42");
    expect(seen?.identity?.user).not.toHaveProperty("token");
    expect(seen?.mcp?.user).toEqual(TOKEN_BEARING_USER);
    expect(token).toBe(BEARER);
  });

  it("all three per-connection filters read ctx.mcp.user.token", async () => {
    const prompts = new PromptsHarness("pr", ...substrate());
    await prompts.ready;
    await prompts.register({ declaration: { name: "greet", description: "g", template: "hi" } });
    const resources = new ResourcesHarness("res", ...substrate());
    await resources.ready;
    resources.register("mem://a", (uri) => [{ uri, text: "A" } as ResourceContents]);

    const seen: Record<string, unknown> = {};
    const r = (active = await rig({
      prompts,
      resources,
      toolsFilter: (_tool, ctx) => {
        seen.tools = ctx.mcp?.user?.token;
        return true;
      },
      promptsFilter: (_decl, ctx) => {
        seen.prompts = ctx.mcp?.user?.token;
        return true;
      },
      resourcesFilter: (_descriptor, ctx) => {
        seen.resources = ctx.mcp?.user?.token;
        return true;
      },
    }));
    const client = await r.connect();
    await client.listTools();
    await client.listPrompts();
    await client.listResources();
    await settle();

    expect(seen).toEqual({ tools: BEARER, prompts: BEARER, resources: BEARER });
  });
});

// ============================================================================
// 2 — the seams that do NOT (yet) carry it, and what they DO get
// ============================================================================

describe("the harness-minted seams get the redacted trunk only", () => {
  // These two are reached THROUGH a harness command, so their ctx is minted by
  // `PromptsHarness` / `ResourcesHarness` from the `RuntimeContextRef` trunk —
  // and everything on that trunk is copied onto the child op's `EventScope` by
  // `inheritScope`, hence journaled. Threading the facet there needs an
  // unserialized boundary-facet channel in `@agentick/runtime`; see the
  // `TODO(adr91-boundary-facets)` markers in the two projections. Pinned as-is
  // so the gap is visible and this suite fails loudly once that lands.

  it("a prompt render reads the credential off the mcp facet, journal-invisible", async () => {
    const prompts = new PromptsHarness("pr", ...substrate());
    await prompts.ready;
    let seen: OperationCtx | undefined;
    await prompts.register({
      declaration: {
        name: "whoami",
        description: "w",
        render: (_args, ctx) => {
          seen = ctx;
          return "you";
        },
      },
    });

    const r = (active = await rig({ prompts }));
    const client = await r.connect();
    await client.getPrompt({ name: "whoami" });
    await settle();

    // The REDACTED twin is what the trunk (and therefore the journal) carries.
    expect(seen?.identity?.principal).toBe("user-42");
    expect(seen?.identity?.scopes).toEqual(["read:all"]);
    expect(seen?.identity?.user).not.toHaveProperty("token");
    // The credential arrives on the BOUNDARY facet — in-fiber, never serialized.
    expect(facetUser(seen)?.["token"]).toBe(BEARER);
  });

  it("a resource resolver reads the credential off the mcp facet too", async () => {
    const resources = new ResourcesHarness("res", ...substrate());
    await resources.ready;
    let seen: OperationCtx | undefined;
    resources.register("mem://who", (uri, ctx) => {
      seen = ctx;
      return [{ uri, text: "A" } as ResourceContents];
    });

    const r = (active = await rig({ resources }));
    const client = await r.connect();
    await client.readResource({ uri: "mem://who" });
    await settle();

    expect(seen?.identity?.principal).toBe("user-42");
    expect(seen?.identity?.user).not.toHaveProperty("token");
    expect(facetUser(seen)?.["token"]).toBe(BEARER);
  });
});

// ============================================================================
// 3 — the facet is ctx-only: it never reaches the journal or the bus
// ============================================================================

describe("the facet never leaks through a serialization path", () => {
  it("with every seam exercised, no envelope carries the credential", async () => {
    const prompts = new PromptsHarness("pr", ...substrate());
    await prompts.ready;
    await prompts.register({
      declaration: { name: "whoami", description: "w", render: () => "you" },
    });
    const resources = new ResourcesHarness("res", ...substrate());
    await resources.ready;
    resources.register("mem://who", (uri) => [{ uri, text: "A" } as ResourceContents]);

    // Every seam TOUCHES the facet — a leak would have to survive a real read.
    let touched = 0;
    const r = (active = await rig({
      prompts,
      resources,
      toolsFilter: (_t, ctx) => {
        touched += ctx.mcp?.user?.token === BEARER ? 1 : 0;
        return true;
      },
      toolHandler: (ctx) => {
        touched += ctx.mcp?.user?.token === BEARER ? 1 : 0;
      },
      completions: {
        prompts: {
          whoami: {
            who: (_v: string, ctx: CompletionContext) => {
              touched += ctx.mcp?.user?.token === BEARER ? 1 : 0;
              return { values: ["w"] };
            },
          },
        },
      },
    }));
    const client = await r.connect();
    await client.listTools();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await client.getPrompt({ name: "whoami" });
    await client.readResource({ uri: "mem://who" });
    await client.complete({
      ref: { type: "ref/prompt", name: "whoami" },
      argument: { name: "who", value: "w" },
    });
    await settle();

    // Non-vacuity #1: the facet really was read, with the real credential, on
    // three seams (list-tools filter, call-tool filter + handler, completion).
    expect(touched).toBeGreaterThanOrEqual(4);

    const busSerialized = JSON.stringify(r.events);
    expect(busSerialized).not.toContain(BEARER);
    expect(busSerialized).not.toContain(BEARER_FRAGMENT);
    const journalSerialized = JSON.stringify(await journaled(r.journal));
    expect(journalSerialized).not.toContain(BEARER);
    expect(journalSerialized).not.toContain(BEARER_FRAGMENT);

    // Non-vacuity #2: every crossing WAS observed, and the principal IS there.
    for (const verb of [
      "list-tools",
      "call-tool",
      "get-prompt",
      "read-resource",
      "complete",
    ] as const) {
      expect(busSerialized).toContain(`mcp:command:${verb}`);
    }
    expect(busSerialized).toContain("user-42");
    expect(journalSerialized).toContain("mcp:command:call-tool");
  });
});
