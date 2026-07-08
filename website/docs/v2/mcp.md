# MCP: Connecting to Servers

The [Model Context Protocol](https://modelcontextprotocol.io) is a wire standard for
exposing tools, resources, prompts, and other capabilities between an AI host and
external servers. Agentick speaks both ends of it: this guide covers the **client**
side — connecting your agent to remote MCP servers and pulling their capabilities
into your session. To go the other direction (expose _your_ agent as an MCP server),
see [Exposing an MCP server](/docs/v2/mcp-server).

## The mental model: MCP is a projection, not a new subsystem

The most important thing to understand before writing any `withMCP` config:

**Resources, tools, prompts, elicitation, and logging/progress are framework
primitives that exist independently of MCP.** MCP is _one projection_ of those
seams onto a wire. The MCP client surfaces a remote server's capabilities **into**
those same primitives; the MCP server projects **yours** out. Same registries, two
directions.

Concretely, when you connect to a remote server:

- Its **tools** register into your session's tool executor — the model calls them
  like any native tool.
- Its **resources** surface into your session's one resources registry — readable
  via `resource_read`, `session.resources`, or `ctx.resource` (see
  [Resources](/docs/v2/resources)).
- Its inbound **elicitation** requests route through your session's elicitation
  harness.

You don't learn a separate "MCP API." You wire a connection, and a remote server's
capabilities show up in the primitives you already use.

## Quickstart

Connect a session to one or more servers with the `withMCP` extension. Each server
is identified by a **`serverId`** (an alias _you_ assign) and a **transport**.

```tsx
import { createApp } from "@agentick/app-next/react";
import { openai } from "@agentick/model-openai-next";
import {
  withMCP,
  streamableHttpTransport,
  StdioClientTransport,
} from "@agentick/mcp-next";

const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
  extensions: [
    withMCP({
      servers: [
        {
          serverId: "linear",
          transport: streamableHttpTransport({
            url: "https://mcp.linear.app/mcp",
            oauth: true,
          }),
        },
        {
          serverId: "filesystem",
          transport: new StdioClientTransport({
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
          }),
        },
      ],
    }),
  ],
});
```

After a session is created, each server's discovered tools are already in the
session's tool executor. The model calls them directly; there is no extra wiring.

## One connection per (session, server)

`withMCP` opens a **fresh connection per session, per server** — N sessions × M
servers → N×M connections. This is deliberate, and it's the architectural floor for
MCP in agentick:

- **Multi-tenant correctness.** MCP binds OAuth tokens, the `Mcp-Session-Id`, and
  authorization _to the connection_. Two users on the same agentick host must have
  different connections because they have different tokens. Sharing a connection
  across users is a wire violation.
- **Concurrent elicits work by construction.** Each connection has a fixed
  elicit-address (its session's), so a server prompting for input never races
  against another session's prompt.
- **Isolated auth scopes.** Even the same user across two sessions (debug vs. prod,
  sandbox vs. real) gets independent auth.

A connection pool keyed by auth principal is a planned optimization for
high-tenant HTTP deployments, but per-session isolation is the correct default and
what ships today.

## Tool discovery and naming

Discovered tools are registered under a per-server prefix to avoid collisions:
`<serverId>__<toolName>`. So a `search` tool on server `linear` becomes
`linear__search`.

```tsx
// Override the prefix (empty string keeps names verbatim — at the risk of
// cross-server collisions):
withMCP({
  servers: [{ serverId: "linear", transport, toolPrefix: "" }],
});
```

If a server pushes `notifications/tools/list_changed`, the client tears down the old
registrations and re-discovers automatically — the model sees the updated tool set
on its next tick.

**Failure is non-fatal per server.** A server that fails to connect is recorded but
doesn't abort the rest — the connection's lifecycle FSM moves to `degraded` (or
`reconnecting` if you set a `reconnect` policy). Observe state via
`bridges.mcp.client(serverId)`.

## Surfacing a remote server's resources

After tool discovery, `withMCP` pulls each server's `resources/list` and
`resources/templates/list` and **proxy-registers** every entry into your session's
one resources registry, so remote content reads through the same interface as your
own (see [Resources](/docs/v2/resources)):

```
register("mcp://<alias>/<originalUri>", () => client.readResource(originalUri))
```

The result: the model reads remote resources with `resource_read`, your code reads
them via `session.resources`, and your own MCP-server projection can re-expose
them — all composed through one registry, no special-casing.

```ts
// A remote resource config://app on server "docs" is readable as:
const contents = await session.resources.read("mcp://docs/config://app");
```

Re-surfaced on `notifications/resources/list_changed`; unregistered on session
close.

### Alias trust — a correctness guarantee

Every surfaced URI is keyed by the **adopter alias** — the `serverId` _you_ assigned
in `withMCP({ servers })`. The server's self-reported name is an **untrusted display
label** and is never used for keying.

The convention is `mcp://<alias>/<originalUri>`: the alias is the URI authority, and
the original URI (scheme and all) is the path, so the mapping round-trips
losslessly. Because the namespace derives only from the trusted `serverId`, a
malicious or buggy server that reports a name colliding with another server's alias
**cannot shadow that alias's namespace**. Tool names (`<alias>__<tool>`), resource
URIs (`mcp://<alias>/…`), and the server-info summary all derive from the trusted
alias alone.

Treat this as a security property, not a formatting choice: never key trust
decisions on a server's advertised `name`.

## Roots — advisory boundaries you expose to a server

MCP **roots** are `file://` filesystem boundaries a _client_ exposes to a _server_
("operate within these directories"). Two things to be clear about:

- **Roots are advisory, not enforced containment.** They tell a well-behaved server
  where you'd like it to work. Enforcement lives in your sandbox / egress controls,
  not in roots. Never treat "I exposed a root" as "the server is confined."
- **Roots are content boundaries, not content transfer.** Transferring content is
  what _resources_ do (server → client). Roots go the other direction (client →
  server) and carry only the boundary list.

Roots are modeled as a **projection over existing primitives, not a new
subsystem** (ADR 65): mount state is owned by the sandbox, reads by resources, and
MCP is one projection of both. The source is pluggable — a static list works with no
sandbox at all:

```ts
import { McpClientHarness } from "@agentick/mcp-next";

// Static list — no sandbox required:
const harness = new McpClientHarness(scopeId, journal, bus, inbox, {
  serverId: "fs",
  transport,
  roots: [{ uri: "file:///data", name: "data" }],
});
```

The **sandbox adapter** is the flagship source: when a deployment _is_ sandboxed,
the boundaries you declare to a peer equal the boundaries you enforce, and mount
changes keep the peer in sync automatically.

```ts
import { sandboxRootsSource, bindSandboxRootsToClient } from "@agentick/sandbox-next/mcp";

const harness = new McpClientHarness(scopeId, journal, bus, inbox, {
  serverId: "fs",
  transport,
  roots: sandboxRootsSource(sandbox), // workspace + mounts → roots/list
});
// Re-advertise roots/list_changed whenever the sandbox's mounts change:
const unsub = bindSandboxRootsToClient(sandbox, harness);
```

> **Note (current shape).** The `roots` source is configured at the
> `McpClientHarness` level. `withMCP({ servers })` does not yet forward a per-server
> `roots` source through its config — reach the harness via
> `bridges.mcp.client(serverId)` if you need to bind roots to a `withMCP`-managed
> connection, or construct the harness directly for full control. The provider-fn
> seam is intentionally the escape hatch (ADR 65).

## Transports

| Transport | Factory | Notes |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| **Streamable HTTP** | `streamableHttpTransport({ url, oauth? })` | Remote servers; OAuth-capable. Returns a per-session factory. |
| **stdio** | `new StdioClientTransport({ command, args })` | Local subprocess servers (one connection per process). |
| **in-memory** | `new InMemoryMcpTransport()` | Tests / loopback against a `Server` in the same process. |

`streamableHttpTransport` returns a **transport factory** — `withMCP` constructs it
once per session, which is what makes per-session OAuth isolation work. Pre-built
transport instances (stdio, in-memory) are single-connection; passing one to
multiple sessions shares it and breaks under concurrency. For multi-session HTTP
deployments, always use the factory form.

### OAuth over HTTP

Set `oauth: true` (or an options object) on `streamableHttpTransport` and the
factory wires a `DefaultOAuthProvider`. The provider drives the authorization-code
flow; when a redirect is needed it fires through the session's elicitation surface
(URL-mode elicit), so the user can complete auth and the originating call retries.

```ts
streamableHttpTransport({
  url: "https://mcp.example.com/mcp",
  oauth: {
    onAuthorizationNeeded: (url) => openBrowser(url),
  },
});
```

OAuth utilities (`DefaultOAuthProvider`, `OAuthCallbackServer`, custom providers)
are also available on the `@agentick/mcp-next/oauth` subpath for CLI bootstrap or
bespoke flows.

## Inbound elicitation

When a connected server issues `elicitation/create` (it needs input from the user
mid-call), the request routes through your session's elicitation harness — the same
primitive you use for your own prompts. The client advertises the `elicitation`
capability by default (`{ form: {}, url: {} }`), so servers can prompt for both
structured forms and URL-mode (OAuth-style) flows.

## Credentials never cross the wire — a guarantee

Server-resident credential material — OAuth tokens, client secrets, PKCE verifiers,
discovery documents — **stays on the agentick host.** It is persisted through the
credentials store (keyed `mcp:<serverId>:<field>` by default) and read by the
transport when it builds a request. Token material is never projected to a client of
_your_ gateway and never leaves the server side. When you expose your own agent as
an MCP server, only verbs and status cross the wire, never the secrets behind them.

Namespace credentials per tenant either by encoding the principal in `serverId`
(structural identity — recommended) or via the `credentialKey` strategy on
`withMCP`. See the `withMCP` options for the full multi-tenant discussion.

## When NOT to use this — gotchas

- **Don't share a pre-built transport across sessions.** stdio / in-memory instances
  are single-connection. Use the `streamableHttpTransport` factory for anything
  multi-session.
- **Roots are advisory.** Exposing a root is not a security boundary. Confine with
  the sandbox / egress, and treat roots as a hint to well-behaved peers.
- **Never trust a server's self-reported `name`.** Key everything on the `serverId`
  alias you control. This is the alias-trust guarantee, not a style preference.
- **A server's resources are pulled, not pushed.** Surfacing populates the catalog;
  the content is fetched only when something reads the `mcp://<alias>/…` URI —
  standard pull semantics (see [Resources](/docs/v2/resources)).
- **Per-server failures are silent by design.** A server that fails to connect
  degrades its own connection but doesn't abort the others. Watch
  `bridges.mcp.client(serverId)` if you need to react.

## See also

- [Exposing an MCP server](/docs/v2/mcp-server) — the other direction.
- [Resources](/docs/v2/resources) — the pull primitive remote resources surface into.
- [Tools](/docs/tools) — where discovered tools land.
- [Sandbox](/docs/sandbox) — the filesystem primitive roots + file-resources project from.
- [`@agentick/mcp-next` README](https://github.com/agenticklabs/agentick/blob/feat/v2/packages-next/mcp/README.md) — package overview, connection lifecycle, capability negotiation.
- ADRs: [62 — resources](https://github.com/agenticklabs/agentick/blob/feat/v2/docs/proposals/v2/blueprint/62-resources-harness.md), [64 — runtime signals (log/progress)](https://github.com/agenticklabs/agentick/blob/feat/v2/docs/proposals/v2/blueprint/64-runtime-signal-family.md), [65 — roots as projection](https://github.com/agenticklabs/agentick/blob/feat/v2/docs/proposals/v2/blueprint/65-roots-as-projection.md).
