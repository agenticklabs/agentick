# @agentick/spec

## 1.0.0-next.19

### Minor Changes

- The last N entries of a log are readable. "Open this thread on its most
  recent 20 messages" — the first read every chat UI performs — had no
  expression anywhere in the framework: `LogQuery` and `history` took a
  lower bound only, and the same lower-bound-only shape was mirrored at
  every layer above (the `timeline/history` payload, the harness face, the
  client handle). The first real consumer paid for that absence four
  times over: it paged FORWARD from the log's head accumulating up to 25
  pages to find the tail, kept its own mirrored copy of the window to do
  it, re-seeded the handle from that copy (clobbering live appends), and
  its scroll-UP affordance loaded NEWER entries.

  The window is now `{ fromSeq?, toSeq?, limit? }` — one named
  `LogHistoryOptions` shared by the port, the harness, and the wire
  payload, so the shape cannot drift between them. Both bounds are
  inclusive and `limit` truncates **from the end the query anchored at**:
  declare a `fromSeq` and you get the first `limit` (forward paging,
  unchanged); declare none and you get the last `limit` at or below
  `toSeq`, defaulting to the log's tail. Rows always come back ascending
  by `seq`. Adapters implement the reverse slice once (`MemoryLog`,
  `timeline-fs`, `timeline-postgres` — `ORDER BY seq DESC LIMIT n`,
  re-ascended), which is why this belongs at the port rather than being
  re-solved per adapter; the conformance suite certifies it.

  Above it: `timeline/history` replies now carry the cursor that continues
  the direction asked in (`nextFromSeq` forward, `nextToSeq` backward), and
  `session.timeline.loadOlder()` is a TRUE tail-anchored backward pager —
  it opens on the log's newest page, walks down by `nextToSeq`, and splices
  each page at the head, so page two lands above page one and scroll-back
  needs no app-side mirror, re-seed, or re-sort. `hydrateTail(n)` is now
  one round-trip instead of a `ceil(N / page)` forward seek.

  BREAKING for callers that read a bare `{ limit: n }`: that used to mean
  the log's FIRST n and now means its LAST n. Forward paging declares its
  lower bound — `{ fromSeq: 0, limit: n }`.

## 1.0.0-next.18

### Minor Changes

- A progress token's stream now ends. `ProgressReporter.close()` sends
  `notifications/progress/complete` (token only — a bounded stream reaching
  its end is not a failure, which is why it is not
  `notifications/subscription/closed`); the client transport closes the
  matching stream on receipt, which ends the consumer's iterator and reaps
  the token's registration.

  Two bugs die with it: a client `handle.events()` loop no longer hangs on
  a `next()` that will never resolve, and a completed `session/send` no
  longer leaves its token in the transport's `progressStreams` map — the
  registration leak.

  The gateway's `session/send` arms the marker behind BOTH progress
  fan-outs (execution events and ADR 64 signals) draining, so it can never
  race the last pushed frame — and does it in a detached continuation, so
  the RPC response is not held behind a slow tail frame. Pinned by a
  no-drop test: a deliberately slow consumer still receives every frame,
  including the terminal `result`, because `MultiplexedStream` empties its
  buffer before signalling done.

- Spawn boundary events on the PARENT's stream. `spawn-start`
  (`spawnSessionId`, `spawnExecutionId`, `originCallId?`) and `spawn-end`
  (`spawnSessionId`, `isError`) bracket one `session.spawn({ send })`, so a
  spawn-tree UI can draw a live child node and attach it to the SPECIFIC
  tool call that asked for it. `originCallId` is the new
  `SpawnInput.originCallId` — passed as data off the dispatch ctx's
  `toolCallId`, because `spawn()` runs its operation on a fresh fiber that
  cannot observe the dispatch's ambient context (the same Promise-boundary
  reason `parentOpId` is threaded explicitly). The unbound spawn form emits
  neither event: it has no child execution the parent can name.

  RULED, and documented in the session README: a child's INTERIOR events
  stay on the child's own handle — nothing is bubbled from one handle onto
  another. `sequence` is a per-handle monotonic counter that durable replay
  keys on, and the wire fan-out is scoped to one execution's progress
  token; bubbling would either re-number foreign events or put a second
  session's events on another session's authorized token. To watch a
  child's interior, hold its handle. `StreamEventBase.spawnPath`'s
  docstring is corrected to say what it is (the emitter's lineage) rather
  than implying a bubbling channel.

  `StreamEventBase.parentExecutionId` and `RunExecutionInput.parentExecutionId`
  are DELETED. Both were declared and set by nothing, and with the boundary
  pair the edge they described is expressed once, from the parent side,
  alongside the origin call id — keeping them would be a second source of
  truth for the same fact. No consumer breaks: nothing populated or read
  either field.

- `ToolPresentation` crosses to the client. The four un-collapsed label
  materials (`name` / `title` / `summary` / `narration`) the tool executor
  already resolves at dispatch — `summary` being the author's
  `displaySummary` annotation resolved against the VALIDATED input — were
  computed and then thrown away on the wire path; `presentation` is now an
  optional field on `tool-dispatch-end` and `tool-dispatch`, threaded
  through `LoopExecutionEvent` and `buildOnEvent`. No new types, no second
  resolution site, and the framework still presumes no precedence — the
  client composes.

  Deliberately NOT on `tool-dispatch-start`, contrary to where the label is
  wanted first: resolution happens INSIDE the dispatch (it needs the
  validated input and the model's stripped narration), strictly after the
  start event is emitted. A slot there would be structurally
  always-undefined, and filling it would mean re-resolving off the raw
  declaration — a second, divergent path for the same fact. Pinned by a
  test asserting `tool-dispatch-start` carries no `presentation`.

- Result-level metadata now reaches the client on the tool-dispatch stream
  event. `ToolDispatchEvent.metadata` forwards `DispatchResult.metadata`
  verbatim — the loop projects the bag it is handed and never interprets
  it — which is what an MCP-Apps frame descriptor needs to reach a UI.

  The consuming side stopped dropping it. `mapCallToolResult` now folds an
  incoming `CallToolResult._meta` into `metadata.mcp.meta` — the SAME
  namespaced key the server-side result extensions project FROM, so a
  result-scoped payload reads identically whether agentick produced it or
  received it — and `withMCP`'s proxy handlers return the full mapped
  result instead of bare content blocks. Two fields the bare content
  mapping also silently dropped now survive with it: `structuredContent`,
  and `isError`, which means a consumed MCP tool's DOMAIN error no longer
  reaches the model wearing a success.

## 1.0.0-next.17

## 1.0.0-next.16

## 1.0.0-next.15

### Minor Changes

- ADR 93 D3 — skills + prompts join the definition grammar.
  `defineSkills({ store?, hydrate?, hooks?, guards? })` and
  `definePrompts({ ... })` — identity + brand, inert until per-session
  install, the D1 pattern verbatim. Source unification: the parallel
  source-config vocabulary is DELETED (moot #3) in favor of named
  hydrators — `hydrateFromDirectory(dir)`, `composeHydrators(...)`, and
  literal seeding — with the node-only directory loader split onto its
  own subpath so browser bundles stay clean; the package `./loaders`
  subpath is renamed `./hydrators`. Prompts gains `store?` (moot #4 — the
  withPrompts-lacks-store asymmetry dies). Genesis default for both is
  none/explicit; the three genesis laws are enforced and tested
  (seed-never-append, fork/spawn never re-runs genesis, a throwing
  hydrator fails session creation with typed `SkillsHydrateFailed` /
  `PromptsHydrateFailed`). `hydrate(ctx)` carries the typed store facet
  and trunk identity — `ctx.principal` is readable, the tiered-catalog
  seam. `createApp({ skills, prompts })` top-level slots land via the
  same augmentation + side-effect slot registration as timeline.

- Three follow-ups riding one slice. (1) The run-level `execution` summary
  event now EXISTS: the loop emits `kind: "execution"` (output, usage,
  stopReason, durationMs) after `execution-end` on any terminal carrying a
  result — exactly as the per-tick `"tick"` follows `"tick-end"` — and the
  session forwards it as the `type: "execution"` StreamEvent, which was
  declared in spec but had no producer anywhere. Adopters now get a
  per-execution duration, not just per-tick. (2) BREAKING: the superseded
  `session/timeline_history` gateway porcelain is DELETED — handler, spec
  `WireMethods` row, and the `SessionTimelineHistoryParams`/`Entry`/
  `Result` types (the `Entry.cursor` co-location affordance was never
  populated by anything and dies with it). `timeline/history` — the
  harness's own grant-gated declared read — is the one wire door; the
  bounded-tool-output hint now points there. (3) `LoopExecutorFactory`,
  `ToolExecutorFactory`, and `SessionHarnessFactory` all type `deps` as
  OPTIONAL, matching their implementations' documented local-substrate
  fallback (the `CompilerFactory` cure applied to its three twins) —
  dep-less construction is now reachable through the public types and
  pinned by tests in all three packages.

## 1.0.0-next.14

## 1.0.0-next.13

## 1.0.0-next.12

## 1.0.0-next.11

## 1.0.0-next.10

### Minor Changes

- ADR 92 Slice A residuals. Effect-native `fx` faces on the Resources +
  Prompts protocols (`ResourcesFx.read/list/listTemplates`,
  `PromptsFx.render`, derived via the existing `fxProxy` convention) let
  the MCP projection run harness reads on the crossing's fiber — wire
  identity now reaches resource resolvers and prompt render, closing ADR
  91's last starved-seam gap: every adopter handler seam (tool,
  completion, resolver, render) receives the request identity on the
  trunk. `runHarnessProtocolOn(runtime, effect)` joins the substrate.
  Transport-side admission-failure visibility: `gateway:admission:failed`
  event emitted on rejected ingress across http/ws/unix-socket
  (connection shape + failure class, never credential material — asserted
  in shared conformance), via a pure `onRejected` reporter callback on
  `authenticateIngress`.

## 1.0.0-next.9

## 1.0.0-next.8

### Minor Changes

- ADR 91 Phase 2 — the ctx spine feeds the starved seams. New
  `OperationCtx = RuntimeContext & Observability & Ops` (spec) as the
  canonical trunk+facets intersection. `ResourceResolver` /
  `TemplateResolver` gain `(uri, ctx?)`; `PromptDeclaration.render` gains
  `(args, ctx?)`; MCP `CompletionContext` extends `OperationCtx`;
  `TaskWorkContext` becomes `OperationCtx & TaskWorkVerbs` (a task body
  can now log/trace/run with its owning session's identity).
  `deriveContext` gains a boundary-extras parameter minting the whole
  composed context branded (descriptor-based composition preserves live
  getters); tool-executor and MCP context builders return
  `Derived<...>`. MCP: the auth pre-gate's verdict now carries the
  authenticated user (`AuthPreGateVerdict`), forwarded on
  `McpConnectionInfo.authenticatedUser` — the authenticator runs exactly
  once per initialize with function-form instructions.

## 1.0.0-next.7

### Minor Changes

- ADR 91 Phase 1 — the ctx spine. `RuntimeContext` (the pure-data trunk)
  moves from `@agentick/runtime` into `@agentick/spec` (augmentation of
  `RuntimeContextUser` retargets to `declare module "@agentick/spec"`).
  New `Derived<C>` brand + `deriveContext(parent?, facets)` in runtime —
  the single boundary-context constructor with lazy Observability/Ops
  facets. `ToolHandlerCtx` / `WireExtensionContext` extend the trunk
  (flat identity re-declarations removed); `StoreCtx` collapses to a
  literal `extends RuntimeContext`. Breaking rename:
  `WireExtensionContext.transport` → `wire`. MCP and tool-executor
  context construction routes through the deriver.

## 1.0.0-next.6

## 1.0.0-next.5

## 1.0.0-next.4

### Minor Changes

- The session-principal completion (ADR 48): principal stamped at
  creation (host door + wire door from the authenticated identity;
  params cannot set it), inherited by spawn/fork children, fork inherits
  the metadata bag, onSessionCreate gains a reshape arm, and
  SessionInstaller exposes principal + metadata at install. The
  same-principal wire target rule now engages on the stamped value.
  SessionRecord gains principal (durable stores should round-trip it).
  Plus MCP: RFC-9728 protected-resource metadata endpoint and the HTTP
  auth pre-gate (401 + WWW-Authenticate before SDK handling).

## 1.0.0-next.3

### Patch Changes

- Per-request ingress identity now reaches wire hook/middleware ctx
  (ctx.identity: IngressIdentity, riding EventScope like origin) and
  WireExtensionContext.identity carries the structured object beside the
  principal string — enabling adopter-space principal-override hooks on
  session-creating wire methods.

## 1.0.0-next.2

### Patch Changes

- Shared-server citizenship for the HTTP and WebSocket server transports:
  attached ({ httpServer }) transports now ignore non-matching requests
  and upgrades instead of 404ing/destroying them, so they coexist with
  the adopter's routes and other websocket consumers (e.g. socket.io) on
  one Node server. Owned ({ port }) behavior unchanged.
