# `@agentick/mcp-next/server`

Expose an Agentick gateway, app, or standalone process as an **MCP server**.
Symmetric inbound counterpart to `@agentick/mcp-next` (the client subpath) —
same wire vocabulary, opposite direction.

> Import path: `import { McpServerHarness } from "@agentick/mcp-next/server"`.
> The `/server` subpath is deliberately isolated so browser / edge bundles
> consuming only the MCP client never pull in Node transport code.

```ts
import { spawnStandaloneMcpServer, stdioServerTransport } from "@agentick/mcp-next/server";
import { createTool } from "@agentick/tool-next";
import { z } from "zod";

const Calculator = createTool({
  name: "calculator",
  description: "Evaluate an arithmetic expression.",
  inputSchema: z.object({ expression: z.string() }),
  handler: async ({ expression }) => [
    { type: "text", text: String(new Function(`return (${expression})`)()) },
  ],
});

const { close } = await spawnStandaloneMcpServer({
  name: "calc-server",
  transports: [stdioServerTransport()],
  tools: [Calculator],
});

process.on("SIGINT", () => void close());
```

Done. The process is now an MCP server speaking over stdio, advertising one
tool to any client that connects.

---

## Two deployment modes

| Mode  | Shell                                                         | When to use                                                                      |
| ----- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **A** | `spawnStandaloneMcpServer(...)` — sole purpose of the process | CLI tools, single-purpose servers, "wrap this skill set as MCP" deployments      |
| **B** | `createGateway({ mcpServers: [...] })` (extension, #254)      | Multi-server gateways, shared substrate, sessions + MCP exposed from one process |

Both modes use the same `McpServerHarness` and the same options shape. Mode B
lands with the formal `GatewayExtension` work (#254); today it's stubbed via
the augment slot.

---

## The options shape (`McpServerOptions`)

Flat object passed to either `new McpServerHarness(...)` or
`spawnStandaloneMcpServer(...)`. There is no `config: {}` wrapper, no
duplicated transports list — per ADR 40 §1.

```ts
interface McpServerOptions {
  readonly name: string; // unique within the gateway; appears in URL routing
  readonly transports: readonly ServerTransport[];

  readonly tools?: McpServerToolsOptions; // see "The tools slot"
  readonly prompts?: McpServerPromptsOptions; // see "The prompts slot"
  readonly elicit?: boolean | { enabled: boolean }; // see "Elicitation"
  readonly resources?: unknown; // lands with #123

  readonly capabilities?: McpServerCapabilitiesOptions; // opt-OUTs only
  readonly auth?: McpServerAuthOptions; // five-stage pipeline
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly serverInfo?: { name: string; version: string };
}
```

`validateOptions(opts)` runs the same checks eagerly — adopters can pre-flight
a config before constructing the harness.

---

## Transports

The harness mounts every transport at `start()`; each can accept many
concurrent connections.

| Factory                                    | Wire     | Notes                                                                                             |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `stdioServerTransport()` (#171c follow-up) | stdio    | Default for `spawnStandaloneMcpServer`. One process = one connection. Adopter owns SIGINT.        |
| `inMemoryServerTransport()`                | in-proc  | Adopter-driven test fixture. Returns `.connect()` that yields the client end.                     |
| `httpServerTransport()` (future)           | HTTP+SSE | Streamable HTTP per MCP 2025-11-25. OAuth-aware (lands #134).                                     |
| Custom                                     | any      | Implement `ServerTransport`; the harness only cares about `listen(accept) → close()` + transport. |

Transports carry their own `kind` discriminator (`"stdio"` / `"http"` / etc.)
which the security pipeline reads for transport-aware defaults — stdio +
in-memory default to `allowAll`; HTTP/WS default to `localOnly` + reject-all
until config provides explicit auth.

```ts
import { inMemoryServerTransport, type ServerTransport } from "@agentick/mcp-next/server";

const transport = inMemoryServerTransport();
const harness = new McpServerHarness(scopeId, journal, bus, inbox, {
  name: "test",
  transports: [transport],
});
await harness.ready;
await harness.start();
const clientTransport = await transport.connect(); // pass into McpClient
```

---

## The `tools` slot — accepted shapes

Per ADR 42 the slot accepts an array shorthand OR a config object. (The third
form — a live `Tools` / `ToolExecutorProtocol` instance via `use:` — is
deferred behind `DispatchInput.ctxOverride` spec evolution; the executor's own
ctx-build would clobber the MCP `transport: "mcp"` discriminator fields.)

```ts
// Form A — array shorthand (the 90% case)
tools: [Calculator, Search, Translate];          // each: CreatedTool

// Form C — config object: CreatedTool[] + per-connection projection rules
tools: {
  tools: [Calculator, Search],
  filter: (tool, ctx) => ctx.mcp.user?.roles?.includes("admin") || !tool.name.startsWith("admin_"),
  transforms: [toolPrefix({ prefix: "v2_" })],
}

// Form C (low-level escape hatch) — explicit registry + handler resolver
// for custom resolution (lookup tables, late-bound dispatch),
// dynamic registries, or projection-layer tests.
tools: {
  registry: [/* ToolDeclaration[] */],
  resolveHandler: (handlerRef) => /* async (input, ctx) => ContentBlock[] */ null,
  filter, transforms,
}
```

**Per-connection projection.** `filter` decides visibility; hidden tools are
invisible to BOTH `tools/list` AND `tools/call` (the projection re-applies on
every request, so a tool can't be hidden from `list` then called via `call`).
`transforms` rewrite declarations (name / metadata / schema) per-connection —
adopters compose with the helpers from `@agentick/tool-next/transforms`
(`toolPrefix`, `toolRename`, `restrictInput`, `wrapHandler`, `toolAlias`,
`composeTransforms`).

Transforms run AFTER the security pipeline's `authenticator` stage, so they
can branch on `ctx.mcp.user.roles` / `ctx.mcp.clientInfo` / `ctx.metadata`.

Per ADR 43 the handler receives the **live `McpRequestContext`** — same
`ToolHandlerCtx` shape adopters see in-process, just with
`transport: "mcp"` + a nested `mcp.*` discriminator block carrying
`connectionId`, `transportKind`, `user`, `clientInfo`, `clientCapabilities`.
The handler is portable across transports unchanged.

---

## The `prompts` slot — accepted shapes

Symmetric with `tools` — array shorthand, instance shorthand, OR config
object. Lives at `packages-next/mcp/README.md` for the canonical write-up;
quick reference:

```ts
prompts: [{ name: "summarize", description: "...", template: "..." }]; // Form A
prompts: somePromptsInstance; // Form B — adopter-owned `Prompts` source
prompts: { declarations: [...], filter, /* OR */ use: somePromptsInstance }; // Form C
```

The server exposes `server.prompts: Prompts | null` for runtime mutation
(`register` / `update` / `remove`) regardless of which form constructed it.

---

## Elicitation (`ctx.elicit`)

Tool handlers receive `ctx.elicit` whenever the connected client advertised
the `elicitation` capability at `initialize` time. The slot is sugar over
per-request `sdkServer.request("elicitation/create")` calls — same `Elicit`
interface adopters use in-process (`session.elicit`, in-process `ctx.elicit`).

```ts
const Whoami = createTool({
  name: "whoami",
  description: "Identify the user.",
  handler: async (_input, { ctx }) => {
    const name = await ctx.elicit?.text("What's your name?");
    return [{ type: "text", text: `Hello ${name ?? "stranger"}` }];
  },
});
```

**Defaults.** Elicitation is ON by default; the slot only exists to OPT OUT
(`elicit: false` or `elicit: { enabled: false }`) for adopters whose audit /
security posture forbids server-initiated requests.

**Schema flatness** (#271). The MCP spec restricts `elicitation/create`'s
`requestedSchema` to flat objects with primitive properties — clients
render the request as a flat UI form. The framework's `ctx.elicit.*`
sugar surface uses TS-level `FlatProperty` types and produces flat
schemas by construction; adopters writing custom MCP wire bridges call
`assertFlatSchema(wireSchema)` from `@agentick/elicitation-next` against
the projected JSON Schema to catch violations before `sdkServer.request`.
Bad schemas raise `ElicitSchemaTooComplex` (subclass of `ElicitError`)
carrying `.issues` + `.schema`.

**URL mode + deferred auth.** `ctx.elicit.requireUrls([...])` throws
`UrlElicitationRequired` — the MCP wire codec maps it to JSON-RPC error
`-32042` so the client can walk the URLs (OAuth-style) and retry the
originating tool call. See ADR 43 + the elicitation-next README.

---

## Security pipeline

Five named stages, each independently overridable. Defaults are
transport-aware. Stages execute in order; any throw short-circuits the
request with a typed `McpServerError` subclass.

| Stage             | Default                          | Adopter override                                 |
| ----------------- | -------------------------------- | ------------------------------------------------ |
| `connectionGuard` | `allowAll` (stdio) / `localOnly` | `allowListGuard({ peers })`                      |
| `authenticator`   | `allowAll` (stdio) / `rejectAll` | `bearerTokenAuth({ tokens })`                    |
| `authorizer`      | `allow`                          | `roleBasedAuthz({ rules })`                      |
| `rateLimiter`     | no-op                            | `slidingWindowLimiter({ window, max })`          |
| `inputSanitizer`  | identity                         | adopter-supplied — must return the request input |

```ts
import {
  bearerTokenAuth,
  roleBasedAuthz,
  slidingWindowLimiter,
} from "@agentick/mcp-next/server";

auth: {
  authenticator: bearerTokenAuth({
    tokens: { "secret-1": { id: "alice", roles: ["admin"] } },
  }),
  authorizer: roleBasedAuthz({
    rules: [
      { tool: "admin_*", requireRoles: ["admin"] },
      { tool: "*",       requireRoles: [] },
    ],
  }),
  rateLimiter: slidingWindowLimiter({ window: 60_000, max: 100 }),
}
```

The authenticated principal becomes `ctx.mcp.user` for the rest of the
request — tools, transforms, and `filter` predicates all see it.

---

## Per-connection request context (`McpRequestContext`)

Built once per `tools/call` / `prompts/get` / etc., passed to handlers,
transforms, and filters. Same shape as in-process `ToolHandlerCtx` (ADR 43);
the only difference is `transport: "mcp"` + a nested `mcp` block:

```ts
interface McpRequestContext extends ToolHandlerCtx {
  readonly transport: "mcp";
  readonly mcp: {
    readonly serverId: string;
    readonly connectionId: string;
    readonly transportKind: string; // "stdio" / "in-memory" / "http" / ...
    readonly connectedAt: number;
    readonly user: McpAuthenticatedUser | null; // populated post-authenticator
    readonly clientInfo: { name: string; version: string } | null;
    readonly clientCapabilities: Readonly<Record<string, unknown>> | null;
  };
  readonly elicit?: Elicit; // when client advertised the capability
  readonly metadata?: Readonly<Record<string, unknown>>; // transport-supplied (headers, origin, remoteAddr)
}
```

---

## Capability advertisement

The `initialize` response advertises capabilities **derived from what was
actually wired** — never from adopter declaration. `tools` advertises when
`tools` is set AND the resolved registry is non-empty. `prompts` advertises
when the prompts source has declarations. `elicitation` advertises when
`elicit` is enabled.

Adopters can OPT OUT of advertising a capability that IS wired
(`capabilities: { tools: false }`) — useful for staged rollouts — but cannot
opt INTO advertising something not wired (the spec calls that lying on the
wire).

---

## Mode A — `spawnStandaloneMcpServer`

The Mode-A shell. Synthesizes a minimal substrate
(`MemoryJournal` + `LocalEventBus` + `LocalInbox`), constructs the harness,
mounts transports, returns a `{ harness, close }` handle. Adopters wire their
own SIGINT / process exit.

```ts
const handle = await spawnStandaloneMcpServer({
  name: "my-server",
  transports: [stdioServerTransport()],
  tools: [
    /* CreatedTool[] */
  ],
  scopeId: "srv:custom", // optional; defaults to srv:<ulid>
});
// ... process runs ...
await handle.close(); // idempotent
```

No signal handlers are installed by the shim — that's the bin layer's job
where intent + main-thread context are clear.

---

## Mode B — gateway extension (preview)

When `createGateway({ mcpServers: [...] })` lands (#254), the same
`McpServerOptions` flows in. Adopters get one substrate + many MCP servers
side-by-side with sessions, sharing journal / bus / inbox + the cluster fan
if running clustered. Today the augment slot is reserved; the formal
extension factory + installer lifecycle is the open task.

---

## Direct projection (`mcp://gateway/<name>`)

Internal agents talking to "their own" MCP server should bypass the wire —
the URL form `mcp://gateway/<server-name>` projects directly through
`McpServerHarness.asClient()`, returning the same protocol surface
`McpClient` exposes but skipping transport serialization entirely. Lands
with #171g.

---

## What this subpath exports

| Symbol                                                                                                | Purpose                                                                                         |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `McpServerHarness`                                                                                    | Construct + lifecycle the harness directly                                                      |
| `spawnStandaloneMcpServer` / `SpawnStandaloneOptions` / `StandaloneServerHandle`                      | Mode-A shell                                                                                    |
| `validateOptions` / `McpServerOptions`                                                                | Eager options validation; flat adopter API                                                      |
| `McpServerToolsOptions` / `McpServerToolsConfig` / `resolveToolsOption`                               | Tools slot trichotomy + resolved internal shape (ADR 42)                                        |
| `McpServerPromptsOptions` / `McpServerPromptsConfig` / `resolvePromptsOption`                         | Prompts slot trichotomy (#171d.1b)                                                              |
| `McpServerElicitOptions` / `resolveElicitOption`                                                      | Elicit opt-out resolution (#171d.2)                                                             |
| `installToolsHandlers` / `installPromptsHandlers`                                                     | Low-level projection installers — adopters with custom Server instances can call these directly |
| `buildMcpElicit` / `inspectElicitationCapabilities`                                                   | MCP-flavored `Elicit` sugar factory (ADR 43)                                                    |
| `bearerTokenAuth` / `allowListGuard` / `roleBasedAuthz` / `slidingWindowLimiter`                      | Built-in security stages                                                                        |
| `inMemoryServerTransport`                                                                             | In-process transport for tests                                                                  |
| `ElicitationCancelled` / `ElicitationDeclined` / `ElicitationNotSupported` / `UrlElicitationRequired` | Elicit error classes (re-exports)                                                               |

Spec types are re-exported for adopters' convenience: `McpRequestContext`,
`McpServerConnectionInfo`, `McpAuthenticatedUser`, `McpServerError`,
`McpServerHarnessProtocol`.

---

## Verified by

- `__tests__/skeleton.spec.ts` — construction, lifecycle, options
  validation, connection tracking primitives.
- `__tests__/end-to-end.spec.ts` — initialize + tools/list + tools/call
  with a real `McpClient` over `inMemoryServerTransport`.
- `__tests__/tools-slot.spec.ts` — trichotomy contract for the tools slot
  (every form + the xor-discrimination boundary cases).
- `__tests__/projection-elicit.spec.ts` — `ctx.elicit` sugar surface +
  URL-mode deferred-auth path.
- `__tests__/projection-prompts.spec.ts` — `prompts/list` + `prompts/get`
  projection.
- `__tests__/spawn.spec.ts` — Mode-A shell ergonomics.
- `security/__tests__/pipeline.spec.ts` — 35 tests covering every stage in
  isolation + the composed pipeline.

## See also

- [`packages-next/mcp/README.md`](../../README.md) — package overview, the
  client subpath, and cross-cutting MCP concerns.
- [`docs/proposals/v2/blueprint/40-mcp-server-harness.md`](../../../../docs/proposals/v2/blueprint/40-mcp-server-harness.md) — full ADR.
- [`docs/proposals/v2/blueprint/42-harness-slot-trichotomy.md`](../../../../docs/proposals/v2/blueprint/42-harness-slot-trichotomy.md) — slot pattern.
- [`docs/proposals/v2/blueprint/43-unified-tool-handler-ctx.md`](../../../../docs/proposals/v2/blueprint/43-unified-tool-handler-ctx.md) — unified ToolHandlerCtx (in-process + MCP).
- [`packages-next/elicitation/README.md`](../../../elicitation/README.md) — elicitation primitive (the substrate the projection layers on top of).
