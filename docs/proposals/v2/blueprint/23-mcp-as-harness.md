# ADR 23 — MCP as Harness (per connection)

**Status:** Proposed — 2026-05-20
**Touches:** `@agentick/mcp` (rework on feat/v2), `@agentick/spec/data/mcp.ts` (already landed in cbb49b6b), `HookBridges` extensibility (ADR 22).
**Driver:** Lock in the v2 MCP shape before sandbox implementation, so the pattern for "extension package shipping a harness" is settled.

## Decision

**Each MCP connection is a full `BaseHarness<"mcp">` instance.** Not a passive object. Not a thin wire-protocol wrapper. A real substrate citizen with commands, events, lifecycle, middleware, and an inbox.

The `MCPBridge` is a **registry of MCP harnesses**, not raw connections.

## Why this shape

MCP fits the harness model on every criterion v2 enforces:

| Criterion                  | MCP per connection                                                          |
| -------------------------- | --------------------------------------------------------------------------- |
| Stateful across calls      | Pending requests, capability cache, resource subscriptions, tool list cache |
| Lifecycle                  | connecting → ready → reconnecting → disconnected                            |
| Substrate-bound operations | Every JSON-RPC request is a journaled operation                             |
| Streaming events           | Notifications (tool list changed, resource updated, progress)               |
| Receives inbox messages    | Server-initiated sampling, elicitation, progress, cancellation              |
| Around-style middleware    | Auth, retry, rate limiting, golden-output capture                           |
| Multi-instance             | One connection per server; multiple servers per app                         |

Treating each connection as a harness gets observability, replay, structured concurrency, and conformance testing for free. The alternative — a passive client that calls `await client.callTool(name, input)` — leaves all that on the table.

## Surface

### Commands

Three groups: **connection lifecycle**, **JSON-RPC operations**, **discovery & catalog**.

```ts
interface MCPConnectionProtocol {
  // ──────────────── Connection lifecycle ────────────────
  //
  // These manage the connection itself. Distinct from JSON-RPC
  // operations: authenticate/reconnect change the connection's
  // status; request/callTool/readResource happen ON a connection
  // already in the "ready" state.

  /**
   * Run the initial auth flow (OAuth redirect, API key challenge,
   * custom token provider). Required when the server's `connect`
   * advertised an auth requirement. `MCPAuthStorage` (configured on
   * the harness) persists tokens; subsequent connects reuse them
   * until reauthenticate / expiry.
   */
  authenticate(input?: MCPAuthInput): Effect<MCPAuthResult, MCPAuthError, never>;

  /**
   * Refresh credentials without dropping the connection. Used when
   * the server returns an unauthorized response mid-session or when
   * a token's TTL is about to expire.
   */
  reauthenticate(): Effect<MCPAuthResult, MCPAuthError, never>;

  /**
   * Full teardown + re-establish. Preserves server identity (id /
   * config) but resets the connection state and pending requests.
   * Auto-reconnect (with backoff) lives in middleware; this is the
   * imperative path.
   */
  reconnect(): Effect<void, MCPConnectionError, never>;

  /**
   * Liveness check. Sends an `mcp/ping` to the server; latency is
   * recorded on the terminal envelope for observability.
   */
  ping(): Effect<MCPPingResult, MCPError, never>;

  /** Disconnect gracefully. Idempotent. */
  disconnect(): Effect<void, never, never>;

  // ──────────────── JSON-RPC operations ────────────────

  /** Generic JSON-RPC outgoing. The lower-level surface. */
  request(input: MCPRequestInput): Effect<MCPResponse, MCPError, never>;

  /** Convenience: invoke a tool exposed by the server. */
  callTool(input: MCPCallToolInput): Effect<MCPToolResult, MCPError, never>;

  /** Convenience: read a resource body. */
  readResource(input: MCPReadResourceInput): Effect<MCPResourceContents, MCPError, never>;

  /** Convenience: fetch a prompt template. */
  getPrompt(input: MCPGetPromptInput): Effect<MCPPromptResult, MCPError, never>;

  // ──────────────── Discovery & catalog ────────────────

  /** Fetch the current tool / resource / prompt lists (may be cached). */
  listTools(): Effect<readonly ToolDeclaration[], MCPError, never>;
  listResources(): Effect<readonly ResourceDeclaration[], MCPError, never>;
  listPrompts(): Effect<readonly MCPPrompt[], MCPError, never>;
}
```

Every command is a journaled operation:

- `mcp:command:authenticate:requested / :before / :terminal`
- `mcp:command:reauthenticate:requested / :before / :terminal`
- `mcp:command:reconnect:requested / :before / :terminal`
- `mcp:command:ping:requested / :before / :terminal`
- `mcp:command:disconnect:requested / :before / :terminal`
- `mcp:command:request:requested / :before / :terminal`
- `mcp:command:call-tool:requested / :before / :delta (progress) / :terminal`
- `mcp:command:read-resource:requested / :before / :terminal`
- `mcp:command:get-prompt:requested / :before / :terminal`
- `mcp:command:list-tools:requested / :before / :terminal`
- `mcp:command:list-resources:requested / :before / :terminal`
- `mcp:command:list-prompts:requested / :before / :terminal`

Adopters subscribe to `app.events({ surface: "mcp", name: "mcp:command:authenticate:terminal" })`
to audit auth events; same pattern for any other command.

Adopters who don't need the convenience methods can use `request()` directly with raw JSON-RPC.

### Events (bus)

In addition to per-command envelopes:

```
mcp:status:connecting          mcp:status:ready
mcp:status:failed              mcp:status:disconnected
mcp:tools:list-updated         mcp:resources:list-updated
mcp:resources:updated          # specific URI changed
mcp:prompts:list-updated
mcp:notification:custom        # server-defined notification
```

### Lifecycle handlers

```ts
// Connection lifecycle
mcp.onConnect((info: MCPServerInfo) => …);
mcp.onDisconnect((reason: MCPDisconnectReason) => …);
mcp.onReconnectAttempt(({ attempt, delayMs }) => …);
mcp.onReconnectFailed((err: MCPConnectionError) => …);

// Auth lifecycle
mcp.onAuthRequired((challenge: MCPAuthChallenge) => …);
mcp.onAuthSucceeded((result: MCPAuthResult) => …);
mcp.onTokenExpired(() => …);

// Protocol lifecycle
mcp.onProtocolError((err: MCPProtocolError) => …);
mcp.onUnsupportedFeature((feature: string) => …);
mcp.onResourcesUpdated((uris: readonly string[]) => …);
```

`onAuthRequired` is the hook adopters wire UI flows to (OAuth redirect,
API key prompt). The default impl uses the configured `MCPAuthStorage`
(see below); custom flows override via this handler.

### Auth storage

OAuth tokens, API keys, refresh tokens — all credentials — go through
a single pluggable interface:

```ts
interface MCPAuthStorage {
  get(connectionId: string): Promise<MCPCredentials | undefined>;
  set(connectionId: string, credentials: MCPCredentials): Promise<void>;
  clear(connectionId: string): Promise<void>;
}
```

Default impl is in-memory (lost on app close — fine for dev). Durable
impls bind to OS keychain, AWS Secrets Manager, etc.:

```ts
withMCP({
  authStorage: new KeychainMCPAuthStorage({ service: "agentick" }),
});
```

The auth storage is `MCPAuthStorage`-keyed, not `<MCP>`-component-keyed —
multiple connections to the same `connectionId` share credentials. This
matters for multi-session apps where a single user authenticates once
and the token is reused across spawned sessions.

### Auto-reconnect

Auto-reconnect is **middleware**, not built into the protocol:

```ts
mcp.use(
  autoReconnect({
    maxAttempts: 5,
    backoff: "exponential",
    initialDelayMs: 250,
    maxDelayMs: 30_000,
  }),
);
```

The middleware listens for `mcp:status:disconnected` events, calls
`mcp.reconnect()` with backoff, and stops after `maxAttempts`. Ship a
default-on `autoReconnect()` middleware in `@agentick/mcp/react` so
adopters get sensible behavior out of the box; they opt out via
`withMCP({ autoReconnect: false })`.

### Middleware

```ts
mcp.use({
  aroundRequest: (input, next) => …,
  aroundCallTool: (input, next) => …,
  aroundSampling: (input, next) => …,    // incoming server callback
  aroundElicitation: (input, next) => …, // incoming server callback
});
```

### Inbox — server-initiated calls

The MCP spec lets servers call back into the host:

| Server method                | Inbox message kind      | Routes to                                                                 |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `sampling/createMessage`     | `sampling-request`      | The app's executor — generates a model response per the server's request  |
| `elicitation/create`         | `elicitation-request`   | The reconciler — surfaces a UI prompt to the user (or a noop in headless) |
| `roots/list`                 | `roots-request`         | A configured roots provider on the harness                                |
| `notifications/cancellation` | `cancel-request`        | The pending request map; aborts in-flight ops                             |
| `notifications/progress`     | `progress-notification` | Emits delta envelope on the in-flight op's event stream                   |

Adopters intercept these via middleware (`aroundSampling`, `aroundElicitation`) for auth/audit; the default behavior wires sampling to the app's executor and elicitation to a user-prompt bridge (TBD — likely a new `ElicitationBridge`).

## MCPBridge as registry of harnesses

```ts
interface MCPBridge {
  register(connection: MCPConnectionHarness): Unsubscribe;
  unregister(id: string): void;
  get(id: string): MCPConnectionHarness | undefined;
  list(): readonly MCPConnectionHarness[];
  subscribe(listener: () => void): Unsubscribe;
}
```

The bridge is **not** the protocol surface. Adopters get a harness back and call its methods (with full substrate observability). The bridge just brokers identity.

## JSX integration

```tsx
import { withMCP, MCP } from "@agentick/mcp/react";

createApp(
  <Agent>
    <MCP id="files" transport="stdio" command="mcp-server-filesystem" />
    <MCP id="github" transport="http" url="https://api.github.com/mcp" />
    <Conversation />
  </Agent>,
  {
    model: openai("gpt-5"),
    extensions: [withMCP()],
  },
);
```

The `<MCP>` component:

1. Calls `useData` to await `MCPConnectionHarness.ready` (Effect-typed connection init)
2. Registers the harness with the `MCPBridge` (from `bridges.mcp`)
3. Emits an `MCPDeclaration` IR fragment via the `mcpContributor` (snapshot persistence)
4. Surfaces server-exposed tools as `ToolDeclaration` fragments — the model sees MCP tools as native tools
5. Cleans up via `useOnUnmount` → harness disconnect → bridge unregister

## How MCP tools flow into the agent

The agent's tool list (`RuntimeDeclarations.tools`) includes:

- Tools declared in JSX (`<tool>` intrinsic)
- Tools surfaced from connected MCP servers (via `MCPConnectionHarness.listTools()`)

The reconciler's collect walker:

1. Pulls `bridges.mcp.list()` at fold time
2. For each ready connection, includes its tools in the declared tool list
3. Each MCP tool's `handlerRef` is a synthetic id like `mcp:<connection-id>:<tool-name>`
4. The session's tool executor's HandlerResolver gets a synthetic handler that proxies to `mcpHarness.callTool(name, input)`

So when the model calls an MCP tool:

- Tool executor dispatches normally (journaled, observable)
- The synthetic handler proxies to `mcpHarness.callTool(name, input)`
- That call is ALSO journaled as an MCP operation
- Two layers of journaling: the agent tool dispatch + the MCP protocol call
- Adopters can filter `app.events({ surface: "mcp" })` for protocol-level observability

## What v2 gains over v1

| v1                                                      | v2                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `MCPClient.callTool(...)` returns `Promise<ToolResult>` | `mcp.callTool(input)` returns `Effect<MCPToolResult, MCPError, never>`           |
| Cancellation via custom AbortController plumbing        | Fiber interruption walks the connection's pending requests                       |
| Health monitoring via `client.getHealth()` polling      | Connection status is a live bus event stream                                     |
| Tool list changes via `client.on("tools-changed", …)`   | Bus subscription with structured `EventQuery`                                    |
| Sampling callbacks dispatched directly                  | Routed through inbox; middleware can intercept                                   |
| No audit trail                                          | Every JSON-RPC request is a journaled envelope                                   |
| No replay                                               | Journal supports replay for debugging                                            |
| Hand-rolled error types                                 | Tagged `_tag` errors throughout                                                  |
| OAuth lives inside the client class                     | `MCPAuthStorage` is a pluggable interface; keychain / vault / file impls plug in |
| Auto-reconnect built-in                                 | Auto-reconnect is middleware; composes with retry / rate limit / audit           |
| Token refresh is implicit                               | Explicit `reauthenticate()` command, journaled, middleware-able                  |

## Migration path for v1 adopters

```diff
- import { MCPClient } from "@agentick/mcp";
- const client = new MCPClient({ servers: [...] });
- await client.connect();
- const result = await client.invokeTool("files", "read", { path });

+ import { withMCP } from "@agentick/mcp/react";
+ const app = await createApp(<Agent />, {
+   model,
+   extensions: [withMCP()],
+ });
+ // MCP connections declared in JSX via <MCP id="files" ...>
+ // Tools surfaced to the model automatically
+ // For direct invocation outside the model:
+ const harness = app.bridges.mcp.get("files");
+ const result = await Effect.runPromise(harness.callTool({ name: "read", input: { path } }));
```

The direct-invocation path mostly disappears — the model uses MCP tools as native tools. Direct calls only matter for tests / utility flows.

## What this ADR does NOT decide

- **`MCPServer` (exposing our agent as MCP).** Separate concern. Likely a different harness (`MCPServerHarness`) or a transport adapter on AppHarness. Out of scope here. v1 has `MCPServer` in the same package; v2 keeps it co-located but it's a different surface.
- **Concrete inbox message schemas.** Sketched above; full types in the impl PR.
- **Elicitation bridge.** Mentioned as TBD. Likely a separate bridge (`ElicitationBridge`) that surfaces "ask the user" calls — could be a console prompt in CLI, a modal in the UI, a Slack message in a connector.
- **MCP Apps capability port.** v1 has custom MCP Apps support. v2 should keep it but I haven't designed where it sits in the harness yet — likely as a method on `MCPConnectionHarness` (`apps(): Effect<MCPApp[], …>`).
- **Roots provider.** v1 supports `roots/list` callbacks. v2 needs a way for adopters to configure the roots — probably via `withMCP({ roots: [...] })` or a per-`<MCP>` prop.
- **Progressive resource discovery.** v1 has lazy resource loading. v2 likely keeps it; concrete shape TBD in impl.

## Implementation cost (estimate)

- ADR (this doc): done
- `MCPConnectionHarness` skeleton (BaseHarness<"mcp">, command surface, lifecycle): ~1 day
- Transport adapters (stdio, http, sse, streamable-http) ported from v1: ~1 day
- JSON-RPC dispatcher + pending-request map + cancellation: ~half day
- Server-initiated inbox messages + middleware hooks: ~half day
- `MCPBridge` impl + `mcpContributor` + `<MCP>` component: ~half day
- Tool-list surfacing + synthetic handler resolver: ~half day
- `withMCP()` factory + augmentation: ~1 hour
- Tests + conformance: ~1 day
- Migration docs: ~half day

**Total: ~5-6 days of focused work.**

## Sequencing recommendation

1. **Ship `@agentick/sandbox` v2 first** (smaller, validates the extension package shape end-to-end).
2. **Revise this ADR if sandbox surfaces design issues** that apply to MCP.
3. **Implement MCP-as-harness** following this design (or its revision).
4. **Defer `MCPServer`** until at least one adopter needs to expose v2 agents as MCP.

## Open questions

- **OQ23.1** — Should `MCPConnectionHarness` expose `request()` AND the convenience methods (`callTool`, `readResource`, `getPrompt`), or just `request()` with consumers building their own convenience layer? _Lean: ship both. The convenience methods are journaled per-method so they show up cleanly in app.events._
- **OQ23.2** — When the server changes its tool list mid-session, does the agent's `RuntimeDeclarations` re-collect automatically? _Lean: yes — `mcp:tools:list-updated` event triggers a reconciler rerender via the bridge subscription._
- **OQ23.3** — Sampling callbacks invoke the executor. If middleware on the executor rate-limits them, what's the error path back to the server? _Lean: middleware rejection → MCP protocol error sent back; document the contract._
- **OQ23.4** — Should the inbox be ONE inbox shared with the rest of the app, or per-connection? _Lean: per-connection. Inbox is scoped to harness; multi-server isolation is cleaner._
- **OQ23.5** — Auth storage interface lives in `@agentick/mcp` or `@agentick/spec`? _Lean: `@agentick/mcp`. It's MCP-specific (token shape varies per auth flow); putting it in spec leaks domain detail._
- **OQ23.6** — When `authenticate()` requires user interaction (OAuth redirect), how does the harness surface it in headless / server contexts? _Lean: throws `AuthInteractionRequired` with the redirect URL; adopters either handle interactively (open browser) or via an `MCPAuthStorage` that pre-populates tokens. The `<MCP>` JSX component installs an `onAuthRequired` handler that integrates with the elicitation bridge for UI flows._
- **OQ23.7** — Auto-reconnect middleware bundled in `@agentick/mcp/react` (default-on) or shipped separately as `@agentick/mcp-auto-reconnect`? _Lean: bundled, default-on; this is what every adopter wants._

## Cross-references

- [ADR 22](./22-state-formatters-reconciler-shape.md) — bridge extensibility pattern.
- [01 — Harness Principle](./01-harness-principle.md) — five-surface contract.
- [07 — Tool Executor](./07-tool-executor.md) — synthetic handler resolution for MCP tools.
- [10 — Events / Handlers / Inbox](./10-events-handlers-inbox.md) — the inbox model.
- [19 — Foundation](./19-foundation.md) — BaseHarness substrate.
