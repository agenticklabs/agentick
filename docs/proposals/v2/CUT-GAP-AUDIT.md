# v2 Cut-Readiness Gap Audit

**Generated:** 2026-07-06 by the `v2-cut-gap-audit` workflow (5 dimension sweeps → adversarial completeness critics → synthesis). Read-only audit; findings verified spot-checked by Fable before this doc.

**Status of the audit itself:** the dedicated content-block×adapter matrix dimension failed its structured-output cap and is being re-run separately; the subsystem sweep independently verified content-block-*type* union parity as present-ok. Everything else completed + was adversarially critiqued.

> This is the triage surface for the cut. Nothing here is filed as a GitHub issue yet except where noted — Ryan triages, then we file + tag the board (workstream + cut-blocking) → roadmap view.


## Executive summary

Synthesized four adversarially-critiqued gap dimensions (connectors, sandbox, model-adapter features, whole-subsystem sweep) into a cut-readiness view. Fifteen gaps gate the v2.0 cut. The correctness-critical class is the SILENT-DROP cluster in the model layer: JSX-declared providerOptions never reach any adapter (#176, orphaned at loop→executor), and responseFormat degrades silently to raw text on Anthropic + AI SDK (a named Knowify email-classification need, #184 closed prematurely). The design-gating cluster is connectors: no ADR exists (#154 in Design), no connector-next base, the auth ingress seam (interceptIngress token→principal) is deferred (#146/ADR 34) and strictly gates the port (B2→C1), and three newly-found silent mechanisms (MessageSource registry, tool-confirmation-via-ElicitationHarness, GatewayExtension inbound sendToSession/respondToConfirmation verb) have no v2 home. The execution-gating cluster is sandbox: zero concrete provider packages exist (#157) though Persona 1 requires one, and sandbox-local is a rework (per-domain NetworkRule[] firewall has no home in the narrowed v2 provider contract). Below the cut line: a large parity backlog (canonical topP/penalties/stopSequences unreachable, AI SDK drops reasoning, OpenAI ignores target.modelId, sandbox exec-streaming dead, no sandbox conformance suite, model-facing sandbox tools lost their diff-preview confirmation UX) plus three undecided drift-to-drop subsystems (apple/bedrock adapters, guardrails, agent-composition) that need explicit keep/defer/drop calls rather than silent omission. All cutBlocking=true gaps map to existing open issues (#176/#146/#154/#157) or a reopen (#184); every genuinely NEW proposal is a non-cut-blocking parity/correctness item.


## Cut-blockers (15) — ranked

1. providerOptions escape hatch orphaned at loop→executor — every JSX-declared provider knob (thinking, seed, logprobs, safetySettings, cache_control, top_p) silently dropped across all four adapters (#176)
2. responseFormat silent-drop on Anthropic + AI SDK — structured output degrades to raw text with no error; named Knowify email-classification live need (#184 closed prematurely)
3. Connectors ADR does not exist — the design gate for the entire connector port; transcript corpus has zero connector discussion (#154)
4. Auth ingress seam interceptIngress (token→principal) deferred — upstream blocker for connector service-account identity; B2 strictly gates C1 (#146/ADR 34)
5. connector-next base package missing — createConnector/ConnectorSession/content-pipeline/DeliveryBuffer/RateLimiter/retry have no v2 home (#154)
6. No sandbox provider packages exist — spec contract landed but zero concrete SandboxProvider; Persona 1 requires a runnable sandbox (#157)
7. GatewayExtension has no sendToSession/inbound-inject/respondToConfirmation verb — the core inbound mechanic v1 PluginContext provided is unbuilt (#154)
8. Tool-confirmation surface fully migrated to ElicitationHarness — connector confirmation UX (inline keyboard / text yes-no) unmapped onto the elicitation channel (#154)
9. MessageSource / MessageSourceTypes augmentable registry has no v2 home — silent drop; imessage augmentation target absent, per-message source tag unbuildable (#154)
10. sandbox-local-next network firewall (NetworkRule[] first-match-wins egress + ProxiedRequest telemetry) has no home in the narrowed v2 provider contract — rework not port (#157)
11. sandbox-docker-next + sandbox-secure-exec-next ports missing — secure-exec not even scoped in #157 (#157)
12. Service-account principal + per-message actor identity model is net-new — v1 has no principal; construction-bound per ADR 48 §5 immutability (#154)
13. connector-telegram-next port missing — must also resolve the v1 GatewayPlugin-vs-ConnectorPlatform dualism onto one gateway-extension shape (#154)
14. connector-imessage-next port missing — depends on the absent MessageSource registry and splitMessage (#154)
15. splitMessage utility lost in v2 — no chunker in utils-next; Telegram hard-caps at 4096 chars; prerequisite for both platform ports

## Proposed issues — CUT-BLOCKING (6)


### responseFormat silently dropped on Anthropic + AI SDK — cross-provider structured output degrades to raw text
**Workstream:** C-parity · **cut-blocking:** True _(net-new)_

**Gap (SILENT DROP, highest correctness class).** Only OpenAI + Google map `responseFormat` natively. Anthropic `buildAnthropicParameters` projects it into `LanguageModelParameters` but `toAnthropicParams` comments 'Silently drop responseFormat' and never emits it. AI SDK `toAISDKInput` maps temperature/topP/penalties/stopSequences but NOT responseFormat, so structured output falls back to raw text + post-hoc parse. `generate-object.ts` has both TODOs unimplemented. No conformance test asserts responseFormat translation.

**Also fold in** `ResponseFormat.name`: carried on `json_schema.name?` (rendered-tree.ts:33) and read by OpenAI (`rf.name ?? 'response'`), but `buildParameters` (canonical-projection.ts:70) and `buildAnthropicParameters` (anthropic-adapter.ts:989) omit it — OpenAI always defaults the schema name.

**Evidence/live need.** CUT-PLAN C8: 'only OpenAI honors responseFormat today and others drop it silently — that silent drop must become an explicit error or projection.' Knowify email-classification flows named as the live consumer.

**v1 ref.** packages/adapters/ai-sdk/src/adapter.ts:312 (responseFormat→outputSchema).
**v2 location.** model-ai-sdk/src/ai-sdk-adapter.ts:358; model-anthropic/src/anthropic-adapter.ts:635; model/src/canonical-projection.ts:70.

**Recommendation.** REOPEN #184 (closed prematurely — its cross-adapter claim is unmet). Implement Anthropic tool-shaped structured output + AI SDK experimental_output/generateObject; carry `name` in both param builders; and make the residual unsupported case an explicit typed error, never a silent raw-text degrade. Add per-adapter responseFormat conformance cells. Adjacent to #160 (widen or file dedicated).


### JSX/tree-declared providerOptions never reach any adapter — orphaned at loop→executor boundary
**Workstream:** C-parity · **cut-blocking:** True _(maps to #176)_

**Gap (SILENT DROP).** `reconciler/collect/collect.ts:379` merges `<ProviderOptions>` fragments into `RenderedTree.providerOptions` (:420), but `loop-executor/src/harness.ts` has ZERO `providerOptions` references — `tickTarget = resolvedModel?.target ?? input.target` (:254) is never augmented with tree providerOptions. `ProjectInput` (executor.ts:106) carries only {compiled,target,scope,tools}; `LanguageModelInput` (:176) only {messages,tools,parameters}. All four adapters read ONLY `target.providerOptions`. Net: every JSX-declared provider knob (thinking config, seed, logprobs, safetySettings, cache_control, top_p, tool_choice) is silently dropped. This is the escape hatch that several other gaps route through, so it is doubly load-bearing.

**v1 ref.** packages/adapters/ai-sdk/src/adapter.ts:169-199 (providerOptions mergeDeep at call time).
**v2 location.** loop-executor/src/harness.ts:254.

**Recommendation.** #176 is PARTIAL — the merge helper exists in reconciler but the result is orphaned. Fold `tickCompiled.providerOptions` onto `tickTarget` before project (or thread through ProjectInput→LanguageModelInput). Add a spec-conformance assertion that a tree-declared provider option lands in buildParams output.


### MessageSource / MessageSourceTypes augmentable registry has no v2 home
**Workstream:** C-parity · **cut-blocking:** True _(maps to #154)_

**Gap (SILENT DROP; #154 sub-mechanism — must be enumerated in the connectors ADR).** `grep -rln MessageSource packages-next/` returns ZERO. v1's augmentable per-message source-tag registry (shared/src/messages.ts:48-53) is what imessage-platform.ts:12-16 augments with `imessage:{type,handle}` and what ConnectorSession.send() writes into message `metadata.source`. `RuntimeContextUser` (runtime-context.ts:69) is a runtime-context ACTOR slot — a DIFFERENT mechanism; the v2 timeline message shape exposes no arbitrary `source` metadata slot (only strategyMetadata). So the connector recommendation of 'per-message actor rides RuntimeContextUser + message metadata' is half-unbuildable.

**v1 ref.** packages/shared/src/messages.ts:48-53.
**v2 location.** none — spec/timeline/utils-next define nothing.

**Recommendation.** The #154 ADR must decide the per-message source-tag home: either port the augmentable registry into spec-next/timeline-next message metadata, or fold sender identity entirely into RuntimeContextUser and drop the message-tag. The imessage augmentation target does not exist and must be created either way.


### Connector tool-confirmation UX must be re-mapped onto ElicitationHarness
**Workstream:** C-parity · **cut-blocking:** True _(maps to #154)_

**Gap (#154 sub-mechanism).** v1's richest connector behavior — inline-keyboard Approve/Deny and text yes/no confirmations rendered to the chat surface — was driven by `tool_confirmation_required` + the `ToolConfirmations` client primitive + `PluginContext.respondToConfirmation`. In v2 that whole mechanism is retired: tool-executor-next/src/harness.ts:290-292 states confirmation responses now arrive on the elicitation harness's address; confirmations flow as `session:channel:elicitation` envelopes with an approve/deny schema (conformance.ts approvalSchema). A ported connector must SUBSCRIBE to the elicitation channel, format the prompt for the platform, and route the reply back through the elicitation harness address — a completely different integration than v1.

**v1 ref.** connector-telegram/src/confirmation-utils.ts (parseTextConfirmation/formatConfirmationMessage); telegram-plugin.ts:150-254.
**v2 location.** elicitation/{channel.ts,inbox-protocol.ts}; tool-executor-next/src/harness.ts:440.

**Recommendation.** The #154 ADR must specify the connector→elicitation-channel subscription + platform-format + respond path, preserving a text-parse (yes/no/explain) fallback as a platform-side transform of the elicitation response schema.


### GatewayExtension needs a sendToSession / inbound-inject / respondToConfirmation verb surface
**Workstream:** B-gateway · **cut-blocking:** True _(maps to #154)_

**Gap (#154 sub-mechanism; net-new on the GatewayExtension contract).** gateway-next/src/harness.ts exposes createApp/createSession cascade + wire dispatch but NO `sendToSession`, session-inject, or `respondToConfirmation`. v1 telegram's entire loop depends on `PluginContext.sendToSession(sessionKey,input): AsyncIterable<StreamEvent>` (iterating content_delta/tick_start/tool_confirmation_required) and `respondToConfirmation`. The v2 mechanism by which a gateway extension injects an inbound user message into a (possibly store-resumed) session and streams that session's events back does not exist.

**v1 ref.** packages/gateway PluginContext.sendToSession / respondToConfirmation (telegram-plugin.ts:131,122,171).
**v2 location.** gateway-next/src/harness.ts (GatewayExtension) — no such verb.

**Recommendation.** The #154 ADR + connector-next must define the extension→session inbound path: resolve/create session (store-backed resume per Workstream A), inject a user message, subscribe to that session's event + elicitation streams, and stamp the construction-bound principal. Net-new verb surface on GatewayExtension.


### Port splitMessage into utils-next — prerequisite for both connector platform ports
**Workstream:** X-crosscutting · **cut-blocking:** True _(net-new)_

**Gap.** `grep -rln splitMessage packages-next/` returns ZERO; no split/chunk text helper in utils-next. Both platforms need message chunking for platform length limits (Telegram hard-caps at 4096 and splits every outbound + telegram:send payload). Per CLAUDE.md 'ALWAYS check utils-next first' this belongs in utils-next.

**v1 ref.** packages/shared splitMessage (used by connector message-splitter.ts + telegram-plugin.ts:75,215).
**v2 location.** utils-next / shared successor — absent.

**Recommendation.** Mechanical port into utils-next before the platform ports. Distinct from the #154 ADR design work — this is a standalone shared-util port, so file it separately rather than burying it in the connectors umbrella where it will drift-to-drop.


## Proposed issues — parity/correctness, below the cut line (23)


### Canonical generation params topP/frequencyPenalty/presencePenalty/stopSequences are unreachable
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap (SILENT DROP-adjacent).** `LanguageModelParameters` (executor.ts:283-297) declares topP/frequencyPenalty/presencePenalty/stopSequences and all four adapters consume them, but `SpecConfig` (rendered-tree.ts:53-59) has ONLY {model,responseFormat,maxOutputTokens,temperature,metadata}. `buildParameters` and `buildAnthropicParameters` map ONLY temperature/maxOutputTokens/responseFormat. So `input.parameters.topP` is ALWAYS undefined on the canonical path — the adapter reads are dead code. Smoking gun: anthropic-executor.spec.ts:626 comment 'Manually call execute since stopSequences/topP aren't in tree.config schema.' The only route is the providerOptions escape hatch — which is itself orphaned (#176).

**v1 ref.** packages/adapters/openai/src/openai.ts (v1 mapped top_p/stop/penalties).
**v2 location.** spec/src/data/rendered-tree.ts:53; model/src/canonical-projection.ts:57.

**Recommendation.** Add topP/frequencyPenalty/presencePenalty/stopSequences to SpecConfig and map in both param builders, OR delete the dead adapter reads and document these as provider-escape-only (contingent on #176). Add a conformance cell asserting a config-declared topP lands in buildParams. Ordered after #176.


### Message-level providerMetadata dies at projection (all adapters)
**Workstream:** C-parity · **cut-blocking:** False _(maps to #173)_

**Gap.** `buildMessages` (canonical-projection.ts:105-113) copies only `entry.metadata?.cache`, never `entry.metadata?.providerMetadata`. `LanguageModelMessage` (executor.ts:196-209) has no providerMetadata field at all. Anthropic's custom buildAnthropicMessages has the same omission. Block-level providerMetadata survives (messagePartFromBlock:137), so only message-scoped metadata is lost.

**v2 location.** model/src/canonical-projection.ts:108.

**Recommendation.** Tracked by #173. Add providerMetadata to LanguageModelMessage; carry entry.metadata.providerMetadata in buildMessages + buildAnthropicMessages; adapters merge into the provider message envelope.


### Google adapter ignores canonical CacheHint (input cache never translated)
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap.** google-adapter.ts never reads part.cache/message.cache — grep finds only usage-side surfacing (cachedContentTokenCount), no input-cache translation to `config.cachedContent`. Canonical buildMessages stamps cache onto system parts but Google's toGoogleContents discards it. Only Anthropic translates the hint; OpenAI no-op is correct (automatic prefix cache); AI SDK relies on the orphaned providerOptions passthrough.

**v2 location.** model-google/src/google-adapter.ts:558.

**Recommendation.** REOPEN #185 (its cross-adapter claim is unmet for Google). Map CacheHint→Gemini cachedContent OR document Google as no-op in #185's matrix; add a per-adapter cache-hints conformance cell exercising Google.


### AI SDK adapter drops reasoning/thinking parts (regression vs v1)
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap.** ai-sdk-adapter.ts:310-312 default branch: 'Reasoning, files, sources, source-document — not yet mapped.' No reasoning ContentBlock emitted for AI SDK models. v1 mapped reasoning-delta→reasoning (adapter.ts:354). The other three adapters surface reasoning (anthropic thinking, google thought, openai reasoning_content).

**v2 location.** model-ai-sdk/src/ai-sdk-adapter.ts:310.

**Recommendation.** Map AI SDK reasoning/reasoning-delta/reasoning-start/reasoning-end fullStream parts to reasoning-* AdapterDeltas.


### OpenAI adapter ignores target.modelId — per-tick <Model> override silently ignored
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap.** toOpenAIParams:495 hardcodes `model: defaultModel ?? 'gpt-4o-mini'` and never reads `target.modelId`. Anthropic (:624) and Google (:592) both use `target.modelId ?? defaultModel ?? DEFAULT_MODEL`. Consequence: ADR 56 per-tick <Model> override flowing via a resolved target is silently ignored for OpenAI — always calls the construction-time model. (AI SDK exempt: model is a bound instance.)

**v2 location.** model-openai/src/openai-adapter.ts:495.

**Recommendation.** Change to `model: target.modelId ?? defaultModel ?? 'gpt-4o-mini'`; add a per-tick-model conformance cell for OpenAI.


### No tool_choice / tool-choice forcing knob anywhere (all adapters)
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap.** `LanguageModelParameters` has no toolChoice field. OpenAI hardcodes tool_choice:'auto' when tools present; anthropic/google/ai-sdk set none. Forcing required/none/specific-tool is only reachable via the orphaned providerOptions escape hatch. (v1 openai also only did 'auto'.)

**v2 location.** spec/src/protocol/executor.ts:283.

**Recommendation.** Add canonical `toolChoice?` to LanguageModelParameters; translate per adapter (OpenAI tool_choice, Anthropic tool_choice, Google functionCallingConfig.mode, AI SDK toolChoice). Low urgency.


### Anthropic stop_reason 'refusal' and 'pause_turn' unmapped → silently fold to 'end'
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap.** mapFinishReason (anthropic-adapter.ts:1104-1117) handles end_turn/max_tokens/stop_sequence/tool_use; default returns 'end'. Anthropic also emits 'refusal' (should map to spec 'content_filter') and 'pause_turn'; both currently mask as clean 'end' — a content-filter event is indistinguishable from a normal completion.

**v2 location.** model-anthropic/src/anthropic-adapter.ts:1114.

**Recommendation.** Map 'refusal'→'content_filter'; pick a canonical value for 'pause_turn' (likely 'other').


### reasoningTokens not surfaced by AI SDK (regression) and OpenAI adapters
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap.** AI SDK normalize usage (ai-sdk-adapter.ts:527-537) maps input/output/total/cachedInput/cacheCreation but NOT reasoningTokens — v1 surfaced it (adapter.ts:391). OpenAI (openai-adapter.ts:726-733) never reads `usage.completion_tokens_details.reasoning_tokens`. Google + Anthropic surface reasoning/cache-creation token fields.

**v2 location.** model-ai-sdk/src/ai-sdk-adapter.ts:527; model-openai/src/openai-adapter.ts:726.

**Recommendation.** Map reasoningTokens in AI SDK (finish usage + normalize) and OpenAI (completion_tokens_details.reasoning_tokens).


### No sandbox provider conformance suite or test double — provider ports will land unverified
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap.** `ls spec-conformance-next/src/` has journal/event-bus/transport/executor/harness-slot but NO sandbox suite. `ls sandbox-next/src/` has react/ + top-level files only — no conformance.ts, no testing/ subpath. CLAUDE.md's per-harness convention mandates conformance.ts + a testing double; 'every claim needs a test' requires provider parity be verified. There is no runSandboxProviderConformance and no stub/fake.

**v1 ref.** packages/sandbox/src/testing.ts; packages/sandbox-local/src/testing.ts.
**v2 location.** spec-conformance-next/src/ (no sandbox file); sandbox-next/src/ (no conformance.ts/testing).

**Recommendation.** Add runSandboxProviderConformance (create→exec/read/write/destroy + error taxonomy) + stubSandboxProvider/fakeSandboxHandle under sandbox-next/testing. Gate each -next provider on the shared suite. Prerequisite for landing #157 providers with any confidence.


### Sandbox exec streaming specified but not wired — SandboxExecDelta never emitted
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap.** grep of sandbox-next/src for exec:delta|SandboxExecDelta|onOutput|onDelta|publish returns only doc-comment/test hits — execBody (harness.ts:266-285) just awaits handle.exec and returns the buffered result. v2 `SandboxExecOptions` (sandbox.ts:47-53) removed v1's onOutput, so a provider has no channel to stream chunks even if the harness wanted to emit the SandboxExecDelta it defines. Live stdout tailing (a v1 capability) is dead.

**v1 ref.** packages/sandbox/src/types.ts:122-124 (ExecOptions.onOutput); OutputChunk.
**v2 location.** spec/src/data/sandbox.ts:217; sandbox-next/src/harness.ts:266.

**Recommendation.** Add onDelta/onOutput back to SandboxExecOptions (or pass an emitter); have execBody forward chunks onto the bus as SandboxExecDelta before the terminal result. Do this BEFORE the provider ports so streaming providers (docker execStart, Lambda response streaming) have a target.


### Model-facing sandbox tools lost confirmation + diff-preview UX — destructive writes no longer show a diff before approval
**Workstream:** X-crosscutting · **cut-blocking:** False _(net-new)_

**Gap (platform-wide confirmation-flow regression).** v1 WriteFile/EditFile set `requiresConfirmation:true` + a `confirmationPreview` returning `{type:'diff',filePath,patch,isNewFile}` (createTwoFilesPatch) so the human approves the EXACT diff. v2 react/tools.tsx WriteFile (:76) and EditFile (:97) set NEITHER. Worse, v2 `declarations.ts:97` exposes only a bare `requiresConfirmation?:boolean` ([V1-INHERITED]) — grep shows NO confirmationPreview/diff/patch payload anywhere in the v2 confirmation flow. The sandbox ACL is an allow/deny path/command gate — a user approving 'write /foo' never sees the content. The diff-preview human-in-the-loop UX regressed platform-wide.

**v1 ref.** packages/sandbox/src/tools.ts:63-102.
**v2 location.** sandbox-next/src/react/tools.tsx:76-127; spec/src/data/declarations.ts:97.

**Recommendation.** Add a `confirmationPreview` diff payload to the v2 tool-executor confirmation flow (declarations + harness) so the elicitation envelope can carry the patch; restore requiresConfirmation on WriteFile/EditFile (compute via read+applyEdits). If the diff-preview is deliberately cut, document it as a known UX regression.


### v2 SandboxHandle narrowed to 4 methods — editFile/stat/readdir are lossy shims, runtime mounts dropped
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap.** Harness synthesizes 3 of 7 verbs atop a 4-method handle. `editFile` (harness.ts:315) is read→applyEditsLocal→write; `applyEditsLocal` (:549) is a self-described 'minimal subset' handling only replace/delete/insert-before/insert-after and `skipped+=1` on insert-start/insert-end/range that spec SandboxEdit still advertises. `stat` fakes kind='file'/mtime=Date.now(); `readdir` shells `ls -1A` and hardcodes kind:'file'. v1 runtime addMount/removeMount/listMounts are gone.

**v1 ref.** packages/sandbox/src/types.ts:29-39.
**v2 location.** sandbox-next/src/harness.ts:315-395,549.

**Recommendation.** Grow SandboxHandle with optional stat/readdir/editFile (harness falls back to shims when absent), or explicitly mark these intentionally-lossy in the README. Reuse v1 applyEdits rather than the reduced applyEditsLocal.


### v2 EditFile model-facing tool schema drops v1 edit modes (range / insert-start / insert-end / from-to)
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap.** v1 EditFile tool schema (tools.ts:128-175) advertises delete-flag, insert start/end, from/to range replacement, content. v2 tool schema (tools.tsx:101-113) exposes only replace/delete/insert-before/insert-after via a 4-value mode enum. Notably narrower than BOTH v1 AND the v2 spec it targets — SandboxEdit (sandbox.ts:235-261) still advertises range/insert-start/insert-end/startLine/endLine, which the model can never invoke.

**v2 location.** sandbox-next/src/react/tools.tsx:101.

**Recommendation.** Widen the EditFile tool schema to match SandboxEdit once applyEditsLocal (or reused v1 applyEdits) implements the modes. Downstream of the applyEditsLocal shim gap.


### Sandbox hibernate/restore unimplemented — bridge never calls provider.restore, snapshot shape changed
**Workstream:** A-durability · **cut-blocking:** False _(net-new)_

**Gap.** grep of sandbox-next/src for restore/SandboxIntent/SandboxSnapshot returns NONE. bridge.createHarness (:92) only calls SandboxHarness.fromProvider→provider.create; the optional SandboxProvider.restore (sandbox.ts:76) and SandboxIntent recording are unwired. Shapes changed: v1 restore read snapshot.id/workspacePath/state (all removed); v2 SandboxSnapshot is now {providerName,data:opaque}. ADR 24 flow-c expects lazy re-create on first sandbox-needing dispatch — but nothing records SandboxIntent for that re-create.

**v1 ref.** packages/sandbox/src/types.ts:96-108; sandbox-local restore().
**v2 location.** spec/src/data/sandbox.ts:294-314; sandbox-next/src/bridge.ts:92.

**Recommendation.** Post-cut acceptable. Add a `TODO(phase-N)` at bridge.createHarness to record SandboxIntent and thread provider.restore; port v1 local restore onto the opaque-data snapshot shape when hibernate lands. Fold v1 `SandboxConfig.persist` opt-in here.


### @agentick/sandbox-next ships no README — CLAUDE.md per-package requirement violated
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap.** `ls sandbox-next/README.md` → no matches. CLAUDE.md mandates a README (description, examples, API, status, roadmap, known gaps) + New Package Checklist item 5. The lossy shims, dropped exec streaming, and missing providers/conformance all belong in a 'Roadmap & known gaps' section per 'every claim needs a test' — there is nowhere documenting them today.

**v2 location.** sandbox-next/README.md (does not exist).

**Recommendation.** Add the README (Purpose, Quick Start via withSandbox + <Sandbox>, API, Verified-by section, Known-gaps enumerating shim fidelity, absent streaming, no providers/conformance yet).


### v1 SandboxConfig.setup (post-create bootstrap) dropped with no v2 equivalent
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap.** v1 SandboxConfig exposed `setup?:(sandbox)=>Promise<void>` (per-sandbox workspace bootstrap — install deps, seed files, warm caches after create) and `persist?:boolean`. v2 SandboxProps (component.tsx:29-44) and SandboxCreateOptions (sandbox.ts:79-90) have neither. `withSandbox({initialize})` is an install-time app-scoped hook with the BRIDGE, not a per-sandbox post-create setup with the handle. (v1 env thunks are intentionally resolved to strings — present-ok.)

**v1 ref.** packages/sandbox/src/types.ts:83-92.
**v2 location.** sandbox-next/src/react/component.tsx:29; spec/src/data/sandbox.ts:79.

**Recommendation.** Add optional `setup?:(handle:SandboxHandle)=>Promise<void>` to SandboxProps running after createHarness resolves, or document the omission. Fold `persist` into the hibernate/SandboxIntent work.


### sandbox-lambda-next — AWS Lambda (Firecracker microVM) provider sketch (post-cut)
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Net-new; FEASIBILITY MODERATE with one hard impedance mismatch.** v2 SandboxHandle is STATEFUL/long-lived (workspacePath persists; exec/read/write mutate the same FS across the sandbox lifetime); AWS Lambda is STATELESS per-invoke (fresh env, /tmp ephemeral, 15-min ceiling, warm reuse never guaranteed). Lambda hides the microVM lifecycle — you cannot hold one microVM open as a persistent shell, so 'one microVM = one sandbox' is unreachable via Lambda (that model wants Fly Machines / e2b / Modal / firecracker-containerd).

**Reconciliation if pursued.** Persistent workspacePath → EFS access point per sandboxId; each exec/read/write/destroy → a Lambda Invoke of a deployed generic runtime against mounted EFS (chatty + cold-start tax); mounts EFS-only (fileSystem:'host' unsupported); network → VPC SG/NACL + egress proxy only (weak NetworkRule[] parity — matches the local firewall gap); streaming → Lambda response streaming NDJSON, but only after the exec-delta wiring lands; credentials → first consumer of ADR 24 SandboxCredentialStorage. restore() is EASIER than local (EFS durable → re-derive handle at the access point).

**Recommendation.** Post-cut unless a cloud persona needs it. Steel-man against Fly/e2b/Modal which fit the persistent-microVM model far better; Lambda-EFS is defensible only for burst/parallel isolated exec inside an existing AWS footprint.


### Provider-adapter matrix drop: apple + bedrock have no v2 home and sit as unresolved STATUS decisions
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap (drift-to-drop, no recorded decision).** v1 packages/adapters is SEVEN provider sub-packages; v2 ported only 4 (openai/anthropic/google/ai-sdk). MISSING: @agentick/bedrock (907 LOC, AWS Bedrock — enterprise), @agentick/apple (749 LOC, Apple Foundation Models on-device via macOS 26+ — a differentiated capability with NO AI-SDK substitute). (huggingface = local embeddings → track under #153.) V1-PARITY-TRACKER.md scopes itself to openai/anthropic/google/ai-sdk ONLY, so the 'adapters covered' claim is false for these. STATUS.md:1530-1533 lists them as `(??)` undecided since 2026-05-08, never resolved; zero mention in CUT-PLAN C/D; zero GH issues.

**v1 ref.** packages/adapters/{apple,bedrock}/src.
**v2 location.** model-* (only 4 ported).

**Recommendation.** Resolve STATUS pending-decision #2 in CUT-PLAN. bedrock chat is plausibly reachable via aisdk(bedrock(...)) — record that migration if so. apple (on-device) has NO AI-SDK path — make an explicit keep/defer/drop call. Do not let real adapters leave the tracker silently.


### guardrails subsystem has no v2 home and no keep/drop decision
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap (drift-to-drop).** v1 @agentick/guardrails ships `toolGuardrail({rules:[deny(...),allow(...)],classify})` middleware — static-rule + LLM-classifier tool-execution gating throwing GuardrailDenied. No packages-next/guardrails exists. gates-next is unrelated (knob-backed continuation conditions). Zero GH issues. CUT-PLAN mentions it once (~line 367), lumped into C7 'CLI, guardrails, secrets ... defer or drop' with no decision. The mechanism (tool-executor-next `use(middleware)` inherited from BaseHarness) exists, but there is no bundled deny/allow/classify surface.

**v1 ref.** packages/guardrails/src/tool.ts.
**v2 location.** tool-executor-next (middleware seam exists) — no guardrails package.

**Recommendation.** Explicit decision, not drift-to-drop: either (a) file to ship a bundled guardrail middleware helper over tool-executor's use() seam, or (b) formally record 'dropped; adopters hand-roll via tool-executor middleware' in CUT-PLAN C7 with a migration one-liner.


### v1 @agentick/agent opinionated composition (Agent + createAgent + token-budget presets) dropped
**Workstream:** D-metapackage · **cut-blocking:** False _(net-new)_

**Gap.** v1 @agentick/agent exports `Agent` (AgentTokenBudgetConfig/AgentTimelineConfig/AgentSectionConfig) + createAgent/agentComponent — an opinionated composition layer over primitives. v2 has NO equivalent: grep for createAgent/agentComponent returns nothing; v2 example agents (v2-otto, v2-real) each HAND-ROLL their own `function Agent()`. app-next provides only createApp (the app boundary), not agent-composition presets. STATUS pending-decision #4 (agent vs agentick metapackage) still open and off CUT-PLAN.

**v1 ref.** packages/agent/src/{agent.tsx,create-agent.ts}.
**v2 location.** none.

**Recommendation.** Either fold the opinionated Agent/token-budget presets into the D1 metapackage ergonomics pass, or formally record 'dropped; adopters compose primitives directly (see D2 personas)'. Currently an unresolved STATUS decision that fell off CUT-PLAN.


### Wire-client backlog untracked: TUI, CLI, client-multiplexer have no v2 issues
**Workstream:** C-parity · **cut-blocking:** False _(net-new)_

**Gap (three off-radar clients).** (1) @agentick/tui (Ink) — no packages-next/tui, no issue; CUT-PLAN C7 defers with sound rationale ('defer until client surface stabilizes post-B3'). (2) @agentick/cli — no packages-next/cli; C7 lumps it into 'defer or drop ... decide at cut time'. (3) @agentick/client-multiplexer (multi-tab shared SSE via createSharedTransport) — no v2 equivalent (client-extensions-next has retry/telemetry/cache/offline but no SharedWorker/BroadcastChannel), no issue, no CUT-PLAN entry. All three appear in STATUS pending-decision #3.

**v1 ref.** packages/{tui,cli,client-multiplexer}.
**v2 location.** none (client-extensions-next is the candidate home for the multiplexer).

**Recommendation.** File one parked/backlog issue covering all three as post-B3 clients so board readers see they exist. None cut-blocking. Deferral is acceptable; being issue-less is not.


### secrets→credentials subsumption asserted but unverified for general (non-auth) secret storage
**Workstream:** A-durability · **cut-blocking:** False _(net-new)_

**Gap.** CUT-PLAN C7 states 'secrets (subsumed by credentials)'. v1 @agentick/secrets is general-purpose platform-native secret storage, whereas credentials-next is oriented to MCP/OAuth token material ('credentials never cross the wire'). The subsumption claim is not backed by verification that credentials covers arbitrary agent secret K/V, not just auth tokens.

**v1 ref.** packages/secrets.
**v2 location.** credentials-next.

**Recommendation.** One-paragraph verification in CUT-PLAN or the credentials README: confirm the credentials store port covers general secret K/V, or note arbitrary secrets are an adopter concern over the state KV store port (ADR 49 A3). Cheap to close.


### No v2 reference example for artifacts/memory user-space patterns
**Workstream:** D-metapackage · **cut-blocking:** False _(net-new)_

**Gap (docs/example, not framework).** CLAUDE.md declares memory/artifacts/todos are user-built patterns over primitives (no package expected), but the only concrete demonstration (todo-list.tool.tsx) lives in example/express (v1-era). The v2 personas (v2-otto/v2-real) are the intended home yet no artifacts/memory pattern example was found — so the 'patterns are built from primitives' claim has no v2 exemplar.

**v1 ref.** example/express/src/tools/todo-list.tool.tsx.
**v2 location.** example/v2-otto, example/v2-real (candidate).

**Recommendation.** Ensure the D2 reference personas port at least one stateful-collection pattern (todos or artifacts).


## Coverage notes / not-audited

DEDUP APPLIED: (1) whole-subsystem 'structured-output silent-drop (C8)' merged with adapter 'responseFormat not normative (#184)' → single proposed issue (reopen #184, adjacent #160); ResponseFormat.name drop folded in. (2) whole-subsystem 'content-block-type parity' verified present-ok (v1 union + content.tsx JSX map cleanly to v2 spec union incl. reasoning; formatters handle media) — NO merge/action; provider-specific block gaps (Anthropic document) already tracked as V1-PARITY-TRACKER G-items. (3) embeddings (whole-subsystem) + huggingface adapter + adapter 'modalities' all fold into #153. (4) TUI+CLI+client-multiplexer merged into one wire-client backlog issue.\n\nCONNECTOR #154 SUB-MECHANISMS: MessageSource registry, confirmation-via-ElicitationHarness, and GatewayExtension inbound verb are newly-found in this audit and were NOT in the prior connector report — I could not read #154's issue body, so VERIFY these are enumerated in #154 or they will drift-to-drop. Connector delivery-strategy / content-summarization / rate-limit / retry homes (v1 ConnectorSession bundled four client-side behaviors) are load-bearing for the Persona-1 iMessage default config (contentPolicy:'summarized' + deliveryStrategy:'on-idle') and remain undecided under #154 — the ADR must place each (delivery→bus cadence; content→formatters-next; rate/retry→gateway-extension procedure middleware). CORRECTION carried forward: do NOT plan to rebuild ConnectorSession on client-next MessageLog/ToolConfirmations 'equivalents' — those primitives do NOT exist in v2 (client-next is a low-level RPC client; client-extensions-next is cache/offline/retry/telemetry). Prefer the server-side gateway-extension path.\n\nNOT AUDITED (need follow-up sweeps): channels/pubsub internals, MCP verb matrix (#147/#148), cluster wires, tasks enumerate — all accepted from the prior whole-subsystem report, not re-grepped. Runtime not executed by the adapter auditor; issue-state cross-refs were taken from prior reports, NOT re-run via gh — VERIFY #184 and #185 are actually CLOSED and that #176 is still open/PARTIAL before acting. Whole Workstream-A durability surface (timeline/state/knobs/gates snapshot-restore, ADR 49) was only touched tangentially (sandbox hibernate, secrets K/V) — no dedicated durability audit here. Known open issues NOT surfaced by any of the four dimensions and therefore un-swept in this pass: #145 DispatchPolicy, #147 MCP slices, #148 MCP pool, #155 channels, #156 express, #158 devtools, #159 scheduler, #160 terminal tools (only touched via responseFormat adjacency), #172 executor fold, #174 customBlocks, #177 tool harness parity, #179 tool-call repair — each needs its own gap sweep before the cut. Sandbox hibernate/restore is ADR 24 flow-c and deserves a dedicated durability-path audit.


## Decisions needed from Ryan (drift-to-drop — explicit call required, do NOT silently omit)

- **apple + bedrock model adapters** — keep / defer / drop for v2.0
- **guardrails subsystem** — keep / defer / drop
- **@agentick/agent opinionated composition** — keep as own package / fold into #161 metapackage / drop
