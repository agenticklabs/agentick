# Agentick v2.0 — Aggressive Cut Roadmap

**Goal:** ship v2.0 soon. Parallel delegate-and-judge tracks; personas as gap-finders;
metapackages last. Every item is a GitHub issue on **project 2** (`agentick v2.0 cut`),
tagged by `Workstream`. Group the board by Workstream to see this live; filter
`Gate = ryan-review` for the decision queue.

**Framing decisions locked (this session):**

- **Agnosticism is fulfilled by per-framework compiler front-ends over the neutral IR**
  (React JSX→IR = the "react story"; Angular component→IR = the angular story). The
  dep-less/functional compiler is therefore **optional** (a zero-dep convenience), **NOT a
  cut-blocker** — it drops out of the critical path.
- **Connectors = the ingress edge**: an external source bound to a session action,
  reply-optional (ADR 58). Scheduler decomposes into a cron-connector + a durable job store
  (no scheduler subsystem).
- **Metapackages are LAST and there are exactly two:** `agentick` (base bundle) +
  `agentick-react` (React bundle).

## Phase 0 — unblock + quick parity wins (now)

Run in parallel; mostly delegated small fixes.

- **Ryan rules the 3 `ryan-review` decisions** — #227 (bedrock **keep** / apple
  **explore-spike**), #228 (guardrails → **drop to documented pattern**), #229
  (`@agentick/agent` → **fold into metapackage #161**). Unblocks D/E cleanup.
- **Adapter-parity batch** (one delegate, judged): **#214 first** (OpenAI ignores
  `target.modelId` — silently breaks the ADR-56 per-tick `<Model>`; regression), then #212
  (Google CacheHint), #173 (providerMetadata at projection), #216 (Anthropic stop-reasons),
  #211 (topP/penalties), #217 (reasoningTokens), #213 (AI-SDK reasoning), #184 (responseFormat
  all adapters — Knowify need), #175 (tokenEstimator). Small, unblocked, correctness.

## Phase 1 — cut-blocker subsystems (parallel tracks)

- **Track — Sandbox** (Persona-1 needs a runnable sandbox): #157 (provider interface +
  docker/local) → #218 (conformance suite/double), #219 (exec streaming), #221 (handle),
  #222 (EditFile modes), #223 (hibernate/restore), #220 (diff-preview UX), #224 (README),
  #225 (SandboxConfig.setup). #226 (Lambda microVM) post-cut.
- **Track — Auth ingress** (#146/#302 `interceptIngress`): unblocks connector per-message
  actors AND is CUT-PLAN B2. Also #145 (DispatchPolicy / slice 6 — the model-as-untrusted
  subject) if it fits.
- **Track — Ready-made connectors + MCP** (bundle real connectors with the framework):
  #233 (telegram), #234 (imessage), plus **#237 (MCP server resource projection — never
  fulfilled)** + #147 (MCP remaining slices) + #148 (MCP pool).
- **Track — remaining parity**: #172 (executor fold), #177/#179 (tool harness + repair),
  #174 (customBlocks), #155 (channels), #156 (express), #158 (devtools), #160 (terminal
  tools), #230 (wire clients: TUI/CLI/multiplexer), #173, #178 (loop-ai-sdk note).
- **Durability (A)**: #132 (TimelineStore fs/postgres adapters), #134/#135/#136
  (hydration / KV / tasks), #139 (kill-resume tests). Needed for the cloud persona.

## Phase 2 — personas as gap-finders

- #162 (local / openclaw-style: gateway + fs timeline store + sandbox + skills) and #163
  (cloud / ernesto-shaped: gateway + auth adapter + durable stores). Building these surfaces
  the _real_ remaining gaps better than more audits — fix what they find.

## Phase 3 — metapackages + cut gates (LAST)

- **#161 → the two metapackages:** `agentick` (bundles the built-ins + core) and
  `agentick-react` (the React reconciler surface). Fold `@agentick/agent` composition
  (#229) into `agentick`. Nothing else.
- **Mechanical sweeps (#167):** reconciler→**compiler** rename (#243), `XHarness`→`X`
  rename. **#164** (migration cut gate), **#166** (README sweep), **#165** (Effect charter).
- **Cut v2.0.**

## Off the critical path (design spikes — parallel, non-blocking)

- Scheduler decomposition (rescope #159: cron-connector + durable job store).
- Functional/dep-less compiler ADR — **optional** per the agnosticism framing; only if it
  earns its keep.
- Apple on-device Foundation Models adapter spike (#227 apple half).

## The aggression

Phases 0 and 1 overlap heavily — the parity batch, sandbox, auth-ingress, and connector
tracks run concurrently as delegated-and-judged workstreams. The only hard ordering:
metapackages + cut gates are genuinely last (they bundle + rename what everything else
produces). Personas run as soon as their dependencies (sandbox, stores, auth) are green and
feed fixes back into Phase 1.

## Strategic update 2026-07-07 — prod runtime = Lambda microVM; the cut is PROD-readiness

**Lambda microVM (#226) is reprioritized: post-cut sketch → CUT-CRITICAL prod runtime.**
Ryan: "we'll likely mostly use Lambda microVMs in prod; local + docker in testing/staging."
That makes the sandbox tiers an **isolation + environment hierarchy**, and it moves the
center of gravity of the cut from "does it work locally" to "does it run in prod."

### Sandbox provider hierarchy (isolation strength ↑ = environment)

| Provider                  | Env            | Isolation                                                          | Shape                                       |
| ------------------------- | -------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| `sandbox-local-next`      | local dev      | seatbelt / bwrap / unshare + cgroup (#240) — _weakest_; dev-safety | same-host, in-process handle                |
| `sandbox-docker-next`     | test / staging | container (`NetworkMode`, cgroups) — _medium_                      | same-host, in-process handle                |
| **`sandbox-lambda-next`** | **prod**       | **Firecracker microVM — _strongest_, the microVM IS the jail**     | **REMOTE** (invoke boundary), **ephemeral** |

Consequences that reshape earlier decisions:

- **Prod isolation = Lambda's Firecracker microVM**, so local's OS-jail (#240) is _dev-safety_,
  not the prod security story — it drops in urgency (still do it, but it's not cut-gating).
- Lambda is a **REMOTE, ephemeral** provider: handle ops cross the invoke boundary (RPC-shaped —
  the async `SandboxHandle` contract already supports it); no persistent fs (EFS mount = the
  capability-tier for mounts); egress control = VPC/security-group, not a 127.0.0.1 proxy (the
  network capability-tier); **hibernate = recreate** (this is the "remote provider" that the
  #223 deferral was waiting for — confirms deferring true checkpoint was right).
- The **contract we're repackaging must hold for a remote provider** — it does (async handle,
  capability-tiers, `SandboxUnsupportedError`). The conformance suite is the guardrail.

### The critical path to a PROD-ready cut (reordered)

1. **Sandbox foundation:** repackaging (in flight) → **`sandbox-lambda-next` (prod)** + `sandbox-docker-next` (test/staging), in parallel → `#240` local isolation (dev-safety, non-gating).
2. **Auth ingress (#302):** prod needs real principal→actor; also unblocks connector actors.
3. **Durable stores (#132 fs/postgres TimelineStore + KV):** the cloud persona needs them.
4. **Cloud persona #163 (ernesto) = THE PROD-READINESS GATE** — proves Lambda sandbox + auth +
   durable stores + gateway work end-to-end. If ernesto runs, we can cut. This is the truth test.
5. MCP resources (#237), connector ports (#233/#234) — as prod needs them.
6. Metapackages (#161) + cut gates (#167/#164) — last.

### Can't-ship-crap guardrails (non-negotiable through all of it)

Every provider passes `runSandboxProviderConformance` against the REAL backend (no fakes — the
stat/readdir lesson). The cloud persona is the integration truth, not a demo. Adversarial judge
on every delegation. Fresh `pnpm -w typecheck` gate (the vitest-strips-types false-green trap).
Mirror the nearest subsystem's packaging (the sandbox-drift lesson). No silent downgrades of v1
capability.

**Lambda is a net-new REMOTE provider (bigger than the docker port)** — it earns a survey → ADR
before delegation, same as connectors/sandbox. Docker is a more mechanical v1 port.
