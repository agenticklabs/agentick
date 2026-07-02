# Agentick v2 — Implementation Status

**Branch:** `feat/v2`
**Last updated:** 2026-07-02 (late night) — **ADR 51 wave: state + knobs migrated (net −83 LOC); Effect-leak audit completed with a clean adopter-edge verdict.**

state (`set`/`delete`) and knobs (`set`/`register`/`dispatch`) are on declared commands — switches, message-type unions, and five hand-built Operation literals deleted; handlers are pure layer logic; wire shapes identical (all pre-existing tests untouched). This commit is what the wave is FOR: **94 insertions, 177 deletions.** The **Effect-leak audit** (grep-verified): every adopter edge is clean — `ctx.emit` void with `runFork` inside, adopter `ChannelHandle.publish` is Promise, `ExecutorStream` is dual-shape AsyncIterable, `tasks.submit` dual-overloaded, store ports Promise; the substrate trio (journal/bus/inbox) is Effect-typed BY DESIGN (the documented internal tier); the one genuine implementer-edge leak is the provider-executor subclass tier — already sentenced by ADR 52. Cosmetic debris removed (the two `_ImportGuard` exports dragging Effect into skills/prompts protocol files). Remaining wave sites carry greppable **`TODO(adr-51-wave)`** markers: session (9 verbs — the big one), prompts (4), skills (3), sandbox (5), mcp-client (6), reconciler-react (3); executor's 13 literals collapse inside the ADR 52 implementation. Full workspace 2792/2792.

**Previously, 2026-07-02 (night) — ADR 51 slice 4 LANDED: timeline migrates to declared commands; `compact` becomes an addressable verb. ADR 52 gains the modalities section.**

Slice 4: every timeline verb is a `this.command()` declaration (`append`/`queue`/`drain`/`replaceProjection`/`resetProjection`/`compact`); the five hand-built Operation literals and the entire `handleMessage` switch are deleted — inbox routing is served by the BaseHarness command registry with **unchanged message types + payload shapes** (the pre-existing inbox-routing tests pass untouched: the zero-behavior-change proof). `compact`'s exception is REMOVED, not enshrined: a bare `timeline:compact` verb from any origin runs the construction-bound default with optional advisory `instructions` as data; the explicit-arg form stays hand-built by doctrine (function input = unaddressable). New substrate primitive: **`BaseHarness.commandEffect()`** — fiber-preserving intra-harness nested-command invocation (drain→append keeps its parentOpId causality tree without crossing `Effect.runPromise`). 3 new tests (bare-verb-over-inbox with `origin: "wire"`, advisory instructions delivered to the resident strategy, six-verb enumeration); 308/308 + consumer suites green. Executor internal-ops migration deliberately **folded into ADR 52 implementation** (migrating ops into a class being collapsed is double work). ADR 52 also gained the **modalities section**: `embed`/`embedMany`/`transcribe`/`generateSpeech`/`generateImage` as optional adapter capability groups + standalone substrate-free helpers, capability-conditional conformance; `embed` lands with the ernesto persona port. **Next: slice 5** (dynamic wire resolver + Authorizer, ONE commit, gated on the verb matrix's `exposure` decisions) and ADR 52 implementation (before any provider work).

**Previously, 2026-07-02 (evening) — ADR 52 drafted + ratified: executors and model adapters — the split.**

The executor (harness — orchestration, opinion tier) splits from provider normalization (part — protocol tier). **ONE** reference `LanguageModelExecutor` owns all Effect machinery (stream pipeline, backpressure, abort, operations); providers become **`LanguageModelAdapter`s** — Promise/AsyncIterable-shaped objects implementing the existing subclass hook surface (`buildParams`/`call`/`openStream`/`mapChunk`/`reconstructRaw`/`normalize` + optional quirk hooks). Standalone use restored (`generate(openai("gpt-5", {apiKey}), input)` — the v1 OCR-service pattern, zero substrate); `createApp({ model: openai("gpt-5") })` quickstart sugar; adapter authors never see Effect (closes the implementer-audience leak); #103 resolved at the root (`define*` factories + subclass points deleted); the four factory files' substrate dance deleted. "Executor" = execution engine, not provider: ai-sdk gets both roles (`aiSdkModelAdapter(LanguageModelV2)` — inherits ai-sdk's whole provider catalog — plus a later `AiSdkExecutor` engine delegating with `stopWhen: stepCountIs(1)`, tools handed back to our tool executor). Guardrail: `LanguageModelInput`/`AdapterDelta`/`LanguageModelExecutionResult` are the ONLY currencies — no double normalization. BYOK (ADR 48 §5) becomes per-principal adapter instances. Packages rename `executor-<provider>-next` → `model-<provider>-next` in the pre-ship window; **Anthropic is written adapter-first — its pending subclass body is never completed** (the forcing deadline: ADR 52 implementation before any further provider work). Also answered: the `this.operation()` question — internal op construction is `this.command({ exposure: "internal" })` (ADR 51, already landed); executor internal ops migrate on the slice-4 wave; function-input ops (explicit-arg `compact(strategy)`) stay hand-built by doctrine.

**Previously, 2026-07-02 (later still) — A2.2 LANDED: open-or-rehydrate + flush barrier + default compact + idempotent createSession (ADR 49).**

Two commits. **(1) Durability wiring:** `SessionHarnessOptions.timeline { store, writePolicy, compact }` threads to the per-session `TimelineHarness` (flows from `createApp({ session: { timeline } })` via SessionDefaults — zero app changes); with a store injected, session construction **hydrates the persisted tier from the durable log before first render** (no store → resolved-promise hot path). `sendBody` awaits `timeline.flush()` at execution end — the ADR 49 barrier: send() resolution implies the store holds the execution; a buffered write failure rejects with the typed `TimelineWriteFailed` and lands the session on **"failed"** (latched past the `.finally`, never a silent "idle" against a diverged log). `TimelineHarnessOptions.compact` + `withTimeline({ store, writePolicy, compact })` — the construction-bound default that makes `compact()` no-arg (the ADR 51 signal form) real; explicit arg overrides (inner-scope-wins, in-process only); neither → typed `CompactStrategyMissing`. All three `TODO(A2.2)` markers resolved. **(2) Idempotent open:** `createSession({ sessionId })` with a live id returns the existing session — create IS resume (stateless replicas open by id blind); `SessionAlreadyExistsError` removed wholesale (class, channel union, spec docs, wire error-code case, codec conformance row — no deprecations). 7+1 new tests; 215 + 768 across affected suites; strict tsc clean. **Next per the ADR 51 slice plan:** slice 4 — timeline migration to `this.command()` declarations (now mechanical: registry landed, `compact` default landed → the bare `timeline:compact` verb becomes addressable), then the matrix-gated resolver+Authorizer (slice 5, one commit, never split).

**Previously, 2026-07-02 (later) — ADR 51 slices 1+2 LANDED: the command registry on `BaseHarness`.**

Spec: `CommandDescriptor`/`CommandExposure`/`CommandInfo` (`protocol/command.ts`), `OperationOrigin` + `EventScope.origin` (provenance — the second gate-stamped core identity dimension, twin of `principal`; the journal is now the authz audit log for the cost of one field), `MessageEnvelope(Input).origin`, `CommandDeclarationError`. Runtime: `BaseHarness.command()` — single declaration site; one canonical verb string = inbox message type = op-name root = authz scope label = future wire method name; declared non-internal verbs are inbox-addressable via one new step in the existing dispatch precedence chain (request-response → `onMessage` → **command registry** → `handleMessage` fallthrough) with Standard-Schema validation at the ONE site (reusing the existing `InvalidPayload`), gate-origin stamping, envelope-causality threading, and ask replies via the existing correlation contract; `commands()` + the `<surface>:commands` meta-verb are the declare-and-discover surface. Zero behavior change (no harness migrated yet — existing switches untouched). 12 new tests; runtime+spec 671/671; strict tsc clean across spec/runtime/timeline/gateway/app. **Deviation from ADR 51 §8 recorded in the commit:** `AuthError`/`PermissionDenied`/`PolicyRule` types land with their consuming slices (5/6), not ahead (no-dead-code rule). Next per the slice plan: A2.2 (hydration wiring + `withTimeline({ compact })`), then the timeline migration to declarations (slice 4, expected net-negative LOC), then the matrix-gated resolver+Authorizer (slice 5, one commit, never split). Also this session: the verdaccio local-registry proxy was fixed (verdaccio 6 sends a malformed `Accept: application/json;` that CodeArtifact 400s; per-uplink `headers.accept` override in nx-knowify `.verdaccio/config.yml`) — the pre-commit hook chain works again.

**Previously, 2026-07-02 — ADR 51 drafted: the harness invocation model + authorization architecture.**

ADR 51 (`blueprint/51-invocation-and-authorization.md`) formalizes the compact-over-wire arc: every harness is a network-addressable actor; commands are **verb + serializable data** ("do X now in/to/with Y") resolved against construction-bound config — executable configuration never travels (signal-form rule for function-param ops; advisory data like compaction `instructions` allowed, the resident strategy authoritative). **Command registry** on `BaseHarness` (`this.command()` single declaration site; one canonical verb string = inbox message type = op-name root = authz scope label = policy-rule target = wire method name; one new step in the existing dispatch precedence chain replaces per-harness `handleMessage` switches at negative LOC). Flat location-transparent addressing (`surface:scopeId` — identity, not topology). Wire projection via a **dynamic namespace resolver** on the sealed registry (explicit-beats-dynamic = porcelain-shadows-plumbing; no catch-all wire method; typed RPC via `WireMethods` module augmentation with types derived from the declaration's Standard Schema; `commands/list` discovery; existing 12 curated methods + extension namespaces untouched). **Two authorization subjects, two gates, one vocabulary:** identity authz (`Authorizer` port at wire dispatch; deny-by-default; same-principal target rule per ADR 48; hard constraint: the resolver ships WITH the gate, never before) and capability policy (`DispatchPolicy` port at tool dispatch; allow/deny/ask generalizing the existing confirmation gate with `confirmationAnnotationsPolicy()` as the zero-behavior-change default; claude.json-style layered **deny-wins narrowing** cascade — new `mergeNarrowing`, explicitly NOT `mergeLayered`; learned layer via `reply.always`; narrowing spawn inheritance). Trust domains name the fourth subject: **the model** — inside the process, intentionally untrusted. Provenance: `origin` joins `principal` as a core gate-stamped `EventScope` dimension; the journal (already the observability ledger, ADR 49) becomes the authz audit log for the cost of one field — Operation carries facts, never decisions. Six-change implementation (~330 LOC across spec/runtime/gateway/tool-executor/utils; harness packages migrate net-negative). Also this session: ADR 27 amendment (harnesses are the behavior, bindings are projections; verbs-not-configuration invariant) and ADR 48 §5 (the fusion rule: the session is where the work and identity axes fuse; the binding decision procedure; the #152 checkout-pattern mandate). Pending Ryan review (⛔).

**Previously, 2026-07-01 (later) — A2 landed: `TimelineStore` durability port (ADR 49) — store-backed persisted tier, write-behind + `flush()` barrier, typed failures. Plus a typed-error sweep (B1 slot collision + compaction failure).**

**A2 — `TimelineStore` durability (ADR 49) — LANDED.** The timeline persisted tier is now store-backed (ADR 49 "stores, not snapshots"). New `TimelineStore` append-log port (`timeline/src/store.ts`) — the flagship generalization of the `CredentialsStore` pattern, but the OTHER archetype: append-only event log (`load`/`append`/`sessions`/`delete`, optional `prune`, `backend`), no `replace` (rewriting the log would break event-sourcing). Bundled zero-dep `MemoryTimelineStore` default. Harness wiring: `TimelineHarnessOptions { store?, writePolicy? }`, a memory-authoritative **write-behind pump** with a `flush()` barrier (added to `TimelineHarnessProtocol`), `writePolicy: "through"` for zero-loss, and `hydrate()` (the resume path). Conformance suite `runTimelineStoreConformance`; the package's first README. **Typed-error correctness (the thread that ran through both B1 and A2):** store-write failures surface the existing registered `TimelineWriteFailed` AgentickError (write-through fails the op channel; write-behind latches + surfaces at `flush()`) — NOT raw `Error`/`orDie` defects. Same fix applied to `compact()`: an LLM-backed strategy failing is OPERATIONAL, so it now surfaces a real `CompactHandlerFailed` instance (was a plain `{_tag}` object + `orDie` defect). And B1's `registerNamespace` slot collision now throws the registered `GatewayBridgeSlotOccupied` (was a bare `Error`), asserted through the `gatewayReady` rejection path. **Deferred (`TODO(A2.2)`):** `createSession({ sessionId })` threading the store + calling `hydrate()` at init, loop-executor awaiting `flush()` at execution end, and the errored-status-transition + retry policy — the cross-package session/executor barrier wiring. Reference adapters (fs/sqlite/postgres) are follow-on packages; the port is locked.

**B1 — `GatewayExtension` (#254) — LANDED (reviewed + approved).** ADR 50 (`blueprint/50-gateway-extensions.md`) is implemented: `GatewayExtension { target: "gateway", install(GatewayInstaller) }` mirroring the existing pair; the installer ships `registerWireExtension` (third install path into the ADR 46 registry, pre-seal only), `registerNamespace` into a new `GatewayBridges` empty seed (occupied slot ⇒ **throw** — hard singleton), `subscribeBus`, `onClose`, and the `gateway` host handle. `ExtensionBundle { gateway?, app?, session?, wire? }` resolves #297: distributed by scope in `GatewayHarness` construction — gateway parts install now, wire parts register into the ADR 46 registry, app/session parts cascade to every `createApp`/`createSession` (composed BEFORE per-call). Wire registry seals in a `finally` after the install phase, so a throwing `install()` fails `createGateway` cleanly (no half-sealed registry). **Two design points decided in ADR 50's 2026-07-01 amendment:** (1) `interceptIngress` (the auth seam) is **deferred to ADR 34/#302**, which owns `IngressContext` + transport wiring — NOT shipped in B1; added later as a non-breaking `BaseInstaller` extension. (2) Gateway bridges are a hard singleton (no outer scope ⇒ duplicate = collision ⇒ throw); app-side `extensionBridges` stays **last-writer-wins** by design (sits under the cascade ⇒ duplicate = override). 19-test adversarial suite (`gateway/src/__tests__/gateway-extensions.spec.ts`). **Retro-driven cleanup folded in:** `subscribeBus` was hand-rolled with an `Effect.promise` fiber-killing defect (a throwing listener silently stopped all delivery) + a fiber leak on close — the fork-a-bus-subscription dance was triplicated across App/Session/Gateway installers and had already diverged. Extracted to `runtime/src/substrate/fork-bus-subscription.ts` (`forkBusSubscription`, canonical error-isolation + atomic teardown; sibling to `busAsyncIterator`), collapsing three call sites; 7 helper tests including the deterministic unsubscribe-stops-delivery pin (via `LocalEventBus.subscriberCount()`).

**ADR 49 — durability — DRAFTED (implementation pending; TimelineStore next).** ADR 49 (`blueprint/49-stores-not-snapshots.md`) pins the durability model: three state classes (A authoritative / B re-derivable / C ephemeral, declared per harness README); Class A durability via per-harness **store ports** generalizing `CredentialsStore`; `TimelineStore` is the flagship (persisted tier store-backed, projection tier derived-never-stored, memory-authoritative write-behind + `flush()` barrier at execution end, write-through opt-in, `createSession({ sessionId })` = idempotent open-or-rehydrate); journal reclassified as observability+idempotency ledger (L7 → TTL/LRU; `DurableJournal` stays the v2.x rung-(d) seam); snapshot demoted to spawn-seeding / opt-in Class-C hibernation / cluster warm hand-off; cluster failover = rehydration + execution leases. Reference adapters: `timeline-fs-next` (JSONL, local pole) + `timeline-postgres-next` (Knowify pole). Pending Ryan review (⛔ gate per CUT-PLAN); the store-port contract + `TimelineStore` is the next build (A2).

**Previously, 2026-07-01 — CUT-PLAN.md drafted: the work plan from Phase 5 to the v2.0 cut.**

Principal-engineer review session produced [`CUT-PLAN.md`](CUT-PLAN.md) — five workstreams sequenced to the v2.0 cut: (A) "Stores, not snapshots" durability model (ADR 49 to be written: state-class taxonomy authoritative/re-derivable/ephemeral, per-harness store ports generalizing the `CredentialsStore` pattern, `TimelineStore` flagship with fs + postgres reference adapters, journal reclassified as observability+idempotency ledger which reduces L7 to a TTL fix, snapshot demoted off the durability critical path, resume = load stores + re-render); (B) gateway completion for the multi-tenant distributed cluster mission (#254 gateway-extensions ADR first — it's the recurring blocker — then auth-at-the-edge principal extraction, wire-extension train #297→#298→#299→#313→#308, MCP slices, cluster failover-by-rehydration + execution leases, Redis fan-out validation against the Knowify Socket.IO-Redis workload); (C) v1 parity landing on gateway (connectors ADR + telegram/imessage ports, channels mapping, express adapter, sandbox providers, devtools, scheduler, terminal tools + continuation-policy hook); (D) `agentick` metapackage + two reference personas (local openclaw-style, cloud ernesto-shaped) with tentickle 100% migration as a cut gate; (E) Effect-containment charter + #103 consolidation + slot-collision guards + missing READMEs. Derived from a four-plane packages-next audit, a full transcript mine (796 user messages), a v1 gap inventory, and a read of the Knowify adopter code (ernesto + assistant-api `V1SessionStore`).

**Previously, 2026-06-30 (later) — ADR 46 drafted (#280 design): Wire extensions — extensible JSON-RPC namespaces on the Agentick client↔gateway wire.**

ADR 46 codifies how packages contribute to Agentick's wire protocol (the Agentick client↔gateway protocol; NOT to be confused with the MCP protocol that gateway-internal `McpClientHarness` speaks to external MCP servers — that's a separate layer). New `WireExtension` primitive: a namespaced bag of typed method handlers + notification declarations + auth metadata + cluster-routing hints. Registered with the gateway at construction; dispatched when matching JSON-RPC arrives. Two install paths to one registry — packages self-install via their `withX` composite (`withMCP` returns `{ session?, app?, gateway?, wire? }`), adopters use `createGateway({ wireExtensions: [...] })` for ad-hoc custom RPC. Built-in packages expose adopter-configurable hooks on their config (`withMCP({ hooks: { beforeReauthenticate, afterReauthenticate, filterClients } })`) — the package's wire handler bodies call hooks at lifecycle points, so adopters customize behavior without authoring raw RPC handlers. Capability discovery is non-optional: built-in `_extensions/list` method, `client.capabilities` populated at connect time, UI gates feature availability. Three locations per wire-aware package: type augmentation (shared between client + server builds via `declare module`), server-side `WireExtension` value (Node bundles), client-side helper library (React hooks / typed proxies, browser bundles). Cross-refs ADR 33 (Client + transports), ADR 32 (extension shape spectrum), ADR 27 (modular built-ins). Depends on #254 (gateway-extensions framework — still needs design). First canonical user lands #279 (MCP client wire projection) + #277d (React useMcpClients hook).

**Previously, 2026-06-30 — ADR 45 drafted (#284 design): Runtime context model — structural identity, propagated context, journal envelope.**

ADR 45 codifies the three-layer model for how identity + ambient state move through the framework: (1) auth-bearing resources encode principal in their CONSTRUCTION (`McpClientHarness` for user-42 ≠ user-43 — structural, not contextual), (2) `RuntimeContext` carries typed dimensions (sessionId/opId/correlationId/traceparent) PLUS an adopter-augmentable `RuntimeContextUser` slot (empty-seed module augmentation, mirrors `HookBridges`), (3) `Operation.scope` collapses into RuntimeContext (one source of truth — operations READ + ENRICH ambient context, don't carry their own scope field). The propagation primitive `runWithContext` writes to BOTH the Effect FiberRef AND an `AsyncLocalStorage` so `readContext()` works across plain async boundaries (post-`Effect.runSync`, callback-based libs, fetch chains). Tool handlers become dual-typed server-side — Promise OR Effect return — same convention as the kernel procedure layer. Client SDK stays Promise-only. Framework primitives NEVER trust adopter `ctx.user` for authorization; adopters can use it for telemetry/branching at their own risk. This unblocks #280 (wire extensions taxonomy needs settled context model), #289 (principal-bearing harness audit — structural identity rule), #290 (capture-replay sweep — residual after ALS coupling). #288 (narrow `RuntimeContext.request`) becomes the destructive prerequisite this ADR specifies the constructive replacement for. Driven by the #277b multi-tenant caveat (OAuth provider's `loadTokens` runs outside Effect → `readContext()` returns EMPTY_CONTEXT → multi-tenant key derivation silently broken).

**Previously, 2026-06-29 (later) — ADR 42 Slice 3 lands (#266): `Skills` + `Tasks` aliases + `withSkills` / `withPrompts` slot refresh.**

`spec-next` now exports `Skills` (= `SkillsHarnessProtocol`) + `Tasks` (= `TasksHarnessProtocol`) adopter-facing aliases, joining the existing `Prompts`. Each ships a matching `isSkillsInstance` / `isPromptsInstance` / `isTasksInstance` structural guard so adopters can discriminate slot forms without touching internal types. The previously-local `isPromptsInstance` inside `mcp/server/config.ts` is gone — single canonical guard now.

`withSkills` and `withPrompts` extension factories accept the trichotomic slot: array shorthand (sugar for `{ initial }`), instance shorthand (`Skills` / `Prompts` instance — adopter owns lifecycle, no per-session construction), or the full config object with a `use:` escape hatch mutually exclusive against `initial` / `loaders` (and `renderers` for prompts). `resolveSlot` is exported per package for adopter inspection. Per-package `slot-trichotomy.spec.ts` suites (10 skills, 11 prompts) verify every form.

`withTasks` is **intentionally exempt** from the trichotomy — the per-session `TasksHarness` is owned by `AppHarness` via the single-construction-site pattern (#159), not by this extension. Constructing another via the slot would collide on the inbox address. README §"About the trichotomy" calls out the exemption + the reason; the `Tasks` alias still lands for downstream code that takes a `Tasks` reference directly.

ADR 42 audit rows updated for skills / prompts / tasks; the trichotomy is a CONVENTION, not a religion — `withTasks` documents why it can't fit. Workspace tests 7173/7188 green; the 7 pre-existing flakes (packages/core v1 reactive-session, cluster-broker reconnect, SessionTree) are unchanged.

**Previously, 2026-06-29 — ADR 42 Slice 2 lands (#265): `Tools` alias + `mcp-next/server` `tools` slot refresh.**

`@agentick/spec-next` exports `export type Tools = ToolExecutorProtocol;` (adopter-facing noun alias) + a structural `isToolsInstance` guard. The mcp-next/server `tools` slot now accepts the trichotomy-aligned shape: `tools: CreatedTool[]` (array shorthand — server splits each into the registry + handler resolver) OR a config object with either inline `tools: CreatedTool[]` OR the low-level `{registry, resolveHandler}` escape hatch (mutually exclusive — `resolveToolsOption` xor-validates at construction time). Filter + transforms work the same on both. Per ADR 43 the handler receives the LIVE `McpRequestContext` (transport: "mcp", `mcp.*` nested) directly — no stub-ctx + no result-shape gymnastics; the spawn-time `normalizeTools` + `createStubHandlerCtx` shims that papered over the old single-shape slot are gone (dead code purged, "no production users" rule).

`spawn.ts` simplified to a pass-through (`SpawnStandaloneOptions extends McpServerOptions`) — the trichotomy at the harness layer absorbs every sugar previously bolted on at the spawn shim. 100/100 mcp tests + 9/9 new `tools-slot.spec.ts` green. Workspace typecheck clean.

Form B (a `Tools` / `ToolExecutorProtocol` instance via `use:`) and the `server.tools` getter remain deferred — blocked on `DispatchInput.ctxOverride` spec evolution because `ToolExecutor.dispatch` builds its OWN `ToolHandlerCtx` and would clobber the MCP `transport`/`mcp.*` discriminator fields. Adopters with an existing executor today can project its registry via the low-level escape hatch. ADR 42 audit row updated; Slice 2 marked ✅ landed.

**Previously, 2026-06-28 (later still) — ADR 40 lands: MCP server harness shape resolved.** Closes the open §"Server-side: shape is OPEN" question from ADR 23. Decisions: Shape 1 harness at gateway scope (NOT session); one package with standalone-process + gateway-extension modes; multiple servers per process; declarative object config; per-connection filters + transforms (NOT per-server pre-baked); security pipeline ported verbatim from v1 (5 named stages); OAuth 2.1 spec-aligned (RS by default, optional embedded AS); internal agents use direct projection (`mcp://gateway/<name>` URL form). Resources defer until #123 lands — additive without shape changes.

v1 audit (20k LOC `packages/mcp/`) catalogued for porting: security stages (`bearerTokenAuth`, `roleBasedAuthz`, `slidingWindowLimiter`, `allowListGuard`), `SamplingAPIImpl.structured()` retry loop, `ElicitationAPIImpl` flat-schema validation, roots path safety, completion builders. Tool transforms (rename / prefix / restrictInput / wrapHandler / alias) are net-new — landing as `@agentick/tool-next/transforms` (#171a) because they're useful beyond the MCP server.

First batch of #171 implementation tasks filed: #171a (transforms), #171b (skeleton + spec types), #171c (stdio + tools projection + security pipeline MVP). Total estimated effort ~16 days across 9 subtasks per ADR 40 rollout plan.

**Previously, 2026-06-28 (earlier) — Skills + Prompts loaders gain `reload()` + lookup-on-miss.** Both harnesses now retain their configured loaders and expose:

- `session.skills.reload({ pruneMissing? })` / `session.prompts.reload({ pruneMissing? })` — re-walk loaders, diff against current state, apply adds + updates (+ optional removes).
- `session.skills.resolve(name)` — async lookup-on-miss read.
- `session.prompts.resolve(name)` — same, plus `invoke()` / `get()` transparently call `resolve` on cache miss before throwing `PromptNotFound`.

`Loader<T>` (in `@agentick/utils-next/loaders`) gains optional `lookup(name): Promise<T | null>` for fast-path resolution; built-in `fromX` factories implement it. Loaders without `lookup` fall back to `load()` + filter on the harness side — same correctness, worse perf. 19 dynamic-surface tests across the two packages bring the total to 98/98 (skills + prompts + prompts-react).

**Previously, 2026-06-28 (earlier) — Skills loaders (#246) + Prompts loaders (#247) close. `withSkills({ loaders })` and `withPrompts({ loaders })` accept the harness-shaped `SkillLoader[]` / `PromptLoader[]`. Subpaths: `@agentick/skills-next/loaders` + `/loaders/node`; `@agentick/prompts-next/loaders`. Composed from the loaders primitive layer in `@agentick/utils-next/loaders{,/node}`.**

Skill loaders are uniform (`fromArray` / `fromUrl` / `fromManifest` / `fromFile` / `fromDirectory`) because `Skill.content: string` carries no functions — every source is sound. Frontmatter parsing defaults to a minimal `key: value` (with quoted strings + inline arrays); adopters override `parseFrontmatter` for full YAML / TOML to avoid pulling a dep at the framework level.

Prompt loaders are intentionally narrower (`fromArray` / `fromModule` / `fromStaticUrl`) because `render(args)` is a function: `fromStaticUrl` enforces at load time that no loaded prompt names a `render` field, with a helpful error pointing adopters toward `fromModule` for dynamic prompts. No `fromDirectory` here — JSX `.tsx` on disk needs a bundler, which is a framework-binding concern.

31 loader tests green (19 skills + 12 prompts) on top of the existing 29 harness tests for these two packages.

**Previously, 2026-06-28 — Native foundation #5 closed: `@agentick/prompts-next` (core, Shape 1 harness) + `@agentick/prompts-react-next` (React binding) ship.**

Prompts harness mirrors MCP `prompts/*` shape (so #171 server projection is a passthrough). `PromptDeclaration { name, description, arguments?, template?, render?(args) }`; Standard-Schema arg validation; `register/update/remove/get/invoke + subscribe/subscribeAll` surface; `invoke` queues messages onto the timeline via `bridges.timeline.queue`. Snapshot/restore carries names + args + description (template/render are non-serializable; adopters re-seed via `withPrompts({ initial })`).

Content shapes: core handles `string` (→ single `system` MessageEntry) and `MessageEntry[]` (passthrough) natively. Anything else flows through a registered `PromptRenderer { name, handles(content), render(content, args) }`. The React binding exposes `reactPromptRenderer` — compiles `ReactNode` via `compileTemplate` and projects context entries: `<message>` → passthrough, sections + loose content → buffered system message (explicit messages flush the buffer; section titles render as a leading `# title` text block). Cross-framework adopters do `withPrompts({ renderers: [reactPromptRenderer, angularPromptRenderer, ...] })`; single-framework adopters use the `withReactPrompts` sugar.

29 tests across the two packages green (17 in prompts-next, 12 in prompts-react-next). Typecheck clean for both. Open: prompt loaders (#247 — `withPrompts({ loaders: [fromArray, fromUrl, fromModule] })`) deferred to a follow-up commit; MCP server projection (#171) deferred to the server harness work.

**Previously, 2026-06-28 (later) — `renderTemplate` + `compileTemplate` ship on `@agentick/reconciler-react-next`; `formatTree` + per-formatter framing ship on `@agentick/formatters-next`; harness `renderToString` migrated to delegate.**

The capability that came out of the ADR 39 compiler-experiment post-mortem: use the existing reconciler infrastructure (compile-until-stable loop, collect walker, `useData` semantics) as a one-shot template renderer without spinning up a session / harness / journal / operation wrap. Two entry points:

- `compileTemplate(element, opts) → { tree, diagnostics, iterations }` — JSX → `RenderedTree` IR
- `renderTemplate(element, opts) → { output, diagnostics, iterations }` — JSX → formatted string via `formatTree`

For static-template use cases: prompt rendering, MCP server prompts / resources (#171), tool descriptions, skill content (`@agentick/skills-next`), snapshot tests, doc generators. Reactive workloads (knobs, `<Tool>` factories, session state, channels) continue through `createApp` + full `ReconcilerHarness`.

`formatTree(tree, defaultFormatter, opts?)` lives in `@agentick/formatters-next`. `DefinedFormatter` gained three optional tree-level serialization methods (`frameSection`, `frameMessage`, `blocksToText`) — each formatter owns its own section/message framing and block-flatten rules; 3rd-party formatters supply theirs for full control or fall back to markdown-flavored defaults.

The reconciler harness's inline `serializeTreeToString` (~190 LOC, marked "Phase 4a pending" since 2026-05) is gone; `renderToStringBody` delegates to `formatTree`. Two modes preserved exactly: per-entry `renderedWith` honored when caller doesn't pin a formatter; caller-pinned formatter overrides everything.

Test pinning: `render-to-string.spec.tsx` (13), `formatter-registry.spec.tsx` (3), `formatter-scope.spec.tsx` (10) — all green after the swap. Full v2 suite at 178 files / 1944 tests; reconciler-react gained 15 new template tests.

**Open follow-ups tracked in tasks:**

- MCP server harness (#171) — when it lands, prompt/resource bodies should use `renderTemplate`
- Prompts loaders (#247) — `withPrompts({ loaders })` for filesystem/url-backed libraries
- Skills loaders (#246) — same shape for `@agentick/skills-next`

**Previously, 2026-06-28 — ADR 39 compiler experiment archived; reverted to `a15807362` (eval-next iter 2).** Phases 1, 1b, and 3 of the JSX-template-walker work (introduce `@agentick/compiler-next` + `@agentick/compiler-react-next` as a parallel walker, then migrate the reconciler over) are reverted as a discarded experiment. The reconciler's existing `collect/` walker already does what the compiler walker did — including compile-until-stable, formatter scope (HostScope), and contributor extensibility. The parallel implementation was unjustified duplication; no real consumer ever materialized outside the new packages' own tests.

**Archived for reference:** `git tag archive/compiler-phase-3-experiment` preserves the full 16-commit experiment tree (Phase 1 + 1b + 3 substeps 1a–3b). Recover with `git reset --hard archive/compiler-phase-3-experiment` if direction changes.

**What carried forward as small follow-up commits on `feat/v2`:**

- `2a898c76` `feat(session-next): track reasoning + cached + cache-creation token usage` — unrelated bug-class improvement that landed alongside the experiment; isolated and preserved
- `e91e9424` `feat(utils-next): isThenable — duck-typed PromiseLike predicate` — generic utility carved out of the experiment; useful broadly

**Lessons that carry forward as practice (not yet ported to code, tracked):**

- Diagnostic-channel pattern — every silent-drop path in the walker (media missing source, malformed event blocks, etc.) should emit a stable-coded `FormatDiagnostic` rather than discarding the JSX node. Worth porting to `reconciler/collect/contributors/*.ts`.
- Three of the five "declaration" JSX intrinsics shipped in v1 have **no runtime consumer**: `<output>` (entirely stubbed), `<mcp>` (replaced by `withMCP({...})` extension), `<resource>` (resource runtime is pending — #123). `<tool>` is half-wired: the layered-tools work (#137) explicitly dropped the executor's `tree.declarations.tools` dependency. The "JSX intrinsic produces an IR field" model is legacy from v1; v2's "extension factories + layered options" superseded most of it without retiring the JSX intrinsics. Worth a deliberate cleanup pass.
- The `RuntimeDeclarations.mcp` singular field name is misleading — it's a plural array. `mcpServers` would read better. Small spec PR if desired.
- Structured outputs (`<output>` / `responseFormat` / "terminal tool") is an unresolved design question, not a feature. Three candidate models, none implemented end-to-end. Worth a dedicated ADR before any more code lands.

**Meta-lesson:** Audit existing code paths before extracting new packages or layers. The compiler walker duplicated the reconciler's render-until-stable + collect walker; the audit takes minutes and would have caught this at Phase 1 scope time.

**Branch state restored to:**

- 177 test files / 1925 tests green (matches pre-experiment baseline)
- Workspace typecheck clean modulo pre-existing v2-real handler-signature drift (`example/v2-real/src/agent.tsx:30` — long-standing, unrelated to revert)
- Origin/feat/v2 is at `9f77ea9c` and is behind local feat/v2 by 16 commits — non-force push to origin is safe

---

**Previously, 2026-06-26 (eval-next MVP shipped) — `@agentick/eval-next` iteration 1 lands.** `defineEval(definition)` returns a callable function; `await myEval()` runs with definition defaults, `await myEval({ executor: X })` overrides any `createApp` slot for one invocation. Iteration-1 surface: `t.send/completed/calledTool/notCalledTool/noFailedActions`. Two subpaths: base (reconciler-agnostic) + `/react` (defaults reconciler to `reactReconciler()`). 8/8 tests pass.

Substrate-level groundwork: `BaseHarness.runOperation` now stamps `op.input` as the `requested` envelope's payload — the blueprint's phase contract pins requested as "argument bound"; previously the field was empty, so eval ledgers had to find the input some other way. With this change, ANY subscriber (eval, OTel exporter, replay harness) sees what was invoked alongside the operation envelope. Verified non-breaking across the v2 workspace (1909/1909 tests).

Eval-next iteration roadmap (deferred): `.matrix(axes)` parameter sweeps, `t.judge(rubric)` LLM-as-judge, tool stubs, fixtures/cassette replay, cost accounting, streaming-event assertions. See [ADR 37](blueprint/37-eval-package-sketch.md) for the sketch.

---

**Previously, 2026-06-26 (Phase 5 closed) — Phase 5 — cluster fusion: `defineXCluster + createApp/createGateway` now actually does something.** Six commits land:

1. **5b — nodeId auto-default**: `defaultNodeId()` / `resolveNodeId()` in `@agentick/cluster-next`. Adopter calls collapse to `defineUnixCluster({ socketPath: "..." })` — no nodeId arg required; falls back to `${hostname}:${pid}` with a `cluster:nodeId:auto-defaulted` diagnostic, OR a `cluster:nodeId:suspicious` warning if hostname is empty/"localhost" (the container-without-HOSTNAME footgun that would otherwise silently corrupt cluster routing). Strict guard at the public-API boundary (`defineXCluster` / `joinXCluster`); internal `XClusterNodeOptions.nodeId` stays required.

2. **5c (app)** — `createApp({ cluster: ClusterFactory })` resolves the factory at construction against a synthesized `ClusterParent`, swaps the substrate to the wrapped versions, and registers cluster close as part of `app.closeApp()`. Substrate factories incompatible with `cluster` (can't resolve factories without the parent shell they'd be constructing) — clear error if mixed. `AppHarness.addInternalCloseHandler(h)` is the new internal slot.

3. **5c (gateway)** — `createGateway({ cluster })` same pattern. Apps spawned via `gateway.createApp(...)` inherit the cluster-wrapped substrate automatically via the existing `bus = input.bus ?? this.bus` default chain. Gateway-owned cluster is THE cluster for all spawned apps — no per-app cluster option, no "precedence" code path needed. `closeGateway()` closes all apps first, then the cluster, then super.close().

4. **defineLocalCluster** — the "fifth wire" testing factory. In-memory ClusterFactory backed by `LocalClusterRegistry`. Optional registry arg (auto-creates for single-node tests; explicit for multi-node simulation). Lives in `@agentick/cluster-next/testing`.

5. **trackPendingAck bug fix** — surfaced via the v2-otto-cluster demo. `subscribeBus`/`subscribeInbox` called before client handshake completes was orphaning the flush()'s Promise; idempotent track preserves the original Promise across the onWelcome re-subscribe loop.

6. **joinXCluster facades** (Phase 4f.7) — `joinUnixCluster`/`joinTcpCluster`/`joinWsCluster`/`joinRedisCluster`. Side-channel cluster wiring for coordination outside the agent loop (proof: `example/v2-otto-cluster` worker went from 148 → 75 LOC). Shared facade builder `makeClusterNode` in `@agentick/cluster-next` hosts the bus / membership.waitForPeers / lifecycle plumbing wire-agnostically.

**ADR 38 — Cluster lifecycle + ownership rules** pins the contract:

- Pattern A (defineXCluster + createApp/createGateway) → framework owns lifecycle
- Pattern B (joinXCluster) → caller owns lifecycle
- One cluster per process (multi-app = gateway-level wiring)
- Cluster requires substrate INSTANCES, not factories
- The `{kind: "unix" | "tcp" | ...}` config form was considered and rejected — runtime missing-package crashes + dynamic-import smell

**ADR 37** sketched the future `@agentick/eval-next` package (testing-shaped framework for evaluating agents/models/tools). Not implementing now.

**Workspace test status**: cluster + app + gateway suites at 281/281. Full v2 workspace remains green at the previous Phase 4 count + Phase 5 additions.

**Deferred to Phase 6+**:

- Real-Redis conformance via docker-compose
- Double-wrap detection (brand cluster-wrapped substrates so a second wrap can refuse)
- Per-app clusters under a gateway (hybrid topologies — drop to `joinXCluster` today)
- Cluster swap mid-flight
- Conformance suite parameterized over all four wires for the integration path
- `@agentick/eval-next` iterations 2+ (matrix sweeps, judge, fixtures, cassette replay, cost accounting)

**Phase 5 closed.** Cluster machinery is now consumed by app/gateway. The "build it once, configure ergonomically" loop is complete; what remains is hardening + real-world adoption signal.

---

**Previously, 2026-06-26 (Phase 4 closed) — Cluster Phase 4f–4g — production-ready cluster wire stack across all four packages.** Eight commits land:

1. **4f.1 — strict-typecheck sweep**: 9 v2 packages had silently regressed `tsconfig.json` since a 2026-06-12 fix; restored across spec, utils, pubsub, tasks, cluster, cluster-broker, cluster-net, cluster-ws, cluster-redis. Surfaced months of accumulated test-fixture drift (deleted obsolete tests for removed features; updated tests for shape-changed types). Fixed a latent `Factory<R, P>` type-soundness bug where `R | Promise<R> | Effect<R, never, never>` was collapsing to `unknown` in TS inference.

2. **4f.2 — DRY consolidation**: extracted `startBroker` / `createClusterNode` / `defineWireCluster` from the three near-identical wire packages into `cluster-broker-next/wire-helpers.ts`. Per-wire LOC dropped ~30%; future wires (Redis, future custom) reuse the helpers transparently.

3. **omitUndefined sweep**: shipped `@agentick/utils-next/omitUndefined` and mechanically swept ~780 instances of `...(X.Y !== undefined ? { Y: X.Y } : {})` across packages-next/. Restricted to pure-forwarding (backreference-enforced LHS = value); thunk-value patterns (`codec: () => opts.codec!`) intentionally untouched (collapsing them would change semantics). Multi-line variants normalized via two-pass perl.

4. **4f.3 — internal re-election (Unix)**: `electableUnixClusterNode` wraps `unixClusterNode` with a diagnostic-event watcher. After K consecutive connect-failed events (default 5), surviving workers race to bind the vacated socket via `tryBindOrConnectUnix`; winner spins up a local `BaseBroker` adopting the bound server. Single-host broker failover without external supervisor restart. TCP/WS multi-host re-election explicitly out of scope (cross-host consensus = wrong fit; use Redis Sentinel via cluster-redis-next).

5. **4f.4 — backpressure**: per-connection `BoundedWriteQueue<BrokerFrame>` (default 1024 frames). All broker → client writes go through queue.enqueue (sync); per-conn background drain. Slow client no longer blocks fan-out; broker memory bounded under sustained slow-consumer stress. Drop-oldest overflow + `cluster:broker:server:backpressure-drop` diagnostic.

6. **4f.5 — BrokerCodec wrapper**: centralized the `as unknown as MessageEnvelope` cast (from Phase 4e) into one adapter in `cluster-broker-next/broker-codec.ts`. `BaseBroker` + `BaseClusterClient` now hold a typed `BrokerCodec` internally; adopter-facing `ClusterCodec` is unchanged. Phase 5+ msgpack/protobuf codecs implement `BrokerCodec` directly.

7. **4f.6 — graceful broker shutdown**: `BoundedWriteQueue.flush(timeoutMs = 5000)` waits for pending frames to drain. `BaseBroker.close()` enqueues FRAME_GOODBYE to every client, awaits parallel flush, then tears down listener. Fixes a regression Phase 4f.4 introduced (writeFrame became sync; Goodbye was fire-and-forget). Aligns with k8s SIGTERM grace period defaults.

8. **4g.1–4g.4 — `@agentick/cluster-redis-next` lands**: the production multi-host story. `createRedisTransport` (pub/sub channels `agentick:bus` + `agentick:inbox:<nodeId>`, two ioredis conns per node) + `createRedisMembership` (SET + per-node TTL keys, 10s heartbeat / 30s TTL / 5s poll defaults) + `redisClusterNode` / `defineRedisCluster` factories. Adopter passes ioredis clients (peer dep); the package is RESP-protocol-compatible (Redis, Valkey, KeyDB, Dragonfly, all cloud managed). 5 integration tests against a fake-Redis hub verify round-trip + broadcast + filter narrowing + membership snapshot + graceful leave. Symmetric — no broker/client role; Redis IS the broker.

**ADR 35 (cluster-protocol)** gains a §10 "Deployment tiers" section that documents the honest tier matrix: dev (none) / single-host (Unix + electable) / multi-host (Redis) / edge (TCP-WS + external supervisor). The "use Redis for multi-host" recommendation is explicit; our broker is for single-host or specialized edge.

**TODO sweep**: retired three resolved phase-4 TODOs (BrokerCodec, per-conn backpressure, listener consolidation). Remaining TODOs catalog deferred concerns to Phase 5+ (codec routing through cluster-next layer, partitioning rebalance on topology change, per-event broadcast FIFO, validator tightening).

**Workspace test status**: 1854+ tests across all cluster packages pass. Strict typecheck clean across 66/66 v2 packages.

**Deferred to Phase 5+** (explicit, ADR-documented):

- Real-Redis conformance via docker-compose (fake-Redis integration ships now; real-Redis is an infra task).
- 3-replica Otto cluster demo (the end-to-end deploy proof point; needs docker-compose infra).
- `createGateway({ cluster })` fusion (Phase 5 ergonomic win).
- DurableJournal adapter (Redis Streams).
- Real adopter signal-driven hardening (compression, TLS shorthand for wsBroker standalone-port, partitioning.onMembershipChange hook).

**Phase 4 closed.** The multi-host production story is shipped; the single-host story has automatic failover; the broker is backpressure-aware and graceful on shutdown. Next: Phase 5 begins with `createGateway` cluster-config fusion.

---

**Previously, 2026-06-25 (Phase 4e) — Cluster Phase 4e — `@agentick/cluster-ws-next` lands. WebSocket wire shipped + uncovered + fixed a latent ClusterCodec type-soundness bug across the cluster build graph.** 16/16 cluster-ws tests green; 148/148 across all four cluster packages. The package mirrors cluster-net's shape (transport + membership multiplexed over one connection, broker mounted standalone OR on adopter's `http.Server`) but uses WebSocket-native message boundaries instead of length-prefix framing. Subprotocol negotiation (`agentick-cluster-v1`) provides forward-compatible versioning; `allowedOrigins` policy rejects unauthorized browser clients; path-prefix routing keeps cluster upgrades from conflicting with adopter HTTP handlers. Verified by 6 WS-specific tests on top of the conformance suite: subprotocol rejection of mismatched clients (×2), mount-coexists-with-other-handlers (×2), origin policy enforcement (×1), connector connect-timeout (×1).

**The uncovered bug:** Building cluster-ws against the cluster build graph surfaced a long-standing type-soundness violation in `packages-next/cluster/src/define.ts` — `resolveFactoryAsync<R, P>(factory: (parent: P) => R | Promise<R> | unknown, ...)` collapsed to `unknown` in TS inference. Every `transport`/`membership`/`partitioning`/`journal`/`codec` resolved-to-unknown, downstream assignments cast through implicit-any. The cluster package's `tsconfig.json` has `"include": []` and references `tsconfig.build.json`, so `pnpm typecheck` (running `tsc -p tsconfig.json --noEmit`) was checking NOTHING — the typecheck script was a silent no-op against the cluster source. Fixed by narrowing the factory's return-type to the documented `R | Promise<R> | Effect.Effect<R, never, never>` union. Once R was correctly inferred, two more cascading errors surfaced in cluster-broker (`writeFrame` passing `BrokerFrame` to a `ClusterCodec.encode` typed for envelopes only — TODOs added documenting the codec-shape gap; cast at boundary is the temporary bridge). A new `createJsonCodec()` synchronous helper was added so wire impls (cluster-net, cluster-ws) can construct the default codec directly instead of invoking `jsonCodec()({} as never)` which returned the factory union.

**Architectural follow-ups documented in-code (TODOs):**

- `phase-4f`: `ClusterCodec` is typed for envelopes only at cluster-next layer; broker frames (Hello/Welcome/Subscribe/SubscribeAck/Membership) piggyback the same codec — JSON tolerates anything; msgpack/protobuf would need broker-specific schema. Cast at boundary documented in `base-broker.ts:writeFrame` and `base-cluster-client.ts:writeFrameRaw`. Follow-up: introduce a `BrokerCodec` that wraps `ClusterCodec` + handles broker frame schema separately.
- `phase-4e-followup`: TCP/Unix/WS listener/connector/cluster modules now follow a near-identical shape across cluster-net + cluster-ws. After Phase 4f Otto demo proves adopter ergonomics, consider a shared `cluster-wire-base-next` package — TODO documented at top of `ws-listener.ts`.
- **Strict-typecheck gap in cluster-next:** `tsconfig.json` has `"include": []` so `pnpm typecheck` runs a no-op. This is a violation of the strict-typecheck memory rule. Phase 4f cleanup should fix the include to `["src"]` so spec drift gets caught at `pnpm typecheck` time, not at downstream build time.

**Workspace:** 148/148 across all four cluster packages — 25 cluster-wrappers + 10 cluster local-conformance + 31 cluster-broker conformance + 14 cluster-net verification + 10 TCP conformance + 10 Unix conformance + 7 Unix stale-cleanup + 10 WS conformance + 6 WS verification. New: `@agentick/cluster-ws-next` (`ws-connection.ts`, `ws-shared.ts`, `ws-listener.ts`, `ws-connector.ts`, `ws-cluster.ts`, README, conformance + verification specs). Workspace registrations updated (typedoc + vitepress).

**Next:** Phase 4f — Otto cluster demo. Real multi-process scenario validating TCP + Unix + WS wires end-to-end with adopter-shape API. Followed by the wire-base DRY consolidation if adopter signal supports it.

**Previously, 2026-06-25 (later still) — Cluster Phase 3.2 — safety pass: Effect.async cancel, wire validation, namespace enforcement, InboxError round-trip, spec-evolution-safe guards.** Closes the load-bearing gaps the Phase 3.1 retrospective surfaced. Eight items:

1. **`Effect.async` cancel hook in `askRemote`.** Returns `Effect.sync(() => { ... })` from the register callback. On caller-interrupt (`Fiber.interrupt`, scope close, etc.) the hook fires: clear the timeoutHandle, delete from pendingAsks, emit `cluster:ask:interrupted`. Pre-3.2, interrupted asks orphaned the Map entry + timer until the timeout naturally fired — under load that's one leak per interrupt.

2. **Wire payload validation at the cluster boundary.** New `isClusterAskRequestPayload` / `isClusterAskResponsePayload` runtime validators in `internal-wire.ts`. `handleInboundAskRequest` rejects malformed requests with `cluster:ask:invalid-payload` (drops envelope; doesn't feed garbage into `local.ask`). `handleInboundAskResponse` validates before resolving the pending Deferred — pre-3.2 a wire-corrupted or attacker-controlled response could deliver a value typed as `R` without any check.

3. **`@cluster/` namespace enforcement.** `ClusterInbox.register` rejects `address.startsWith("@cluster/")` with `RoutingFailed`. `send` and `ask` reject both reserved addresses AND reserved message types. Pre-3.2 the namespace was documented as reserved but not enforced — an attacker (or careless adopter) could register a handler at `@cluster/asks:node-X` to intercept ask responses, or send a forged `@cluster/ask-response` envelope to resolve a pending Deferred with attacker-controlled data.

4. **InboxError round-trip fidelity.** `ClusterAskResponsePayload` now discriminates `handler-fail` vs `routing-fail`. `causeToAskFailure` recognizes both `MessageHandlerError` AND `InboxError` separately and ships the correct tag. Asker reconstructs the typed error with the original `_tag` preserved (`AddressNotFound`, `RoutingFailed`, `InboxClosed`, `AskTimeout` all round-trip). Pre-3.2 only `MessageHandlerError` was preserved; `InboxError` from remote `local.ask` collapsed into a synthesized `HandlerError` wrapping the original — caller couldn't distinguish "remote handler failed" from "remote inbox was unreachable."

5. **Membership-partitioning integration test.** New end-to-end test wires a live-mutable `membership.nodes()` and verifies `ownerOf` observes new nodes after a topology join. Sweeps 100 addresses to statistically prove rebalance. Pre-3.2 the membership-reactivity test only proved bus event emission while the mocked `nodes()` returned a static list — partitioning behavior under topology change was one spot-check away from regression.

6. **Diagnostic event coverage.** Pinned tests for `cluster:ask:dispatched`, `cluster:ask:resolved`, `cluster:ask:timeout` (real handler-stuck timeout, not no-handler proxy), `cluster:ask:response-orphaned` (forged response envelope), `cluster:ask:invalid-payload`, `cluster:ask:interrupted`, `cluster:transport:broadcast:failed`, `cluster:event:malformed`. Pre-3.2 only `cluster:transport:send:failed` and `cluster:routing:address-not-found` had tests — "Every claim needs a test" memory rule violated. Now every documented diagnostic has a verifying test.

7. **Spec-evolution-safe type guards.** `isMessageHandlerError` / `isInboxError` use `Record<TagUnion, true>` initializers — the TypeScript compiler enforces that the Record covers every tag in the union. If spec adds a tag to `MessageHandlerError`, the initializer fails to compile until the guard is updated. Pre-3.2 the guard was hand-rolled (`tag === "HandlerError" || tag === "InvalidPayload"`); a new spec tag would silently downgrade to a synthesized `HandlerError` defect path. Same pattern for `InboxError`.

8. **`ClusterEventBus.onRemoteEvent` shape validation.** `isValidProtocolEvent` minimum shape check (`id`/`surface`/`name`/`phase`/`timestamp`/`scope`) before `local.append`. Garbage from a misbehaving transport adapter emits `cluster:event:malformed` and drops; pre-3.2 it would corrupt the ring buffer.

**Bonus:** Replaced hand-rolled `typeof value !== "object" || value === null` checks throughout with `isObject` from `@agentick/utils-next`. The predicates package owns the canonical type guards; cluster wrappers consume them instead of re-rolling. Caught by user mid-implementation.

**`@agentick/pubsub-next` audit:** Checked all pub-sub-shaped code in the cluster package. (a) `pendingAsks` is one-shot Deferred-by-correlation — not pub-sub. (b) `DiagnosticEmitter` publishes through the canonical `EventBus`. (c) `LocalClusterRegistry` (testing fixture only) has filter-aware fan-out — `KeyedNotifier` doesn't model subscription-side filters, so refactoring would restructure the registry/transport boundary rather than simplify it. No production pub-sub hand-rolls; the registry's pattern is the right primitive for its filter contract.

**Workspace:** 57/57 across cluster-next (12 new tests added in Phase 3.2: namespace enforcement × 4, caller-interrupt cleanup × 1, wire validation × 1, bus shape validation × 1, membership-partitioning × 1, ask lifecycle diagnostics × 3, broadcast failure × 1). Typecheck + oxlint + oxfmt clean.

**Phase 3 retrospectives → 3.1 → 3.2 closed the load-bearing gaps surfaced by each iteration.** The cluster package is now ready for Phase 4 adapters to depend on: cross-node ask works with full typed-error fidelity, interrupt-safe, payload-validated, namespace-enforced; every documented diagnostic is test-pinned; spec evolution is compiler-caught; bus inbound is shape-guarded.

**Next:** Phase 4 — `@agentick/cluster-ipc-next`. First real adapter; cross-runtime broker over Unix socket / TCP localhost. With Phase 3.2's wire-validation contract and diagnostic surface in place, the adapter has a clear safety bar.

**Previously, 2026-06-25 (later) — Cluster Phase 3.1 — cross-node `ask` + membership reactivity + transport diagnostics + loud routing.** Closes the load-bearing gaps the Phase 3 retrospective surfaced. Six parts:

1. **`ulid` moved from runtime-next to utils-next.** The cluster wrappers (and future cross-cluster adapter packages) need monotonic ids without pulling in the in-process substrate impls. The canonical implementation lives in `@agentick/utils-next/src/ulid.ts`; `@agentick/runtime-next/src/substrate/ulid.ts` is now a re-export so existing call sites (`LocalInbox`, `MemoryJournal`) keep their import path. 253/253 across runtime-next + utils-next.

2. **Cross-node `ask` via cluster-internal wire framing.** New `wrappers/internal-wire.ts` defines the reserved `@cluster/` namespace: `@cluster/ask` (forward request type), `@cluster/ask-response` (reply type), `@cluster/asks:<nodeId>` (reply address). Adopter `MessageEnvelope` fields (type, payload, from, correlationId) pass through unmolested — the wrapper carries the inner envelope inside a `ClusterAskRequestPayload` that the receiver unwraps before calling `local.ask`. `ClusterInbox.askRemote` generates a correlationId, registers a `PendingAsk` with timeout, ships the wrapped envelope via transport.send. On the receiving node, `handleInboundAskRequest` runs the inner ask against the local handler and ships back a discriminated `ClusterAskResponsePayload` (`_tag: "success" | "fail" | "interrupt"`). On the asker, `handleInboundAskResponse` looks up the correlationId, clears the timeout, resolves/rejects the pending Effect. Typed `MessageHandlerError` (`HandlerError` / `InvalidPayload`) round-trips structurally; runtime defects collapse into a synthesized `HandlerError`. Interrupts surface as `RoutingFailed`. Timeouts honor `AskOptions.timeoutMs` (default 30s) and emit `cluster:ask:timeout`. Close rejects every pending ask cleanly. Tests cover happy-path remote ask returning the handler value, typed failure round-trip, and timeout-on-unregistered-address.

3. **Membership reactivity.** `defineCluster` subscribes `membership.onChange` at construction and emits one of `cluster:membership:joined` / `cluster:membership:lost` / `cluster:membership:snapshot` per transition on the LOCAL bus (so operators see local topology truth regardless of `fanoutMode`). The subscription is registered with `parent.onClose` so it tears down in the LIFO chain. Pre-3.1 the cluster was operationally blind to topology changes — `membership.nodes()` was queried on demand but nothing reacted to deltas.

4. **Transport error diagnostics.** Replaced silent `.catch(() => {})` swallows. `ClusterEventBus.broadcastWithDiag` emits `cluster:transport:broadcast:failed { eventId, eventName, reason }` on broadcast rejection while still returning local `append` success (broadcast contract is best-effort). `ClusterInbox.sendRemote` emits `cluster:transport:send:failed { target, address, messageId, reason }` before bubbling the failure as `InboxError`. `askRemote` emits the same when the wire `transport.send` rejects before any response arrives, plus cleans up the pending entry. Adopters subscribing to `surface: "cluster"` now see real distributed-failure signal instead of silence.

5. **`ClusterInbox.dispatchInbound` discriminates errors instead of swallowing all.** Branches on env.type for the three inbound classes: `@cluster/ask` → `handleInboundAskRequest`; `@cluster/ask-response` → `handleInboundAskResponse`; everything else → `dispatchAdopterTell`. The adopter-tell path catches `InboxError` and emits `cluster:routing:address-not-found { address, messageId, from }` on the `AddressNotFound` tag — exactly the ops-debug signal pre-3.1 was hiding. `InboxClosed` (expected during teardown) stays silent.

6. **Shared diagnostic emitter + dead-config cleanup.** New `wrappers/diagnostics.ts` factors out the `DiagnosticEmitter` both wrappers consume — single code path for `surface: "cluster"` events with consistent `scope.nodeId` stamping, ULID ids, and fire-and-forget `Effect.runFork` semantics. Stripped the `label` field from the conformance-against-local call site (the field was removed from `ClusterTransportConformanceConfig` earlier; the call site was passing it via TS structural-typing tolerance).

**Workspace:** 45/45 across cluster-next (5 new tests in `cluster-wrappers.spec.ts` covering remote ask happy path, typed-failure round-trip, ask timeout, transport.send failure diagnostic, address-not-found diagnostic; 1 new test for membership reactivity). 253/253 across runtime-next + utils-next (ulid move). Typecheck + oxlint + oxfmt clean.

**Deferred to Phase 5 (createGateway/createApp integration timeframe):** Per-subscription `scope: "cluster-wide"` opt-in for the bus (currently `fanoutMode` is global per-cluster); subscriber-index gossip for `publishLazy` short-circuit in cluster-wide mode; `transport.broadcastBatch` seam for `appendBatch` bulk shipping (currently per-event serial loop).

**Next:** Phase 4 — `@agentick/cluster-ipc-next`. The first real adapter; cross-runtime broker over Unix socket / TCP localhost. Validates the wire-codec story end-to-end and lets us run real multi-process clusters on Node + Deno + Bun + PM2-spawned deployments.

**Previously, 2026-06-25 — Cluster Phase 3 — `ClusterEventBus` + `ClusterInbox` wrapper impls landed.** `defineCluster` no longer pass-through; the returned `Cluster` value carries real wrapped substrate.

- **`ClusterEventBus`** wraps a local `EventBus`. Outbound: stamps `scope.nodeId`, calls `local.append` (synchronous local fan-out), then `transport.broadcast` (cross-node). Inbound: subscribes to `transport.subscribeBus({})` at construction; under `cluster-wide-default` re-appends remote events into the local bus so subscribers see one merged stream; under `node-local-default` (default) drops remote events at the wrapper boundary so subscribers only see local activity. Defense-in-depth: drops any inbound event whose `scope.nodeId === currentNode` even if the transport adapter misbehaves. Emits `cluster:wrap:installed` and `cluster:wrap:disposed` diagnostics on the local bus for operator observability. `publishLazy` keeps its local short-circuit in `node-local-default`; over-builds in `cluster-wide-default` (remote subscriber index isn't known from here) and the README documents the trade-off. `read`/`hasSubscriberFor`/`metrics`/`subscribe` all delegate to local.
- **`ClusterInbox`** wraps a local `MessageInbox`. `send` consults `partitioning.shardKeyFor(address) → partitioning.nodeFor(shardKey)`; if `owner === currentNode` delegates to `local.send`, else stamps a `MessageEnvelope` (preserving idempotency `messageId`, defaulting `from` to `node:<currentNode>`) and forwards via `transport.send(owner, env)`. On the receiving node, the wrapper's `transport.subscribeInbox({})` callback runs `local.send(env.addressedTo, env)` so the registered handler picks up the cross-node message exactly as if it had arrived locally. `register` delegates to `local.register` (registration state isn't gossiped — addresses must live on their partition-owner). **`ask` is local-only in Phase 3** — remote ask fails with `InboxError { _tag: "RoutingFailed" }` carrying a clear "Phase 3b will land remote ask via RequestResponseRegistry" pointer; the call/response correlation across the cluster is meaningful additional plumbing.
- **`defineCluster` wiring** — both wrappers registered with `parent.onClose` so close fires in the same LIFO chain as the underlying seams. Construction order: transport → membership → partitioning → codec → bus wrapper → inbox wrapper. Top-level `cluster.close()` is defensive (calls inbox.close + bus.close directly); wrappers are idempotent on double-close.
- **No production dependency on `@agentick/runtime-next`.** Earlier draft used `ulid()` for diagnostic ids; pulled the dependency out so cluster-next stays framework-substrate-agnostic. Tests still use runtime-next as devDep for `LocalEventBus`/`LocalInbox`/`MemoryJournal` fixtures.
- **`@agentick/cluster-next/testing`** subpath unchanged from Phase 2b — `LocalClusterTransport` + `LocalClusterMembership` + `LocalClusterRegistry`. New `cluster-wrappers.spec.ts` exercises both wrappers end-to-end against two simulated nodes sharing a registry.

**Workspace:** 40/40 across cluster-next (5 files: json-codec, consistent-hash-partitioning, define, conformance-against-local, cluster-wrappers). Typecheck + oxlint clean.

**Next:** Phase 4 — `@agentick/cluster-ipc-next` (first real adapter; broker over Unix socket / TCP localhost; cross-runtime — Node.js + Deno + Bun + PM2-spawned). Phase 5 — substrate-seam integration in `createGateway` / `createApp`.

**Previously, 2026-06-23 (later still + #164) — #164 — `session.dispatch(...)` defaults to Pattern A for host-side callers; Pattern B is opt-in via `{ task: "ref" }`.** Pre-#164, dispatching a `taskSupport: "required"` tool from the host returned a `session_task_ref` content block — adopters had to `JSON.parse` the ref and then call `session.tasks.result(localId)` themselves. That was the right shape for the model-tick path (the model needs the ref to manage the task across ticks) but hostile for host callers who expect "I called dispatch, I get blocks." This change makes the host-side default await the local TaskHandle and return its final blocks. Four parts:

1. **Spec — `DispatchInput.task: "auto" | "ref" | "inline"`** added to `@agentick/spec-next/protocol/tool-executor`, alongside a new `DispatchOptions` (`task` only) on `SessionHarnessProtocol.dispatch(name, input, options?)`. `"auto"` is the default; `"ref"` and `"inline"` are explicit overrides. A new tagged error `ToolTaskModeConflictError` is added to `ToolExecutorError` for the two contradictory pre-flight cases (`{ task: "ref" } + taskSupport: "unsupported"` or `{ task: "inline" } + taskSupport: "required"`).

2. **ToolExecutorHarness matrix.** `dispatchOnResolved` no longer reads `supportMode === "required"` in isolation. It computes `usePatternB = requestedTaskMode === "ref" || (requestedTaskMode === "auto" && via === "model" && supportMode === "required")`. Everything else awaits the handle. The pre-flight conflict check runs before the handler executes — `(ref, unsupported)` and `(inline, required)` reject immediately with `ToolTaskModeConflictError` instead of dispatching nonsense handler shapes.

3. **`SessionHarness.dispatch` threads the option** through to the executor via `task: options.task` on the dispatch input; `defineSession`'s `SessionSpec.dispatch` signature widened to `(name, input, options?)` so adopter-provided session specs can forward the option. The model-tick path in `LoopExecutorHarness` is unchanged — it passes `via: "model"` and gets the `(required, auto, model) → Pattern B` matrix cell. Verified: the executor's existing `via: "model"` branching IS the model-tick path, so we don't need the loop-executor to look up declarations or pass `{ task: "ref" }` explicitly.

4. **Tests + adopter-visible reset.** New `packages-next/tool-executor/src/__tests__/dispatch-task-mode-matrix.spec.ts` covers the full 3×3 matrix (`supportMode` × `task`) plus the `via: "model"` cells for `"auto"` resolution — 12 tests, every cell asserted. `task-handle.spec.ts` (the #156 spec) flipped the two `taskSupport: "required"` host-dispatch tests to pass `{ task: "ref" }` so they still cover Pattern B serialization. `mcp/src/__tests__/task-bridge.spec.ts` — the first test ("auto-completes a task") now asserts Pattern A (host-side dispatch returns the remote payload directly); a new second test covers Pattern B opt-in via `{ task: "ref" }`. The `withMCP` integration didn't need any code change: the matrix lives entirely in the executor; the MCP tool's `annotations.taskSupport: "required"` (bridged from `execution.taskSupport`) still drives the model-tick path's `(required, auto, model) → ref` cell unchanged.

**Workspace:** 245/245 across session + mcp + app + tasks; 120/120 across tool-executor (12 new in the matrix spec). Typecheck + oxlint clean across spec / tool-executor / session / mcp.

**Adopter-visible diff:**

```ts
// before — host caller had to JSON.parse the ref + chase tasks.result
const ref = JSON.parse((await session.dispatch("deploy", input))[0].text);
const blocks = await session.tasks.result(ref.taskId);

// after — same code path, blocks come back directly
const blocks = await session.dispatch("deploy", input);

// still available — Pattern B is one option flag away
const refBlocks = await session.dispatch("deploy", input, { task: "ref" });
```

**Deferred:** Phase C (#174) refines the `(supported, auto)` cell with capability negotiation + per-call `task: { ttl }` opt-in. This pass treats `(supported, auto)` as Pattern A everywhere (host AND model) so `withMCP`'s framework→server-side bridging stays uniform; `#174` adds the per-call escape hatch.

**Previously, 2026-06-23 (later still + Phase B) — Phase B (#158) — MCP wire codec for tasks: outbound client honors server-broadcast `tool.execution.taskSupport === "required"` by routing through `ctx.tasks.submit(mcpTaskEffect(...))`.** Closes the Pattern B over-MCP loop. Six parts:

1. **Wire codec primitives** in `packages-next/mcp/src/wire/task-codec.ts`. Pure helpers built on the SDK's exported schemas: `buildCallToolAsTaskParams` (assembles `tools/call` params with `task: { ttl }`), `discriminateCallToolResponse` (distinguishes `CallToolResult` vs `CreateTaskResult` on the wire), `matchProgressNotificationForTask` (filters `notifications/progress` by `_meta["io.modelcontextprotocol/related-task"].taskId` via the SDK's `RELATED_TASK_META_KEY` constant). Pass-through re-exports of the SDK's task types so consumers don't reach into `@modelcontextprotocol/sdk` directly.

2. **`McpClientHarness` extensions** — five new methods all wired through the same `runOperation` substrate envelope as `callTool`: `callToolAsTask` (returns the discriminated `inline|task` outcome), `taskNotifications(taskId): Stream<{kind, notification}>` (per-taskId fan-out backed by `setNotificationHandler` + Maps keyed by taskId), `getTask`, `getTaskResult`, `cancelTask`. Notification handlers registered once at client construction; subscriber sets keyed by remote taskId; `Stream.async`'s `onCancel` tears down the subscription cleanly. Inbox routing for `tasks-cancel` server-to-client requests stays a future enhancement (we don't expose tasks-bearing tools as a server today).

3. **`mcpTaskEffect(client, input, workCtx)`** in `packages-next/mcp/src/integration/task-bridge.ts`. The Effect adopters pass to `ctx.tasks.submit(...)`. Encapsulates the full lifecycle: task-augmented `tools/call`, branch on inline/task response, fold inbound notifications into `workCtx.onProgress / setStatusMessage` via `Stream.runFoldWhile` (early-exit on terminal status), fetch payload via `tasks/result` on `completed`, surface a `McpRemoteTaskNonCompletedError` on `failed`/`cancelled` so the harness's failure path emits a symmetric local `TaskRejection`. `Effect.onInterrupt(sendCancel)` fires `tasks/cancel(remoteTaskId)` on local Fiber.interrupt (Phase D's settled-cancel awaits it; the wire cancel completes before `await session.tasks.cancel(localId)` returns).

4. **`withMCP` integration** — `discoverAndRegisterTools` detects `tool.execution.taskSupport === "required"` (the MCP-canonical location per SDK 1.29.0 `ToolSchema` — the legacy `annotations.taskSupport` was strict-stripped) and wraps the handler closure: `(input, { ctx }) => ctx.tasks!.submit((workCtx) => mcpTaskEffect(harness, {name, args: input, taskOptions}, workCtx))`. Unannotated tools keep current inline behavior. `mcpDeclaration` bridges MCP's `execution.taskSupport: "optional"|"required"|"forbidden"` to our framework-local `annotations.taskSupport: "supported"|"required"|"unsupported"` so the executor's Pattern A/B branching sees a uniform shape regardless of tool origin. New `McpServerConfig.defaultTaskTtl` field carries the per-server TTL into `task: { ttl }`.

5. **In-memory fake MCP server + end-to-end test** — `packages-next/mcp/src/__tests__/task-bridge.spec.ts` uses the SDK's `Server` class with `InMemoryMcpTransport.createLinkedPair()`. Fake advertises `tasks.requests.tools.call: {}` capability (SDK 1.29.0 shape; `taskCreation` field landed in the unreleased main-branch refactor). Three scenarios verified end-to-end through the AppHarness + withMCP stack: auto-complete happy path (dispatch returns `session_task_ref`; `session.tasks.result(localTaskId)` resolves to the server's `tasks/result` payload); cancellation (local `session.tasks.cancel(localId)` propagates as wire `tasks/cancel` and the server observes it via a Promise hook); progress notifications (server emits `notifications/progress` tagged with `RELATED_TASK_META_KEY` and the local TaskHandle's events stream surfaces the progress in order).

6. **Out of scope (deferred):**
   - **Phase C — capability negotiation.** MCP's `execution.taskSupport === "optional"` (= our `"supported"`) requires a per-call `task: {ttl}` opt-in from the caller, which the executor doesn't have a branch for today. Phase C adds the "supported" path: server-broadcast tools advertise availability, caller chooses to task-augment per-dispatch.
   - **Server-side tasks** (us exposing framework tasks via the MCP wire). mcp-next is client-only; the inbound-server path needs a separate `McpServerHarness` package.
   - **`tasks/list`** wire integration. The local `session_tasks_list` tool only surfaces local tasks; a future enhancement could merge remote `tasks/list` results.
   - **Progress notification `progressToken`** — we currently match on `_meta.related-task` only; future codec work could also recognize the `progressToken` from the original `tools/call` `_meta.progressToken` for servers that don't tag related-task.

**Workspace:** 301/301 tests pass across mcp-next + tool-executor + tasks + app (3 new e2e tests in task-bridge.spec.ts). Strict typecheck clean across spec / runtime / tasks / tool-executor / app / mcp. Adopters: server includes `execution: { taskSupport: "required" }` on its tool listing → our framework routes through Pattern B end-to-end with zero adopter configuration.

**Previously, 2026-06-23 (later still) — #155 (Phase D minimal) — `TasksHarness.submit` accepts `Effect<T, E, never>` work; cancel calls `Fiber.interrupt` for real interruptibility.** Closes the Effect-typed work seam called out as a TODO in `harness.ts` and on the #155 backlog item. Five parts:

1. **`TasksHarnessProtocol.submit` overloaded with an Effect work signature.** Spec adds `submit<T, E>(work: (ctx) => Effect.Effect<T, E, never>, opts?)` alongside the existing Promise/sync form. Both surface the same `TaskHandle<T>` — adopters branch purely on work-fn ergonomics, not on a separate API. `TaskWorkContext` (`signal`, `onProgress`, `setStatusMessage`) is unchanged; Effect work calls the imperative callbacks via `Effect.sync(() => ctx.onProgress(...))`.

2. **Runtime branch on `Effect.isEffect(work(ctx))` in `TasksHarness.submit`.** Promise path is unchanged (still `workPromise.then().catch()` + `AbortController.abort()`). Effect path runs `Effect.runFork(effect)`, stores the resulting `Fiber.RuntimeFiber` on the `TaskRecord`, and chains `Fiber.await(fiber).then(handleExit)` to surface Exit→FSM transitions. `Exit.Success` → `completed`; `Cause.failureOption(...)` Some → `failed` with `errorReason(failure)`; `Cause.isInterruptedOnly(cause)` → internally-cancelled path (treated as `cancelled` with `reason: "interrupted"`); otherwise defect → `failed` with first defect's reason.

3. **`Fiber.interrupt` wired into `cancelInternal`.** When a record carries a fiber, `cancel()` calls `Effect.runPromise(Fiber.interrupt(record.fiber)).catch(() => undefined)` fire-and-forget after the cancel transition is already committed. The fiber's Exit.Interrupt is observed by the `runEffectWork` continuation and silently dropped (status already `"cancelled"`). The AbortController is ALSO aborted on the Effect path as defence in depth — any Promise-flavor side-effects embedded inside the Effect still see the abort.

4. **Cause→reason mapping (`causeToReason`).** Effect's `Cause` structure preserves failure shape that a `.catch()` rejection would flatten. The helper walks `Cause.failureOption` first (typed `Effect.fail`), then `Cause.defects` (`Effect.die`), then `Cause.pretty` as a last resort — feeds the existing `errorReason()` consistently. Same `TaskFailure.kind: "error"` is emitted for both typed failures and defects; the reason string distinguishes them.

5. **Tests landed.** Conformance suite gains 4 cross-impl Effect tests (`succeed`, `fail`, `die`, `cancel-interrupts-Effect.sleep`). `harness.spec.ts` gains 6 reference-impl Effect tests including a **zombie-compute test**: an `Effect.gen` `while(true)` loop incrementing a Ref; after `cancel()`, the counter must freeze (verified by reading it twice across a 50ms gap). That test would loop forever without `Fiber.interrupt` — it's the load-bearing assertion for "real interruptibility" vs "AbortSignal flag flipped, microtasks still running."

**What's deliberately NOT in this slice (deferred TODO, separate refactor):** the per-subscriber `Set<Queue<TaskEvent>>` fan-out → `Stream.fromQueue` rewrite. The current Queue pattern is correct; the rewrite is cleanup, not capability. Tracked as a `#155-followup` TODO in `harness.ts`.

**Workspace:** `packages-next/tasks` 61 tests pass (54 prior + 7 new). `tool-executor` + `session` + `app` sweep clean (225 tests). Strict typecheck across spec / runtime / tasks / tool-executor / session / app / mcp all clean.

**Previously, 2026-06-23 (later) — #157 model-facing `session_tasks_*` tools — `withTasks()` auto-registers list / get / cancel / await so Pattern B is usable end-to-end.** Closes the Pattern B loop opened by #156. Without these the model receives a task-ref content block but has no way to act on it; with them the agent can dispatch concurrent long-running work, continue talking, and reconcile results across ticks. Six parts:

1. **`TasksHarnessProtocol.list()` added to the spec.** Returns `readonly TaskInfo[]` — a snapshot of every task known to this harness. Per-session scope (one harness per session via `withTasks()`). Implemented in `TasksHarness` (iterates the internal `tasks` map, calls existing `snapshot()` helper); implemented in `stubTasks` (returns `Array.from(known.values())`); conformance suite extended with one test covering the lifecycle (empty → 2 working → 2 completed).

2. **Four model-facing tools in `packages-next/tasks/src/tools.ts`:**
   - `session_tasks_list` — `{ tasks: TaskInfo[] }`
   - `session_tasks_get` — `{ task: TaskInfo }` or `{ error: "unknown_task", taskId }`
   - `session_tasks_cancel` — `{ cancelled: taskId }` or `{ error: "unknown_task", taskId }`
   - `session_tasks_await` — content blocks on `completed`; `{ error: "task_failed", status, failure }` on `failed`/`cancelled`; `{ error: "unknown_task", taskId }` for unknown id

   All four are thin handlers over `ctx.tasks` (no closure capture — handler routes through the live harness instance). `session_tasks_await` does **NOT** propagate its own dispatch abort to the underlying task — observation only. Model has to call `session_tasks_cancel` explicitly to actually stop the work.

3. **Naming decision: `session_*` prefix, underscores throughout.** Discussion in conversation log:
   - `tasks.*` alone collides with the huge namespace of user-defined "tasks" tools (todos, kanban, project trackers). Real ambiguity for the model.
   - `agentick.*` / `framework.*` leaks brand or implementation detail — the model doesn't know it's in a framework.
   - `background_tasks.*` / `async_operations.*` work but `session_*` is more accurate (these things ARE per-session) and opens a reserved namespace for future framework-native model-visible primitives: `session_knobs_*`, `session_timeline_*`, etc.
   - Underscores not dots: OpenAI's function-calling validator historically rejected dots; underscores work universally across OpenAI/Anthropic/Google/MCP.
   - The `_kind: "task-ref"` discriminator on the Pattern B content block was renamed to `_kind: "session_task_ref"` for consistency with the tool namespace.

4. **`withTasks()` auto-registers the bundle at session-install.** New `WithTasksOptions.registerModelTools` field (defaults to `true`); set `false` to skip the model surface for headless adopters driving tasks from server code with no LLM in the loop. The substrate (`ctx.tasks`, `bridges.tasks`) is wired regardless. Registration walks `installer.registerToolHandler(handlerRef, handler)` for each of the four handlers, then `installer.registerExtensionTool(registration)` for each declaration — same shape `withMCP` uses for its per-server tools. Bindings: `{ scope: "extension", extensionName: "@agentick/tasks-next", level: "session" }`. Handler refs include `installer.sessionId` so cross-session registrations on the shared `HandlerResolver` don't collide.

5. **Tool descriptions actively disclaim user-tool semantics.** Each tool's description starts with: _"Manage framework-spawned background tasks for the current session. These tools operate ONLY on tasks the framework created via long-running tool calls (signalled by a `session_task_ref` content block in the prior tool result). They are NOT for managing user-facing tasks like todos, project tickets, or kanban items..."_. The description carries real weight at inference time — that's where the disambiguation lives for a fine-tuned model that's pattern-matched on millions of productivity tools.

6. **Test coverage added: `packages-next/tasks/src/__tests__/session-tasks-tools.spec.ts` — 16 tests.** Each tool dispatched end-to-end through a real `ToolExecutorHarness` (constructed on the same in-memory substrate as the `TasksHarness`); known + unknown id paths for get / cancel / await; failure-shape coverage for `session_tasks_await` against a cancelled task; bundle structural assertions (4 registrations + 4 handler refs + per-sessionId namespacing + `level: "session"` binding); extension wiring smoke tests (`withTasks()` default vs `registerModelTools: false`). `@agentick/tool-executor-next` added as a `devDependency` per the CLAUDE.md guidance: "tests live where their dependencies live".

**Workspace:** 433/433 tests pass across the five affected packages (`tasks-next` 51 + `tool-executor-next` + `spec-next` + `session-next` + `app-next`). Lint + strict typecheck clean. README + STATUS updated.

**What's still missing for the full Pattern B story:**

- **#155** — `Effect<T>` work overload + `Fiber.interrupt` on cancel (LANDED in the latest entry). `Stream<TaskEvent>` from per-subscriber `Queue<TaskEvent>` fan-out remains a deferred cleanup (TODO `#155-followup` in `harness.ts`).
- **Phase B (MCP wire codec)** — `mcp-next` translates inbound MCP `tools/call` with `task: { ttl }` into `submit`; outbound MCP wire serializes our TasksHarness state into `notifications/tasks/status` + `notifications/progress`. Tracked separately.
- **`taskSupport: "supported"`** — caller-choice mode is in the spec annotation but executor doesn't branch on it yet. Land alongside MCP wire codec.
- **Otto example update** — the otto example doesn't yet exercise the Pattern B path (no tool declares `taskSupport: "required"`). Worth a one-tool addition to demonstrate the model managing background work.

**Previously, 2026-06-23 — #156 ToolExecutor task integration + `ctx.tasks` / `ctx.elicitation` on every handler — Pattern A vs Pattern B branching on `taskSupport` annotation.** Closes the wiring loop opened by #120 (TasksHarness substrate primitive) and #119 (ElicitationHarness substrate primitive). Both harnesses now reach the handler via `ctx` instead of the JSX `use:` ceremony — the "substrate primitive on `ctx`" rule from the spec doc. Five parts:

1. **`ToolHandlerCtx` extended with `elicitation` + `tasks` slots.** Both typed against their protocol interfaces in `@agentick/spec-next/protocol/*`; both `?:` optional so substrate-stripped test fixtures can omit them without compile errors, but every real session installs both (the required-set contract). Handlers call `ctx.tasks!.submit(...)` / `ctx.elicitation!.elicit(...)` without ceremony. Substrate-primitive slots vs `use:` slots — the rule: framework-provided harnesses every session has (elicitation, tasks, and future sampling/roots) live on `ctx`; extension-provided / provider-scoped things (sandbox bridge, custom MCP refs) flow through `use:` capture.

2. **`ToolHandlerResult` union extended with TaskHandle return shapes.** `TaskHandle<readonly ContentBlock[]>` + `Promise<TaskHandle<...>>` + `Effect<TaskHandle<...>>`. Async handler bodies wrap returns in Promise, so the executor needs the post-await detection path — handled by `dispatchOnResolved(resolved)` in the executor body (see §3).

3. **Pattern A / Pattern B branching on `taskSupport` annotation.** The executor's handler-result processing was restructured into a `dispatchOnResolved` post-processor invoked after Promise/Effect awaits. If the resolved value is a `TaskHandle` (detected via duck-type guard against `taskId` + `result` + `events` + `cancel`):
   - `taskSupport: "required"` → **Pattern B**. Executor serializes a typed task-ref content block (`{ _kind: "task-ref", taskId, status, statusMessage?, ttl? }`) and returns it to the model. The task continues running; the model owns it across subsequent ticks. Abort wires to `handle.cancel(reason)`.
   - `taskSupport: "unsupported"` (default) or undefined → **Pattern A**. Executor awaits `handle.result` transparently via `Effect.raceFirst(taskAwaitEff, abortEff)`. Model sees the eventual content blocks; never sees the taskId. Abort wires to `handle.cancel(reason)` AND short-circuits the await.
   - `taskSupport: "supported"` → deferred to #157 (caller-choice mode lands alongside the model-facing `tasks.*` tools).

4. **Per-session `TasksHarness` constructed alongside the elicitation harness in `AppHarness`.** Threaded through `SessionHarnessOptions → buildSessionBridges → SessionHookBridges` so `session.tasks` accesses the same instance as `ctx.tasks` and `bridges.tasks`. `CallbackSessionHarness` was extended with the same `readonly tasks` slot for parity. `createTestHarness` (tool-executor's `/testing` subpath) now constructs a real `TasksHarness` on the same in-memory substrate as its elicitation harness and exposes both in the bundle — adopter integration tests get the live status + progress envelopes on the bus for free.

5. **Tasks `README.md` rewritten for the current shape.** Pattern A / Pattern B explained with examples; `withTasks()` install path documented as the standard entrypoint; the `fakeTasks()` / `stubTasks()` doubles documented under their canonical `/testing` subpath with full option surfaces and adopter recipes; "Verified by" updated to point at the actual test files + counts (18 harness + 4 cluster-inbox + 12 conformance + 6 tool-executor task-handle = 40 tests across two packages); roadmap aligned with the live backlog (#157 / #155 / Phase B MCP wire codec). `FakeTasksOptions` added to the `/testing` barrel export.

**Test coverage added in this pass:** `packages-next/tool-executor/src/__tests__/task-handle.spec.ts` — 6 tests covering `ctx.tasks` + `ctx.elicitation` wiring, Pattern A (await transparently), Pattern B (serialize task-ref + task continues post-return), and Pattern A abort-propagation (`AbortController.abort()` on the dispatch routes through to `handle.cancel` and transitions the task to `cancelled`).

**Deferred:**

- **#157** — auto-register `tasks.list / tasks.get / tasks.cancel / tasks.await` model-facing tools when `withTasks()` is installed. Required for Pattern B to be usable — currently the model receives the task-ref content block but has no way to act on it.
- **#155** — `Effect<T>` work overload + `Fiber.interrupt` on cancel (LANDED in the latest entry). `Stream<TaskEvent>` from per-subscriber `Queue<TaskEvent>` fan-out remains a deferred cleanup (TODO `#155-followup` in `harness.ts`).
- **#158** — agent-self-coding via MCP server bridge (design only; no implementation).

**Workspace:** all v2 tests pass (1703/1703 in the full sweep + 6 new task-handle tests). Strict typecheck clean. The full README + status doc sweep adds the test-double accuracy guarantee for `fakeTasks`/`stubTasks` per the [[feedback_test_doubles_meszaros]] convention.

**Previously, 2026-06-13 — Executor harness round 2 — Effect.Stream pipeline + declarative hook surface + 4 providers refactored + lifecycle helper extraction + `defineLanguageModelExecutor`.** Second deep pass on the executor layer following round 1 (`BaseLanguageModelExecutor` introduction). This pass swapped the hand-rolled streaming loop for native Effect primitives, factored the v1 `createAdapter` borrowings into per-provider hooks, and consolidated lifecycle bookkeeping into a single shared helper. Four parts:

1. **Effect.Stream-ified streaming pipeline.** `BaseLanguageModelExecutor.executeBody` now uses `Stream.fromAsyncIterable(providerStream)` + `Stream.mapConcat(mapChunk)` + `Stream.mapConcat(pipeline.process)` + `Stream.tap(accum.apply)` + `Stream.tap(bus emit)` + `Stream.tap(Queue.offer)`. `executeStream` forks the pipeline as a daemon fiber with `Queue.bounded(64)` between producer and iterator — real backpressure: when the consumer lags, `Queue.offer` blocks the upstream Stream, which pauses `Stream.fromAsyncIterable`'s pull from the provider SDK. Cancellation flows via `Fiber.interrupt(fiber)` + `Effect.tryPromise({ try: (signal) => … })`'s fiber-aware AbortSignal; the external `abort()` API + caller signal merge in via `withExternalAbort` (`Effect.race` against a watcher). 5 new tests in `base-effect-stream.spec.ts` verify: pipeline routing order, bounded backpressure (exact delta count N+6 for 200 chunks), `abort()` interruption, iterator `return()` interruption, bus emission.

2. **Hook surface aligned with v1 `createAdapter`** (the user's "borrow from v1" item, fully landed). Abstract hooks: `buildParams` / `callProvider` / `openStream` / `mapChunk(chunk, accum) → readonly AdapterDelta[]` / `reconstructRaw(accum, modelSeen) → TRaw` / `normalizeRaw`. Optional hooks: `adapterTransforms(): readonly DeltaTransform[]` / `customBlocks: Record<string, CustomBlockDefinition>` (declarative XML-tag extraction) / `postProcessForNormalize` / `finalizeStream` / `mapProviderError` / `isAbortError`. The base owns the loop + transform pipeline + accumulator + bus + iterator + fiber lifecycle; providers write ~5 pure functions.

3. **All four shipped providers refactored** onto the new hooks. Each provider's drainStream (~200-300 LOC) + local accumulator class (~100 LOC) + buildTagRouter (~50 LOC) + applyTagRouterToX (~30 LOC) collapses to `openStream` + `mapChunk` + `reconstructRaw` + an `adapterTransforms()` returning `[thinkTagTransform()]` (when applicable) + a declarative `customBlocks` field. Cumulative: `executor-openai 1713 → 861` (-50%), `executor-anthropic 1684 → 1105` (-34%), `executor-google 1658 → 966` (-42%), `executor-ai-sdk 1027 → 601` (-41%). **Total provider LOC: 6082 → 3533 (-2549, -42%).** All 211 provider conformance + per-provider behavior tests pass.

4. **Adopter ladder + lifecycle helper.** Added `defineLanguageModelExecutor` — callback wrapper around `BaseLanguageModelExecutor` for adopters with streaming providers who don't want subclassing. Three rungs now: `extends BaseLanguageModelExecutor` (class, full power) → `defineLanguageModelExecutor({ openStream, mapChunk, reconstructRaw, … })` (callback, same hooks) → `defineExecutor({ run })` (single-callback, simplest). Extracted `ExecutorLifecycle` (`packages-next/executor/src/executor-lifecycle.ts`) — the `inFlight: Map`, `aborted: Set`, `abort()` impl, and pre-execute aborted check that was duplicated across `BaseLanguageModelExecutor`, `FakeLanguageModelExecutor`, and `CallbackLanguageModelExecutor`. All three now hold a `lifecycle` instance and delegate. Executor README in `packages-next/executor/README.md` documents the full custom-executor authoring story.

**Workspace:** 214/214 executor-layer tests passing (15-test conformance suite × 5 executors + 5 base-pipeline tests + 22 tag-parser tests + define-executor tests + define-language-model-executor tests + fake-language-model-executor tests + per-provider tests). Strict typecheck clean across executor packages. v2 modularity model preserved — no executor-anthropic/google/ai-sdk depends on executor-openai (the shared `StreamTagParser` lives in `@agentick/executor-next`).

**v1 / other-library borrowings explicitly landed:**

- v1 `createAdapter.mapChunk` → `BaseLanguageModelExecutor.mapChunk` (abstract)
- v1 `createAdapter.reconstructRaw` → `BaseLanguageModelExecutor.reconstructRaw` (abstract)
- v1 `DeltaTransform` pipeline + declarative `customBlocks` → `delta-transform.ts` + `tag-transforms.ts` + base's `adapterTransforms()` + `customBlocks` field
- v1 `prepareInput` → `buildParams` hook
- v1 `extractMetadata` → partial: per-tool `providerMetadata` (Google's `thoughtSignature` use case); broader extractMetadata callback not yet exposed
- AI SDK `fullStream` event vocabulary → already aligned in `AdapterDelta` union
- **Net new vs v1:** Effect.Stream backpressure (`Queue.bounded` + fiber-interrupt cancellation) — v1 had no equivalent.

**Follow-up audit deferred to its own pass:** the user flagged that other layers (`runtime-next`, `tool-executor-next`, `loop-executor-next`) likely have similar hand-rolled streaming/looping code that should be reviewed for Effect-primitive opportunities (Stream, Queue, Fiber). Not in scope for this pass; STATUS entry here to anchor the follow-up.

**2026-06-13 (later that day) — Effect audit landed across runtime + tool-executor; extractMetadata + defineLanguageModelExecutor conformance also landed.** Four follow-ups closed in one pass:

1. **`runtime-next/substrate/request-response-registry.ts`** — replaced the manual `setTimeout` + `clearTimeout` + `signal.addEventListener` + cleanups-array juggling with `Effect.raceFirst(deferred.await, timeoutEffect, signalEffect) + Effect.ensuring`. `Effect.raceFirst` (not `Effect.race`/`raceAll`) settles on first to either succeed OR fail — required for fail-fast timeout/abort semantics. `Effect.delay` and `Effect.async`'s cleanup-return-effect handle timer + listener cleanup automatically on race-loser interrupt. Net: ~40 LOC removed, eliminates the race conditions between timeout/signal fire ordering, no leaked listeners. 8/8 registry tests pass.

2. **`tool-executor-next/src/harness.ts`** — same fix in two places. The Effect-handler branch was using `Effect.race(handlerResult, abortEff)` which only settles on first SUCCESS — a slow-but-eventually-succeeding handler would beat an already-fired abort. Switched to `Effect.raceFirst`. The Promise-handler branch was using `Promise.race([handler, abortPromise])` with a hand-rolled `abortPromise` helper — replaced with `Effect.tryPromise(...).pipe(Effect.raceFirst(abortEff))`; deleted `abortPromise` (~10 LOC). Both handler shapes now share the same abort watcher. 71/71 tool-executor tests pass.

3. **`loop-executor-next`** — audit found NO Effect opportunities. Loop is intentionally sequential (tool dispatch waits for state-applicator ordering); the audit recommended "skip for now". Documented as a future optimization under "Roadmap & known gaps" rather than refactored.

4. **`defineLanguageModelExecutor` conformance** — wired the full 15-test `runExecutorConformance` suite against the callback wrapper. All 15 pass — confirms the callback path is equivalent to subclassing. Translates `scripted: LanguageModelExecutionResult` to a synthetic chunk stream that openStream yields, mapChunk translates to AdapterDeltas, reconstructRaw returns the scripted result.

5. **v1 `extractMetadata` borrow — fully landed.** Added optional `extractMetadata(raw)` hook to `BaseLanguageModelExecutor` + the `defineLanguageModelExecutor` callback bundle. Base merges the returned record into `result.finishMetadata` (last-write-wins per key) after `normalizeRaw`. Adopters can surface OpenAI `system_fingerprint`, Google `safetyRatings`, citation slots, etc. without rewriting `normalizeRaw`. Closes v1 createAdapter parity. New test in `define-language-model-executor.spec.ts` verifies the merge semantics + existing `finishMetadata` keys are preserved.

**Workspace:** 1260/1260 v2 tests pass. (Full workspace sweep also flagged 5 failures in `packages/gateway/__tests__/unix-socket-transport.spec.ts` — v1 gateway, EADDRINUSE port 18789, transient port-conflict flake unrelated to v2 changes.)

**2026-06-13 (continued) — Effect-primitives audit extended to session / app / gateway / transport; 2 real bugs fixed + helper deduplication.** Same audit pattern applied to the remaining harness layers. Three concrete changes:

1. **`transport-next/src/client/base-transport.ts` — AbortSignal listener leak.** The abort listener attached on every `request()` was never removed after the response arrived. Long-lived signals (the common case — one `AbortController` shared across many requests) accumulated listeners with each call: real memory leak under sustained load. Hoisted the listener out of the Promise constructor so a wrapper `settle()` can detach it on both success AND error before forwarding the value/error to `resolve`/`reject`. The `pending.has(id)` / `pending.delete(id)` ownership-check was already correct (single-threaded JS, no race); the listener-leak was the actual bug.

2. **`app-next/src/harness.ts` — `subscribeBus` microtask leak.** The previous implementation used an `aborted` boolean flag + manual `iter.next()` polling + `iter.return()` on unsubscribe. Between an in-flight `await listener(env)` and the outer `aborted = true` flip, `iter.next()` could already be pending and yield one more value AFTER the unsubscribe call returned. Replaced with `Effect.runFork(Stream.runForEach(bus.subscribe(filter), ...))` + `Fiber.interrupt` on unsubscribe — atomic, no microtask gap. Errors swallowed via `Effect.catchAll(Effect.void)` so one extension can't kill the bus subscription.

3. **`busAsyncIterator` helper deduplicated.** The `makeBusAsyncIterator` (`Stream` → `AsyncIterator<ProtocolEvent>` bridge with fiber-interrupt-based `return()`) was duplicated nearly identically between `AppHarness.events()` (60 LOC) and `GatewayHarness.events()` (60 LOC, with a worse `require()`-based effect import). Extracted to `@agentick/runtime-next/substrate/bus-async-iterator.ts`. Single source of truth; both harnesses delegate.

Skipped (audit said low-urgency or correct as-is): session's single-execution mutex (Promise-null-check is correct in single-threaded JS), MultiplexedStream (correct hand-rolled implementation), BaseConnectionContext (no concurrency hazards), runtime-next event bus / memory-journal wake-resolver patterns (Effect.async + resolver is idiomatic Effect — Deferred would be marginally cleaner but no resilience win).

**Workspace:** 1260/1260 v2 tests still pass after all three changes (and the prior request-response-registry refactor). v1 gateway flake (EADDRINUSE port 18789) attempted but not fixable from this branch (`gateway.start()` hangs for unrelated reasons when port is changed); v1 test left as-is.

**Previously, 2026-06-13 — Strict typecheck on test files + pre-commit hook coverage rolled out across all 30 v2 packages.** Every `pnpm typecheck` script now runs `tsc -p tsconfig.json --noEmit` (which includes `src/**/__tests__/`) instead of `tsconfig.build.json` (which excluded tests). The `lint` + `format:check` + `clean` scripts are now declared in every v2 package's `package.json` so turbo's pre-commit hook runs them symmetrically (was running on 7/30 before).

The strict-typecheck pass surfaced and fixed **~120 stale-fixture drift errors across 18 v2 packages**. Each error was a test asserting against a spec shape that had since narrowed/renamed/dropped a field — passing in vitest because esbuild strips types, failing under strict `tsc`. Highlights:

- **Spec widening** (real bugs in the spec, not tests): `ExecutorFactory.(deps?: ExecutorFactoryDeps)` is now optional (every shipped impl already accepted no-args; spec was the outlier); `ExecutorProtocol.ready: Promise<void>` added to match every concrete impl and every other harness; `spec-conformance/{loop-executor,session-harness}` stubs picked up the new `ready` field automatically.

- **Canonical extractText**: lifted three duplicate `textOf(content: readonly { text?: string }[])` helpers (knobs, state, reconciler-react, timeline) into `@agentick/spec-next` as `extractText(blocks)`, sibling to `isTextBlock`. Caught the structural-shim drift: `{ text?: string }` accepted ContentBlock by accident; canonical helper narrows via `isTextBlock`. Spec's `guards/index.ts` is now exported from the package root.

- **JSX.IntrinsicElements augmentation drafted, not wired**: v2 doesn't yet declare host intrinsics (`<message>`, `<tool>`, `<section>`, `<text>`, ...) in `JSX.IntrinsicElements`. Test code writing JSX against them fails with `TS2339: Property 'message' does not exist`. Drafted `packages-next/reconciler-react/src/react/jsx-intrinsics.d.ts` (mirror of v1's `packages/core/src/jsx/react-jsx.d.ts`, retyped against `@agentick/spec-next`) — **not wired in yet**. Adopter-facing requirement; lands as its own dedicated piece of work. Until then, tests use `React.createElement("message" as unknown as React.ComponentType<Record<string, unknown>>, ...)` with documented TODOs.

- **Per-layer canonical fakes (extending the previous Meszaros-taxonomy work)**: every layer's drift-fix pass became an opportunity to lift local stubs to a `/testing` subpath. Done so far: `@agentick/reconciler-next/testing/fakeReconciler`. Follow-up renames pending: `MockLanguageModelExecutor → FakeLanguageModelExecutor`, `mockTimelineHarness → fakeTimelineHarness`, `stubBridges → fakeBridges`.

- **Module-augmentation invisibility**: `ProviderOptions` (augmented by executor-openai etc.) and `HookBridges` (augmented by knobs-next, timeline-next, ...) slots are invisible to tests that don't import those packages. Indexed through `Record<string, unknown>` with explanatory comments at affected call sites. Real fix is the side-effect-import pattern, but that's wider than this sweep.

**Workspace:** 1236/1236 v2 tests passing. Strict typecheck clean across all packages-next. Lint + format:check clean across the v2 tree. Pre-commit hook now covers all 30 v2 packages symmetrically.

**Previously, 2026-06-12 — Test-double convention established + `@agentick/reconciler-next/testing` shipped with `fakeReconciler()`.** Per the Meszaros _xUnit Test Patterns_ taxonomy: `fake*` for minimal working impls (default), `stub*` for canned answers, `spy*` for call recorders, `mock*` for expectations. Never `test*` — it collapses the taxonomy and loses information. Every layer ships its test doubles under a `/testing` subpath (CLAUDE.md's harness pattern applied across all layers). Doubles are typed against spec interfaces — when the spec changes, the doubles break at compile time. Adding `fakeReconciler` immediately caught two stale-spec drift bugs in the existing `define-reconciler.spec.ts` fake helper (`{warnings,errors}` diagnostics shape that's now `readonly ReconcileDiagnostic[]`, missing `iterations` field, dead `version` field, missing `MountResult.restoredFromSnapshot`) — exactly what the convention is designed to prevent. Fixed in this pass.

**Follow-up (consistency cleanup):** existing test doubles using `Mock` / `mock` / `stub` prefixes are misnamed under the new convention since they're all working-impl shapes (Fakes per Meszaros). Rename in a separate pass: `MockLanguageModelExecutor → FakeLanguageModelExecutor`, `mockTimelineHarness → fakeTimelineHarness`, `stubBridges → fakeBridges`. Also move helpers like `stubBridges` from `bridges/` into `testing/` for consistency.

**Previously, 2026-06-12 — Phase 33.C hardening pass — `MultiplexedStream` backpressure + jitter property tests + full client→gateway→executor `session/send` e2e.** Three items flagged in earlier STATUS entries closed:

- **`MultiplexedStream<T>` backpressure** — four explicit policies: `"unbounded"` (default; prior behavior), `"drop-oldest"`, `"drop-newest"`, `"close-on-overflow"`. Bounded policies require a finite positive `capacity`; constructor rejects misconfiguration. `onDrop` / `onOverflow` callbacks let adopters observe loss. AsyncIterator now drains buffered values before surfacing the terminal error so close-on-overflow consumers see what was buffered at the moment of overflow. 9 tests in `transport-next/src/__tests__/multiplexed-stream-backpressure.spec.ts`.
- **Backoff jitter property tests** — extracted `computeFullJitterBackoff(attempt, policy, random?)` as a pure free function (the `BaseClientTransport.computeBackoff` is now a one-liner over it). 6 tests verify: output in `[0, cap)` for every attempt, cap doubles per attempt until `maxDelayMs`, uniform distribution across `[0, cap)` (10k-sample chi-squared sanity ±15%, bottom-decile within 7-13% to rule out equal-jitter / no-jitter regressions), and deterministic reproducibility via injected RNG.
- **`session/send` end-to-end** — real `createClient → inProcessTransport → dispatchRequest → GatewayHarness → AppHarness → SessionHarness → MockLanguageModelExecutor` roundtrip in 2 tests. Verifies the wire shape + dispatch + executor wiring all hold together (previous tests stubbed the gateway handler with a switch). Established the pattern adopters use for full-stack tests: `dispatchRequest(gateway, req, sink)` wrapped as an `InProcessGatewayHandler`.

**Workspace:** 1236/1236 tests across `packages-next/*` (+17 from this pass). Typecheck clean.

**Previously, 2026-06-12 — Phase 33.F.1 — consolidated the four client-middleware packages into a single `@agentick/client-extensions-next` bundle with subpath exports.** Reason: `@agentick/client-{retry,telemetry,cache,offline}-next` was colliding with the planned `@agentick/client-{react,angular,vue}-next` framework-binding namespace — `client-X` was carrying two semantically different jobs (middleware behavior vs framework binding). The bundled package keeps each behavior in its own subdir with its own README + test suite + JSDoc, but ships under a single layer-disambiguated name. Adopters install one package and opt in per behavior via subpath imports:

```ts
import { retry } from "@agentick/client-extensions-next/retry";
import { telemetry, noopAdapter } from "@agentick/client-extensions-next/telemetry";
import { cache } from "@agentick/client-extensions-next/cache";
import { offline } from "@agentick/client-extensions-next/offline";
```

This establishes the v2 naming convention for first-party extensions: **`{layer}-extensions-next`** for bundled middleware (`client-extensions-next`, future `gateway-extensions-next`, `harness-extensions-next`); **`{layer}-{framework}-next`** for framework bindings (`client-react-next`, `client-angular-next`, ...). Third-party extensions name themselves freely.

**Second bonus bug caught and fixed:** `BaseClientTransport.request()`'s cancellation path had a microtask gap — when the abort listener synchronously rejected the inner `promise` before the outer async function reached `return promise`, Node observed the rejection as unhandled before vitest could chain its `.then`. Fixed by attaching a passive `.catch(() => {})` immediately on the inner promise; the outer return path still propagates the rejection unchanged. Confirmed via isolated cancellation test — no more `PromiseRejectionHandledWarning` or "Unhandled Errors" line. (Same family as the earlier orphan-pending-on-sendFrame-throw fix — both about `BaseClientTransport` letting inner promises become temporarily handler-less.)

**Phase 33.F original (now subsumed) — four common middleware behaviors shipped.** Each behavior designed against established prior art (cited in its README) and configurable along the axes that matter most for adoption:

- **`/retry`** — exponential backoff with full jitter (AWS Builder's Library), configurable retryable predicate (transport drops + RateLimited/Backpressure/InternalError by default), idempotency-key propagation via `params._meta.idempotencyKey` (RFC 7231 §4.2.2 / Stripe / GCP convention) on non-idempotent methods (`session/send`, `session/dispatch`, `session/queue`, `app/runOnce`), per-method override, deadline-budget. 16 tests.
- **`/telemetry`** — OpenTelemetry-shaped: span per logical RPC with RPC semconv attributes (`rpc.system`, `rpc.service`, `rpc.method`, `rpc.jsonrpc.error_code`, `rpc.duration_ms`), W3C Trace Context propagation via `_meta.traceparent` / `_meta.tracestate`, BYO `TelemetryAdapter` (we don't bundle `@opentelemetry/api`), per-method sampler, `noopAdapter` for context-only adopters. 9 tests.
- **`/cache`** — method-explicit-allowlist read-through cache (default empty — agentick is stateful), per-method TTL, in-memory LRU `CacheStore` default, pluggable for Redis-backed durable caches, `_meta` stripped before keying so trace/idempotency variations don't fragment. Same family as React Query / TanStack / SWR / Apollo Client. 7 tests.
- **`/offline`** — outbound queue extension. Per-method `queue` / `fail-fast` / `never` policy (default fail-fast), FIFO replay on `state === "open"`, pluggable `OfflineStore` (in-memory default; adopters wire IndexedDB / SQLite / Redis), `client.offline.{pending,size,flush,clear}()` namespace via `ClientNamespaces` declaration merging. Same family as Workbox BackgroundSync / Apollo Link Queue / Redux Offline. 7 tests.

**Bonus bug caught and fixed during the retry tests:** `BaseClientTransport.request()` left an orphaned pending entry when `sendFrame` threw — when retry middleware moved on after a send failure, the original Promise stayed in the pending Map; subsequent `close()` rejected it with `{ kind: "closed" }` and Node logged the unhandled rejection (9 of them across the retry suite). Fixed by wrapping `sendFrame` in try/catch and cleaning the pending entry on throw. The retry middleware's behavior (correctly) didn't change; the noise vanished.

**Known follow-up — cache utility extraction.** The `LruCacheStore` in `client-extensions-next/cache` has a near-identical sibling in `runtime-next/substrate/local-inbox.ts`'s `IdempotencyEntry` cache (LRU+TTL via Map insertion order). Different semantics (RPC response cache vs handler-fiber dedup), same data structure. Two callsites isn't enough to justify extraction — wait for a third (adapter response cache, formatter compile cache, MCP capability cache, ...) before pulling out `@agentick/cache-next` (`LruTtlCache<V>` as a utility, **not** a harness).

**Workspace:** 1219/1219 tests across `packages-next/*`. Typecheck clean across all 95 packages.

**Previously, 2026-06-12 — Phase 33.C.2 — second consolidation pass into `@agentick/transport-next`.** Pulled the reconnect machinery (exponential backoff with full jitter, `scheduleReconnect`, `computeBackoff`, `handleConnectionDrop`, `cancelReconnect`) onto `BaseClientTransport`; pulled the per-connection server state (subscriptions Map, in-flight Map, `dispatchInbound`, `cancelInFlight`, `close` cleanup) into a new `BaseConnectionContext` abstract class. All four transports (in-process, WS, HTTP, Unix socket) refactored to consume these — clients shrank ~150 LOC of duplicated reconnect code; servers shrank ~250 LOC of duplicated `ConnectionContext` boilerplate. Each concrete transport now contains ONLY wire-specific code: WS = subprotocol negotiation + WebSocket lifecycle (165 LOC); UDS = NDJSON + net.Socket lifecycle (130 LOC); HTTP = fetch + SSE parse + GET notification channel (215 LOC). Workspace: 110/110 across all transport packages; WS conformance suite passes 20/20 isolated runs after the consolidation (same as after the earlier race fix). Typecheck clean.

**Previously, 2026-06-12 — Phase 33.E shipped: `@agentick/transport-unix-socket-next`.** Fourth transport on `BaseClientTransport`. Newline-delimited JSON-RPC over a Node `net.Server` / `net.Socket`. Node-only — required for tentickle-class local-IPC (TUI ↔ same-host daemon). ~170 LOC of socket-specific code; the extraction from Phase 33.C.1 is paying off — fourth transport in same session as third (33.D) and shipped on first-try with 18 tests green (5 smoke + 13 conformance). All four transports (in-process, WS, HTTP, Unix socket) now share the same `BaseClientTransport` + `runTransportConformance` discipline.

**Previously, 2026-06-12 — Phase 33.D shipped: `@agentick/transport-http-next` (Streamable HTTP per MCP 2025-03-26).** Single endpoint serves POST (JSON-RPC request → either `application/json` for non-streaming or `text/event-stream` for `_meta.progressToken`-bearing requests), GET with `Accept: text/event-stream` (persistent notification channel for subscriptions + unsolicited events), DELETE (session teardown). Universal `fetch` client (Node 22+, browser, Bun, Deno, edge). Server adapter mounts on `http.Server`; per-session `ConnectionContext` tracks GET notification stream + in-flight RPCs + subscriptions. Session affinity via `Mcp-Session-Id` header. CORS via `allowedOrigins` + OPTIONS preflight. Subclasses `BaseClientTransport` from `@agentick/transport-next` — third transport built in ~250 LOC of HTTP-specific code; gets state machine, RPC correlation, subscription multiplexing, cursor-aware resubscribe for free. 18 new tests (5 smoke + 13 conformance, all passing). Caught one bug: `writeHead` alone doesn't flush headers on a Node `http.ServerResponse` for streaming SSE — explicit `flushHeaders()` + a leading comment frame is required for `fetch` clients to resolve their response promise on connect.

**Previously, 2026-06-12 — Phase 33.C.1 shipped: `@agentick/transport-next` extracts ~400 LOC of shared transport plumbing from `transport-in-process-next` + `transport-websocket-next`.** `BaseClientTransport` (abstract) now owns state machine, RPC correlation, subscription/progress stream registries, notification routing, cursor-aware resubscribe machinery, and AbortSignal→cancellation wire emit. Concrete transports subclass and supply only wire-specific connection management — in-process shrank from ~340 to ~94 LOC; WebSocket from ~390 to ~220 (kept reconnect + subprotocol + WS-specific socket plumbing). `dispatchRequest` (the JSON-RPC → `GatewayHarnessProtocol` adapter) moved out of `transport-websocket-next/server/dispatch.ts` (wrong package) into `transport-next/server/dispatch.ts` — WS, HTTP (Phase 33.D), and Unix-socket (33.E) all consume it. `runTransportConformance(name, factory)` ships in `@agentick/spec-conformance-next`: a shared behavioral suite (13 tests) every transport runs against its own setup function — state machine, RPC dispatch + errors, multiplexed concurrent RPCs, `notifications/cancelled` wire emit, subscription routing + close + eviction, progress stream routing. The extraction caught a real `MultiplexedStream` bug: `end(error)` was resolving pending iterator `next()` calls with `{ done: true }` instead of rejecting — pre-existing in both transport impls, now fixed in one place. Workspace: 5768 tests passing (+46 from conformance × 2 transports), typecheck clean.

**Previously, 2026-06-12 (earlier) — Phase 33 README audit pass — every claim in user-facing docs now traces to a verifying test, or sits in "Roadmap & known gaps" with an explicit `✗` marker.** Caught a real API bug along the way: `ClientProtocol.request()` claimed to accept an `AbortSignal` (per the README and ADR 33) but didn't expose the parameter — the test forced the fix. Wire-level `notifications/cancelled` emit + server-side handling is now genuinely verified end-to-end. Added 17 new tests (security 7, cancellation 2, custom-WebSocket-ctor 1, handler-registry 6, effect-middleware 3, send-shortcut 2). Every Phase 33 README has a `## Verified by` section mapping claims → test files; non-obvious code invariants carry `@verifiedBy` JSDoc citations. Saved as memory rule: "Every claim needs a test" — applies to user-facing docs, comments, and code claims going forward.

**Phase 33.B + 33.C — initial ship (previous work blocks):**

**Phase 33.C — WebSocket transport (this work block):**

- **`@agentick/transport-websocket-next`** package with `/client` + `/server` subpath exports.
- **Client side** — uses `globalThis.WebSocket` by default (Node 22+, browser, Bun, Deno, edge runtimes). Accepts `{ WebSocket }` constructor override for adopters on Node 18/20 (`ws` library) or who need custom headers in Node. Frame multiplexing: a single connection carries N concurrent RPCs (correlated by `id`) plus N subscriptions / progress streams (correlated by `subscriptionId` / `progressToken`). No Socket.IO — the canonical wire-multiplexing pattern via JSON-RPC. Exponential backoff with full jitter (per AWS Builder's Library; 100ms → 30s cap). Cursor-aware resubscribe on reconnect — each active subscription replays from its last-seen cursor.
- **Server side** — `websocketServer({ httpServer, gateway })` attaches a `WebSocketServer` (from the `ws` library; Node's native WebSocket is client-only) to an existing Node `http.Server`. Subprotocol negotiation: accepts only `agentick-rpc-v1`. Per-connection `ConnectionContext` tracks active subscriptions; heartbeat via WS-level ping/pong (RFC 6455 §5.5.2/3, 30s default). Origin validation for browser clients (`allowedOrigins` config). JSON-RPC frame dispatch in `server/dispatch.ts` is **transport-agnostic** — it will serve the HTTP and Unix-socket adapters in Phase 33.D / 33.E without changes.
- **Tests** — 19 new, all green. Smoke (8) covers WS connect with subprotocol, ping roundtrip, listApps reflecting real GatewayHarness state, RPC error → `TransportError`, concurrent RPC multiplexing, clean close, subprotocol enforcement. Reconnect (3) covers server-bounce → reconnect transition, explicit-close suppression, disabled-reconnect → clean closed. Wire conformance (8) — the spec-conformance suite runs against the JSON codec.

**Phase 33.B — `@agentick/client-next` + in-process transport (this work block):**

- **`@agentick/spec-next/client/`** — `ClientProtocol`, `Client` (= protocol + `ClientNamespaces` via decl-merge), `GatewayHandle` / `AppHandle` / `SessionHandle` / `ClientSessionExecutionHandle`, `ClientTransport` contract, `ClientExtension` shape (Promise-native middleware + per-event-merge lifecycle handlers + `ClientInstaller`), `ClientState` machine, `TransportError`, client-bus event surfaces. **Multiple impls can conform** — canonical client, test mocks, future Worker-thread proxy — the protocol is the canonical surface, not any particular package.
- **`@agentick/client-next`** — `createClient()`, `AgentickClient`, `composeRequest` / `composeSubscribe` pipelines, `ClientHandlerRegistry` (per-event merge: observer / first-non-null-wins / any-reconnect-wins, exhaustiveness-checked), `effectMiddleware()` Effect adapter, handle factories, `createSessionExecutionHandle` stitches `session/send` RPC with `transport.progress(token)` stream into the canonical AsyncIterable + `.result` + abort shape.
- **`@agentick/transport-in-process-next`** — first transport. Direct-call, zero-serialization. Optional `wireParity: true` mode JSON-roundtrips for catching wire-shape regressions at test time. Smoke (10) covers ping, listApps, listSessions, session.abort, RPC error shape, wireParity roundtrip, extension middleware order, namespace registration, onClose LIFO. Wire conformance (8) green.
- **Wire-type alignment** — `AppGetSessionResult = SessionEntry`, `AppListSessionsParams.filter: SessionFilter`, `AppListSessionsResult.sessions: SessionEntry[]`. The wire reuses canonical in-process types where they're JSON-safe; eliminates wire/in-process shape divergence.

**Phase 33.A — engineering decisions made (pre-review pass against rev-1 draft):**

- **`JsonRpcSuccessResponse` / `JsonRpcErrorResponse` enforce mutual exclusion** via `error?: never` / `result?: never` markers. JSON-RPC 2.0 forbids carrying both; TS structural typing required explicit `never` to close the gap.
- **`SessionSendParams.messages` typed `SendMessageInput[]`** (not `ContentBlock[]`). Role + content + metadata cross the wire. Same fix on `AppRunOnceParams` / `SessionQueueParams`.
- **`WireRequestParams` base interface** carries `_meta?: RequestMeta`; every request params type extends it (MCP-uniform).
- **`initialize` + `notifications/initialized` handshake** added with `ClientCapabilities` / `ServerCapabilities` (cursorResume, batch, streamableHttp, subscriptions, progress, cancellation, mcpSurface).
- **`validateJsonRpcFrame` / `validateJsonRpcInput`** validators ship in spec — transports MUST validate untrusted JSON before treating it as typed.
- **`runWireConformance(codec)` suite** in `@agentick/spec-conformance-next` — every transport runs this against its own encode/decode.

**Workspace:** 5722 tests passing (was 5703 — +19 WS tests). Typecheck clean across all 89 packages. v1 transport tests in `packages/gateway/{unix-socket,local}-transport.spec.ts` flake under workspace-wide parallel load (Unix socket path collisions; pre-existing — pass 68/68 in isolation).

**Previously, 2026-06-11 — ADR 33 landed + Phase 33.A shipped: wire types in `@agentick/spec-next/wire/`.** ADR 33 (Client + transports) drafted through four revisions: rev-1 initial design, rev-2 ergonomics pass (selector/multiplexer take instances not factories; `client.send()` shortcut; Streamable HTTP), rev-3 `BaseHarness`-parity (client middleware Promise-native with `effectMiddleware` adapter; lifecycle handlers with per-event merge rules; `AuthSource` parameterized per-transport), rev-4 MCP wire alignment (`_meta.progressToken` at MCP-exact location; method separator unified to `/`; `notifications/` prefix; error code table; reserved MCP namespaces; planned `@agentick/mcp-surface-next` + `@agentick/transport-mcp-client-next` bilingual packages). Wire spec types shipped in `@agentick/spec-next/wire/`: JSON-RPC 2.0 envelopes with mutual-exclusion enforcement via `error?: never` / `result?: never`; `ErrorCode` const namespace (-32700/-32603 standard, -32800/-32801 LSP, -32000..-32050 Agentick); `ErrorData` typed-data registry; `SubscriptionScope` discriminator; method-bound param/result shapes for every method including `initialize` handshake (MCP-aligned); `WireMethods` + `WireNotifications` registries for typed dispatch; `validateJsonRpcFrame` + `validateJsonRpcInput` for untrusted-input validation; `runWireConformance` suite in spec-conformance for every transport to verify roundtrip + validator integration.

**Phase 33.A — engineering decisions made (post-review pass against the rev-1 draft):**

- **`SessionSendParams.messages` typed `SendMessageInput[]`**, NOT `ContentBlock[]`. Role + content + metadata cross the wire. Caught in self-review pre-commit; without role the wire cannot represent multi-turn conversation.
- **`WireRequestParams` base interface** carries `_meta?: RequestMeta` so every request shape can opt into MCP `_meta` hints uniformly — no inconsistent presence per method.
- **`JsonRpcSuccessResponse` / `JsonRpcErrorResponse` enforce mutual exclusion** via `error?: never` / `result?: never`. TypeScript structural typing made this a real gap; `never`-marker closes it.
- **`initialize` + `notifications/initialized` handshake added** mirroring MCP. Capability negotiation (cursorResume, batch, streamableHttp, subscriptions, progress, cancellation, mcpSurface) at session start.
- **`validateJsonRpcFrame` / `validateJsonRpcInput`** validators ship in spec — transports MUST call these on untrusted decoded JSON before treating it as a typed frame. Type guards (which exist alongside) narrow already-well-formed frames; the validators reject malformed input with a structured `JsonRpcError`.
- **`runWireConformance(codec)` suite** in `@agentick/spec-conformance-next/wire.ts` — every transport's test file calls this with its own encode/decode pair, exercising roundtrip of all four frame kinds + validator integration + batch handling + empty-batch rejection.

**Workspace:** 5686/5686 tests green (+18 from new wire conformance + extended wire spec). Typecheck clean across all packages.

**Previously, 2026-06-10 — Workspace reorganization: v2 packages relocated to `packages-next/` with `-next` suffix on every package name.** v1 stays untouched in `packages/` so master merges land cleanly. The reorganization is purely packaging; no API or behavior change. At v2.0 cut the suffix strips and `packages-next/` collapses onto `packages/`.

**Reorganization (this work block — `f22b3985`):**

- **`pnpm-workspace.yaml`** — added `packages-next/*` glob.
- **`git mv`** — 22 v2-pure packages relocated to `packages-next/` with rename detection preserving history: `spec`, `runtime`, `app`, `session`, `reconciler`, `reconciler-react`, `executor`, `executor-openai`, `executor-anthropic`, `executor-google`, `executor-ai-sdk`, `loop-executor`, `tool-executor`, `tool`, `knobs`, `state`, `timeline`, `gates`, `skills`, `formatters`, `subscriptions`, `spec-conformance`.
- **Sandbox + Gateway extraction** — `packages/sandbox/src/v2/` → `packages-next/sandbox/` and `packages/gateway/src/v2/` → `packages-next/gateway/` as standalone packages with their own `package.json` / `tsconfig.json` / `tsconfig.build.json`. `/v2` exports + v2 deps stripped from v1 sandbox + gateway package manifests so the v1 surfaces are clean.
- **Rename pass** — `@agentick/<pkg>` → `@agentick/<pkg>-next` across source `.ts`/`.tsx`, every `package.json` / `tsconfig*.json`, examples, blueprint docs, and skill docs (376 files via perl script).
- **Tooling configs** — `.changeset/config.json` drops v2 names from the `fixed` array (v2 packages re-publish under canonical names at v2.0 cut); `website/typedoc.json` replaces v2 entries with `packages-next/*` paths; `website/.vitepress/config.mts` lists the 24 `-next` packages under the v2 group.
- **Verification** — `pnpm install` clean; `pnpm -r typecheck` clean across all packages; `pnpm vitest run` clean (4625 tests passing, 1 file skipped).

**Cut-over plan at v2.0** — perl-strip `-next` suffix + `git mv packages-next/* packages/`. Overlapping names collide with v1 — that collision is the migration moment where v1 gets archived.

**Workspace:** 4625/4625 tests green. 87 packages on `feat/v2` (65 v1 + 22 v2-pure + 2 v2-extracted from v1 dual-tree packages).

**Previously, 2026-06-07** — **ADR 32 landed (Extension shape spectrum — six shapes from full harness to pure descriptor; decision tree + concrete v1 plugin/transport disposition for Phase 5). First Phase 5 deliverable: `SkillsHarness` shape-1 harness scaffold in new `@agentick/skills-next` workspace package (OpenClaw / Hermes style durable, searchable agent skill library). Plus `readonly id: string` exposed on `AppHarnessProtocol` and `SessionHarnessProtocol` (filled the adopter-surface gap from Phase 4).**

**Phase 5 kicked off (2026-06-07 work block):**

- **`blueprint/32-extension-shape-spectrum.md`** (new ADR). Documents the spectrum every "extension" lives on: (1) full harness extension, (2) namespace object, (3) pure bus subscriber, (4) reconciler contributor, (5) descriptor + hook (gates pattern), (6) tool / formatter. Each shape has a cost/value calculus. Decision tree adopters or contributors use to pick the right shape. Phase 5+ plugin/transport disposition table — most v1 plugins reshape into shape 1 (mcp-server, openai-compat as harnesses with per-request state) but logging reshapes into shape 3 (pure subscriber, ~3 lines of code). All v1 transports reshape into shape 1 — per-connection state + bidirectional translation justifies the substrate audit cost. Gates is the load-bearing shape-5 counter-example.
- **`AppHarnessProtocol.id` + `SessionHarnessProtocol.id`** (new spec fields). Filled the gap flagged in Phase 4. Promoted from `protected scopeId` to public via `get id()` getter on `AppHarness`, `SessionHarness`, `CallbackSessionHarness`. Gateway tests now round-trip the auto-generated `app:${ulid()}` id through `gateway.createApp`.
- **`@agentick/skills-next` workspace package** (shape 1 harness extension). `Skill` data model (`name` / `description` / `content` + optional `tags` + `metadata` + timestamps). Sync surface: `get`/`has`/`list`/`search`/`subscribe`/`subscribeAll`. Async surface: `register`/`update`/`remove` through `runOperation`. Snapshot/restore. Inbox catalog with three message types. Module augmentation: `HookBridges.skills` + `SessionHarnessProtocol.skills`. `withSkills({ initial })` SessionExtension. Conformance suite (18 contract tests). `stubSkillsHarness(initial?)` testing helper. `"skills"` added to `EventSurface` union.

**Workspace:** 5647/5647 tests green (was 5615; +19 skills + 13 from interim). Typecheck clean across 87 packages (now includes `@agentick/skills-next`).

**Previously, 2026-06-06 — Phase 4 kicked off — thin `GatewayHarness` scaffold shipped in `packages/gateway/src/v2/`. Runtime-root harness; multi-app hosting with substrate inheritance / per-app factory overrides; lifecycle cascade; cross-app event observation. Plus three doc artifacts grounding the v2 Gateway story against v1's actual implementation: rewrite of `blueprint/12-gateway.md` (runtime-root framing, four deployment tiers, transports/plugins as extensions), `V1-GATEWAY-PARITY-TRACKER.md` (42 v1 features inventoried across 12 categories; Phase 4 closes 6 of them, rest deferred / reshaped), and ADR 31 framing clarifications (Gateway useful at all tiers, not just cluster-node level).**

**Phase 4 (this work block — sequenced 4.1 through 4.4):**

- **`blueprint/12-gateway.md` end-to-end rewrite (4.1)** — V1 deep-read revealed the doc's prior "stateless front door" framing didn't match v1's actual `Gateway` (~27K LOC, stateful multi-app host + transports + plugins + auth + sessions). Rewrote around the harness-shape view: Gateway is the runtime root in every tier, cluster substrate is a swap not a separate harness, transports are extensions. Useful for OpenClaw/Hermes-class local agents AND multi-tenant cloud.
- **ADR 31 framing clarifications (4.2)** — "Gateway: cluster-node level" → "Gateway: runtime root, useful at every deployment tier." `@agentick/cluster` provides substrate impls, not a separate harness type.
- **`V1-GATEWAY-PARITY-TRACKER.md` (4.3)** — explicit inventory of v1 Gateway capabilities matching the `V1-PARITY-TRACKER.md` pattern. Categories: gateway core (GG1–GG4), extension protocol (GE1–GE2), network transports (GT1–GT7), plugins (GP1–GP3), session management (GS1–GS5), method registry (GM1–GM6), auth (GA1–GA5), config (GC1–GC2), backpressure (GB1–GB3), static (GF1–GF2), tool confirmation (GTC1), devtools (GD1–GD2). Phase 4 closes 6; rest reshape or defer.
- **`GatewayHarness` scaffold (4.4)** — new files in `packages/spec/src/protocol/gateway-harness.ts` + `packages/gateway/src/v2/`. Spec defines `GatewayHarnessProtocol` (read-side apps surface, lifecycle, events), `GatewaySubstrateParent`, `CreateAppInput`, `GatewayExtension`/`GatewayInstaller`/`GatewayExtensions` for future extension impls. Impl ships `GatewayHarness extends BaseHarness<"gateway">` + `createGateway(options)` factory. Apps inherit gateway substrate by default; per-app substrate overrides supported (instance or factory). Close-op envelopes are bus-only via Option G `JournalingPolicy.override`. Package `./v2` subpath added to `packages/gateway/package.json` (matches sandbox v2 coexistence pattern). 11 tests passing.

**Workspace:** 5615/5615 tests green (was 5604; +11 gateway). Typecheck clean across all 86 packages.

**Phase 4 — engineering decisions made:**

- **`GatewayHarnessProtocol` keeps read-side only for apps.** `createApp(input)` is on the concrete impl (`GatewayHarness` from `@agentick/gateway/v2`), not on the protocol. Reason: typing input opts at the spec level would force pulling `@agentick/app-next`'s `AppHarnessOptions` into spec or making it opaque (useless for adopters). Concrete impls expose their own typed `createApp`; protocol consumers can enumerate apps but not construct them.
- **`EventLog<E, AppendError>` parameterised error channel** carried over from Phase C — Gateway uses default `never` (in-memory substrate, infallible appends).
- **No transports / plugins / auth in Phase 4.** Per ADR 31's "Gateway is optional, plugins reshape into extensions" + the parity tracker's reshape table. Tier 0 only — embedded library shape. Phase 5+ ships per-transport / per-plugin packages.
- **`gateway:app:created` event** emitted on the gateway bus when an App is registered. Adopters subscribing to `gateway.events({ surface: "gateway" })` see app construction observability without adapter wiring.

**Phase 4 — adopter-surface gaps acknowledged (not blockers):**

- `AppHarnessProtocol` / `SessionHarnessProtocol` don't expose `readonly id: string`. Adopters track app/session ids through the construction-time input (the caller-supplied appId / sessionId). Gateway's `app(id)` lookup works because the gateway tracks its own appId mapping. Worth a follow-up to add `id` to the protocols for symmetry with v1 ergonomics, but not Phase 4 scope.
- No example/v2-real or new example demonstrating Gateway hosting multiple Apps with per-tenant substrate factories. Worth adding before Phase 5 to exercise the multi-tenant emergent pattern.

**Previously, 2026-06-06 (earlier) — ADR 29 Phase C shipped: `EventLog<E, AppendError>` unified primitive; `LocalEventBus` ring buffer + cursor pull; `MemoryJournal` aligned to the same protocol; `bus.publish` → `bus.append` rename in lockstep with the spec extends; `tail` collapsed to sugar over `read`. Net Phase B+C delivers ~1.5–1.6× on the executor hot path; the cursor pull subsumed most of Phase B's relative win because the per-subscriber Effect.Queue model it replaced was the underlying bottleneck.**

**ADR 29 Phase C (this work block — sequenced C.1 through C.7):**

- **Spec — `EventLog<E, AppendError = never>` primitive** (new `packages/spec/src/protocol/event-log.ts`): `Cursor`, `CompiledMatcher<E>` generic, `CursorEvictedError`, `LogMetrics`, `EventLog<E, AppendError>` interface. Parameterised error type so bus uses `never` (in-memory, infallible) and journal uses `JournalError` (storage can fail).
- **Spec — `EventBus extends EventLog<ProtocolEvent>`**: `append`/`appendBatch`/`read(cursor, matcher)`/`hasSubscriberFor`/`metrics` inherited from the log primitive. `subscribe(query, options?)` is now sugar with `SubscribeOptions { fromCursor?: Cursor }`; failure channel flipped to `CursorEvictedError`. Old `bufferSize`/`overflow`/`SubscriberOverflow`/`BufferOverflowError` dropped (no longer meaningful under cursor pull).
- **Spec — `OperationJournal extends EventLog<ProtocolEvent, JournalError>`**: same inheritance. Old `OperationJournal.read(query, from)` renamed to `readByQuery(query, from)`; new `read(cursor, matcher)` is the EventLog primitive. `tail(query)` is now sugar over `read(currentHead, compileQuery(query))` with `CursorEvictedError → JournalError` mapping.
- **Runtime — `LocalEventBus` rewrite**: shared ring buffer (default `capacity: 4096`; configurable via `LocalEventBusOptions.capacity` and `defaultRetention.maxEvents`); per-subscriber cursor + `Promise`-based wake registered via `Effect.async`; `Stream.unfoldEffect` for clean stream-end on close. Phase B's batch accumulator + `publishLazy` + parent fan-in preserved.
- **Runtime — `MemoryJournal` aligned**: `tailListeners` set replaced by `cursorSubs`. Same `pullOne` pattern as `LocalEventBus`. Sliding-window event-rate metric via cheap two-counter scheme. **True wall-clock `cursorLagP99`** (not eps-approximation) — looks up `event.timestamp` at the subscriber's cursor position.
- **Audit + rename in lockstep**: every `bus.publish(...)` → `bus.append(...)` across BaseHarness, session-harness, channel-publisher, conformance suite, all tests, all benches. Every `journal.read(query, from)` → `journal.readByQuery(query, from)` across 8 test files + the v2 example. Caught a buggy `{ kind: "earliest" }` in `create-factory.spec.ts` that was passing TypeScript structurally but never matched a real `JournalReadFrom` variant.
- **C.5 collapsed into C.2**: old per-subscriber `Effect.Queue` path removed entirely — single code path through the ring buffer. No transitional state shipped.

**Phase C — engineering decisions made (documented in `blueprint/29-bus-overhaul.md`):**

- `EventBus`/`OperationJournal` extend `EventLog<E, AppendError>` as **parameterised interface** — bus and journal share the same primitive surface but specialize the append error channel.
- `LocalEventBusOptions.defaultRetention.maxEvents` defaults to **4096** with per-surface overrides via `LocalEventBusOptions.retention`. Pass `defaultRetention: {}` for unbounded.
- **Loud-failure backpressure**: cursor past retention → `CursorEvictedError` on the stream's failure channel. No silent skip-ahead. Adopters who want skip-ahead semantics catch the error and resubscribe with `oldestAvailable`.
- **`tail` is sugar over `read`** on both bus and journal. `tailListeners` removed from MemoryJournal — single cursor-pull mechanism.
- **`maxAge` retention is reserved by spec but not enforced** by either impl. Time-based eviction requires a periodic sweep; small lift, not Phase-C-critical. Documented as deferred.
- **Self-instrumentation deferred**: bus emitting its own metrics events would require a new `EventSurface` value or piggybacking on an existing one. Punted to ship alongside the L8 OTel projection.

**Phase C — bench numbers** (full results in `packages/runtime/src/__bench__/substrate-bench-results.md`):

| Path                                                    | Pre-Phase-B |          Phase B |                   Phase C |
| ------------------------------------------------------- | ----------: | ---------------: | ------------------------: |
| `OpenAIExecutor.run` 100 deltas + 1 sub (full hot path) |    1,558 hz | 2,679 hz (1.72×) | 2,448 hz (1.57× vs pre-B) |
| `bus.publish(executor:delta)` 1 sub batching OFF        |           — |          175K hz |            299K hz (+70%) |
| `bus.publish(executor:delta)` 3 subs batching OFF       |           — |           64K hz |            109K hz (+71%) |

The ring buffer made the unbatched baseline ~70% faster, which means **Phase B's relative batching win shrank from 1.89×/2.26× (Phase B) to 1.05×/1.16× (Phase C)** — but both absolute numbers are higher than Phase B's batched path. Net Phase B+C delivers ~1.5–1.6× on the executor hot path; most of it from Phase C's cursor pull, not Phase B's batching.

**Phase C — adopter-surface gaps acknowledged (not blockers):**

- Events don't carry their own cursor — adopters consuming `app.events(...)` have no way to capture a resume point from events they've already seen. The cursor protocol is wired through `bus.subscribe(query, { fromCursor })` (and `app.events(filter, { fromCursor })` per this commit), but actually using it requires either (a) carrying cursor on the envelope OR (b) emitting a "current cursor" probe. Either is small follow-up work; neither is in Phase C.
- `metrics()` is exposed on the bus, not on the app/session façade. Adopters who want metrics need bus access.
- No `example/v2-real` cursor-replay demo was added — the demo would require the adopter-surface work above to be usable. Documented honestly rather than shipping a contrived example.

**Workspace:** 5604/5604 tests green (3 skipped, 5 todo). Typecheck clean across 86 packages.

**Previously, 2026-06-05 — ADR 29 Phase B shipped: per-surface batched LocalEventBus + `publishBatch` direct path. Transparent ~1.7–1.9× win at one subscriber on the full OpenAI streaming path; 4.4× via explicit `publishBatch`. Honest writeup of the gap from ADR 29's 10× target (Phase A's `compileQuery` already moved the floor) in `packages/runtime/src/__bench__/substrate-bench-results.md`.**

**ADR 29 Phase B (this commit)**:

- **Spec** — `SurfaceBatchPolicy`, `SurfaceRetentionPolicy`, optional `JournalingPolicy.batch?`/`retention?` types added to `@agentick/spec-next/data/journaling-policy.ts`. Optional `EventBus.publishBatch?` added to `@agentick/spec-next/protocol/bus.ts` (technically-accurate Phase B name; renames to `appendBatch` when Phase C unifies under `EventLog<E>`).
- **Runtime** — `LocalEventBus` gained a per-surface batch accumulator with two flush triggers (time-window via `setTimeout`, count-cap on push). `LocalEventBusOptions.batch?` accepts adopter policy; defaults to `DEFAULT_LOCAL_BUS_BATCH_POLICY` (exported constant — only `executor:delta` 8ms/4 ships by default; ADR 29 draft's `session:metric` was dead config keyed against a non-existent phase, dropped). `publishBatch` direct path bypasses the accumulator entirely. Chained close-drain (caught + fixed a race between `Effect.runFork(dispatch)` and `Effect.runFork(Queue.shutdown)` where queue could shut down first).
- **Executors** — zero adapter code changes needed. `OpenAIExecutor extends BaseHarness<"executor">` + `emitDeltaLazy(streamOp, () => delta)` → `bus.publish` with `surface=executor phase=delta` automatically hits the batched path.
- **Tests** — 16 new batching specs in `packages/runtime/src/__tests__/local-event-bus-batching.spec.ts`; 3 type-only specs in `packages/spec/src/__tests__/types.spec.ts`. All existing bus tests still green (they use surfaces/phases that don't match the default policy, so they fly through the immediate path).
- **Benches** — 6 new Phase B scenarios in `packages/runtime/src/__bench__/substrate.bench.ts` + 2 A/B scenarios in `packages/executor-openai/src/__bench__/streaming.bench.ts`. Full numbers in `packages/runtime/src/__bench__/substrate-bench-results.md`.
- **Workspace** — 5582/5582 tests green (3 skipped, 5 todo). Typecheck clean across all 86 packages.

**Honest read against ADR 29's 10× per-delta target:** that target was anchored to a 2026-06-02 measurement of "+20 μs per delta with one subscriber" (full executor.run path). Phase A's `compileQuery` (already shipped) moved the bus-only baseline from ~20 μs to ~5.7 μs/publish — a ~3.5× cheaper floor than the figure ADR 29 was written against. Against today's actual baseline, Phase B's transparent win is **1.7–2.3× at 1 sub, 2.3× at 3 subs**; `publishBatch` direct delivers **4.4×** on 8-event batches. Remaining cost is dominated by `Effect.runPromise`/`Effect.suspend` runtime entrance (~3 μs floor) which batching cannot reduce. Pushing further requires either executor-level explicit batching (deferred — invasive, low marginal benefit) or sync `publishUnsafe` (out of Phase B scope).

**Previously, 2026-06-02 — G9 + G11 closed; layered providerOptions architecture across all four executors; ADR 29 (bus overhaul) proposed; pre-compiled query matchers shipped (Phase A of ADR 29).**

`@agentick/executor-google-next` shipped covering G9: full streaming + non-streaming through `@google/genai`, Vertex AI + Gemini Developer API paths via `clientOptions: GoogleGenAIOptions`, thoughtSignature round-trip for Gemini 3+ thinking (without it, multi-turn tool use returns `MISSING_THOUGHT_SIGNATURE`), `part.thought === true` routing to the reasoning channel (Gemini 2.5+), single-pass stream accumulator that builds `ContentBlock[]` directly during streaming, full 16-entry FinishReason map, `thoughtsTokenCount`/`cachedContentTokenCount` surfacing, `sanitizeSchemaForGemini` ported from v1, parseThinkTags + customBlocks via the shared `StreamTagParser`. 54/54 tests in the package (35 provider-specific + 15 conformance + 4 factory).

**Layered providerOptions** landed across all four executors (closes G11): three new empty-seed augmentable interfaces in `@agentick/spec-next` (`ProviderClientOptions`, `ProviderOptions`, `ProviderToolOptions`) mirroring v1's `ProviderClientOptions`/`ProviderGenerationOptions`/`ProviderToolOptions` triad. Each adapter contributes its slots typed as the SDK's actual config types — no hand-rolled subsets. OpenAI: `OpenAI.ClientOptions` / `Partial<ChatCompletionCreateParams>` / `Partial<FunctionDefinition>`. Anthropic: `Anthropic.ClientOptions` / `Partial<MessageCreateParams>` / `Partial<AnthropicTool>`. Google: `GoogleGenAIOptions` / `GenerateContentConfig` / `Partial<FunctionDeclaration>`. Each executor's construction options now nest SDK config under `clientOptions` (replacing flat `apiKey`/`baseURL`/etc. fields). `ToolDeclaration.providerOptions?` extends `ToolDeclaration`; `buildTools` in every executor forwards it through projection. **Anthropic `cacheControl` meta-knob removed entirely** — per-block cache control now flows via `BaseContentBlock.providerMetadata.anthropic.cacheControl` (per-block adopter stamps the specific block; executor reads it and stamps SDK `cache_control` on the corresponding param). `providerMetadata?` lifted from `ToolUseBlock` onto `BaseContentBlock` so every block type carries per-block round-trip data (Anthropic cache_control, Gemini thoughtSignature, future OpenAI logprobs).

**Streaming adapter benchmarks landed** (`packages/executor-{openai,anthropic,google}/src/__bench__/streaming.bench.ts` + dated entry in REFACTOR-SCRATCHPAD `§2026-06-02`). Numbers: no-subscriber per-delta is ~2 μs across all three adapters (OpenAI 2.20 μs, Anthropic 1.72 μs, Google 1.79 μs); the dual-walk pattern in OpenAI/Anthropic costs only ~0.4 μs more than Google's single-pass. **The real cost is subscriber fan-out: +20 μs per delta the moment ONE subscriber attaches** — 10× the no-sub baseline. Drives ADR 29's prioritization (batching > leaner aggregation).

**ADR 29 — Bus overhaul** proposed at `blueprint/29-bus-overhaul.md`. Phased rollout toward multi-tenant cloud + cluster-ready substrate: (A) pre-compiled queries [SHIPPED], (B) batched LocalEventBus with per-surface policy, (C) cursor protocol + ring buffer impl swap, (D) `@agentick/cluster` backend. Captures the architectural picture (unified `EventLog<E>` primitive, structural tenancy at the log level, gossip-replicated distributed `hasSubscriber`) and names four open design decisions for review before Phase B lands.

**Phase A shipped this session**: `compileQuery(query): CompiledMatcher` exported from `@agentick/runtime-next`; specialises per-event filter from a query-union walk to a 2-comparison closure for typical `{ surface, phase }` shapes. Wired into `LocalEventBus.subscribe` (per-subscriber matcher), `MemoryJournal` tail listeners, and `MemoryJournal.read`. 24-test correctness spec assert agreement with `matchesQuery` across every shape; bench numbers (1.65× – 2.49× faster) appended to substrate.bench.ts. 89/89 runtime + 402/402 across substrate + executors green.

**Previously, 2026-05-27:** **FAÇADE.6 shipped + `@agentick/reconciler-next` package extracted**. The four deferred callback-style factories landed: `defineToolExecutor`, `defineLoop`, `defineSession`, `defineReconciler` — same pattern as the existing `defineExecutor` (callback bundle → marker-tagged factory). Spec gained the corresponding `XFactory` / `XFactoryDeps` / `isXFactory` type-guard triple per harness. `AppHarness` slots widened to accept factories alongside instances/options: `tools`, `loop`, `reconciler` all detect the marker and invoke the factory with the shared substrate so harness events flow through `app.events()` automatically. `defineReconciler` initially shipped in `@agentick/runtime-next`; relocated immediately into the new **`@agentick/reconciler-next`** package as the reconciler-agnostic base. The split matches the existing pattern (`@agentick/executor-next` base + `@agentick/executor-openai-next` concrete; `@agentick/reconciler-next` base + `@agentick/reconciler-react-next` concrete). New-package checklist completed (changeset linked, typedoc entry, vitepress group, README). **Honest assessment of the factories captured in scratchpad:** they are substrate-wiring sugar, not full replacements for the reference subclasses — most reference-impl ergonomics (validation pipeline, lifecycle events, middleware hooks, state stores) are NOT replicated. defineX is the right tool for test stubs, simple adapter patterns, and protocol-conforming mocks; subclassing `BaseHarness<X>` remains the path for production-quality custom impls. Documented this trade-off so users aren't surprised. **Also captured in scratchpad: the model-catalog / `ModelAdapter` architecture** as a deferred design note (resolves the `executor-openai` naming concern by re-shaping concrete provider impls as adapters consumed by a native executor, with capabilities lookup uniform across native + ai-sdk paths). 19 new tests across the four define APIs; 5314/5314 effective tests pass; 2 pre-existing executor-ai-sdk msw failures unchanged.

**Previously, 2026-05-23:** **End-to-end real-model example landed** (`example/v2-real/`). Validates v2 ergonomics with a real OpenAI model via `@agentick/executor-ai-sdk-next` + `@ai-sdk/openai`. Writing the example surfaced three missing ergonomic affordances which were filled inline: (1) **`app.send(input: string | SendInput): Promise<SendResult>`** — Vercel-grade shortcut over `runOnce` for the 90% case (plain prompt → final result); (2) **`app.close()` alias** — natural counterpart to `session.close()` / `harness.close()` (thin alias for `closeApp`); (3) **Semantic role components** — `<System>`, `<User>`, `<Assistant>` as pass-through wrappers over `<Message role="...">`, plus block-level `<Paragraph>`, `<H1>`, `<H2>`, `<H3>` over the `paragraph` / `heading` intrinsics. All trivial wrappers (no behavior) but lift the user surface from "JSX boilerplate" to "JSX prose." The example agent (~30 LOC) renders a `<System>` prompt, declares a `Calculator` tool inline via `createTool` (zod schema + inline handler), exposes a `verbose` knob via `useKnob`, renders `<Knobs />` to auto-emit `set_knob`. The runner (~15 LOC) is `createApp(<Agent />, { executor: aisdk({ model: openai("gpt-4o-mini") }) })` + `await app.send("prompt")`. Full workspace typecheck green (86 packages). End-to-end run pending adopter's `OPENAI_API_KEY`. Lesson reinforced: the example is the unit test for ergonomics — write it BEFORE freezing the user surface. See REFACTOR-SCRATCHPAD.md "2026-05-23 — End-to-end real-model example landed" for the punt list.

**Previously, 2026-05-26:** **ADR 27 landed: modular built-ins**. Built-in extensions (timeline, knobs, state, gates) now follow the IDENTICAL pattern as optional extensions (sandbox, mcp): per-harness package layout, TypeScript module augmentation for `HookBridges` slot registration, `/react` subpath convention, `/testing` subpath convention. Difference between built-in and optional is shipping only — built-ins are private workspace packages bundled into the `agentick` metapackage; optionals are public packages installed separately. `@agentick/spec-next`'s `HookBridges` is an empty seed; every harness augments its own slot via `declare module "@agentick/spec-next"`. `@agentick/reconciler-react-next` has NO dependency on any harness package and is a true leaf — its snapshot/restore iterates `Object.entries(bridges)` generically via `SnapshotCapable` feature-detection (no hardcoded slot names). **Hooks and components relocated:** `useKnob` + `<Knobs>` → `@agentick/knobs-next/react`, `useTimeline` + `<Timeline>` + `compactEntries` → `@agentick/timeline-next/react`, `useSessionState` → `@agentick/state-next/react`. Each harness's `/react/index.ts` does `import "../augment.js"` to register its slot. **Per-harness `/testing` subpaths** house the real `stubXHarness` factories. **Integration tests relocated** to their harness packages (`@agentick/knobs-next/__tests__/integration-with-reconciler.spec.tsx`, etc.); cross-harness snapshot tests moved to `@agentick/session-next`. Reconciler-react's tests use mock-protocol bridges where needed (the `mockTimelineHarness` / `mockKnobsHarness` / `mockStateHarness` in `reconciler-react/src/bridges/stub-bridges.ts`). **Real cycle break achieved** — turbo no longer detects any workspace cycle; any future harness can add a `/react` subpath without architectural risk. ADR 27 doc + REFACTOR-SCRATCHPAD.md document the journey; CLAUDE.md carries the principles as foundational. 5501 workspace tests green (5312 + 189 tui).

**Previously, 2026-05-26 (earlier):** ADR 26 Step 5a follow-up: **post-migration cruft cleanup** + **pending-messages on TimelineHarness**. **Cleanup pass** (commit `94a2d0c1`): rewrote `packages/spec/src/__tests__/reconciler-protocol.spec.ts` to drop dead `KnobBridge`/`TimelineBridge`/`TimelineSnapshot`-old type imports + their test sections (only passing because vitest's esbuild strips types — broken at the type level); retargeted 6 comment-rot sites referring to retired `KnobBridge`/`TimelineBridge`/`StateBridge` interfaces (`example/v2/substrate.ts`, `spec/protocol/session-harness.ts`, `spec/data/reconciler-snapshot.ts`, `sandbox/v2/acl.ts`, `knobs/harness.ts`, `reconciler-react/harness/reconciler-harness.ts`); tightened extension factory docs (`withTimeline`/`withKnobs`/`withState`) from "compiles but not yet invoked" v1→v2 leftover wording to explicit "ADR 26 Step 8 — pending" planning notes. Left alone: session/app inbox dispatch "not yet wired" stubs (legit deferred work) and v1 ↔ v2 `TimelineEntry` namespace collision (Phase 6 sunset territory). **Pending-messages** (this commit): added the **third tier** to TimelineHarness — pending queue alongside log and projection, mirroring v1's `_queuedMessages` / `ExecutionMessage` pattern. New protocol surface: sync `readPending(): readonly PendingEntry[]`; async `queue(input): Promise<{id}>` (pushes pending, no log/projection write; returns stable id) and `drain(): Promise<{entries}>` (moves pending → log + projection via per-entry `appendEffect` calls, returns drained entries). `subscribe` is one signal — fires on either projection OR pending change. `appendEffect` is a new private Effect-native variant of `append` so `drain`'s inner calls compose within the same Effect fiber and the substrate's FiberRef-based parent auto-threading lands `parentOpId` on every append envelope (Step 3.5 capability exercised at scale). Inbox-addressable at `"timeline:queue"` and `"timeline:drain"`. **Session integration:** `SessionHarness.queue()` and `SessionHarness.sendBody`'s input-messages loop now route user-input through `bridges.timeline.queue()` instead of direct append; `sendBody` drains pending into the durable timeline at the start of every execution before the first tick. Per-tick mid-execution drain deferred (Step 6+). New `queueInputMessage` helper supersedes the old `appendInputMessage`. 5344 workspace tests green (+18 from new pending conformance + unit tests covering envelope emission, parent-causality, inbox routing, interleave with append, metadata preservation); 2 pre-existing `executor-ai-sdk/msw` failures unchanged.

**Previously, 2026-05-24:** ADR 26 Step 5a: TimelineHarness extraction with two-tier (log + projection) model. New private workspace package `@agentick/timeline-next` housing `TimelineHarness extends BaseHarness<"timeline">`. **Two-tier storage:** `persisted` is an append-only durable log (the system of record for "what happened"); `projection` is the materialized view consumers read (`useTimeline`, formatter). Normally a live mirror; after `compact`/`replaceProjection`/`resetProjection`, can diverge. This is event-sourcing + CQRS in CS terms — direct prior art is Greg Young's CQRS, LSM/WAL + compaction, git's object-db vs working-tree split. The novel piece is that the projection function is non-deterministic (LLM-driven) with strategy metadata recorded on the snapshot for replayable rehydrate. **Protocol:** sync `read`/`subscribe` (projection-level) + `readPersisted` (log); async Operations `append` (writes to both), `compact(strategy)` (rewrites projection only), `replaceProjection` (overwrite), `resetProjection` (rebuild as mirror); `exportSnapshot`/`importSnapshot` with three modes ("as-is" / "persisted-only" / "rehydrate" — rehydrate requires a strategy). **Compaction strategy** is an opaque object built by factories (`withHandler` ships in 5a; `withModel` + `withApp` deferred to 5b). Strategy.metadata is preserved on the snapshot's `lastCompaction` for snapshot fidelity. **Storage migration:** `SessionStateStore._timeline`/`_timelineVersion` removed; SessionHarness constructs TimelineHarness via session-bridges with the session's substrate (`timeline:{sessionId}:timeline`); `applyExecutorResult`/`applyToolResults`/`appendEntry` are now async paths that await `bridges.timeline.append`; `SessionHarness.timeline()` returns the projection; `SessionHarness.snapshot()` carries the persisted log (Step 6 will compose per-harness snapshots into the SessionSnapshot shape). **Reconciler-react:** `useTimeline` reads the projection unchanged; `<Timeline>` + `compactEntries` migrated to consume the full `TimelineEntry[]` (kind-discriminated) — `TimelineEntrySummary` retired, components filter `kind === "message"` directly. `TimelineBridge`/`TimelineSnapshot` (old shape)/`TimelineEntrySummary` deleted from spec. `stubTimelineBridge` → `stubTimelineHarness(initial?: TimelineEntry[])`; old `runTimelineBridgeConformance` retired in favor of `runTimelineHarnessConformance`. **Session bridge close hygiene:** SessionHarness.close iterates over every bridge with a `close()` method (built-ins + extension-installed) and shuts them all down — not a hardcoded triple. Inbox-addressable: `"timeline:append"`, `"timeline:replaceProjection"`, `"timeline:resetProjection"` (compact is NOT inbox-addressable because the strategy carries a function reference; cross-process compaction would route through a higher-level surface). 5328 workspace tests green (+43 from new timeline harness + conformance + migrated tests); 2 pre-existing `executor-ai-sdk/msw` failures unchanged.

**Previously, 2026-05-23 (later):** ADR 26 Steps 3.5 + 4: parentOpId envelope projection + gates package extraction. **Step 3.5:** Added `parentOpId?: string` to `EventEnvelope`; `BaseHarness.makeEvent` projects `op.parentOpId` onto every emitted envelope. The substrate already auto-threaded parentOpId via the `RuntimeContext` FiberRef + stamped it on the Operation/OTel span — this surfaces it on the bus stream so subscribers see the causality tree without inspecting spans. New plumbing test (`packages/runtime/src/__tests__/harness-plumbing.spec.ts`) proves Effect-native nested `runOperation` auto-threads parentOpId onto every child envelope phase. Known gap (documented in the existing Promise-bridged parent/child test): when a parent's body crosses `Effect.promise(() => child.set())`, the child's fresh fiber doesn't inherit the parent's FiberRef and auto-propagation is lost; Promise-bridged composition must thread parentOpId explicitly. Effect-native composition (canonical shape) propagates automatically. **Step 4:** Extracted gates to new private workspace package `@agentick/gates-next` — `useGate` + `gate()` descriptor + `GateDescriptor`/`GateState`/`GateValue` types moved from `reconciler-react/react/hooks/use-gate.ts`. Gates is NOT a harness; gates have no independent state — the gate's value IS a knob value (a three-state `inactive`/`active`/`deferred` knob in the "gates" group). Pure hook composition over `@agentick/knobs-next` + reconciler-react's `useKnob`/`useLoopControl`/`useOnTickEnd`. The "seven harnesses" list stays at seven — gates is a _pattern_ over knobs, not a primitive. `useGate`/`gate` removed from reconciler-react's package index; `UseKnobOptions` type now re-exported from reconciler-react's index for cross-package consumption. 9 gate tests moved + green; 5285 workspace tests pass; 2 pre-existing `executor-ai-sdk/msw` failures unchanged.

**Previously, 2026-05-23:** ADR 26 Step 3a — StateHarness extraction. New private workspace package `@agentick/state-next` housing `StateHarness extends BaseHarness<"state">` — the "adopter stash" backing `useSessionState`. Sync `get/has/list/subscribe/subscribeAll` + async `set/delete` through `runOperation`; inbox-addressable at `state:{scopeId}`; `exportSnapshot`/`importSnapshot` for hibernate/restore; conformance suite (`runStateHarnessConformance`) covering envelope flow + inbox routing + snapshot round-trip. `StateHarnessProtocol` added to `@agentick/spec-next/protocol/state-harness.ts`; `StateBridge` interface deleted from `hook-bridges.ts`; `HookBridges.state` now typed as `StateHarnessProtocol`. Session-bridges (`@agentick/session-next/src/session-bridges.ts`) constructs `new StateHarness(${store.id}:state, journal, bus, inbox)` with the session's substrate. `useSessionState` in reconciler-react uses async fire-and-forget + `getSnapshot` fallback to `initial` (mirrors the useKnob pattern from Step 2.5). `inMemoryStateBridge` deleted from reconciler-react (replaced by `stubStateHarness()` factory). Step 3b (compose KnobsHarness on StateHarness) **abandoned** — composition layers conceptually right but costs (different listener semantics, different envelope surface, nested-Operation orchestration) outweigh the ~50 LOC of shared Map boilerplate; kept as parallel implementations following the same pattern. 5284 workspace tests green (16 new state tests); 2 pre-existing `executor-ai-sdk/msw` failures unchanged.

**Previously, 2026-05-22:** ADR 26 Steps 1, 1.5, 2, 2.5 — Extension protocol + KnobsHarness extraction + dead-code cleanup. Reshaped `@agentick/spec-next`'s extension types to a discriminated union by `target` (`AppExtension | SessionExtension`, open via `(string & {})`); per-host installer interfaces (`AppInstaller` / `SessionInstaller`) with minimal surface (`hostId`, `substrate`, `registerNamespace`, `getNamespace`, `onClose`); `AppExtensions` / `SessionExtensions` augmentation slots. AppHarness adopts new shape: `extensions` accepts `Extension[]`, filters by target, `registerBridge` → `registerNamespace`, `uninstall` retired in favor of `installer.onClose(handler)`. Step 1.5 harness-plumbing test graph in `@agentick/runtime-next/__tests__/` proves substrate primitives via toy harnesses (12 tests). `MessageEnvelopeInput<T>` cleanup: inbox.send/ask take an input type; inbox stamps `addressedTo`/`timestamp`/`messageId(ULID)`. Step 2 extracts `@agentick/knobs-next` private workspace package with `KnobsHarness extends BaseHarness<"knobs">` — sync get/has/list/subscribe/subscribeAll + async set/register/dispatch through `runOperation`; inbox-addressable at `knobs:{scopeId}`; full v1 set_knob validation pipeline lives in dispatch; conformance suite. Step 2.5 (this commit) wires KnobsHarness into core SessionHarness as a default required surface — session-bridges constructs the harness with the session's substrate; useKnob in reconciler-react uses async fire-and-forget + `getSnapshot` fallback to `initial`; `<Knobs/>` set_knob tool delegates to `harness.dispatch()` directly; `KnobBridge` interface deleted from spec; `inMemoryKnobBridge` deleted from reconciler-react (replaced by `stubKnobsHarness()` factory); old `runKnobBridgeConformance` retired. 5267 workspace tests green; 2 pre-existing `executor-ai-sdk/msw` failures unchanged. Open: bus subscribe is lazy via Stream — caller-side race (subscribe-then-publish drops events) requires `setImmediate` workaround in tests. Effect-idiomatic fix: reshape `bus.subscribe(filter)` to return `Effect<Stream<...>>` so acquisition registers the subscriber eagerly; remote late-joiner replay via `PubSub.sliding(N)` when cluster substrate lands. Tracked but not blocking; revisit alongside L5/L6 substrate scalability.

**Previously, 2026-05-21:** Component port batch — `<Timeline>`, `<Message>`, `<Section>`, `useGate`/`gate()`, `useKnob` descriptor extension, `<Knobs/>`. Timeline reads via `useTimeline()`/`TimelineBridge`; default render is `<Message {...entry} />` (the contributor's new `content` prop takes spec-shape `ContentBlock[]` verbatim, v1 precedence: non-empty prop wins, else children). `<content blocks=…>` passthrough intrinsic kept for niches `<Message>`'s content prop can't serve (cross-container injection in `<section>`/`<ephemeral>`/etc., mixed authored+pre-built compositions). Token-budget compaction (`maxTokens`/`strategy`/`headroom`/`preserveRoles`/`guidance` with truncate + sliding-window + custom-function escape hatch). `useGate` + `gate()` ported as knob-backed continuation conditions — composes `useKnob` + `useOnTickEnd` + `useLoopControl`; auto-renders `<Section>` with instructions only while active. KnobBridge spec extended with `register(id, descriptor)` + `subscribeAll(listener)`; `KnobDescriptor`/`KnobRegistration` carry v1's full surface (description, valueType, group, options, min/max/step, maxLength/pattern, required, momentary, inline, validate, schema — `validate` is a function ref, non-serializable, dropped by cross-process bridges). `useKnob(id, initial, options?)` accepts the full descriptor surface; two-phase init (synchronous `set` seed + deferred `register` in `useEffect`) avoids setState-in-render. Momentary resets at execution-end via `useOnExecutionEnd`. `<Knobs/>` ships default + render-prop + `Knobs.Provider`/`Knobs.Controls`/`useKnobsContext` modes; emits `set_knob` tool via `createTool` with `use()` capturing the bridge; v1's validation pipeline (exactly-one(name,group) → exists → type → options → bounds → length/pattern → custom validate); atomic group dispatch with type-mismatch detection. `InMemoryKnobBridge.list()` and `stubTimelineBridge.read()` now cache snapshot refs between mutations — without it `useSyncExternalStore` infinite-loops (recurring v2 gotcha worth a spec note). Dropped from v1: `Timeline.Provider`/`Timeline.Messages`, `useConversationHistory`, pending/queued message rendering (deferred until a v2 queued-messages bridge surface exists). Deliberately NOT ported yet: `<Ephemeral>`/`<Grounding>` — only consumer in v1 was gates' auto-render, replaced with `<Section>`; real interleave/role-mapping value depends on richer `TargetCapabilities` than v2 has today. 829 workspace tests green; 43 KnobBridge conformance tests (was 37).)

This is the **running progress log** for v2 implementation. Update it
every session. New contributors / sessions read this first.

Related docs:

- [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md) — overall phasing,
  exit criteria, risk register
- [`blueprint/`](./blueprint/) — architectural contracts (~24 docs)
- [`blueprint/17-open-questions.md`](./blueprint/17-open-questions.md) —
  unresolved design decisions

## Current state

```
Phase 0  ■ in progress — workspace setup
  ✓ Spec + spec-conformance packages scaffolded (committed)
  ✓ Nomenclature rename pass (compiler→reconciler, renderer→formatter,
    CompiledStructure→RenderedTree, useContinuation→useLoopControl)
  ✗ Package renames (still pending decisions — defer to convenience)
  ✗ Website / typedoc updates (deferred to end of Phase 0)

Phase 1  ■ in progress — spec package type population
  ✓ Foundation-critical types (envelopes, outcomes, errors, policy)
  ✓ Substrate protocol interfaces (journal, bus, inbox)
  ✓ Reconciler-related wire types (RenderedTree, ContextSpec,
    MessageEntry, SectionEntry, ContentBlock, SemanticNode,
    FormatterRef, FormatInput/Result, RuntimeDeclarations, etc.)
    — landed 2026-05-15, unblocks Phase 3
  ✓ Executor wire types (ExecutionResult, ExecutorTerminal,
    LanguageModelExecutionResult, ExecutionTarget) — landed 2026-05-15
  ✗ Channels, Timeline, Knobs, ReconcilerSnapshot, SessionRecord
    (later phases)

Phase 2  ✓ in-memory substrate — MemoryJournal, LocalEventBus,
         LocalInbox, BaseHarness implemented in @agentick/runtime.
         Effect-native protocols (Effect<R,E,never> / Stream<E,F,never>);
         FiberRef-based RuntimeContext substrate; conformance suites
         populated for journal + bus + inbox; 4953 workspace tests green;
         full workspace typecheck clean.
Phase 3  ■ in progress — RECONCILER HARNESS
         ✓ 3.1 ReconcilerProtocol + I/O + errors + inbox messages
         ✓ 3.2 ReconcilerSnapshot + diagnostics
         ✓ 3.3 HookBridges (DataBridge no-Suspense contract)
         ✓ 3.4 @agentick/reconciler-react-next package scaffold
         ✓ 3.5 host layer (HostInstance / HostScope / Container)
         ✓ 3.6 host-config + react-reconciler init (React 19)
         ✓ 3.7 Contributor protocol + IRFragment + ContributorRegistry
         ✓ 3.8 Built-in contributors (section/message/tool/resource/
               output/mcp/model)
         ✓ 3.9 collect walker + foldFragments → RenderedTree
         ✓ 3.10a ReconcilerHarness BaseHarness subclass
         ✓ 3.10b InMemoryDataBridge + stub bridges
         ✓ 3.10c render-until-stable loop (no-Suspense useData async path)
         ✓ 3.11 BridgeContext + 5 hooks (useData/useKnob/useTimeline/
               useLoopControl/useSession)
         ✓ 3.12 Lifecycle hooks + tick-start catch-up (useOnTickStart/End,
               useOnExecutionStart/End, useOnError, useOnMount/Unmount)
         ✓ 3.13 Formatter scope providers (FormatScope + Markdown/XML/PlainText)
         ✓ 3.14 runReconcilerConformance + bridge conformance suites
         ✗ 3.15 Snapshot/restore concrete impls (hook state capture)
Phase 4  ■ in progress — REMAINING HARNESSES
         ✓ 4a.1 ToolExecutorProtocol + I/O + errors + inbox + lifecycle (spec)
         ✓ 4a.2 runToolExecutorConformance + FixtureToolSpec
         ✓ 4a.3 @agentick/tool-executor-next package scaffold
         ✓ 4a.4 Harness skeleton + registry + handler resolver + validators +
                dispatch happy path + abort + handler errors + timeout.
                53/53 tool-executor tests; 16/16 conformance pass against
                the reference impl. (Lifecycle event emission, confirmation
                flow, middleware are deferred to 4a.5+.)
         ✗ 4a.5 Confirmation flow + framework channel
         ✗ 4a.6 Middleware + lifecycle handler hooks
         ✗ 4a.7 Inbox dispatcher (abort + confirmation-response)
         ✗ 4a.8 v1 tool tests port + parity sweep
         ✓ 4b.1 ExecutorProtocol + LanguageModelExecutor spec types
         ✓ 4b.2 runExecutorConformance suite
         ✓ 4b.3 @agentick/executor-next package + MockLanguageModelExecutor
                reference impl (12/12 tests; 6 conformance + 6 impl-specific)
         ✓ 4b.4 example/v2 executor scenario — JSX → RenderedTree →
                executor.run → streaming deltas → ExecutionResult
         ■ 4c   Provider adapters
                ✓ 4c.1 @agentick/executor-openai-next package scaffold
                ✓ 4c.2 OpenAIExecutor extends BaseHarness<"executor">
                       implements LanguageModelExecutor (project/execute/
                       normalize/run/abort). Promise-typed surface via
                       runHarnessProtocol; per-tick opId composition;
                       SDK injection point for tests.
                ✓ 4c.3 tool-use round-trip + streaming deltas
                       (StreamAccumulator reconstructs ChatCompletion from
                       chunks; emitDeltaLazy per chunk via Effect-driven
                       iterator drive; finish_reason → stopReason map).
                ✓ 4c.4 stub-client tests (8 OpenAI-specific: non-streaming,
                       model id passthrough, finish_reason mapping, tool
                       extraction, tool_result threading, abort, streaming
                       deltas, journaled lifecycle)
                ✓ 4c.5 runExecutorConformance against OpenAIExecutor
                       (6/6 pass — identical contract to mock)
                ✗ 4c.6 Anthropic, Google, AI SDK adapters
                ✗ 4c.7 example/v2 wired through real provider (deferred
                       — no API key in CI)
         ✓ 4d.1 LoopExecutorProtocol + StateApplicator spec types
         ✓ 4d.2 runLoopExecutorConformance suite (5 scenarios:
                happy path, applyExecutorResult call count,
                tool-call round-trip, max ticks, abort no-op)
         ✓ 4d.3 @agentick/loop-executor-next package +
                LoopExecutorHarness + NoopStateApplicator
                (5/5 conformance tests pass against reference impl)
         ✓ 4d.4 example/v2 loop scenario — multi-tick agent loop:
                tick 1 returns tool_use → loop dispatches calculator
                → tick 2 returns final text → terminal "end". Streaming
                deltas observed on the bus. 2 ticks, 1 tool dispatch.
         ✓ 4e.1 SessionHarnessProtocol spec types (minimum surface:
                send, close, timeline, snapshot, StateApplicator
                methods, notifyLifecycle). SessionMessage, TimelineEntry,
                SendInput, SendResult, SessionExecutionHandle,
                SessionSnapshot, SessionError taxonomy.
         ✗ 4e.2 runSessionConformance suite (deferred — impl proven
                via example end-to-end)
         ✓ 4e.3 @agentick/session-next package + SessionHarness:
                  - SessionStateStore — in-memory timeline + status +
                    usage + listeners
                  - session-bridges — HookBridges backed by session
                    state (TimelineBridge reads accumulated timeline,
                    KnobBridge in-memory)
                  - session-execution-handle — AsyncIterable + .result
                    dual-shape handle
                  - SessionHarness — owns mount, implements
                    StateApplicator (real timeline writes), delegates
                    send() to LoopExecutorHarness
         ✓ 4e.4 example/v2 session.send({ messages }) — end-to-end:
                user message → render → executor → tool_use →
                dispatch calculator → timeline append (assistant +
                tool result) → render → executor returns final text →
                stopReason "end". 2 ticks, 1 tool dispatch, timeline
                with 4 entries.
         ■ 4f   App harness
                ✓ 4f.1 AppHarnessProtocol spec types (createSession,
                       runOnce, getSession, listSessions, closeApp);
                       CreateSessionInput, RunOnceInput/Result,
                       SessionEntry, SessionFilter, AppError taxonomy.
                       Spec stays React-agnostic — construction options
                       live in the impl package.
                ✓ 4f.2 @agentick/app-next package + AppHarness:
                        - Shared substrate (journal/bus/inbox) + shared
                          sub-harnesses (reconciler, loop) — one
                          instance per app, reused by every session
                        - Per-session ToolExecutorHarness (so JSX-
                          declared tools don't bleed between sessions),
                          shared HandlerResolver
                        - In-memory SessionRegistry with metadata filter
                        - Promise-typed surface via runHarnessProtocol
                        - 6/6 smoke tests pass: createSession + send,
                          listSessions filter, duplicate-id reject,
                          runOnce ephemeral dispose, closeApp guard,
                          direct constructor variant
                ✓ 4f.3 example/v2 scenarioAppHarness — createApp(<Agent />,
                       opts) → runOnce + createSession + listSessions
                       + closeApp end-to-end. Verifies the ergonomic
                       surface wraps everything below.
                ✓ 4f.4 RECONCILER-AGNOSTIC TYPING — session/app types
                       changed from `ReactNode` to `unknown`. The spec
                       was already renderer-agnostic
                       (`MountInput.element: unknown`); the impls had
                       drifted. React/Angular/etc. reconcilers all
                       satisfy the contract with no app/session change.
                ✓ 4f.5 SLOT-PATTERN CONFIG CASCADE — every parent
                       harness's options now accept child slots as
                       either a pre-built instance OR an options bag
                       for the default impl. CSS shorthand/longhand
                       semantics: per-call > app-level longhand
                       (`session.defaultMaxTicks`) > app-level shorthand
                       (`defaultMaxTicks`) > framework default.
                         - AppHarnessOptions.reconciler: instance | opts
                         - AppHarnessOptions.loop: instance only (no
                           opts on LoopExecutorHarness today)
                         - AppHarnessOptions.tools: per-session
                           ToolExecutor defaults
                         - AppHarnessOptions.session: per-session
                           SessionHarness defaults
                       Duck-typed slot resolution (`mount()` discriminator
                       for reconciler). Same leak fixed on SessionHarness:
                       `reconciler`/`loop` are now ReconcilerProtocol /
                       LoopExecutorProtocol (was concrete classes).
                ✓ 4f.6a app.events(filter?) cross-session subscription —
                       AsyncIterable<ProtocolEvent> over the app's bus.
                       Filter via EventQuery. Multi-subscriber; clean
                       cleanup on break-out via Fiber.interrupt.
                       3 tests pass (filter, multi-sub, close).
                       NOTE: caller-supplied executor must share the
                       app's substrate (journal/bus/inbox) to appear in
                       app.events(). When the executor is constructed
                       with its own substrate, its events stay private
                       — a feature for isolation, a footgun for naive
                       use. Slot-pattern for executor (instance | opts
                       so app constructs with its own substrate) is a
                       future ergonomics fix; documented in the test
                       helper for now.
                ✗ 4f.6b use() integrations (interceptors + observers
                        + services registry)
                ✗ 4f.7 persistence + telemetry Layer slots
Phase 5  □ Adapters, cluster, gateway
Phase 6  □ v1 sunset
```

## Known loose ends (track-but-not-blocking)

Captured 2026-05-15 so these don't fall off the radar while we move on.
Most are addressed later — none of them gate the next priority
(conformance suites, 3.14). Listed here so any later session can pick
up the right one.

### Stubs / placeholders to flesh out

- ~~renderToString / renderResource return spec-shaped empty payloads~~
  ✓ renderToString implemented 2026-05-15 with default markdown/xml/text
  serializer. renderResource dropped — over-specified; resource content
  resolution is the runtime/MCP layer's concern via `handlerRef`.
- **Snapshot/restore hook-state capture**. `ReconcilerSnapshot.hookStates`
  is always empty, `dataCache` always empty. Hibernate-and-resume is
  shape-conformant but doesn't preserve component state yet.
- ~~strictNoSuspense plumbing~~ DROPPED 2026-05-15. Suspense firing
  cannot be reliably detected via react-reconciler 0.33's host config
  callbacks. Tried fetch-count heuristic (false positives/negatives),
  static element-tree scan (misses dynamic Suspense), and
  outer-Suspense sentinel (detection works but inner user-Suspense's
  unwrap-on-resolve doesn't fire with LegacyRoot, leaving fallback
  stuck in IR). Removed from spec.
- ✓ **Suspense warning heuristic** added 2026-05-15.
  `ReconcilerHarness.maybeWarnSuspense` scans the input element tree
  for `React.Suspense` at mount + rerender; emits a one-shot
  `console.warn` per mount. Static scan — Suspense returned from a
  function component is still invisible. Catches the common case
  (user wraps their JSX in `<Suspense>`) and gives a clear pointer to
  the "no-Suspense DataBridge contract" rather than silently rendering
  fallbacks into the model context. Tests in
  `boundary-diagnostics.spec.tsx`.
- ✓ **ErrorBoundary detection** — `error-boundary-active` info
  diagnostic emits via host config `onCaughtError`. Landed 2026-05-15.
- ✓ **Custom lifecycle event dispatch** — `LifecycleStore.registerCustom`
  - `useOnLifecycleCustom(kind, handler)` hook land 2026-05-15. Dispatching
    a custom kind with no registered handler emits a one-shot
    `console.warn` per kind so typos surface instead of being silently
    dropped. Tests in `lifecycle.spec.tsx`.

### Spec gaps

- **`@agentick/spec-next/guards`** — directory exists, stubs only. Type guards
  for runtime validation (isTextBlock, isSection, isToolDeclaration, etc.)
- **`@agentick/spec-validator`** — referenced in pluggability charter
  for opt-in JSON-Schema runtime validation; package doesn't exist.
- **Phantom-type Operation inference (`__r`, `__e`)** — never validated.
- **Idempotency conflict semantics** — same opId, different input is
  currently silent first-wins. Charter says we'll add detection "if a
  real case demands it"; no diagnostic yet.

### Tests deferred

- **max-iterations diagnostic test** — TODO comment in hooks.spec.tsx.
  Need a controlled DataBridge fixture that fakes pending without
  actually throwing.
- **Concurrent features no-op verification** — useTransition /
  useDeferredValue documented as no-op; not tested.
- **Wire-compat round-trip** — pluggability charter rule #7 asserted in
  docstrings but not exercised. Add a smoke test that
  `JSON.parse(JSON.stringify(renderedTree))` recovers an equivalent
  value.
- **Hibernate/restore round-trip** — even with empty hookStates,
  snapshot → JSON → restore → renderTree should produce equivalent IR.
- **findOrphaned semantics for non-memory journals** — protocol doesn't
  specify index requirements; concrete durable impls will surface this.

### Integration gaps

- ✓ **react-devtools bridge** — ported to
  `@agentick/reconciler-react-next/react/devtools-bridge.ts`. Each
  `createReconciler()` auto-injects into DevTools via
  `injectIntoDevTools` (no per-mount opt-in). Call
  `enableReactDevTools({ host?, port? })` once at startup to connect to
  the standalone DevTools app — returns a typed outcome
  (`connected`/`already-connected`/`not-installed`/`failed`) instead of
  console-warning side effects. `react-devtools-core` is loaded via
  dynamic import (not a declared peer dep — install yourself when
  needed). Landed 2026-05-15.
- ✓ **Content-block intrinsics** — all 14 content-block contributors
  (`text`/`image`/`code`/`json`/`document`/`audio`/`video`/`reasoning`/
  `csv`/`html`/`xml`/`user_action`/`system_event`/`state_change`/
  `custom`) are registered in `createBuiltInRegistry()`.
  `messageContributor` folds them into `MessageEntry.content` via
  `ctx.collectContentBlocks()`; 15 tests in `content-blocks.spec.tsx`.
  Landed 2026-05-15 (the line that used to live here was stale).
- **Semantic HTML intrinsics** — `<strong>`, `<em>`, `<ul>`, etc. v1 has
  them; v2 design says they're a formatter concern (formatter harness
  consumes SemanticNode tree). Not wired.
- ✓ **`format` JSX intrinsic typing** — confirmed as intentional. The
  `format` intrinsic is INTERNAL; `<FormatScope>` / `<Markdown>` /
  `<XML>` / `<PlainText>` are the only typed entry points and they all
  funnel through one `internalIntrinsic()` helper that owns the unavoidable
  cast. Wider IntrinsicElements augmentation for `<section>` /
  `<message>` / `<text>` / etc. is a Phase-4-or-later concern — v2
  test code uses `React.createElement(...)` for intrinsics by design.
  Updated 2026-05-15.
- **Long-lived primitives** (`<Cron>` / `<Webhook>` / `<EventListener>`)
  — declared via SubscriptionIntent in the snapshot; no JSX components
  yet.

### Performance / observability

These are **gating items for Phase 4c (executor)** unless flagged
otherwise. Tracked in `blueprint/17-open-questions.md` §Substrate
scalability + observability.

- ~~**L5 — OTel exception recording without breaking error-reference
  identity.**~~ ✓ decided 2026-05-18. Restored standard `Effect.withSpan`
  (was side-channel). Empirical finding: only the _outer_ failure
  wrapper loses `===` identity; inner `.cause` Error references survive,
  all structural data (`_tag`, prototype chain, properties, stack)
  matches, and the recommended matchers (`instanceof`, `_tag` checks,
  `expect.objectContaining`) all work as adopters would expect. The
  narrow loss is acceptable in exchange for full OTel span hierarchy
  - exception recording. Substrate `annotateOperationSpan` documents
    the contract; see `blueprint/17-open-questions.md` §L5 investigation
    for findings + adopter patterns.
- ~~**L6 — Bus publish hot-path benchmark.**~~ ✓ landed 2026-05-17.
  Numbers in `blueprint/17-open-questions.md` §Benchmark results.
  Headline: lazy emission no-subs at 0.5 μs (12× speedup vs eager),
  bus.publish 1-sub at 6.0 μs (20% over target — acceptable),
  runOperation empty body at 46.8 μs (target revised from 10 μs →
  50 μs after Effect framework overhead measured).
- ~~**L7 — `MemoryJournal.appendedKeys` Set unbounded growth.**~~
  ✓ landed 2026-05-18. Eviction tied to the ring buffer's drop point —
  when an event drops, its (opId, phase) key is removed from
  `appendedKeys`, and `terminals` / `inFlight` are cleaned up
  accordingly. 14/14 journal tests pass; full workspace 5005/5005.
  MemoryJournal is explicitly non-durable; durable journals (sqlite,
  pg) implement dedup against their backing store and aren't affected.
- **L8 — Substrate self-instrumentation.** No metric surface for
  subscriberCount / journal size / inbox cache size / queue depth.
  How does a deployment know if the substrate is overloaded? Designed
  alongside L6.
- **Render-until-stable wallclock budget** — only iteration-bounded.
  A slow fetcher blocks the loop. We may want `awaitTimeoutMs` per
  iteration.

### Documentation gaps

- **Per-package API reference READMEs** — high-level pitch only. No
  user-facing component / hook reference for reconciler-react.
- **Flow diagrams in `15-flows/`** reference v1 vocabulary in places.

## Critical priority recalibration (2026-05-14)

**The reconciler is the most foundational piece of agentick.** Everything
connects to it; everything else is plumbing around it. Phase 3 in
`IMPLEMENTATION-PLAN.md` was originally the tool executor (chosen as
"simplest proof of substrate"). It is now the **reconciler harness**.

Rationale: if `BaseHarness` doesn't fit the foundational harness cleanly,
we need to know that before building six other harnesses on top. The
tool executor is peripheral; proving the substrate against it teaches
us little. Tool executor moves to Phase 4a.

This means Phase 3 lands more spec types in parallel (ContentBlock,
RenderedTree, MessageEntry, SemanticNode, FormatterRef, etc.) before
the reconciler harness can be implemented.

## What's done so far

### Architecture (locked)

- [`blueprint/`](./blueprint/) — 23 docs covering the five-surface
  harness model, foundation substrate (journal/bus/inbox/OTel),
  data model, every per-harness contract, flows, and packaging.
- Naming scheme locked: `compiler-*`, `client-*`, `server-*`,
  `executor-*`, `persistence-*`, `sandbox-*`.
- Foundation contract: `Operation`, `DiscreteEvent`, `ChannelEvent`,
  `MessageEnvelope`, `OperationJournal`, `EventBus`, `MessageInbox`,
  `BaseHarness` with five surfaces.

### Resolved open questions

From `17-open-questions.md`:

- **A10** `ReconcilerSnapshot` shape — locked 2026-05-08
- **A11** `StateApplicator` interface — locked 2026-05-08 (Pick of session)
- **F2** Handler verdict merge — locked 2026-05-08 (veto > replace > defer > proceed)
- **N5** Ingest mechanism — locked 2026-05-08 (hybrid: direct call +
  lifecycle handler chain)

### Code (Phase 0 morning, 2026-05-08, committed)

```
packages/spec/                                          ✓ scaffolded
  package.json                                          zero-dep, types-only
  tsconfig.json + tsconfig.build.json
  README.md
  src/version.ts                                        SPEC_VERSION
  src/index.ts
  src/data/                                             populated this session
  src/protocol/                                         populated this session
  src/guards/index.ts                                   stub

packages/spec-conformance/                              ✓ scaffolded (private: true)
  package.json                                          (same as before)
  src/{journal,inbox,harness,renderer}.ts               stubs (Phase 2+)

.changeset/config.json                                  ✓ @agentick/spec-next in fixed group
```

### Amendment — React feature semantics + notifyLifecycle (2026-05-15)

Pushback on the original Phase 3.1 framing landed two refinements:

1. **`notifyTickEnd` → `notifyLifecycle`.** Single command carrying a
   tagged `LifecycleEvent` union (`tick-start | tick-end |
execution-start | execution-end | error` + a namespaced `custom`
   escape hatch). Direct method-based coupling (synchronous, ordered)
   coexists with parallel event-bus emission (async, fan-out) — they
   answer different questions. Future lifecycle kinds don't add
   protocol methods.

2. **React feature semantics.** "Forbidden" was too strong. Revised:
   - `<Suspense>` — fallbacks DO appear in the IR if a boundary
     fires. Default behavior: emit `suspense-boundary-active` warning
     diagnostic. `MountInput.strictNoSuspense = true` upgrades to a
     terminal `RenderFailed`. The reconciler's outer Promise catch
     means `useData` does NOT trigger Suspense boundaries — only
     things React itself intercepts (e.g., `React.lazy`).
   - `<ErrorBoundary>` — supported. Catching a render error and
     rendering a fallback is a _good_ pattern (per-section
     resilience). Emits `error-boundary-active` info diagnostic.
   - `useTransition` / `useDeferredValue` — allowed; no effect in
     sync-render mode.

Diagnostic codes added: `suspense-boundary-active` (warning),
`error-boundary-active` (info).

Blueprint docs updated: `01-harness-principle.md`, `03-reconciler-harness.md`,
`05-loop-executor.md`, `08-session-harness.md`, `17-open-questions.md`,
`21-reconciler-implementation.md`, `IMPLEMENTATION-PLAN.md`.

Tests: 74/74 spec green (26 in reconciler-protocol.spec.ts with new
LifecycleEvent + strictNoSuspense + diagnostic coverage).
`pnpm -r typecheck` clean.

### Code (Phase 3.1–3.3 reconciler protocol contracts, 2026-05-15)

```
packages/spec/src/data/                                 ✓ snapshot + diagnostics
  reconciler-snapshot.ts  ReconcilerSnapshot, HookStateEntry,
                          DataCacheEntry, SubscriptionIntent,
                          ReconcileDiagnostic, ReconcileDiagnosticCode,
                          RenderToStringPayload

packages/spec/src/protocol/                             ✓ contracts
  hook-bridges.ts         HookBridges + DataBridge (no-Suspense),
                          KnobBridge, TimelineBridge, LoopBridge,
                          SessionBridge, Sandbox/MCP placeholders
  reconciler.ts           ReconcilerProtocol with mount/rerender/
                          renderTree/renderToString/renderResource/
                          notifyLifecycle/unmount/snapshot/restore.
                          notifyLifecycle carries tagged LifecycleEvent
                          union (tick-start | tick-end | execution-start |
                          execution-end | error). Direct-method coupling
                          coexists with bus-event fan-out — same moments,
                          different channels.
                          ReconcileError taxonomy (11 tags).
                          ReconcilerInboxMessage (recompile/unmount/
                          invalidate).

packages/spec/src/__tests__/
  reconciler-protocol.spec.ts                           23 new tests
                          - MountInput/Result, RenderTreeInput/Result
                          - RenderToString/Resource I/O
                          - Snapshot JSON round-trip
                          - ReconcileError taxonomy
                          - InboxMessage discrimination
                          - Diagnostic codes
                          - DataBridge no-Suspense semantics (cached
                            sync, pending throws Promise, failure
                            throws Error)
                          - Knob/Timeline/Loop/Session shapes
                          - ReconcilerProtocol method roster
```

**Design constraints baked into Phase 3.1:**

- **No Suspense.** `DataBridge.resolve` is the no-Suspense contract:
  cached value returns synchronously; pending throws an in-flight
  Promise (caught by the reconciler's render-until-stable loop, not
  by React `<Suspense>`); prior failure throws the underlying Error.
  `RenderedTree` never carries "loading" states.
- **JSON firewall.** `ReconcilerSnapshot` survives
  `JSON.parse(JSON.stringify(s))`. No functions, Dates, Maps, Sets.
- **Bridges, not globals.** Every runtime-supplied capability hook
  components need (timeline read, knob get/set, async data, loop
  control, session identity) goes through `HookBridges` passed at
  mount time. Module-level singletons are forbidden by contract.
- **`MountScopedInput` base.** Every operation that targets a mount
  carries `(mountId, opId?, correlationId?, parentOpId?)`. Phase
  contract + idempotency + causality come from `BaseHarness`.
- **Forward-compat strings.** `RenderPurpose`, `SessionStatus`,
  `HookType`, `ReconcileDiagnosticCode` are open string unions with
  named recognized values — new variants don't break older snapshots.

**Status check:**

- `pnpm vitest run packages/spec` — 71/71 green
- `pnpm -r typecheck` — all packages green
- Phase 3.4 (`@agentick/reconciler-react-next` scaffold) unblocked

### Code (Phase 2 in-memory substrate, 2026-05-15)

```
packages/runtime/                                       ✓ new package
  package.json                                          deps: @agentick/spec-next
                                                        devDeps: @agentick/spec-conformance-next
  tsconfig.json + tsconfig.build.json
  README.md
  src/index.ts                                          public exports
  src/substrate/
    ulid.ts                                             lex-sortable id gen
    query.ts                                            EventQuery matcher
                                                        (exact|prefix|segments|wildcard)
    memory-journal.ts                                   MemoryJournal
                                                        (ring buffer, idempotency map,
                                                         tail subscribers, findOrphaned,
                                                         bounded retention)
    local-event-bus.ts                                  LocalEventBus
                                                        (per-subscriber bounded buffer,
                                                         lazy fan-out, 3 overflow strategies)
    local-inbox.ts                                      LocalInbox
                                                        (address registry, messageId
                                                         idempotency cache w/ TTL,
                                                         tell + ask + timeout)
    base-harness.ts                                     BaseHarness, HandlerRegistry,
                                                        MiddlewareChain, mergeVerdict,
                                                        OperationOutcomeError
                                                        (5 surfaces wired; phase contract;
                                                         idempotent replay; verdict merge
                                                         veto > replace > defer > proceed;
                                                         JournalingPolicy honored;
                                                         override map with longest-prefix)
  src/__tests__/
    memory-journal.spec.ts                              conformance + capacity tests
    local-event-bus.spec.ts                             pub/sub + buffer + abort
    local-inbox.spec.ts                                 conformance
    base-harness.spec.ts                                phase contract, idempotency,
                                                        verdict merge, middleware
                                                        composition, inbox dispatch

packages/spec-conformance/                              ✓ bodies populated
  src/journal.ts                                        runJournalConformance
                                                        (append/read, idempotency, tail,
                                                         crash recovery)
  src/inbox.ts                                          runInboxConformance
                                                        (registration, tell, ask, timeout,
                                                         handler error, idempotency)
  src/harness.ts                                        DEFERRED to Phase 3
                                                        (needs a concrete harness driver)
  src/renderer.ts                                       DEFERRED to Phase 3
```

**Decisions baked in this session:**

- **Promise/AsyncIterable end-to-end.** No Effect in runtime yet. The
  blueprint reserves Effect for higher layers (Scope/Span integration);
  the in-memory substrate doesn't need it. If a real case demands
  cancellable Effects, we layer them in then.
  > **REVERSED 2026-05-15.** This decision contradicted `19-foundation.md`
  > as written and produced architectural drift. Substrate is now
  > Effect-native; see the dated entry above.
- **Idempotency dedup is per `(opId, phase)`, not per envelope id.** Same
  operation replaying the same phase is a no-op. Same opId in different
  phases is normal (requested → terminal).
- **`emit` returns Promise<void>** so concrete harnesses can await
  delivery. Discrete events still skip the `before` handler/middleware
  chain — they're light-path only.
- **`OperationOutcomeError`** is the runtime's signal for non-success
  terminals (failed | canceled | vetoed | deferred). `succeeded` and
  `replaced` return the result directly via the call.
- **Journaling override map** supports exact name OR longest-prefix
  matching. Lets harnesses tag noisy event families ("session:stream:")
  as `bus-only` without enumerating every leaf.
- **`runHarnessConformance` deferred to Phase 3.** It needs a concrete
  harness to drive; the runtime tests cover the BaseHarness contract in
  the meantime.

**Status check:**

- `pnpm vitest run packages/runtime packages/spec` — 82/82 green
  (24 prior spec + 23 phase-1c spec + 12 journal + 9 inbox + 4 bus + 9 base-harness + 1 version)
- `pnpm -r typecheck` — all packages green
- v1 packages unaffected

### Code (Phase 1c reconciler-facing wire types, 2026-05-15)

```
packages/spec/src/data/                                 ✓ wire types for Phase 3
  content-blocks.ts     ContentBlock taxonomy (21 variants), MediaSource,
                        role-scoped allow lists. `any` → `unknown`; enums
                        collapsed to string literal unions. Runtime helpers
                        stay in @agentick/shared.
  semantic.ts           SemanticNode (with rendererRef instead of function
                        ref), SemanticType, SemanticMetadata, FormattableBlock
  formatter.ts          FormatterRef, FormatterCapabilities, FormatInput,
                        FormatScope, FormatTrace, FormatDiagnostic,
                        FormatDiagnostics, FormattedContent, FormatResult
  entries.ts            CacheHint, MessageEntry, MessageMetadata,
                        SectionEntry, SectionMetadata, ContextEntry,
                        ContextSpec
  declarations.ts       ToolDeclaration, ToolExposure, ToolAnnotations,
                        ResourceDeclaration, OutputDeclaration,
                        MCPDeclaration, RuntimeDeclarations, JsonSchema
  rendered-tree.ts      RenderedTree, SpecConfig, ProviderOptions,
                        ResponseFormat, ModelSelection, SpecFeatureName
  execution-result.ts   UsageStats, ExecutionResult, ExecutorError,
                        ExecutorTerminal, LanguageModelStopReason,
                        ToolCall, LanguageModelExecutionResult,
                        ExecutorDelta
  execution-target.ts   ExecutionTarget, LanguageModelTarget,
                        TargetCapabilities
  index.ts              re-exports all of the above

packages/spec/src/__tests__/                            ✓ 48 tests passing
  rendered-tree.spec.ts (23 new tests: ContentBlock narrowing, SemanticNode,
                         Formatter protocol, ContextSpec entries,
                         RuntimeDeclarations, RenderedTree free-root,
                         ExecutorTerminal outcomes, ExecutionTarget)
```

**Decisions baked in this session:**

- **Function references can't cross the wire.** v1's
  `SemanticNode.formatter: Formatter` field becomes
  `rendererRef?: FormatterRef`. Formatter identity is data; behavior
  lives behind the formatter harness. `[V1-REPLACED]`.
- **Enums are runtime artifacts; spec is types-only.** v1's `BlockType`,
  `MessageRole`, `MediaSourceType`, MIME-type, and `CodeLanguage` enums
  collapse to string literal unions (with `(string & {})` escape hatch
  on open lists for ergonomics without losing literal autocomplete).
- **`readonly` everywhere on wire types.** The spec exposes shapes
  consumers MUST treat as immutable. Implementations construct fresh
  objects; downstream code reads.
- **`ExecutorTerminal` omits `deferred`.** `deferred` is a pre-execution
  handler verdict (the `before` phase), not a terminal outcome. The
  envelope carries the five values that actually terminate execution.
- **Runtime helpers stay in `@agentick/shared`.** Type guards
  (`isTextBlock`, `isToolUseBlock`, …) and base64 helpers depend on
  Node Buffer / browser fallbacks — those don't belong in zero-dep spec.

**Status check:**

- `pnpm -r typecheck` — all packages green
- `pnpm vitest run packages/spec` — 48/48 green (24 prior + 23 new + 1 version)
- v1 packages unaffected

### Code (Phase 1 foundation-critical types, 2026-05-11)

```
packages/spec/src/data/                                 ✓ all populated
  events.ts             EventEnvelope, ProtocolEvent, EventSurface,
                        EventPhase, EventScope, EventQuery, NameQuery
  outcomes.ts           CommandOutcome (6 values), HandlerVerdict,
                        TerminalEvent<R,E>, HandlerScope
  operations.ts         Operation<I,R,E>, DiscreteEvent, ChannelEvent<T>
  inbox.ts              MessageEnvelope<T>, MessageAck, MessageHandler
  errors.ts             JournalError, InboxError, MessageHandlerError
  journaling-policy.ts  JournalingPolicy + DEFAULT_JOURNALING_POLICY
  standard-schema.ts    Inlined StandardSchemaV1 (~30 LOC; zero-dep preserved)
  index.ts              re-exports all of the above

packages/spec/src/protocol/                             ✓ substrate protocols
  journal.ts            OperationJournal (append, appendBatch, read, tail,
                        lookupTerminal, findOrphaned)
                        + OrphanedOperation, OrphanQuery, JournalReadFrom,
                          Maybe<T> sentinel
  bus.ts                EventBus (publish, subscribe)
                        + SubscribeOptions, BufferOverflowError
  inbox.ts              MessageInbox (register, send, ask)
                        + AskOptions, Unsubscribe
  index.ts              re-exports

packages/spec/src/__tests__/                            ✓ 25 tests passing
  version.spec.ts       (1 test, SPEC_VERSION format)
  types.spec.ts         (24 tests, structural smoke for every new type)
```

**Decisions baked in this session:**

- **Async return type in spec is `Promise<T>` / `AsyncIterable<T>`.** Not
  `Effect<T, E, R>`. This preserves spec's zero-dep claim and matches
  the blueprint's own pattern (compiler-react is Effect-free; the
  runtime bridges to Effect at the BaseHarness boundary). Errors are
  thrown/rejected, typed via JSDoc `@throws`. Implementations using
  Effect convert at their protocol boundary via
  `Effect.runPromise` / `Effect.tryPromise`.
- **Streaming uses `AsyncIterable<T>`** (TS-native) rather than Effect's
  `Stream`. Implementations adapt.
- **No `Option<T>`.** `OperationJournal.lookupTerminal` returns a plain
  discriminated union `Maybe<T> = { some: true; value: T } | { some: false }`.
- **Error shape is `{ _tag: ...; ... }` tagged unions** for runtime
  pattern matching. No exception class hierarchy.
- **Phantom type fields on `Operation<I, R, E>`** (`__r`, `__e`) are
  inference-only; not runtime properties.

**Status check:**

- `pnpm typecheck` — 55/55 green
- `pnpm vitest run packages/spec/src` — 25/25 green
- v1 packages unaffected

## What's next

### Immediate

Two parallel work streams can proceed now:

1. **Foundation substrate (Phase 2)** is **unblocked** — spec has the
   types and protocol interfaces needed to implement `MemoryJournal`,
   `LocalInbox`, `LocalEventBus`, and `BaseHarness`.

2. **Reconciler spec types (Phase 1 continuation)** can start in
   parallel — these are needed for Phase 3 (reconciler harness):
   - `ContentBlock` taxonomy + `MediaSource` (promote from
     `packages/shared/src/blocks.ts`)
   - `SemanticNode`, `SemanticType`, `SemanticMetadata` (promote from
     `packages/core/src/renderers/base.ts`)
   - `FormatterRef`, `FormatInput`, `FormatResult`, `FormattedContent`,
     `FormatScope`, `FormatTrace`
   - `RenderedTree`, `ContextSpec`, `MessageEntry`, `SectionEntry`
   - `RuntimeDeclarations`, `ToolDeclaration`, `OutputDeclaration`,
     `ResourceDeclaration`
   - `ReconcilerSnapshot` (per `03-reconciler-harness.md` §Snapshot rules)
   - `Message`, `MessageRoles` (promote from
     `packages/shared/src/messages.ts`)
   - `TimelineEntry` (promote from `packages/shared/src/timeline.ts`)
   - `UsageStats` (promote from `packages/shared/src/models.ts`)

Recommended order:

1. **Commit current state** (nomenclature rename + priority reorder).
2. **Promote reconciler spec types** (Phase 1 continuation). Mostly
   mechanical — move + re-export from `@agentick/shared` for transient
   compat.
3. **Start Phase 2 substrate** (`MemoryJournal`, `LocalInbox`,
   `LocalEventBus`, `BaseHarness`) — can happen in parallel with #2.
4. **Phase 3 — Reconciler harness** in `@agentick/reconciler-react-next`.
   Port v1 reconciler + JSX runtime + components + hooks. Implement
   `ReconcilerProtocol`. Prove the substrate against the foundational
   harness.

### Deferred (do later when needed)

These spec types are NOT needed for foundation substrate (Phase 2) or
the first harness (Phase 3). Promote them when the consuming harness
gets implemented:

- **Phase 4 prereqs** (compiler-react, executor adapters):
  - `ContentBlock` taxonomy (from `packages/shared/src/blocks.ts`)
  - `Message`, `MessageRoles` (from `packages/shared/src/messages.ts`)
  - `TimelineEntry` (from `packages/shared/src/timeline.ts`)
  - `ToolCall`, `ToolResult` (from `packages/shared/src/tools.ts`)
  - `UsageStats`, `ResponseFormat` (from `packages/shared/src/models.ts`)
  - `RenderedTree`, `ContextSpec`, `MessageEntry`, `SectionEntry`
  - `RuntimeDeclarations`, `ToolDeclaration`, `OutputDeclaration`
  - `SemanticNode`, `SemanticType`, `SemanticMetadata`
  - `FormatterRef`, `FormatInput`, `FormatResult`, `FormatScope`
  - `ExecutionResult`, `ExecutorTerminal`, `LanguageModelExecutionResult`
  - `ExecutionTarget`, `LanguageModelTarget`
  - `ExecutorDelta`
  - `ReconcilerSnapshot`
  - `SessionRecord`
  - `FrameworkChannels` (concrete channel payloads)

- **Higher-layer protocol interfaces** (promote when implementing the
  corresponding harness):
  - `ReconcilerProtocol` (Phase 4b)
  - `FormatterProtocol` (Phase 4a)
  - `ExecutorProtocol`, `LanguageModelExecutor` (Phase 4c)
  - `ToolExecutorProtocol` (Phase 3)
  - `LoopExecutorProtocol` (Phase 4d)
  - `SessionHarnessProtocol` (Phase 4e)
  - `AppHarnessProtocol` (Phase 4f)

### Pending decisions (carried from 2026-05-08, not yet blocking)

The rename pass on existing v1 packages is still pending decisions —
but it can happen at any time and doesn't block substrate work. Defer
until convenient. The four open questions:

### Pending decisions (from session 2026-05-08)

1. **`@agentick/server`** exists today, described as "channel routing,
   session handling, transport adapters." Action:
   - (a) Rename to `@agentick/gateway` (current gateway pkg is something else?)
   - (b) Keep as `@agentick/server` (separate from gateway?)
   - (c) Fold into runtime

2. **`packages/adapters/` has 7 packages** vs the 3 in the original
   rename list:

   ```
   ai-sdk          → @agentick/executor-ai-sdk-next     (in plan)
   anthropic       → @agentick/executor-anthropic-next  (not in plan)
   apple           → @agentick/executor-apple      (??)
   bedrock         → @agentick/executor-bedrock    (??)
   google          → @agentick/executor-google-next     (in plan)
   huggingface     → @agentick/executor-huggingface (??)
   openai          → @agentick/executor-openai-next     (in plan)
   ```

   Rename all 7? Defer some?

3. **Other v1 packages** — angular, cli, client-multiplexer, connector\*,
   guardrails, nestjs, scheduler, secrets, socket.io. Keep current
   names? Some renamed?

4. **`packages/agent/` and `packages/agentick/`** — which is the
   meta-package and what's the other?

## Environment quirks

### pnpm install requires explicit registry

Workspace has a Knowify CodeArtifact registry configured (`.npmrc`)
that intercepts unrelated package requests when its auth token is
expired. Two workarounds:

```bash
# Option 1: pass registry flag
pnpm install --registry=https://registry.npmjs.org/

# Option 2: refresh Knowify token
# (the team's standard token refresh procedure)
```

The `.npmrc` warning during pnpm runs about `${NPM_TOKEN}` failing to
replace is benign — comes from the workspace `.npmrc` template; not a
v2 concern.

### Vitest configuration is workspace-level

Don't add a per-package `"test": "vitest run"` script — vitest's
include glob `packages/*/src/**/*.spec.{ts,tsx}` is resolved relative
to the directory vitest is invoked from. Per-package `pnpm test` ends
up resolving to `packages/spec/packages/*/...` and finds nothing.

Run tests from workspace root:

```bash
pnpm vitest run packages/spec/src           # all spec tests
pnpm vitest run packages/spec/src/foo.spec.ts   # specific
```

### Day 1 morning fix applied

Originally `packages/spec/package.json` had `"test": "vitest run"` and
explicit `typescript` + `vitest` devDeps. Both removed:

- Test script removed (workspace runs tests from root)
- TypeScript + vitest provided by root devDeps

## Decision log

Running record of decisions made during execution (separate from the
blueprint's design decisions; this is execution-level).

### 2026-06-29

- **ADR 43 Slices 2 + 3 landed.** Slice 2: `buildSessionElicit(harness)`
  factory in `@agentick/elicitation-next/src/elicit-sugar.ts` wraps an
  in-process `ElicitationHarness` in the `Elicit` sugar surface. Wired
  into `tool-executor-next/harness.ts` ctx-build so in-process tool
  handlers get `ctx.elicit` populated identically to MCP-server tool
  handlers (same Elicit interface, same throwing semantics). Slice 3:
  `fakeToolHandlerCtx({ ... })` factory in `spec-conformance-next`
  centralizes ToolHandlerCtx test fixtures; two existing ad-hoc fakes
  (`tool-next/__tests__`, `reconciler-react-next/__tests__`) migrated
  to the helper. Tool-handler ctx shape changes now propagate to all
  tests via one factory update.
- **#272 landed — `session.elicit` accessor.** Augment adds
  `SessionHarnessProtocol.elicit: Elicit` required slot; both
  `SessionHarness` (lazy getter) and `CallbackSessionHarness` (eager
  constructor) implementations expose the sugar. Adopters writing
  session-level commands or agent-side asks use the same `Elicit`
  interface tool handlers receive via `ctx.elicit`.

- **ADR 43 proposed + Slice 1 landed — Unified `ToolHandlerCtx` across
  transports.** Adds `transport: "in-process" | "mcp"` discriminator
  to `ToolHandlerCtx` + `mcp?: McpRequestExtras` sub-slot for
  MCP-only wire identity material (connection id, client capabilities,
  authenticated user, sendProgress). `McpRequestContext` collapses to
  a structural type alias of `ToolHandlerCtx & { transport: "mcp";
  mcp: McpRequestExtras }`. Tool handlers receive the SAME ctx shape
  whether dispatched in-process or via MCP server — `createTool` is
  now portable across transports. ADD-only rollout strategy: no
  existing fields removed; new fields populated at three known
  ctx-build call sites (in-process tool-executor, MCP server
  projection, session dispatch path) in the same slice. **Why:** the
  prior split between `ToolHandlerCtx` (in-process) and
  `McpRequestContext` (MCP) was historical, not designed — adopter
  pushback on 2026-06-29 ("createTool tools should work with mcp
  server too and both should basically work the same") forced the
  unification. **How to apply:** any new ctx-build site populates
  `transport` + `mcp?` per ADR 43 §3; sugar surfaces (`ctx.elicit`,
  future `ctx.sample` / `ctx.roots`) work identically in both
  transports; `Partial<McpRequestContext>` test fixtures use the
  flat-override helper documented in `pipeline.spec.ts`. Workspace
  7150/7158 green (+1 conformance round-trip). Tasks #272
  (session.elicit), #266 (ADR 42 Slice 3 — withX trichotomy), and
  future sampling/roots ctxes all unblocked by this landing.

- **ADR 42 proposed — Harness-slot trichotomy (`Instance | Config | shorthand`).**
  Codifies the convention every harness-backed adopter slot must follow:
  the slot is an `Instance | Config` union, with an optional third
  `readonly Decl[]` shorthand case for harnesses that have a single
  dominant declaration type. Naming rules pin "no Harness in adopter
  vocabulary" (every protocol gets a `<Noun>` alias —
  `Prompts = PromptsHarnessProtocol`, etc.), `use:` as the pre-built
  escape-hatch field name (never `harness:`, `instance:`, `source:`),
  `filter:` for per-connection visibility, and `parent.<slotName>:
  Instance | null` as the runtime-mutation read surface. Lifecycle
  ownership follows construction: parent-built → parent closes;
  adopter-supplied (top-level Instance OR `use:`) → adopter closes.
  Initial audit lists `mcp-next/server.prompts` as the lone fully-
  passing slot; `mcp-next/server.tools`, `withSkills`, `withPrompts`
  all flagged for follow-up slices. Triggered by #171d.1b where
  `prompts: { harness: ... }` leaked framework vocabulary into adopter
  code. Not a code-level generic (the first draft was — pushed back as
  too tight; the per-harness Config shape varies too much). ADR is a
  CONVENTION + 7-item audit CHECKLIST. Cross-references ADR 26, 27,
  40, 41. **How to apply:** every new harness-backed slot scored
  against the checklist before merge; existing slots get follow-up
  tasks for each gap.

- **ADR 41 landed — `AgentickError` class hierarchy supersedes POJO
  `{ _tag: ... }` unions for typed errors.** Closes #256. Every typed
  error in v2 is now a class extending `AgentickError extends Error`
  (with optional per-domain abstract intermediates carrying a literal
  `_tag` union for `Effect.catchTag` narrowing). A registry-based codec
  (`registerAgentickError(tag, cls)` + `serialize`/`deserialize`)
  preserves class identity across the wire; `UnknownAgentickError` is
  the lossless fallback for unregistered tags. The previous 2026-05-11
  decision ("Spec error shape = `{ _tag: ...; ... }` tagged union. No
  class hierarchy") is **superseded**. Zero production `Effect.fail({_tag:...})`
  / `throw {_tag:...}` sites remain; 404 surviving `_tag` references
  are all on non-error tagged unions (message envelopes, wire frames,
  content blocks, channel events) and are correct. Conformance test in
  `@agentick/spec-conformance-next/__tests__/agentick-error-conformance.spec.ts`
  pins registry-membership + instance-shape + codec round-trip
  invariants for all 88 framework error tags. Adding a new error class
  requires adding one row to the suite's `EXPECTED` list. Work landed
  on branch `feat/v2-error-infra`; ready to merge → `feat/v2`. 2476/2476
  workspace tests green. Commits: `5420945c` (ADR-41 proposal) →
  `cd90ec8f` (#256e + #256f final sweep).

### 2026-06-23

- **`@agentick/utils-next` carved out from `@agentick/shared`.** The
  v1 `@agentick/shared` package is fundamentally a v1-API content bag
  (block-types, messages, transport, identity, etc.) with a single
  `utils/` subdirectory of framework-agnostic helpers. Adding new v2
  utilities (`mergeLayered`, `isEqual`, `isPlainObject`, predicates)
  there forced every v2 package to import from a v1-coupled package,
  creating a backwards dep edge from v2-next to v1.
  Moved predicates + merge-layered + tests into a new private
  workspace package `@agentick/utils-next` at `packages-next/utils/`.
  Inlined the tiny `isObject` helper that v1's `mergeDeep` was using
  so v1 `@agentick/shared` stays self-contained. Updated v2 consumers
  (`tool-executor-next/registry.ts`, three harness migrations for
  journalingPolicy) to import from `@agentick/utils-next`.
  Future v2 framework-agnostic utilities land here, not in v1 shared.
- **`mergeLayered` first internal demonstration — journalingPolicy
  cascade in App / Gateway / Session harnesses.** Replaced
  `{ ...DEFAULT_JOURNALING_POLICY, override: { ... } }` hand-spreads
  with `mergeLayered<JournalingPolicy>(DEFAULT_JOURNALING_POLICY,
options.policy, { override: { ... } })`. Adding fields to
  `JournalingPolicy` no longer requires touching the three close-op
  override sites. Gateway's adopter-supplied `policy` now deep-merges
  through the cascade rather than per-field copy.
- **#133 ElicitationBridge landed — MCP server-to-client
  `elicitation/create` routing.** Closes the MCP-side half of the
  elicitation chapter. Spec gains an optional
  `AppInstallerHost.getSession(id)` so app-extensions can reach live
  session bridges at dispatch time without coupling to
  `@agentick/app-next`. `withMCP`'s tool-handler closure resolves
  `installer.app.getSession(ctx.sessionId)?.elicitation` and threads
  it through `harness.callTool(..., { elicitResolver })`. The MCP
  SDK's `ElicitRequestSchema` handler routes inbound `elicit/create`
  through the per-call slot — accept → tool result embeds value,
  decline/cancel → server sees clean termination. Translation lives
  in a separate `mcp/client/elicit-bridge.ts` so #134a (URL mode) is
  a small drop-in. v0 concurrency caveat: single resolver slot per
  harness; concurrent elicit-routed `callTool`s race. Mitigated by
  MCP's per-connection serial-call convention; per-request-id
  correlation deferred until the wire ships stable
  `relatedRequestId` on inbound server-initiated requests.
- **#149 cluster-friendly elicit routing + URL mode + Effect
  cleanup.** Substrate-level overhaul of the elicit bridge.
  `ElicitationHarness` gains an `elicit-request` inbox message
  handler that runs an elicit locally and routes the result back via
  `request-response`. `McpClientHarness` slot stores a _sessionId
  string_ (not an object reference); the SDK elicit handler routes
  via the substrate inbox to the session's elicit address — same
  protocol in-memory (LocalInbox) and cluster (ClusterInbox). The
  per-call slot stamp uses `Effect.acquireUseRelease` for
  interrupt-safe acquire/release. URL mode wired end-to-end:
  harness publishes URL-mode payload, MCP bridge forwards URL
  elicits as consent-only terminals. `UnsupportedElicitationModeError`
  deleted (both modes wired). SDK exported `ElicitRequestFormParams |
ElicitRequestURLParams` union used directly (replaces hand-rolled
  type). `BaseHarness.address` made public — every harness exposes
  its cluster-portable inbox address. `ElicitationHarnessProtocol`
  gains `address: string`. Unrouted/ambiguous elicits emit
  `mcp:warning:routing-dropped` bus envelopes. URL-mode conformance
  - capability handshake + concurrent in-session tests added.
- **#150 SessionExtension lifecycle wiring.** The `target: "session"`
  half of the extension union was a placeholder — AppHarness cached
  the extensions but never invoked them. Now wired:
  `createSessionBody` builds a SessionInstaller (sessionId + tool +
  bridge + bus + onClose registration surface), runs session-target
  extensions BEFORE constructing the ToolExecutor so contributed
  tools (binding `{ scope: "extension", level: "session" }`) land in
  `initialTools`. Per-session bridges overlay app-level. Close
  handlers + tool-handler unregisters + bus subscriptions fire LIFO
  at session.close. Foundational for every session-scoped extension
  — knobs, sandbox-session, mcp-future. 6 conformance tests cover
  install-once-per-session, dispatch reachability, bridge isolation,
  LIFO close, no-zombie-handlers, app+session sibling phasing.
- **#151 withMCP becomes per-session — drops the elicit slot
  entirely.** Architectural floor for multi-tenant MCP.
  `McpClientHarness` is now per-(session, server); `elicitAddress`
  is fixed at construction (set to `SessionInstaller.elicitation
.address`). The `activeElicitSessionId` slot, the
  `Effect.acquireUseRelease` wrapper around `callTool`, the
  `resolveElicitAddress` callback, the cross-session ambiguity
  warning path — all gone. handlerRefs are per-session
  (`mcp:<sessionId>:<serverId>:<toolName>`) to avoid collisions on
  the shared HandlerResolver. Tools bind with
  `{ scope: "extension", level: "session" }`. Multi-tenant
  correctness: MCP binds OAuth tokens + `Mcp-Session-Id` + auth
  decisions to the connection; sharing across users is a wire
  violation. **Future optimization (#152, weeks horizon):**
  connection pool keyed by auth principal — sessions check out /
  back in. Sits BENEATH McpClientHarness; same auth principal →
  connection sharing, different principals → isolation. Loud
  documentation in `packages-next/mcp/README.md` "Connection
  lifecycle" and `blueprint/23-mcp-as-harness.md`.

### 2026-05-08

- **Day 1 morning approach:** do additive (new packages) safely first;
  pause before destructive renames until full package inventory was
  understood.
- **`@agentick/spec-conformance-next` not separate repo:** marked private
  in monorepo. The "private repo" idea was overengineered — conformance
  tests aren't a competitive moat.
- **Per-package test scripts:** removed; vitest runs from workspace root.

### 2026-05-11

- **STATUS.md created:** running progress + decision log to enable
  cross-session continuity.
- **Spec async return = Promise/AsyncIterable** (not Effect). Preserves
  zero-dep. Implementations bridge to Effect at the boundary.
- **Spec error shape = `{ _tag: ...; ... }` tagged union.** No class hierarchy.
  **⚠ SUPERSEDED 2026-06-29 by ADR 41 — see decision-log entry. v2 now
  uses an `AgentickError` class hierarchy with a registry-based codec.**
- **`lookupTerminal` returns `Maybe<T>`** (plain discriminated union),
  not Effect's `Option<T>`.
- **Phantom type fields on `Operation<I, R, E>`** for inference; not
  runtime properties. Marked `@internal`.
- **`DEFAULT_JOURNALING_POLICY`** ships as a const in spec:
  `alwaysJournal: ["requested", "terminal"]`, `busOnly: ["before", "delta"]`,
  `overflow: "sliding"`, `queueCapacity: 4096`. Per-surface override at
  consumer.

### 2026-05-14

- **Nomenclature recalibration:** drop idiomatic naming where it
  conflicts with proper CS terms. Specifically:
  - `Compiler harness` → `Reconciler harness` (it reconciles a reactive
    program; it does not compile in the static-compilation sense).
  - `Renderer harness` (markdown/xml) → `Formatter harness` (it formats
    semantic content into output formats; "renderer" collides with
    React's own meaning).
  - `CompiledStructure` → `RenderedTree` (matches React's mental model:
    what the reconciler "renders" to).
  - `useContinuation` → `useLoopControl` (avoids overloading the existing
    "gate" concept; clearer semantic about what it does).
  - `CompileError` → `ReconcileError`.
  - `RenderError` (formatter) → `FormatError`.
  - `compileContext` command → `renderTree`.
  - `compile-until-stable` → `render-until-stable`.
  - Event prefixes: `compiler:*` → `reconciler:*`,
    `renderer:*` → `formatter:*`.
  - Surface enum: `"compiler"` → `"reconciler"`,
    `"renderer"` → `"formatter"`.
  - Package: `@agentick/compiler-react` → `@agentick/reconciler-react-next`.
  - Doc file: `03-compiler-harness.md` → `03-reconciler-harness.md`,
    `04-renderer-harness.md` → `04-formatter-harness.md`.
  - "Harness" stays — adds engineering-discipline specificity over
    bare "actor" (BaseHarness inheritance, five surfaces, journal
    durability). Documented as an addressable actor.

### 2026-05-17

- **L6 — substrate benchmark suite landed.** New
  `packages/runtime/src/__bench__/substrate.bench.ts` exercises every
  hot path (bus.publish ± subscribers, bus.publishLazy, journal.append
  ± dedup, inbox.send ± cache hit, runOperation ± idempotent replay,
  LocalChannelPublisher ± subscriber, streaming simulation 10 ops ×
  10 deltas eager vs lazy). Full table + decisions in
  `blueprint/17-open-questions.md` §Benchmark results.

  Key results:
  - **Lazy emission validated end-to-end.** `bus.publishLazy` no-subs
    at 0.5 μs is a **12× speedup** vs constructing-and-publishing
    (6.0 μs). The streaming sim shows 10 ops × 10 deltas: lazy at
    229 μs/iter beats eager at 289 μs/iter by ~20% when no
    subscriber. Construction-on-demand is the right call.
  - **`bus.publish` no-listeners hits target.** 0.5 μs < 1 μs.
  - **`bus.publish` 1-subscriber misses by 20%.** 6.0 μs vs 5 μs.
    Mostly Effect-runtime overhead (`Effect.all` + `Queue.offer`
    plumbing). Acceptable; micro-opt available.
  - **`journal.append` + `inbox.send` cache hit excellent.** ~1.4 μs
    fresh append, 0.6 μs dedup; 0.6 μs cache hit on inbox.
  - **`runOperation` empty body is 46.8 μs, 4.7× over original 10 μs
    target.** Decomposition: ~21 μs in three publishes, ~26 μs in
    Effect framework overhead (Effect.scoped + withContext + nested
    Effect.gen yields). **Target revised: < 50 μs.** Realistic
    given how much work the phase contract does. Substrate cost is
    0.5% of a 10 ms tool call, 0.05% of a 100 ms model call —
    real-world throughput is not substrate-limited at this number.

  Optimization opportunities deferred (not blocking Phase 4c):
  - Inline single-subscriber path in `bus.publish` to skip
    `Effect.all` overhead.
  - Flatten nested `Effect.gen` blocks in `runOperation`; skip
    `Effect.scoped` when no finalizers registered. ~15-20 μs
    recoverable.

### 2026-05-16

- **Substrate refinement pass — 8 critical items closed.** Audit of
  the substrate after the Effect-native migration surfaced eight gaps
  between the blueprint and the implementation. All eight closed in
  one pass:
  1. **`Effect.scoped` wrap around every command body.** `runOperation`
     now establishes a `Scope` for the operation's lifetime — any
     `Effect.acquireRelease` inside a body runs its finalizer when the
     operation terminates (success, failure, or interrupt). Unblocks
     adapters that hold per-operation resources (HttpClient, WebSocket,
     sandbox process handles).

  2. **Typed error channel.** `runOperation` now returns
     `Effect<R, E | SubstrateError, never>` instead of
     `Effect<R, unknown, never>`. New `SubstrateError` tagged union in
     `@agentick/spec-next` covers `OperationOutcomeError | JournalError |
LifecycleHandlerError`. Callers regain compile-time signal about
     what failure modes to handle; subclass harnesses can pattern-match
     in `Effect.catchTag` / `Effect.catchTags`.

  3. **`parentOpId` auto-set from the FiberRef.** When `runOperation`
     starts and `op.parentOpId === undefined`, it reads the surrounding
     `RuntimeContextRef`'s `opId` and uses that. Nested operations
     compose into a causality tree without app code threading
     parentOpId. Every consumer of the journal/bus (devtools, OTel
     exporter, replay debugger) can reconstruct the operation tree.

  4. **OTel span integration — without breaking error-identity.**
     `runOperation` annotates each operation with `Effect.withSpan`
     via a private `annotateOperationSpan` helper that side-channels
     the span (success-typed `Effect.void.pipe(Effect.withSpan(...))`)
     so the failure value the caller sees is the same JS reference the
     body raised. Earlier attempt to use `Effect.withSpan` directly on
     the body's pipe lost error-reference identity (failures appeared
     as Errors with the same `.message` but different `.constructor`
     ref). Workaround preserves identity at the cost of the span not
     seeing the original error — for now, OTel sees only the span
     name + attributes; explicit `recordException` integration is a
     follow-up.

  5. **Lifecycle-handler failures flow through `SubstrateError`.** A
     `before`-handler's Effect failing now produces a typed
     `{ _tag: "LifecycleHandlerError", phase, cause }` instead of
     silently widening the operation's `E`. The substrate publishes
     `terminal:failed` for the operation and re-fails with the typed
     lifecycle error.

  6. **`runHarnessProtocol` extracted to `@agentick/runtime-next`.**
     Concrete harnesses (reconciler-react, tool-executor) used to
     duplicate this `FiberFailure → typed error` unwrap helper.
     Now exported once; both consumers import it.

  7. **`ToolHandler` accepts Effect, Promise, or sync.** The 90%-case
     Promise ergonomic (v1-compatible) keeps working. Effect-typed
     handlers see the harness's `RuntimeContextRef` directly via
     `getContext` (no `ctx` plumbing), participate in `Effect.scoped`
     finalizer chains, and cancel via `Effect.race` against an
     AbortSignal-driven failure. The dispatch body itself converted
     from Promise-shaped to Effect-shaped so the FiberRef propagates
     into Effect handlers without crossing the JS-async boundary.

  8. **`AbortSignal` ↔ Effect interrupt bridge.** Effect-typed tool
     handlers race the handler effect against an `Effect.async` that
     fails when the dispatch's AbortSignal fires. Promise handlers
     continue using the `AbortSignal` directly. The two abort
     primitives coexist without one dictating the other.

  **Status:** `pnpm -r typecheck` clean; 4953/4961 tests green across
  the workspace; example/v2 demonstrates both Promise and Effect
  handler paths end-to-end (the Effect `whoami` reads sessionId /
  executionId / tickId / opId via FiberRef without any parameter
  plumbing).

- **Components → reconciler-react.** Decision locked: user-facing
  component wrappers (`<Section>`, `<Message>`, `<H1>`, `<Tool>`, etc.)
  live in the matching reconciler package, not a separate
  `@agentick/components`. Rationale: components are coupled to the
  reconciler's intrinsics; future Solid / Vue reconcilers ship their
  own. example/v2 defines them locally as a stopgap; they graduate
  into `@agentick/reconciler-react-next` before Phase 4e so app authors can
  `import { Section, Tool } from "@agentick/reconciler-react-next"`.

- **Substrate scalability + observability — gates registered.** Four
  new entries in `blueprint/17-open-questions.md` §L (Observability):
  L5 (OTel exception recording without breaking error-reference
  identity), L6 (bus publish hot-path benchmark), L7 (`MemoryJournal.
appendedKeys` Set unbounded growth), L8 (substrate self-instrumentation).
  L5 + L6 are **gating items for Phase 4c (executor harness)** —
  must land before adapter authors write code on top of the substrate.
  L7 gates v2.0 release. L8 lands alongside L6. See "Substrate
  scalability + observability (running notes)" in 17-open-questions.md
  for the benchmark plan and concrete concerns.

### 2026-05-15

- **Phase 3 priority reorder:** the reconciler harness, not the tool
  executor, is the proof harness. Reasoning: the reconciler IS the
  foundation; the substrate is plumbing for it. If substrate doesn't fit
  the foundational harness cleanly, we need to know that before building
  on top. Tool executor moves to Phase 4a.
- **Mechanical rename pass complete** across blueprint + plan + status.
  55/55 typecheck green; 25/25 spec tests green.
- **Path A — substrate flipped to Effect-native.** The earlier
  "Promise/AsyncIterable end-to-end. No Effect in runtime yet"
  decision is reversed. It contradicted `19-foundation.md` as written
  (`BaseHarness.runOperation` returns `Effect<R, E, Scope>`; journal /
  bus / inbox return `Effect` / `Stream`) and produced architectural
  drift — most visibly in an aborted attempt to bolt a `FiberRef + ALS
mirror` `RuntimeContext` onto a Promise-typed substrate. The bolt-on
  was thrown out; the substrate itself is now Effect.

  Concretely:
  - `@agentick/spec-next` protocols flipped: `OperationJournal`,
    `EventBus`, `MessageInbox`, `MessageHandler` all return Effect /
    Stream. Tagged-union errors flow through the `E` channel.
  - `effect` is a direct dependency of `@agentick/spec-next`,
    `@agentick/spec-conformance-next`, `@agentick/runtime-next`,
    `@agentick/reconciler-react-next`, and `@agentick/tool-executor-next`.
  - `@agentick/runtime-next` rewrites: `MemoryJournal` (Stream-based read /
    tail, idempotency unchanged), `LocalEventBus` (Effect `Queue`
    backed — `Queue.sliding` for drop-oldest, `Queue.dropping` for
    drop-newest), `LocalInbox` (Fiber-memoized idempotency cache —
    same `messageId` joins the same Fiber), `BaseHarness` (Effect
    `runOperation` with `withContext` establishing
    `RuntimeContextRef` for the operation's lifetime; FiberRef
    propagates sessionId / executionId / tickId / opId / parentOpId /
    correlationId to every Effect launched inside the body).
  - New `runtime-context.ts`: `RuntimeContextRef: FiberRef<RuntimeContext>`,
    `getContext`, `withContext`. **No AsyncLocalStorage mirror** —
    the prior session's dual-surface attempt is the exact pattern we
    are refactoring v2 to escape (ALS is scoped to async-resource
    chains; actor identities outlive any single call stack).
  - `runEventBusConformance` added (charter rule #4 status table
    flagged it as missing).
  - Reference harnesses re-anchored: `ReconcilerHarness` and
    `ToolExecutorHarness` keep their Promise-typed `ReconcilerProtocol`
    / `ToolExecutorProtocol` public surfaces (the spec hasn't
    flipped those — Phase 4 concern) but wrap each command body
    with `Effect.runPromise` via a `runProtocol` bridge that
    unwraps `FiberFailure` → original typed error. FiberRef scope
    propagates within each command.
  - Workspace status: 4953/4961 tests green (3 skipped, 5 todo, 0
    failed); `pnpm -r typecheck` clean.

  Architectural payoff (now realized for every harness that
  inherits BaseHarness):
  - FiberRef propagation across command bodies — sessionId / opId /
    tickId visible to any downstream Effect via `getContext`. No
    parameter plumbing, no ALS scope leaks.
  - `Effect.withSpan` integration point ready in `runOperation` for
    the OTel projection (`19-foundation.md` §OTel). Spans align with
    `parentOpId` via FiberRef.
  - `Effect.scoped` finalizer chaining available for harness
    teardown / abort cleanup when the per-command scope closes.
  - `@effect/cluster` substitution path open — `ClusterJournal` /
    `ClusterInbox` will implement the same Effect-typed protocols
    that `MemoryJournal` / `LocalInbox` do, satisfying the same
    conformance suites.

  Cost: the migration was a one-day mechanical conversion. Test
  bodies cross at `Effect.runPromise` / `Stream.runCollect` at the
  vitest edge; impl bodies are `Effect.gen` / `Effect.sync` /
  `Effect.tryPromise` wrappers. Nothing fundamentally new is being
  built — we're aligning the substrate with the blueprint that
  already specified it. The longer this drift had run, the more
  expensive the conversion.

## Open architecture decisions (deferred from blueprint)

Top of the priority list from `17-open-questions.md`:

```
1. A19 — PersistenceBackend methods (Phase 5; defer)
2. A13 — ExecutorDelta shape (Phase 4c; defer)
3. C6 — Provider-side tool execution marker (Phase 4c; defer)
4. B5 — Handler ID validation mechanism (Phase 4b; defer)
5. A1 — features[] registry (Phase 1; address as types land)
6. E11 — Spec version migration on restore (Phase 5; defer)
7. Inbox idempotency cache size + TTL (Phase 2)
8. Per-harness inbox message catalogs (cross-validate during 4-9)
9. Cluster routing integration with @effect/cluster (Phase 5 spike)
```

None of these block immediate work.

## Quick-start for a new session

```
1. Read this file (STATUS.md).
2. Skim docs/proposals/v2/IMPLEMENTATION-PLAN.md for phasing.
3. Read blueprint/00-overview.md for the architecture map.
4. Read blueprint/01-harness-principle.md + blueprint/19-foundation.md
   for the foundational concepts.
5. Check "What's next" section above for the immediate work item.
6. Update this file when work completes.
```

## How to update this file

When finishing a session or work block:

1. Move items from "What's next" → "What's done" as appropriate.
2. Add a dated entry to "Decision log" for any non-obvious choices.
3. Update "Current state" phase markers.
4. Add new pending decisions if encountered.
5. Note any environment surprises.
6. Commit alongside the work it describes.
