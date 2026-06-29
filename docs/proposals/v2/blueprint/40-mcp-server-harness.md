# ADR 40 — MCP server harness shape

**Status:** Proposed — 2026-06-28. **Amended 2026-06-28** to align package layout with ADR 23 §6 (one package, subpath exports) — the original ADR 40 proposed a separate `@agentick/mcp-server-next` which would have duplicated ~70% of code shared with the client. Server now lives at `@agentick/mcp-next/server`.
**Touches:** `@agentick/mcp-next` (server subpath — #171), `@agentick/tool-next` (transforms subpath, shipped #171a), `@agentick/prompts-next` (server projection), `@agentick/elicitation-next` (inbound dispatch), `@agentick/tasks-next` (server-side `taskSupport`), `@agentick/gateway-next` + `@agentick/app-next` (extension wiring), `@agentick/spec-next/protocol/mcp-server-harness.ts` (new). Cross-references ADR 23 §"Server-side: shape is OPEN" — this is the resolution.
**Driver:** Lock the v2 MCP server shape so #171 can ship. ADR 23 left it open between two candidate models ("integrated session-extension" vs "descriptive standalone declaration tree"); the discussion on 2026-06-28 + the v1 audit closed the choice. This ADR is the resolution + the implementation contract.

---

## TL;DR

1. **MCP server is a Shape 1 harness at GATEWAY scope, NOT session scope.** A server is long-lived multi-tenant infrastructure; binding it to a session is wrong containment. Sessions interact with MCP servers as clients (existing `withMCP` + `McpClientHarness`), not by hosting them.

2. **One package, two deployment modes, same harness.** Server ships at `@agentick/mcp-next/server` (subpath of the existing client package — ADR 23 §6 alignment; ~70% of code is shared between client + server, so a separate package would duplicate transport, era-codec, OAuth, JSON-RPC framing, and Standard-Schema bridge). Two modes:
   - **Mode A — Standalone process** (`npx agentick-mcp-server --config server.config.ts` — bin shipped by `@agentick/mcp-next`). A thin shell boots substrate + harness + transports.
   - **Mode B — Gateway extension** (`createGateway({ mcpServers: [...] })`). Production deployment for most adopters.
   - Both modes wrap the same `McpServerHarness`. Mode A is "Mode B with a minimal synthesized gateway shell."

3. **Multiple servers per process.** `mcpServers: McpServerConfig[]` — each server has its own name, transports, identity, tool/prompt/resource projection, auth, and rate limits. Our own agents can connect to any of them via `withMCP({ url })` exactly as a 3rd party would.

4. **Declarative object config, NOT a builder.** Each `McpServerConfig` is a plain TS object literal — spreadable, composable, no method-chaining ceremony. Builder pattern was considered + rejected (discoverability gain didn't outweigh the indirection).

5. **Per-connection projection + transforms, NOT per-server pre-baked sets.** Filters and transforms run at request time against the live `MCPRequestContext` of each connection. Same per-session-per-request granularity as v1. A single server can serve "anonymous read-only" and "authenticated admin" connections with different visibility, no separate server instance per persona.

6. **Tool transforms are first-class primitives, shared with the rest of the framework.** `rename`, `alias`, `prefix`, `restrict-input`, `restrict-output`, `wrap-handler`, `filter` live in `@agentick/tool-next/transforms` — usable anywhere a tool list is consumed, not MCP-server-specific. The MCP server just composes them.

7. **Security pipeline ported from v1 verbatim.** `ConnectionGuard` / `Authenticator` / `Authorizer` / `RateLimiter` / `InputSanitizer` — five named async stages, swappable per-server. Defaults are transport-aware (HTTP forces explicit auth config; stdio + in-process default to allow-all). v1's stages library (`bearerTokenAuth`, `roleBasedAuthz`, `slidingWindowLimiter`, `allowListGuard`) ports as-is to `@agentick/mcp-next/server/security`.

8. **OAuth 2.1 fully spec-aligned, both AS and RS roles.** v1 shipped client-side OAuth only. v2 server ships token validation (Resource Server role) + optional embedded Authorization Server. PKCE-mandatory, OIDC discovery, JWT/introspection token formats. Reuses #134's URL-mode elicit infrastructure for symmetric callback handling.

9. **Internal agents use direct projection — no wire loopback.** When `createApp` and `withMcpServer` are in the same process, `gateway.mcpServer("name").asClient()` returns a `McpClientHandle`-shaped object that calls the projection layer directly (post-auth, post-filter, post-transform) without serialization. Adopters who want to test the wire just use the actual transport endpoint.

10. **Capability advertisement is harness-driven.** The server's `initialize` response declares only what's actually wired: prompts capability iff prompts are configured, elicitation iff `ElicitationHarness` is mounted, taskSupport iff `TasksHarness` is mounted, resources iff #123 is wired. No "we support X but it returns empty" lies on the wire.

11. **Sampling/elicitation/roots/completions sugar ports from v1.** v1's `SampleAPIImpl.structured()` retry loop and `ElicitationAPIImpl` flat-schema validation are load-bearing and well-tested. Port the implementations; rewire the state-ownership to the v2 harnesses (which already exist). Adopter-facing API (`ctx.elicit.select`, `ctx.roots.assertWithin`, `completeFromList`, three-action elicit) and recipe examples live in the package README, not this ADR.

12. **Resources (#123) ship later. Server capability negotiation handles absence cleanly.** Server config has an optional `resources` slot; missing → don't advertise the capability → no `resources/list` or `resources/read` requests will arrive. Additive when #123 lands — including `resources/subscribe` per-URI, `notifications/resources/updated`, and resource templates. ADR 23's deferral stance applies.

13. **Display metadata mutable per-connection; semantic annotations immutable.** `title`/`icons`/`description` flow through `@agentick/tool-next/transforms` (`setTitle`, `setIcons`, `describe`) and can be customized per audience. Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are SEMANTIC — set at `createTool` time, immutable through projection. Lying about destructiveness per-connection would be a safety footgun.

14. **Tool handlers receive `ctx.signal` + `ctx.sendProgress` via projection-layer wrapping.** Both ported from v1's `MCPHandlerContext` unchanged. Long-running tools observe `signal` for client cancellation; progress notifications stream to clients that advertised support. Wrapping happens in the projection layer; tool handlers see them as plain function/AbortSignal.

15. **`tools/list_changed`, `prompts/list_changed`** (and `resources/list_changed` when #123 lands) are driven by harness change-notifications — KeyedNotifier subscriptions on tool registry / `PromptsHarness` / `ResourcesHarness`. Adopters get them for free on `register`/`update`/`remove`; the server harness does not own change-tracking state.

---

## Context

### The shape question ADR 23 left open

ADR 23 §"Server-side: shape is OPEN" called out two models without choosing:

- **"Integrated" via session-extension.** A `<MCPServer>` JSX node inside an agent declaration; the server's lifetime = the session's lifetime; the tools the model has access to within the session are also the tools served on the wire.
- **"Descriptive" as a standalone declaration tree.** Separate config file / module / package; server lifetime is process-scoped; tools are explicitly listed.

The discussion on 2026-06-28 surfaced that neither matches the deployment shape we actually want:

- An MCP server is multi-tenant. Multiple unrelated clients connect concurrently. Sessions are single-conversation. Putting a server inside a session forces session-per-connection, which destroys the multi-tenant property.
- An MCP server's tool surface is configured at deploy time by an operator. A session author writes "what does THIS agent do." Those are different stakeholders, different rev cycles. JSX inside an agent file mixes them.
- The JSX-in-agent model is right for things the model perceives and influences within a turn (sections, tools the model can call, knobs it can read). An MCP server is *infrastructure the agent is unaware of*. The agent is a CLIENT of MCP servers (via `withMCP`); the agent does not host them.

### What we have now that v1 didn't

ADR 23 reaffirmed: MCP semantics ARE Agentick's native semantics. Concretely, the v2 substrate already has the primitives a server needs to project, with minimal translation:

| MCP wire concept                | v2 source of truth                              | Translation needed?            |
| ------------------------------- | ----------------------------------------------- | ------------------------------ |
| `tools/list`, `tools/call`      | `@agentick/tool-next` registry + `createTool`   | None — `createTool` IS the MCP shape |
| `prompts/list`, `prompts/get`   | `@agentick/prompts-next` (`PromptsHarness`)     | None — mirror is exact         |
| `elicitation/create` (server→client) | `@agentick/elicitation-next` (`ElicitationHarness`) | None         |
| `tasks/list`, `tasks/get`, taskSupport | `@agentick/tasks-next` (`TasksHarness`) | None — already cluster-aware  |
| `sampling/createMessage` (server→client) | `SamplingHarness` (pending)                | Bridge needed (not v1-shape direct call) |
| `resources/list`, `resources/read` | `@agentick/resources-next` (#123, pending)   | Bridge needed when #123 lands  |
| `roots/list`                    | Workspace bridge (#124, pending)                | Bridge needed                  |

All but the bottom three are ready today. The MCP server harness composes the existing harnesses + bridges; it does NOT own state for things the harnesses already own.

### What v1 got right (and we port)

The audit of `packages/mcp/src/server/` (20k LOC, ~3k LOC test) surfaced these load-bearing patterns:

1. **`MCPRequestContext` as the central flow-through type** — carries `user` identity, `clientInfo`, `clientCapabilities`, `session.{sessionId, transportType, createdAt}`, SDK passthrough, free-form `metadata`. Every stage sees the same object. Worth porting almost verbatim.

2. **Security pipeline shape — five named stages** (`src/server/security/stages.ts`):
   - `ConnectionGuard: (info) => Promise<boolean>` — once per transport connection
   - `Authenticator: (ctx) => Promise<AuthnResult>` — per-request
   - `Authorizer: (ctx, op) => Promise<AuthzResult>` — per-request
   - `RateLimiter: (ctx, op) => Promise<RateLimitResult>` — per-request
   - `InputSanitizer: (ctx, toolName, input) => Promise<Record<string, unknown>>` — tool-call only

   Each stage is a swappable async function, NOT a composable middleware chain. Defaults are transport-aware. Production-ready stages library: `bearerTokenAuth`, `roleBasedAuthz`, `slidingWindowLimiter`, `allowListGuard`.

3. **Tool filter + tool transform per-session per-request:**
   - `toolFilter: (tool, ctx) => boolean` — hides tools from `tools/list`, rejects `tools/call`
   - `toolTransform: (tool, ctx) => MCPToolDefinition | null` — mutates definition per session

   Filter is the canonical gate; transform is for presentation. Applied only to `tools/*` in v1; v2 generalizes to all projected surfaces.

4. **`SamplingAPIImpl.structured()`** — JSON-parse + Zod-validate + retry-on-malformed loop (v1 `src/server/sampling.ts:205-261`). Load-bearing. Port the loop; rewire to v2's `SamplingHarness` when it lands.

5. **`ElicitationAPIImpl` flat-schema validation** — strict per-spec: rejects nested objects, free-form arrays, discriminated unions. v1 `src/server/elicitation.ts:144-198`. Port exactly.

6. **Roots safety utilities** — `fileUriToPath()`, `pathIsWithin()`, `isValidRootUri()` (v1 `src/server/roots.ts`). Boundary-safe path operations. Keep.

7. **Completion builders** — `completeFromList`, `completeFromEnum`, `completePrefixMatch`, `completeExact`. 100-value cap + `hasMore`. Port as-is.

8. **Transport-aware security defaults** — HTTP forces `localOnlyGuard + rejectAllAuth` until config explicitly relaxes; stdio/in-process default to allow-all. Right default; port it.

### What v1 did that v2 changes

- **Single transport per server** (v1 hard-coded one transport per `MCPServer` instance via `.connect(transport)` or `.handleHTTPRequest()`). v2 — multiple transports per server (config is `transports: Transport[]`).
- **Server owns the tool/prompt/resource registries.** v2 — registries live in their owning harnesses (tools in tool-executor, prompts in PromptsHarness, etc.). The server projects.
- **Server starts a session-TTL cleanup interval.** v2 — gateway lifecycle handles cleanup. No per-server timer.
- **No rename / alias / prefix / restrict-schema transforms.** v2 adds these as first-class primitives in `@agentick/tool-next/transforms`.
- **OAuth client-side only.** v2 — server-side Resource Server token validation + optional embedded Authorization Server, both OAuth 2.1 spec-aligned.
- **`MCPApp` (ui:// resources) as first-class capability.** v2 — defer. Spec stability uncertain; treat as adopter extension via a custom resource-type registration when #123 lands.

---

## Decision

### 1. Package layout

Server code lives inside the existing `@agentick/mcp-next` package as a `/server` subpath. This is ADR 23 §6 alignment: client + server share ~70% of code (wire codec, transport abstractions, OAuth utilities, era-codec, JSON-RPC framing, Standard-Schema bridge), so they live together and import from shared internal modules. The client public surface (`@agentick/mcp-next`) is unchanged; server consumers import from `@agentick/mcp-next/server`.

```
@agentick/mcp-next/                         ← existing package
├── src/
│   ├── index.ts                            ← CLIENT public surface (unchanged)
│   ├── client/                             ← existing
│   ├── oauth/                              ← existing OAuth client utilities (shared)
│   ├── transports/                         ← existing in-memory + future shared transports
│   ├── protocol/                           ← existing JSON-RPC + completions (shared)
│   ├── server/                             ← NEW (the #171 work)
│   │   ├── index.ts                        ← server public surface
│   │   ├── harness.ts                      McpServerHarness (Shape 1, gateway-scope)
│   │   ├── extension.ts                    withMcpServer(config) — gateway extension factory
│   │   ├── handle.ts                       McpServerHandle (curated surface on gateway)
│   │   ├── augment.ts                      HookBridges.mcpServer slot
│   │   ├── config.ts                       McpServerConfig + validation
│   │   ├── projection/
│   │   │   ├── index.ts                    per-connection projection orchestrator
│   │   │   ├── tools.ts                    tool registry → MCP tools/* projection
│   │   │   ├── prompts.ts                  PromptsHarness → MCP prompts/*
│   │   │   ├── elicitation.ts              ElicitationHarness → MCP elicitation/create
│   │   │   ├── tasks.ts                    TasksHarness → MCP tasks/*
│   │   │   ├── sampling.ts                 SamplingHarness → MCP sampling/createMessage
│   │   │   └── resources.ts                (placeholder; lands with #123)
│   │   ├── transports/                     server-side transport adapters; shared types from ../transports
│   │   │   ├── stdio.ts
│   │   │   ├── http.ts                     Streamable HTTP
│   │   │   ├── ws.ts
│   │   │   └── in-memory.ts                (shares LinkedPair with client)
│   │   ├── protocol/                       server-specific protocol layer over ../protocol
│   │   │   ├── jsonrpc.ts                  framing helpers, reuses error codes from ../protocol/errors.ts
│   │   │   ├── lifecycle.ts                initialize + capability negotiation
│   │   │   └── era-codec.ts                target draft 2026-07-28; encode/decode 2025-11-25
│   │   ├── security/
│   │   │   ├── pipeline.ts                 5-stage runner
│   │   │   ├── stages.ts                   ConnectionGuard / Authenticator / Authorizer / RateLimiter / InputSanitizer
│   │   │   ├── defaults.ts                 transport-aware defaults
│   │   │   ├── built-ins/
│   │   │   │   ├── bearer.ts
│   │   │   │   ├── role-based-authz.ts
│   │   │   │   ├── sliding-window.ts
│   │   │   │   ├── allow-list.ts
│   │   │   │   └── oauth-validator.ts      Resource Server token validation; reuses ../oauth shared
│   │   │   └── identity.ts                 MCPRequestContext shape (ported from v1)
│   │   ├── auth/                           server-side OAuth specifics
│   │   │   ├── oauth-as.ts                 optional embedded Authorization Server
│   │   │   ├── pkce.ts                     reused from ../oauth where possible
│   │   │   └── discovery.ts                OIDC + MCP-specific discovery endpoints
│   │   ├── conformance.ts                  runMcpServerHarnessConformance(makeHarness)
│   │   ├── testing/                        stubMcpServerHarness, fakeTransport
│   │   └── bin.ts                          Mode A CLI entry — `agentick-mcp-server`
└── package.json
    exports:
      ".":         → ./src/index.ts                  (client; unchanged)
      "./oauth":   → ./src/oauth/index.ts            (existing)
      "./server":  → ./src/server/index.ts           (NEW)
      "./testing": → ./src/server/testing/index.ts   (server testing; future)
    bin:
      "agentick-mcp-server": "./src/server/bin.ts"  (NEW)
```

**Shared internal modules** (not re-exported from `index.ts`; both client and server import from `./protocol`, `./oauth`, `./transports`):

- `src/protocol/` — JSON-RPC framing, error codes, completion builders, era-codec utilities
- `src/oauth/` — PKCE, discovery, token formats, callback server (currently client-shaped; server-side validator added here too)
- `src/transports/` — base transport interfaces, in-memory `LinkedPair`, shared codecs

When client + server need diverging types (e.g., client `McpRequestContext` vs server `McpServerRequestContext`), they live in their respective subdirectories. Otherwise: shared internal modules first.

`@agentick/tool-next/transforms` (shipped in #171a) is a separate package. The MCP server projection imports `composeTransforms` + the primitives from there; the transforms library is NOT MCP-specific.

### 2. Config shape (declarative)

```ts
// gateway.config.ts
import { createGateway } from "@agentick/gateway-next";
import { stdioTransport, httpTransport } from "@agentick/mcp-next/server";
import { rename, prefix, filter } from "@agentick/tool-next/transforms";
import { bearerTokenAuth, roleBasedAuthz } from "@agentick/mcp-next/server/security/built-ins";

export const gateway = createGateway({
  cluster: defineCluster({ ... }),

  mcpServers: [
    {
      name: "public",
      transports: [
        stdioTransport(),
        httpTransport({ port: 8080, host: "0.0.0.0" }),
      ],

      // Per-connection projection. Filter + transforms are FUNCTIONS,
      // not pre-baked lists — they see the live MCPRequestContext.
      tools: {
        filter: (tool, ctx) => tool.metadata?.public === true,
        transforms: [
          // Tool transforms apply in array order. Per-connection.
          prefix("public_"),
          rename({ "internal_search": "search" }),
        ],
      },

      prompts: {
        filter: (decl, ctx) => decl.metadata?.public === true,
      },

      // Capabilities advertised in `initialize` — derived from what's wired.
      // Adopters override only to opt OUT of an otherwise-available capability.
      capabilities: {
        // resources: false,  // explicitly opt out
      },

      auth: {
        connectionGuard: undefined,  // default: transport-aware (HTTP → localOnly until configured)
        authenticator: bearerTokenAuth({ tokens: { "abc...": { id: "user-1" } } }),
        authorizer: roleBasedAuthz({ rules: { "tools/call:public_*": ["read"] } }),
        rateLimiter: slidingWindowLimiter({ windowMs: 60_000, max: 100 }),
      },
    },

    {
      name: "admin",
      transports: [stdioTransport()],
      // Admin server: no tool filter — sees the full gateway tool registry.
      // Transforms still apply per-connection if needed.
      tools: {},  // all
      auth: {
        authenticator: oauthValidator({
          issuer: "https://idp.internal/",
          audience: "agentick-admin",
        }),
      },
    },
  ],
});
```

**Why declarative object over builder:** spreadable, composable, type-inferred end-to-end, easy to load from JSON for ops use cases. Builder's discoverability win is real but small; the indirection cost (auto-complete on a partially-built object is worse than on a fully-typed literal) outweighs it. Adopters who want builder ergonomics can write `defineMcpServer(cfg)` in three lines locally.

### 3. Connection model + per-connection projection

Each transport connection produces:

1. A `ConnectionGuard` decision (accept/reject) once at connect time. Trusted transports (stdio, in-memory) skip.
2. A `Connection` object that owns:
   - The transport's send/receive duplex
   - A `MCPRequestContext` template (sessionId, transportType, createdAt + slots filled in by `Authenticator` on each request)
   - A capability-negotiation result (from `initialize`)
3. For each incoming request, the projection orchestrator:
   - Runs `Authenticator(ctx)` → populates `ctx.user`
   - Runs `Authorizer(ctx, op)` → reject or continue
   - For `tools/call`: `RateLimiter` then `InputSanitizer`
   - Dispatches to the appropriate projection module (`projection/tools.ts`, etc.)
   - The projection module applies `filter` + `transforms` against the live `ctx` and returns the projected view

**Filters and transforms run per request, not at connection setup.** This lets the projection react to per-call authz outcomes ("user is in 'admin' role for this request only"), session age, or transient ctx fields without re-establishing the connection.

**Tool handler invocation context.** During `tools/call` dispatch, the projection wraps the handler with two cross-cutting concerns required by the MCP spec:

- **`ctx.signal: AbortSignal`** — fires when the client sends `notifications/cancelled` or the connection drops. Long-running tools MUST respect it. v1 ships this on `MCPHandlerContext`; v2 ports the contract unchanged.
- **`ctx.sendProgress(progress, total?, message?)`** — emits a `notifications/progress` JSON-RPC message correlated to the in-flight request. The projection layer owns the JSON-RPC framing; the tool handler just calls the function. Progress notifications are capability-gated (only emitted if the client advertised `progress` support in `initialize`).

Both flow through unchanged from v1's `MCPHandlerContext` shape. The projection layer attaches them per-request; tools that don't need them ignore them.

### 4. Tool transformation primitives (`@agentick/tool-next/transforms`)

A `ToolTransform<C = MCPRequestContext>` is:

```ts
interface ToolTransform<C = unknown> {
  readonly name: string;  // debug + transform-trace
  readonly apply: (
    tool: ToolDeclaration,
    ctx: C,
  ) => ToolDeclaration | null;  // null = drop
}
```

Compose via `composeTransforms(...transforms)` → single transform that applies in array order.

**Shipped primitives** (initial set):
- `rename({ from: to, ... })` — explicit map
- `prefix(p)` — prepend to every tool name
- `suffix(s)`
- `filter((tool, ctx) => boolean)` — drop tools where predicate is false
- `restrictInput(schemaMask)` — mask out fields from `inputSchema` (Standard-Schema-aware)
- `restrictOutput(schemaMask)` — same for `outputSchema`
- `wrapHandler((tool, ctx) => wrappedHandler)` — middleware around invoke; e.g., log, retry, rate-limit per-tool
- `describe({ name: descOverride, ... })` — replace descriptions for adopter-facing prompts
- `alias({ canonical: [alias1, alias2] })` — make a tool callable under multiple names

These are NOT MCP-specific. The MCP server projection uses them via `composeTransforms`; tool-executor uses them for in-app rebranding; eval-next uses them for tool ablation.

**Display metadata vs. semantic annotations — two different concerns:**

- **Display metadata** (`title`, `icons`) is presentation. Adopters customize per-connection: a "kid-friendly" connection might transform `title` to plain-language descriptions; an enterprise connection might add corporate icon URLs. Ships as sugar transforms:
  - `setTitle({ toolName: titleOverride, ... })`
  - `setIcons({ toolName: [{src, sizes, mimeType}], ... })`
  - `describe({ toolName: descOverride, ... })` already covers `description`
- **Tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are SEMANTIC metadata that influence agent behavior at the model layer (agents avoid destructive tools unless asked). They are **immutable** at projection time — set at `createTool` registration, flow through projection unchanged, never mutated by per-connection transforms. Lying about destructiveness to one connection but not another would be a safety footgun. The transforms library deliberately does NOT ship `setAnnotations` or equivalent.

This split is intentional: presentation can vary per audience; semantics cannot.

### 5. Security pipeline

Ported from v1 verbatim, with one structural change: stages are functions (not classes), composable via plain function references. No middleware chain (v1 doesn't have one and didn't need it).

Defaults — applied per transport type unless overridden:

| Transport     | ConnectionGuard | Authenticator   | Authorizer    | RateLimiter   | InputSanitizer  |
|---------------|-----------------|------------------|----------------|----------------|------------------|
| stdio         | allowAll        | allowAll         | allowAll       | allowAll       | passthrough      |
| in-memory     | allowAll        | allowAll         | allowAll       | allowAll       | passthrough      |
| HTTP          | localOnly       | **rejectAll**   | allowAll       | allowAll       | passthrough      |
| WebSocket     | localOnly       | **rejectAll**   | allowAll       | allowAll       | passthrough      |

`rejectAll` is intentional: HTTP/WS adopters must explicitly configure an authenticator. Refusing all unauthenticated requests is the safe default; the framework will not silently expose internal tools on a network port.

### 6. OAuth 2.1 (server-side)

**Two roles**, both shipped:

- **Resource Server** (default for most adopters): validate inbound bearer tokens against a configured Authorization Server. Discovery via `/.well-known/oauth-authorization-server`. JWT (RS256/EdDSA) + introspection both supported. Cache verified tokens up to their `exp`. Caller provides issuer + expected audience.

- **Authorization Server** (optional embedded — for adopters who don't have an external IdP): full OAuth 2.1 flow with PKCE-mandatory, client registration endpoint, token + introspection + revocation endpoints, OIDC discovery. Stored client credentials + token state via a pluggable backend (in-memory default, sqlite/postgres adapters as follow-ups).

**MCP-specific:** server advertises authorization metadata in capabilities per the MCP spec (`2025-11-25` and draft `2026-07-28` both supported via era-codec). URL-mode elicitation for deferred-auth UX reuses the elicit infrastructure from #134.

### 7. Internal agents — direct projection

When an `@agentick/app-next` instance and a `withMcpServer` configuration live in the same process under the same gateway:

```ts
// in an app, talking to our own MCP server without going over the wire:
import { withMCP } from "@agentick/mcp-next";

const app = createApp(<MyAgent />, {
  extensions: [
    withMCP({
      // Special-cased "in-process" URL form. Looks up the named server
      // on the parent gateway; produces a transport that skips
      // serialization but still runs through the full projection
      // (filter/transform/auth/limiter).
      url: "mcp://gateway/public",
    }),
  ],
});
```

The `mcp://gateway/<name>` URL form resolves at `withMCP` install time to the gateway-mounted server's direct-projection handle. The handle:

- Runs `Authenticator` with a synthetic in-process identity (configurable, defaults to "service-account")
- Runs full projection (filter / transforms / authz / sanitizer)
- Skips JSON-RPC framing — projection module is called directly with native objects
- Skips transport serialization

Result: internal agents see exactly the same view 3rd-party agents see (modulo identity), with zero wire cost. The symmetry that makes "we treat our agents like other agents" load-bearing is preserved.

Adopters who want to TEST the wire substitute the URL: `ws://localhost:8080/public`. Same code in the agent; different transport behind the scenes.

### 8. Capability negotiation (harness-driven)

The server's response to `initialize` declares only what's wired. The projection orchestrator inspects which harnesses are bound + which config slots are populated:

```ts
const capabilities = {
  tools: gateway.tools.size > 0 ? { listChanged: true } : undefined,
  prompts: config.prompts ? { listChanged: true } : undefined,
  resources: config.resources ? { listChanged: true, subscribe: true } : undefined,
  elicitation: gateway.bridges.elicitation ? {} : undefined,
  taskSupport: gateway.bridges.tasks ? "supported" : undefined,
  sampling: gateway.bridges.sampling ? { ... } : undefined,
  roots: gateway.bridges.workspace ? { listChanged: true } : undefined,
};
```

No "we support X but return empty list" surfaces. Clients can rely on advertised capabilities being real.

### 9. Resources deferral

`McpServerConfig.resources` is an optional slot. When absent:
- `resources` capability is NOT advertised
- `resources/list` and `resources/read` would be `Method not found` (but clients won't send them without the capability)
- `notifications/resources/list_changed` is never emitted

When #123 lands and configures `resources: { ... }`, the capability appears + the projection module wires up. Pure addition; no shape changes elsewhere.

**Resource subscription forward-compat.** When the `ResourcesHarness` lands, the server harness will additionally:

- Project resources at request time (same filter + transforms pattern as tools/prompts; per-connection).
- Subscribe to the `ResourcesHarness`'s change stream + emit `notifications/resources/list_changed` to all connections whose `clientCapabilities.resources.listChanged` is true.
- Support `resources/subscribe` (per-connection per-URI subscriptions) → emit `notifications/resources/updated` on backend change.
- Support resource templates (`uriTemplate: "db://schema/{table}"`) with variable extraction + completion via the completion builders.

No server-harness shape changes are required — the additions plug into the projection layer + the harness's existing change-notification mechanism (KeyedNotifier or equivalent on the ResourcesHarness side). The capability negotiation table in §8 already includes the conditional advertisement.

**`tools/list_changed` and `prompts/list_changed`** (analogous to resources) — emitted when the underlying tool registry or PromptsHarness signals a change, scoped to connections whose `clientCapabilities` opted in. Driven by harness-level subscriptions, not server-internal state. Adopters get this for free when they call `tools/register` or `session.prompts.register`.

### 10. Standalone mode (Mode A)

The CLI entry (`bin/server.ts`) is a thin shell:

```ts
#!/usr/bin/env node
import { spawnStandaloneMcpServer } from "@agentick/mcp-next/server";
const config = await import(parseArgs(process.argv).config);
await spawnStandaloneMcpServer(config.default);
```

`spawnStandaloneMcpServer(cfg)` synthesizes a minimal gateway shell (substrate: in-memory journal/bus/inbox; cluster: `defineLocalCluster`; no app-spawning), mounts the server harness, attaches transports, runs until SIGINT/SIGTERM. The harness is the same one Mode B mounts; only the surrounding shell differs.

---

## Lifecycle + ownership

Per ADR 38 (cluster lifecycle + ownership rules):

- **Mode B (gateway extension):** gateway owns the server harness lifecycle. `gateway.close()` triggers `mcpServerHarness.close()` which drains in-flight requests, closes all transports, then releases resources.
- **Mode A (standalone):** the shell owns it. SIGINT triggers the same close path.

Within a server:
- Each `Connection` is owned by the harness and tracked in an internal `Map<ConnectionId, Connection>`.
- Transport-level disconnects cause `Connection.close()` to fire; harness removes the entry.
- Harness shutdown iterates over `Map`, drains each, then closes transports.

---

## Conformance + testing

`@agentick/mcp-next/server/conformance.ts` exports `runMcpServerHarnessConformance(makeHarness)`. Cases pin:

- Capability negotiation matches wired harnesses
- Per-connection filter + transforms apply correctly
- Security pipeline: each stage runs in order; rejection at any stage short-circuits
- Multi-connection isolation: connection A's authz state doesn't leak to connection B
- OAuth Resource Server: valid token → user populated; expired → 401; revoked → 401
- Direct projection (in-memory transport): byte-identical to wire roundtrip modulo serialization
- Resources NOT advertised when `config.resources` is absent
- Multiple servers in one process don't interfere

`testing/` ships `stubMcpServerHarness(initial)` for adopter tests (drive without spawning transports) and `fakeTransport()` for protocol-level tests.

---

## Migration / rollout plan

1. **#171a — `@agentick/tool-next/transforms` subpath.** Lands first; usable independently. ~1 day.
2. **#171b — `@agentick/mcp-next/server` subpath + spec types.** Subpath scaffold inside the existing mcp-next package, `McpServerHarness` shell, config validation, no transports yet. ~1 day.
3. **#171c — stdio transport + tools-only projection.** Minimum viable: stdio transport, capability negotiation, tools projection, security pipeline default-allow stages. Smoke test via Mode A CLI on a fixture config. ~2 days.
4. **#171d — Prompts + elicitation + tasks projections.** Each is a small commit; harnesses already exist. ~2 days.
5. **#171e — HTTP transport (Streamable HTTP) + OAuth 2.1 Resource Server.** ~3 days.
6. **#171f — WebSocket transport.** ~1 day.
7. **#171g — Direct projection (`mcp://gateway/...` URL form in `withMCP`).** ~1 day.
8. **#171h — Embedded Authorization Server.** Optional; can ship later. ~3 days.
9. **#123 lands → resources projection slots in.** No shape change to the server harness.
10. **#171i — Conformance suite + testing helpers + README.** ~2 days.

Total estimate: ~16 days of work. Not blocking on #123 or #124.

---

## Risks + mitigations

1. **OAuth 2.1 spec interpretation drift.** The MCP authorization spec is still maturing; era-codec covers the wire-level differences but the AS/RS contract may evolve.
   *Mitigation:* implement the Resource Server first (passive — validates tokens issued by any compliant AS); embedded AS is opt-in and can lag.

2. **Direct projection's identity model is hand-wave-y.** "Synthetic in-process identity, defaults to 'service-account'" needs to be tightened.
   *Mitigation:* expose `mcp://gateway/<name>?as=<principal>` URL form for explicit identity selection. Defer until first adopter scenario forces the decision.

3. **Per-connection per-request transforms may surprise on perf.** v1's audit notes filter+transform run on every request; for high-QPS connections this is non-trivial.
   *Mitigation:* `composeTransforms` caches the composed function reference; per-call cost is the chain itself, not composition. If profiling shows hot, add a "static" config form (`tools: { filter, transforms, transformsCacheKey: (ctx) => ... }`) later.

4. **Multi-server config grows unwieldy.** A gateway with 5 MCP servers + 3 transports each is a lot of TS.
   *Mitigation:* the declarative shape is plain objects — adopters can factor into per-server modules and spread. No framework feature needed.

5. **v1's tests don't fully translate.** v1's tool/resource/prompt registries live on the server; v2's live on the harnesses. v1 tests that drive server.tools.register(...) need rewriting.
   *Mitigation:* expected; the v2 conformance suite is the new pin set. v1 tests serve as a feature checklist, not a reusable suite.

---

## What lives in the package README (not this ADR)

The following are adopter-facing material that the `@agentick/mcp-next` README will document (server section, alongside the existing client section). They are NOT architectural shape questions — they're API surface + recipes. Listed here so the ADR isn't mistaken for the README:

- **Tool definition reference** — input/output schemas, handler context shape, error vs result patterns. Port from v1 README §"Server API — Tools".
- **Production security recipes** — `bearerTokenAuth` + `roleBasedAuthz` + `slidingWindowLimiter` + `allowListGuard` (IP/origin CIDR + glob) usage examples. Port from v1 §"Production security stages".
- **Argument completion** — `completeFromList`/`completeFromEnum`/`completePrefixMatch`/`completeDependent`/`completeFromAsync` builders. Already in `@agentick/mcp-next` (client side); the server-side completion handler reuses them.
- **Elicitation sugar** — `ctx.elicit.{select, confirm, text, number, boolean, object, url, requireUrls, multiSelect}` + `tryX` variants + three-action distinction (`accept`/`decline`/`cancel`). Ported from v1 `ElicitationAPIImpl`.
- **Sampling sugar** — `ctx.sample.{text, structured, message, image, audio, withTools}` + retry loop. Ported from v1 `SampleAPIImpl`.
- **Roots helpers** — `ctx.roots.{list, assertWithin, rootContaining, resolveRelative}` + caching + invalidation on `notifications/roots/list_changed`. Ported from v1.
- **Dynamic registration recipes** — `addTool`/`removeTool`/etc. examples; the harness already exposes these.
- **Server-to-client request escape hatch** — `MCPServer.request<T>()` analog on v2's `McpServerHarness`. For adopters who need to add custom bidirectional methods beyond the built-in sampling/elicitation/roots.
- **Tool execution error vs protocol error distinction** — when to throw vs return `{ isError: true }`. Ported recipe from v1 README.
- **Multi-step elicitation workflows** — chaining `ctx.elicit.*` calls for complex confirmations. v1 examples carry forward.

Each of these will be a section in the v2 package README scaffold built incrementally during #171c–#171i. The README is the user-facing manual; this ADR is the spec.

## What this ADR does NOT decide

- **Watch-mode loaders** (filesystem reload of tools/prompts). Out of scope; loader retro on 2026-06-28 deferred to a separate ADR if/when needed.
- **MCP App (`ui://` resource type, Spec 2026-01-26).** Defer — spec stability uncertain.
- **Federated MCP** (server A advertising server B's tools). Out of scope; can be built on top via tool-import patterns.
- **Multi-tenancy at the IdP level** (one server, multiple realms with different tool surfaces). Solved by running multiple servers with different audience claims; framework doesn't need built-in support.
- **Wire-level fuzzing / chaos testing.** Important but separate workstream.

---

## See also

- ADR 23 — MCP integration shape (this resolves §"Server-side: shape is OPEN")
- ADR 26 — Harness API shape
- ADR 27 — Modular built-ins
- ADR 32 — Extension shape spectrum (MCP server is Shape 1)
- ADR 33 — Client + transports (transport abstraction reuse)
- ADR 38 — Cluster lifecycle + ownership rules
- v1 `packages/mcp/` audit findings (Explore agent report, 2026-06-28)
