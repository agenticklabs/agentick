# Exposing an MCP Server

The mirror image of [connecting to MCP servers](/docs/v2/mcp): here you expose an
agentick app — its tools, resources, prompts, elicitation, logging, and progress —
as an **MCP server** any compliant client can connect to. Same wire vocabulary,
opposite direction.

## The mental model: you project the seams you already have

An MCP server, in agentick, is a **projection layer over your existing
primitives.** You don't re-author your tools in an MCP-specific shape or maintain a
parallel resource store. The server harness reads your registries and speaks them
over the wire:

- your `CreatedTool`s → `tools/list` + `tools/call`
- your resources registry → `resources/*`
- your prompts → `prompts/*`
- runtime `ctx.log` / `ctx.progress` signals → `notifications/message` / `progress`
- `ctx.elicit` → `elicitation/create` (client capability permitting)

The projection is **thin**: it reads registries and never mutates them, exactly the
way a client surfaces a remote server _into_ your primitives. Capabilities are
advertised strictly from **what's actually wired** — the server never claims support
it can't back.

## Two deployment modes

| Mode | Entry point | When |
| ----- | ------------------------------------------------ | -------------------------------------------------------- |
| **A** | `spawnStandaloneMcpServer(...)` | CLI tools, single-purpose servers, "wrap this toolset as MCP" |
| **B** | `createGateway({ mcpServers: [...] })` (preview) | Multi-server gateways sharing one substrate with sessions |

Both use the same `McpServerHarness` and the same `McpServerOptions` shape. Mode B
lands with the formal gateway-extension work; Mode A ships today.

## Quickstart (Mode A)

```ts
import { spawnStandaloneMcpServer, stdioTransport } from "@agentick/mcp-next/server";
import { createTool } from "@agentick/tool-next";
import { z } from "zod";

const Calculator = createTool({
  name: "calculator",
  description: "Evaluate an arithmetic expression.",
  inputSchema: z.object({ expression: z.string() }),
  handler: async ({ expression }) => [
    { type: "text", text: String(evaluate(expression)) },
  ],
});

const { close } = await spawnStandaloneMcpServer({
  name: "calc-server",
  transports: [stdioTransport()],
  tools: [Calculator],
});

process.on("SIGINT", () => void close());
```

The process is now an MCP server speaking over stdio, advertising one tool to any
client that connects. `spawnStandaloneMcpServer` synthesizes a minimal substrate,
constructs the harness, mounts transports, and returns a `{ harness, close }`
handle — you own the signal handling.

Note the tool factory: server tools use `createTool` from `@agentick/tool-next`,
whose schema field is `inputSchema` and whose handler receives `(input, { ctx })`.

## The options shape

`McpServerOptions` is a flat object — no `config: {}` wrapper, no duplicated
transports list.

```ts
interface McpServerOptions {
  readonly name: string;                     // unique within the gateway; appears in routing
  readonly transports: readonly ServerTransport[];

  readonly tools?: McpServerToolsOptions;    // CreatedTool[] OR a projection-config object
  readonly prompts?: McpServerPromptsOptions;
  readonly resources?: McpServerResourcesOptions; // a Resources instance OR { use, filter }
  readonly elicit?: boolean | { enabled: boolean }; // opt-OUT (on by default)
  readonly completions?: McpServerCompletionsOptions;

  readonly capabilities?: McpServerCapabilitiesOptions; // opt-OUTs only
  readonly auth?: McpServerAuthOptions;                 // five-stage security pipeline
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly serverInfo?: { readonly name: string; readonly version: string };
}
```

`validateOptions(opts)` runs the same checks eagerly, so a bad config surfaces at
construction time (or a config-load step) rather than at first connection.

## Projecting tools

The `tools` slot accepts an array shorthand (the 90% case) or a config object with
per-connection projection rules:

```ts
import { toolPrefix } from "@agentick/tool-next/transforms";

// Array shorthand:
tools: [Calculator, Search, Translate];

// Config object — CreatedTool[] + per-connection filter + transforms:
tools: {
  tools: [Calculator, Search],
  filter: (tool, ctx) => ctx.mcp.user?.roles?.includes("admin") || !tool.name.startsWith("admin_"),
  transforms: [toolPrefix({ prefix: "v2_" })],
}
```

`filter` decides visibility — a hidden tool is invisible to **both** `tools/list`
_and_ `tools/call` (the projection re-applies on every request, so a tool can't be
hidden from `list` then reached via `call`). `transforms` rewrite name / metadata /
schema per-connection; they run _after_ authentication, so they can branch on
`ctx.mcp.user.roles`.

Handlers receive the **live `McpRequestContext`** — the same `ToolHandlerCtx` you use
in-process, discriminated by `transport: "mcp"` plus a nested `mcp` block
(`connectionId`, `transportKind`, `user`, `clientInfo`, `clientCapabilities`). Your
handler code is portable across transports unchanged.

There's a low-level escape hatch (`registry` + `resolveHandler`) for custom handler
resolution and dynamic tool sets; see the package README.

## Projecting resources

Hand the server your resources registry and it projects it over `resources/*`. Unlike
prompts, there is **no declarative array shorthand** — a resource binding needs a
resolver function, so you build the source (see [Resources](/docs/v2/resources)) and
pass it in:

```ts
resources: sessionResources,               // a Resources instance
// …or with a per-connection visibility filter over fixed resources:
resources: { use: sessionResources, filter: (r, ctx) => isVisible(r, ctx) },
```

Wiring resources advertises `resources: { subscribe, listChanged }` and serves
`resources/list`, `resources/templates/list`, `read`, `subscribe`, `unsubscribe`,
plus `notifications/resources/{updated,list_changed}`. The projection reads the
registry and never mutates it.

> The `filter` gates _fixed_ resources (which carry a descriptor). Templated reads
> resolve without a fixed descriptor and bypass it — enforce template access control
> inside the resolver.

## Projecting prompts

Symmetric with tools — array shorthand, an existing `Prompts` instance, or a config
object:

```ts
prompts: [
  {
    name: "summarize",
    description: "Summarize a passage",
    arguments: [{ name: "text", required: true }],
    render: ({ text }) => [
      { kind: "message", role: "user", content: [{ type: "text", text: `Summarize: ${text}` }] },
    ],
  },
];
```

Lifecycle: forms the server constructs (array / `declarations`) are closed on
`server.close()`; a `use`-supplied instance is left alone (you own it). `server.prompts`
exposes the resolved source for runtime `register` / `update` / `remove`.

## Capability advertisement — derived, never declared

The `initialize` response advertises **only what's wired**:

| Capability | Advertised when |
| ------------- | ------------------------------------------------------------- |
| `tools` | `tools` is set and the resolved registry is non-empty |
| `resources` | a resources source is wired |
| `prompts` | the prompts source has declarations |
| `elicitation` | `elicit` is enabled (this is a _client_ capability MCP-side) |
| `tasks` | at least one tool declares `taskSupport: "required" \| "supported"` |
| `completions` | the `completions` slot carries a handler |
| `logging` | on by default (every request ctx gets a `ctx.log` sink) |

You can **opt out** of advertising something that _is_ wired
(`capabilities: { tools: false }`, useful for staged rollout) but you cannot opt
_into_ advertising something not wired — the spec calls that lying on the wire, and
the harness won't do it.

## The security pipeline

Five named stages, each independently overridable, defaults transport-aware. Stages
run in order; any throw short-circuits the request with a typed `McpServerError`.

| Stage | Default (stdio / HTTP) | Built-in override |
| ----------------- | ------------------------------- | --------------------------------------- |
| `connectionGuard` | `allowAll` / `localOnly` | `allowListGuard({ peers })` |
| `authenticator` | `allowAll` / `rejectAll` | `bearerTokenAuth({ tokens })` |
| `authorizer` | `allow` | `roleBasedAuthz({ rules })` |
| `rateLimiter` | no-op | `slidingWindowLimiter({ window, max })` |
| `inputSanitizer` | identity | adopter-supplied |

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
      { tool: "*", requireRoles: [] },
    ],
  }),
  rateLimiter: slidingWindowLimiter({ window: 60_000, max: 100 }),
}
```

The defaults are the important part: **HTTP/WS transports reject-all until you wire
an authenticator.** stdio and in-memory default to allow-all because the process
boundary _is_ the trust boundary. The authenticated principal becomes
`ctx.mcp.user` for the rest of the request.

## Elicitation, logging, and progress

- **`ctx.elicit`** — tool handlers can prompt the connecting user when that client
  advertised the `elicitation` capability. On by default; `elicit: false` forbids it
  entirely. Always check `ctx.elicit` for presence (a client that didn't advertise
  leaves it `undefined`).
- **`ctx.log(level, data, logger?)`** — structured logging, filtered by the client's
  `logging/setLevel` (syslog ordering). Advertised by default.
- **`ctx.progress(token, { progress, total?, message? })`** — liveness for
  long-running work, correlated to the client's `_meta.progressToken`.

`log` and `progress` are **framework runtime signals, not MCP-only sinks** (ADR 64):
each emit produces one bus event scoped to the connection, and the MCP projection is
a _subscriber_. Cross-connection isolation is structural — connection A's signals
never reach connection B's notification handlers. Whether or not you're running an
MCP server, the same `ctx.log` / `ctx.progress` fire; the MCP layer just adds a
wire projection on top.

## Roots — inbound (a connecting client's boundaries)

When a client advertises the `roots` capability, the server pulls its `roots/list`
after `initialize` (re-pulling on `notifications/roots/list_changed`) and surfaces
the result on **`ctx.mcp.clientRoots`**. This is:

- **Advisory.** The roots are the client's declared boundaries — a hint about where
  it wants you to operate, not enforced containment. Enforcement is still yours.
- **Per-connection and isolated.** Connection A's roots never appear on connection
  B's ctx, and `clientRoots` is `undefined` when the client didn't advertise roots
  (or before the first pull resolves). A failed pull is never a control path.

A server never _exposes_ roots — that's the client's job. Roots are always
client → server. Content transfer the other direction is
[resources](/docs/v2/resources).

## Transports

| Factory | Wire | Notes |
| --------------------------- | -------- | -------------------------------------------------------------------- |
| `stdioTransport()` | stdio | Default for `spawnStandaloneMcpServer`; one process = one connection |
| `httpTransport({ port })` | HTTP+SSE | Streamable HTTP listener, multi-connection; `port: 0` binds ephemeral |
| `inMemoryServerTransport()` | in-proc | Test fixture; `.connect()` yields the client end |

Each transport carries its own `kind` discriminator, which the security pipeline
reads for its transport-aware defaults.

```ts
import { McpServerHarness, httpTransport, bearerTokenAuth } from "@agentick/mcp-next/server";

const server = new McpServerHarness(scopeId, journal, bus, inbox, {
  name: "my-server",
  transports: [httpTransport({ port: 8080 })],
  tools: [Calculator],
  auth: { authenticator: bearerTokenAuth({ tokens: { "secret-1": { id: "alice", roles: ["admin"] } } }) },
});
await server.ready;
await server.start();
```

## Conformance

`@agentick/mcp-next/testing` ships `runMcpConformance`, which exercises a server
harness both over an in-process loopback (server harness ↔ a real `McpClient`) and,
gated, against an official reference peer — catching wire drift the shared-SDK
loopback can't. Run it against your server config to prove the projection round-trips
every operation.

## When NOT to use this — gotchas

- **Don't advertise what you can't back.** Capabilities are derived from wiring; you
  can opt out but never opt in. If a capability isn't showing up, wire the primitive
  behind it.
- **HTTP defaults to reject-all.** Forgetting to wire an `authenticator` on an HTTP
  transport means _no request authenticates_ — that's intentional. stdio's allow-all
  default relies on the process boundary being the trust boundary; don't carry that
  assumption to a network transport.
- **Inbound roots are advisory.** `ctx.mcp.clientRoots` is a hint. Enforce with your
  sandbox / egress, and handle `undefined` (client didn't advertise).
- **The projection is read-only.** It never mutates your registries. Mutate through
  the primitives themselves (`server.prompts.register`, the resources registry), and
  the projection reflects the change (with `list_changed` where the wire supports it).
- **`resources` has no array shorthand.** A binding needs a resolver — build the
  `Resources` source and pass the instance.

## See also

- [MCP: connecting to servers](/docs/v2/mcp) — the client direction.
- [Resources](/docs/v2/resources) — the registry you project over `resources/*`.
- [Tools](/docs/tools) — the tools you project over `tools/*`.
- [`@agentick/mcp-next/server` README](https://github.com/agenticklabs/agentick/blob/feat/v2/packages-next/mcp/src/server/README.md) — full server surface + exports.
- ADRs: [40 — MCP server harness](https://github.com/agenticklabs/agentick/blob/feat/v2/docs/proposals/v2/blueprint/40-mcp-server-harness.md), [62 — resources](https://github.com/agenticklabs/agentick/blob/feat/v2/docs/proposals/v2/blueprint/62-resources-harness.md), [63 — compiler surfacing](https://github.com/agenticklabs/agentick/blob/feat/v2/docs/proposals/v2/blueprint/63-compiler-surfacing.md), [64 — runtime signals](https://github.com/agenticklabs/agentick/blob/feat/v2/docs/proposals/v2/blueprint/64-runtime-signal-family.md), [65 — roots](https://github.com/agenticklabs/agentick/blob/feat/v2/docs/proposals/v2/blueprint/65-roots-as-projection.md).
