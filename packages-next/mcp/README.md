# @agentick/mcp-next

**MCP client harness** — connects an agentick session to N Model
Context Protocol servers. Discovered tools register into the local
`ToolExecutor`; inbound `elicitation/create` from servers routes
through `bridges.elicitation`. Targets the MCP `draft` spec going
forward; supports the latest official (`2025-11-25`) via an era-codec
layer at the wire edge.

Private workspace package. Bundled into the `agentick` metapackage;
not published independently.

## Status

**Skeleton commit (#1 of 5).** Pure utilities + types ported from v1
(`packages/mcp/`); no harness yet.

| Phase | Shipping in | Status |
|---|---|---|
| #1 Skeleton — OAuth + protocol utilities + in-memory transport | this commit | ✅ |
| #2 `McpClientHarness` — Transport / Protocol / Auth / Lifecycle | next | ⏳ |
| #3 `withMCP` extension + ToolBridge integration | shipped | ✅ |
| #4 ElicitationBridge — server-to-client elicit/create routing | shipped | ✅ |
| #5 OAuth + URL-mode elicitation + Streamable HTTP | follow-up | ⏳ |

## Architecture

Per-server harness, **four pluggable layers** inside each:

```
withMCP({ servers: [...] })  ─── AppExtension
        │
        ▼ constructs one per server
McpClientHarness extends BaseHarness<"mcp">
  ├ McpTransport    — stdio / streamable-http / sse / ws / in-memory
  ├ McpAuth         — None / Bearer / OAuth21
  ├ McpProtocol     — initialize handshake + JSON-RPC correlation
  └ McpLifecycle    — connection state machine + reconnect + heartbeats
        │
        ▼ bridges
  ToolBridge        — registers discovered MCP tools in session's ToolExecutor;
                      dispatch routes through tools/call
  ElicitBridge      — inbound elicit/create routes through
                      bridges.elicitation.elicit; response sent over MCP wire
```

## What's in the skeleton commit

### `@agentick/mcp-next/oauth` — OAuth utilities

Generic OAuth glue, framework-agnostic. Ported from v1 with no
behavioral changes (Logger swapped for `console.warn`/`console.error`).

```ts
import {
  DefaultOAuthProvider,
  OAuthCallbackServer,
  type OAuthProvider,
} from "@agentick/mcp-next/oauth";

// CLI / desktop pattern: localhost callback + default provider
const callback = new OAuthCallbackServer({ port: 0 });
const redirectUrl = await callback.start();

const provider = new DefaultOAuthProvider({
  serverName: "linear",
  serverUrl: "https://mcp.linear.app",
  redirectUrl,
  onAuthorizationNeeded: (url) => openInBrowser(url.toString()),
});

// When the user finishes the OAuth flow in their browser, the
// callback server resolves with the code, which we hand to the
// provider to unblock the SDK's pending auth wait.
const code = await callback.waitForCode();
if (code) provider.resolveAuthorizationCode(code);
else provider.cancelAuthorization();
```

**Replacement when McpClientHarness #5 lands:** the `redirectToAuthorization`
+ `waitForAuthorizationCode` pair becomes a URL-mode elicitation. The
localhost callback server stays as a fallback for environments without
a UI (CLI dev loops).

### `@agentick/mcp-next` (protocol utilities)

```ts
import {
  toolError,
  toolResult,
  toMCPResult,
  protocolError,
  ErrorCodes,
  sanitizeErrorMessage,
  rethrowAsProtocolError,
  completeFromList,
  completeFromEnum,
  completePrefixMatch,
  completeDependent,
  completeFromAsync,
} from "@agentick/mcp-next";
```

**Sanitization** strips stack traces, file paths, DB connection
strings, and `password=`/`token=`/`key=` patterns before they reach
the client.

**Completion builders** enforce the spec's 100-value cap automatically
and handle the `string[]` vs `CompletionResult` shape coercion. The
`CompletionContext` type is narrower than v1's `MCPCompletionContext`
(server-side handler context like auth/session goes with the future
MCP server work).

### `@agentick/mcp-next` (in-memory transport)

```ts
import { InMemoryMcpTransport } from "@agentick/mcp-next";

const [clientSide, serverSide] = InMemoryMcpTransport.createLinkedPair();
```

Synchronous delivery; preserves real-transport ordering. Useful for
testing the harness end-to-end without spawning a subprocess.

## Verified by

- `src/__tests__/skeleton.spec.ts` — every ported public export
  resolves, sanitization patterns catch the documented sensitive
  shapes, completion builders enforce the 100-cap, in-memory linked
  pair round-trips a message.

## Connection lifecycle

Today `withMCP` is an **AppExtension** — one McpClientHarness per
server, **shared across every session in the app**. That sharing has
a known race:

> Concurrent `callTool` invocations from **different sessions**
> through the same MCP connection share a single elicit resolver
> slot. Cross-session ambiguous routing is best-effort and emits
> `mcp:warning:routing-dropped` envelopes when the resolver can't be
> resolved.

**Architectural fix — per-session McpClientHarness (#151)**. Each
session owns its connection per server; the elicit address is fixed
at construction; the slot disappears; concurrent calls from different
sessions become impossible by construction. This is the **right
posture** for multi-tenant — the MCP spec binds OAuth tokens, `Mcp-
Session-Id`, and authorization to the connection. Sharing a
connection across users is a wire violation; sharing across same-user
sessions still couples auth contexts that should remain independent.

#### ⚠️ FUTURE OPTIMIZATION — connection pooling (track in coming weeks)

Per-session fan-out costs N×M connections for N sessions × M
servers. Acceptable for HTTP-remote streams; wasteful for stateless
local stdio servers (mcp-everything, filesystem) and for huge
multi-tenant deployments.

The follow-up is a **connection pool keyed by authentication
principal**:

- Pool holds open connections keyed by `(serverId, auth principal)`.
- Sessions **check connections out** for the duration of a tick / a
  callTool, and **check them back in** when done.
- Same principal → connection sharing (cheap). Different principals →
  isolation (correct).
- `Mcp-Session-Id` (Streamable HTTP) makes connections cleanly
  resumable across check-outs.

The pool sits **beneath** McpClientHarness — a `connection:
McpConnectionRef` indirection — so nothing above changes. Defer until
production load demands it; design space documented in
[`docs/proposals/v2/blueprint/23-mcp-as-harness.md`](../../docs/proposals/v2/blueprint/23-mcp-as-harness.md).

## Roadmap & known gaps

- **No version negotiation.** The era-codec layer (canonical = draft
  shape; codecs for 2025-11-25, 2024-11-05) lands with the harness.
- **OAuth flow is bootstrap-only today.** `DefaultOAuthProvider` logs
  the authorize URL or invokes `onAuthorizationNeeded`. URL-mode
  elicitation integration lands with #5.
- **No stdio / streamable-http transport.** In-memory transport for
  tests is the only transport here. Real transports land with #2 / #5.
- **Per-session McpClientHarness (#151)** + **SessionExtension
  lifecycle (#150)** outstanding. See "Connection lifecycle" above.
- **Connection pool (deferred, coming weeks)** — see "Connection
  lifecycle".

@see [`docs/proposals/v2/blueprint/23-mcp-as-harness.md`](../../docs/proposals/v2/blueprint/23-mcp-as-harness.md)
