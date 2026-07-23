# MCP three-way comparison — v1 `@agentick/mcp` × v2 `@agentick/mcp-next` × `libs/mcp` requirements

> Companion to `knowify-pivot-plan.md`. Grounded in the 2026-07-23 deep
> explorations of `packages/mcp` (v1, @0.15.3), `packages-next/mcp` (v2), and
> the earlier `libs/mcp` survey. Spine question: **ernesto is an in-process
> client of the Knowify MCP server — what does that look like under v2?**

## 0. BLUF

v2 MCP is **bidirectional and substantially complete** — this was the feared
thin spot and it is not thin. Full client harness (`withMCP`), full mountable
**server** harness (`McpServerHarness`) with a 5-stage security pipeline,
tasks/elicitation/resources/prompts/completions/logging/progress/roots, the
in-memory transport ported from v1 unchanged, and a 953-line conformance
suite that runs loopback, real-SDK-peer, and a protocol-version matrix
(draft + 2025-11-25). Both sides wrap the official
`@modelcontextprotocol/sdk@^1.29.0` — same as v1 — so the wire protocol is
the cross-version compatibility layer.

The gaps are enumerable and none block the Knowify pivot's critical path.

## 1. Ernesto as in-process MCP client — three scenarios

1. **v2 ernesto → v2 server (target state):** first-class.
   `InMemoryMcpTransport.createLinkedPair()` (v1-ported, synchronous) →
   server side into the harness, client side into
   `withMCP({ servers: [{ serverId: "knowify", transport: clientSide }] })`.
   Per-(session, server) harness — same per-session pattern as ernesto's
   current `useMcpServers`.
2. **v2 ernesto → v1 server (transition — keep `libs/mcp` on v1):** likely
   works in-process: both packages' in-memory transports are the same code
   lineage implementing the SDK `Transport` interface against the same SDK
   range, and SDK protocol classes treat transports structurally (no
   instanceof). **Needs a 30-minute spike test** (two SDK copies in
   node_modules is the only real risk). Fallback that cannot fail:
   streamable-HTTP loopback to the already-mounted v1 `/api/v2/mcp` — the
   protocol is the compatibility layer; "MCP can't go down" holds either way.
3. **External clients (Cursor/Claude/ChatGPT):** stay on the v1 door
   untouched until the v2 door earns the traffic (per the decoupled-doors
   plan). No coupling to ernesto's migration.

Port-note for ernesto: v2's client entry is the **`withMCP` session
extension, not `<MCP>` JSX** (the v2 `<mcp>` intrinsic emits IR that nothing
materializes — vestigial). Ernesto's `<MCP servers={...}>` mount moves from
the component tree to `createApp({ extensions })`. Set `toolPrefix: ""` to
keep verbatim tool names (`query`, `platform_knowledge`) that the identity
prompt references; v2 default prefixes `<serverId>__`.

## 2. The Knowify server door — Ryan's "directly embedded, not on the gateway"

**v2 already supports exactly this, and it's the only mode that works today:**
`McpServerHarness` standalone + `httpTransport({ ... })` which can **mount on
a caller-supplied `http.Server`** — i.e. Nest's own server, no agentick
gateway involved. Mode B (`createGateway({ mcpServers })`) is declared in
spec but unimplemented (#254/#171 series) — and Knowify doesn't need it. The
separate-door model from the pivot plan maps 1:1 onto what exists.

Auth mapping for that door: v1's OAuth story was thinner than assumed (only
RFC 8414 auth-server metadata; no RFC 9728 route; step-up hints were
`libs/mcp`'s own tool-layer code). Knowify already owns `/.well-known` at the
Nest root and owns JWKS verification in their auth plugin — under v2 that
verification becomes the **authenticator stage** of the pipeline
(`McpAuthenticatedUser` → `ctx.mcp.user`). So v2's "server-side OAuth RS =
future" gap is **not blocking for Knowify**: they bring the pieces v2 hasn't
built, and v2 provides the pipeline v1 never had.

## 3. `libs/mcp` port matrix (v1 `MCPServerOptions` → v2 `McpServerOptions`)

| libs/mcp uses (v1) | v2 status |
| --- | --- |
| `tools` + `toolFilter` + `toolTransform` | ✓ registry + `filter` + `transforms` (direct mapping; live `ToolCatalog` drives `list_changed`) |
| `prompts` (29 `MCPPromptDefinition`) | ✓ `PromptDeclaration[]` — mechanical reshape |
| `resources` / `resourceTemplates` | ✓ `Resources` instance + filter; templates ✓ |
| Prompt-arg completion | ✓ `completions.prompts` config |
| **Resource-template completion** (their hand-rolled `complete.model`) | **⚠ verify** — v2 config shows prompt-arg completions only; client verb exists. Named gap if absent |
| **Per-session `instructions: () => string`** (injects live user/company context) | **⚠ likely gap** — not in v2 options (`serverInfo` looks static). Named issue; small |
| `contextProvider` | Replaced by authenticator stage → `ctx.mcp.user`; kernel-Context bridging becomes explicit identity threading (better) |
| `securitySchemes` / permissive `security` | Replaced by 5-stage pipeline + `capabilities` opt-out; gateway-owns-auth mode = permissive authenticator |
| **`apps` (`MCPAppDefinition`, `ui://`)** | **✗ absent in v2** — Knowify usage today is one env-gated hello-world; not slice-critical, but the MCP-Apps iframe relay in k-assistant-v2 depends on the concept long-term. Named issue |
| `mcpServerPlugin({ path, server })` gateway mount | No v2 equivalent (Mode B unbuilt) — **not needed** (separate door, §2) |
| Handler ctx `request.{user, clientInfo, authInfo, _meta}` + `sendProgress` | Reshaped: `ToolHandlerCtx & { mcp: McpRequestExtras }`; `sendProgress` → `ctx.progress` bus seam. Mechanical sweep of `libs/mcp` handlers |

## 4. v2 gaps → named issues (none on the slice-1 critical path)

1. Mode-B gateway mount (declared, unbuilt) — Knowify-independent.
2. Server-side OAuth RS (RFC 9728 route, introspection, WWW-Authenticate) —
   Knowify brings their own; still v2's to build for adopters who don't.
3. `apps` / MCP-Apps UI surface — port of v1's `ext-apps` bridge.
4. Per-session `instructions` closure — small, `libs/mcp` needs it.
5. Resource-template completion server-side — verify, likely small.
6. `ctx.sample` (SamplingHarness) + `asClient()` direct projection (#171g).
7. `<mcp>` JSX intrinsic is vestigial — either materialize it or delete it
   (one way to do things; currently it's a trap).

Also banked from the v1 dive: v1 has **two forks** of
`MCPStaticResource`/`MCPResourceTemplate` (real ones in mcp, thin homonyms in
the gateway plugin) — v2 must not reproduce this; single source of truth.

## 5. Sequencing consequence

The MCP axis fully decouples, in v2's favor:

- **Slice 1** (thin vertical): v2 ernesto connects to the **v1** Knowify MCP
  server — spike scenario-2 in-process first, HTTP-loopback fallback. libs/mcp
  unchanged, external MCP clients unchanged.
- **Later slice**: `libs/mcp` ports to `McpServerHarness` (matrix above),
  mounts as the separate door on Nest's `http.Server`, their JWKS code as the
  authenticator stage. External clients cut over last, after conformance +
  side-by-side soak.
