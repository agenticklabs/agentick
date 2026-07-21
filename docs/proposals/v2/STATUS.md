# Agentick v2 — Implementation Status

**Branch:** `feat/v2`
**Last updated:** 2026-07-12 (later) — **ADR 77 spine-compose COMPLETE (Stages 3–6) — THE SESSION IS ONE FIBER, TELEMETRY NESTS, ABORT TEARS DOWN IN-FLIGHT WORK, TOOL CALLS RUN IN PARALLEL, TIMEOUT IS OPT-IN, AND `.fx` IS DOCUMENTED PUBLIC. The `Effect.gen` loop rewrite landed behind the 28-test characterization diff (byte-identical green on the first run); the session runs the composed loop on the app's telemetry `ManagedRuntime`, so a `session.send` under a collecting tracer now produces a NESTED span tree (`loop:command:run-execution` root > executor/reconciler/tool children, `parent_op_id` auto-linked via FiberRef). This is the payoff the whole spine was building toward — before Stage 3 it was ~40 orphan `runPromise` roots. 5 commits this session (`f63a7ff9`→[this]); workspace 145/145, full packages-next suite green. KEY FINDINGS: (1) twin criterion sharpened to "twin iff `runHarnessProtocol`-backed" (notifyLifecycle needs none — bare-async bridge); (2) overriding an executor's PUBLIC facade does NOT intercept its `.fx` twin (caught two facade-intercepting test doubles at the integration layer — the net working as designed); (3) most Stage-4 plumbing already existed (`runHarnessProtocol` takes a runtime, `parentOpId` auto-threads via FiberRef) so Stage 4 was a ~1-line routing swap. Stage 5+6 ALSO landed: (a) structured cancellation — `loop.abort()` (→ `session.send().abort()`) tears down in-flight model/tool work immediately via a per-execution `AbortController` merged into the signal threaded to `executor.fx.run`/`dispatch` (signal-forwarding — preserves the accumulator + char-byte-identical); (b) PARALLEL tool dispatch — a tick's tool calls run concurrently by default (`toolConcurrency`, `Effect.all` keeps call-order; rendezvous-proven); (c) opt-in execution `timeoutMs` (no default → `stopReason:"timeout"`, structured abort); (d) `.fx` + the Promise edge-facade documented as first-class public surfaces (loop-executor README). Dead-Promise-path check: none to remove (facades are the frozen public edge). Deferred: whole-spine whitelabel namespace (needs fiber-context read, `TODO(stage-4: fiber-context-namespace)`) + ADR 76 middleware tier-4. See SPINE-COMPOSE-PLAN.md (authoritative tracker) + the 2026-07-12 entries. Prior:** 2026-07-12 — **ADR 77 Stage 1+2 BUILT: the `.fx` dual-typed edge across the spine + streaming edge as a singular concept (`AsyncStream`/`runHarnessStream`) + `readonly fx` hoisted onto the four spine protocols (`c27f4235`). Gate 0 char net closed (28 tests). 20 commits `611a0262`→`724788bb`. Prior:** 2026-07-10 — **Change-event notify seam (`createChangeNotifier`) BUILT in pubsub-next + FIRST RETROFIT landed (knobs StateDelta now projects over `onChange`, behavior-preserving); ADR 75 rescoped to two foundational bricks (wake seam cut); ADR 76 (operation middleware scoping) drafted (base-harness scaffold in DRAFT); `@effect/rpc` at the wire rejected (JSON-RPC 2.0 for MCP parity). 5 commits landed (`bb59b0bd`, `ed631113`, `2c29646d`, `a6811983`, + this status). See 2026-07-10 entry. Prior: StateDelta emission landed (`649bc919`): knobs-state JSON-Patch channel + `applyJsonPatch` in utils-next — ADR 73 native adoption; client-apply deferred to a generic channel-consumer. Earlier (2026-07-08): MCP/resources wave COMPLETE (see 2026-07-08 entry): ADR 63 compiler-surfacing BUILT (b-core, `125fdfb0`); ADR 64 log/progress signal family + adversarial hardening (`9b45d810`, `b801af36`); ADR 65 roots-as-projection, both directions (`b92e2275`, `4c8b6f95`); resource front-ends + `withMCP` surfacing + `mcpServerInfo`/alias-keying (`668afdcf`); skills `skill://` asset direction + markdown-first stance recorded (`67c6dfc1`). Earlier: Verified gates + read-only knobs landed (gates/knobs/spec) — see dated entry below. Earlier: MCP push started: gap-mapped (v2 ahead architecturally, regressed on coverage vs v1); Wave 1 HTTP transports LANDED (`08470a28`) — real-loopback conformance, OAuth reachable; ADR 62 (ResourcesHarness) + ADR 61 correction drafted. Earlier: #240 sandbox-local OS-jail (`73e70e16`) — exec runs jailed (seatbelt/bwrap/unshare/cgroup), confinement PROVEN; closes the silent v1 regression. Auth: slice-3 relocation WITHDRAWN (`25800124`) — per-transport authSource stays. Resume #139 (`30e448ce`); stores #132 (`dcc5565b`); ingress authn slice 1 (`59b66185`); sandbox `sandbox-lambda-next` (`9ab97cd6`).**

**2026-07-21 — TOOL-CONFIG RESTORATION PASS B (tool-call presentation) BUILT. NOT committed.** Restored v1's `displaySummary` + added model-self-narration, reusing v2's existing pipes (schema projection + the tool lifecycle events). **Spec:** `ToolAnnotations` gains `title` / `displaySummary` (string | `(input,ctx)=>string` seam, erased on the wire) / `narrate`; new RESERVED `TOOL_NARRATION_FIELD = "_summary"` const + `ToolPresentation` interface in `data/declarations.ts`; `DispatchResult.presentation` + `LifecycleToolEnd.presentation` + `LifecycleToolStart.narration` slots; `narrate?: boolean` threaded onto `ProjectInput`/`RunInput`/`RunExecutionInput`/`SessionHarnessOptions`/`CreateSessionInput`/app options. **Pipe 1 — injection (`model/canonical-projection.ts` `buildTools(tools, narrate=true)`):** injects an optional `_summary` string property into each model-facing tool JSON schema, gated on `narrate && annotations.narrate !== false && !schema-already-has-_summary`; never in `required`; shallow-copies (never mutates the shared cached raw schema). **Pipe 2 — strip+resolve (`tool-executor/harness.ts` `dispatchBody`):** strips `_summary` from the raw input BEFORE validation (shallow copy, MODEL-DOOR ONLY — never reaches handler/tool_result), then resolves `presentation` as FOUR DISTINCT fields (`name` / `title` / `summary` / `narration`, NEVER collapsed — the framework presumes no precedence; the client composes identity `title ?? name` + activity `narration ?? summary`) — the SINGLE resolution site (holds all sources + validated input) — onto `DispatchResult.presentation`. (Corrected from an initial collapsed-`summary` build per Ryan: title=identity and summary=activity are distinct, both surfaced.) **Surface:** loop (`loop-executor/harness.ts`) reads the eager narration off `tc.input` for the `tool-start` spinner (live, pre-dispatch) + threads `DispatchResult.presentation` onto `tool-end`; both REUSE existing lifecycle events. **App-level off-switch** (token cost is real): `createApp/createSession({ narrate:false })` cascades app→session→`runExecution`→`ProjectInput.narrate`→`buildTools`; default ON. `createTool` surfaces `title`/`displaySummary`/`narrate` typed to `TInput`. Gates: `pnpm typecheck --force` 152/152 (0 cached); root vitest tool-executor/tool/model/spec/loop/session/app/executor/model-anthropic 1316 passed +16 new (`model/…/narration-injection.spec.ts` 8, `tool-executor/…/narration-strip.spec.ts` 8); oxfmt clean; oxlint 0 errors. Docs: tool-executor README §"Tool-call presentation" (precedence + reserved field + TOKEN-COST + off-switch) + model README §"Tool-call narration injection" + both Verified-by. **DEVIATION from the contract's locked assumption (reported):** tool-start is emitted by the LOOP *before* dispatch resolves, so the full precedence chain (which needs post-validation `displaySummary`) can't ride tool-start — per the contract's STEP-3 fallback, the resolved `ToolPresentation` rides `DispatchResult.presentation` + `tool-end`, and only the eager model `narration` rides `tool-start` (which is exactly the live spinner value). **Prior:** 2026-07-20 — STORE CONVERGENCE RUN 1 (`Store` universal): `Store` is now the ONE store contract — zero store-level straddle. NOT committed.** `CollectionStore<T,Q,PruneArg> extends Store<T, Q, CollectionMutation<T>>` and `LogStore<T> extends Store<T, LogQuery, LogMutation<T>>` are formal profiles over the seam (new `LogQuery`/`LogMutation<T>` in `spec/protocol/log-store.ts`, derived from the real `read`/`history`/`append` params); `CredentialsStore extends Store<CredentialEntry, CredentialQuery, CredentialMutation>` conforms too (kept its value-projecting `get`/`set`/`has`/`keys` sugar — the seam is no more value-exposing than `get`, and the store is server-resident so no wire concern). Every concrete store now implements `query`/`mutate`: the in-memory defaults (`MemoryCollection`/`MemoryLog` + the composing `InMemoryTask/Session/Resource` stores + `InMemorySkill/PromptStore`), the generic decorators (`IdempotentCollectionStore` — `mutate` routes through the dedup path; `JournalProjectedStore` — `query`=fold, `mutate`=no-op, matching its no-op `put`/`delete`), and the adapters (`PostgresTaskStore`, `FsTimelineStore`, `PostgresTimelineStore`). The Cut-1 `TODO(store-cut2)` coexistence markers (memory-collection, skills, prompts) are gone. Gates: `pnpm typecheck --force` 152/152 (0 cached); root `vitest` touched packages 1283 passed + timeline-fs conformance 19 (postgres conformance skipped, no DB); oxfmt clean; oxlint 0/0. Docs: `store.md` (BUILT + convergence-cuts LANDED), this entry.

**2026-07-15 — ADR 88 LIVE MEDIA SESSIONS v0 core SCAFFOLDED: `@agentick/live-next` (harness + handle + routing + wire + client), FAKE-transport unit tested. NOT committed.** New OPTIONAL package (like sandbox/mcp, NOT bundled). **Spec (`spec-next`):** `data/media.ts` (`MediaFrame`/`MediaEnvelope`/`MediaSessionRef`/`LiveState`/`TranscriptDelta` + the `MediaTransport`/`MediaUplink`/`MediaDownlink` capability, `openUplink`/`openDownlink`, `send`+`close` verbatim from ADR 88 §Two planes — `MediaDownlink` I spelled out as `onFrame`+`close` since the ADR left the downlink mirror implicit); `protocol/live-harness.ts` (`LiveHarnessProtocol` + `LiveStream` context + `Live` alias); `client/live.ts` (`LiveSessionHandle` portable surface — NO stream types); `readonly media: boolean` added to `TransportCapabilities` (REQUIRED per the ADR → swept `media: false` onto all 4 transport impls + 6 client-core test literals; no-backcompat). **Package (`live/`):** `harness.ts` (`LiveHarness extends BaseHarness<"live">` — stream registry keyed by streamId, `start`/`push`/`interrupt`/`stop`/`close`, uplink fan-in + downlink sink + transcript/state channels), `augment.ts` (`HookBridges.live?`+`SessionHarnessProtocol.live?`, OPTIONAL slots), `extension.ts` (`withLive({ onStream })` = bare SessionExtension mirroring withTasks/withSandbox — self-constructs the harness + `registerNamespace("live")`), `wire.ts`+`wire-augment.ts` (`liveWireExtension`), `channel.ts` (live-transcript/live-state), `client/` (`liveSessionHandle` with `uplink: WritableStream`/`downlink: ReadableStream` runtime projections over `sendFrame`/`onFrame`; `sessionLive` facet with `start()`/`active`; `register.ts` → `session.live`). **DELIBERATE DEVIATIONS from the two things ADR 88 explicitly enumerates (flagged for review):** (1) added a THIRD wire method `live/interrupt` (ADR §Two planes names only start/stop) — the `LiveSessionHandle.interrupt` spec method is a genuine client→server signal distinct from stop (keeps the stream open, carries playedMs), so folding it into stop would misrepresent it; (2) added `LiveStream.onInterrupt` (not in the ADR's explicit `LiveStream` member list) — the interrupt signal must land somewhere for the app to compose barge-in, which the ADR itself prescribes. **Wire registration is OPTIONAL not builtin:** `liveWireExtension` is exported for the adopter to pass to `createGateway({ wireExtensions })`; NOT added to `app-next`'s `builtinWireExtensions` (confirmed sandbox/mcp have no client↔gateway wire ext — live is the first optional one; the `ExtensionBundle.wire` seam exists but withMCP/withTasks are bare SessionExtensions, so I mirrored that + separate export). **Deferred (ADR 88 Future directions, NOT built):** real WS/binary `MediaTransport` (`transport-ws-media-next`), `pipelineEngine`, `SttEngine`/`TtsEngine`, `TurnArbiter`, `RealtimeModel`, driven-loop, per-op hooks. Gates GREEN: `pnpm typecheck --force` 150/150 (0 cached); `vitest run live spec` 542 passed (live: wire 6 + harness 14 + client-handle 11 = 31); oxfmt clean; oxlint live 0/0. Checklist done EXCEPT `.changeset/config.json` `linked` is `[]` (no linked group for -next pkgs — nothing to add); typedoc + vitepress nav + README added; `pnpm install` ran. **Prior:** 2026-07-15 — CHANNEL READ STACK: `channelStream` (ground-floor primitive) + `channelView` (fold sugar) unified; elicitation converged; `onChange`/`subscribe` semantics corrected.** A design-workshop-driven refactor of the client read surface (ADR 33). **The one truth is the frame stream, not the view.** New `channelStream(client, scope, channel)` in client-core — a channel's ordered frame-payload stream (snapshot-first then deltas), materializes nothing, single-consumer (`for await` OR `onChange`); it's the general construct for ANY state shape (value, large collection, paginated, request/event). `channelView` REFACTORED to fold OVER `channelStream` (was: called transport.subscribe itself), with the corrected two-feed surface: **`subscribe((state) => …)`** (STATE feed — the folded value; also the `useSyncExternalStore(subscribe, get)` contract, React ignores the value we hand it) + **`onChange((frame) => …)`** (CHANGE feed — each frame it folds, NOT the whole state) + **`status: "loading"|"live"|"closed"`** (readiness; replaces `closed`). `ChannelView<T>` → `ChannelView<T, F=unknown>`. This corrects the `onChange(fullState)` I'd shipped hours earlier — the payoff shows in the coding example: tasks' `seenTasks` dedup Set is GONE (`session.tasks.onChange((task) => …)` hands the one changed task; `session.knobs.subscribe((knobs) => …)` hands the full store). **Elicitation converged onto the uniform read surface:** the bespoke `ClientElicitationStream` + `session.onElicit` are DELETED — `session.elicitations` is now a `ChannelStream<ClientElicitationHandle>` (opts out of the fold — each frame is a discrete request, not state; taps the envelope for correlationId but PRESENTS the uniform `ChannelStream`), consumed via `session.elicitations.onChange((e) => e.accept(...))` — identical read surface to tasks/knobs. So the invariant now holds: **every channel reads through `channelStream`/`channelView`; the only per-channel variation is the state/frame TYPE and the domain WRITE commands (`knobs.set`/`e.accept`/CQRS).** Rippled through spec (ChannelStream + ChannelView types) + client-core (impl + 2 new tests) + knobs/tasks façades (F param) + elicitation (+e2e dogfoods it) + the example. Workspace typecheck 149/149; affected suites 376 green (+ channel-stream 3 + status/onChange tests). Docs: client-core README (channelStream primitive + two-feed rule). NOT committed yet. Also this session (prior, committed): ergonomic sugar (`inProcessTransport({ gateway })` killed the DispatchSink boilerplate; onChange/onElicit) `1bf5b787`; eval trials+pass@k `bf428407`; eval HTML report `d9c16ebf`. **Prior:** 2026-07-14 (later¹⁰) — EVAL-NEXT: RUN-ACCESS + SCORES + THE `t` PLUGIN SEAM + workspace/judge plugins + a coding-agent eval.** Extended `@agentick/eval-next` (was MVP: `defineEval` + 4 imperative assertions) into a maximally-useful agent-eval surface, grounded in its "vitest for agents" model (NOT a Braintrust rewrite). **Core:** (1) `t.result` exposes the full `SendResult` (usage/ticks/output/toolResults — was fetched-and-dropped); (2) `t.expect(label, passed)` (generic boolean scorer, gates `passed`) + `t.score(label, value)` (numeric, does NOT gate — aggregated across matrix); (3) `formatResult`/`formatMatrix` console scorecards. **The plugin seam (the `t` extension mechanism Ryan asked for):** `EvalContextExtensions` empty seed + `EvalContext extends` it + `registerEvalPlugin` (global install-to-appear) / per-eval `plugins: []` — the SAME ADR-27 augmentation law as HookBridges / SessionHandleExtensions / ToolHandlerCtxExtensions. A plugin is `(rc: EvalRunContext) => methods` merged onto `t`; `rc` gives `result()`/`toolCalls`/`record`/`score`. Runner types the base literal as `Omit<EvalContext, keyof EvalContextExtensions>` (same trick as makeSessionHandle) so downstream augmentation doesn't break the core compile. **Two first-party plugins (subpaths, prove the seam):** `/plugins/workspace` (`t.sh`/`t.file` — EXECUTABLE scoring: grade coding agents by RUNNING the result, SWE-bench model) + `/plugins/judge` (`t.judge(rubric)` — LLM-as-judge, model-agnostic via injected `generate`, records assertion + score). `declare module "@agentick/eval-next"` self-augmentation from a subpath works. **The coding-agent eval (`example/v2-coding-agent/src/eval/coding.eval.tsx`):** executable (`t.file`/`t.sh` run the produced code) + trajectory (`t.calledTool`) + budget (`t.result.ticks`) + judge, ~15 lines; `codingEval.matrix({ model: [...] })` benchmarks across models. Agent runs headless (`setAutoApproveWrites(true)` — evals have no client to answer write_file's elicitation; `t.onElicit` is the follow-on). 5 new tests (16 total, all green), workspace typecheck 149/149. Roadmap-aligned names kept for the rest (`t.onElicit`/`t.stubTool`/`t.withinBudget`/trials+pass@k). **Prior:** 2026-07-14 (later⁹) — NEW EXAMPLE `example-v2-coding-agent`: the client-ergonomics forcing function, end-to-end.** A naive coding agent (server-side JSX: `read_file`/`list_dir`/`grep` + `write_file` gated behind `ctx.elicit.confirm(...)` + `run_shell` via `ctx.tasks.submit(...)`, a `explainSteps` knob, real OpenAI model) driven by a decoupled client over the in-process transport. The client uses ONLY `@agentick/client-next` (the bundle) — proving install-to-appear: `session.knobs` (live view + client-driven `set` = CQRS), `session.tasks` (live status from run_shell), `session.elicitations()` (auto-approves write_file), `handle.events()` streaming (`content-delta`/`tool-dispatch-start`), `session.onLog`. Typechecks clean against live v2 packages (standalone `tsc --noEmit` EXIT=0); runs with an OPENAI_API_KEY. Borrows tentickle's prompt tone (ACT-don't-narrate / list→grep→read / edit>write) + mirrors `v2-otto`'s task-tool pattern. Validated real API surface: `gateway.createApp({appId, rootElement, options:{model, reconciler: reactReconciler()}})`, tool-handler `ctx` (`elicit.confirm`→bare-boolean reply, `tasks.submit`, `log`), client `handle.events()` StreamEvent union. Files: `src/{tools.tsx,agent.tsx,server.ts,client.ts,index.ts}` + README + .env.example. **Prior:** 2026-07-14 (later⁸) — CLIENT CORE/BUNDLE SPLIT: `@agentick/client-next` is now the batteries-included DEFAULT; `@agentick/client-core-next` is the lean core.** Ryan's call (cleaner than an interim `client-bundle-next`): invert the naming so the default name gives you everything. `git mv client → client-core` (renamed `@agentick/client-core-next`, the agnostic core — createClient/makeSessionHandle/registry/handles, deps NO harness) + a NEW `@agentick/client-next` in `packages-next/client` (the bundle — 3 side-effect imports of `tasks`/`knobs`/`elicitation` `/client` + `export * from client-core-next`, zero logic). At the v2 cut → `@agentick/client` (bundle) + `@agentick/client-core` (core). Uniform sweep: EVERY current `@agentick/client-next` import/dep is a CORE usage → 59 files rewritten to `client-core-next` (harness /client packages MUST dep the core, never the bundle = cycle); the freed `@agentick/client-next` name is the bundle. **NO CYCLE** (bundle→harnesses/client→core; core→nothing). **Bug the rename EXPOSED + fixed:** the bundle is the first place `knobs/client` compiles OUTSIDE the knobs package, and `knobs/set` (a `WireMethods` augmentation in the server-side `augment.ts`) wasn't in scope → split it into a type-only `knobs/src/wire-augment.ts` that BOTH the server augment AND the `/client` index side-effect-import (zero runtime, no server code in a browser bundle). Proof: workspace typecheck **146/146** (was 145 — +1 net package); bundle test (registry has all 4 slots + a session handle self-assembles `.tasks`/`.knobs`/`.elicitations()`/`.respondToElicitation()`); client-core+tasks+knobs+elicitation+transport-in-process suites green (171). Docs: bundle README + core README (retitled, metapackage note points at the `client-next` bundle) + ADR 87 §9 (packaging) + tasks/knobs/elicitation/client-extensions READMEs swept (their client dep is the core). Adopter-client refs (root README, gateway/tool-executor READMEs) STAY `@agentick/client-next` (still valid — the bundle IS what an app installs). PRE-EXISTING gap noted: the v2 client family (client-next/client-core/client-extensions) isn't in the website typedoc/vitepress nav — deferred with the rest of the v2-website wiring. NOT committed yet. **Prior:** 2026-07-14 (later⁷) — ELICITATION IS NOW A CLIENT REGISTRANT: client-core is fully harness-agnostic (ADR 87 thesis complete).** The last hardcoded harness surface in client-core is gone. `client/handles.ts` held ~120 lines of elicitation-specific code (`makeElicitationStream`/`parseElicitation`/`wrapHandle`/`ELICITATION_CHANNEL_FQN`) + the `elicitations()`/`respondToElicitation()` methods baked into `makeSessionHandle` + the two methods declared on the spec `SessionHandle` — a direct ADR-27/87 violation (client-core is supposed to know about NO harness, exactly as it now doesn't for tasks/knobs). MOVED to `@agentick/elicitation-next/client` (new subpath): `elicitations.ts` (impl, retyped against `ClientProtocol`) + `register.ts` (augments `SessionHandleExtensions` with `elicitations`/`respondToElicitation`, registers both). **API UNCHANGED** — a registrant slot may be a METHOD (the lazy getter yields the function), so call sites keep `session.elicitations(opts?)` / `session.respondToElicitation(input)`; only a side-effect `import "@agentick/elicitation-next/client"` is added. Spec `SessionHandle` lost the two methods (now contributed via augmentation); the client elicitation TYPES stay in `spec/client/elicitation.ts` (protocol-shaped, like the rest of `spec/client`). elicitation-next gains a `client-next` dep — NO CYCLE (client-next deps zero harnesses; direction is harness→client, same as tasks/knobs; the `/client` subpath pulls only spec+client+utils+the pure channel constants, never the server harness). Proof: workspace typecheck 145/145; transport-in-process elicitation e2e (6) + unit (3) GREEN through a real gateway+client, driven purely by the side-effect import; client+elicitation suites 157 total. Elicitation is now the 3rd/4th registrant (tasks, knobs, elicitations, respondToElicitation). **SURFACED CONSTRAINT (Ryan's call):** the "always available automatically" bundling belongs in the public `agentick` metapackage's `/client` entry (`import "@agentick/{tasks,knobs,elicitation}-next/client"` — the client twin of how it bundles server built-ins), NOT client-core (agnostic by design; self-bundling = the cycle). But `packages/` + `packages-next/` are ONE pnpm workspace and `packages/agentick` already owns the name `agentick`, so the v2 metapackage is name-blocked until the v2 cut. Interim options pending decision: (A) v2-named client-bundle package now [needs a name], or (B) defer to the cut + document the metapackage bundle-list. **Prior:** 2026-07-14 (later⁶) — `taskStatusView` OPEN-WITH-SNAPSHOT: `session.tasks` now survives reconnect/late-subscribe.** Closes the substance gap flagged after the ADR 87 seam — the task-status channel previously had NO opening snapshot, so a subscriber saw only tasks that transitioned AFTER it joined (never a backfill of the existing list). Now `TasksHarness implements ChannelSnapshotProvider` (`snapshotChannel = "task-status"`; `channelSnapshotPayload()` returns `{ kind: "snapshot", tasks: this.list() }` from the live projection) → the session's generic bridge scan discovers it → `sub/subscribe` prepends the snapshot as frame one (K8s watch-list model, same seam knobs uses). Delta frames stay BARE `TaskInfo` (byte-identical, MCP conceptual-mirror preserved — the substrate channel is independent of the MCP `notifications/tasks/status` path via `task-bridge.ts`, verified); only the OPENING frame is discriminated (`kind: "snapshot"`), and the client `taskStatusView` reduce distinguishes structurally (`"kind" in frame` seeds the whole store; else folds the bare delta by taskId). 3 new tests (harness provider payload reflects live tasks; client seeds-from-snapshot-then-folds-deltas; existing bare-delta fold unchanged); tasks+session suites green (134), workspace typecheck 145/145. NOT committed yet. **STILL OPEN (ADR 87 follow-ups, deferred):** verb-alignment on the server/client `session.tasks`/`.knobs` twin (client replica's `get()`/`set()` signatures diverge from the server authority's — CQRS-justified, documented, but the *great* version aligns the vocabulary); `enumerate` + reconnect re-seed as a first-class client-extension composition; elicitation/resources/mcp as further registrants; client metapackage (bundle the built-in `/client` subpaths) once ≥3 registrants; ui-core multi-session firehose (the "listen to N sessions at once" ask — explicitly low-priority per Ryan). **Prior:** 2026-07-14 (later⁵) — ADR 87 CLIENT SUB-HANDLE SEAM BUILT: `client.session(id).tasks` / `.knobs` self-assemble (install-to-appear). The client twin of the server's `HookBridges`.** Workspace typecheck **145/145**; client+tasks+knobs suites green (296 passed, 6 new tests). The obvious-but-missing API: a harness's client façade (`taskStatusView`, `knobsHandle`) was arg-only (`taskStatusView(client, id)`) — you had to know it existed and wire it by hand. ADR 87 makes it a NAMED SLOT on the generic `SessionHandle`, contributed by the harness `/client` package via the SAME module-augmentation law as the server bridges (ADR 27). **(1) Spec seed:** empty `interface SessionHandleExtensions {}` in `spec/client/handles.ts` (twin of the empty `HookBridges` seed); `SessionHandle extends …, SessionHandleExtensions`. **(2) client-core registry (`session-handle-extensions.ts`):** `registerSessionHandleExtension(name, (client, sessionId) => sub)` + `applySessionHandleExtensions(handle, client, id)` spreads each registered factory as a **lazy, cached getter** that skips any name already on the handle (never shadows a real member). `makeSessionHandle` types its literal as `Omit<SessionHandle, keyof SessionHandleExtensions>` (full base-checking, drops the augmented slots the getters add) then `applies…` + returns `as SessionHandle` — so the slot stays **NON-optional** (`session.tasks`, not `session.tasks?.`) in a harness compilation while client-core stays agnostic. **(3) First registrants:** `@agentick/tasks-next/client` → `session.tasks` (`ChannelView<Record<taskId, TaskInfo>>` = `taskStatusView`); `@agentick/knobs-next/client` → `session.knobs` (`KnobsHandleView` = `knobsHandle`, read view + `set`). Each is a 3-part `register.ts` (`declare module` slot + `registerSessionHandleExtension` + side-effect import from the `/client` index). Install-to-appear: importing the subpath is the ONLY thing that makes the slot exist — same as the server's bundled-vs-optional packaging law. Closes the "`client.session(id).knobs` sugar" follow-up flagged in the 2026-07-12 (later⁴) channel-arc entry. Docs: client README §"Session sub-handles — install-to-appear (ADR 87)" (usage + how-to-publish-your-own). Prior tiny build this session: `taskStatusView` (`2058996e`) + ADR 87 draft (`0e7908d4`). NOT yet committed (seam left in tree). **Prior:** 2026-07-14 (later⁴) — ADR 84 GATEWAY PROGRAM COMPLETE: full hookable op surface + canonical lifecycle. 3 commits (`ea96cfa4`, `fcd563be`, `a3683038`) close it out; workspace 145/145, gateway+transport+connector+spec green.** **(1) `gateway:create-app` + `authorizer:authorize` (`ea96cfa4`, §4/§5):** createApp normalizes both overloads then wraps the mount in a `gateway:create-app` op → `onBeforeGatewayCreateApp` (veto/transform, e.g. tenant-scoped appId) / `onAfterGatewayCreateApp`; a `mapGatewayError` routes `GatewayClosedError`/`AppAlreadyExistsError` through the op Fail channel so `instanceof` survives. `authorizer:authorize` is the FINE contextual auth layer — `gateway.authorize(input)` wraps `authorizer.authorize` in an op (`onBeforeAuthorizerAuthorize` adds contextual scopes / denies, `onAfterAuthorizerAuthorize` audits); `dispatch.ts` routes the verb-scope + additive-role policy calls through `host.authorize`. **The structural ceiling (`requiredScopes`/`scopeCovers`) stays a direct, un-waivable check OUTSIDE the op** — proven by a test where the ceiling denies regardless of a maximally-permissive hook (which never fires). **(2) LIFECYCLE CANONICALIZATION (`fcd563be`, breaking):** `listen()` is now ENFORCED — the gateway starts UNSTARTED; `createApp` throws the new `GatewayNotStartedError` until `listen()` runs (a pre-gate before the op; closed-check wins). This makes the `gateway:start` seam structurally guaranteed (space for future framework startup logic) and gives ONE canonical start call. `closeGateway()` DROPPED (no deprecation) — `close({ drain })` is the sole terminal verb (pairs with `listen()`, matches `app.close()`). Swept ~103 `closeGateway→close`, 13 test files gained `await gateway.listen()`, every doc example is now `createGateway → listen() → createApp → close()`. **(3) `gateway:accept` (`a3683038`, §4, the LAST op):** `gateway.accept(info: ConnectionInfo)` wraps a `gateway:accept` op → `onBeforeGatewayAccept` (throw to REJECT the connection) / `onAfterGatewayAccept`; guard-able. It's a CONNECTION concept, so only connection-oriented transports fire it AFTER ingress-authn, BEFORE frames: WS (`wss.on("connection")` → reject = `ws.close(1008)`), Unix (`netCreateServer` cb → reject = `socket.destroy()`); **HTTP deliberately does NOT** (request-oriented — its admission IS the per-request `authorize` path; code comment explains). `transportId` threaded from each wrapper's stable id (`websocket:${port}`, `unix-socket:${path}`) for per-peer rate-limiting. Real-loopback proof: a throwing `onBeforeGatewayAccept` drops a live WS (close 1008) + Unix client connection; a permitting hook round-trips ping, firing once. **The gateway op surface is now: `gateway:start` · `gateway:close` · `gateway:create-app` · `authorizer:authorize` · `gateway:accept` · `wire:<method>` — all hookable, HOOK-LIFECYCLE "Planned — ADR 84" section now empty/landed.** Prior (earlier 2026-07-14): the foundation — live interceptor inheritance (`c3cec53c`, gateway hooks fold live gateway→app→session→subs), `wire:` prefix (`39c4fb88`, no double-fire), client wire hooks (`df2b6acf`), listen/close lifecycle + gateway→app capstone (`1f46ed22`) — see the `ca647896` status entry. **Prior:** 2026-07-14 (later³) — CONCRETE `ServerTransport` WRAPPERS LANDED (ADR 84 §2). The follow-on to the abstraction is now FILLED — all four factories ship.** Not yet committed (left in tree). Workspace typecheck **145/145**; the four transport packages + gateway suites green (29 new tests: `runServerTransportConformance` × 4 = 22 + real-bind/gateway tests). Each factory inverts the raw shape — **wire config binds at construction; host is injected at `listen(host)`** — and lives at each package's `./server` subpath (`inProcess` at the package root). **(1) `webSocketServerTransport({ port, host?, … })`** (`transport-websocket/src/server/transport.ts`): OWNS the Node `http.Server` — `websocketServer` only ATTACHES a WS upgrade handler, binds no port, so `listen(host)` does `createServer()` → `websocketServer({ httpServer, gateway: host })` → `httpServer.listen(port)`; `close()` tears down BOTH the WS handle and the server it created. **(2) `httpServerTransport({ port, host?, … })`** (`transport-http/src/server/transport.ts`): same http-server ownership (the raw `httpServer` mounts on a caller-supplied Node server via `on("request")`). **(3) `unixSocketServerTransport({ path, … })`** (`transport-unix-socket/src/server/transport.ts`): simplest — `unixSocketServer` binds its own `net.Server`, so the wrapper just defers the host and awaits the `listening` event; `close()` closes the socket (Node unlinks the path). **(4) `inProcessServerTransport()`** (`transport-in-process/src/server-transport.ts`): direct-call transport — the in-process client reaches the gateway through an adopter-built `handler` closure, NOT a bound listener, so `listen`/`close` are HONEST no-ops (documented). Exists so an in-process deployment lists its transport alongside the network ones and `gateway.listen()` fan-out stays uniform; stable id `"in-process"`. Both WS and HTTP also accept `{ httpServer }` (adopter-owned server) — attached, never closed. KEY FINDINGS: (a) no port-discovery accessor on `ServerTransport`, so real-bind tests grab a free ephemeral port via a throwaway probe listener, then hand it to the wrapper — teardown is proven by re-binding the freed port (avoids fighting the client reconnect machinery — `reconnect` is a policy object, not a boolean). (b) config-derived ids (`websocket:${port}`, `unix-socket:${path}`, `http:${port}`, `in-process`) — no module-level `ulid`/counter, so oxlint's no-mutable-counter rule is satisfied by construction. (c) `DispatchHost = GatewayHarnessProtocol`, so the raw factories' `gateway: DispatchHost` slot takes the `listen(host)` host directly — zero adapter. Docs: all four package READMEs (factory + `createGateway({ transports })` example + Verified-by row); ADR 84 §2 + §7 flipped to LANDED with the four signatures. `transport-next/src/server/dispatch.ts` + `gateway/src/harness.ts` untouched (owned by the next change). **Prior:** 2026-07-14 (later²) — `ServerTransport` ABSTRACTION + GATEWAY OWNERSHIP (ADR 84 §2).

**2026-07-14 (later²) — `ServerTransport` ABSTRACTION + GATEWAY OWNERSHIP (ADR 84 §2). The `listen()`/`close()` transport fan-out TODO is now FILLED.** Not yet committed (left in tree). Workspace typecheck **145/145**; gateway+spec+spec-conformance suites **600/600 green** (12 new gateway tests). **(1) Spec (`packages-next/spec/src/server/transport.ts`, new `server/` subpath):** `ServerTransport { id; listen(host: GatewayHarnessProtocol); close() }` — the symmetric server-side mirror of `client/transport.ts`. Uses `GatewayHarnessProtocol` DIRECTLY (not transport-next's `DispatchHost` alias — spec must not dep on transport-next). Wire config (port/path/tls) binds at the transport's construction; the one thing only the gateway supplies at listen-time is itself as host, so `listen(host)` is uniform. **(2) Gateway ownership (`gateway/src/harness.ts`):** flat `transports?: readonly ServerTransport[]` on `GatewayHarnessOptions` (withX convention, no `config:{}`); `listenBody()` awaits gateway-ready THEN `Promise.all(transports.map(t => t.listen(this)))`; `closeGatewayBody()` closes transports **FIRST** in the LIFO teardown (`transports → apps → extensions → substrate`) — transports are the ingress edge, so stopping them before apps tear down prevents an inbound frame routing `dispatchRequest(this,…)` into a half-closed app (mirror of `listen`, which binds transports LAST after ready seals the wire registry). Transport close failures best-effort. `listen()`'s started-latch short-circuits BEFORE the op, so a 2nd `listen()` does NOT re-fire `transport.listen`. **(3) Spy double (`gateway/src/testing/spy-server-transport.ts`, new `/testing` subpath):** `spyServerTransport()` records `listen` hosts + `close` count, typed against the spec interface. **(4) Conformance (`spec-conformance/src/server-transport.ts`):** `runServerTransportConformance(name, factory)` — bind/teardown/idempotency/re-listen. **DEFERRED (follow-on task, unchanged):** the concrete transport wrappers (`webSocket`/`http`/`unixSocket`/`inProcess`) wrapping the existing `websocketServer`/`httpServer`/`unixSocketServer` factories behind this interface. See `blueprint/84-…§2` (marked LANDED).

**2026-07-14 (later) — GATEWAY LIFECYCLE + LIVE HOOK PROPAGATION (ADR 84 + ADR 83 §4 amended). Gateway hooks now reach the whole tree, live.** 8 commits (`e686fe85`→`4dc38835`); workspace **145/145**, all affected suites green. **(1) Live interceptor inheritance (`c3cec53c`, ADR 83 §4 amended):** the frozen construction-fold is now LIVE — registering `.use`/`.guard`/`.hook` on a harness propagates to every live descendant (push-on-register + children set), a new child pulls the current set at construction, unsubscribe cascades by identity, close() detaches. Wired every edge (app→executor/loop/session + per-session elicitation/tasks/resources/tool-executor + session→knobs). e2e proof: a LATE `app.hook` reaches a session's tool-executor + knobs bridge (2-hop grandchild). **(2) `wire:` prefix (`39c4fb88`):** `runWireDispatch` names the op `wire:<method>` → `wire:session/send` Pascalizes to `WireSessionSend` → `onBeforeWireSessionSend`, distinct from the session op's `onBeforeSessionSend`. Retired the "collision is symmetry / fold-root no double-fire" call — it was propped on the gateway→app gap. The name is the routing: each hook fires at exactly one layer. **(3) Gateway lifecycle (`1f46ed22`, ADR 84):** `listen()` (hookable `gateway:start`, transport fan-out TODO) + `close({ drain })` (no `destroy` twin); `gateway:close-gateway`→`gateway:close` rename. CAPSTONE — `createApp` threads `interceptorParent: this`, so a gateway hook folds live gateway→app→session→sub (proven: post-createApp `gateway.hook({onBeforeToolDispatch})` reshapes a session dispatch). **(4) Client wire hooks (`df2b6acf`):** `client.hook()`/`client.hooks.on*` symmetric with the server, reusing the SHARED spec derivation (`HooksOf<WireAsCommandReg, ClientHookContext>` — `{params,result}`→`{input,output}` + `wire:` adapter). Wraps the request pipeline live. **(5) `_`-split (`4dc38835`):** `Pascal`/`deriveHookNames` split on `_` too, so snake_case wire ids mint clean camelCase (`app/run_once`→`onBeforeWireAppRunOnce`, was mangled `…Run_once`). NEW ADR 84 (gateway-lifecycle-and-transports) + `createApp(rootElement, input)` overload (`f4053a85`). DEFERRED (own arcs): ServerTransport abstraction + `withTransports` ownership (fills `listen()` fan-out); gateway `authorizer:authorize`/`gateway:accept`/`gateway:create-app` hooks (in HOOK-LIFECYCLE "Planned"). See `blueprint/84-gateway-lifecycle-and-transports.md` + `HOOK-LIFECYCLE.md`.

**2026-07-14 — THE ONE-PRIMITIVE THESIS COMPLETED: hooks ARE op-scoped middleware; the `Hooks` subsystem + its shadow cascade DELETED. Plus the imperative trio and verb-hookability across the harnesses (branch `feat/interceptor-collapse`).** Three follow-on waves on top of the collapse. **(1) Imperative trio (`8f8d9b0d`):** hooks are now runtime-registrable like `use`/`guard` — `harness.hook(config)` (batch → `Unsubscribe`) + `harness.hooks.onBefore<Verb>(fn)` (typed per-verb Proxy). Kebab verbs mint clean camelCase (`Pascal`/`deriveHookNames` split on `-` too). **(2) Verb migration:** `send`/`append`/`applyExecutorResult`/`applyToolResults` (session, `8ec1d86f`) and `elicit` (elicitation, `dbcf8ff5`) now route through `runOperation` via a `sessionOp`/`elicitOp` wrapper → hookable (`onBeforeSessionSend`, `onBeforeElicitationElicit`, …); form+URL unify into one `elicitation:elicit` op (before=request, after=response); session send's synchronous JOIN reservation stays atomic (88 session tests green incl. steering). **Documented limitations:** session verbs are hookable but NON-ADDRESSABLE (SendInput non-serializable, ADR 51 §1.2); `apply-*` hooks fire on the public facade, not the loop's in-fiber `*Fx` path. **Tasks (`c55b0143`): NOT hookable, by a proven boundary** — the seam is intrinsically ASYNC (`asBefore`/`asAfter` await) but `tasks.submit` returns `TaskHandle` synchronously; `runSyncExit` DIES on the async boundary (spiked). No hollow wrapper shipped — greppable `NOTE(adr-83)` + naming-lock tests + README. Unblockers: async `submit` (breaking) or a sync-hook fast-path (necessary-but-insufficient). **(3) HOOKS-INTO-`.use` COLLAPSE (`8c1cd87a`, ADR 83 amendment):** hooks rode a SECOND parallel cascade (`Hooks` class + keyed `hookLayer` + separate `hooks:` threading + `...hookLayer.forOp()` compose term). DELETED. New primitive `on<Command>(mw)` — the full typed op-scoped middleware (sugar over `.use`); `onBefore/onAfter<Command>` are now sugar over IT (`asBefore`/`asAfter`, which already produced middleware). Hooks register as op-scoped `transform` middleware on the ONE `.use` chain, self-scoping via `RuntimeContext.op` (the op's Pascal suffix), cascading through the ONE `inheritedInterceptors` fold. Adopter surface GREW (`on<Command>` added; config object + `onBefore/onAfter<Surface><Action>` names identical), substrate SHRANK. **GUARD UNTOUCHED** (already a `.use` interceptor). Compose order is now registration order within the transform rank (guards still outermost) — resolves ADR 82's "deferred interleave." Verification: full workspace **8250 passed, 1 pre-existing** (`retry.spec.ts` pollution/predicates WIP), typecheck 145/145. **Also caught:** the `app.fx.use wraps runOnce too` test was stale since the FOLD (`7be911a4` made `app.fx.use` reach fold-inherited ops) — proven failing at HEAD pre-change, corrected. Per-harness hookability map: see `blueprint/83-one-interceptor-primitive.md`. Not yet merged to `feat/v2`.

**2026-07-13 (later⁵) — THE VERDICT SUBSYSTEM COLLAPSED INTO ONE INTERCEPTOR PRIMITIVE; the cascade is now a FOLD, not a walk (ADR 83; `01092c6e` / `7be911a4` / `073dc138`, branch `feat/interceptor-collapse`).** The operation boundary had THREE interception mechanisms — the verdict **gate** (`HandlerRegistry` / `mergeVerdict` / `runInheritedBefore` / `LifecycleHandler`, a distinct before-phase), **middleware** (`.use`), and **hooks** (`onBefore`/`onAfter`). That is one concept — intercepting an operation — in three costumes. **ADR 83 collapses it to ONE primitive: the wrapping `Middleware`, with three KINDS** (`InterceptorKind = "guard" | "transform" | "observe"`, tagged via `tagInterceptor`; untagged ⇒ `transform`). `guard` = admission control (`proceed`/`veto`/`replace`/`defer`) — sugar `harness.guard(decide)` / `guardEffect`; a non-`proceed` `HandlerVerdict` desugars (`signalFromVerdict`) into a typed `OperationSignal` (`OperationVeto`/`Replace`/`Defer` in `op-signals.ts`) that the guard RAISES and `runOperation`'s settle step catches → **byte-identical terminal** (`terminateFromSignal` delegates to the same `terminate()` the verdict switch used; only the trigger changed). `transform` = plain middleware (hooks `onBefore`/`onAfter` are keyed sugar over it). `observe` = pure side-effect. `runOperation` composes ONE list `[...callMiddleware, ...inheritedInterceptors, ...ownMiddleware, ...hooks.forOp()]`, stable-sorted **guard-outermost** (`orderInterceptors`, `guard ≺ transform ≺ observe`) so deny-before-transform holds and a retry mw can't swallow a veto. **The verdict subsystem is DELETED.** **NAMING — `guard`, not `gate`:** the type system forced it — a `gate(decide)` on `BaseHarness` collided (TS2416) with `SessionHarness.gate(name) => GateHandle`, which is **loop continuation** (`@agentick/gates-next`), a different concept at a different scope. Rule: **guard : operation :: gate : loop.** New public API: `BaseHarness.guard` (`base-harness.ts:864`) / protected `guardEffect` (`:888`), `GuardDecider` (`:132`), and `ToolExecutorHarness.guardDispatch` (`tool-executor/harness.ts:461`, renamed from `onBeforeDispatch`). **THE CASCADE IS A CONSTRUCTION-FOLD, NOT A PARENT-WALK (generalizes ADR 82; SUPERSEDES ADR 81).** `ownAndInheritedMiddleware` + the `parent` pointer are GONE. Each scope snapshots its parent's `resolvedInterceptors()` at construction into a frozen `inheritedInterceptors` (mirrors the hooks fold). Own tier-2 registration stays dynamic (`this.middleware.snapshot()` per op); only the inherited layer is snapshotted. The trade is a static boundary (registration before a child's construction inherits; after does not) — and the fold FIXES a latent gap: per-session sub-harnesses now inherit app-level guards/middleware (the walk was functional on exactly one edge, App→Session; every sub-harness had dropped `parent`). **Precedence:** multi-guard is now **compose-order** (first non-`proceed` in composed order wins; guard-outermost sort, then scope, then registration), replacing the old order-independent `veto > replace > defer` priority-merge — a substrate hardcoded policy traded for a caller-controlled mechanism (capability-not-opinion). Fiber invariant unchanged (guards ride the same `liftMiddleware` seam). Docs swept: runtime/app/tool-executor READMEs + this entry. `LifecycleHandlerError` (spec) retained as a valid taxonomy entry but currently producer-less (a throwing guard decider propagates raw to `terminal:failed`). See `blueprint/83-one-interceptor-primitive.md`.

**2026-07-13 (later⁴) — HOOK CASCADE LIVE END-TO-END (`6b55b96e`, judged clean).** The dormant mechanism is now wired: `createApp({ hooks: { onBeforeToolDispatch } })` fires on a tool dispatch, and `createSession({ hooks })` composes on top (proven: `"x|app|session"`, app-outer). Public `AppHarnessOptions.hooks?: CommandHooks` folds to the app layer (`Hooks.from`); `createSessionBody` computes `sessionHooks = this.hooks.extend(Hooks.from(input.hooks))` ONCE and threads the resolved `Hooks` VALUE into the session + every per-session sub-harness (elicitation/tasks/resources/tool/knobs); the app-shared spine (loop/executor) gets `this.hooks`. **No parent pointer, no ordering knot** — the ADR-82 payoff realized. Each sub-harness got a mechanical `hooks`-forward-to-super (loop/knobs gained minimal options objects); middleware parent-walk untouched. `CreateSessionInput.hooks?` augmented FROM the app package (not spec) to avoid a spec→runtime cycle (ADR-27 declare-module). 4 tests (reshape/compose/after/behavior-preserving); full packages-next suite green (1 fail = predicates WIP); typecheck 145/145 turbo, zero error TS. **Reachability:** `tool:dispatch` PROVEN (only registry-augmented verb); knobs/tasks/resources/loop/executor value-wired but TYPE-dormant until each adds a one-line `declare module CommandRegistry` entry. **CAVEAT + `TODO(adr-80)` at the site:** `tool:dispatch` declares `output: ContentBlock[]` but the body returns the richer `DispatchResult` → `onAfterToolDispatch` is observe-safe / transform-UNSAFE (returning `ContentBlock[]` breaks `session.dispatch().content`); reconcile the declared output type to make after-transforms sound. **Deferred (unchanged):** slice 0 (session verbs through `runOperation` → unlocks `onBeforeSessionSend`); per-session hooks on shared-spine ops = tier-4 call-scoped; gateway→app hook threading; the factory-slot construction-context consolidation (subsumes hooks/parent/ns/principal threading — design note only).

**2026-07-13 (later³) — ADR 82 DRAFTED: the hook cascade is a construction-FOLD, not a parent-walk (revises ADR 80 §6/§7; narrows ADR 81 to middleware-only).** Design-session conclusion, reached by generalizing the tools config-cascade. The construction hierarchy (gateway→app→session→sub-harness) is a **scope chain**; a harness's effective hooks = every ancestor's layer merged with its own. Instead of walking `this.parent` per-op (ADR 80's `ownAndInheritedHooks` — needs parent pointers = ADR 81, + hits the construction-ordering knot), **fold the chain once at construction**: each scope computes `resolved = parentResolved.extend(ownHooks)` and threads the resolved immutable `Hooks` value into every harness it builds. Ops read local `this.hooks.forOp(name)`. The fold IS the walk, memoized per node — no parent pointers, no ordering knot (a value needs no live parent; computed once at the top of createSessionBody, threaded to the session AND its sub-harnesses). **`Hooks`** = immutable per-command layer holding LISTS (not a flat object — two layers setting the same `onBeforeX` would key-collide); **`extend` COMPOSES, not overrides** (hooks are middleware — both ancestor+descendant fire outer-first; the ONE divergence from tools' last-wins). `forOp` lifts through the SAME `liftMiddleware` path (ADR 80 §7 fiber invariant UNCHANGED); `deriveHookNames`/types/`asBefore`/`asAfter` all reused verbatim — only the collection method changes (walk→fold), cheap because dormant. **Cost:** static snapshot — mutating `app.hooks` after a session exists doesn't reach it (forfeits runtime-retroactive deployment policy, the ~10%; `session.hooks.append` still works via local overlay). **Rejected:** a general `ScopedConfig<T>` god-object (tools+hooks share a SHAPE — layer+merge folded down the chain — but the MERGE differs: compose vs override; per-type merge, not one object). **Net:** ADR 81's construction-parent invariant is no longer a hook prerequisite — it narrows to "if/when tier-3 `app.use` middleware needs the dynamic walk." **IMPLEMENTED + judged clean (`026323ca`):** the `Hooks` primitive (`from`/`extend`/`forOp`/`empty`), `extend` COMPOSES (verified onion order `["app:before","session:before","session:after","app:after"]`), `from`↔`forOp` can't diverge (shared `parseHookKey`), `forOp` lifts via `liftMiddleware` (fiber invariant carries over), `ownAndInheritedHooks` DELETED, middleware walk untouched. 18 tests; dormant-but-correct (`this.hooks` defaults `Hooks.empty` → `forOp` `[]` → byte-identical). **NEXT SLICE (to make it work end-to-end):** public `hooks:{}` option on `createApp`/`createSession` + fold-threading (app computes `resolved`, threads down to session + per-session sub-harnesses via the mechanical `hooks` forward — NOT the ADR-81 parent/factory work) + slice 0 (session verbs through `runOperation` so session-level ops are hookable). **tsc-figure correction (agent-flagged, applies to prior entries too):** the "145/145" cited throughout is TURBO's per-package task count, not a monolithic root `tsc` (which OOMs / surfaces pre-existing v1 `packages/`+`website/` errors); `packages-next` in isolation typechecks clean (87/87, zero `error TS`). See `blueprint/82-hooks-cascade-as-construction-fold.md`.

**2026-07-13 (later²) — ADR 80 PR #1 LANDED (`bcd18e7e`) + ADR 81 DRAFTED (construction-parent invariant).** The command-lifecycle hook cascade is IN base-harness: `runOperation` now composes `onBefore/After<Command>` hooks alongside middleware via `ownAndInheritedHooks` (mirrors `ownAndInheritedMiddleware`, returns `[]` when empty → byte-identical with no hooks). Hooks lift through the SAME `liftMiddleware` path as `.use` (§7 fiber invariant — verified: ambient ctx / span-nesting / interruption survive an awaiting hook; no bespoke hook-runner). Typed via derived mapped type: empty-seed `CommandRegistry` (id→{input,output}) → `onBefore<Pascal>`(input)/`onAfter<Pascal>`(output); type-level `Pascal` === runtime `deriveHookNames` (lockstep test). tool-executor contributes the first registry line. 16 new tests; existing suites unchanged; tsc 145/145. Judged clean against code (not just the agent report) before commit. **ADR 81 (uncommitted→committing): the construction parent must be a mandatory explicit invariant.** Audit found it's SYSTEMIC: loop/tool/knobs/resources call `super(...)` positionally and DROP `options.parent` (`parent-threaded refs: 0`); app passes `parent: this` at ONE site. So the cascade (ADR 76 middleware AND ADR 80 hooks) is silently half-wired — and `app.use()` tier-3 already doesn't reach the parentless spine harnesses (a live bug, pre-hooks). Decision: every harness is ROOT or CHILD, never orphan-by-omission; **parent = whoever owns your scope id** (appId→app, sessionId→session — dissolves the sibling/child ambiguity into a rule). Two-sided fix specced (child forwards options→super; parent passes `parent: this` at construction). NOT YET IMPLEMENTED — the parent-side carries the true-parent determination, deliberately not blind-edited across 8 constructors; the mechanical child-side forwarding + app/session activation is the next slice, ahead of ADR-80 slice 0. See `blueprint/81-construction-parent-invariant.md`.

**2026-07-13 (later) — ADR 80 DRAFTED: command lifecycle hooks (design session, uncommitted; born from the nx-knowify multimodal-input investigation).** A cross-layer audit of every core harness lifecycle (loop/executor/reconciler/model/tool-executor/session/app) established: v2 has THREE disjoint lifecycle vocabularies — `LifecycleStore`+`useOn*` (observer-only, handlers `=>void` discard returns `lifecycle-store.ts:173`, LOOP-fed not layer-owned so no standalone fire), `runOperation` phase envelopes (`base-harness.ts:814/823/877`, observer, standalone), and operation middleware (`.use`/`.fx.use`, the ONLY transform primitive) — plus dead spec (`ToolLifecycleEvent` 9 kinds never emitted `tool-executor.ts:374`; `useOnError` binding with no producer). Gaps proven: reconciler emits ZERO compile events (`renderTreeBody` never touches lifecycle), NO before/after-model transform seam (nothing between `loop-executor/harness.ts:412`↔`:416`), session `send`/`render`/`dispatch` BYPASS `runOperation` entirely (`session/harness.ts:552`, TODO `:1002` — a lifecycle vacuum). **ADR 80 decision:** lifecycle is INTRINSIC to `command()` — every `<who>:<what>` verb auto-gets two surfaces: **events** `<who>-<what>-<phase>` (kebab, observe, wire-projectable, from the phase envelopes) + **hooks** `onBefore<Who><What>`/`onAfter<Who><What>` (camel, in-band transform, ARE middleware entries). Naming = total function of the command id (`hook = on+Before|After+PascalCase(<who>:<what>)`) → forces `tool:dispatch`→`tool:execute` rename. Contract: `(value, ctx) => value|void` (return=transform, void=observe, throw=veto); `ctx`=RuntimeContext (the explicit-ctx-into-methods thread cashed in). Registration: declarative `hooks:{}` augmentable empty-seed `CommandHooks` interface (ADR-27 pattern, exposure-gated) at ANY scope (gateway⊃app⊃session⊃execution, cascades+composes onion via `ownAndInheritedMiddleware`/ADR 76) + imperative `.hooks.append/prepend/remove/off` + `.hooks.fx`. **Fiber invariant (§7):** hooks desugar to `.use`/`.fx.use` registrations → inherit ADR 76's `liftMiddleware` ambient-runtime continuation fix VERBATIM; a bespoke hook-runner side-path would reintroduce the fiber-sever bug — hard invariant. **`Hooks` is NOT a harness** (§8): state is unserializable functions (fails ADR 49 stores), must never cross the wire (policy/code), meta-regress (hooks-on-hooks) — it's a `BaseHarness` capability/facet. Worked examples: `onBeforeModelGenerate(input,ctx)=>reconcile(input,ctx.target)` (the reconciler-agnostic ground-floor media seam the whole investigation was chasing — lands as the plainest possible hook) + `onBeforeTimelineAppend` (ingestion IS timeline append; no separate ingest layer). **Slices:** 0 = route session verbs through `runOperation` (ADR 51 migration, PREREQ); 1 = the mechanism + 3 exposed commands (`model:generate`/`timeline:append`/`tool:execute`) — mergeable alone; 2 = per-harness `CommandHooks` augmentation accretes + wire-or-delete the dead spec. Ryan: "land this soon." NOT built — next is slice 0/1. See `blueprint/80-command-lifecycle-hooks.md`.

**2026-07-13 — Wire auth + naming hardening (4 commits, follows the channel arc).** (1) `knobs/set` now registers in every gateway automatically (`33f81f3d`) — `app-next` owns `builtinWireExtensions`, gateway registers them in the bundled tier (not framework-privileged); gateway stays harness-agnostic. Closes the slice-4 production gap. (2) **Declarative `WireExtension.auth` wired into the dispatch choke point** (`98ea511a`) — ADR 46 specced the slot but it was inert; now `authorizeDispatch` reads it, reconciling ADR 46 with ADR 51 §3.3: `required:false` → open (policy skipped, structural `requiredScopes` ceiling still un-waivable), `scope` → **additive** role (verb-scope AND role, never a relabel — a role can only tighten, so no anti-bypass hole). 6 tests. Also replaced the conditional-spread `...(x!==undefined?{}:{})` in dispatch with `omitUndefined`. **Correction:** my earlier "knobs/set is ungated" flag was WRONG — I'd grepped `gateway/src` and missed the choke point in `transport/src/server/dispatch.ts` (`authorizeDispatch` gates EVERY resolved method: session ceiling → verb-scope → additive role, deny-by-default). (3) Auth guide + examples in the gateway README (`1dbc1483`) — end-to-end flow (AuthSource ingress → single dispatch gate), `staticTokenAuthSource`/`staticAuthorizer`/`claimsAuthorizer`, per-method `auth`, the ceiling. (4) **Wire-naming convention RATIFIED + swept** (`b4eca4bb`) — **snake_case method/notification names, camelCase payload fields** (spec/wire/README.md). Rationale: routing tokens are opaque strings (language-neutral, matches MCP); param fields become identifiers in the serde-less TS stack (keep camelCase). Renamed `app/createSession`→`app/create_session`, `gateway/listApps`→`gateway/list_apps`, `session/respondToElicitation`→`session/respond_to_elicitation`, MCP kebab `mcp/list-tools`→`mcp/list_tools` etc. — 33 files, tsc 145/145, full suite 3573 pass. **KNOWN FOLLOW-UP:** the client-extensions `retry/` module (WIP `predicates.ts`, untouched per constraint) keys on old `app/runOnce` via plain strings — left the whole `retry/` module at the old name (consistent, tests pass); update `retry/*` + `predicates.ts` → `app/run_once` when the retry WIP lands.

**2026-07-12 (later⁴) — Client channel-consumer arc: slices 1–4 LANDED (design B).** The CQRS loop for knobs is built end to end. Commits: `a2db953a` channelView is a pure fold (in-band snapshot, design B — supersedes design-A `e014e0f7`); `c19d27e9` slice 2 (channel subscriptions open with a snapshot — `ChannelSnapshotProvider` conformance + `session.channelSnapshot` bridge-scan + knobs provider + gateway `sub/subscribe` prepend, subscribe-first ordering); `c8da4e2c` slice 3 (`knobsStateView` read façade — the `@agentick/knobs-next/client` subpath, applyJsonPatch fold); `1478d60a` slice 4 (`knobsHandle` read+write — the `knobs/set` wire handler that was ratified-but-unimplemented + the client resource handle whose `set` is fire-and-observe, re-folding via the channel not a hand-patch). ~15 new tests; the CQRS round-trip (set → view UNCHANGED → channel delta re-folds) is pinned. Slice 2 + slice 4 were delegated to agents with precise specs and judged (bridge-scan finds the real KnobsHarness not a handle; key→id mapping matches KnobsHandle.set; ordering guarantee; round-trip proves no hand-patch). **KNOWN PRODUCTION GAP (loud TODO in `knobs/extension.ts`):** `knobsWireExtension` is built + tested but NOT registered in a live gateway — blocked on ADR 26 Step 8 (`withKnobs()` isn't consumed; the `ExtensionBundle.wire` path is unused in production). So `knobs/set` is verified in tests but not yet reachable end-to-end until that registration lands. **REMAINING (clean follow-ups):** slice-1b reconnect re-seed (composes with the `offline`/`retry` client-extensions — not bespoke); `collectionView` keyed sugar (build with tasks as the first real keyed conformer — tasks needs a `ChannelSnapshotProvider` + a snapshot-frame shape, a slice-2-shaped server change); `client.session(id).knobs` sugar (a client-extension or metapackage attaches the free-function `knobsHandle` as a `.knobs` property — the generic client-next can't, dependency direction). Prior design-finalization note (design A→B pivot, CQRS model, CollectionView abstraction, ergonomic ladder) below.

**2026-07-12 (later³) — Client channel-consumer arc: slice 1 LANDED (`e014e0f7`), then DESIGN PIVOTED to a simpler model in review. Read this before building more.** The generic client-side reduced-channel primitive `channelView` + `channelEventQuery` shipped (client-next + spec, 9 tests). **BUT the design has since been superseded in review — slice 1 as committed is "design A" and must be revised.** The arc, as finalized with Ryan:

- **The pattern is CQRS with an event-driven read model.** Reads flow server→client as reactive **channels** (queries, eventually-consistent, subscribe+fold). Writes flow client→server as discrete **req-res commands** (authoritative). The client holds a *replica* of the read view updated by the channel; a write's effect returns *through the channel* (a delta), not the response — so one client's write, another client's, and the MODEL's write all update every view uniformly. Server harness = source of truth; the channel = a derived stream; the client view = a folded replica. Prior art is exact: **Kubernetes list-watch (Reflector/Informer)**, CQRS + event-sourced read models, AG-UI snapshot/delta (ADR 73). Frontier deliberately NOT adopted (over-engineering for one-directional small-collection projections): CRDT/local-first (Yjs/Automerge/ElectricSQL/Zero), query-based IVM.

- **DESIGN A (committed slice 1) → DESIGN B (agreed, to build).** A = pull baseline (`channel/snapshot` RPC) + push deltas (`sub/subscribe`), tied by a **cursor**. B = **in-band snapshot / K8s `sendInitialEvents` watch-list**: the subscription OPENS with a snapshot frame, then streams deltas on the SAME ordered stream. B is strictly simpler for our (small) channels — it deletes `baseline()`, `ChannelBaseline`, the cursor tie, the separate pull RPC, the head-cursor accessor, AND the snapshot↔stream race (the snapshot is frame-one, before any delta — ordering guaranteed by construction; reconnect re-seed is free). `channelView` collapses to a **pure fold over a channel subscription**: `channelView(client, scope, channel, { initial, reduce })` — no baseline, no cursor; `reduce(state, frame)` handles snapshot-kind (seed) vs delta-kind (fold), the primitive stays dumb. A's pull+cursor become documented ESCAPE HATCHES for the two cases B gives up (one-shot read without subscribing; mid-stream resume of a LARGE collection) — neither is our case; K8s kept both for the same reason.

- **The abstraction (named): `CollectionView<Id,T>`** = the client-side Informer/materialized-view of a server-owned collection — `get(id) / list() / has(id) / subscribe() / close()`. Sugar over `channelView` (state is `Map<Id,T>`). Conformers (≥5, well past the 3-consumer bar): tasks, resources (`ResourcesHarness` — literally a keyed resource collection), elicitations, mcp-client status, knobs. Named `CollectionView` NOT `Resource` (collision with MCP `Resource`/`ResourcesHarness`).

- **The full resource handle = read projection + write commands** (Apollo/RTK-Query shape): `session.tasks()` → `.get/.list/.subscribe` (channel-backed reactive read) + `.cancel(id)` etc. (req-res mutation). Writes land two ways, same sugar/escape-hatch ladder: typed **wire-extension methods** (`defineWireExtension` → `knobs/set`), or **`session/dispatch`** by name (app-defined `audience:"user"` tools). `channel.request`/`onRequest` is substrate-local, NOT wired — a client write cannot ride it. **`session/send` is a command too but NOT an entity mutation — don't over-fit send/abort into the resource CRUD shape.**

- **Ergonomic ladder (low cognitive overhead): façades arg-free (`taskStatusView(client, sessionId)`, rung 1) → `collectionView`/`channelView` primitive (rung 2) → raw `transport.subscribe`/`request` (rung 3). No cliff — each rung returns the one below.** Future `client-react` `useChannel(view)` is a one-liner over the `get/subscribe` contract.

- **Open per-channel question:** does `knobs` even need JSON-Patch deltas, or is full-record-push (`reduce = replace`) simpler given how small knob state is? The SAME `channelView` fold covers both — delta-vs-full is a producer choice the primitive is agnostic to. Revisit when building `knobsStateView` (AG-UI wire parity is the only counter-reason).

- **NEXT BUILD (in order):** (1) revise `channelView` to the pure fold — DELETE `baseline`/`ChannelBaseline`/cursor from `client/src/channel-view.ts` (supersedes `e014e0f7`); (2) slice 2 = "a channel subscription opens with a snapshot" — the server-side snapshot-**provider seam** on `SessionHarness` (`channelSnapshot(channel)` registry; knobs/tasks register) that PREPENDS the snapshot frame to the live `sub/subscribe` stream (NOT a separate `channel/snapshot` pull RPC); (3) `collectionView` + first resource handle (`taskStatusView`) proving read+write round-trip. See the published design artifact (client↔server layout) from this session.

**2026-07-12 (later²) — ADR 76 gap #2 CLOSED: async middleware wraps are fully in-fiber (ambient-runtime fork). Corrects two prior claims.** Ryan flagged that "applying any non-Effect middleware effectively breaks the fiber connection" — and was RIGHT that it was a real break, but it turned out to be a BUG in `liftMiddleware`, not an inherent limit. **Root cause:** the lift forked the continuation with `Effect.runFork`, which seeds a bare root on the DEFAULT runtime — no tracer, empty FiberRefs, no parent span. So a span opened in the wrapped ops detached (in fact wasn't even collected — the tracer lives in the runtime), and the tier-4 `CallMiddlewareRef` reset to `[]`. **Fix (`liftMiddleware`):** capture `Effect.runtime()` in-fiber (the ambient Runtime = Context + FiberRefs + tracer) and fork the continuation on THAT via `Runtime.runFork(runtime)`. Now everything `next` wraps keeps full in-fiber semantics across the `await`: **OTel span-nesting, `RuntimeContext`/`parentOpId`, tier-4 `withCallMiddleware`, and interruption** all survive. The ONLY residual is the middleware's OWN JS body (statements around `await next`, microtask-driven — inherent, can't be fiber-interrupted mid-statement, hence explicit `ctx`). **This CORRECTS:** (a) the `f387b455` claim "does NOT restore span-nesting (child still a root span)" — FALSE, span-nesting survives once you fork on the ambient runtime; (b) the "definitive lazy-next" framing that a coroutine trampoline was needed for continuation span-nesting — it wasn't; the trampoline is only relevant to making the mw's OWN BODY in-fiber (still impossible, still pointless). **Per Ryan's "everything you uncover becomes a test case":** 6 new `base-harness.spec` tests under "async middleware fiber propagation" pin each property — span nests through the async mw; the continuation body still reads `getContext`; a tier-4 `withCallMiddleware` wraps a NESTED op reached through the async mw (wraps===2 proves the FiberRef crossed); body rejection surfaces on the outer E channel; an async-mw throw surfaces; `next` callable >once (retry). Plus the earlier ctx-third-arg, short-circuit, and interrupt-tears-down tests. Gate: workspace tsc 145/145, base-harness 26/26, oxfmt+oxlint clean. Caveat text corrected everywhere (README, `AsyncMiddleware` JSDoc, ADR 76). **Net: `use` and `fx.use` differ ONLY in whether the middleware's own body runs in-fiber — the wrapped work is identical.** Un-committed as of this note; commit next.

**2026-07-12 (later) — ADR 76 middleware: the `use` / `fx.use` two-surface split + explicit `ctx` (`c2d21187` + doc pass).** Middleware now registers through the SAME facade/twin split as every operation: `harness.use(mw)` takes a pure-JS `AsyncMiddleware` `(input, next, ctx: RuntimeContext) => Promise<R>`; `harness.fx.use(mw)` takes the Effect-native `Middleware` `(input, next) => Effect<R,E>`. **Why split, not overload:** a single `use(Middleware | AsyncMiddleware)` union (and the earlier `async`-auto-detect path) killed inline-arrow param inference for BOTH forms — the async and Effect `next` contracts are structurally incompatible. Splitting across the two surfaces makes EACH a single type → inline arrows infer cleanly. `Middleware` + `HarnessFx` moved to `@agentick/spec-next` (so every `XFx` protocol can type `fx.use`); `AsyncMiddleware` lives in `@agentick/runtime-next` (it carries `RuntimeContext`, a runtime concern). **The `ctx` third arg:** an async middleware runs OUTSIDE the fiber (`await next` = detached `runPromise` root — the honest sever), so it can't read `getContext` itself; `liftMiddleware` captures the ctx snapshot at the op boundary and hands it in. Backed by a new base-harness test proving `use(async (i,next,ctx)=>…)` receives the op's `{sessionId, executionId, opId}` + a short-circuit test (mw returns without calling `next` → body skipped). Doc pass: runtime README (canonical — two-surfaces section + a "which surface" use-case catalog: observe→`use`, control-the-fiber→`fx.use`), ADR 76 §Implementation, app README (`app.use` = tier-3 deployment-global), session README (`session.use` = tier-2, per-send = tier-4). **DEFINITIVE "can `next` be lazy + in-fiber?" analysis (Ryan pushed to exhaust it):** YES for the CONTINUATION — a coroutine trampoline (Queue+Deferred pump loop running `yield* nextEffect` in the outer fiber) makes the wrapped ops in-fiber (spans nest, interruptible). But it's architecturally POINTLESS: (1) the middleware's OWN body (`A` before `next`, `B` after) is plain JS on the microtask queue — never in-fiber, because a JS async fn's suspension points aren't externally steppable; (2) interruption keeps an irreducible seam (orphaned async fn whose `await next` never settles; microtask `B` uncancelable); (3) it's the exact re-entrant dual-form hazard the ADR 77 spike condemned. **QED:** the ONLY way to get the middleware body in-fiber is to make it a generator the fiber drives — i.e. an Effect — i.e. `fx.use`. No fourth construct exists. The split is the honest, minimal statement of a real two-scheduler boundary, not a limitation. **Follow-up LANDED (same session):** the `runFork` + interrupt-on-signal upgrade. `liftMiddleware` now forks each continuation (`Effect.runFork`, holding the fiber handle) instead of `Effect.runPromise`, and interrupts it on the `Effect.tryPromise` abort signal (which fires when the outer op is interrupted). So aborting a `send` tears down the in-flight inner model/tool call an async middleware wraps — instead of leaving it running as a detached root (the leak). It does NOT restore span-nesting (child still a root span) or make the mw body in-fiber; only interruption is re-threaded. Backed by a base-harness test: interrupt a live op whose forked continuation hangs on `Effect.never` → its `onInterrupt` finalizer fires. Caveat text corrected everywhere (was "interruption does NOT cross" — now "span-nesting severs, interruption + ctx are re-threaded"): runtime README + `AsyncMiddleware` JSDoc + ADR 76. Gate: workspace tsc 145/145, base-harness 20/20 + full packages-next suite 3539 green, oxfmt+oxlint clean.

**2026-07-12 — ADR 77 spine-compose: Stage 1 + Stage 2 BUILT (the `.fx` dual-typed edge + the protocol-`fx` hoist). Stage 3 (the `Effect.gen` loop rewrite) is NEXT.** See `docs/proposals/v2/SPINE-COMPOSE-PLAN.md` (the gated tracker — authoritative). Summary of this session's 20 commits (`611a0262`→`724788bb`):

- **A/B fork RESOLVED → A-on-the-spine (ADR 79).** Session spine (session→loop→executor→tool→reconciler) = ONE co-located Effect entity; distribution is coarse at bus/inbox (cluster wraps the substrate, ADR 38, uses direct refs — orthogonal to composing the spine). Telemetry folded in: within-entity = free nested traces (one tracer runtime at the composed root); across = W3C `traceparent`.
- **The runtime already existed** — `commandEffect` (intra-harness) + `runOperation` (builds the Effect then immediately `runHarnessProtocol`s it). `.fx` is EXPOSURE of Effects already built, not invention. Big de-risk.
- **`.fx` = the dual-typed edge.** Effect canonical, Promise DERIVED via `PromiseView<T>` (spec, homomorphic mapped type — preserves JSDoc, mutation-verified guard in `promise-view.spec`; the ONE-WAY erasure means there is no `EffectView` inverse). Facade = `runPromise` at the entity edge; `.fx` = the un-run twin for in-fiber composition.
- **Streaming edge = the DUAL of the Promise edge** (singular concept): `AsyncStream<Item,Result>` (facade type, dual of `Promise<A>`) + `runHarnessStream` (runtime bridge, sibling of `runHarnessProtocol` — ALL the Queue/fork/iterator machinery lives here once). Canonical form = **sink-fold** `(input, sink) => Effect<Result>`. Executor's `executeStream` facade rewritten over it (~120 lines → the bridge; 8 backpressure/cancel tests unchanged). Finding: the Effect side is SIMPLER than the facade.
- **`.fx` mechanism decision tree (settled):** bare command passthrough → `fxProxy` sugar (knobs); command + facade logic (door→origin) → hand-author over `commandEffect` (tool-executor); not-a-command (inline Operation) → hand-author over `runOperation` (executor/loop/reconciler); non-Promise facade (streaming) → hand-author + edge bridge. All behind a uniform `get fx(): XFx`.
- **Twins landed:** knobs (S1 reference), executor `run`+`executeStream`, loop `runExecution`, tool-executor `dispatch` (×2 impls), reconciler `renderTree` (×2 impls).
- **`readonly fx` HOISTED onto the four spine protocols (`c27f4235`)** — THE Stage 2→3 bridge. The loop holds protocol-typed dep refs, so composing `yield* input.executor.fx.run(...)` needs `fx` on the PROTOCOL. Every impl + double now provides it (notably `FakeLanguageModelExecutor` gained `fx.run`+`fx.executeStream`; recording stubs record on the fx path too). **"internal calls go through .fx" now typechecks.**
- **Gate 0 characterization CLOSED** — `loop-executor/__tests__/characterization.spec.ts` (28 tests + `makeLoop` differential seam + `assertLoopInvariants`). This is the net the Stage 3 loop rewrite lands behind.
- **STILL PROMISE-CHAINED (the whole point of Stage 3):** the loop's `runExecutionAsync` (`loop-executor/harness.ts`) still `await`s each dep's facade — ~40 runPromise roots, no nested telemetry/cancellation yet. **Stage 3 = rewrite it to `Effect.gen`, `await dep.method()` → `yield* dep.fx.method()`, behind the char diff.** Model HTTP call stays `Effect.tryPromise(adapter.execute)`, tool handler stays `Effect.tryPromise(handler)` (legit external-I/O boundaries, in-fiber not roots). Remaining twins before/with it: `StateApplicator` + session.
- Gate throughout: workspace tsc **145/145**, ~1146 spine tests green, oxfmt+oxlint clean.

**2026-07-10 — Change-event primitive BUILT + ADR 75 rescoped + ADR 76 drafted (design session, uncommitted).** Delivered honest pushback on the ADR 75 design; Ryan agreed and asked to scale it to "the most elegant and foundational." Result: **(1) ADR 75 rescoped** to two foundational bricks — the change-event primitive + the `kind:"event"` archetype — with projection/normalization as lean *consequences* and the **wake seam CUT** (a run is an adopter `send()`, callable from an `onChange` handler; a framework wake policy would be shipping a throttling *opinion* — capability-not-opinion forbids it). Also applied: `ChangeEvent` **de-CRUD'd** (`{key, value?, prev?}`, no verb — the harness names the transition via `eventKind`); the **injection requirement** named (tag-envelope formatters MUST neutralize `<event>` syntax in genuine user content or user input can forge system events); the **no-double-count test** (a kind fully recoverable from a live current-state render does NOT project); "four routings" deflated to three honest consumers. **(2) First brick BUILT** — `createChangeNotifier<V, K>` in `@agentick/pubsub-next` (`change-notifier.ts`): the **notify** seam (`onChange`/`emitChange`/`changeKind`), a **sibling** to `KeyedNotifier` (NOT a bolt-on — bolting a value+prev stream onto the keyed notifier would force a 3rd type param and muddy its void-vs-value ping overload). Stateless pipe, read-only fire-and-forget observers (sync + error-isolated — an observer cannot affect the emitting op), producer supplies `prev` at the mutation site. 12 tests, README updated (Verified-by). **(3) ADR 76 drafted** — operation middleware scoping: per-call / per-instance (`harness.use()`, exists) / **structural inheritance** (compose construction-ancestors' chains root-outermost — the "global middleware" answer; register at app/session → wraps every descendant op) / call-scoped tier-4 DEFERRED (use Effect `Context.Reference`+`provide`, don't hand-roll fiber propagation). `onChange` here is the *notify* twin of ADR 76's *intercept* (middleware) seam. Draft base-harness edits landed (`DRAFT(ADR 76)`: `composeMiddleware`, `MiddlewareChain.snapshot`, `ownAndInheritedMiddleware`, `runOperation` compose site) — strictly additive, behavior-preserving (187 runtime tests green). **`@effect/rpc` at the wire: REJECTED** — v2 wire is deliberately JSON-RPC 2.0 for MCP envelope-parity; `@effect/rpc` optimizes Effect-to-Effect ergonomics (opposite of an interop wire); steal its patterns, not the library (record as rejected-alt in ADR 33 — PENDING). Gate: workspace tsc **145/145**, pubsub 58/58 + runtime 187/187, oxfmt+oxlint clean. Supersedes the 2026-07-09 ADR 75 entry below (wake + `KeyedNotifier.onChange` framing now obsolete).

**LANDED (5 commits):** `bb59b0bd` feat(pubsub-next) createChangeNotifier · `ed631113` docs(v2) ADR 75 rescope + ADR 76 + `DRAFT(ADR 76)` base-harness scaffold · `2c29646d` docs(adr-33) reject @effect/rpc at the wire (Ryan: "scrap the effect/rpc idea" — Effect is the engine, not the interface) · `a6811983` **refactor(knobs-next): first retrofit — StateDelta now projects over the `onChange` notify seam** (applySet/applyRegister emit a `ChangeEvent`; the JSON-Patch channel is ONE subscriber via `changeKind`; mutation logic ignorant of the projection; existing state-channel spec passes UNCHANGED = behavior-preserving; +5 change-stream tests incl. multiple-projections-on-one-stream; `harness.onChange` exposed class-only, `TODO(notify-seam)` to promote to protocol when a cross-package projection needs it). **STILL PENDING:** promote the base-harness ADR 76 scaffold out of draft (needs the ancestor-wraps-descendant proving test + handler-inheritance follow-up, ADR 76 Q2) — awaiting Ryan's ADR 76 read; next retrofit candidates = `state`/`gates` onto `onChange`, then the timeline `event` archetype (the second projection that makes the decoupling pay off).

**2026-07-10 (later) — ADR 77 DRAFT: the operation spine (fiber-through-the-process) + dual-typed edges.** Telemetry investigation ("do we emit OTel spans / can users set up a provider?") surfaced a ROOT-CAUSE architectural finding, discussed with Ryan and pinned in ADR 77. **Finding (verified):** the Effect fiber tree is BROKEN at every harness boundary — `runHarnessProtocol` is a bare `Effect.runPromiseExit` and each harness runs its own root; the loop even drops out of Effect entirely (`Effect.tryPromise(() => this.runExecutionAsync(...))`, plain async orchestration, `loop-executor/harness.ts:149`). So the "operation tree" is ~40 independent runPromise roots joined by `await`. This is the ONE root cause of: (a) telemetry can't propagate (every op emits `Effect.withSpan` at `base-harness.ts:687` but against the no-op tracer — spans emitted, never exported; `AppOptions.telemetry` Layer slot exists but is a placeholder that doesn't reach command execution, and no `@effect/opentelemetry` dep is installed); (b) `parentOpId` is hand-threaded (FiberRef can't cross roots); (c) ADR 76 tier-4 FiberRef middleware can't work. **Telemetry is a symptom.** **Decision (ADR 77):** internal ops carry one Effect fiber through a process (harness→harness calls compose via `yield*`; `runPromise` only at true edges); location-transparent boundary (local=compose, remote=`inbox.ask` — fiber breaks exactly at node edges, stitched by W3C `traceparent`); **dual-typed edges** (native-JS primary + Effect twin). Then telemetry/parentOpId/interruption/middleware-context all FALL OUT. **Rejected:** ALS (masks the debt — fails "meaningfully better than Effect"; Ryan: hard-no unless targeted+better, which it isn't here) and the ~80-edit runtime-threading (throwaway once the tree is mended). **SPIKE (run + verified, file discarded — it crashes the vitest worker):** a single object that IS an Effect + thenable **hard-crashes `runPromise`** (Promise-resolution adopts thenables → infinite re-entry → stack overflow, reproduced); Promise-eager+`.effect` **double-executes** side-effecting ops; the **lazy wrapper** (NOT an Effect, `isEffect===false`; thenable runs on `await`; carries the lazy Effect as `.effect`) gives **single execution per consumer, no crash** (v1 `ProcedurePromise` lineage) — this is the chosen dual form (contract: Effect users compose `.effect`, don't `await`). **Staged plan:** S1 mend the spine (session→loop→executor→tool, loop `Effect.gen` rewrite is the crux — characterization tests FIRST), S2 tracer at edge → telemetry lands + delete manual parentOpId on spine, S3 cluster remote-proxy (deferred, less-likely path), S4 leaves later. **Safeguards for "don't break things" (Ryan required high confidence):** dual-path coexistence (every commit works), characterization tests before the loop rewrite, spine-first incremental behind green gate, edge contract frozen (public stays native-JS → nothing external breaks), interruption+error-channel explicitly tested. Confidence: design HIGH; migration HIGH *with* safeguards. NOT built — ADR pinned; next is S1 characterization tests + the loop rewrite behind dual-path.

**2026-07-10 (later) — `state`/`gates` onChange retrofit landed (`3c90de4e`).** `StateHarness` gets the ADR 75 notify seam parallel to knobs (`applySet`/`applyDelete` emit `ChangeEvent`; `onChange` class-only). State exercises what knobs can't: the `remove` path (`delete`) and `unknown` values that may be `undefined` — so add-vs-update rides an `existed` (`has`) check, not `prev !== undefined`. The `state-deltas` TODO now points at "subscribe `onChange`" (mirroring knobs' `projectStateDelta`) with the undefined-value codec caveat. **Gates deliberately gets NO `ChangeNotifier`** — a gate value IS a knob value, so engage/clear already flows through `knobs.emitChange`; a gates-owned stream would double-emit (documented at `GatesController`; projections filter `knobs.onChange` for gate-backing keys). +4 state tests; gates 31/31 unchanged; workspace tsc 145/145. Two harnesses (knobs, state) now on the notify seam; the `event`-archetype migration (below) is the remaining ADR 75 work.

**2026-07-10 (later) — ADR 75 Decision 2 (event archetype) REWRITTEN after survey; a prior claim was wrong.** Before implementing the `event` archetype I surveyed the blast radius and the ADR's premise did NOT hold: (a) `role:"event"` is **NOT vestigial** — it appears in **two** role unions (`MessageRole` rendered-tree + `SessionMessageRole` persisted), the latter documenting it as a deliberate (crude) mechanism for "state events that flow through the timeline without participating in model context," paired with `MessageTimelineEntry.visibility`; it has reconciler-react `content-blocks.spec.tsx` usages and is already flagged as deferred debt in the timeline README. My earlier "verified vestigial" claim (line below + the superseded 2026-07-09 entry) was WRONG. (b) The ADR conflated **two entry models**: the rendered-tree `ContextEntry = MessageEntry | SectionEntry` (`entries.ts`, `kind ∈ {message,section}`) vs the persisted `TimelineEntry = MessageTimelineEntry | TurnBoundaryEntry` (`session-harness.ts`, `kind ∈ {message,boundary}`) — the archetype belongs in the PERSISTED union, which already has a non-message kind (ADR 53 turn boundary = precedent). **Corrected model:** `event` = a persisted `TimelineEntry` kind (`EventTimelineEntry {kind:"event"; event:{...}; ts; visibility?; tags?}`, nested-domain convention) that **renders to a `MessageEntry`** at compile (role `user` + `<event>` envelope, Decision 4) — NO parallel entry in `entries.ts`; `renderedWith` stored on the event keeps re-projection deterministic (ADR 49). Retiring `role:"event"` is a **migration** (both role unions + reconciler tests + README + fold/render wiring mirroring turn-boundary), not a clean deletion. **No code edited on the wrong premise** — ADR 75 (Decision 2, TL;DR, Problem gap 2, Rejected, References) corrected; implementation scoped off the corrected spec, pending go.

**2026-07-09 (later) — ADR 75 DRAFT: system events + timeline projection.** Pins the design reached with Ryan: (1) a **change-event primitive** (`onChange` typed push variant on `KeyedNotifier`) — the substrate all reactivity routings compose over; (2) the **`kind:"event"` timeline archetype** (sibling to `message`, NO role — removes the stray `"event"` from `MessageRole`, a category error, verified vestigial [CORRECTED 2026-07-10: NOT vestigial — two role unions carry it + a deliberate `SessionMessageRole` mechanism + reconciler tests; see 2026-07-10 (later) entry]); (3) **opt-in timeline projection** of harness ops (per-`eventKind` policy; generous default — discrete outcomes ON, state churn OFF/coalesced — reconciled with ADR 49's ES-bloat prohibition); (4) **normalization** = a `user`-role message in an `<event kind source at>` XML envelope (the ONLY mid-conversation-interspersable role across Anthropic/OpenAI/Google; `developer` non-portable), riding the existing `renderedWith: FormatterRef` seam; (5) a **gated wake seam** (some events enqueue a run, distinct from resume, never automatic). Governing principle recorded: **capability, not opinion** — framework ships mechanism + overridable defaults, owns the default formatter not the format. The change-event unifies four routings: StateDelta (built), AG-UI steps (specced), timeline `<event>` (this ADR), wake (this ADR). NOT built — design pinned for review; first brick is the `KeyedNotifier.onChange` primitive.

**2026-07-09 — StateDelta emission: knobs-state JSON-Patch channel (ADR 73 adoption)** (`649bc919`). Adopt AG-UI's snapshot+delta state-sync natively. `applyJsonPatch` (RFC 6902 subset add/replace/remove/test, **copy-on-write** — untouched subtrees shared by reference, so reactive consumers diff by reference) + `JsonPatchOp`/`JsonPatchError` land in `@agentick/utils-next` (18 tests). `KnobsHarness` fans a `knobs-state` channel (`session:channel:knobs-state`, mirrors task-status): a `snapshot` frame on `importSnapshot`, a per-id `add`/`replace` `delta` on `set`/defaulted-`register` (**no document diff needed — the harness notifies per-id, so a changed knob IS one op**), monotonic gap-detect `version`, plus `stateSnapshotFrame()` for late-join re-seed (7 tests incl. the money test: snapshot seed + applied deltas reconstruct `exportSnapshot()`). **Scope call**: client-apply DEFERRED — no client consumes any `session:channel:*` yet (task-status doesn't either); a generic per-channel client state-model is cross-cutting, not knobs-bespoke → `TODO(state-deltas)` trailheads at `state`/`gates` harnesses (gates already project their bool through knobs via write-through). The AG-UI `StateDelta` projection now falls out as a codec over this channel. Judged by me: full suite 8093 passed / 0 fail, workspace tsc 145/145, oxfmt+oxlint clean. **Next: step labels** (bundled `step()` tool + loop-executor step-span → `step_start`/`step_end`, projects to AG-UI StepStarted/StepFinished — independent follow-on).

**2026-07-08 — MCP/resources wave brought home: ADR 63 built + ADR 64 signals + ADR 65 roots + resource front-ends (all judged by me — fresh uncached per-pkg tsc across touched + consumers, real round-trips, adversarial + mutation checks, oxlint/oxfmt clean).**

- **ADR 63 compiler-surfacing BUILT — b-core** (`125fdfb0` + tests/README `bfeb09a2`/`4ea761b7`/`36bc3523`). `collect` gains a content-append stream + a `<project projectionKey>` override fragment (compiler-general, reconciler-next); a lazy `DefaultProjection` registry (tools advertisement + a `timeline` fold that structurally duck-types `HookBridges.timeline` — no reconciler-react→timeline dep, ADR 27); `RenderedTree.provenance` (`default:`/`authored:`, 1:1 with entries). Default-on + lazy override proven incl. **empty-override-still-suppresses** (keys on presence, not count); retired the `timeline-not-rendered` diagnostic (spec 10→9). Preserves ADR-49 "IR = only what the compiler rendered."
- **ADR 64 log/progress signal family** (`9b45d810`) + **adversarial hardening** (`b801af36`). One emit → one discrete bus event → projections subscribe (emit once, receive everywhere). `ctx.log`/`ctx.progress` are always-present universal `ToolHandlerCtx` slots; `BaseHarness.emitLog`/`emitProgress` are structurally bus-only (never journaled, subscriber-probed). Wave 3a's MCP direct-sink reworked into `installLogProjection`/`installProgressProjection` bus subscribers (wire behavior + level filter preserved — 19 parity tests). Hardening closed progress end-to-end (MCP `_meta.progressToken` → `ctx.mcp.progressToken`; gateway `session/send` bridges progress signals scoped to the executionId → the wire ProgressReporter) and added the adversarial trio: **cross-connection isolation (mutation-checked — I independently stripped the connectionScope filter and confirmed the tenant leak)**, fire-and-forget under `append`-death, below-level-still-on-bus. No ambient global `Context.log` (Promise-bridge FiberRef hazard — `TODO(#19-ambient)`); `useLog` deferred to a future `client-react-next` (`TODO(#19-react)`).
- **ADR 65 roots-as-projection** (`b92e2275`) + seam, **both directions** (`4c8b6f95`). Decision recorded LOUDLY: roots is composed, NOT a harness — mount state already lives in the sandbox (`add-mount`/`remove-mount` declared commands); resources owns reads; roots is the projection (ADR 63). Source is pluggable (static list | fn | sandbox | fs) — **no sandbox required** (pinned by test). Reversible via the `McpRootsSource` provider-fn seam; regret asymmetry favors composing; concrete revisit-trigger + upgrade path documented. Build: `sandboxRootsSource` + `bindSandboxRootsToClient` (live `notifyRootsListChanged` on mount change, via new `SandboxHarness.subscribeMounts`) + `sandboxFileResolver`/`fsFileResolver` + inbound `ctx.mcp.clientRoots` (server pulls `roots/list`, re-pulls on `list_changed`, **structural per-connection isolation** — differential test). Packaged as the opt-in `@agentick/sandbox-next/mcp` subpath (deps mcp+resources; acyclic).
- **Resource front-ends + surfacing + server-info** (`668afdcf`). `ctx.resource` (Resources protocol on `ToolHandlerCtx`); `<Resource>` + `useResourceBridge` in `@agentick/resources-next/react` (mirrors `<Tool>` — register-on-mount, renders null, catalog via the ADR-63 default projection); `withResources` model tools (`resource_list`/`resource_read`). **`ResourcesHarness` is now an always-constructed per-session substrate primitive built at the AppHarness SINGLE construction site (#159)** — the SAME instance on `ctx.resource` + `bridges.resources` + `session.resources` + `installer.resources` (reference-equality pinned by test; the stale extension-constructs-it TODO closed). `withMCP` proxy-registers a remote server's resources into the one session harness under `mcp://<alias>/…` (re-surfaced on `list_changed`, torn down on close). `mcpServerInfo` default projection. **Alias trust-safety**: surfaced resources + server-info key on the trusted adopter `serverId`, NEVER the server's self-reported name — adversarial differential test proves a spoofed colliding name can't shadow another's namespace.
- **Skills `skill://` direction recorded** (`67c6dfc1`, no code). Bundled skill assets → a `skill://<name>/<path>` resource namespace (lazy resolvers into the session ResourcesHarness — the same aliased-resolver pattern as `file://`/`mcp://<alias>/`; progressive disclosure = lazy reads; instructions stay push). Multi-source folders already work (multiple loaders); layered-precedence direction (user>project>bundled) + its coupling to the asset-URI shape noted. **Design stance: markdown/file is the primary authoring form (portability is the format's point); JSX `<Skill>` authoring considered and DEFERRED** — power-path into the same registry only, never the default (a reactive block that doesn't need the catalog is just a `<Section>`).
- **The through-line:** resources is emerging as the universal *scoped-namespace content substrate* — `file://` (sandbox), `mcp://<alias>/` (remote servers), future `skill://<name>/` — same aliased-resolver mechanism each time, composed onto the one registry, never a new subsystem.
- **Remaining releaseable-bar items:** #22 (cohesive MCP+resources user-facing docs pass — next), #17 (mime-type-aware media capabilities + throw-on-unsupported-modality).

**2026-07-07 (gates) — Verified gates + read-only knobs (parity+ with v1 work of same date).**

Ported the new gate species from `packages/` (v1, uncommitted on this branch — ships separately with its own changeset) and brought `packages-next` to parity plus the arming extension:

- **`@agentick/spec-next`**: `KnobRegistration.readOnly` — model-visible, not model-settable.
- **`@agentick/knobs-next`**: `dispatch()` (set_knob pipeline) rejects read-only knobs by name; group writes skip read-only members (error when the whole group is read-only). `harness.set()` untouched — application writes always work. React: `UseKnobOptions.readOnly` threaded; `<Knobs />` formatter emits a `read-only` hint.
- **`@agentick/gates-next`**: `GateDescriptor` is now a union — latch gates (`activateWhen`, unchanged) | verified gates (`satisfied`): level-triggered code predicate evaluated at every tick-end, auto-clears on pass, re-engages on regression, backing knob registered read-only (unforgeable), `defer()` no-op, **fail-closed on predicate throw** (v2's LifecycleStore isolates handler errors, so the hook must catch and treat as unsatisfied — differs from v1 where a throw propagates). Optional `activateWhen` on a verified gate is an ARMING SCOPE: dormant (no verification, no blocking) until the arming predicate first fires; sticky per mount; verification takes over same-tick.
- **Tests**: +10 gates specs (engage/block, auto-clear, regression, async, fail-closed, read-only knob registration, dispatch bypass rejection, defer no-op, dormant/arming) and +4 knobs harness specs (read-only name/group/all-read-only/application-set). Full `packages-next` suite green (3203 passed); per-pkg tsc clean (spec, knobs, gates).
- Judged by me: fresh per-pkg tsc, real stubKnobsHarness dispatch round-trips (not mocks), adversarial coverage on the bypass path.

**2026-07-07 (later) — MCP push: Waves 1–4a landed + content-block safety net.**

Progress on the 6-wave plan (all judged by me — fresh uncached per-pkg tsc, real round-trips, scope-held, adversarial pass):
- **Wave 1 HTTP transports** (`08470a28`): server `httpTransport` + client `streamableHttpTransport` (OAuth threaded), real-loopback conformance.
- **Wave 2 client completeness** (`75de8b52`): full v1 client surface restored (resources/prompts/completion reads, sampling handler, roots provider, logging) + resource content block in spec + content-mapper carries structuredContent/isError.
- **Wave 3a server mechanical** (`c92d99ac`): completion + logging (MCP projection) wired; `lifecycle.ts` tasks-capability bug fixed.
- **Wave 4a ResourcesHarness** (`fdc38ebf`): new bundled `@agentick/resources-next` (registry-of-resolvers + notifier per ADR 62, NOT a store) + thin MCP server projection (hardcoded `resources:false` gone). ADR 51 note: register/subscribe/notifyUpdated are plain methods (required fn param can't be a declared command); read/list/listTemplates are commands.
- **Content-block safety net** (`e7d95447`, `1268640b`): `foldContentBlock`/`foldContentBlockWith` in spec + `resource→clean text` normalization; house rule = never silently drop (degrade to text or be exhaustive), not a 23-handler mandate.
- **Wave 6 conformance** (`c7c73afb`): `runMcpConformance` (loopback both roles + raw-SDK-client + gated server-everything + draft/2025-11-25 version matrix), parameterized by caller-injected harness factories (shipped module imports no concrete sibling; matches runTimelineStore/Sandbox pattern). **Found + fixed a real interop bug**: `buildCapabilities` advertised `tasks:{}` → SDK rejected task-augmented `tools/call` → our own `callToolAsTask` failed against our own server; now emits `tasks:{list,cancel,requests:{tools:{call}}}` + a real passing round-trip. Grows per-capability as later waves land.
- **Compiler-surfacing model — ADR 63** (`46e46b4d`, ratified): defaults = a default TREE (framework default components composed with the root, overridable, devtools-inspectable), NOT implicit IR injection — keeps ADR 49's "IR = only what the compiler rendered" verbatim while getting default-surfacing ergonomics. Per-primitive default (content/tools on; resources = catalog not inlined; MCP server-info = self-description). Unblocks Wave 4b (surfacing = default components).

**Wave 5 fully designed (discussed with Ryan):** log+progress(+status) = ONE framework runtime-ctx family (like elicit), one bus emit → dual projection (MCP notifications + agentick-client via EXISTING subscribe/progress/subscriptions-next infra + typed sugar) — task #19; `isError→ToolResultBlock.isError` + `structuredContent→json block` in the withMCP tool-bridge (no throw, error not lost); pagination (tools/prompts) + `instructions` mechanical; circuit breaker folded into the connection-status FSM.
**Parked/follow-on:** sampling (Wave 3b — discuss later), mime-type-aware media capabilities + throw-on-unsupported-modality (#17), the framework log/progress family ADR (#19). MCP Apps → later `@agentick/mcp-apps-next`. Wave 6 conformance = concurrent finalizer track.

**2026-07-07 (later) — MCP comprehensive push (Ryan: "the best server + client impls we can do").**

**Gap assessment (read-only audit):** v2 MCP is architecturally *ahead* of v1 (per-server harness, declared/journaled commands, security pipeline, era codec, tasks/*, OAuth-via-elicitation) but **regressed hard on protocol coverage** — spoke only tools+prompts+elicitation+tasks over stdio/in-memory; dropped resources, sampling, roots, logging, completion (dead code), all HTTP transports, structured-content passthrough. 6-wave plan to restore + surpass v1. Two ADRs drafted: **ADR 62 `ResourcesHarness`** (resources as a framework primitive MCP projects onto — elicitation precedent, but provider/consumer-asymmetric; awaiting Ryan's 3 calls) and the **ADR 61 correction** (auth stays per-transport). Two build decisions locked: MCP Apps → later `@agentick/mcp-apps-next`; Resources → bundled `ResourcesHarness`. Real bug found: `server/protocol/lifecycle.ts:71` gates the tasks capability on the `resources` opt-out key (fix in Wave 3). No MCP conformance suite exists (8 sibling harnesses have one) — Wave 6.

**Wave 1 — HTTP transports (`08470a28`), both roles.** server `httpTransport({port})` (multi-connection Streamable-HTTP over the `ServerTransport` contract, security pipeline runs per HTTP connection, SSE-hang close-ordering fixed) + client `streamableHttpTransport({url,oauth})` (SDK transport + OAuth provider threaded → the `oauth/` module is finally reachable). Proven over **real loopback HTTP** (initialize→list→call, bad-bearer rejected at the pipeline, concurrent-session isolation, OAuth redirect fires the URL elicit; full dance gated on an IdP). Client-wiring placed in a new `integration/http-transport.ts` (not the pure-types `transport-factory.ts` — avoids coupling the type seam to OAuth impl; there is no spec-kind switch in the real code). fresh mcp tsc clean; 232 passed/0 skipped. **Wave-order note:** Wave 2 (client protocol completeness) is HELD until ADR 62 is ratified — the client resource reads + `content-mapper` fix should use the agreed resource content block, not build it twice.

**2026-07-07 (later) — #240 local OS isolation (`73e70e16`) + auth slice-3 correction (`25800124`).**

**#240:** ported v1's OS-jail into `@agentick/sandbox-local-next` — `LocalSandbox.exec` now routes through a platform-selected jail (macOS seatbelt `sandbox-exec` profile; Linux bwrap/unshare + cgroup v2) instead of a bare unjailed `spawn("bash")` (the silent v1-capability regression, now closed). `readonly isolation` field surfaces the effective strategy honestly; `strategy:"auto"` picks strongest; an explicit strategy the host can't honor THROWS at create (no silent downgrade). Limits: wallClockSec/diskMb both platforms; memoryMb/cpuPercent via cgroup on Linux, documented-unsupported on macOS. **Confinement PROVEN** (`isolation.spec.ts`): each deny guarded by `isolation===<jail>` (can't pass on passthrough) + paired with a `strategy:"none"` CONTROL that performs the same escape and succeeds → the jailed failure is provably the jail's doing (write-escape / read-escape / net-egress). seatbelt exercised live on the darwin host; linux gated-skip. Per-domain network rules stay proxy-based (bypassable, documented like docker); only `network:false` is kernel-hard. deps unchanged; fresh tsc clean; 20 passed/5 skipped. Still dev-safety tier (Lambda microVM is the prod isolation) — non-cut-gating, but no longer a v1 regression. **Judge caught nothing to bounce — the confinement CONTROL pattern met the worse-than-none-if-faked bar.**

**Auth slice-3 correction:** the ADR-61 slice-3 plan (relocate auth from slice-1's per-transport `authSource` option to a gateway `interceptIngress` chain + `withAuth`) was **withdrawn** — it would have removed just-shipped working code, created two auth-config paths (one-code-path violation), and added a chain abstraction with **no consumer** (rate-limit/tenant interceptors are speculative, not cut items). Per-transport `authSource` (slice 1) is THE design; the gateway chain is deferred until a concrete non-auth interceptor needs it (`TODO(#146)`). A delegated attempt was hard-killed mid-edit (`TaskStop`) and fully reverted (transports verified tsc-clean at the slice-1 state); `transport-http` was never touched. **Process lessons banked:** don't ship-then-relocate without a consumer ([[steelman-the-null-hypothesis]] serial-churn corollary); to STOP an agent editing, `TaskStop` it — a message is too slow. Slice 2 (connectors) remains the genuinely-additive auth next-step.

**2026-07-07 (later) — #139 kill-and-resume acceptance, both poles (`30e448ce`).**

End-to-end proof of ADR 49 "open-or-rehydrate" against the REAL store adapters. `runKillResumeAcceptance` (new `session-next/testing` subpath, the conformance idiom — parameterized `makeStore` + `skip?`) drives a genuine cycle: session1 `send()` (real write-behind + flush barrier) → `close()` (kill) → fresh session2, SAME id, store over the same durable backing → `hydrate()` before render. Four cases: (1) completed turn survives the fresh open; (2) **MODEL-VISIBILITY (load-bearing)** — a Meszaros `SpyLanguageModelExecutor` overrides `project()` to capture the compiled `LanguageModelInput`; asserts the hydrated prior turn ("PLUM", written only by session1) lands as a USER message the model received on session2's FIRST render → **closes the flagged STATUS gap** ("does hydrated history reach the MODEL, not just the timeline?"); (3) flush barrier (resolution ⟹ durability, asserted synchronously post-`await`); (4) `delete` ends the session (fresh open hydrates empty). Run at Memory + `fsTimelineStore` (real temp dir) GREEN; `postgresTimelineStore` gated on `TIMELINE_PG_URL` (skipped here, honest). `session-next` gains `./testing` + test-only devDeps on the two adapters; NO fakes of the resume pipe (scripted model only); mirrors `timeline-durability.spec.ts` wiring, which stays untouched. Gate (mine): fresh uncached session tsc clean; `npx vitest run packages-next/session` = 70 passed / 4 skipped; oxfmt+oxlint clean. **The durable-stores + resume foundation is now cut-proven at both poles** — the cloud persona #163 (ernesto) stands on verified sandbox + auth-ingress + durable-timeline + resume.

**2026-07-07 (later) — TimelineStore reference adapters #132 (`dcc5565b`; ADR-49 amendment `865158f9`).**

The durability MODEL + the `TimelineStore` port + hydration/flush wiring were already landed (ADR 49, A2). This adds the concrete Class-A adapters. **Design decision (weighed + recorded in ADR 49):** NO `define*`/`defineStore` helper — a `defineTimelineStore` was considered and rejected (the two archetypes share a *pattern* + conformance discipline, not code; and a helper can't own the *backend-assigned* `seq` invariant without breaking DB-serial / stateless-replica resume). Adapters follow the `CredentialsStore` precedent: per-backend factory `implements TimelineStore` directly. **`timeline-fs-next`** (zero-dep JSONL, one append-only file/session, `seq` durable per line, base64url traversal-proof filenames, per-session mutex, batch-append=one syscall) — **restart-durable across prune-to-empty via a GDPR-clean `.hwm` high-water-mark sidecar** (`seed` precedence: cursor → transcript max+1 → sidecar → 0). **`timeline-postgres-next`** (the cloud pole / shared-source-of-truth across stateless replicas): escape hatches first-class — **BYO `executor` (never owns the pool), `table`/`columns`, per-op `sql` function overrides, `codec` (jsonb+schema_ver), `migrate:"off"` default (`postgresTimelineSchemaSql` exported for manual apply)** — the library never owns your schema; `seq = bigint GENERATED ALWAYS AS IDENTITY`; batch `INSERT … RETURNING`. Both pass `runTimelineStoreConformance` against REAL backends (fs: temp dir; **pg: verified 14/14 against real Postgres 16** — IDENTITY + jsonb — plus gated-skip on `TIMELINE_PG_URL` absence, honest like docker/lambda; NO fakes). `timeline-next` gained a `skip?` on the store conformance (mirrors sandbox) + re-exports `TimelineEntry` (adapters dep one package). **Judge loop:** first pass shipped a documented "prune-to-empty + restart resets seq to 0" gap; I rejected it (real violation of the frozen never-reused clause — a cursor-holder silently misses post-restart entries) and sent it back → fixed via the `.hwm` sidecar + a 4-case restart-simulation test (new store instance over the same dir asserts seq continues at 3, not 0). Gate (mine): fresh uncached per-package tsc clean; `timeline-fs` 18/18; pg gated; oxfmt+oxlint clean. **Next:** #139 kill-and-resume acceptance tests (both poles) — the end-to-end resume truth-test #163 (ernesto) leans on. **Known gap:** `seq` coerced to JS `number` (pg `bigint`) — ceiling 2^53 entries, documented on the port.

**2026-07-07 (later) — ADR 61 ingress authentication, slice 1 (`59b66185`; ADR `6c8caee5`).**

The auth story had 3 of 4 pieces built (Authorizer ADR 51 §4, `AuthSource` port, `IngressIdentity` carrier); the 4th — the authn CALL — ran only on WebSocket, leaving `transport-http` (the prod edge), unix-socket, and connectors stamping NO principal → the Authorizer saw the trusted local pole = an open door in prod. **ADR 61** (written this session; #146 retargeted off its stale "ADR 34" title; the `TODO(#302)` code refs are stale → #146) establishes **one `interceptIngress` seam for every trust-boundary crossing** (client transports + connectors), a **polymorphic `IngressCredential`** (`bearer|platform|none`), `AuthSource` as the normalizing identity broker → the existing `IngressIdentity`; `session.send`/in-process is the trusted interior and never authenticates. Authenticate ONCE per crossing (per-connection ws / per-request http), propagate the principal, never re-auth inward (north-south vs east-west; prior art: API-gateway edge auth, `SecurityContext` propagation, federated identity/OIDC/SPIFFE). **Slice 1 built + judged green:** `IngressContext`/`IngressCredential` in spec; `AuthSource.authenticate` widened to the polymorphic credential (breaking — all callers fixed); shared **fail-closed** `authenticateIngress` helper (no source → local pole; configured → run + FAIL CLOSED, never catch-and-continue; enrichment-only, never authorizes); typed `IngressAuth{Required,Failed}`/`IngressCredentialUnsupported`. **Edges:** websocket migrated onto the helper (ZERO behavior change — existing ws suites untouched + green; ALSO fixed a latent query-token leak where `?token=` was honored regardless of the documented `allowQueryToken` default-false, and dropped a false "10s timeout" doc comment); **`transport-http` per-request authn** (each POST authenticates from its OWN `Authorization` header, identity threaded per-dispatch, NEVER cached on the per-session `SessionConnection` → no cross-request bleed; resolves `TODO(trail-http-per-request-auth)`); unix-socket `kind:"none"` default. `staticTokenAuthSource` credential-kind switch (prototype-key-bypass guard KEPT; platform rejected → slice 2). **`runIngressAuthnConformance`** (transport-next/testing) runs against REAL servers (raw ws/fetch/net clients, `spyAuthorizer` records what dispatch saw): valid-bearer→principal, missing/invalid REFUSED at the edge (the fail-closed proof, not local-pole fallthrough), prototype-key bypass, no-source→local-pole, once-per-crossing (ws per-conn shares identity / http per-request proves alice-then-bob no-bleed). **Judge gate (mine, not the agent's word):** fresh UNCACHED per-package tsc clean on all 5 (spec + 4 transports — turbo FULL-TURBO would have lied); `npx vitest run` = 26 files / 184 passed / 15 skipped; oxfmt+oxlint clean; grep-confirmed no client imports `AuthSource` (server-side only). Package READMEs updated with the seam + "Verified by" rows. **Known gaps / TODO(#146) trailheads:** slice 2 (connectors — the `kind:"platform"` federated path + per-message actor, resolves `define-connector.ts:132`); slice 3 (`GatewayInstaller.interceptIngress` multi-interceptor chain + `withAuth` extension, ADR 50 item 2); HTTP DELETE not yet authn-gated; **no authn timeout — a hung `AuthSource` leaks the ws socket / hangs the request** (pre-existing; not a regression).

**2026-07-07 — Lambda MicroVMs prod sandbox provider (ADR 60, `9ab97cd6`; ADR corrections `d7f42f28`).**

Researched the actual [Lambda MicroVMs guide](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html) (Ryan: "research first"). It is a NEW, purpose-built offering ("sandboxes for AI") — a long-lived, addressable Firecracker microVM (dedicated HTTPS endpoint; HTTP/2/gRPC/WS/SSE), FULL OS, persistent processes, NO exec ceiling (the `900` in examples is the idle-suspend timer), with native `suspend`/`resume` preserving memory+disk. This **withdrew ADR 60's A-vs-C substrate fork** — Lambda IS the persistent Firecracker the survey attributed only to a self-operated fleet, serverless + with a real checkpoint. A self-operated `sandbox-firecracker-next` becomes a later portability play, not a capability fork. **Topology decision (Ryan): align with docker/local FIRST** — Lambda = a `SandboxProvider` the gateway-side session reaches into (Topology A). "Agent-in-sandbox" (whole session runs IN the microVM; endpoint = session channel; local sandbox inside) is a real, higher-value prod shape but a **future gateway/session-runtime track**, NOT a SandboxProvider — deferred. **Built (`@agentick/sandbox-lambda-next`, deps sandbox-next only + AWS SDK v3):** provider orchestration (run-microvm→waitRunning→create-auth-token→client stub); the in-VM sandbox-agent (our HTTP/WS server baked into the image, CMD :8080 — readFile/writeFile/editFile with in-VM `applyEdits`, exec streamed over WebSocket→onOutput, the in-VM egress proxy using the base's shared `matchRequest`); the endpoint client (JWE `X-aws-proxy-auth`/`X-aws-proxy-port`, server-side only); a typed-error codec that round-trips sandbox errors across the wire (instanceof preserved); an **injectable `LambdaMicrovmsControlPlane` seam** so the far-side + client + protocol are FULLY real-tested via a loopback (`fakeLambdaMicrovmsControlPlane` spins up real agents; real fs/bash/HTTP-WS) running the shared #218 conformance suite, while the AWS control plane (`@aws-sdk/client-lambda-microvms@3.1080.0`, real shapes) is integration-tested gated on real AWS. **Divergences from docker (deliberate):** NetworkRule[] is SUPPORTED via the in-VM proxy (docker throws); double is a Meszaros `fake*` not `stub*`. **Gate:** fresh uncached tsc clean (incl tests); `npx vitest run packages-next/sandbox-lambda` = 11 passed / 8 skipped (AWS suite gated); oxfmt+oxlint clean. **Known gaps / TODO trailheads (judge pass):** (1) **`TODO(#226)` SECURITY-VERIFY** — `network:false` maps to *omit egress connector* = intended deny-all, but the AWS doc says egress is PUBLIC by default; if omission ≠ deny-all, `network:false` silently grants internet (the in-VM proxy is soft/env-based, so the connector is the hard boundary). MUST verify on a real microVM. (2) `TODO(#223)` hibernate fast-follow — native suspend/resume = the first HONEST checkpoint (`SandboxSnapshot={microvmId}`, retain-on-destroy); `restore` absent for now. (3) `TODO(#226-followup)` EFS/S3 mount reinterpretation (host binds stay SandboxUnsupportedError). (4) The AWS control-plane wrapper is typechecked against real SDK shapes but UNEXECUTED — closing that needs an AWS account with the offering enabled + a built image (a Ryan-input to prove prod). Docker provider (`487edb42`, #157) + ADR 59 repackaging (`sandbox-next` base, providers dep the base) landed earlier this session.

Merged: adapter combinators (withRetry/withFallback/tapModel — retry/failover through the FIRST chunk); generateObject + normative responseFormat (normalize → translate → providerOptions-wins, ratified); CacheHint awakened (canonical carrier → anthropic cache_control with ttl; explicit providerMetadata wins); usage→cost spine (NORMATIVE UsageStats subset rule — anthropic folds cache tokens into inputTokens; target.pricing adapter-authority precedence, ratified); cursored history (store.history / timeline.history / run({history}) via the hydration path — seeding IS resuming); executeStream iterator throws typed error (#182 Option A; abort clean-terminates); slice 5 (Authorizer port + WireRpcError + dynamic resolver — deny-by-default, exact-beats-dynamic, gated commands/list, augmentations for exactly the ratified matrix rows; unconfigured default: local pole passes, any principal denied). Test infra: runtime-next/testing stubInbox + model-next/testing scriptedAdapter (replaced FIVE per-spec locals). #137 was already fixed (L7 eviction + tests) — closed with evidence. 2836 tests green. **Known gaps flagged:** (1) NOTHING stamps WireExtensionContext.principal — ingress authn (ADR 50 interceptIngress + ADR 34 AuthSource) is the missing half of the security story; (2) the wire lane is unit-tested only — e2e (real gateway+session+staticAuthorizer) owed; (3) timeline→compiled-tree injection unverified (does run({history}) reach the MODEL, not just the timeline?).

**Previously, 2026-07-03 — #152 + #171 landed (PR #180, stacked on #150/PR #170): the `model:` slot and `run()` one-shot.**

`createApp({ model: openai("gpt-4o") })` — exactly one of `model` (LanguageModelAdapter; app wraps it in THE executor) / `executor` (BYO engine); bare-adapter-on-executor rejected with a pointer. The noun aligns across every tier: generate({model}) / run({model}) / createApp({model}) / <Model model> (#169) / model-* packages. And `run(<Agent/>, { model, messages })` fills the ergonomics ladder's middle rung (generate → run → createApp+sessions): temporary app+session, one full-loop execution, auto-teardown on settle, v1 handle ergonomics (`.result` unwrap + directly for-await-able), exported from app-next + /react. History seeding deferred to the timeline:append exposure story (noted on #171). App 82/82. Also this session: issues #171–#179 filed from the design review (executor-consumes-fold, message-level providerMetadata, customBlocks doc injection, tokenEstimator, merge helper, tool parity audit, loop-ai-sdk design note, tool-call repair hook); #178 updated with the verified ai@5.0.123 prepareStep mechanism — the AI SDK ladder collapses to two rungs (adapter shipped; prepareStep-loop faithful but coupling-priced).

**Previously, 2026-07-03 (later still) — **#150 ADR 52 IMPLEMENTED end-to-end: the ONE LanguageModelExecutor, four providers converted to adapters, @agentick/model-next carved out, packages renamed model-<provider>-next.**

The subclass tier is gone. `LanguageModelExecutor<TRaw,TChunk>` is one final class consuming a `LanguageModelAdapter` options part; `BaseLanguageModelExecutor` + both `define*` factories deleted (755 lines, #103 resolved at the root). All four providers converted with hook bodies verbatim, closures replacing `this.*`: `openai(model?, opts?)`, `google(...)`, `anthropic(...)` (the workspace had been silently red since the collapse — Anthropic still extended the deleted base, so #151's core landed in this branch), `aisdk(model, opts?)` (flat signature, AI-SDK-as-provider-library archetype; the engine archetype stays a follow-up). SDK clients construct lazily — declaring an adapter needs no API key until first call. The substrate-dance `*-factory.ts` files are deleted; `createApp({ executor: openai("gpt-4o") })` works via `isLanguageModelAdapter` detection at the app slot (app wraps the adapter in THE executor on its own substrate; `ExecutorFactory` survives only as a legacy slot form, `TODO(#151)` marks its removal). New package **`@agentick/model-next`** (zero Effect, zero substrate): adapter contract + `StreamAccumulator(+View)` + `DeltaTransform` pipeline + tag routing + canonical projection + **`generate()`/`generateStream()`** options-bag single-shot helpers whose streaming fold mirrors the executor exactly (verified by spec). `defaultFinalizeStream` exported as an executable default (Google's late stop-reason mapping composes it — the `super.finalizeStream()` pattern is dead). Provider packages renamed `executor-<p>` → **`model-<p>-next`** with dep graphs cleaned: `model-next` + spec + utils + SDK only; Effect and runtime-next are devDependencies (an adapter's runtime tree is Effect-free). READMEs rewritten for all six packages. Workspace typecheck green; 2779 tests green (9 new generate specs; executor 41 + model 30 + providers 28/50/43/23). Environment note: verdaccio's CodeArtifact uplink token expired mid-session — restarted via nx-knowify's `scripts/start-verdaccio.sh` (fresh `aws codeartifact get-authorization-token`); public-package installs 404 until that runs.

**Previously, 2026-07-03 (later) — Tracking moves to the GitHub project board: [agentick v2.0 cut](https://github.com/users/agenticklabs/projects/2), issues #132–#167 seeded.**

Kanban columns Backlog/Design/Ready/In Progress/Review/Done + fields Workstream (A–E), Kind, Gate (⛔ ryan-review). 36 issues seeded forward-only from CUT-PLAN + the ADR 51/52 track + the wave's named follow-ups. Division of authority (recorded in CUT-PLAN §0): board = live state; STATUS = narrative log; plan/ADRs = map + design, linking never tracking. Ready column at seed: #133 (seq on TimelineStore), #137 (L7), #140 (verb matrix, ⛔), #141 (slice 5, ⛔), #144 (ADR 51 footnotes), #150 (ADR 52 implementation). Design column: #146 (ADR 34), #154 (connectors ADR, ⛔), #165 (Effect charter, ⛔). **Legacy-number disclaimer:** pre-2026-07-03 `#NNN` references in docs are conversational ids, not issue numbers — ranges collide; issue bodies carry `Legacy id:` annotations. Also: the working tree was found checked out on `master` (the v1 adapter session landed PR #130 + release there) — returned to `feat/v2`; all 25 wave-day commits intact.

**Previously, 2026-07-03 — ADR 51 wave COMPLETE across every harness: skills/prompts/sandbox/mcp-client migrated; reconciler/session/loop/app/gateway precisely classified.**

The invocation model is now uniform. **Migrated** (switches + op literals deleted, wire shapes identical, ZERO test edits across 2792 workspace tests): timeline (6 verbs, slice 4), state (2), knobs (3), skills (3, −52), prompts (5, −39, `prompts:get` newly addressable), sandbox (7, **all newly addressable** — no switch had existed; `exec`/`write-file` flagged for conservative wire-exposure treatment), mcp-client (7, all newly addressable; connect/disconnect/reauth doctrine-excluded as construction-bound; elicitation relay + task fan-out correctly classified plumbing). **Classified with per-verb annotations, not migrated:** reconciler-react (mount/rerender carry live elements/bridges — doctrine; renderTree blocked by two REAL registry gaps the wave discovered: **input-aware scope fn + caller-opId passthrough**, named `BaseHarness.command` follow-ups; recompile/unmount/invalidate are spec-frozen unprefixed wire types → v2.0-sweep rename candidate); session (`TODO(adr-51-session-verbs)`: commands don't run through runOperation at all today + SendInput non-serializables → designed signal form on the slice-5/matrix pass; `session:dispatch` is the easy first declaration); loop-executor (live-refs, permanent doctrine); app/gateway (rootElement doctrine; `close-app`/`close-gateway` are candidates gated on the matrix). Doctrine footnotes owed to ADR 51: optional-fn fields don't trigger §1.2 (required-param rule, knobs/prompts precedent; they degrade to absent over the inbox); opIds canonicalize to `${verb}:${ulid()}` (embedded discriminators move to scope — zero consumers verified). Aggregate wave arithmetic: ~30 verbs declared + enumerable, 6 switches + 27 hand-built Operation literals deleted, 21 verbs inbox-addressable for the first time.

**Previously, 2026-07-02 (late night) — ADR 51 wave: state + knobs migrated (net −83 LOC); Effect-leak audit completed with a clean adopter-edge verdict.**

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

- **`/retry`** — exponential backoff with full jitter (AWS Builder's Library), configurable retryable predicate (transport drops + RateLimited/Backpressure/InternalError by default), idempotency-key propagation via `params._meta.idempotencyKey` (RFC 7231 §4.2.2 / Stripe / GCP convention) on non-idempotent methods (`session/send`, `session/dispatch`, `session/queue`, `app/run_once`), per-method override, deadline-budget. 16 tests.
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

### 2026-07-21

- **Tool-config parity restoration — Pass A LANDED (confirmation seams).** A full
  v1→v2 tool-config audit found the rewrite dropped 15 fields, 4 of them
  callable→static seam-violations (all in the confirmation-UX cluster). Pass A
  restores the confirmation seams, reusing the elicit request's existing
  `message`/`metadata` slots (the gate had hardcoded them) — NO new machinery:
  `annotations.confirmationMessage` (`string | (input,ctx)=>string|Promise`) →
  elicit `message`; `annotations.confirmationPreview` (`(input,ctx)=>Promise<Record>`,
  e.g. a write/edit diff) → `metadata.preview`; `defaultResult` widened to a
  callable at both the fire-and-forget + timeout-fallback sites; `ToolDeclaration.aliases`
  with exact-name-first / alias-index dispatch resolution (an alias never shadows a
  real tool). All typed on `createTool` (erased on the declaration, like `handler`).
  Gates: typecheck --force 152/152 0-cached; 783 tests (9 new confirmation-seams);
  README Confirmation-flow + Dispatch-aliases sections updated. **Restoration queue:**
  Pass B (presentation: `title` humanized name + `displaySummary` + a model-narration
  `_summary` field injected into every tool schema, surfaced on the tool-start event);
  Pass C (`onComplete`/`onError` hooks); Pass D (`type:PROVIDER` provider-executed
  tools — executor skips dispatch, provider runs it). Client `policy` (approve/deny/
  prompt) → folded into client-tools stage 3. Then client-tools stage 2 (wire) ships
  the complete declaration shape.

- **Client-side tools — Stage 1 LANDED (executor native handling).** Baked
  handler-less "client tool" handling + an async `requiresConfirmation` predicate
  into the tool executor's `dispatchBody`, reusing the elicitation suspend/resume
  infra. Discriminator: `handlerRef === undefined` → client-handled (a
  present-but-unresolvable `handlerRef` stays `ToolHandlerMissing`). Two modes off
  `annotations.requiresResponse`: `true` → **suspend** and relay via
  `this.request(TOOL_CALL_CHANNEL, …)`, await the client's `ContentBlock[]`
  (`executedBy: "client"`; timeout → `defaultResult` if set else
  `ToolCallTimeoutError`); falsy → resolve immediately with `defaultResult ??
  "executed successfully"` + a fire-and-forget `this.notifyChannel(...)` (new `BaseHarness`
  primitive — the one-way twin of `request`, `requestType: "notify"`, no
  correlationId). `requiresConfirmation` widened to `boolean | ((input,ctx) =>
  boolean | Promise<boolean>)`, evaluated at the gate. `createTool` handler +
  `handlerRef` now optional. New: `ToolCallTimeoutError`, `tool-call-schema.ts`
  (`TOOL_CALL_CHANNEL`/`ToolCallRequestPayload`/`TOOL_CALL_REQUEST_SCHEMA` — the
  stage-2/3 wire contract), `annotations.responseTimeoutMs`. Gates: typecheck
  --force 152/152 0-cached; 1056 tests (12 new client-tools + regression guard;
  elicitation unchanged); tool-executor README updated with the client-tool flow +
  the confirmation seam. **Next:** the flattened-seam RESTORATION (v1→v2 audit
  running — `confirmationMessage`/`displaySummary`/`confirmationPreview`/
  `defaultResult`-as-function/client `policy`) BEFORE stage 2 (wire `register_tool`
  + `respond_to_tool_call`) so the wire carries the complete declaration shape;
  then stage 3 (client router), then custom UI for tool-use blocks.

- **Phase 4a LANDED: `View.flush()` durability barrier.** View writes are
  fire-and-forget (reads served from the sync cache; a durable-write failure must
  not crash the mutation). Added a private `persist(m, ctx)` that routes the store
  write off the critical path but TRACKS the promise in a `pending` Set and
  latches the first failure (`writeError ??= err`); `flush()` awaits all pending
  writes then surfaces + clears the latched error. `seedSync` stays cache-only.
  Hot path unchanged — the only new surface is `flush()` (the graceful-close /
  hibernate barrier a durable store needs; a no-op for the in-memory default).
  `wrapWriteError` seam skipped (harnesses wrap at their own flush delegation).
  Manifest DROPPED from Phase 4 (Ryan: "too much ceremony") — resume is just
  "each store hydrates its own scope," no per-store cursor record. Gates:
  typecheck --force 152/152 0-cached; store 81 passed (view.spec 16→18). **Next
  (4b):** wire `hydrate()` per harness into construction/resume, seed only when
  the store is empty (fresh), retire `importSnapshot` as the resume mechanism,
  wire close→flush; resources re-runs loaders post-hydrate.

### 2026-07-20

- **Store convergence — COMPLETE (Run 5: resources migrated, credentials closed
  out). ZERO STRADDLE.** resources' two raw catalog Maps (`fixed`/`templates`)
  fold into ONE `View<ResourceDeclarationRecord>` over its single kind-discriminated
  store — durable declarations via `view.write`, transient tree-mounts via
  `view.seedSync` (cache-only, never persisted), unmount via `view.deleteSync`,
  `fixed`/`templates` a read-time partition by `record.kind`. Resolver sidecars +
  both MCP notifiers (`resources/updated` content, `list_changed` topology) stay
  domain-owned (the tasks/prompts precedent). The agent's read: a CLEANER fit than
  the two-Map catalog — the store was already one kind-discriminated collection, so
  the two-Map split was the outlier. Two named behavior changes: durable writes are
  now fire-and-forget (the View trade — reads from cache, a durable failure doesn't
  crash the mutation, same as tasks) and the single keyspace honors the disjoint-key
  invariant the store already relied on. credentials documented as the deliberate
  **async-only no-view case** (no sync read surface ⇒ no View, not SnapshotCapable).
  Gates: typecheck --force 152/152 0-cached; resources+store+mcp 479 passed.

  **The final taxonomy — one contract, one projection pattern, nothing hand-rolled:**
  - `Store<T,Q,M>` — the universal store seam (`query`/`mutate`/`watch?`/`backend`).
    Every store conforms; `CollectionStore`/`LogStore` are ergonomic profiles that
    `extends Store`.
  - `View<TCache, TStore, Q, M>` — the sync collection projection: pure-mirror
    (knobs/state/skills/prompts), fused cache≠store via `project`/`reconstruct`/
    `seedSync` (tasks), single-record single-key (session).
  - `LogView<T>` — the sync log projection (timeline): two-tier + write-behind + flush.
  - **Rule:** a harness holds a `View`/`LogView` IFF it has a synchronous read
    surface. credentials (async-only) is the one principled no-view store.
  Seven commits: 17183a4a (View foundation) · 44b00cf1 (retire CollectionProjection)
  · 9493e505 (rename Reactive*→Store/View) · 746a0b53 (Store universal) · a9a6f64f
  (View cache≠store + tasks) · 8b9f93f7 (session) · a80bd935 (LogView + timeline)
  · [Run 5].

- **Store convergence — Run 4 LANDED: `LogView` extracted, timeline migrated.**
  The log-archetype projection — the sibling of `View`. Timeline hand-rolled a
  two-tier (durable `persisted` + bounded/compacted `projection`) log projection
  with a write-behind pump + `flush()` barrier + compaction; that whole ~200-line
  payload-agnostic machine moved verbatim into `LogView<T>` (`@agentick/store-next`).
  Timeline harness shed net −115 lines, now holds one `log: LogView<TimelineEntry>`
  — grep for bare `_persisted`/`_projection`/`writeBuffer`/`pumpError` fields
  returns none. Two DI seams keep it generic: `wrapWriteError` injects the
  `TimelineWriteFailed` mapper (a spec domain error a generic primitive must not
  hardcode) so `flush()` throws the exact typed error; `LogProjectionMeta` carries
  compaction provenance opaquely. `append` is `Promise<void>` (through awaits the
  store inline + surfaces the typed error; behind buffers + pumps) — awaited via
  `Effect.tryPromise` in `appendBody`. Two-tier kept (the §2.7 projection-only
  drop is a separate future concern); snapshot shape unchanged so restore/
  kill-resume untouched. Gates: typecheck --force 152/152 0-cached; store +
  timeline 178 passed; session/timeline-fs resume green. **The projection taxonomy
  is complete: `View` (collection / single-record / fused) + `LogView` (log), both
  over the one `Store`.** Remaining: resources (`View` + resolver sidecar);
  credentials stays the principled no-view case.

- **Store convergence — Run 3 LANDED: session onto a single-key `View`.**
  `SessionRuntime` hand-rolled the View machine (sync cache + `syncSessionRecord`
  write-through + a `_listeners` notifier); all three fold into
  `View.collection(store, r => r.id)` — one cache entry, keyed by session id. No
  View refinement needed — proof the primitive covers the single-record cell.
  Typed accessors stay as the session-domain facade. Parity-only: the E11
  upsert-on-transition semantics are preserved exactly — `setStatus`/`setMeta`
  persist (`view.write`), `addUsage`/`bumpExecutionCount`/`setCurrentExecutionId`
  are cache-only (`view.seedSync`, riding the next status write), `currentTick`
  stays transient. Optional `SessionStore` handled with a module `NULL_STORE`
  (no-op mutate) so there's ONE read path and no durable mirror is introduced
  where there wasn't one. Honest cost: scalar mutation became whole-record
  copy-on-write (+ ~modest ceremony); session-state.ts grew (a lot of it docs +
  identity fields relocated from the harness, which shed −48) — the trade is
  uniformity over minimal LOC, per the explicit "everything leverages View"
  mandate. `subscribeMetadata` is now consumer-less (folded into `view.write`);
  the `setMeta` change fires an unobservable extra ping. Gates: typecheck --force
  152/152 0-cached; session + app 202 passed / 4 skipped (kill-resume).
  **Remaining:** timeline (`LogView` sibling), resources (`View` + resolver
  sidecar); credentials stays the principled no-view case.

- **Store convergence — Run 2 LANDED: `View` generalized (cache ≠ store) + tasks
  migrated.** The thesis test — does `View` cover the augmented FUSED case, or was
  it only ever a pure-mirror? It covers it, cleanly. `View<TCache, TStore = TCache,
  Q, M>` gains a symmetric CQRS boundary pair — `project: TCache→TStore` (strip on
  write) + `reconstruct?: TStore→TCache` (rebuild on hydrate) — plus `seedSync`
  (cache-only adopt of a record that came FROM the store, no re-persist, no
  change-emit). `View.collection` fills identity, so the 4 pure-mirror consumers
  are unchanged (annotations widened to 4-param, zero behavior change). **tasks**
  dropped its hand-rolled `live: Map<string,LiveTask>` for `View<LiveTask,
  TaskRecord,…>` (`project = lt => lt.record`): `persist()` → `view.write`,
  adopt-from-store → `view.seedSync`, the interrupted-resume branch seeds then
  writes to round-trip the mutation. tasks keeps its per-task `eventBus` (domain
  event stream, NOT the projection notifier) and bespoke `hydrateOrphans`
  (reattach) — View's notify/hydrate are opt-in, unused here. The old
  `TODO(store-phase-N)` betting the primitive would never fit tasks is refuted and
  removed. Gates: typecheck --force 152/152 0-cached; tasks 140 passed (kill/resume
  + cancellation unchanged); store + pure-mirror 349 passed; oxfmt + oxlint clean.
  **Remaining to zero straddle:** session (single-key `View`), timeline
  (`LogView` sibling), resources (`View` + resolver sidecar); credentials stays
  the principled no-view (async-only) case.

- **Store convergence — Run 1 LANDED: `Store` is the universal store contract.**
  `CollectionStore`/`LogStore` formally `extends Store`; every concrete store
  (in-memory defaults, generic decorators, Postgres/Fs adapters, AND credentials)
  implements `query`/`mutate`; the profile methods are sugar. `LogQuery`/
  `LogMutation` defined; duplicate `backend` dropped from the profiles; Cut-1
  coexistence TODOs removed. No store-level straddle left. Gates: typecheck
  --force 152/152 0-cached; vitest 1000 passed (+ timeline-fs 19); oxlint clean.

- **Store convergence — Cut 1 LANDED (foundation + pilot proof).** The
  nine store-backed harnesses each hand-rolled the same reactive machine; the
  convergence collapses it. Design: `docs/proposals/v2/store.md`
  (grounded in TanStack Query / RxDB / Svelte-stores; the "Locked" section).
  **The seam** (`Store<T,Q,M>` in spec-next): three verbs — `query(q,ctx)`
  (read = projection from the source), `mutate(m,ctx)` (write), optional
  `watch?(q,ctx)` (reactivity is a capability, not a mandate). `Q` = a
  serializable query DESCRIPTION (never a query language), defaults to `void`; `M`
  the mutation vocab. `CollectionStore`/`LogStore` are ergonomic PROFILES over it
  (Cut 1: coexist additively — `MemoryCollection` implements both `get/list/put`
  AND `query/mutate`; the formal `extends` sweep is Cut 2). **The collapse**
  (`View` in store-next): ONE harness-side sync projection that subsumes
  `CollectionProjection` + `KeyedNotifier` (render pings) + `ChangeNotifier`
  (typed deltas) — sync reads (`getSync`/`listSync`, render + sync-`exportSnapshot`
  safe), single-mutation `write`/`deleteSync` (cache → seam `mutate` off the
  critical path → ping + typed change), and CHANGE-SILENT bulk `replace`/`hydrate`
  (cache-first, batched pings — a wholesale replace is the harness's own aggregate
  frame, not N spurious deltas). **Pilot:** knobs + state migrated (3 fields → 1
  `view`; `applySet`/`applyRegister`/`applyDelete`/`importSnapshot`/`hydrate`
  boilerplate collapsed). Parity held on the delicate points: knobs `knobs-state`
  JSON-Patch channel (entry-typed stream, `projectStateDelta` unwrap), state's
  `undefined`-value classification (add/update rides `cache.has`, NOT
  `prev !== undefined` — a stored value may legitimately BE `undefined`). Gates:
  **152/152 typecheck 0-cached, 1043 tests / 64 files, oxfmt + oxlint clean.**
  Residual drift (deferred to Cut 2 per the three-consumers rule): a ~7-line
  `toValueChange` entry→value unwrap is duplicated in knobs + state — hoist to a
  `store-next` `mapChange` export during the fan-out. **Cut 2+:** fan `View`
  out to the remaining 7 harnesses, retire `CollectionProjection`, make the
  profiles formally `extends Store`. TODO markers greppable:
  `TODO(store-cut2)`.

- **Store Cut 2a LANDED — skills + prompts migrated, `CollectionProjection`
  RETIRED.** The seven remaining harnesses do NOT fan out uniformly (map in the
  Cut-2 planning): only skills (pure mirror) and prompts (mirror + harness-owned
  `augmentations` split-map sidecar) were the other `CollectionProjection` holders,
  so migrating them onto `View` left the old primitive with zero consumers
  — deleted `collection-projection.ts` + its spec (−287 lines), dropped the barrel
  export. Both in-memory stores gained additive `query`/`mutate` delegates to their
  composed `MemoryCollection` (`TODO(store-cut2)`); store options widened
  to the `Store` seam. Prompts parity detail: the `augmentations` sidecar
  stays harness-owned (cleared on import, untouched on hydrate) and is populated
  BEFORE the now-synchronous `view.write` ping so a subscriber sees the combined
  `declarationOf`. Also fixed Cut-1 doc-rot (state README + store-backing spec still
  named `CollectionProjection`). Gates: **152/152 typecheck 0-cached, 225 tests /
  17 files, oxfmt + oxlint clean.** Net −254 lines.
  **DEFERRED (each needs a design decision, not a sweep):** tasks (cache-type ≠
  store-type `LiveTask` sidecar — needs a `View` refinement + honors tasks'
  own ≥2-augmented-consumer gate), session (single-record `SessionRuntime` → wants
  a `ReactiveCell` sibling; one consumer, three-consumers rule), resources (hybrid
  raw-Map catalog + resolver sidecars — partial fit), timeline (LOG archetype →
  needs a `ReactiveLogView` sibling, not `View`), credentials (async-only,
  untouched — the standing counter-example). **Cut 2b (next mechanical step):**
  `CollectionStore`/`LogStore` formally `extends Store` (in-memory defaults
  inherit `query`/`mutate` free; hand-write on the Postgres/Fs adapters + MemoryLog
  + Idempotent/Journal stores) — retires the coexistence TODOs.

### 2026-07-15

- **ADR 88 + 88a — live media sessions (DRAFT).** Designed the "live" capability
  grounded in OpenAI Realtime / Gemini Live / AI SDK / LiveKit / Pipecat + Knowify
  v1 parity. **Retargeted to a minimal core (rev 3):** a `MediaTransport` *capability*
  (feature-detected, backpressured uplink/downlink, keyed by `(sessionId, streamId)`),
  a continuous `MediaSession`, and the `session.live` handle — client `sendFrame`/
  `onFrame` spec + `uplink`/`downlink` stream projections; server `withLive({ onStream })`
  routing + a per-stream context. Everything above the pipes (STT/TTS engine packaging,
  `TurnArbiter`, capability record, `RealtimeModel` archetype, driven-loop/full-duplex,
  2-track reflex tier) is **app-composed from existing primitives** (`session.send`,
  `guard`, steering, tasks) or **demoted to Future directions**. Key design calls:
  callback/imperative is the spec (no stream-type dep in spec), streams are the
  runtime projection; barge-in = `abort` + steering (not a subsystem); hooks are
  server-lifecycle-grained + opt-in (client is a projection: callbacks + middleware).
  88a validates the deferred engine layer against session-required streaming STT
  (Google) over a continuous multi-turn call (one recognizer, many turns, rotation
  at turn boundaries, Timeline = memory). Scaffolded v0 (`ba3d5770`): harness +
  handle + routing + wire + client, fake-transport unit tested (31 tests).
- **live-next increment 2 — frames actually flow (in-process media plane).** Added
  `inProcessLiveMedia(gateway)` (`@agentick/live-next/testing`) — the in-memory
  `MediaTransport` — composed with the generic control transport via a new optional
  `inProcessTransport({ gateway, media })` hook (transport-in-process stays live-agnostic;
  the coupling lives in live-next). Spec: `onDownlink` egress seam on `LiveHarnessProtocol`
  (the mirror of `push`). 4-test full-stack e2e proves a client `sendFrame` reaches the
  server `onStream.onFrame` and a server `sendFrame` reaches the client `onFrame`, +
  concurrent-stream routing by `streamId`. **Finding (real gap the e2e surfaced):**
  optional-extension bridges (registered via `installer.registerNamespace` →
  `extensionBridges`) had **no server-side `session.<name>` getter** — only built-ins
  (`get tasks()`/`get elicitation()`) did — so `session.live` was `undefined` and the wire
  handler couldn't reach the harness. `live` is the first optional extension with a wire
  method, so nothing hit it before. **Fixed generally in `session-next`:** the SessionHarness
  now exposes every `extensionBridges` name as a `session.<name>` getter (never shadowing a
  built-in) — the server twin of the ADR-87 client sub-handles; makes `session.sandbox`/
  `.credentials`/`.live`/etc. all resolve. Gates: `pnpm typecheck --force` 150/0-cached;
  927 tests across session/app/live/transport-in-process/sandbox/credentials/spec.
- **`session.tasks` completed to a CQRS handle** (`e271c834`): added
  `tasksWireExtension` (`tasks/cancel`) + `tasksHandle` (client) so
  `session.tasks` is now `ChannelView & { cancel(taskId, reason?) }` — uniform
  with `session.knobs` (view + `set`) and `session.elicitations` (stream +
  `respond`). Reads are uniform (channelView/channelStream); writes are per-domain
  commands, NOT divergence. `tasks/cancel` rides `builtinWireExtensions` (owned by
  app-next), so every gateway registers it. Closes the "read-only until its wire
  method lands" note in `builtin-wire.ts`.
- **Ambient-module shadow trap — root-caused a 1575-error regression.** A wire
  `wire-augment.ts` with a bare `declare module "@agentick/spec-next" { … }` and
  NO top-level `import`/`export` is a SCRIPT, so TS reads the block as an *ambient
  module declaration that shadows the entire spec package* (every export vanishes)
  rather than a merging augmentation. Symptom: `example-v2-real` went 0 → 1575
  "has no exported member" errors while every changed package typechecked clean in
  isolation. Fix: `export {}` at the top makes it a module → augmentation. The
  knobs twin dodged this only incidentally (`import type { CommandInfo }`). Load-
  bearing comment added at the seam. **Watch for this on every new type-only
  augmentation file.**
- **Proportionality call:** `tasks/cancel` is a structural twin of `knobs/set`
  (plain request/response wire method), so it gets the knobs test treatment
  (wire-unit + client-handle-unit + real-gateway registration), NOT a heavier
  inProcessTransport full-stack e2e. The elicitation e2e existed because
  elicitation had novel correlationId-routed-stream machinery; tasks/cancel has
  none, and a dedicated e2e would only re-prove the generic dispatch path.

### 2026-07-09

- **Tasks/escalation close-out batch (4 built + verified):** (1) escalation routes
  per ORIGINATING session — `makeEscalate`/lineage read `record.scope`, `submit`
  stamps a per-submit `scope` (`de8aeaa5`); (2) `taskSupport: "supported"` verified
  ALREADY built (pre-flight conflict validation + caller-choice ref/inline + the
  `dispatch-task-mode-matrix` suite; only #174 auto-capability-negotiation remains);
  (3) `ttl` reaper — unref'd per-task timer → `expireTask` marks `failed{kind:
  "timeout"}` + tears down the executor, cleared on terminal (`08155ac2`); (4)
  `client.events()` live stream — `AsyncIterable<ClientEvent>` over a dedicated
  `LocalPubSub` emitter, filter/close/multi-iterator, live-only cursor honestly
  documented, `#308` (`b4497f9d`).
- **ADR 73** (`0ea18bb8`) — AG-UI projection (session bus/`ClientEvent` stream +
  inbox → AG-UI events; thin codec over existing substrate; gated on #308, now
  partly unblocked). **ADR 74** (`980f35dd`) — DRAFT media capabilities +
  capability-aware normalization (#17): structured `media` capability on
  `TargetCapabilities` + a shared normalization pass (source-form transcode in-core;
  format transcode pluggable; unsupported → `onUnsupportedMedia` policy). Design-first
  (no prior spec); 7 open questions to workshop before build.
- **Design ADRs drafted (NOT built — banked for later):** **ADR 71** (`a2df8b02`)
  — app workspace conventions + `agentick.config.ts` (workspace-default layout,
  five explicit-barrel convention folders, a `mergeLayered`-resolved config with
  profiles/`extends`, `create-agentick-app --framework`). **ADR 72** (`33333635`)
  — the `ui://` IR **widget** seam → **A2UI** (MCP-Apps = A2UI-over-MCP), with
  interaction via the ADR 69 inbox relay. **ADR 73** (`0ea18bb8`) — the **AG-UI**
  projection: the session bus/`ClientEvent` stream + inbox → AG-UI events (a thin
  codec over existing substrate; "closer to done"; gated on #308 `client.events()`).
  A2UI = widgets, AG-UI = event stream, MCP = tools — three axes, they compose.
  Companion workshop artifacts exist for 71 + 72. All three are DESIGN drafts;
  none started. (NOTE: the "## What's next" section above is STALE — it predates
  the whole tasks/escalation/tool-result arc; this Decision Log is the live record.)
- **ADR 70 — tool result currency landed** (`5719389f` ADR, `f72508bb` build). A
  tool handler returns `string | ContentBlock[] | { content: string |
  ContentBlock[]; structuredContent?; isError?; metadata? }` (+ Promise/Effect/
  TaskHandle), normalized to one internal result at dispatch. `structuredContent`
  is `outputSchema`-validated (typed `ToolValidationError` on failure) and flows
  to `DispatchResult` + the MCP `CallToolResult` wire — closing the dead
  `outputSchema`→`structuredContent` seam. The headline is composition:
  `outputSchema` is what lets a model chain tools (typed output→input) or write
  code that calls them. `isError` (soft/domain error, model-visible) **replaces**
  `DispatchResult.succeeded` (removed) — soft-error path coherent end-to-end
  (`DispatchResult.isError` → loop `dispatchSucceeded` → `LoopToolResult.succeeded`
  → session `tool_result.isError`); throw stays the HARD path. NO plain-object→
  JsonBlock guessing (rejected — kills inference; wrong-shape return is a TS error,
  guarded by `@ts-expect-error`). `toContentBlocks` string→text normalizer created
  in `spec-next`. `LoopToolResult`/`ExecutionTerminal.succeeded` retained
  (different types, loop-internal — out of scope). Full suite 8060 green.
- **`@agentick/tasks-store-postgres-next` rename** (`6e0a5c90`) + configurable
  `created_at` column across both pg stores (`a2b4445f`) — the pg store gains a
  slot discriminator (tasks has two swappable slots: store + executor, unlike
  timeline's one), forward-compatible with a future `tasks-executor-*`.

### 2026-07-08

- **ADR 69 — substrate request escalation (chain-of-responsibility over the
  ownership inbox); T1 landed** (`5f1794bf` ADR, `01ea384b` T1). A nested unit
  (task or sub-agent) blocked on input escalates up the ownership chain to the
  connected client; the answer routes back. The mechanism IS **nested
  `inbox.ask`** — the ask return-value stack is both the relay AND the reply
  route (no envelope-forwarding / reply-address threading; the first ADR draft
  had that and it was deleted). Escalation edge is the **spawn lineage
  (`parentSessionId`), NOT the structural harness `parent`** (which is the App).
  Interception = a hop's handler returns instead of forwarding; default is
  forward; bubble is the superset, cluster-direct a future optimization.
  Invariant: **`interactive ⊥ detached`** — a detached task can't elicit (no
  live chain) → typed `DetachedTaskCannotElicitError`. T1: `ctx.elicit =
  awaitingInput(escalate)`; `escalate = inbox.ask("session:"+sessionId, 24h,
  signal-interruptible)`; `SessionHarness.handleMessage` forwards if
  `parentSessionId` else resolves terminally via `elicitation.elicit`.
  Payload-agnostic escalation protocol lives in `runtime-next` (substrate
  floor). First consumer = elicitation; sampling/permission/credential/error
  are free future riders. Verified: round-trip + FSM flip + detached guard,
  full suite 8028 green.
- **ADR 69 T2a landed** (`1f4ac378`) — the multi-agent bubbling core: the
  recursive `parentSessionId` hop (2-session chain proven — child task elicit
  forwards up, root parent resolves against the real client), the
  `interceptEscalation(handler)` seam (an ancestor answers / denies / forwards
  a descendant's request; `{forward:false,response}` short-circuits before the
  terminal, throw = deny, `{forward:true}` falls through; NO interceptor =
  byte-identical to T1 parity), `lineage` provenance appended per hop
  (origin task+session → each forwarding hop, principal best-effort per ADR
  51), and the folded dual-currency gap: `awaitingInput` gains an
  `Effect<T,E,never>` overload run as a real interruptible child fiber
  (cancel/ttl `Fiber.interrupt`s it — finalizer-fires proven — vs the
  Promise flag-only path). Contract types (`EscalationEnvelopePayload`,
  `EscalationHop`, `EscalationOutcome`, `EscalationInterceptor`) moved to
  spec-next (cycle-free: the spec `SessionHarnessProtocol.interceptEscalation`
  references them); wire constants stay in runtime-next. Full suite 8035 green.
- **ADR 69 T2b landed** (`6c3f18be`) — the cross-process child elicit bridge:
  a forked task's `ctx.elicit` (a generic `Elicit` Proxy) marshals a
  serializable INTENT `{method, args}` over IPC; the parent
  (`ChildProcessTaskExecutor.bridgeElicit`) reconstructs the live-schema
  request via `hooks.buildElicit(hooks.escalate)[method](...args)` and feeds
  the SAME escalate chain — so interception + lineage apply to a forked task
  for free (proven: a parent interceptor short-circuits a forked child's
  elicit, client elicit never called). The live `StandardSchemaV1` NEVER
  crosses IPC (only `{method, args}` does; `assertElicitArgsCloneable` fails
  loud on a raw `form(liveSchema)`). Typed elicit errors round-trip via
  `serializeAgentickError` (child rethrows the exact class, e.g.
  `ElicitationDeclined`). `input_required` flip crosses via `awaitingInput`
  over IPC. `@agentick/elicitation-next` is a TEST-ONLY devDep — tasks src
  stays elicitation-free (the sugar is injected). Full suite green.
  **Escalation arc (T1 + T2a + T2b) complete for in-process AND cross-process.**
- **Deferred:** lineage UI-surfacing into the client elicit request, and T3
  (durable/cluster escalation + the direct-delivery optimization).
- **ADR 68 input_required (#120-followup) landed** (`4fdb548f`) —
  `ctx.awaitingInput` status wrapper (`working → input_required → working`),
  the origin seam ADR 69 builds on. Plus worker self-terminates on parent IPC
  `disconnect` (`65cf49d8`); cross-restart child reattach reframed as the
  distributed tier (unsound over fork IPC), not a follow-on.
- **ADR 68 persistent tasks — Builds A + B landed** (`3c747508`,
  `3c1beb6f`). The pivot: a task is a persisted `TaskRecord` FSM in a
  `TaskStore`; *how it runs* is a pluggable `TaskExecutor`. Build A:
  record-source-of-truth refactor of `TasksHarness` (CQRS — sync
  projection kept in lockstep with async `store.put`; bus stays the
  LIVE plane, store the DURABLE plane, wire payloads byte-identical),
  `InMemoryTaskStore` + `runTaskStoreConformance`, `InProcessTaskExecutor`,
  `detached` lifetime (survives session close), `interrupted` orphan
  accounting on hydration (scope-filtered per session). Build B:
  `ChildProcessTaskExecutor` over fork+IPC (by-ref: closures can't cross
  the boundary → `handlerRef` + serializable `TaskRecord` descriptor;
  graceful IPC-cancel → SIGKILL backstop; crash → `failed`; within-process
  reattach), and the harness single-executor field generalized to a
  **registry keyed by `.kind`** — per-submit `executorKind` selection,
  hydration/cancel dispatch by `record.executorKind`.
- **Executor authoring surface decided.** `TaskHandlerRegistry` +
  `registerTaskHandler<I,O>` (transport-agnostic, generic) factored
  STRICTLY apart from `runTaskWorker` (the IPC driver) — the registry is
  the reusable piece a future distributed (e.g. queue-backed) executor
  reuses with its own driver. NO `defineTaskStore`/`defineTaskExecutor`
  factories: the ports are non-generic and validation lives in the
  conformance suites, so a factory would be a pass-through returning its
  arg. The `define`-energy belongs at the by-ref handler layer, not the
  port layer.
- **App-scoped `tasks: { store, executors }` seam on `createApp`** — NOT
  a cascade. Detached tasks + child reattach require shared singletons
  that outlive any one session, so the store + executors are app-owned
  for the app's lifetime (a session-scoped store would lose detached
  tasks on close). Contrast knobs/gates, which DO cascade (policy).
- **ADR 68 pg tier landed** (`4e3b43d3`). `@agentick/tasks-store-postgres-next` —
  a durable Postgres `TaskStore`, the flexible cloud-pole sibling of
  `timeline-postgres` (BYO executor, table/columns/sql/codec/migrate escape
  hatches, factory implements the port directly per ADR 49). Schema: task_id
  PK + scope jsonb (GIN) + status + updated_at + payload jsonb + schema_ver;
  UPSERT put, `scope @>` containment list, terminal-only prune. Passes
  `runTaskStoreConformance`. The unlock the in-memory store structurally
  can't demonstrate — a cross-process resume proof (verified 12/12 on a real
  postgres:16): `interrupted`-on-restart FIRES FOR REAL (abandon harness #1
  without close → fresh harness #2 over the same pool+table marks the orphan
  `interrupted`) + terminal adoption (result decoded from pg, not a live
  fiber). NOTE: the earlier scout finding stands — with the in-memory store,
  same-process session-resume re-hydration was already a no-op the ADR 68
  machinery covered; this pg store is what makes cross-process resume real.
- **Still deferred (seam-ready):** cross-restart CHILD reattach-by-pid
  (needs the executor to persist its pid into `record.executorState` +
  pid-based re-adoption) — `TODO(ADR-68 child-reattach)`; and the
  `input_required` transition (`#120-followup`). A
  distributed/queue executor (pg-boss-style) is the ambitious tier: it's
  the child-process executor with the pipe swapped for a queue + the
  cluster bus (report goes through the durable + cluster planes rather
  than an in-process closure).

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
