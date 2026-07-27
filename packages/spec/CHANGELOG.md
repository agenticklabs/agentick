# @agentick/spec

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
