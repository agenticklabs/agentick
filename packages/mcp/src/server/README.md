# `@agentick/mcp/server`

Expose an Agentick gateway, app, or standalone process as an **MCP server**.
Symmetric inbound counterpart to `@agentick/mcp` (the client subpath) —
same wire vocabulary, opposite direction.

> Import path: `import { McpServerHarness } from "@agentick/mcp/server"`.
> The `/server` subpath is deliberately isolated so browser / edge bundles
> consuming only the MCP client never pull in Node transport code.

```ts
import { spawnStandaloneMcpServer, stdioTransport } from "@agentick/mcp/server";
import { createTool } from "@agentick/tool";
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
  transports: [stdioTransport()],
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
  readonly completions?: McpServerCompletionsOptions; // see "Argument completion"
  readonly resources?: McpServerResourcesOptions; // Resources source projected over resources/* (ADR 62)

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

| Factory                              | Wire     | Notes                                                                                                                                                                                                      |
| ------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stdioTransport()` (#171c follow-up) | stdio    | Default for `spawnStandaloneMcpServer`. One process = one connection. Adopter owns SIGINT.                                                                                                                 |
| `inMemoryServerTransport()`          | in-proc  | Adopter-driven test fixture. Returns `.connect()` that yields the client end.                                                                                                                              |
| `httpTransport({ port })`            | HTTP+SSE | **Landed** — Streamable HTTP listener (multi-connection). Wraps the SDK `StreamableHTTPServerTransport`; per-`Mcp-Session-Id` routing; `port: 0` binds ephemeral. Accepts a caller-supplied `http.Server`. |
| Custom                               | any      | Implement `ServerTransport`; the harness only cares about `listen(accept) → close()` + transport.                                                                                                          |

Transports carry their own `kind` discriminator (`"stdio"` / `"http"` / etc.)
which the security pipeline reads for transport-aware defaults — stdio +
in-memory default to `allowAll`; HTTP/WS default to `localOnly` + reject-all
until config provides explicit auth.

```ts
import { inMemoryServerTransport, type ServerTransport } from "@agentick/mcp/server";

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
  transforms: [prefix("v2_")],
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
adopters compose with the helpers from `@agentick/tool/transforms`:
name-targeting (`prefix`, `suffix`, `rename`, `renameBy`), visibility
(`filter`, `allow`, `deny`, `onlyExposingTo`), metadata / schema
(`setMetadata`, `replaceMetadata`, `replaceInputSchema`, `replaceOutputSchema`,
`mapSchemas`), and `composeTransforms` to chain them. `prefix` / `suffix` take
a positional string (`prefix("v2_")`); `rename` takes a `{ old: new }` map.
Handler wrapping is deliberately NOT a transform (transforms operate on
`ToolDeclaration` only).

Transforms run AFTER the security pipeline's `authenticator` stage, so they
can branch on `ctx.mcp.user.roles` / `ctx.mcp.clientInfo` / `ctx.metadata`.

Per ADR 43 the handler receives the **live `McpRequestContext`** — same
`ToolHandlerCtx` shape adopters see in-process, just with
`transport: "mcp"` + a nested `mcp.*` discriminator block carrying
`connectionId`, `transportKind`, `user`, `clientInfo`, `clientCapabilities`.
The handler is portable across transports unchanged.

### Pattern B over the MCP wire (#171d.3)

A tool handler that returns a `TaskHandle` (typically via
`ctx.tasks!.submit(...)`) is automatically routed through the MCP
task wire — same handler code that yields a `session_task_ref` block
in-process now yields a `CreateTaskResult` (the `{ task: { taskId,
status } }` wire shape) on the MCP side. The harness:

- Constructs one server-side `TasksHarness` per server (`server.tasks`).
- Wires `ctx.tasks` so handlers can call `submit(...)` without
  knowing they're running over MCP.
- Detects `TaskHandle` returns via the canonical `isTaskHandle`
  guard from `@agentick/spec`.
- Maintains a per-connection task registry that serves `tasks/get`,
  `tasks/result`, `tasks/cancel`, `tasks/list`.
- Subscribes to each handle's `events()` stream and emits
  `notifications/tasks/status` as the task progresses.
- Translates `annotations.taskSupport` → wire `execution.taskSupport`
  (`required` / `supported` → `optional` / `unsupported` →
  `forbidden`) so MCP clients know to wrap the tool in their own
  `ctx.tasks.submit(...)` (Pattern B reciprocity).
- Advertises `tasks: {}` in the `initialize` capabilities reply when
  any registered tool declares `taskSupport`.

```ts
const Lint = createTool({
  name: "lint_repo",
  description: "Lint the repository (long-running)",
  annotations: { taskSupport: "required" },
  handler: async (input, { ctx }) => {
    return ctx.tasks!.submit(async ({ signal, onProgress }) => {
      // ... work that respects signal + emits progress ...
      return [{ type: "text", text: "lint complete" }];
    });
  },
});

// Both routes work — same handler, same shape:
spawnStandaloneMcpServer({ name: "lint-server", tools: [Lint], ... });
// or createApp({ extensions: [withTasks(), withMCP({ servers: [...] })] })
//   with Lint registered in-process.
```

---

## The `prompts` slot — accepted shapes

Symmetric with `tools` — array shorthand, instance shorthand, OR config
object. Lives at `packages/mcp/README.md` for the canonical write-up;
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
`assertFlatSchema(wireSchema)` from `@agentick/elicitation` against
the projected JSON Schema to catch violations before `sdkServer.request`.
Bad schemas raise `ElicitSchemaTooComplex` (subclass of `ElicitError`)
carrying `.issues` + `.schema`.

**URL mode + deferred auth.** `ctx.elicit.requireUrls([...])` throws
`UrlElicitationRequired` — the MCP wire codec maps it to JSON-RPC error
`-32042` so the client can walk the URLs (OAuth-style) and retry the
originating tool call. See ADR 43 + the elicitation-next README.

---

## Argument completion (`completions`)

Wires the `completion/complete` request to per-argument
`CompletionHandler`s built with the sugar factories re-exported from this
subpath (`completeFromList`, `completeFromEnum`, `completePrefixMatch`,
`completeDependent`, `completeFromAsync`). The `completions` capability is
advertised iff at least one handler is wired.

```ts
completions: {
  prompts: {
    summarize: {
      // ref/prompt "summarize", argument "style"
      style: completeFromList(["concise", "detailed", "bullet"]),
      // dependent arg: sees sibling values via ctx.resolvedArguments
      section: completeDependent({ requires: ["docId"] }, async (typed, { docId }) => {
        return (await loadSections(docId)).filter((s) => s.startsWith(typed));
      }),
    },
  },
},
```

Handlers live at the wire (a server-config slot), NOT on
`PromptDeclaration` — argument completion is an MCP-wire concept, and the
100-value cap + sugar belong at the wire edge while prompt declarations stay
framework-neutral. Unknown prompts / arguments resolve to an empty value
list (clients probe freely, no protocol error). `ref/resource`
(resource-template completion) resolves to empty until the resource
substrate lands (Wave 4).

---

## Structured logging (`ctx.log` / `ctx.progress`)

Per ADR 64, `ctx.log(level, data, logger?)` and `ctx.progress(...)` are
**always-present bus slots** on every `ToolHandlerCtx` — not MCP-specific
sinks. Each call emits ONE discrete bus event (`<surface>:signal:log` /
`:progress`) scoped to the connection; the slots are present regardless of
whether the handler runs over MCP or in-process, so handlers never guard
for their existence. `capabilities: { logging: false }` does NOT remove
`ctx.log` — it only suppresses the MCP wire projection.

```ts
const tool = createTool({
  name: "reindex",
  handler: async (input, { ctx }) => {
    ctx.log("info", { phase: "start", input });
    // ... work ...
    ctx.log("debug", { rows: 1234 }, "indexer"); // optional logger channel
    return [{ type: "text", text: "done" }];
  },
});
```

On the MCP server side, `installLogProjection` is a **bus subscriber**:
per connection it subscribes to `log` events and forwards them to
`notifications/message`, filtered by the client's `logging/setLevel`
(installed only when the client advertised the `logging` capability).
`installProgressProjection` does the same for `notifications/progress`
(not capability-gated — installed unconditionally per connection).

Clients set their minimum severity with `logging/setLevel`; the server
stores it per-connection and filters emissions below it (syslog ordering:
`debug < info < notice < warning < error < critical < alert < emergency`).
Before any `setLevel`, the connection defaults to `debug` (emit
everything). Projections are fire-and-forget — below-threshold levels and
send failures (connection closed mid-flight) drop silently. Because the
bus is the seam, a below-level log the MCP projection drops is still
observable by any other bus subscriber.

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
} from "@agentick/mcp/server";

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
`elicit` is enabled. `tasks` advertises when at least one tool declares
`taskSupport: "required" | "supported"`. `resources` advertises (with
`subscribe` + `listChanged`) when a Resources source is wired (ADR 62).
`completions` advertises when the `completions` slot carries a handler.
`logging` advertises by default (every request context gets a `ctx.log`
sink). (`elicitation` and `sampling` are CLIENT capabilities in MCP — the
server never advertises them on the wire; it issues `elicitation/create`
when the connected client advertised the capability and `elicit` is enabled.)

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
  transports: [stdioTransport()],
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

| Symbol                                                                                                                                                                                         | Purpose                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `McpServerHarness`                                                                                                                                                                             | Construct + lifecycle the harness directly                                                                                               |
| `spawnStandaloneMcpServer` / `SpawnStandaloneOptions` / `StandaloneServerHandle`                                                                                                               | Mode-A shell                                                                                                                             |
| `validateOptions` / `McpServerOptions`                                                                                                                                                         | Eager options validation; flat adopter API                                                                                               |
| `McpServerToolsOptions`                                                                                                                                                                        | Tools slot type (array shorthand \| config object, ADR 42). `McpServerToolsConfig` / `resolveToolsOption` are internal — NOT re-exported |
| `McpServerPromptsOptions` / `McpServerPromptsConfig` / `resolvePromptsOption`                                                                                                                  | Prompts slot trichotomy (#171d.1b)                                                                                                       |
| `McpServerElicitOptions` / `resolveElicitOption`                                                                                                                                               | Elicit opt-out resolution (#171d.2)                                                                                                      |
| `McpServerCompletionsOptions` / `McpServerCompletionsConfig` / `resolveCompletionsOption`                                                                                                      | Argument-completion slot + resolved internal shape (Wave 3a)                                                                             |
| `completeFromList` / `completeFromEnum` / `completePrefixMatch` / `completeDependent` / `completeFromAsync`                                                                                    | Completion sugar builders (re-exported from the protocol layer)                                                                          |
| `installToolsHandlers` / `installPromptsHandlers` / `installResourcesHandlers` / `installCompletionsHandlers` / `installLoggingHandler` / `installLogProjection` / `installProgressProjection` | Low-level projection installers — adopters with custom Server instances can call these directly                                          |
| `createConnectionLogState` / `LOG_LEVEL_SEVERITY` / `ConnectionLogState`                                                                                                                       | Per-connection log-level state + syslog severity ordering (ADR 64)                                                                       |
| `buildMcpElicit` / `inspectElicitationCapabilities`                                                                                                                                            | MCP-flavored `Elicit` sugar factory (ADR 43)                                                                                             |
| `bearerTokenAuth` / `allowListGuard` / `roleBasedAuthz` / `slidingWindowLimiter`                                                                                                               | Built-in security stages                                                                                                                 |
| `inMemoryServerTransport`                                                                                                                                                                      | In-process transport for tests                                                                                                           |
| `ElicitationCancelled` / `ElicitationDeclined` / `ElicitationNotSupported` / `UrlElicitationRequired`                                                                                          | Elicit error classes (re-exports)                                                                                                        |

Spec types are re-exported for adopters' convenience: `McpRequestContext`,
`McpServerConnectionInfo`, `McpAuthenticatedUser`, `McpServerError`,
`McpServerHarnessProtocol`, `McpServerRegistry`, `McpLogLevel`.

---

## Verified by

- `__tests__/skeleton.spec.ts` — construction, lifecycle, options
  validation, connection tracking primitives.
- `__tests__/end-to-end.spec.ts` — initialize + tools/list + tools/call
  with a real `McpClient` over `inMemoryServerTransport`.
- `transports/__tests__/http-transport.spec.ts` — `httpTransport` over
  **real loopback HTTP** (ephemeral port): full initialize → tools/list →
  tools/call round-trip via the SDK `StreamableHTTPClientTransport`;
  bearer auth reading the HTTP `Authorization` header through the security
  pipeline; two concurrent clients each getting a distinct
  `Mcp-Session-Id`; and the client `streamableHttpTransport` factory
  wiring an OAuth `authProvider` whose redirect fires the URL elicit.
- `__tests__/tools-slot.spec.ts` — trichotomy contract for the tools slot
  (every form + the xor-discrimination boundary cases).
- `__tests__/projection-elicit.spec.ts` — `ctx.elicit` sugar surface +
  URL-mode deferred-auth path.
- `__tests__/projection-prompts.spec.ts` — `prompts/list` + `prompts/get`
  projection.
- `__tests__/projection-completions-logging.spec.ts` — Wave 3a: argument
  completion round-trip (ref/prompt routing, `context.arguments`
  pass-through, unknown-ref + ref/resource → empty), `ctx.log`
  round-trip with level filtering (`setLoggingLevel("info")` filters
  `debug`; default level emits both), capability gating for
  `completions`/`logging`, and the `lifecycle.ts` tasks-vs-resources
  gating regression.
- `__tests__/progress.spec.ts` — `ctx.progress` → `notifications/progress`
  correlated to the client's `_meta.progressToken` (surfaced on
  `ctx.mcp.progressToken`): explicit-token wire equality + real SDK
  `onprogress` round-trip; no capability gate.
- `__tests__/cross-connection-isolation.spec.ts` — TWO clients on ONE
  server; a tool's `ctx.log` + `ctx.progress` over connection A reach
  NEITHER of B's notification handlers (mutation-checked against the
  `connectionScope` filter — the multi-tenant guarantee).
- `__tests__/below-level-log-bus-emit.spec.ts` — a below-level `debug`
  log the MCP projection drops is STILL observed by an independent bus
  subscriber; each projection applies its own threshold.
- `__tests__/spawn.spec.ts` — Mode-A shell ergonomics.
- `security/__tests__/pipeline.spec.ts` — 35 tests covering every stage in
  isolation + the composed pipeline.

## See also

- [`packages/mcp/README.md`](../../README.md) — package overview, the
  client subpath, and cross-cutting MCP concerns.
- [`docs/proposals/v2/blueprint/40-mcp-server-harness.md`](../../../../docs/proposals/v2/blueprint/40-mcp-server-harness.md) — full ADR.
- [`docs/proposals/v2/blueprint/42-harness-slot-trichotomy.md`](../../../../docs/proposals/v2/blueprint/42-harness-slot-trichotomy.md) — slot pattern.
- [`docs/proposals/v2/blueprint/43-unified-tool-handler-ctx.md`](../../../../docs/proposals/v2/blueprint/43-unified-tool-handler-ctx.md) — unified ToolHandlerCtx (in-process + MCP).
- [`packages/elicitation/README.md`](../../../elicitation/README.md) — elicitation primitive (the substrate the projection layers on top of).
