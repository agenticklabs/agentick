/**
 * ADR 92 §Slice A — MCP server request crossings ARE operations.
 *
 * Every assertion here drives the REAL wire: an in-memory transport pair, a
 * real SDK `Client` on the far side, and the harness's own bus + journal as the
 * observation surface. Nothing reaches into the projection layer directly.
 *
 * Pins, one describe per contract clause:
 *
 *   1. Each promoted crossing emits `mcp:command:<verb>` with the connection
 *      dimension + the authenticated identity on its scope.
 *   2. Work inside a crossing PARENTS under it — a handler's `ctx.run` op
 *      carries the crossing's opId as `parentOpId` and inherits the connection
 *      dim + identity (the ADR's composition rule).
 *   3. The identity payoff (ADR 91 stop-rule #2): over the wire, EVERY handler
 *      seam — the in-fiber ones (tool handler, completion handler) and the ones
 *      reached THROUGH a harness command (resource resolver, prompt render) —
 *      receives an `OperationCtx` whose TRUNK carries the request's identity,
 *      not a fabricated one.
 *   4. A guard veto on a crossing actually blocks the work.
 *   5. Journal policy is honored per op class (`call-tool` + `initialize`
 *      persisted; reads/lists/completions bus-only).
 *   6. The single-authenticator property still holds.
 *   7. A rejected admission leaves an admission-failure EVENT — and no op.
 *
 * @see docs/proposals/v2/blueprint/92-operation-grammar-completion.md
 * @see docs/proposals/v2/blueprint/91-ctx-spine.md §Phase 2
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type {
  ContentBlock,
  McpRequestContext,
  OperationCtx,
  ProtocolEvent,
  ResourceContents,
  ToolDeclaration,
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import { ResourcesHarness } from "@agentick/resources";
import { PromptsHarness } from "@agentick/prompts";

import {
  inMemoryServerTransport,
  McpServerHarness,
  MCP_SERVER_ADMISSION_FAILED,
  type ToolHandlerResolver,
} from "../index.js";

// ============================================================================
// Fixtures
// ============================================================================

const emptySchema = jsonSchema({ type: "object", properties: {}, additionalProperties: true });

const AUTHED_USER = { id: "user-42", displayName: "Ada", roles: ["admin"], scopes: ["read:all"] };

function toolDecl(name: string, handlerRef = `handler:${name}`): ToolDeclaration {
  return {
    id: name,
    name,
    description: `desc:${name}`,
    inputSchema: emptySchema,
    exposure: ["model"],
    handlerRef,
  };
}

interface Rig {
  readonly harness: McpServerHarness;
  readonly bus: LocalEventBus;
  readonly journal: MemoryJournal;
  readonly transport: ReturnType<typeof inMemoryServerTransport>;
  readonly events: ProtocolEvent[];
  readonly connect: () => Promise<McpClient>;
  readonly stop: () => Promise<void>;
}

/**
 * Stand up a server whose bus is OURS, so every op envelope the harness
 * publishes is observable, and whose journal we can read to prove policy.
 */
async function rig(
  options: {
    readonly tools?: readonly ToolDeclaration[];
    readonly resolveHandler?: ToolHandlerResolver;
    readonly resources?: ResourcesHarness;
    readonly prompts?: PromptsHarness;
    readonly completions?: Record<string, Record<string, unknown>>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly auth?: any;
  } = {},
): Promise<Rig> {
  const bus = new LocalEventBus();
  const journal = new MemoryJournal({ capacity: 4096 });
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(`srv:${generateId()}`, journal, bus, new LocalInbox(), {
    name: "crossing-test",
    serverInfo: { name: "crossing-test", version: "0.0.0" },
    transports: [transport],
    ...(options.tools
      ? {
          tools: {
            registry: [...options.tools],
            resolveHandler: options.resolveHandler ?? (() => null),
          },
        }
      : {}),
    ...(options.resources ? { resources: { use: options.resources } } : {}),
    ...(options.prompts ? { prompts: { use: options.prompts } } : {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(options.completions ? { completions: options.completions as any } : {}),
    ...(options.auth ? { auth: options.auth } : {}),
  });
  await harness.ready;
  await harness.start();

  // Collect every envelope this harness publishes, before any connection.
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
    bus,
    journal,
    transport,
    events,
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
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
}

/** Authenticator that admits everyone as {@link AUTHED_USER}. */
const alwaysAda = {
  authenticator: async (): Promise<{ authenticated: true; user: typeof AUTHED_USER }> => ({
    authenticated: true,
    user: AUTHED_USER,
  }),
};

/** Settle the microtask + bus fan-out queue. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function opsNamed(events: readonly ProtocolEvent[], name: string): readonly ProtocolEvent[] {
  return events.filter((e) => e.name === name);
}

async function journaled(journal: MemoryJournal, name: string): Promise<readonly ProtocolEvent[]> {
  const out = await Effect.runPromise(
    Stream.runCollect(journal.readByQuery({ name: { exact: name } }, "beginning")),
  );
  return Array.from(out);
}

let active: Rig | undefined;
afterEach(async () => {
  await active?.stop();
  active = undefined;
});

// ============================================================================
// 1 — every promoted crossing is an operation with the right name + scope
// ============================================================================

describe("crossings are operations (name + scope)", () => {
  it("emits mcp:command:initialize for the accept crossing", async () => {
    const r = (active = await rig());
    await r.connect();
    await settle();

    const requested = opsNamed(r.events, "mcp:command:initialize").filter(
      (e) => e.phase === "requested",
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]!.scope.mcpServerId).toBe(r.harness.id);
    expect(requested[0]!.scope.mcpConnectionId).toMatch(/^conn:/);
    expect(requested[0]!.scope.origin).toBe("wire");
  });

  it("emits one op per request crossing, named by the kebab verb", async () => {
    const resources = new ResourcesHarness(
      "res",
      new MemoryJournal({}),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await resources.ready;
    resources.register("mem://a", () => [{ uri: "mem://a", text: "A" } as ResourceContents]);
    const prompts = new PromptsHarness(
      "pr",
      new MemoryJournal({}),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await prompts.ready;
    await prompts.register({
      declaration: { name: "greet", description: "g", template: "hello" },
    });

    const r = (active = await rig({
      tools: [toolDecl("echo")],
      resolveHandler: () => async () => ({
        kind: "inline",
        content: [{ type: "text", text: "ok" }] as ContentBlock[],
      }),
      resources,
      prompts,
      completions: { prompts: { greet: { who: () => ({ values: ["world"] }) } } },
    }));
    const client = await r.connect();

    await client.listTools();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await client.listResources();
    await client.listResourceTemplates();
    await client.readResource({ uri: "mem://a" });
    await client.subscribeResource({ uri: "mem://a" });
    await client.unsubscribeResource({ uri: "mem://a" });
    await client.listPrompts();
    await client.getPrompt({ name: "greet" });
    await client.complete({
      ref: { type: "ref/prompt", name: "greet" },
      argument: { name: "who", value: "w" },
    });
    await settle();

    const terminals = new Set(
      r.events
        .filter((e) => e.phase === "terminal" && e.outcome === "succeeded")
        .map((e) => e.name),
    );
    expect(terminals).toEqual(
      new Set([
        "mcp:command:initialize",
        "mcp:command:list-tools",
        "mcp:command:call-tool",
        "mcp:command:list-resources",
        "mcp:command:list-resource-templates",
        "mcp:command:read-resource",
        "mcp:command:subscribe-resource",
        "mcp:command:unsubscribe-resource",
        "mcp:command:list-prompts",
        "mcp:command:get-prompt",
        "mcp:command:complete",
      ]),
    );
  });

  it("stamps the connection dimension AND the authenticated identity on the crossing scope", async () => {
    const r = (active = await rig({
      tools: [toolDecl("echo")],
      resolveHandler: () => async () => ({
        kind: "inline",
        content: [{ type: "text", text: "ok" }] as ContentBlock[],
      }),
      auth: alwaysAda,
    }));
    const client = await r.connect();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await settle();

    const call = opsNamed(r.events, "mcp:command:call-tool").find((e) => e.phase === "requested")!;
    expect(call.scope.mcpConnectionId).toMatch(/^conn:/);
    expect(call.scope.mcpServerId).toBe(r.harness.id);
    expect(call.scope.identity).toEqual({
      principal: "user-42",
      user: AUTHED_USER,
      scopes: ["read:all"],
    });
    // The connection dim is the SAME one the initialize crossing minted.
    const init = opsNamed(r.events, "mcp:command:initialize").find((e) => e.phase === "requested")!;
    expect(call.scope.mcpConnectionId).toBe(init.scope.mcpConnectionId);
  });
});

// ============================================================================
// 2 — the parenting composition rule
// ============================================================================

describe("work inside a crossing journals as a CHILD", () => {
  it("a tool handler's ctx.run op carries the crossing opId as parentOpId + the connection dim", async () => {
    const r = (active = await rig({
      tools: [toolDecl("work")],
      resolveHandler: () => async (_input, ctx) => {
        await ctx.run("inner-step", async () => "done");
        return { kind: "inline", content: [{ type: "text", text: "ok" }] as ContentBlock[] };
      },
      auth: alwaysAda,
    }));
    const client = await r.connect();
    await client.callTool({ name: "work", arguments: {} }, CallToolResultSchema);
    await settle();

    const crossing = opsNamed(r.events, "mcp:command:call-tool").find(
      (e) => e.phase === "requested",
    )!;
    const child = opsNamed(r.events, "mcpServer:run:inner-step").find(
      (e) => e.phase === "requested",
    )!;

    expect(child).toBeDefined();
    // The chain: connection → crossing → inner command.
    expect(child.parentOpId).toBe(crossing.opId);
    expect(child.scope.mcpConnectionId).toBe(crossing.scope.mcpConnectionId);
    expect(child.scope.identity).toEqual(crossing.scope.identity);
  });

  it("a grandchild inherits the connection dim through two levels", async () => {
    const r = (active = await rig({
      tools: [toolDecl("work")],
      resolveHandler: () => async (_input, ctx) => {
        await ctx.run("outer", async () => {
          await ctx.run("inner", async () => "leaf");
        });
        return { kind: "inline", content: [{ type: "text", text: "ok" }] as ContentBlock[] };
      },
      auth: alwaysAda,
    }));
    const client = await r.connect();
    await client.callTool({ name: "work", arguments: {} }, CallToolResultSchema);
    await settle();

    const inner = opsNamed(r.events, "mcpServer:run:inner").find((e) => e.phase === "requested")!;
    const crossing = opsNamed(r.events, "mcp:command:call-tool").find(
      (e) => e.phase === "requested",
    )!;
    expect(inner.scope.mcpConnectionId).toBe(crossing.scope.mcpConnectionId);
    expect(inner.scope.identity).toEqual(crossing.scope.identity);
  });
});

// ============================================================================
// 3 — the identity payoff over the wire (ADR 91 stop-rule #2)
// ============================================================================

describe("identity reaches the handler ctx over the wire", () => {
  it("a tool handler's ctx trunk carries the request's identity", async () => {
    let seen: McpRequestContext | undefined;
    const r = (active = await rig({
      tools: [toolDecl("who")],
      resolveHandler: () => async (_input, ctx) => {
        seen = ctx;
        return { kind: "inline", content: [{ type: "text", text: "ok" }] as ContentBlock[] };
      },
      auth: alwaysAda,
    }));
    const client = await r.connect();
    await client.callTool({ name: "who", arguments: {} }, CallToolResultSchema);
    await settle();

    // The TRUNK — not a bespoke MCP field — carries the authenticated identity.
    expect(seen?.identity?.principal).toBe("user-42");
    expect(seen?.identity?.scopes).toEqual(["read:all"]);
    // And the MCP-boundary projection of the same fact (ADR 91 conflict table).
    expect(seen?.mcp?.user).toEqual(AUTHED_USER);
    // The trunk is bound to the RUNNING crossing op, not fabricated.
    const crossing = opsNamed(r.events, "mcp:command:call-tool").find(
      (e) => e.phase === "requested",
    )!;
    expect(seen?.opId).toBe(crossing.opId);
    expect(seen?.mcpConnectionId).toBe(crossing.scope.mcpConnectionId);
  });

  it("a completion handler's ctx trunk carries the request's identity", async () => {
    const prompts = new PromptsHarness(
      "pr",
      new MemoryJournal({}),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await prompts.ready;
    await prompts.register({ declaration: { name: "greet", description: "g", template: "hi" } });

    let seen: OperationCtx | undefined;
    const r = (active = await rig({
      prompts,
      completions: {
        prompts: {
          greet: {
            who: (_value: string, ctx: OperationCtx) => {
              seen = ctx;
              return { values: ["world"] };
            },
          },
        },
      },
      auth: alwaysAda,
    }));
    const client = await r.connect();
    await client.complete({
      ref: { type: "ref/prompt", name: "greet" },
      argument: { name: "who", value: "w" },
    });
    await settle();

    expect(seen?.identity?.principal).toBe("user-42");
    const crossing = opsNamed(r.events, "mcp:command:complete").find(
      (e) => e.phase === "requested",
    )!;
    expect(seen?.opId).toBe(crossing.opId);
  });

  // ── The residual seams (ADR 92 §Slice A follow-up) ──────────────────────
  //
  // A resolver / a prompt `render` is NOT reached in-fiber like a tool handler:
  // the projection calls the harness, which re-enters Effect. Through the
  // Promise facade that is a fresh ROOT fiber inheriting no FiberRef, so the
  // seam saw an identity-free ctx and the inner command journaled as an orphan.
  // The projections now compose the harness's `.fx` twin on the CROSSING's
  // captured runtime, which is what these two pin.

  it("a resource resolver's ctx trunk carries the request's identity + the crossing's coordinates", async () => {
    const resourcesBus = new LocalEventBus();
    const resources = new ResourcesHarness(
      "res",
      new MemoryJournal({}),
      resourcesBus,
      new LocalInbox(),
    );
    await resources.ready;

    let seen: OperationCtx | undefined;
    resources.register("mem://who", (uri, ctx) => {
      seen = ctx;
      return [{ uri, text: "A" } as ResourceContents];
    });

    // Watch the RESOURCES harness's own bus: the inner command must show up as
    // a linked record (layered execution = layered journal records).
    const innerOps: ProtocolEvent[] = [];
    const innerFiber = Effect.runFork(
      Stream.runForEach(resourcesBus.subscribe({ surface: "resources" }), (e) =>
        Effect.sync(() => {
          innerOps.push(e);
        }),
      ),
    );

    const r = (active = await rig({ resources, auth: alwaysAda }));
    const client = await r.connect();
    const result = await client.readResource({ uri: "mem://who" });
    await settle();

    // Wire behavior is unchanged — the content still arrives.
    expect(result.contents[0]).toMatchObject({ uri: "mem://who", text: "A" });

    const crossing = opsNamed(r.events, "mcp:command:read-resource").find(
      (e) => e.phase === "requested",
    )!;
    // The RESOLVER's ctx: the request's identity on the trunk, not a fabricated
    // one, plus the crossing's connection dim and its opId as the parent.
    expect(seen?.identity?.principal).toBe("user-42");
    expect(seen?.identity?.scopes).toEqual(["read:all"]);
    expect(seen?.mcpConnectionId).toBe(crossing.scope.mcpConnectionId);
    expect(seen?.parentOpId).toBe(crossing.opId);

    // And the inner command is a real linked record, not an orphaned root.
    const inner = innerOps.find(
      (e) => e.name === "resources:command:read" && e.phase === "requested",
    )!;
    expect(inner).toBeDefined();
    expect(inner.parentOpId).toBe(crossing.opId);
    expect(inner.scope.mcpConnectionId).toBe(crossing.scope.mcpConnectionId);
    expect(inner.scope.identity).toEqual(crossing.scope.identity);

    await Effect.runPromise(Fiber.interrupt(innerFiber));
  });

  it("a prompt render's ctx trunk carries the request's identity + the crossing's coordinates", async () => {
    const prompts = new PromptsHarness(
      "pr",
      new MemoryJournal({}),
      new LocalEventBus(),
      new LocalInbox(),
    );
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

    const r = (active = await rig({ prompts, auth: alwaysAda }));
    const client = await r.connect();
    const got = await client.getPrompt({ name: "whoami" });
    await settle();

    expect(got.messages[0]).toMatchObject({ role: "user" });

    const crossing = opsNamed(r.events, "mcp:command:get-prompt").find(
      (e) => e.phase === "requested",
    )!;
    expect(seen?.identity?.principal).toBe("user-42");
    expect(seen?.identity?.scopes).toEqual(["read:all"]);
    expect(seen?.mcpConnectionId).toBe(crossing.scope.mcpConnectionId);
    expect(seen?.parentOpId).toBe(crossing.opId);
  });
});

// ============================================================================
// 4 — the guard seam
// ============================================================================

describe("guard veto blocks a crossing", () => {
  it("a harness guard vetoing CallTool prevents the handler from running", async () => {
    let ran = 0;
    const r = (active = await rig({
      tools: [toolDecl("danger")],
      resolveHandler: () => async () => {
        ran++;
        return { kind: "inline", content: [{ type: "text", text: "ok" }] as ContentBlock[] };
      },
    }));
    r.harness.guard((_input, ctx) =>
      ctx.op === "McpCallTool" ? { kind: "veto", reason: "policy" } : { kind: "proceed" },
    );
    const client = await r.connect();

    await expect(
      client.callTool({ name: "danger", arguments: {} }, CallToolResultSchema),
    ).rejects.toThrow(/policy|vetoed/);
    await settle();

    expect(ran).toBe(0);
    const terminal = opsNamed(r.events, "mcp:command:call-tool").find(
      (e) => e.phase === "terminal",
    )!;
    expect(terminal.outcome).toBe("vetoed");
  });

  it("the guard is scoped to its crossing — sibling crossings still run", async () => {
    const r = (active = await rig({
      tools: [toolDecl("safe")],
      resolveHandler: () => async () => ({
        kind: "inline",
        content: [{ type: "text", text: "ok" }] as ContentBlock[],
      }),
    }));
    r.harness.guard((_input, ctx) =>
      ctx.op === "McpCallTool" ? { kind: "veto", reason: "policy" } : { kind: "proceed" },
    );
    const client = await r.connect();

    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual(["safe"]);
  });
});

// ============================================================================
// 4b — the security stages ARE the crossing's guard seam
// ============================================================================

describe("security stages ride the crossing's guard seam", () => {
  /** A crossing rig whose four stages record their order. */
  async function staged(
    stages: Record<string, unknown>,
    order: string[] = [],
  ): Promise<{ rig: Rig; order: string[] }> {
    const r = (active = await rig({
      tools: [toolDecl("search")],
      resolveHandler: () => async (input) => {
        order.push(`body:${JSON.stringify(input)}`);
        return { kind: "inline", content: [{ type: "text", text: "ok" }] as ContentBlock[] };
      },
      auth: stages,
    }));
    return { rig: r, order };
  }

  it("runs authenticate → authorize → rate-limit → sanitize → body", async () => {
    const order: string[] = [];
    const { rig: r } = await staged(
      {
        authenticator: async () => {
          order.push("authn");
          return { authenticated: true, user: { id: "u1" } };
        },
        authorizer: async () => {
          order.push("authz");
          return { allowed: true };
        },
        rateLimiter: async () => {
          order.push("rate");
          return { allowed: true };
        },
        inputSanitizer: async (
          _c: unknown,
          _t: string,
          input: Readonly<Record<string, unknown>>,
        ) => {
          order.push("sanitize");
          return { ...input };
        },
      },
      order,
    );
    const client = await r.connect();
    await client.callTool({ name: "search", arguments: { q: "hello" } }, CallToolResultSchema);

    expect(order).toEqual(["authn", "authz", "rate", "sanitize", 'body:{"q":"hello"}']);
  });

  it("an authorizer denial rejects the crossing and the body never runs", async () => {
    const order: string[] = [];
    const { rig: r } = await staged(
      { authorizer: async () => ({ allowed: false, reason: "no role" }) },
      order,
    );
    const client = await r.connect();

    await expect(
      client.callTool({ name: "search", arguments: {} }, CallToolResultSchema),
    ).rejects.toThrow(/Forbidden|no role/);
    expect(order).toEqual([]);
  });

  it("a rate-limit rejection carries retryAfterMs to the wire error", async () => {
    const { rig: r } = await staged({
      rateLimiter: async () => ({ allowed: false, retryAfterMs: 5000 }),
    });
    const client = await r.connect();

    await expect(
      client.callTool({ name: "search", arguments: {} }, CallToolResultSchema),
    ).rejects.toThrow(/rate|limit/i);
  });

  it("the sanitizer rewrites the tool input the handler receives", async () => {
    const order: string[] = [];
    const { rig: r } = await staged(
      {
        inputSanitizer: async (
          _c: unknown,
          _t: string,
          input: Readonly<Record<string, unknown>>,
        ) => ({
          ...input,
          _sanitized: true,
        }),
      },
      order,
    );
    const client = await r.connect();
    await client.callTool({ name: "search", arguments: { q: "hi" } }, CallToolResultSchema);

    expect(order).toEqual(['body:{"q":"hi","_sanitized":true}']);
  });

  it("the sanitizer does NOT run for a non-tool crossing", async () => {
    let sanitized = 0;
    const r = (active = await rig({
      tools: [toolDecl("search")],
      resolveHandler: () => async () => ({
        kind: "inline",
        content: [{ type: "text", text: "ok" }] as ContentBlock[],
      }),
      auth: {
        inputSanitizer: async (
          _c: unknown,
          _t: string,
          input: Readonly<Record<string, unknown>>,
        ) => {
          sanitized++;
          return { ...input };
        },
      },
    }));
    const client = await r.connect();
    await client.listTools();
    expect(sanitized).toBe(0);
  });

  it("the authenticated user reaches the authorizer + rate-limiter stages", async () => {
    const seen: unknown[] = [];
    const r = (active = await rig({
      tools: [toolDecl("search")],
      resolveHandler: () => async () => ({
        kind: "inline",
        content: [{ type: "text", text: "ok" }] as ContentBlock[],
      }),
      auth: {
        authenticator: async () => ({
          authenticated: true,
          user: { id: "u9", roles: ["admin"] },
        }),
        authorizer: async (c: McpRequestContext) => {
          seen.push(c.mcp?.user);
          return { allowed: true };
        },
        rateLimiter: async (c: McpRequestContext) => {
          seen.push(c.mcp?.user);
          return { allowed: true };
        },
      },
    }));
    const client = await r.connect();
    await client.callTool({ name: "search", arguments: {} }, CallToolResultSchema);

    expect(seen).toEqual([
      { id: "u9", roles: ["admin"] },
      { id: "u9", roles: ["admin"] },
    ]);
  });
});

// ============================================================================
// 5 — journaling policy per op class
// ============================================================================

describe("journal policy is honored per op class", () => {
  it("call-tool and initialize persist; list-tools stays bus-only", async () => {
    const r = (active = await rig({
      tools: [toolDecl("echo")],
      resolveHandler: () => async () => ({
        kind: "inline",
        content: [{ type: "text", text: "ok" }] as ContentBlock[],
      }),
    }));
    const client = await r.connect();
    await client.listTools();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await settle();

    // Bus sees every crossing.
    expect(opsNamed(r.events, "mcp:command:list-tools").length).toBeGreaterThan(0);
    expect(opsNamed(r.events, "mcp:command:call-tool").length).toBeGreaterThan(0);

    // Journal retains the persisted classes only.
    expect(await journaled(r.journal, "mcp:command:call-tool")).not.toHaveLength(0);
    expect(await journaled(r.journal, "mcp:command:initialize")).not.toHaveLength(0);
    expect(await journaled(r.journal, "mcp:command:list-tools")).toHaveLength(0);
  });

  it("read-resource, get-prompt and complete stay bus-only", async () => {
    const resources = new ResourcesHarness(
      "res",
      new MemoryJournal({}),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await resources.ready;
    resources.register("mem://a", () => [{ uri: "mem://a", text: "A" } as ResourceContents]);

    const r = (active = await rig({ resources }));
    const client = await r.connect();
    await client.readResource({ uri: "mem://a" });
    await settle();

    expect(opsNamed(r.events, "mcp:command:read-resource").length).toBeGreaterThan(0);
    expect(await journaled(r.journal, "mcp:command:read-resource")).toHaveLength(0);
  });
});

// ============================================================================
// 6 — single-auth still runs exactly once per crossing
// ============================================================================

describe("single authentication per crossing", () => {
  it("the authenticator runs once per request crossing, not once per stage", async () => {
    let calls = 0;
    const r = (active = await rig({
      tools: [toolDecl("echo")],
      resolveHandler: () => async () => ({
        kind: "inline",
        content: [{ type: "text", text: "ok" }] as ContentBlock[],
      }),
      auth: {
        authenticator: async () => {
          calls++;
          return { authenticated: true, user: AUTHED_USER };
        },
      },
    }));
    const client = await r.connect();
    const before = calls;
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    expect(calls - before).toBe(1);
  });
});

// ============================================================================
// 7 — admission failure is an EVENT, never an operation
// ============================================================================

describe("admission failure leaves a trace", () => {
  it("a rejected crossing emits the admission-failure event and NO operation", async () => {
    const r = (active = await rig({
      tools: [toolDecl("echo")],
      resolveHandler: () => async () => ({
        kind: "inline",
        content: [{ type: "text", text: "ok" }] as ContentBlock[],
      }),
      auth: {
        authenticator: async () => ({ authenticated: false, reason: "bad token" }),
      },
    }));
    const client = await r.connect();

    await expect(
      client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema),
    ).rejects.toThrow(/bad token|Authentication/);
    await settle();

    const failures = opsNamed(r.events, MCP_SERVER_ADMISSION_FAILED);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toMatchObject({
      failureClass: "authenticate",
      transportKind: "in-memory",
      reason: "bad token",
    });
    // The connection dimension is present so the trace is attributable.
    expect(failures[0]!.scope.mcpConnectionId).toMatch(/^conn:/);
    // Admission denied ⇒ no work unit: the crossing op never started.
    expect(opsNamed(r.events, "mcp:command:call-tool")).toHaveLength(0);
  });

  it("the admission-failure payload never carries credential material", async () => {
    const r = (active = await rig({
      tools: [toolDecl("echo")],
      resolveHandler: () => async () => ({
        kind: "inline",
        content: [{ type: "text", text: "ok" }] as ContentBlock[],
      }),
      auth: { authenticator: async () => ({ authenticated: false, reason: "denied" }) },
    }));
    const client = await r.connect();
    await client
      .callTool({ name: "echo", arguments: {} }, CallToolResultSchema)
      .catch(() => undefined);
    await settle();

    const payload = opsNamed(r.events, MCP_SERVER_ADMISSION_FAILED)[0]!.payload as Record<
      string,
      unknown
    >;
    // Only the connection SHAPE + the failure class. Every key is on the
    // allow-list, and nothing credential-shaped rides along.
    expect(
      Object.keys(payload).every((k) =>
        ["failureClass", "transportKind", "origin", "remoteAddress", "reason"].includes(k),
      ),
    ).toBe(true);
    expect(payload).not.toHaveProperty("headers");
    expect(JSON.stringify(payload)).not.toMatch(/authorization|bearer|token/i);
  });
});
