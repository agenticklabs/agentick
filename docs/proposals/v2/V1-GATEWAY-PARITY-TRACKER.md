# v1 → v2 Gateway Parity Tracker

**Status:** open. Updated as gaps close.

This document tracks the feature gap between v1's `@agentick/gateway`
(`packages/gateway/src/` — ~27K LOC across 25 files) and v2's
`GatewayHarness` (`packages/gateway/src/v2/` — Phase 4 onward).

**v2 MUST reach feature parity with v1 before 1.0** — anything dropped
is a regression for adopters migrating from v1. Some v1 features may
reshape (plugin → extension) or relocate (method registry → tool
dispatch), but the underlying capability must remain available.

Source audit performed: 2026-06-06 (read v1 `gateway.ts` ~2500 LOC,
`types.ts`, `app-registry.ts`, `session-manager.ts`, transport
modules, plugin modules).

---

## Architectural shift: plugins → extensions

V1's `GatewayPlugin` shape (id + initialize + destroy + plugin
context) maps cleanly to v2's `GatewayExtension` shape per ADR 31's
extension protocol. Method registration, route registration, event
subscription, broadcast — all become methods on `GatewayInstaller`
(parallel to `AppInstaller` / `SessionInstaller`).

**This is a v2 reshape, not a v2 drop.** Every v1 plugin becomes a v2
extension. The reshape gives extensions the same architectural status
as the harness's built-in surface.

---

## Status legend

`[ ]` open · `[~]` in progress · `[x]` closed · `[reshape]` v1
feature reshaped into v2 extension or different harness location ·
`[deferred]` intentional scope · `[dropped]` replaced by v2 mechanism

---

## Critical (must close before v2.0)

### G-CORE — `GatewayHarness` shape

- [ ] **GG1. GatewayHarness extends BaseHarness.** Top-level harness
      with substrate slots (bus/inbox/journal) inheritable; substrate
      slot pattern from ADR 31; identity (`id`, `metadata`); standard
      lifecycle. **Phase 4 deliverable.**
- [ ] **GG2. Multi-app hosting.** `gateway.createApp(element, options)`
      / `gateway.app(id)` / `gateway.apps()`. Eager list at
      construction OR lazy factory (ADR 31 line 138 lists both as
      options; final shape decided during Phase 4 build).
- [ ] **GG3. Cross-app event observation.** `gateway.events(filter?,
options?)` returns `AsyncIterable<ProtocolEvent>` aggregating
      every app the gateway hosts. **Inherits from Phase C bus
      surface.**
- [ ] **GG4. Lifecycle.** `closeGateway()` / `close()` alias.
      Cascades into apps' close. Operation-wrapped with `bus-only`
      override per Option G semantics (ADR 31 §close-op
      journaling-policy).

### G-EXT — Extension protocol surface

- [ ] **GE1. `GatewayExtension` shape** in spec — parallel to
      `AppExtension` / `SessionExtension`. `target: "gateway"`,
      `install(installer: GatewayInstaller)`. **Phase 4 deliverable.**
- [ ] **GE2. `GatewayInstaller`** with the minimum useful surface for
      transports + plugins: `hostId`, `substrate`,
      `registerNamespace`, `getNamespace`, `onClose`, plus
      gateway-specific additions (`registerMethod`, `registerRoute`,
      `subscribeBus`). Shape decided during Phase 4 build.

---

## Network transports (deferred — Phase 5+ per-transport packages)

V1 shipped six transports in the gateway package. V2 splits each into
its own package, all installed as extensions. None ship in Phase 4's
thin scaffold.

- [reshape] **GT1. WebSocket transport** → `@agentick/gateway-ws`.
- [reshape] **GT2. HTTP/SSE transport** → `@agentick/gateway-http-sse`.
- [reshape] **GT3. Streamable HTTP (MCP-style)** → `@agentick/gateway-streamable-http`.
- [reshape] **GT4. Unix socket transport** → `@agentick/gateway-unix-socket`.
- [reshape] **GT5. Local (in-process) transport** → `@agentick/gateway-local` (for tests + Tier 0).
- [reshape] **GT6. Embedded mode (use as middleware)** → `@agentick/gateway-express` matches v1 naming.
- [reshape] **GT7. Multi-transport mode** (`"both"` / multiple simultaneously) → adopter composes multiple extensions. Same gateway, multiple transport extensions installed.

---

## Plugins (deferred — Phase 5+ as extensions)

V1's three in-tree plugins each become a v2 extension package.

- [reshape] **GP1. MCP server** (v1's `mcp-server` plugin) →
  `@agentick/gateway-mcp-server`. Exposes the gateway's
  apps/methods over the MCP wire protocol.
- [reshape] **GP2. OpenAI-compat shim** (v1's `openai-compat` plugin)
  → `@agentick/gateway-openai-compat`. Exposes sessions via the
  OpenAI Chat Completions wire protocol so OpenAI client SDKs
  work against agentick.
- [reshape] **GP3. Logging plugin** (v1's `logging`) →
  `@agentick/gateway-logging`. Structured logging extension.

---

## Session management (reshape — split between Gateway and Apps)

V1's `SessionManager` lived on Gateway and held:

- per-client session mappings (which client owns which session)
- session subscriptions (which clients subscribe to which session's events)
- hibernation timers
- resume state

In v2, sessions are owned by Apps (per ADR 31 — App is the supervisor;
Session is the unit of execution). Cross-client session ownership and
subscription state belongs at the transport extension layer, not the
gateway core.

- [reshape] **GS1. Session lookup by key** — `gateway.app(appId).session(sessionId)` (two-step) replaces v1's `gateway.session("appId:sessionId")` (single key).
- [reshape] **GS2. Per-client session ownership** — transport extensions track which client owns which session (transport-specific concern, not gateway-core).
- [reshape] **GS3. Channel subscriptions** — transport extensions broker subscriptions; substrate bus already supports the underlying multi-subscriber model.
- [deferred] **GS4. Hibernation** — session-level concern; reshape during the session-hibernation pass. Not Phase 4.
- [deferred] **GS5. Resume with `lastSeenSequence`** — Phase C's cursor protocol gives us the primitive; transport extensions use `bus.subscribe(query, { fromCursor })` for resume.

---

## Method registry / RPC (open design question — likely reshape)

V1's gateway exposed RPC-style methods (`gateway.invoke("foo.bar",
params)`) with schemas, namespaces, roles, guards. Streaming methods
supported via async generators.

In v2, this could be:

- (a) Kept as a gateway-level concern (method registry extension)
- (b) Folded into `session.dispatch` / `app.dispatch` (v2's tool-dispatch primitive)
- (c) Replaced by direct extension RPC (each extension exposes its own surface)

**Open design question.** Phase 4 doesn't ship methods; Phase 5+
chooses the shape.

- [ ] **GM1. Method registry decision** — gateway-level vs. tool dispatch vs. extension RPC.
- [reshape] **GM2. Method schemas** — Zod schemas attached to methods. Move to whichever shape GM1 picks.
- [reshape] **GM3. Streaming methods** — async generators. Same as GM2.
- [reshape] **GM4. Method namespaces** — recursive nesting. Same as GM2.
- [reshape] **GM5. Role-based access** — per-method roles. Auth-system concern (see G-AUTH below).
- [reshape] **GM6. Method guards** — per-method validation guards. Same as GM5.

---

## Auth + identity (deferred — Phase 5+ as cross-cutting extension)

V1's auth lives partly in `@agentick/server` and partly in the
gateway's request handling. Validate tokens, extract identity, attach
to context, role checks.

In v2, this is its own design pass — cross-cutting between gateway
extensions, app dispatch, and session-level identity propagation.

- [deferred] **GA1. Authenticate** — token validation, identity extraction.
- [deferred] **GA2. Authorize** — does identity own session/access this method?
- [deferred] **GA3. Tenant scoping** — set `metadata.tenantId` on session creation. Note: framework defines no `tenantId` field; adopters set it via metadata. Per ADR 31's "Multi-tenancy is emergent" principle.
- [deferred] **GA4. Roles + guards** — per-method role checks.
- [deferred] **GA5. WWW-Authenticate header generation** — transport-specific (HTTP/WS).

---

## Configuration system (reshape — adopter-owned)

V1's `ConfigStore` was a runtime config bag that adopters populated
via `agentick.config.json` and accessed in tools / plugins. Plugins
declared config schemas; the config was validated at load time.

In v2, this can be:

- (a) Kept as a gateway-level extension (config-store extension)
- (b) Adopter-owned entirely (v2 doesn't ship a config primitive)
- (c) Replaced by the `metadata` bag on each harness (lightweight)

V1's config-store was substantial work. v2's stance: **adopters bring
their own config layer** unless we discover a structural need.

- [deferred] **GC1. Config store decision** — extension, adopter-owned, or metadata-based.
- [deferred] **GC2. Plugin config schemas** — only if GC1 lands as extension.

---

## Per-client backpressure (reshape — transport concern)

V1's `ClientEventBuffer` provides bounded buffers per connection,
back-pressuring slow clients, closing connections on overflow.

This is a transport-extension concern in v2. Each transport extension
manages its own per-connection buffer policy. The gateway's substrate
bus already has the cursor protocol for slow-subscriber semantics
(Phase C); transports wrap it for connection-level backpressure.

- [reshape] **GB1. Per-connection event buffer** → transport extension internal.
- [reshape] **GB2. Sequence numbers for resume** — replaced by Phase C's `Cursor` (`bus.subscribe(query, { fromCursor })`).
- [reshape] **GB3. Buffer overflow → connection close** — transport extension policy.

---

## Static file serving (deferred — out of gateway scope)

V1's `serveStatic` ships in the gateway package. In v2, static-file
serving is a transport-adjacent concern (the HTTP transport extension
may include it; gateway core doesn't).

- [deferred] **GF1. Static file serving** → `@agentick/gateway-http-sse` or similar.
- [deferred] **GF2. CORS configuration** → per-transport.

---

## Tool confirmation flow (reshape — already in v2 via tool-executor)

V1's gateway routes tool-confirmation messages between clients and
sessions. In v2, the tool-executor harness owns confirmation flow;
transport extensions wire client confirmation responses through
session-level inbox messages.

- [reshape] **GTC1. Tool confirmation routing** — already implemented in v2's `@agentick/tool-executor-next` (the confirmation flow is a session-level concern, not gateway-level). Transport extensions just pipe client responses to `session.dispatch` or inbox.

---

## DevTools (reshape — observer extension)

V1's gateway emits a shadow devtools event stream (`devToolsEmitter`)
that exposes full prompts, model context, provider details. Internal
events are filtered from the public subscriber list but exposed to
devtools.

In v2, this becomes an observer extension on the substrate bus. The
`@agentick/devtools` package (existing) subscribes to the gateway's
bus directly.

- [reshape] **GD1. DevTools event stream** → `@agentick/devtools` subscribes to gateway bus directly.
- [reshape] **GD2. Internal event filtering** — already a `JournalingPolicy.override` concern (events flagged `bus-only` or `drop`); generalized in ADR 29.

---

## Audit summary (after this pass)

| Category                     |  Total | In Phase 4 | Deferred | Reshape | Dropped |
| ---------------------------- | -----: | ---------: | -------: | ------: | ------: |
| Gateway core (GG)            |      4 |          4 |        0 |       0 |       0 |
| Extension protocol (GE)      |      2 |          2 |        0 |       0 |       0 |
| Network transports (GT)      |      7 |          0 |        7 |       7 |       0 |
| Plugins (GP)                 |      3 |          0 |        3 |       3 |       0 |
| Session management (GS)      |      5 |          0 |        2 |       3 |       0 |
| Method registry (GM)         |      6 |          0 |        6 |       5 |       0 |
| Auth (GA)                    |      5 |          0 |        5 |       0 |       0 |
| Configuration (GC)           |      2 |          0 |        2 |       0 |       0 |
| Per-client backpressure (GB) |      3 |          0 |        3 |       3 |       0 |
| Static file serving (GF)     |      2 |          0 |        2 |       2 |       0 |
| Tool confirmation (GTC)      |      1 |          0 |        0 |       1 |       0 |
| DevTools (GD)                |      2 |          0 |        0 |       2 |       0 |
| **Total**                    | **42** |      **6** |   **30** |  **26** |   **0** |

(Reshape count overlaps with deferred — items are tagged with their
final disposition; some appear in both columns.)

**Phase 4 closes 6 items** (the gateway core + extension protocol).
The remaining 36 are deferred to Phase 5+ in their own packages or
need design decisions before reshaping.

**Nothing is permanently dropped.** v1 → v2 is a reshape, not a
retraction.
