# ADR 92 — The operation-grammar completion

**Status:** DRAFT (pending Ryan ratification)
**Closes:** the gap family opened by ADR 90 ("wire extensions are
commands") — every qualifying crossing joins the same grammar
**Siblings:** ADR 91 (the ctx spine — contexts are one reality; this
ADR makes crossings one grammar; each completes the other)
**Grounded in:** the 2026-07-26 op-grammar crossing audit (full sweep
table in the audit report; summarized below)

## The law

> An **operation** is a named (`<surface>:command:<verb>`), journaled,
> interceptable, guardable, span-parented unit of work run via
> `runOperation`. A crossing MUST be an operation iff an adopter could
> ever want to hook it, guard it, or find it in the audit trail —
> external ingress and state-mutating verbs qualify.
>
> Correctly NOT operations: store data methods (data-plane; they carry
> `StoreCtx` from the enclosing op), event/signal emissions (what ops
> emit, not work units), and pure computation inside an enclosing op
> (a compile pass inherits the tick's envelope).

The 2026-07-26 audit found the grammar holds across the core — timeline,
skills, prompts, resources, knobs, state, gates, sandbox, model/loop
executors, elicitation, tool dispatch, the MCP client, gateway wire +
lifecycle are all ops — and identified seven defectors in three
families, plus one visibility note.

## The gaps and their treatment

### Family 1 — ingress (Slice A: mechanical, highest value)

1. **MCP server request crossings** (`tools/call`, `resources/read`,
   `prompts/get`, `completion/complete`, `initialize`) — SDK
   `setRequestHandler` callbacks invoke handlers directly; no journal,
   no hook, no guard, root spans. **Fix:** wrap each handler body in
   `runOperation` under `mcp:command:<verb>` (kebab per the command
   naming law: `call-tool`, `read-resource`, `get-prompt`, `complete`,
   `initialize`). The 5-stage security pipeline
   (ConnectionGuard/Authenticator/Authorizer/RateLimiter/InputSanitizer)
   maps onto the **guard seam** of those ops — the staged
   `auth: {...}` API stays as sugar over guard registration, not a
   parallel mechanism. Ctx simplification falls out: an op-wrapped
   request establishes the fiber context, so the MCP off-fiber
   `deriveContext(parent, …)` fabrication path collapses toward the
   ambient overload (finishing what ADR 91 started).
   **Parent-child composition (Ryan probe, 2026-07-26):** today the
   inner work inherits ops only ACCIDENTALLY and config-dependently —
   a live-harness slot (`resources: ResourcesHarness`) journals an
   ORPHANED-ROOT `resources:command:read` with no connection identity
   or parentage, while a declarations slot (`CreatedTool[]` /
   `PromptDeclaration[]`) journals nothing at all, so the ADR 42
   dichotomy sugar silently changes audit semantics. The crossing op
   fixes this by PARENTING, not duplication: `mcp:command:<verb>` is
   the parent; inner harness commands and handler `ctx.run` ops become
   properly scoped children (connection → crossing → inner command);
   the declarations form journals because the crossing itself is the
   op. The slice must assert this chain (child op scope carries the
   crossing's opId as parentOpId + the mcp connection dim).
   **Ratified (Ryan, 2026-07-26): layered execution = layered journal
   records, deliberately.** A crossing that traverses N real layers
   (mcp crossing → tool dispatch → handler sub-ops) produces N linked
   records; per-op-class journal policy trims chatty CLASSES, never
   collapses real layers. Open consideration for Slice A (not
   required): the MCP server's tool invocation currently bypasses the
   tool-executor (`resolveFromCreatedTools` is MCP-local resolution) —
   delegating to the ToolExecutor dispatch op would unify dispatch
   machinery (confirmation gates, timeouts, aliases, client-tool
   handling for free) AND yield the two-record layering naturally.
   Evaluate under the three-consumers rule during Slice A; do not
   force artificial layers where no real layer executes.
2. **Subscription dispatch** — a cron/scheduler fire or external driver
   invokes the subscription handler as a bare callback
   (`subscriptions/src/bridge.ts:121`). Time-triggered ingress with no
   veto seam and no audit record. **Fix:**
   `subscriptions:command:dispatch` op around the handler invocation
   (already async; no blocker).
3. **Admission-failure visibility** — `authSource.authenticate` is
   correctly pre-op (it establishes the identity later stamped on every
   wire-op scope), but a rejected ingress (401) leaves no trace.
   **Fix:** an admission-failure bus **event** (not an op — admission
   denied means no work unit exists) carrying the connection info +
   failure class, so the audit trail sees attack attempts. Applies to
   both the gateway ingress and the MCP 401 pre-gate.

### Family 2 — lifecycle & security mutations (Slice B: mechanical, few naming calls)

4. **Session spawn / fork** — `createChildSession` bypasses the create
   op (`app/src/harness.ts:2259`). The `onSessionCreate` hook DOES fire
   for spawns (ADR 48), so adopters are not blind — what's missing is
   the envelope: guards, journal lineage, span parenting. **Fix:** run
   `createChildSession` under `app:command:create-child-session`
   (wrapping `createSessionBody`; the wire/host `create-session` op
   stays as-is).
5. **Session close + idle eviction** — plain teardown while
   `App.closeApp` / `Gateway.close` are ops (asymmetry). **Fix:**
   `session:command:close` marked bus-only (the journaling-policy
   override already anticipates the name); the eviction sweep's
   `disposeSession` routes through it.
6. **Live media in-process `stop`/`close`** — wire ingress is covered;
   direct calls are not. **Fix:** op-wrap (async, no blocker). `start`
   belongs to Family 3.
7. **Credentials `set`/`delete`** — security state-mutations as plain
   CRUD while sibling `state:set` is an op — the sharpest
   inconsistency in the audit. **Fix:** promote to
   `credentials:command:{set,delete}`. Reads stay data-plane.
   Journaling policy: bus-only or redacted-params — **credential
   material never enters the journal** (the credentials-never-cross-
   the-wire law extends to the audit trail: journal the fact and the
   key, never the secret).

### Family 3 — the sync-return seam (design note, NOT sliced yet)

**Tasks `submit`/`applyTransition`** and **live `start`** return sync
handles; a sync return cannot host the async interceptor fold (the
blocker is documented at `tasks/src/harness.ts:388`). Two candidate
shapes, decision deferred to its own pass:

- (a) async-ify the verbs (`submit(): Promise<TaskHandle>`) — honest,
  breaking, aligns with the grammar; or
- (b) a sync-hook fast-path in the runtime lift — ops whose
  interceptor chain is provably sync run synchronously; async
  interceptors on such ops become a registration-time error.

Lean: (a) for `submit` (creation is ingress-like; callers already live
in async contexts), with (b) rejected unless a second strong consumer
appears — a dual sync/async op path is a Frankenstein seed. Not
ratified here; steel-man both when picked up.

## Journaling policy is orthogonal to the envelope

Chatty crossings (`resources/read` under a polling client) are an
argument about what the journal RETAINS, not whether the op exists.
Every crossing in this ADR gets the envelope (name, guards, hooks,
span); per-op-class journal policy (persist / bus-only / redact) is the
existing substrate knob and is set per crossing in the slices
(defaults: MCP reads bus-only, MCP `call-tool` persisted, subscription
dispatch persisted, session close bus-only, credentials redacted).

## Non-goals

- Store data methods, events, in-op computation stay non-ops (the law's
  exclusion list).
- Pre-op admission stays pre-op — authentication does not become an
  operation; only its failure becomes visible (event).
- No change to ADR 90's wire dispatch or to any surface the audit
  classified OP.
- Cluster gossip/heartbeat timers stay infra (not adopter crossings).

## Sequencing & verification

After ADR 91 Phase 2 lands (same files in flight). Slice A → Slice B →
Family 3 design pass. Per slice: full workspace suite green; new
conformance per promoted crossing (op observed on the bus with correct
name + scope; guard veto actually blocks; journal policy honored —
including a credentials-redaction assertion); the MCP slice re-runs the
Ernesto shadow-run gate downstream (the op envelope must be invisible
to MCP clients — wire behavior byte-identical).
