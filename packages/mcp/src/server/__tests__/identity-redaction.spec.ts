/**
 * The identity-stamp redaction law (ADR 92 §"Journaling policy … redact").
 *
 * `IngressIdentity` rides `EventScope` on every crossing operation, and
 * `mcp:command:call-tool` / `mcp:command:initialize` are the PERSISTED op
 * classes. So whatever `toIngressIdentity` copies out of the authenticated user
 * record is written to the durable journal on every tool call. An adopter's
 * `Authenticator` is free to hang whatever it likes off the open bag on
 * `McpAuthenticatedUser` — bearer tokens, OAuth refresh material, PII — because
 * the tool-handler side legitimately needs it. The STAMP must not follow.
 *
 * Every assertion drives the REAL wire: a real `bearerTokenAuth` stage, a real
 * SDK `Client`, and the harness's own bus + journal as the observation surface.
 * The assertion pattern is the credentials harness's redaction suite
 * (`packages/credentials/src/__tests__/mutation-operations.spec.ts` §2):
 * fragment checks over the FULL serialized journal + bus, each with a
 * non-vacuity guard proving the capture really did see the crossing.
 *
 * @see docs/proposals/v2/blueprint/92-operation-grammar-completion.md
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type {
  ContentBlock,
  McpAuthenticatedUser,
  McpRequestContext,
  ProtocolEvent,
  ToolDeclaration,
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import {
  bearerTokenAuth,
  McpServerHarness,
  type McpServerAuthOptions,
  type ToolHandlerResolver,
} from "../index.js";
import { InMemoryMcpTransport } from "../../transport/in-memory.js";
import type { AcceptHandler, AuthPreGate, ServerTransport } from "../transports/types.js";
import { inMemoryServerTransport } from "../transports/in-memory.js";

// ============================================================================
// Fixtures
// ============================================================================

const emptySchema = jsonSchema({ type: "object", properties: {}, additionalProperties: true });

/** The credential the adopter's authenticator resolves the crossing against. */
const BEARER = "SECRET_TOKEN_VALUE";
/** A fragment of it — pins that no partial/encoded copy survives either. */
const BEARER_FRAGMENT = "SECRET_TOKEN";

/**
 * A user record shaped the way a real adopter's authenticator shapes it: the
 * four fields `McpAuthenticatedUser` declares, plus open-bag additions. The
 * open bag is exactly where credentials hide — Knowify's authenticator hangs
 * the caller's live bearer token there so tool handlers can call downstream
 * APIs on the caller's behalf.
 */
const TOKEN_BEARING_USER: McpAuthenticatedUser = {
  id: "user-42",
  displayName: "Ada",
  roles: ["admin"],
  scopes: ["read:all"],
  // ── the open bag ────────────────────────────────────────────────────
  token: BEARER,
  oauthToken: { accessToken: BEARER, refreshToken: `${BEARER}-refresh` },
  email: "ada@example.com",
};

/** The `Authorization` header the transport puts on the connection snapshot. */
const AUTH_HEADER = { authorization: `Bearer ${BEARER}` } as const;

/**
 * The real `bearerTokenAuth` stage on its DEFAULT extraction path — it reads
 * `Authorization: Bearer <token>` out of `ctx.metadata.headers`, exactly as it
 * does behind `httpTransport`. Nothing about the stage is stubbed.
 */
function tokenAuth(): McpServerAuthOptions {
  return {
    authenticator: bearerTokenAuth({
      verify: async (token) => (token === BEARER ? TOKEN_BEARING_USER : null),
    }),
  };
}

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

/**
 * An in-memory `ServerTransport` that runs the harness's auth PRE-GATE and
 * forward-derives the resolved user onto the accept-path `McpConnectionInfo`
 * — the same contract `httpTransport` honors (ADR 91 §Phase-2). Needed here
 * because `mcp:command:initialize` stamps its identity from
 * `info.authenticatedUser`, and the stock in-memory transport never sets it.
 */
interface PreGatedTransport extends ServerTransport {
  readonly connect: () => Promise<InstanceType<typeof InMemoryMcpTransport>>;
}

function preGatedInMemoryTransport(): PreGatedTransport {
  let acceptCallback: AcceptHandler | null = null;
  let preGate: AuthPreGate | undefined;
  return {
    kind: "in-memory",
    async listen(accept: AcceptHandler, gate?: AuthPreGate): Promise<void> {
      acceptCallback = accept;
      preGate = gate;
    },
    async close(): Promise<void> {
      acceptCallback = null;
    },
    async connect(): Promise<InstanceType<typeof InMemoryMcpTransport>> {
      if (!acceptCallback) throw new Error("preGatedInMemoryTransport: listen() not called");
      const info = {
        transportKind: "in-memory",
        remoteAddress: "in-memory",
        headers: AUTH_HEADER,
      } as const;
      let authenticatedUser: McpAuthenticatedUser | null | undefined;
      if (preGate?.enforce) {
        const verdict = await preGate.verify(info);
        if (!verdict.ok) throw new Error("preGatedInMemoryTransport: 401");
        authenticatedUser = verdict.user;
      }
      const [clientSide, serverSide] = InMemoryMcpTransport.createLinkedPair();
      await acceptCallback(serverSide as unknown as Transport, {
        ...info,
        ...(authenticatedUser !== undefined ? { authenticatedUser } : {}),
      });
      return clientSide;
    },
  };
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
    readonly auth?: McpServerAuthOptions;
    readonly identityProjection?: (
      user: McpAuthenticatedUser,
    ) => Readonly<Record<string, unknown>> | undefined;
    readonly resolveHandler?: ToolHandlerResolver;
  } = {},
): Promise<Rig> {
  const bus = new LocalEventBus();
  const journal = new MemoryJournal({ capacity: 4096 });
  const transport = preGatedInMemoryTransport();
  const harness = new McpServerHarness(`srv:${generateId()}`, journal, bus, new LocalInbox(), {
    name: "redaction-test",
    serverInfo: { name: "redaction-test", version: "0.0.0" },
    transports: [transport],
    tools: {
      registry: [toolDecl("echo")],
      resolveHandler:
        options.resolveHandler ??
        (() => async () => ({
          kind: "inline",
          content: [{ type: "text", text: "ok" }] as ContentBlock[],
        })),
    },
    auth: options.auth ?? tokenAuth(),
    ...(options.identityProjection ? { identityProjection: options.identityProjection } : {}),
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

async function journaled(journal: MemoryJournal): Promise<readonly ProtocolEvent[]> {
  const out = await Effect.runPromise(Stream.runCollect(journal.readByQuery({}, "beginning")));
  return Array.from(out);
}

function identityOf(events: readonly ProtocolEvent[], name: string): Record<string, unknown> {
  const found = events.find((e) => e.name === name && e.phase === "requested");
  if (!found) throw new Error(`no requested envelope for ${name}`);
  return (found.scope.identity ?? {}) as Record<string, unknown>;
}

let active: Rig | undefined;
afterEach(async () => {
  await active?.stop();
  active = undefined;
});

// ============================================================================
// 1 — THE REDACTION LAW
// ============================================================================

describe("the identity stamp never carries credential material", () => {
  it("no journal record, serialized, contains the credential or a fragment of it", async () => {
    const r = (active = await rig());
    const client = await r.connect();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await settle();

    // EVERY record — so a leak through any surface's envelope fails this too.
    const serialized = JSON.stringify(await journaled(r.journal));
    expect(serialized).not.toContain(BEARER);
    expect(serialized).not.toContain(BEARER_FRAGMENT);
    // Non-vacuity: the journal DID retain both persisted crossings, and it DOES
    // carry the principal — so the assertions above are not trivially true.
    expect(serialized).toContain("mcp:command:call-tool");
    expect(serialized).toContain("mcp:command:initialize");
    expect(serialized).toContain("user-42");
  });

  it("no bus envelope, serialized, contains the credential or a fragment of it", async () => {
    const r = (active = await rig());
    const client = await r.connect();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await client.listTools();
    await settle();

    const serialized = JSON.stringify(r.events);
    expect(serialized).not.toContain(BEARER);
    expect(serialized).not.toContain(BEARER_FRAGMENT);
    expect(serialized).toContain("mcp:command:call-tool");
    expect(serialized).toContain("mcp:command:list-tools");
    expect(serialized).toContain("user-42");
  });

  it("the transport-supplied Authorization header never reaches an envelope either", async () => {
    // The header IS on `ctx.metadata.headers` — that is how `bearerTokenAuth`
    // reads it. It must stay there: nothing puts `metadata` on an op's input or
    // its scope.
    const r = (active = await rig());
    const client = await r.connect();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await settle();

    const serialized = `${JSON.stringify(r.events)}${JSON.stringify(await journaled(r.journal))}`;
    expect(serialized).not.toMatch(/authorization/i);
    expect(serialized).not.toMatch(/bearer/i);
    // Non-vacuity: the header WAS consumed — `bearerTokenAuth` resolved the
    // principal from it, which is why `user-42` is on the crossing scope.
    expect(serialized).toContain("mcp:command:call-tool");
    expect(serialized).toContain("user-42");
  });

  it("the default projection copies the DECLARED fields and drops the open bag", async () => {
    const r = (active = await rig());
    const client = await r.connect();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await settle();

    const identity = identityOf(r.events, "mcp:command:call-tool");
    expect(identity).toEqual({
      principal: "user-42",
      scopes: ["read:all"],
      user: { id: "user-42", displayName: "Ada", roles: ["admin"], scopes: ["read:all"] },
    });
    // The open bag — including the non-credential `email` — never rides along.
    // "Identifier-class" is not a judgement the framework makes about adopter
    // keys; only the DECLARED fields are copied by default.
    expect(identity.user).not.toHaveProperty("token");
    expect(identity.user).not.toHaveProperty("oauthToken");
    expect(identity.user).not.toHaveProperty("email");
  });

  it("the initialize crossing's stamp is redacted too (forward-derived pre-gate identity)", async () => {
    const r = (active = await rig());
    await r.connect();
    await settle();

    const identity = identityOf(r.events, "mcp:command:initialize");
    expect(identity.principal).toBe("user-42");
    expect(identity.user).toEqual({
      id: "user-42",
      displayName: "Ada",
      roles: ["admin"],
      scopes: ["read:all"],
    });
  });
});

// ============================================================================
// 2 — the adopter's redaction seam
// ============================================================================

describe("identityProjection — the adopter's PII/credential redaction seam", () => {
  it("what the hook returns becomes identity.user verbatim", async () => {
    const r = (active = await rig({
      identityProjection: (user) => ({ id: user.id, tenant: "acme", email: user.email }),
    }));
    const client = await r.connect();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await settle();

    const identity = identityOf(r.events, "mcp:command:call-tool");
    expect(identity.user).toEqual({ id: "user-42", tenant: "acme", email: "ada@example.com" });
    // `principal` + `scopes` stay FRAMEWORK-derived — not the hook's job.
    expect(identity.principal).toBe("user-42");
    expect(identity.scopes).toEqual(["read:all"]);
  });

  it("a hook returning undefined omits identity.user entirely", async () => {
    const r = (active = await rig({ identityProjection: () => undefined }));
    const client = await r.connect();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await settle();

    const identity = identityOf(r.events, "mcp:command:call-tool");
    expect(identity).toEqual({ principal: "user-42", scopes: ["read:all"] });
    expect(identity).not.toHaveProperty("user");
  });

  it("a hook that leaks is the ADOPTER's leak — the framework stamps what it returns", async () => {
    // The hook owns the policy; the framework owns the guarantee that nothing
    // ELSE reaches the stamp. Pinned so the contract is unambiguous.
    const r = (active = await rig({
      identityProjection: (user) => ({ id: user.id, token: user.token }),
    }));
    const client = await r.connect();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await settle();

    expect(identityOf(r.events, "mcp:command:call-tool").user).toEqual({
      id: "user-42",
      token: BEARER,
    });
  });
});

// ============================================================================
// 3 — the credential's legitimate home
// ============================================================================

describe("the full record still reaches the tool handler", () => {
  it("ctx.mcp.user carries the whole authenticated record, open bag included", async () => {
    let seen: McpRequestContext | undefined;
    const r = (active = await rig({
      resolveHandler: () => async (_input, ctx) => {
        seen = ctx;
        return { kind: "inline", content: [{ type: "text", text: "ok" }] as ContentBlock[] };
      },
    }));
    const client = await r.connect();
    await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
    await settle();

    expect(seen?.mcp?.user).toEqual(TOKEN_BEARING_USER);
    expect((seen?.mcp?.user as Record<string, unknown> | undefined)?.token).toBe(BEARER);
    // …and the trunk still carries the redacted projection.
    expect(seen?.identity?.principal).toBe("user-42");
    expect(seen?.identity?.user).not.toHaveProperty("token");
  });
});

// ============================================================================
// 4 — THE SAME LAW ON THE IN-PROCESS TRANSPORT
// ============================================================================

/**
 * Everything above arrives over a pre-gated HTTP-shaped crossing, where the token
 * rides an `Authorization` header. In-process there is no header and no pre-gate:
 * the caller already knows who it is and states it with
 * `connect({ authenticatedUser })`, which forward-derives onto `accept` the same
 * way the pre-gate does.
 *
 * Both halves have to hold on that path too, and they are the halves in tension —
 * a handler calling the host's own API needs the caller's token, and the durable
 * journal must never see it. Neither is safe to leave resting on a docblock.
 */
describe("in-process identity — connect({ authenticatedUser })", () => {
  async function inProcessRig(): Promise<{
    readonly seen: () => McpRequestContext | undefined;
    readonly journal: MemoryJournal;
    readonly events: readonly ProtocolEvent[];
    readonly call: () => Promise<void>;
    readonly stop: () => Promise<void>;
  }> {
    let seen: McpRequestContext | undefined;
    const bus = new LocalEventBus();
    const journal = new MemoryJournal({ capacity: 4096 });
    const transport = inMemoryServerTransport();
    const harness = new McpServerHarness(`srv:${generateId()}`, journal, bus, new LocalInbox(), {
      name: "inproc-test",
      serverInfo: { name: "inproc-test", version: "0.0.0" },
      transports: [transport],
      tools: {
        registry: [toolDecl("echo")],
        resolveHandler: () => async (_input, ctx) => {
          seen = ctx;
          return { kind: "inline", content: [{ type: "text", text: "ok" }] as ContentBlock[] };
        },
      },
      // No auth stage at all — the point is that a trusted transport can state the
      // identity without one, so nothing here extracts a token from anywhere.
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

    const clientTransport = await transport.connect({ authenticatedUser: TOKEN_BEARING_USER });
    const client = new McpClient({ name: "c", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport as unknown as Transport);

    return {
      seen: () => seen,
      journal,
      events,
      call: async () => {
        await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
        await settle();
      },
      stop: async () => {
        await client.close().catch(() => {});
        await harness.close();
        await Effect.runPromise(Fiber.interrupt(fiber));
      },
    };
  }

  it("the tool handler sees the WHOLE record, token included", async () => {
    // The hard requirement: a handler calling the host's own API has to call it as
    // the caller, and on a trusted transport there is no header to recover that from.
    const r = await inProcessRig();
    try {
      await r.call();
      expect(r.seen()?.mcp?.user).toEqual(TOKEN_BEARING_USER);
      expect((r.seen()?.mcp?.user as Record<string, unknown> | undefined)?.token).toBe(BEARER);
    } finally {
      await r.stop();
    }
  });

  it("and the journal still never sees the credential", async () => {
    const r = await inProcessRig();
    try {
      await r.call();
      const records = await journaled(r.journal);
      // Non-vacuity first: a capture that saw nothing would pass the fragment check
      // trivially, which is how a redaction test quietly stops testing anything.
      expect(records.length).toBeGreaterThan(0);
      expect(JSON.stringify(records)).not.toContain(BEARER_FRAGMENT);
    } finally {
      await r.stop();
    }
  });

  it("nor does any bus envelope", async () => {
    const r = await inProcessRig();
    try {
      await r.call();
      expect(r.events.length).toBeGreaterThan(0);
      expect(JSON.stringify(r.events)).not.toContain(BEARER_FRAGMENT);
    } finally {
      await r.stop();
    }
  });

  it("stamps the redacted projection, so the crossing is still attributable", async () => {
    // Redaction that also lost WHO acted would be a different bug. The declared four
    // survive; the open bag does not.
    const r = await inProcessRig();
    try {
      await r.call();
      const identity = identityOf(r.events, "mcp:command:call-tool");
      expect(identity["principal"]).toBe("user-42");
      expect(identity["user"]).toMatchObject({ id: "user-42", displayName: "Ada" });
      expect(identity["user"]).not.toHaveProperty("token");
    } finally {
      await r.stop();
    }
  });

  it("an explicitly ANONYMOUS connection stamps no user", async () => {
    // `authenticatedUser: null` asserts anonymity; omitting the field entirely means
    // "run your own authenticator", which is a different statement.
    const bus = new LocalEventBus();
    const journal = new MemoryJournal({ capacity: 1024 });
    const transport = inMemoryServerTransport();
    let seen: McpRequestContext | undefined;
    const harness = new McpServerHarness(`srv:${generateId()}`, journal, bus, new LocalInbox(), {
      name: "anon-test",
      serverInfo: { name: "anon-test", version: "0.0.0" },
      transports: [transport],
      tools: {
        registry: [toolDecl("echo")],
        resolveHandler: () => async (_input, ctx) => {
          seen = ctx;
          return { kind: "inline", content: [{ type: "text", text: "ok" }] as ContentBlock[] };
        },
      },
    });
    await harness.ready;
    await harness.start();
    const clientTransport = await transport.connect({ authenticatedUser: null });
    const client = new McpClient({ name: "c", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport as unknown as Transport);
    try {
      await client.callTool({ name: "echo", arguments: {} }, CallToolResultSchema);
      await settle();
      expect(seen?.mcp?.user ?? null).toBeNull();
    } finally {
      await client.close().catch(() => {});
      await harness.close();
    }
  });
});
