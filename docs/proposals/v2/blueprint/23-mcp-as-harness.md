# ADR 23 — MCP integration shape

**Status:** Revised — 2026-06-14 (originally Proposed 2026-05-20).
**Touches:** `@agentick/mcp-next` (new package; rework of v1 `@agentick/mcp`), `@agentick/spec-next/data/mcp.ts` (landed in cbb49b6b — needs extension), `HookBridges` extensibility (ADR 22), `@agentick/transport-next` (`BaseClientTransport` reuse, ADR 33), schema slots across spec (Standard-Schema adoption).
**Driver:** Lock in v2 MCP shape across BOTH directions (client-side consuming external MCP servers, server-side exposing Agentick as MCP) before sandbox implementation. Several decisions are still open and called out as such; this ADR captures the reasoning so we can return to them deliberately.

---

## TL;DR

1. **Target the draft spec (`2026-07-28`) semantically; treat `2025-11-25` and earlier as wire codecs that translate to/from the draft-shaped internal vocabulary.** Era detection runs at connect time per the draft's published fallback chain. Legacy compat survives ~12 months past draft promotion to release.
2. **MCP semantics are not bolted onto Agentick — they ARE Agentick's native semantics.** The substrate's tool, resource, prompt, elicitation, tasks, sampling, roots, listChanged, cancellation, progress, capability-negotiation primitives all map 1:1 onto MCP concepts. MCP is a wire codec on top of the substrate, not a translation layer.
3. **Client-side: each MCP connection is `BaseHarness<"mcp">`** (the original ADR 23 decision; reaffirmed).
4. **Server-side: shape is OPEN** — two candidate models discussed below ("integrated" via session-extension; "descriptive" as a standalone declaration tree). Both are viable; need real-world adopter scenarios to choose.
5. **Standard-Schema adopted framework-wide** for `inputSchema`, `outputSchema`, and elicitation schema slots. Zod remains valid (Zod is a Standard-Schema implementation).
6. **One package, subpath exports:** `@agentick/mcp-next/{client, server, transport/*, auth/*, react, testing}`. Client + server share ~70% of code (wire codec, transport, vocab, auth); splitting them would duplicate that.

---

## Strategic answer: target draft, era-codecs at the wire edge

### The problem

MCP is mid-flux. Adopters today need **`2025-11-25`** (current released — adds Tasks, URL-mode elicitation, sampling-with-tools, OIDC discovery, CIMD, step-up scope). The draft (**`2026-07-28`**) is not an incremental change — it's a re-architecture:

| Aspect | `2025-11-25` | Draft |
|---|---|---|
| `initialize` handshake | Required | **Gone.** Every request carries `protocolVersion / clientInfo / capabilities` in `_meta`. |
| Server-initiated RPC | Yes (sampling, elicitation, roots) | **Gone.** Collapsed into MRTR (Multi Round-Trip Request) pattern. |
| Session at protocol layer | Yes (`Mcp-Session-Id` header) | **Gone.** Application-layer concept only. |
| HTTP GET listening channel | Yes | **Gone.** Replaced by `subscriptions/listen`. |
| `tasks` capability | Core | **Extension** (`io.modelcontextprotocol/tasks`). |
| `roots` capability | Active | Deprecated (SEP-2577). |
| `sampling` capability | Active | **Removed from core.** Becomes MRTR `inputRequest`. |
| `logging` capability | Active | **Removed from core.** Becomes per-request `_meta.logLevel`. |
| Polymorphic results | `{content, isError?}` | `{resultType: "complete" \| "input_required" \| <ext>, ...}` |
| Extensions framework | `experimental` flag | First-class reverse-DNS-keyed `extensions` map |

Targeting `2025-11-25` directly means rewriting when draft promotes. Targeting both via separate codebases means maintaining two implementations in perpetuity.

### The chosen approach

**Internal vocabulary is draft-shaped.** Stateless per-request, MRTR-native, polymorphic results, extension-keyed capabilities, `subscriptions/listen` semantics for streaming. Adopter-facing APIs (`callTool`, `readResource`, etc.) hide the wire details and look the same regardless of era.

**Wire codecs translate to/from the canonical vocab.** Three codecs:

- `wire/v2025-11-25/` — current released (default for new connections). Codec performs the `initialize` handshake, translates server-initiated `sampling/createMessage` into synthetic MRTR `inputRequests`, manages `Mcp-Session-Id` headers, encodes/decodes the non-polymorphic result shape.
- `wire/v2025-03-26/` — legacy compat (for older servers still in production).
- `wire/draft/` — opt-in via `experimental: true`, used when negotiating with draft-implementing peers.

**Era detection at connect time** per the draft's published fallback chain:
1. Try draft first (send a modern-shaped first request, e.g. `tools/list` with full `_meta`).
2. On `-32004 UnsupportedProtocolVersionError` → fall back to `2025-11-25` (send `initialize`).
3. On `2025-11-25` `initialize` response with `protocolVersion: "2025-03-26"` → fall back further.
4. On HTTP `400` with non-modern error body → server is `2025-11-25` or older.

**The trade-off:** the canonical vocab is more abstract than today's `2025-11-25` spec. Adopters reading MCP docs online from `2025-11-25` may not see one-to-one mapping. Mitigation: ship a `harness.requestRaw()` escape hatch that emits/receives the raw wire shape, plus comprehensive docs that show "MCP wire X corresponds to canonical Y."

---

## The unification: MCP semantics are Agentick's native semantics

A table that earns the design's keep. Every native Agentick primitive has a clean MCP analog. Listed both directions:

| Agentick native primitive | MCP concept | Match quality |
|---|---|---|
| Tool definition (name + inputSchema + handler) | Tool definition | **Identical shape.** Differ only in schema library — addressed by Standard-Schema adoption. |
| Tool dispatch | `tools/call` | **Identical semantics.** |
| Tool confirmation (v1's `audience: "user"`; v2 `confirmable` flag) | `elicitation/create` (form mode, three-action response: accept/decline/cancel) | **Identical pattern.** Pause execution, ask user, accept/decline/cancel, resume. Same primitive, different wire encoding. |
| Approval flows (sensitive operation gating, possibly out-of-band) | `elicitation/create` (URL mode) | URL mode unlocks Slack/mobile/email approval — superset of v1 approval. |
| Long-running tools with `ExecutionHandle` (.result/.progress/.abort) | Tasks FSM (`tools/call` with `execution.taskSupport`, `tasks/get/result/cancel`, `notifications/tasks/status`) | **Identical FSM.** MCP defines the wire encoding of substrate's handle semantics. |
| Streaming progress (`Context.emit("progress", ...)`) | `notifications/progress` | Direct map. |
| Workspace roots / sandbox boundaries | `roots/list` | Direct map. |
| Sampling (LLM call) via `session.spawn()` | `sampling/createMessage` | **Identical semantics.** |
| Resources (read-only context data) | `resources/*` | Direct map. `ResourceDeclaration` already in spec; just needs the `resources/templates/list` semantics. |
| Prompts (templated conversation starts) | `prompts/*` | Direct map. Needs `PromptDeclaration` to land in spec. |
| Event bus envelope (`surface / phase / payload`) | `notifications/*` | Direct map; substrate is richer (parentOpId, structured payloads). |
| Cancellation | `notifications/cancelled` | Direct map. |
| Logging | `logging/setLevel` + `notifications/message` | Direct map. |
| Capability negotiation per session-extension installed | MCP capabilities map | **Derived from installed bridges** — capabilities aren't declared explicitly, they fall out of which bridges exist on the session. |

**Design law:** the MCP-next package isn't a translation layer over a foreign vocabulary. It's a **wire codec** on top of the substrate's already-MCP-shaped semantics, plus the genuinely MCP-specific concerns (OAuth flow, Streamable HTTP transport binding, `Mcp-Session-Id` header, era-detection fallback chain, URL elicitation phishing mitigations, `requestState` security, JSON Schema 2020-12 elicitation subset, MRTR pattern).

---

## Package boundaries

Single package; subpath exports per the v2 modularity model (ADR 27).

```
@agentick/mcp-next/
  package.json
    "exports": {
      "."                          : "./src/index.ts",       // common types
      "./client"                   : "./src/client/index.ts",
      "./server"                   : "./src/server/index.ts",
      "./transport/stdio"          : ...,
      "./transport/streamable-http": ...,
      "./transport/in-process"     : ...,
      "./auth/oauth"               : ...,
      "./auth/bearer"              : ...,
      "./react"                    : ...,                    // JSX components
      "./testing"                  : ...
    }
  src/
    protocol/             — canonical vocab + per-era wire codecs (internal)
      vocab/              — draft-shaped canonical types
      wire/
        v2025-11-25/      — current released (default)
        v2025-03-26/      — legacy
        draft/            — experimental
        era-detection.ts
      transport-interface.ts
    transport/            — MCP-specific transport bindings
      stdio/
      streamable-http/    — Mcp-Session-Id, Origin validation, Last-Event-ID, etc.
      in-process/
      legacy-http-sse/    — 2024-11-05 fallback
    client/               — consume external MCP servers
      harness.ts          — MCPHarness extends BaseHarness<"mcp">
      bridge.ts           — MCPBridge (registry)
      augment.ts          — module-augments HookBridges
      mrtr.ts             — MRTR loop owned by harness
      reconnect.ts        — auto-reconnect middleware
    server/               — expose Agentick as MCP (shape TBD; see Open Questions)
      ...
    auth/                 — OAuth 2.1 + bearer + CIMD + step-up
    tasks/                — Tasks FSM (substrate-aware Tasks bridge)
    schema/               — Standard-Schema adapter
    react/                — JSX (<MCP>, <MCPServer> or descriptive form, hooks)
    testing/              — fakeMCPHarness + fixture servers
```

**Why one package, not three:**

Client and server share the wire codec, transport bindings, auth code, MRTR pattern, vocabulary types, and conformance fixtures. Splitting them into `mcp-client-next` + `mcp-server-next` + internal `mcp-protocol-next` would either duplicate ~70% of the code or introduce a third dependency edge.

Adopters install one package; tree-shaking handles dead-code elimination for cases where only client OR only server is used.

---

## Schema library: Standard-Schema adoption

The TS MCP SDK v2 moved to **Standard-Schema** (Zod / Valibot / ArkType / TypeBox / raw JSON Schema — agnostic). The spec uses JSON Schema 2020-12 as the canonical wire format.

**Decision:** v2 adopts Standard-Schema framework-wide for declaration schema slots (`Tool.inputSchema`, `Tool.outputSchema`, elicitation `requestedSchema`, etc.).

- Zod remains valid (Zod is Standard-Schema-compatible).
- Adopters can use Valibot, ArkType, TypeBox, or raw JSON Schema without adapters.
- The substrate's internal representation moves from `ZodSchema` → `StandardSchemaV1` in spec slots.
- Validation goes through Standard-Schema's `~validate` method.
- JSON Schema serialization (for MCP wire) goes through Standard-Schema's introspection or per-library adapter where Standard-Schema doesn't provide it directly.

**Rationale:** at the MCP boundary, schemas arrive from third-party servers in unknown shape. Forcing them through Zod would create an unnecessary adapter layer. Standard-Schema is the right abstraction.

**Rollout:** schema slot fields become `StandardSchemaV1 | ZodSchema` initially (during migration), narrow to `StandardSchemaV1` once existing call sites migrate.

---

## Client side: connection-as-harness (preserved + refined)

Each MCP connection is `BaseHarness<"mcp">`. This decision from the original ADR holds against the draft spec — even though the draft removes protocol-level session state, the *client* still has per-connection state (capability cache, pending requests, MRTR-loop state, auth tokens, reconnect bookkeeping). The harness is the right home for that state.

### Scope: per-session (target), per-app (today)

**Architectural intent: per-session McpClientHarness.** Each agentick
session owns its connection per server. Reasons:

- **MCP binds auth to the connection.** OAuth tokens, `Mcp-Session-Id`,
  server authorization decisions are per-connection. Different users
  on one agentick host MUST have different connections (different
  tokens). Sharing across users is a wire violation.
- **Concurrent elicit routing is solved by construction.** A
  per-session harness's elicit address is fixed at construction; no
  slot, no cross-session race.
- **Per-session OAuth scopes / contexts.** Even same-user-different-
  sessions wants isolation (debug session vs prod session shouldn't
  share OAuth scopes).

**Current state (#133, #149):** `withMCP` is an AppExtension that
constructs one harness per server, shared across sessions. The
elicit-bridge routes inbound elicits via inbox to the active
session's elicit address; the slot races on cross-session concurrent
calls (best-effort, surfaced via `mcp:warning:routing-dropped`).
This works for single-user CLIs and is the right cleanup posture
before per-session SessionExtension wiring lands.

**Per-session lands as #150 (SessionExtension lifecycle) + #151
(per-session McpClientHarness)**.

### ⚠️ FUTURE OPTIMIZATION — connection pool keyed by auth principal

Per-session connection fan-out costs N×M connections for N sessions
× M servers. Acceptable for HTTP-remote streams; wasteful for
stateless local stdio servers (mcp-everything, filesystem
adapters) and for huge multi-tenant deployments.

**The follow-up — connection pool layer beneath McpClientHarness:**

- Pool holds open connections keyed by `(serverId, authPrincipal)`.
- Sessions **check connections out** for the duration of a tick / a
  callTool, and **check them back in** when done.
- Same principal → connection sharing (cheap). Different principals
  → isolation (wire-correct).
- `Mcp-Session-Id` makes Streamable HTTP connections cleanly
  resumable across check-outs.
- The pool sits *beneath* McpClientHarness — a `connection:
  McpConnectionRef` indirection — so nothing above the harness
  changes when the pool is introduced.

**Defer until production load demands it** (estimated horizon: weeks
after #151 lands; track via load-test data). The abstraction layer
is straightforward; we want real workload numbers before optimizing.

### `MCPHarness` surface

```ts
interface MCPHarness extends BaseHarness<"mcp"> {
  readonly target: MCPDeclaration;
  readonly status: Signal<"idle" | "connecting" | "ready" | "reconnecting" | "failed" | "closed">;
  readonly wireVersion: Signal<MCPWireVersion | undefined>;    // observable era for telemetry
  readonly capabilities: Signal<MCPCapabilities | undefined>;
  readonly tools: Signal<readonly ToolDeclaration[]>;          // listChanged-reactive
  readonly resources: Signal<readonly ResourceDeclaration[]>;
  readonly prompts: Signal<readonly PromptDeclaration[]>;

  // Lifecycle
  connect(): Promise<void>;                                    // includes initial auth handshake
  disconnect(reason?: string): Promise<void>;
  ping(): Promise<MCPPingResult>;

  // Canonical operations (era-agnostic; codec translates to wire)
  callTool(name: string, args: unknown, opts?: MCPCallOpts): Promise<MCPToolResult>;
  readResource(uri: string, opts?: MCPCallOpts): Promise<MCPResourceContents>;
  getPrompt(name: string, args?: unknown): Promise<MCPPromptResult>;

  // Discovery (cached, listChanged-invalidated)
  listTools(opts?: { refresh?: boolean }): Promise<readonly ToolDeclaration[]>;
  listResources(opts?: { refresh?: boolean }): Promise<readonly ResourceDeclaration[]>;
  listResourceTemplates(opts?: { refresh?: boolean }): Promise<readonly ResourceTemplateDeclaration[]>;
  listPrompts(opts?: { refresh?: boolean }): Promise<readonly PromptDeclaration[]>;

  // Escape hatch for wire-level access (telemetry, debugging, exotic patterns)
  requestRaw<T>(method: string, params: unknown, opts?: MCPCallOpts): Promise<T>;
}
```

**Authentication is not a separate command.** `connect()` runs the auth handshake. Re-auth on token expiry is handled by auth middleware (default-installed). Manual reconnect is `disconnect().then(connect)`.

### MRTR loop owned by harness

`callTool` returns a Promise that resolves only when terminal. If the wire returns `InputRequiredResult`, the harness internally:
1. Dispatches each `inputRequest` to its registered resolver (sampling → executor, elicitation → ElicitationBridge, roots → workspace bridge).
2. Gathers `inputResponses`.
3. Retries the original request with a new id, echoing `requestState`.
4. Repeats until terminal.

**Resolvers come from session-extension config**, not constructor options. The substrate's existing sampling-as-spawn and dispatch-as-tool-call patterns ARE the resolvers — we don't write MCP-specific sampling code, we write 30-line resolvers that translate MCP request → substrate primitive.

For legacy wire (`2025-11-25` and earlier), the codec translates inbound server-initiated `sampling/createMessage`/`elicitation/create`/`roots/list` requests into synthetic MRTR `inputRequests` on the harness's current in-flight tool call. The harness internals only ever see MRTR.

### Inbox dispatch

```ts
type MCPInboxMessage =
  | { type: "input-required"; requestId: string; inputs: MCPInputRequests; requestState: string }
  | { type: "subscription-update"; subscriptionId: string; notification: MCPNotification }
  | { type: "progress"; requestId: string; progress: number; total?: number; message?: string }
  | { type: "cancelled"; requestId: string; reason?: string };
```

Per-connection inbox (OQ23.4 lean preserved). Each MCPHarness owns its inbox; multi-server isolation is cleaner.

### `MCPBridge` (client-side)

Registry of MCP harnesses. Module-augments `HookBridges`:

```ts
declare module "@agentick/spec-next" {
  interface HookBridges {
    mcp: MCPBridge;
  }
}

interface MCPBridge {
  register(harness: MCPHarness): void;
  unregister(id: string): void;
  get(id: string): MCPHarness | undefined;
  list(): readonly MCPHarness[];
  subscribe(listener: (harnesses: readonly MCPHarness[]) => void): () => void;
}
```

Adopters access the bridge via `app.bridges.mcp`. The reconciler's collect walker pulls tools/resources/prompts from every registered MCP harness into `RuntimeDeclarations`.

---

## Server side: SHAPE (provisionally resolved as S3)

Three candidate models considered:

### Candidate S1 — Integrated server (session-extension)

Each `<MCPServer>` mounts an `MCPServerHarness` ON A SESSION. Incoming MCP requests dispatch through the session's substrate; the server's lifecycle is tied to a session's. Confirmation/approval/elicitation/tasks pipelines all auto-route through that session.

**Pros**: full unification; no plumbing required for session integration.
**Cons**: heavy machinery for the common case ("just expose some tools via MCP"); MCP server life-coupled to session life; non-trivial `sessionStrategy` mental load; doesn't fit standalone MCP servers (math-utils, file-tools) at all.

### Candidate S2 — Descriptive server (declaration tree, no session machinery)

Declare an MCP server as a standalone JSX tree (or programmatic equivalent). No SessionHarness. No bridges. Just tools/resources/prompts + a runtime that executes handlers and speaks MCP wire.

**Pros**: lightweight; minimal ceremony for the common case.
**Cons**: no automatic integration with confirmation/approval/elicitation pipelines; adopters must hand-wire each integration; the `<MCPSelf>` pattern (app consuming its own server) needs an additional structural concept.

### Candidate S3 — Knowify pattern (lightweight server + per-request hooks)

The pattern in production at Knowify (`libs/mcp/src/server.ts` + `apps/assistant-api/src/v2/gateway.ts`). The MCPServer is a **standalone primitive** (S2-like) with **first-class integration hooks** as constructor options:

```ts
interface MCPServerConfig {
  name: string;
  version: string;
  description?: string;
  instructions?: string | (() => string);

  // Declarations — supplied as object arrays OR collected from JSX
  tools?: MCPTool[];
  resources?: MCPResource[];
  resourceTemplates?: MCPResourceTemplate[];
  prompts?: MCPPrompt[];
  apps?: MCPApp[];                          // MCP Apps if applicable

  // Security pipeline (ConnectionGuard → Authenticator → Authorizer)
  security?: MCPSecurityConfig;

  // Per-request hooks — the integration points
  contextProvider?: (extra: RequestExtras) => MCPRequestContext;
  toolFilter?: (tool: MCPTool, ctx: MCPRequestContext) => boolean;
  toolTransform?: (tool: MCPTool, ctx: MCPRequestContext) => MCPTool;
  resourceFilter?: (res: MCPResource, ctx: MCPRequestContext) => boolean;

  // OAuth/auth hints
  securitySchemes?: SecurityScheme[];
  resourceMetadataUrl?: string;
}
```

Tools are objects: `{name, description, inputSchema, handler}`. The MCP server has no opinion about whether handlers invoke Agentick sessions, call external HTTP services, run pure functions, or anything else. Session integration happens **inside specific tool handlers when needed**:

```ts
// A tool that delegates to an Agentick session
{ name: "ask_assistant",
  handler: async (question, sessionId) => {
    const result = await (await app.session(sessionId)).send({...}).result;
    return result;
  }
}

// A tool that's pure HTTP proxy — no session involved
{ name: "query",
  handler: async (args, ctx) => httpClient.post("/query", args, { user: ctx.user })
}
```

Per-request context (`transportType`, `sessionId`, authenticated `user`, etc.) flows through `contextProvider` into every handler + filter, so tools can branch on "am I being called by an in-process consumer vs. external HTTP client?"

The "app-as-its-own-MCP-server" pattern (the dream) is just **mounting the same MCPServer for multiple transports**:

```ts
// One server, multiple transports
const server = createMCPServer({ tools, resources, ... });

// Mount via gateway plugin for external HTTP clients
gateway.use(mcpServerPlugin({ path: "/mcp", server }));

// Mount via in-process transport for local consumption
const inProcConn = mcpServer.connect({ transport: "in-process" });
localAgentApp.bridges.mcp.register(inProcConn);
```

`toolFilter`'s `ctx.transportType` discriminates. No `<MCPSelf>` component needed — the pattern reduces to "mount the same server twice."

JSX remains available as **sugar over the same constructor**:

```tsx
const server = createMCPServer({
  name: "my-app",
  declarations: (                              // reconciler walks, collects declarations
    <>
      <Tool name="lookup" handler={lookup} />
      <Resource uri="customer://{id}" handler={readCustomer} />
    </>
  ),
  contextProvider, toolFilter, toolTransform, security,
});
```

The reconciler is **optional** — adopters in React get JSX sugar; adopters in plain Node use the object form. Both produce the same MCPServer.

**Pros**:
- Lightweight: same minimal ceremony as S2 for the common case.
- Production-proven: this is the pattern Knowify ships at scale.
- Flexible: per-request hooks (`contextProvider`, `toolFilter`, `toolTransform`) give S1-flavored integration WHERE NEEDED without forcing it everywhere.
- Dissolves `<MCPSelf>`: no special "self" pattern — just mount the server for in-process + HTTP transports.
- JSX optional, not required: opens MCP server authoring to React-free contexts (Node-only servers, agent-less tool services).
- Transport-agnostic: same server, multiple transports, per-transport discrimination via `ctx`.

**Cons**:
- Per-tool integration with elicitation/tasks/approval is more code than S1 would require (because S1 auto-routes everything through a session). Adopters writing a confirmable MCP tool must explicitly emit elicitation requests in their handler. The substrate can provide helpers (`ctx.elicit.form(...)`, `ctx.task(...)`) but the handler is responsible for using them.
- No "everything is observable via the session bus" — observability is at the MCP-server level, not the substrate level. (Mitigation: the MCP server emits its own events via the bus; substrate-level observers see them with `surface: "mcp"`.)
- Adopters new to the pattern may not immediately see how to integrate with sessions — needs clear docs and migration examples.

### Resolution: S3 (Knowify pattern) is the provisional lean

S3 dissolves the tensions that S1/S2 each had:
- It's as lightweight as S2 for the standalone case
- It supports session integration via per-tool-handler delegation (the `ask_knowify` pattern)
- It supports the "app-as-its-own-MCP-server" dream via multi-transport mounting (no `<MCPSelf>` concept)
- It keeps JSX as sugar without making JSX required

**Open: validate against more adopter scenarios before locking in.** OQ23.10 now narrows to "is S3 sufficient, or are there scenarios where S1's auto-routing wins enough to justify shipping both?" See OQ23.10 below.

---

## Transport set

Reuse `BaseClientTransport` from `@agentick/transport-next` (ADR 33) for the wire-level plumbing (connection state machine, RPC correlation, reconnect-with-backoff). MCP-specific transport bindings layer on top.

| Transport | When | Status |
|---|---|---|
| stdio | Local subprocess MCP servers; CLI integrations | Ship in MCP.1 |
| Streamable HTTP | Remote MCP servers; cloud-hosted; gateway-bridged | Ship in MCP.2 |
| in-process | When same Agentick app consumes an MCP server it declares locally (`<MCPSelf />`) | Ships with server side (after OQ23.10 resolves) |
| Legacy HTTP+SSE | Fallback for 2024-11-05-era servers | Ship in MCP.6 (after main transports + auth) |

Stdio is unambiguously transport-level. Streamable HTTP includes the `Mcp-Session-Id` header dance (for `2025-11-25`-era; gone in draft), `MCP-Protocol-Version` header (gone in draft), `Origin` validation, `Last-Event-ID` resume semantics, `text/event-stream` SSE leg for server-initiated messages. These are MCP-specific concerns layered on top of the generic transport.

---

## Auth

`@agentick/mcp-next/auth/`. Two-tier surface mirroring the SDK ecosystem survey's finding:

- `auth/bearer` — simple `AuthProvider` interface: `token(): Promise<string | undefined>` + optional `onUnauthorized(ctx)`. Adopter-managed bearer tokens.
- `auth/oauth` — full OAuth 2.1 + PKCE (S256 required) + RFC 8707 resource indicators + RFC 9728 protected resource metadata + OIDC discovery + Client ID Metadata Documents + step-up scope flow. Adapter to `AuthProvider` via `adaptOAuthProvider`.

Adopters import what they need. CLI/dev tools use bearer; production-cloud uses OAuth.

`MCPAuthStorage` interface for token persistence lives in `@agentick/mcp-next/auth/` (per OQ23.5 lean — MCP-specific, not in spec).

---

## Migration path for v1 adopters

v1 `@agentick/mcp` is replaced by v2 `@agentick/mcp-next`. No import compat. Migration guide ships with the package.

```diff
- import { MCPClient } from "@agentick/mcp";
- const client = new MCPClient({ servers: [...] });
- await client.connect();
- const result = await client.invokeTool("files", "read", { path });

+ import { MCP } from "@agentick/mcp-next/react";
+ const app = await createApp(<Agent />, {
+   model,
+   extensions: [withMCP()],
+ });
+ // MCP connections declared in JSX via <MCP>
+ // Tools surfaced to the model automatically; native invocations
+ // also possible via the harness directly:
+ const harness = app.bridges.mcp.get("files");
+ const result = await harness.callTool("read", { path });
```

The direct-invocation path mostly disappears — the model uses MCP tools as native tools.

---

## What this ADR does NOT decide

These are flagged as open questions:

- **Server-side shape** (S1 integrated vs S2 descriptive; see OQ23.10–OQ23.13).
- **`<MCPSelf />` as a first-class pattern** — exists in the design discussion but unresolved.
- **Where the elicitation bridge lives** (substrate-level in spec, or MCP-specific) — leaning substrate-level given the unification.
- **Tasks bridge lifting** — whether substrate's existing `ExecutionHandle` semantics get lifted to a typed `TasksBridge` primitive in spec, or whether MCP's tasks are a wire-codec concern only.
- **MCP Apps capability** — v1 has custom MCP Apps support; v2 likely keeps it but the shape is TBD.
- **Roots provider configuration** — `<Roots>` declaration? `withMCP({ roots })` config? Per-`<MCP>` prop?
- **Progressive resource discovery** — v1 has lazy resource loading; v2 likely keeps it; concrete shape TBD.

---

## Implementation cost (revised estimate)

This ADR's implementation lift is significantly larger than the original estimate (~5-6 days). Realistic per-phase estimate:

| Phase | Scope | Estimate |
|---|---|---|
| MCP.0 | Spec gaps (ResourceDeclaration, PromptDeclaration, ElicitationBridge, Standard-Schema rollout, MCPCapabilities) | 2-3 days |
| MCP.1 | Foundation (canonical vocab, v2025-11-25 codec, stdio transport, MCPHarness skeleton, `<MCP>` JSX, conformance against SDK ref server) | 3-4 days |
| MCP.2 | Streamable HTTP + bearer auth + era detection + reconnect | 2-3 days |
| MCP.3 | Discovery + caching + listChanged + bridge integration | 1-2 days |
| MCP.4 | MRTR + sampling + elicitation + roots (form mode) | 2-3 days |
| MCP.5 | Tasks (with substrate-aware Tasks bridge) | 2-3 days |
| MCP.6 | Server side (waits on OQ23.10) | 4-6 days |
| MCP.7 | OAuth 2.1 full (PKCE, RFC 8707, RFC 9728, OIDC, CIMD, step-up) | 4-5 days |
| MCP.8 | Draft wire codec + era detection extended | 2-3 days |
| MCP.9 | URL-mode elicitation + phishing mitigations | 1-2 days |
| MCP.10 | Legacy HTTP+SSE fallback | 1 day |
| MCP.11 | Polish, docs, migration guide, DX | 2-3 days |

**Total: ~26-37 days of focused work**, spread across multiple phases that ship independently. Client-side path (MCP.0 → MCP.5) is ~12-18 days; server-side adds significantly more.

---

## Sequencing recommendation

1. **Resolve OQ23.10–OQ23.13** before any server-side code. Client-side is unblocked.
2. **Phase MCP.0**: spec gaps. Adds `ResourceDeclaration`, `PromptDeclaration`, `ElicitationBridge`, Standard-Schema rollout, `MCPCapabilities`. Pure spec work; no implementation.
3. **Phase MCP.1**: foundation (canonical vocab, v2025-11-25 codec, stdio transport, `MCPHarness` skeleton). Validate against `@modelcontextprotocol/sdk` reference server.
4. **Phase MCP.2-MCP.5**: build out the client side (transports, discovery, MRTR, tasks).
5. **Resolve server-side shape** (OQ23.10) based on learnings from client-side.
6. **Phase MCP.6+**: server side.
7. **Phase MCP.8**: draft wire codec when draft promotes (or sooner if a draft-implementing peer emerges).

---

## Open questions

### From the original ADR (revisited)

- **OQ23.1** — Should `MCPHarness` expose `request()` AND the convenience methods (`callTool`, `readResource`, `getPrompt`), or just `request()`? **Resolution: ship both** + a `requestRaw()` escape hatch for wire-level access.
- **OQ23.2** — When the server changes its tool list mid-session, does the agent's `RuntimeDeclarations` re-collect automatically? **Resolution: yes** — `tools.listChanged` reactive signal triggers re-collect via bridge subscription.
- **OQ23.3** — Sampling callbacks invoke the executor. If middleware on the executor rate-limits them, what's the error path back to the server? **Resolution: middleware rejection → MCP protocol error** sent back via the MRTR response.
- **OQ23.4** — Should the inbox be ONE inbox shared with the rest of the app, or per-connection? **Resolution: per-connection** (preserved from original lean).
- **OQ23.5** — Auth storage interface in `@agentick/mcp-next` or `@agentick/spec-next`? **Resolution: `@agentick/mcp-next/auth`** (MCP-specific token shapes).
- **OQ23.6** — How does `connect()` surface auth-redirect-required in headless contexts? **Resolution: throws `AuthInteractionRequired` with URL**; adopters handle interactively or via pre-populated tokens. The `<MCP>` JSX component installs an `onAuthRequired` handler integrating with the `ElicitationBridge` for UI flows.
- **OQ23.7** — Auto-reconnect middleware bundled in `@agentick/mcp-next/react` (default-on) or shipped separately? **Resolution: bundled, default-on for HTTP transports; off for stdio/in-process** (process death is end-of-session).

### New (from 2026-06-14 design session)

- **OQ23.8** — Standard-Schema adoption rippled to `spec-next` schema slots, or limited to MCP boundary? **Lean: ripple to spec-next.** Schema-slot fields become `StandardSchemaV1`. Zod continues to work transparently. Reduces special cases, future-proofs.

- **OQ23.9** — Wire codec visibility to adopters? **Lean: observable read-only** via `harness.wireVersion: Signal<MCPWireVersion>` for telemetry/devtools; never user-settable.

- **OQ23.10** — Server-side shape: S1 (session-extension), S2 (descriptive), or S3 (Knowify pattern — lightweight + per-request hooks)? **Provisional resolution: S3.** Validated by Knowify production usage (`libs/mcp/src/server.ts` + `apps/assistant-api/src/v2/gateway.ts`). Open: is S3 sufficient, or are there scenarios where S1's auto-routing through a session wins enough to justify shipping both? Needs:
  - One or more adopter scenarios where S3's per-tool-handler delegation feels meaningfully clumsier than S1's auto-routing
  - Confirmation that S3 doesn't lose substrate-level observability adopters would expect (events with `surface: "mcp"` should still flow through the session bus when the MCP server is invoked from in-process)

- **OQ23.11** — `<MCPSelf />` first-class pattern? **Provisional resolution: NOT NEEDED with S3.** The "app talks to its own MCP server" pattern reduces to "mount the same MCPServer for in-process + HTTP transports." `toolFilter`'s `ctx.transportType` discriminates per-call. No special structural concept required.

- **OQ23.12** — Session strategy mechanism (formerly: how does S1 map MCP requests to sessions?). With S3 selected: **resolved differently — no global session strategy needed.** Per-request context flows through `contextProvider`, and tools that need a session-scoped operation invoke `app.session(...)` inside their handler. The mapping is per-tool, not per-server.

- **OQ23.13** — Server-side security pipeline: port v1 verbatim? **Resolution: port the shape (ConnectionGuard → Authenticator → Authorizer → RateLimiter → InputSanitizer), implemented as constructor-config callbacks per S3.** v1's production-tested shape, modernized to the S3 hooks API.

- **OQ23.14** — `<MCP>` JSX shape: one component with array prop vs many siblings? **Resolution: many siblings.** Each `<MCP>` mounts one harness. Multi-server is composition. Aligns with Anthropic's `mcp_servers[]` flat shape.

- **OQ23.15** — Tasks: ship in MCP.5 as planned, lifted to a substrate-aware `TasksBridge` so the long-running-tools pattern works equivalently for local invocations? **Lean: yes.** Decouples the substrate's already-existing handle semantics from MCP's wire encoding of them. Local and MCP-wire invocations of a `longRunning` tool both return the same ExecutionHandle; MCP wire encoding happens at the boundary.

- **OQ23.16** — v1's `InMemoryTransport` was a custom impl due to an SDK concurrency bug. Does the SDK v2 fix it? **Resolution: verify during MCP.1 implementation**; default to porting from v1 if unclear.

- **OQ23.17** — Migration path from v1: dual-package compat (`@agentick/mcp` continues to ship alongside `@agentick/mcp-next` for a transition window) or clean break? **Lean: clean break.** v2 doesn't promise import compat with v1; rename forces adopter migration to the new model.

---

## Risks

1. **Spec churn during build.** Draft is moving; today's draft snapshot may shift before MCP.8 ships. Mitigation: pin canonical vocab to today's draft snapshot; treat future-draft changes as a new codec version.

2. **OAuth complexity.** PKCE + RFC 8707 + RFC 9728 + OIDC + CIMD + step-up is a multi-week implementation lift. Mitigation: borrow heavily from v1 auth code (production-tested).

3. **MRTR translation correctness for legacy wire.** Translating server-initiated `sampling/createMessage` ↔ MRTR `inputRequests` while preserving cancellation/progress/timeouts is real engineering work. Mitigation: aggressive testing against `@modelcontextprotocol/sdk` reference server.

4. **Era detection edge cases.** Real-world server behavior at the era boundary is going to be quirky. Mitigation: manual-override `wireVersion` config + extensive era-detection logging.

5. **Standard-Schema ripple.** Changing the substrate's schema slot from Zod to Standard-Schema touches many packages. Mitigation: incremental rollout — slots become `StandardSchemaV1 | ZodSchema` initially, narrow over time.

6. **Server-side `requestState` security.** Draft spec is explicit that `requestState` is attacker-controlled; server MUST HMAC/AEAD/TTL/principal-bind. v1 has no analog — new code required. Mitigation: explicit security review of server-side `requestState` handling before shipping any server implementation.

---

## v1 capabilities to preserve (from v1 audit)

The v1 `@agentick/mcp` package is mature and production-tested. The v2 implementation should harvest:

- **Connection health model** — state machine (connected/disconnecting/reconnecting/degraded) + connection-attempt deduplication + exponential backoff reconnect + circuit breaker (5 consecutive failures → cooldown).
- **Per-server caches with event-driven invalidation** — `tools/resources/prompts` caches keyed by serverName; `list_changed` notification → clear cache → emit `*:changed` event.
- **Request/response correlation via SDK's internal messageId routing** — don't fight the SDK's plumbing; layer above it.
- **Sugar APIs for bidirectional RPC** (under the unification, these become the substrate's sampling/elicitation/roots resolvers): `ctx.sample.text() / .message() / .structured() / .withTools()`, `ctx.elicit.text() / .select() / .form() / .url()`, `ctx.roots.list() / .isWithin() / .assertWithin() / .subscribe()`.
- **Per-transport auth defaults** — HTTP gets OAuth flow; stdio/in-process skip auth (trusted lifecycle).
- **Error classification at call site** — typed `MCPClientError.type` (`timeout`, `server_error`, `circuit_open`, etc.) enables specific retry/fallback per error class.
- **Structured sampling result shape** — preserve `model`, `stopReason` explicitly.
- **Security pipeline stages** (for server-side, if and when S1 lands) — ConnectionGuard → Authenticator → Authorizer → RateLimiter → InputSanitizer with typed `SecurityError` → protocol error code -32001.
- **Per-session request context** — `MCPRequestContext` flows through every pipeline stage with auto-enriched user/client/session metadata.

---

## v1 patterns to NOT carry over

- **SDK transport imports directly** — v1 imports `@modelcontextprotocol/sdk` transports without abstraction. v2 should add a clean abstraction so SDK transport-API churn doesn't ripple.
- **`dispatchProcedure` + middleware registry plumbing** — v1 framework coupling; v2's harness model replaces it.
- **Zod → JSON Schema conversion at call time** — under Standard-Schema adoption, this moves to registration time.
- **Custom `InMemoryTransport`** — if SDK v2 fixed the concurrency bug, drop the custom impl.
- **EventEmitter for connection state** — v2 uses reactive signals (`harness.status: Signal<...>`); EventEmitter is legacy.

---

## Cross-references

- [ADR 22](./22-state-formatters-reconciler-shape.md) — bridge extensibility pattern.
- [ADR 27](./27-modular-built-ins.md) — modular package layout (per-harness convention).
- [ADR 33](./33-client-and-transports.md) — `BaseClientTransport` reuse, transport bindings.
- [01 — Harness Principle](./01-harness-principle.md) — five-surface contract.
- [07 — Tool Executor](./07-tool-executor.md) — synthetic handler resolution for MCP tools.
- [10 — Events / Handlers / Inbox](./10-events-handlers-inbox.md) — inbox model.
- [19 — Foundation](./19-foundation.md) — BaseHarness substrate.
- MCP spec `2025-11-25` — https://modelcontextprotocol.io/specification/2025-11-25
- MCP draft — https://modelcontextprotocol.io/specification/draft
- v1 `@agentick/mcp` package — `packages/mcp/src/`
- Knowify v1 reference: production MCP server factory (`/Users/ryan/Documents/work/knowify/nx-knowify/libs/mcp/src/server.ts`) + gateway wiring (`/Users/ryan/Documents/work/knowify/nx-knowify/apps/assistant-api/src/v2/gateway.ts`). Validates S3 pattern at scale.
