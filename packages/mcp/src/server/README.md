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
  readonly identityProjection?: McpIdentityProjection; // what the audit trail records about the caller
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

### SSE resumability (`eventStore`)

Streamable HTTP delivers server→client messages over SSE. When that connection
drops — a proxy timeout, a closed laptop, a flaky mobile link — the client
reconnects with `Last-Event-ID`. **With no event store the server has nothing to
replay**, so every message sent during the gap is gone: a long tool call's
progress notifications and its result included. The reconnect silently becomes a
fresh stream.

Resumability is opt-in config, because a store retains messages in memory and
that is not a cost to impose on a server that never asked for it:

```ts
import { httpTransport, inMemoryEventStore } from "@agentick/mcp/server";

httpTransport({ port: 3000, eventStore: inMemoryEventStore() });
// or bound it explicitly — default is 1000 events across all streams
httpTransport({ port: 3000, eventStore: inMemoryEventStore({ maxEvents: 5_000 }) });
```

`inMemoryEventStore` is a **reference** implementation: single-process,
non-durable, and bounded (oldest dropped first — a client reconnecting past the
window is told the id is unknown and opens a fresh stream). A multi-node
deployment needs a shared store, since a reconnect can land on a different node:
implement the SDK's `EventStore` against Redis / Postgres / your own log and pass
that instead. Both HTTP shapes (`httpTransport`, `httpMiddlewareTransport`) take
the option.

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
originating tool call. See ADR 43 + the @agentick/elicitation README.

---

## Argument completion (`completions`)

Answers `completion/complete` — what a client's composer offers while a user
types into a prompt argument.

**If your prompts already declare how their arguments complete, you are done.**
A `PromptDeclaration` argument carries `complete` (an inline resolver, or a name
into a completions registry), and the server resolves `ref/prompt` through that
declaration. The same resolver that serves the agentick wire serves this one;
there is nothing to restate here.

```ts
// The declaration — written once, in @agentick/prompts.
definePrompts({
  prompts: [
    {
      name: "summarize",
      description: "…",
      arguments: [
        { name: "style", complete: completeFromList(["concise", "detailed", "bullet"]) },
        // A dependent argument reads sibling values off ctx.resolvedArguments.
        {
          name: "section",
          complete: completeDependent({ requires: ["docId"] }, async (typed, { docId }) =>
            (await loadSections(docId)).filter((s) => s.startsWith(typed)),
          ),
        },
      ],
      render: …,
    },
  ],
});

// The server — projecting that surface is the whole wiring.
prompts: { use: myPrompts },
```

The `completions` slot is the **override**, and the only completion path for a
server that projects no prompts surface at all (a façade over a REST API, say).
An entry here outranks the declaration for that one argument:

```ts
completions: {
  // ref/prompt "summarize", argument "style" — wins over the declaration's own.
  prompts: { summarize: { style: completeFromList(["terse", "long"]) } },
  // Resource-template variables (ref/resource), keyed by template uri. These
  // have no declaration seam to fold into, so config is the whole story.
  resources: { "file:///{path}": { path: completeFromList(["a.txt", "b.txt"]) } },
  // The registry that answers an argument naming a source (complete: "crm.customers").
  use: myCompletions,
}
```

Both forms build handlers from the sugar factories re-exported from this subpath
(`completeFromList`, `completeFromEnum`, `completePrefixMatch`,
`completeDependent`, `completeFromAsync`).

**Nothing here protocol-errors.** An unknown prompt, an unknown argument, an
argument declaring no completion, a named source no registry answers to — all
return an empty value list, so a client probes freely. A prompt your
per-connection `prompts.filter` hides is not completable either: completion runs
a resolver over the caller's data, which is exactly what the filter withholds.

The `completions` capability is advertised when the slot carries a handler OR a
prompts surface is projected — a declaration can complete its own arguments, so
the capability follows the surface. `capabilities: { completions: false }` opts
out of either.

**The 100-value cap is this wire's, and it is applied here.** A resolver returns
everything it found; the projection trims the response to
`COMPLETION_MAX_VALUES` and sets `hasMore`. The same resolver reached over the
agentick wire is not capped — wire constraints live at the wire.

**Handler context (ADR 91 §2).** `CompletionContext extends OperationCtx` —
beyond `resolvedArguments` (the sibling-argument values), a handler reads the
per-request trunk (the redacted `identity`) plus `ctx.mcp.user`, the caller's
full authenticated record with its credential, and the `log` / `trace` / `run`
facets. That holds for a declaration's resolver too, and it is why the projection
composes the prompts harness's Effect twin from inside the crossing rather than
calling its Promise face: on a fresh fiber the resolver would see the session
that owns the registry instead of the client that asked. So a DB-backed
completion scopes its query to the authenticated principal; a prefix-match
handler ignores everything but `resolvedArguments`.

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

## Every request crossing is an operation (ADR 92 §Slice A)

An inbound MCP request is external ingress, so it qualifies under the
operation-grammar law: an adopter could want to hook it, guard it, or find
it in the audit trail. Each SDK `setRequestHandler` crossing therefore runs
inside a named, journaled, guardable, span-parented operation.

| Wire method                | Operation                             | Journal   |
| -------------------------- | ------------------------------------- | --------- |
| connection accept          | `mcp:command:initialize`              | persisted |
| `tools/call`               | `mcp:command:call-tool`               | persisted |
| `tools/list`               | `mcp:command:list-tools`              | bus-only  |
| `resources/list`           | `mcp:command:list-resources`          | bus-only  |
| `resources/templates/list` | `mcp:command:list-resource-templates` | bus-only  |
| `resources/read`           | `mcp:command:read-resource`           | bus-only  |
| `resources/subscribe`      | `mcp:command:subscribe-resource`      | bus-only  |
| `resources/unsubscribe`    | `mcp:command:unsubscribe-resource`    | bus-only  |
| `prompts/list`             | `mcp:command:list-prompts`            | bus-only  |
| `prompts/get`              | `mcp:command:get-prompt`              | bus-only  |
| `completion/complete`      | `mcp:command:complete`                | bus-only  |

Every crossing gets the **envelope** — name, guards, hooks, span —
unconditionally. The journal column is only about RETENTION: the chatty
read/list classes stay bus-only so a polling client cannot grow the durable
journal without bound, while `call-tool` and `initialize` persist. Every
phase of every crossing is still observable on the bus.

**Scope.** A crossing op carries the connection dimension
(`mcpConnectionId`, `mcpServerId`), `origin: "wire"`, and the authenticated
`identity` (`{ principal, user, scopes }` — identifiers and grants, never
the credential).

**Parenting.** Work inside a crossing journals as a CHILD: a tool handler's
`ctx.run` mints an op whose `parentOpId` is the crossing's `opId` and whose
scope inherits the connection dimension and identity. The chain reads
connection → crossing → inner command.

### Hooking or guarding a crossing

The op name Pascalizes to the hook/command tag (`mcp:command:call-tool` →
`McpCallTool`), so a guard self-scopes by comparing `ctx.op`:

```ts
server.guard((input, ctx) =>
  ctx.op === "McpCallTool" && !allowed(ctx.identity)
    ? { kind: "veto", reason: "policy" }
    : { kind: "proceed" },
);
```

A veto blocks the handler before it runs and terminates the op `vetoed`.

### Identity reaches every handler seam

Over the wire, every seam an adopter writes receives a context whose **trunk**
carries the request's authenticated identity — `ctx.identity.principal`,
`ctx.identity.scopes`, and the connection dimension.

A subset of seams additionally carries the **`mcp` boundary facet**
(`ctx.mcp`): the connection metadata plus the FULL authenticated record the
`Authenticator` resolved, credential included. The trunk identity is
serialized (it is stamped on every crossing operation, so it lands in the
audit trail and is redacted accordingly — see
[Redacting the identity stamp](#redacting-the-identity-stamp)); the facet is
never serialized, which is what makes it safe to carry a live token.

| Seam                                                | Trunk identity | `ctx.mcp` facet | How it is reached                          |
| --------------------------------------------------- | -------------- | --------------- | ------------------------------------------ |
| tool handler                                        | yes            | yes             | the crossing's branded ctx, directly       |
| tools / prompts / resources per-connection `filter` | yes            | yes             | the crossing's branded ctx, directly       |
| completion handler                                  | yes            | yes             | the crossing's branded ctx, directly       |
| `ResourceResolver` (fixed/template)                 | yes            | yes             | through `resources:command:read`, in-fiber |
| `PromptDeclaration.render`                          | yes            | yes             | through `prompts:command:render`, in-fiber |

The last two are not called by the projection — they are called by Resources
and Prompts, one command deeper. Through those harnesses' Promise facade
(`resources.read(uri)`) the command re-entered Effect on a fresh root fiber
inheriting nothing: it journaled as an orphaned root and the seam saw no
identity at all. The projections now compose the Effect-canonical twin
(`source.fx.read(...)`, `source.fx.render(...)`) on the runtime captured
INSIDE the crossing operation, so the trunk flows. The inner command is a real
linked record — `parentOpId` = the crossing's `opId`, connection dimension and
identity inherited — and the ctx those seams receive is derived from it. The
`mcp` facet reaches them on a channel of its own: the crossing publishes it as a
**boundary facet**, which the runtime folds into any context derived on that
fiber but never copies onto an operation's event scope. So the credential is
reachable one command deeper without ever being serializable.

```ts
resources.register("knowify://me", async (uri, ctx) => {
  // Over the wire this is the MCP caller's identity, not a fabrication.
  const principal = ctx?.identity?.principal;
  return [{ uri, text: await profileFor(principal) }];
});

// A completion handler that must call a downstream API as the caller reads
// the credential off the facet, not off the trunk.
const completions = {
  prompts: {
    invoice: {
      customer: async (typed: string, ctx: CompletionContext) => {
        const token = ctx.mcp?.user?.token as string | undefined;
        return { values: await searchCustomers(typed, token) };
      },
    },
  },
};
```

---

### Redacting the identity stamp

Every crossing operation stamps an `identity` record on its event scope, and
`tools/call` + `initialize` are the **persisted** operation classes — so
whatever the stamp carries is written to the durable journal on every tool
call and every connection.

`McpAuthenticatedUser` has an open index signature, and adopters use it: an
`Authenticator` that resolves a bearer token routinely hangs the token, OAuth
refresh material, or a whole user row off the record so tool handlers can act
on the caller's behalf. **None of that belongs in the journal.**

The default projection is therefore structural, not a post-hoc scrub. Only
the four fields `McpAuthenticatedUser` declares are copied:

| Stamped field        | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| `identity.principal` | `user.id`                                                   |
| `identity.scopes`    | `user.scopes`                                               |
| `identity.user`      | `{ id, displayName, roles, scopes }` — declared fields only |

Everything else on the record is dropped, because the framework cannot tell
an adopter's `token` key from its `tenantId` key. The full record stays
reachable in-process on `ctx.mcp.user`.

Override with `identityProjection` — the PII / credential redaction seam.
What it returns becomes `identity.user` verbatim; `principal` and `scopes`
stay framework-derived:

```ts
const server = new McpServerHarness(scopeId, journal, bus, inbox, {
  name: "my-server",
  transports: [httpTransport({ port: 8080 })],
  auth: { authenticator: bearerTokenAuth({ verify: introspect }) },

  // Stamp a tenant id your dashboards group by — and nothing else.
  identityProjection: (user) => ({ id: user.id, tenantId: user.tenantId }),
});
```

Return `undefined` to stamp no `user` record at all. Whatever you return IS
serialized, so a hook that copies the token puts the token in the journal —
the hook owns the policy, the framework guarantees nothing else reaches the
stamp.

> [!NOTE]
> The transport edge draws the same line one step earlier: an `AuthSource`
> returns an `IngressIdentity` directly, so its return value **is** the stamp —
> there is no projection step to configure, and a credential placed in its
> `user` record is a credential in the journal. Same rule, two edges: never put
> the credential in `user`. See
> [@agentick/transport](../../../transport#ingress-authentication).

---

## Security pipeline

Five named stages, each independently overridable. Defaults are
transport-aware. Any throw short-circuits the request with a typed
`McpServerError` subclass.

**The stages are seams on the crossing op, not a parallel pipeline.** The
staged `auth: {...}` config is sugar over that one enforcement path:

| Stage             | Where it runs                                                              |
| ----------------- | -------------------------------------------------------------------------- |
| `connectionGuard` | Pre-op, once per connection — before `mcp:command:initialize`              |
| `authenticator`   | **Pre-op**, per request — admission is not work, so it is not an operation |
| `authorizer`      | `guard`-kind interceptor on the crossing op                                |
| `rateLimiter`     | `guard`-kind interceptor on the crossing op                                |
| `inputSanitizer`  | `transform`-kind interceptor — rewrites the crossing op's tool input       |

Guard-kind interceptors sort ahead of transforms, which reproduces the
fixed order authenticate → authorize → rate-limit → sanitize. Each stage
self-scopes to its crossing's command tag, so none of them fire on the
nested ops a handler triggers. Each rejects by throwing its existing typed
error rather than raising a veto signal, so the JSON-RPC frame a client
sees is byte-identical to the pre-envelope path.

A **rejected admission** (connection guard, pre-gate 401, or a failed
per-request authenticator) publishes the discrete
`mcpServer:admission:failed` event instead of an operation — admission
denied means no work unit exists. Its payload carries the connection shape
(`transportKind`, `origin`, `remoteAddress`) and a `failureClass` of
`"connection-guard" | "pre-gate" | "authenticate"`, plus the stage's reason
string. It never carries headers or credential material.

| Stage             | Default                          | Adopter override                                 |
| ----------------- | -------------------------------- | ------------------------------------------------ |
| `connectionGuard` | `allowAll` (stdio) / `localOnly` | `allowListGuard({ addresses, origins })`         |
| `authenticator`   | `allowAll` (stdio) / `rejectAll` | `bearerTokenAuth({ tokens })`                    |
| `authorizer`      | `allow`                          | `roleBasedAuthz({ rules })`                      |
| `rateLimiter`     | no-op                            | `slidingWindowLimiter({ window, max })`          |
| `inputSanitizer`  | identity                         | adopter-supplied — must return the request input |

`allowListGuard` is the low-level connection guard the two defaults build
on: `localOnlyGuard` is `allowListGuard({ addresses: [loopback…] })`, and
`allowAllGuard` is the trivial accept-everything base beneath it. It
matches the socket `remoteAddress` against exact IPs / IPv4 CIDRs / IPv6
prefixes, and `origin` against globs (`https://*.example.com`); an empty
allowlist rejects everything.

**Behind a load balancer, `remoteAddress` is the balancer, not the
client** — so a bare address allowlist sees only the LB's IP, and the
`localOnly` default rejects every real client (the LB's private IP is not
loopback). Either admit at the connection layer and gate on the bearer
token (`connectionGuard: allowAllGuard`), or match the real client by its
forwarded address:

```ts
import { allowListGuard } from "@agentick/mcp/server";

auth: {
  // Match the client the proxy saw, not the proxy socket. Enable
  // trustForwardedFor ONLY behind a proxy that sets X-Forwarded-For —
  // on a directly-exposed server any client can spoof it.
  connectionGuard: allowListGuard({
    addresses: ["203.0.113.0/24"],
    trustForwardedFor: true,
  }),
}
```

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

## OAuth resource-server discovery (RFC 9728)

A real deployment serving Claude / ChatGPT is an **OAuth 2.0 protected
resource**: clients must be able to discover which authorization server
issues tokens for it. The MCP authorization spec layers RFC 9728
(Protected Resource Metadata) on top of that.

**Division of labour — the framework serves discovery; the adopter's
`Authenticator` verifies.** The framework issues and verifies _no_
tokens. It only serves the discovery document; your `authenticator`
stage does the actual RS256 / JWKS verification (userland). This keeps
token material and provider-specific verification policy where it
belongs — with the adopter.

### Serving the metadata document

`httpTransport` takes an `oauth` option. When `oauth.metadata` is
provided, the transport answers `GET
/.well-known/oauth-protected-resource` (and the RFC 9728 path-suffixed
variant derived from `metadata.resource`, e.g.
`/.well-known/oauth-protected-resource/mcp`) with the JSON document.
This works in both `{ port }` owned mode and caller-supplied `server`
(attached) mode — in attached mode the transport claims only its own
paths and leaves everything else for the caller's other routes
(shared-server citizenship).

```ts
import { httpTransport } from "@agentick/mcp/server";
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

const metadata: OAuthProtectedResourceMetadata = {
  resource: "https://api.example.com/mcp",
  authorization_servers: ["https://auth.example.com"],
  bearer_methods_supported: ["header"],
  scopes_supported: ["mcp:read", "mcp:write"],
};

const transport = httpTransport({ port: 8080, oauth: { metadata } });
```

### Verifying tokens — the adopter's `Authenticator`

Token verification stays in the security pipeline. A minimal RS256 /
JWKS verify callback wired as the `authenticator`:

```ts
import { bearerTokenAuth } from "@agentick/mcp/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL("https://auth.example.com/.well-known/jwks.json"));

auth: {
  authenticator: bearerTokenAuth({
    // `verify(token)` returns the authenticated principal, or `null` to
    // reject. Runs only when the token isn't in the static `tokens` map.
    verify: async (token) => {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: "https://auth.example.com",
          audience: "https://api.example.com/mcp",
        });
        return { id: String(payload.sub), roles: (payload.roles as string[]) ?? [] };
      } catch {
        return null; // invalid signature / expired / wrong audience
      }
    },
  }),
}
```

### The `401` challenge — an HTTP-level auth pre-gate

The RFC 9728 flow expects an unauthorized HTTP request to return `401`
with `WWW-Authenticate: Bearer resource_metadata="…"` so the client can
_discover_ the metadata endpoint. A per-operation `Authenticator` cannot
emit this: it runs inside an SDK request handler, by which point the
SDK's `StreamableHTTPServerTransport` has already committed a `200`
response (SSE / JSON) and dispatched to it (`webStandardStreamableHttp.js`
— `handlePostRequest` opens the SSE stream / resolves the JSON promise
_before_ invoking `onmessage`) — from there the transport can neither
set the status to `401` nor inject a header.

The challenge is therefore raised at the HTTP **crossing**, before the
SDK sees the request. `httpTransport` carries an **auth pre-gate**: when
armed, every inbound MCP request (POST rpc, GET events stream) is
verified at the HTTP layer BEFORE any SDK handling. On failure the
transport responds `401` with `WWW-Authenticate: Bearer
resource_metadata="<url>"` and never touches the SDK transport. The
well-known metadata endpoint is **exempt** — discovery must work
unauthenticated, that is its purpose.

**The pre-gate reuses the server's `Authenticator` — it is NOT a parallel
auth config.** The harness threads its resolved `Authenticator` to the
transport at `listen()` time (the `AuthPreGate` seam on `ServerTransport`);
the transport runs that same stage against a minimal request context
synthesized from the HTTP request's headers. Trusted transports (stdio,
in-memory) ignore the seam — no HTTP crossing to challenge.

**Division of labour is preserved.** The pre-gate authenticates the
_crossing_ (defense at the door); the per-operation security pipeline
still runs downstream and authorizes each _operation_ (defense in depth).
Two layers, two jobs — the pre-gate does not replace the pipeline.

**Enforcement split (spec model, with an escape hatch).** The pre-gate
fires only when BOTH halves agree:

- the server has a **real** (non-`allowAll`) `Authenticator` — the
  harness's `enforce` flag, AND
- **`oauth` is configured** on the transport — the transport's own state.

| Server auth        | `oauth` on transport | Behavior                                                                                         |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------------ |
| real authenticator | configured           | Pre-gate ALL requests — everything `401`s until authorized (the MCP authorization spec's model). |
| real authenticator | absent               | **Unchanged.** Per-operation pipeline only; `initialize` / `ping` stay reachable.                |
| `allowAll` (open)  | any                  | Pre-gate dormant (`enforce: false`) — open deployment, unchanged.                                |

This keeps non-OAuth bearer deployments (a static `Authorization: Bearer`
with no discovery flow) working exactly as before: no `oauth` means no
pre-gate, and `initialize` reaches the SDK as it always did.

**The challenge URL** populating `resource_metadata`:

- `oauth.resourceMetadataUrl` when set (metadata hosted on a separate
  authorization service), else
- derived from the served `oauth.metadata` (`metadata.resource` → the
  well-known document URL on the resource's origin), else
- **omitted** — when neither is resolvable the `401` is bare (no
  `WWW-Authenticate` header; there is nothing to point a client at).

```ts
const transport = httpTransport({
  port: 8080,
  oauth: {
    metadata, // served at the well-known path AND derives the challenge url
    // resourceMetadataUrl: "https://auth.example.com/.well-known/..." // if hosted elsewhere
  },
});
```

---

## Display metadata and `_meta` on the wire

Tools, prompts, and resources all reach the wire through the same two
conventions, so a declaration says these things once and every projection reads
them the same way.

**Display fields.** `metadata.title` and `metadata.icons` project onto the wire
record's `title` / `icons`. Prompts and resource descriptors also have a
first-class `title`; `metadata.title` overrides it, which is what lets a
per-connection transform relabel without touching the declaration. A tool has no
declaration-level title field — `createTool({ title })` lands on
`annotations.title`, and that is the fallback when no `metadata.title` overrides
it.

**MCP `_meta`.** Anything MCP-specific rides one namespaced key, `metadata.mcp`,
built by a helper rather than hand-written — an MCP Apps `ui://` template
linkage, a client-understood descriptor, a step-up challenge:

```ts
import {
  mcpToolExtensions,
  mcpPromptExtensions,
  mcpResourceExtensions,
} from "@agentick/mcp/server";

createTool({
  name: "search_invoices",
  // …
  metadata: mcpToolExtensions({
    annotations: { readOnlyHint: true },
    meta: { "openai/outputTemplate": "ui://widget/invoice-list" },
  }),
});

prompts.register({
  name: "jobs_over_budget",
  title: "Jobs Over Budget",
  description: "Jobs past their budget.",
  metadata: mcpPromptExtensions({ meta: { "openai/outputTemplate": "ui://widget/jobs" } }),
});

resources.register({
  uri: "file:///reports/q1.pdf",
  name: "q1_report",
  metadata: mcpResourceExtensions({ meta: { "acme/kind": "report" } }),
});
```

A declaration carrying none of this projects exactly as it did before — the
fields are emitted only when present. Nothing MCP-shaped leaks into the shared
spec: `metadata` is an open bag, and this package is the only reader.

---

## Content on the way out

agentick's content model has 23 block types; MCP's has five (`text`, `image`,
`audio`, `resource_link`, embedded `resource`). Every `tools/call` result and
every `prompts/get` message crosses that narrowing through one mapper, by three
rules:

| Block                                                                                                                                                       | Wire                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `text`, `resource`, base64 `image` / `audio`                                                                                                                | the same kind, field-for-field (byte-stable)                       |
| `generated_image`                                                                                                                                           | `image` (it already is base64 + mimeType)                          |
| url-sourced `image` / `audio` / `document` / `video`, `generated_file`                                                                                      | `resource_link` pointing at the uri                                |
| `json` / `xml` / `csv` / `html` / `code` / `executable_code` / `reasoning` / `code_execution_result`                                                        | `text`, fenced, info string = the kind or its language             |
| everything else (`tool_use`, `tool_result`, `task_ref`, `document`/`video` with an inline payload, `user_action`, `system_event`, `state_change`, `custom`) | `text`, fenced JSON of the block's payload, info string = the kind |

Lossy where it must be, never silent: the fence names what was projected, so a
consumer can tell a narrowed `csv` from a narrowed `xml`. A `reference` media
source (an adopter-namespaced `fileId`) is reported as the id it is rather than
being turned into a uri the wire could not resolve.

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

`ctx.signal` is the CALLER's cancellation, not a placeholder: it aborts when the
client sends `notifications/cancelled` for this request and when the connection
closes. Pass it into whatever your handler awaits — a `fetch`, a query, a child
process — and the work stops when the client gives up instead of running to
completion against a peer that is gone.

```ts
handler: async ({ q }, { ctx }) => {
  const res = await fetch(url(q), { signal: ctx.signal });
  return [{ type: "text", text: await res.text() }];
};
```

> [!IMPORTANT]
> `ctx.mcp.user` and `ctx.identity` are not the same view of the caller.
> `ctx.mcp.user` is the full record the `Authenticator` returned — open bag
> and all — and lives only in this process. `ctx.identity` is the redacted
> projection that rides the operation's event scope into the audit trail. Read
> credentials off `ctx.mcp.user`; read the caller's identity for logging,
> scoping, or authorization off `ctx.identity`. See
> [Redacting the identity stamp](#redacting-the-identity-stamp).

---

## Capability advertisement

The `initialize` response advertises capabilities **derived from what was
actually wired** — never from adopter declaration. `tools` advertises when
`tools` is set AND the resolved registry is non-empty. `prompts` advertises
when the prompts source has declarations. `elicitation` advertises when
`elicit` is enabled. `tasks` advertises when at least one tool declares
`taskSupport: "required" | "supported"`. `resources` advertises (with
`subscribe` + `listChanged`) when a Resources source is wired (ADR 62).
`completions` advertises when the `completions` slot carries a handler OR a
prompts surface is projected (a declaration completes its own arguments, so the
capability follows the surface — it deliberately does not scan for arguments that
declare one, because prompts register after `initialize` has already negotiated).
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
  scopeId: "srv:custom", // optional; defaults to srv:<id>
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
| `McpIdentityProjection`                                                                                                                                                                        | The PII / credential redaction seam for the journaled identity stamp                                                                     |
| `ToolsFilter` / `PromptsFilter` / `ResourcesFilter`                                                                                                                                            | Per-connection visibility predicates — receive the full request context                                                                  |
| `inMemoryServerTransport`                                                                                                                                                                      | In-process transport for tests                                                                                                           |
| `inMemoryEventStore` / `InMemoryEventStoreOptions` / `DEFAULT_MAX_EVENTS`                                                                                                                      | Bounded SSE resumability store for the HTTP transports (opt-in)                                                                          |
| `mcpToolExtensions` / `mcpResultExtensions` / `mcpPromptExtensions` / `mcpResourceExtensions` (+ their readers, `MCP_METADATA_KEY`)                                                            | The `metadata.mcp` carriage convention — `_meta` and tool annotation hints                                                               |
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
  Also OAuth resource-server discovery (RFC 9728): serving the
  protected-resource metadata document at the well-known path(s) in both
  owned (`{ port }`) and attached (caller-supplied `server`) modes, the
  405 on non-GET, shared-server citizenship (attached mode leaves foreign
  paths for the caller's own routes), and the `oauth`-absent 404.
  Plus the HTTP auth pre-gate (RFC 9728 challenge): absent + bad
  credential each `401` with `WWW-Authenticate: Bearer
resource_metadata="…"` (derived url AND explicit `resourceMetadataUrl`)
  on both the POST rpc + GET events-stream paths; the well-known endpoint
  stays reachable unauthenticated behind the gate; a valid token passes
  through to the full round-trip; the bare `401` (no header) when no url
  is resolvable; the enforcement split (no `oauth` → pre-gate dormant,
  unauthenticated crossing reaches the SDK as before); and attached-mode
  citizenship (the pre-gate guards only the MCP path, not foreign routes).
  Plus ADR 92 §Slice A at the HTTP edge: a pre-gate `401` publishes
  `mcpServer:admission:failed` (failure class `"pre-gate"`, no crossing op, no
  credential in the payload), and a pre-gate-authenticated crossing forwards
  its identity onto the `mcp:command:initialize` op scope.
- `__tests__/tools-slot.spec.ts` — trichotomy contract for the tools slot
  (every form + the xor-discrimination boundary cases).
- `__tests__/projection-elicit.spec.ts` — `ctx.elicit` sugar surface +
  URL-mode deferred-auth path.
- `__tests__/projection-prompts.spec.ts` — `prompts/list` + `prompts/get`
  projection.
- `__tests__/crossing-abort.spec.ts` — `ctx.signal` IS the caller's
  cancellation, over the real wire: a client cancelling an in-flight
  `tools/call` aborts the running handler's signal carrying the client's
  reason; closing the connection aborts it too; and an uncancelled crossing
  leaves it quiet.
- `__tests__/wire-extensions.spec.ts` — the `metadata.mcp` convention and its
  projection at all four sites: tool `_meta` + annotation hints, the wire
  title resolving `metadata.title ?? annotations.title`, prompt and resource
  `title` / `icons` / `_meta`, and a regression guard per site proving a bare
  declaration still projects byte-identically.
- `transports/__tests__/event-store.spec.ts` — `inMemoryEventStore`'s replay
  contract (order, stream isolation, unknown anchor, the bound) plus the
  option reaching the SDK, proven over real loopback HTTP: the SAME resumption
  request opens a fresh stream on a store-less server (today's default — the
  hole) and is refused as an unknown event id on one configured with a store.
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
- `security/__tests__/pipeline.spec.ts` — 28 tests covering the connection
  guard, the transport-aware defaults, and every built-in stage in isolation.
- `__tests__/crossing-operations.spec.ts` — ADR 92 §Slice A over the real
  wire (in-memory transport + a real SDK `Client`): every promoted crossing
  emits `mcp:command:<verb>` with the connection dimension + authenticated
  identity on its scope; a handler's `ctx.run` op parents under the crossing
  and inherits its dims two levels deep; a tool handler's AND a completion
  handler's ctx trunk carries the request's identity; a guard veto blocks
  `McpCallTool` while sibling crossings still run; journal policy is honored
  per op class (`call-tool` + `initialize` in the journal, `list-tools` +
  `read-resource` bus-only); the authenticator runs exactly once per
  crossing; a rejected admission emits `mcpServer:admission:failed` with no
  crossing op and no credential material; and the four security stages run
  in order on the guard seam with the sanitizer scoped to tool calls only.
- `__tests__/identity-redaction.spec.ts` — the redaction law over a real
  authenticated round-trip (real `bearerTokenAuth`, real SDK `Client`, a user
  record carrying a bearer token on the open bag): the FULL serialized journal
  and the FULL serialized bus contain no occurrence of the credential or any
  fragment of it, each with a non-vacuity guard proving the capture holds the
  crossing ops and the principal; the default projection copies the four
  declared fields and drops the open bag on both `call-tool` and the
  pre-gate-authenticated `initialize`; `identityProjection` replaces
  `identity.user` verbatim while `principal` + `scopes` stay
  framework-derived; `undefined` omits `identity.user`; and the full record
  still reaches the tool handler on `ctx.mcp.user`.
- `__tests__/identity-facet.spec.ts` — which seams carry the `ctx.mcp`
  boundary facet: tool handler, all three per-connection filters (tools,
  prompts, resources), and completion handler all read `ctx.mcp.user.token`
  over a real authenticated crossing (typed, no cast); the prompt-render and
  resource-resolver seams reach the same credential through the boundary facet
  one command deeper while their trunk identity stays redacted; and with all
  five crossings exercised and the facet actually read, neither the bus nor the
  journal contains the credential.

## Roadmap & known gaps

- **Elicitation is tool-only.** A `PromptDeclaration.render` receives no
  `elicit` seam, so a render that needs to disambiguate an argument with the
  user cannot ask — it has to resolve or fall back. Server-initiated
  elicitation from a render is unbuilt.
- **`prompts/get` results carry no `_meta`.** The wire slot exists, but
  `PromptsGetResult` (`{ description, messages }`) has no metadata bag, so a
  render has nowhere to put result-scoped `_meta`. A prompt's
  `metadata.mcp.meta` is declaration-scoped and rides `prompts/list` only.
  Closing it needs a spec change (`PromptsGetResult.metadata`).
- **`initialize` stamps an identity only when the transport forward-derives
  one.** The HTTP pre-gate does; trusted transports (stdio, in-memory) have
  no credential to resolve at accept time, so the connection crossing carries
  the connection dimension without an `identity`.

## See also

- [`packages/mcp/README.md`](../../README.md) — package overview, the
  client subpath, and cross-cutting MCP concerns.
- [`docs/proposals/v2/blueprint/40-mcp-server-harness.md`](../../../../docs/proposals/v2/blueprint/40-mcp-server-harness.md) — full ADR.
- [`docs/proposals/v2/blueprint/42-harness-slot-trichotomy.md`](../../../../docs/proposals/v2/blueprint/42-harness-slot-trichotomy.md) — slot pattern.
- [`docs/proposals/v2/blueprint/43-unified-tool-handler-ctx.md`](../../../../docs/proposals/v2/blueprint/43-unified-tool-handler-ctx.md) — unified ToolHandlerCtx (in-process + MCP).
- [`packages/elicitation/README.md`](../../../elicitation/README.md) — elicitation primitive (the substrate the projection layers on top of).
