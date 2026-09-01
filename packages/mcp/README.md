# @agentick/mcp

Model Context Protocol, both directions. Connect a session **out** to any number
of MCP servers, and serve your own tools, prompts, and elicitation **in** to
remote MCP clients — from one package, over shared internals (transport
plumbing, era codec, OAuth, JSON-RPC framing, the Standard Schema bridge).

Targets the MCP `draft` spec, with the latest official release (`2025-11-25`)
supported through an era-codec layer at the wire edge.

This README covers the **client** direction. The server direction has its own
document: **[`src/server/README.md`](src/server)**.

## Subpaths

| Import                  | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `@agentick/mcp`         | Client harness + the `withMCP` extension. Agentick → servers. |
| `@agentick/mcp/server`  | Server harness. Remote clients → Agentick.                    |
| `@agentick/mcp/oauth`   | OAuth 2.1 utilities, shared by both directions.               |
| `@agentick/mcp/testing` | `runMcpConformance` — the executable interop suite.           |

The split is deliberate: a browser or edge bundle that only consumes the client
subpath never pulls the server's Node transport and filesystem code.

## Install

```bash
npm install @agentick/mcp
```

## Quick start

`withMCP` is a session extension. Give each server an id and a transport; its
tools land in the session's tool executor, prefixed with that id.

```typescript
import { createApp } from "@agentick/app";
import { StdioClientTransport, streamableHttpTransport, withMCP } from "@agentick/mcp";

const app = await createApp(<MyAgent />, {
  extensions: [
    withMCP({
      servers: [
        {
          // `serverId` is an alias YOU assign. Tools register as
          // `docs__<toolName>`, and it keys bridges.mcp.client("docs").
          serverId: "docs",
          transport: streamableHttpTransport({ url: "https://example.com/mcp" }),
        },
        {
          serverId: "fs",
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

That's the whole integration. Discovered tools are callable by the model
immediately; inbound `elicitation/create` from a server reaches the session's
Elicitation; each server's resources become readable through the session's
Resources.

## One connection per (session, server)

`withMCP` builds a separate `McpClientHarness` for every session, for every
server. This is not an implementation detail you can tune away — it's forced by
the protocol. MCP binds OAuth tokens, `Mcp-Session-Id`, and authorization to the
_connection_, so two users sharing one connection is a wire violation, not an
optimization. Per-session connections also mean each harness has a fixed elicit
address, which is why concurrent elicits across sessions need no arbitration.

The cost is N sessions × M servers connections. That's fine for HTTP streams and
wasteful for stateless local stdio servers — see the gaps below.

Failure is per-server: a server that can't connect is recorded and skipped, and
the rest of that session's servers still come up. Watch it through
`bridges.mcp.client(id)?.status` or by subscribing to `onStatusChange`.

## Reaching a client at runtime

`withMCP` publishes the per-session clients on the `mcp` bridge slot. In JSX,
`useBridges().mcp?.client("docs")`; in a hook or tool, the same slot off
`bridges`.

```typescript
const client = bridges.mcp?.client("docs");

client?.status; // { kind: "connected" } | { kind: "credentials-expired", reason? } | ...
client?.serverInfo; // { serverId, status, implementation, capabilities }

const off = client?.onStatusChange((status) => {
  if (status.kind === "credentials-expired") void client.reauthenticate();
});
```

`isTerminalStatus(status)` is the settled-vs-transitional predicate — useful in
UI reducers and tests that wait for a connection to stop moving. The lifecycle
verbs are `connect`, `disconnect`, `reconnect`, and `reauthenticate`.

You don't need the harness to call a tool. Dispatch goes through the normal
path: `session.tools.dispatch("docs__search", { query })`.

### Wire-level operations

Beyond tools, the harness exposes the client half of the protocol directly:

| Area       | Methods                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------- |
| Tools      | `listTools`, `callTool`                                                                            |
| Tasks      | `callToolAsTask`, `getTask`, `getTaskResult`, `listTasks`, `cancelTask`, `taskNotifications`       |
| Resources  | `listResources`, `listResourceTemplates`, `readResource`                                           |
| Prompts    | `listPrompts`, `getPrompt`                                                                         |
| Completion | `completePromptArgument`, `completeResourceTemplate` — full `CompletionResult`, optional `context` |
| Logging    | `setLoggingLevel`, `onLogMessage`                                                                  |
| Roots      | `notifyRootsListChanged`                                                                           |
| Lifecycle  | `connect`, `disconnect`, `reconnect`, `reauthenticate`, `onListChanged`, `currentCodec`            |

Paginated list verbs take an optional cursor and return a page with the next
one.

## Transports

Three shapes, and one important distinction between them.

```typescript
import { InMemoryMcpTransport, StdioClientTransport, streamableHttpTransport } from "@agentick/mcp";
```

`StdioClientTransport` and `InMemoryMcpTransport` are **instances**. Handing an
instance to `withMCP` is safe for a single session and broken for several: they'd
share one transport and collide under concurrent connections.

`streamableHttpTransport(...)` returns a **factory** instead —
`(deps) => Transport`, invoked once per session at install time. `deps` carries
that session's elicit binding, its `serverId`, Credentials if one is installed,
and the resolved credential key, which is what makes OAuth work
without per-session boilerplate. Multi-session deployments want the factory
form; `isTransportFactory` is the discriminator if you're writing your own.

```typescript
streamableHttpTransport({
  url: "https://example.com/mcp",
  requestInit: { headers: { authorization: `Bearer ${token}` } }, // static-token servers
  oauth: true, // or an options object
});
```

With `oauth` enabled, the factory wires a `DefaultOAuthProvider` bound to the
session: the authorize step surfaces as a URL-mode elicit, tokens persist
through the credentials substrate when present (in-memory otherwise), and the
browser prompt is gated to explicit `reauthenticate()` calls rather than firing
on a background reconnect.

## OAuth credential keys

Tokens, client registration, PKCE verifier, and discovery state are stored under
`mcp:<serverId>:<field>` by default. For multiple principals, the cleanest
approach is **structural identity** — put the principal in the `serverId`:

```typescript
withMCP({
  servers: [{ serverId: `linear:user-${principal.userId}`, transport }],
});
```

The default key then namespaces per principal for free, and each principal gets
its own harness with its own connection — which is what the protocol wants
anyway.

`credentialKey` exists for the unusual case where principals genuinely share one
harness and you need their credentials kept apart inside a shared store:

```typescript
// Declare your principal shape once, anywhere in the app:
declare module "@agentick/spec" {
  interface RuntimeContextUser {
    readonly tenantId: string;
  }
}

withMCP({
  servers: [...],
  credentialKey: (ctx, { serverId, field }) =>
    `mcp:${ctx.user?.tenantId ?? "anon"}:${serverId}:${field}`,
});
```

> [!NOTE]
> The callback reads the ambient runtime context at every call, and that context
> is empty inside Effect fibers unless it was bound at the call boundary. Prefer
> structural identity when you can.

## Tools discovered from a server

Each discovered tool becomes a normal declaration with
`exposure: ["model", "dispatch"]`, so it's reachable by the model and by
`dispatch`. Three things get stamped on it.

**Name.** `<serverId>__<toolName>`. Override with `toolPrefix`; set it to `""`
for verbatim names and accept the cross-server collision risk.

**Provenance.** `annotations.executedBy: "mcp:<serverId>"`, so results are
attributed to the server rather than the framework's default. It's an in-process
stamp on a field absent from the client-facing annotation type, so a remote
client can't forge it.

**Group.** `_meta["agentick/group"]` (a path array, or a single string) files
the tool into the capability tree. A tool that declares none files under
`[serverId]` — a foreign server's tools ARE one capability — and the client
registers a synthesized group declaration ("Tools from `<serverId>`", prose
from the server's identity) so that bucket renders with a paragraph, not a raw
key. A server can do better: put a group-prose manifest on the `tools/list`
RESULT's `_meta` —

```jsonc
"_meta": {
  "agentick/toolGroups": [
    { "path": ["knowify-write", "service"], "title": "Service work",
      "summary": "Service tickets and visits: …", "order": 24 }
  ]
}
```

— and the client registers it into the session's `toolExecutor.groups`,
upserting over the synthesized default (one declaration per group, matching the
paths member tools carry; malformed entries are dropped rather than costing the
tools). Serving side: pass `toolGroups` in `McpServerOptions` and the harness
stamps this `_meta` on every `tools/list` result. Group-unaware clients ignore
result `_meta` per spec.

**Task support.** MCP's `execution.taskSupport` maps onto the framework's own
vocabulary: `required` → `required`, `optional` → `supported`,
`forbidden` → `unsupported`. A `required` tool always goes through the task wire.
A `supported` tool is inline by default and uses the task wire only when the
dispatch asks for a reference — matching how every other `supported` tool in the
framework behaves. `defaultTaskTtl` sets the TTL sent with task calls; the server
may clamp it.

MCP tools narrate by default, like any tool — the framework injects an optional
`_summary` field so the model can describe its own call. That costs a schema
property per tool and tokens per call, so it's opt-out at two levels:

```typescript
withMCP({
  narrate: false, // every server here opts out
  servers: [
    { serverId: "docs", transport },
    { serverId: "fs", transport, narrate: true }, // ...except this one
  ],
});
```

When a server pushes `notifications/tools/list_changed`, the previous
registrations are torn down and discovery re-runs, serialized so overlapping
notifications can't interleave.

## A server's resources, through one interface

After tool discovery, `withMCP` pulls each server's `resources/list` and
`resources/templates/list` and proxy-registers every entry into the session's
Resources as `mcp://<serverId>/<originalUri>`. One consequence worth
stating plainly: there is no separate "MCP resources" API. The model reads them
with `resource_read`, your code reads them through `session.resources`, and your
own MCP server projection can re-expose them — all the same interface.
Re-surfaced on `notifications/resources/list_changed`; unregistered on session
close.

> [!IMPORTANT]
> Keys derive from the **alias you assigned**, never from the server's
> self-reported name. That name is an untrusted display label. A server that
> reports a name colliding with another server's alias therefore cannot shadow
> that namespace — tools, resource URIs, and the server-info projection all key
> off the trusted `serverId` alone.

The compiler also surfaces a summary of connected servers into model context
(`mcpServerInfo`), keyed by alias: display name and version, connection state,
and an advertised-capability summary. It's lazy, overridable via
`<Project projectionKey="mcpServerInfo">`, and reads the bridge structurally so
the compiler carries no dependency on this package.

## A server's prompts, in your palette

Prompts fold the same way, into the session's Prompts as
`<promptPrefix><remoteName>` (default `<serverId>__`; pass `promptPrefix: ""` for
bare names when one server owns the palette). A folded prompt renders by calling
`prompts/get` at invoke time rather than caching a rendering, so a server whose
prompt text changes without announcing it still serves the current one.
Re-surfaced on `notifications/prompts/list_changed`; removed on session close.
Declare `prompts` before `withMCP` — a session with no prompts namespace has
nothing to fold into, and the fold is skipped.

**Their argument slots complete.** Each folded argument carries a forwarding
resolver: the native completion seam runs it, and its body re-asks the origin
server's `completion/complete`. The siblings the user already filled ride along
as MCP's `context.arguments`, which is what makes a conditional slot answerable —
typing into `phase` offers the phases of the job chosen two slots ago. Every
argument gets one, because `prompts/list` advertises no per-argument
completability; a server with nothing to say for that argument answers empty
values, which is the composer's dismissal. A server that never advertised the
`completions` capability gets no resolver at all, so the slot reads as
uncompletable rather than spending a request per keystroke, and a server that
advertised it but declines this particular ref answers empty rather than throwing
on every character typed.

## Serving Agentick as an MCP server

The full story is in **[`src/server/README.md`](src/server)**: deployment
modes, the tools and prompts slots, elicitation, completions, the security
pipeline, OAuth resource-server discovery, and per-connection request context.

One server-side option isn't covered there yet — the open `extensions`
namespace. The advertised capability set is _closed_: the harness knows which
projection modules are attached, so it refuses to advertise what it cannot
serve, and `options.capabilities` can only opt **out** of a wired capability,
never in to an unwired one. Spec extensions are the opposite case, because their
surface (a `ui://` template, a `_meta` convention, an out-of-band rendering
contract) is invisible to the harness. So `options.extensions` is merged
verbatim into the advertised capabilities, and the claim is yours to keep
honest:

```typescript
new McpServerHarness(scopeId, journal, bus, inbox, {
  name: "my-server",
  transports: [httpTransport({ port: 3000 })],
  resources: myResourcesHarness, // serves the ui:// templates
  extensions: {
    "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
  },
});
```

This matters for MCP Apps specifically: a conformant host refuses to render a
`ui://` resource unless the server negotiated the extension at `initialize`.
Registering the resources and attaching the tool extensions is only half the
contract. Clients read it back as
`client.getServerCapabilities().extensions`.

Construction-time validation checks that the bag is an object with non-empty
keys and object values. It does **not** enforce a key format — vendor-prefixed
reverse-DNS is the spec's convention, not a grammar, and rejecting a legal
identifier would be a bug rather than strictness. Absent or empty means no
`extensions` key on the wire at all.

## API reference

### Client

| Export                                             | Role                                                        |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `withMCP(options)`                                 | The session extension. `McpServerConfig` / `WithMCPOptions` |
| `McpClientHarness`                                 | One connection to one server                                |
| `McpHookBridge`                                    | The `bridges.mcp` slot: `client(id)` and `clients`          |
| `isTerminalStatus(status)`                         | Settled-vs-transitional predicate                           |
| `BearerAuth`, `NoneAuth`, `McpAuth`                | Auth strategies (`NoneAuth` is the default)                 |
| `McpLifecycle`                                     | The lifecycle state machine                                 |
| `selectCodec`, `DraftPassthroughCodec`, `EraCodec` | Spec-era translation at the wire edge                       |

### Transports

`StdioClientTransport` (with `StdioServerParameters`), `InMemoryMcpTransport`,
`streamableHttpTransport` (with `StreamableHttpTransportOptions` /
`StreamableHttpOAuthOptions`), `isTransportFactory`, `TransportFactory`,
`TransportFactoryDeps`.

### Content mapping

Inbound (a server's content into framework blocks): `mcpContentToBlocks`,
`mapCallToolResult`, `mapResourceContents`, `MappedCallToolResult` — preserving
structured content, the error flag, and embedded resource blocks.

Outbound (framework blocks onto the wire): `toWireContent`,
`toWireContentBlock` — the whole 23-member `ContentBlock` union narrowed onto
MCP's five. Native kinds pass through unchanged; a url-sourced medium becomes a
`resource_link`; everything else becomes fenced text whose info string names the
kind that was projected. Applied by the server's `tools/call` and `prompts/get`
projections; see
[the server README](./src/server/README.md#content-on-the-way-out) for the
per-kind table.

### Protocol utilities

`ErrorCodes`, `protocolError`, `rethrowAsProtocolError`, `safeToolHandler`,
`sanitizeErrorMessage`, `stripMcpErrorPrefix`, `toMCPResult`, `toolError`,
`toolResult`; and for completions, `completeFromList`, `completeFromEnum`,
`completeFromAsync`, `completePrefixMatch`, `completeDependent`,
`normalizeCompletionResult` — re-exported from
[`@agentick/completions`](../completions/README.md), which is where they live.
They apply **no** value cap: MCP's 100-value ceiling
(`COMPLETION_MAX_VALUES`, exported from `@agentick/mcp/server`) is applied by the
`completion/complete` projection, because wire constraints live at the wire.

### Tasks

`mcpTaskEffect`, `McpTaskEffectInput`, `McpRemoteTaskNonCompletedError`, plus
the task wire codec.

### OAuth (`@agentick/mcp/oauth`, also re-exported from the root)

`DefaultOAuthProvider`, `OAuthCallbackServer`, `createSDKProvider`, and their
option and token types.

## Conformance

`@agentick/mcp/testing` ships `runMcpConformance` — an executable interop suite
rather than a single-implementation validator, because MCP has two roles that
have to agree. Adding a capability means adding a section, never a rewrite.

```typescript
import { runMcpConformance } from "@agentick/mcp/testing";

runMcpConformance({
  makeResources: async () => /* fresh resources source */,
  makePrompts: async () => /* fresh prompts source */,
  makeElicitation: async (scopeId, journal, bus, inbox) => /* on the CLIENT substrate */,
});
```

The suite injects sibling harnesses through those factories rather than
importing them, so the packages it interoperates with stay development
dependencies instead of leaking into this package's runtime graph. The
elicitation factory must share the client's substrate — that's how the SDK's
elicit handler reaches it.

It runs in three parts:

**Loopback.** A real server harness against a real client harness over the
in-memory transport. Both roles wrap the MCP SDK, so this exercises _our_
translation layers on both sides — real transport, real substrate, only the
model scripted. Covers initialize and negotiation, tools, prompts, resources
(text and blob, plus templates), completion, logging with level filtering,
elicitation in both form and URL mode, and the task lifecycle.

**Real peer.** The SDK's reference `Client` drives our server with no
agentick-side normalization, reaching verbs our client doesn't expose
(`resources/subscribe`, `unsubscribe`, `ping`). A second, gated path runs the
SDK's reference server against our client over stdio — the only peer that can
catch wire-shape drift the shared-SDK loopback structurally cannot. Enable it by
installing `@modelcontextprotocol/server-everything` or setting
`MCP_REFERENCE_SERVER=1`.

**Version matrix.** The loopback re-run against both `draft` and `2025-11-25`
eras. Since `selectCodec` currently collapses every version onto the draft
passthrough, this is a forward guard: it proves the loopback is stable whichever
era is configured, and gives a real `2025-11-25` codec a tested landing spot.

Server-to-client sampling is a `describe.skip` seam, gated behind
`sections.sampling`, until a sampling harness exists.

## Verified by

- `src/__tests__/harness.spec.ts` — client lifecycle transitions, tool
  discovery, and `callTool` round-trip.
- `src/__tests__/with-mcp-e2e.spec.ts` — `withMCP` through a real session: tools
  discovered on session start, a model-issued call routed through the harness.
- `src/__tests__/wave2-client.spec.ts` — the client half against a real
  in-memory SDK server: resource list / templates / read with text and blob
  typing, prompt list and get including embedded-resource blocks, both
  completion verbs (each returning the server's `total` / `hasMore` alongside
  its values), an inbound sampling handler invoked (and method-not-found
  when unconfigured), roots served from both a static list and a provider
  function with nothing else in the graph, `setLoggingLevel` reaching the server
  with `notifications/message` surfacing through `onLogMessage`. Plus content
  mapping for structured content, the error flag, and embedded resources.
- `src/integration/__tests__/resource-surface.spec.ts` — alias round-trip,
  proxy registration under `mcp://<alias>/<uri>` reading through to the original
  URI, template alias stripping, pagination, teardown. Includes an adversarial
  differential: two servers advertise the same URI and one self-reports the
  other's alias as its name — each alias still routes to its own server and
  neither shadows the other.
- `src/integration/__tests__/prompt-surface.spec.ts` and
  `prompt-surface-completion.spec.ts` — the prompts fold: prefixed names, title
  and description kept distinct, arguments carried through, content fetched per
  invoke, teardown leaving no stale palette entry. Completion is proved end to
  end against a real SDK server — a `phase` slot scoped by the `job` already
  filled (and empty for a different job, so the scoping is not an artifact of the
  prefix filter), the origin's `hasMore` surviving the fold, a declined ref
  answering empty rather than throwing, and an unadvertised `completions`
  capability leaving the slot `unavailable`. Includes the two-hop case: the same
  folded prompt re-exposed through our own `McpServerHarness`, where a downstream
  client's `completion/complete` reaches a server it never connected to.
- `src/__tests__/with-mcp-resources-e2e.spec.ts` — a real server's resources
  readable both through `session.resources` and the `resource_read` tool;
  `resources/list_changed` re-surfaces; session close unregisters.
- `src/__tests__/elicit-bridge.spec.ts` — inbound `elicitation/create` reaching
  Elicitation, with accept, decline, cancel, and schema validation.
- `src/__tests__/oauth-elicit.spec.ts` — `DefaultOAuthProvider` publishes a
  URL-mode elicit when authorization is needed.
- `src/__tests__/task-bridge.spec.ts` and `task-codec.spec.ts` — remote task
  notification fan-out, and the task wire codec including capability
  negotiation and per-call opt-in.
- `src/__tests__/skeleton.spec.ts` — every public export resolves; error
  sanitization patterns; the completion-builder cap.
- `@agentick/compiler-react`'s `default-projections.spec.tsx` — the
  `mcpServerInfo` projection keyed by alias, with its provenance tag, override
  suppression, and the server-info alias-trust differential.

Server-side verification is listed in
[`src/server/README.md`](src/server).

## Roadmap & known gaps

- **`runMcpConformance` requires a type the `/testing` barrel doesn't export.**
  Its first parameter is `McpConformanceFactories`, which is declared in
  `src/testing/conformance.ts` but absent from `src/testing/index.ts`. Callers
  can construct the object literal but cannot name its type.
- **`CredentialField` isn't exported from the package root** even though it is
  the type of `deps.field` in `withMCP`'s `credentialKey` callback. Adopters
  annotating that callback explicitly have to inline the union.
- **No connection pooling.** Per-session fan-out means N×M connections. The
  intended fix is a pool keyed by authentication principal, sitting _beneath_
  the client harness behind a connection reference, so sessions check a
  connection out for a tick and back in afterward: same principal shares,
  different principals stay isolated, and `Mcp-Session-Id` makes Streamable HTTP
  cleanly resumable across check-outs. Nothing above the harness would change.
  Deferred until production load justifies it.
- **The OAuth dance is unit-verified, not end-to-end.** The 401 → authorize →
  `finishAuth` → retry wiring and the elicit-fire path are covered, but nothing
  runs against a live identity provider.
- **Read verbs are addressable commands, not wire-exposed.** The client's
  discovery and read operations are reachable in-process but not granted to
  remote clients; that needs a ratified exposure decision first.
- **Inbound sampling takes an adopter-supplied handler.** Routing
  `sampling/createMessage` to Agentick's own executor by default is not
  implemented, and the server direction advertises no sampling capability at
  all.
- **The era codec is a passthrough.** `selectCodec` resolves every advertised
  version to the draft codec. The seam and its version-matrix tests exist so a
  real `2025-11-25` codec can land with coverage, but no translation happens
  today.
- **A forwarded completion drops `ctx.signal`.** The client's completion verb is
  a declared command and its invoker takes no `AbortSignal`, so latest-wins
  cancellation stops at the fold: a superseded keystroke's request still
  round-trips to the origin server (its answer is discarded by the caller).
  Threading it needs a signal on the command invoker
  (`TODO(mcp-complete-abort)`).
- **WebSocket transport is not implemented** in either direction.
