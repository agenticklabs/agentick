# The Knowify pivot — Ernesto + assistant-api + k-assistant-v2 on agentick v2

> B3, the build pivot. Grounded in the 2026-07-23 six-agent survey of
> `nx-knowify` (assistant-api ~90k LOC, libs/ernesto ~8k, libs/mcp ~6k,
> frontend k-assistant-v2 + libs/ui chat kit). This doc is the approach;
> slice specs derive from it.

## 0. The reframe

This is **not** brownfield integration — it is an **agentick v1 → v2 upgrade**
of an existing, production-shaped agentick deployment. The strangler fig
already happened on their side: the legacy in-house engine (`src/assistant/`,
47k LOC) was already strangled by a quarantined agentick module (`src/v2/`,
~6k LOC of host wiring), `libs/ernesto` is already a pure-DI agentick JSX
agent, `libs/mcp` is already an `@agentick/mcp` server library, and the
frontend's v1-client coupling is already concentrated in one service.
Nothing needs to prove agentick can live inside Knowify. What v2 must prove
is that **the upgrade retires hand-rolled host wiring into designed seams.**

## 1. The five server seams (hand-rolled v1 → designed v2)

| Their v1 host wiring                                                                | agentick v2 replacement                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monkey-patched `gateway.handleRequest(req,res)` + Nest middleware forwarding `v2/*` | `fetchServerTransport({ identity })` — registered in `createGateway({ transports })`, lifecycle-correct (C4.5)                                                                                                                                                                                                                                             |
| `plugins/auth.ts` (531 lines: kAuth HS256 + OAuth JWKS → `UserContext`, caching)    | The `identity` callback: their verification returns `{ principal, user, scopes }` or their own `Response`; token material never crosses. Their `?token=` SSE quirk lives in their callback — policy on their side, as designed                                                                                                                             |
| `v1-session-store.ts` (1,076 lines of session-event → TypeORM row mapping)          | Store-seam adapters (`TimelineStore` / `SessionStore` / `TaskStore` over the SAME legacy tables) + conformance suites as the correctness gate. Their schema is friendly: UUIDv7 PKs (time-sortable → seq/cursor), blocks table ≈ `ContentBlock` 1:1, and their own `ThreadRepository.getThreadInfo` comment says it is "shaped for the agentick v2 bridge" |
| `tracking/` (custom provider + `Agentick.use("*")` middleware + shapers)            | The span ladder: `telemetry: true`, `spanMiddleware`, `telemetryNamespace` (nothing says "agentick" in their track-API)                                                                                                                                                                                                                                    |
| Scope derivation (`tenant-admin`, `advisor`, …) enforced ad hoc                     | Scopes flow into the v2 authorizer; `authorizeDispatch` is the one choke point                                                                                                                                                                                                                                                                             |

## 2. The client swap surface (measured, not guessed)

All v1 client coupling lives in `AssistantSessionService` (1,009 lines) plus
two slivers (`McpAppBridgeService`, the confirmation flow). Consumed v1 API:
`provideAgentick`, `AgentickService.session()/send()/channel()`, and on
`SessionAccessor`: `subscribe / unsubscribe / onEvent / onToolConfirmation /
send / abort`. `ChannelAccessor.subscribe/publish` for the MCP-app iframe
relay. **Unconsumed:** interrupt, close, submitToolResult, onResult,
dispatch, invoke, stream, channel.request.

v2 mapping:

- The 1,009-line hand-rolled event reducer is **exactly what v2 handles
  absorb**: `session.timeline` (entries + `loadOlder()` — which also
  dissolves their dual history representation: REST `Interaction[]` mapper
  vs live event accumulation), `session.tasks`, item-handle verbs.
- `onToolConfirmation(request, respond)` **is** the elicitations item-handle
  design: `session.elicitations.list()[0].accept()`.
- The MCP-app channel relay maps to wire subscriptions + wire commands.
- `@knowify/ui` chat kit (~35 components) is purely presentational
  (`ChatMessageData` / `ToolCallDisplay` plain shapes) — survives untouched.
- Binding: Angular (v19 signals, AngularJS-hybrid, DI-shaped). Needs
  `@agentick/client-angular-next` — thin (`subscribe`→signal effect +
  `provideAgentick`-style factory), the Angular twin of client-react.

## 3. The three decisions (Ryan's call)

- **D1 — the CJS/ESM dodge. RESOLVED 2026-07-23 (verified on `assistant-latest`).**
  The "migrate to esm" branch (`fafc33b8`, effectively landed on
  `assistant-latest` via the `assistant` merge + a residual 2-file
  cherry-pick `b6360836`) does NOT flip to `type: module` — it stays CJS and
  relies on **Node ≥22.12 unflagged `require(ESM)`**. The dodge is deleted;
  `gateway.ts`/`module.ts` use static top-level `@agentick/*` imports — the
  typed boundary (IntelliSense, typo=compile-error) is restored. **Verified
  empirically on Ryan's machine (Node 24):** `require()` of
  `@agentick/gateway`, `@agentick/core`, `@knowify/ernesto`, `@knowify/mcp`
  all succeed (no top-level await in the v1 graph), and
  `tsc -p tsconfig.app.json --noEmit` yields **3 errors, all one root
  cause** — duplicate pnpm-hashed `typeorm@0.3.30` instances (peer-set
  divergence; nine typeorm instances across 0.2.45/0.3.30/0.3.31 exist in the
  lockfile) making `DataSource` nominally incompatible at 3 call sites.
  Fix is lockfile hygiene (`pnpm dedupe` — dry-run shows changes available —
  or a typeorm override pinning one instance), NOT ESM work.
  **Follow-ups:** (1) tighten `engines` from `>=22.0.0` to `>=22.12` —
  22.0–22.11 gate `require(ESM)` behind a flag; audit prod images. (2)
  **agentick v2 obligation:** the strategy only survives the v2 port if
  packages-next dist stays top-level-await-free — add a "no TLA in published
  dist" invariant gate to v2 CI (friction-log item, real enabler).
- **D2 — persistence.** Keep writing the v1 tables via store adapters
  (legacy UI, execution-graph controller, feedback keep working; conformance
  suites verify the adapter). Revisit ownership post-pivot. **Recommendation:
  yes for the pivot.**
- **D3 — event-vocabulary strategy.** Rewrite the client reducer onto v2
  handles (recommended — the reducer is the thing the handle contract
  obsoletes) vs. shim v1 `StreamEvent` names onto v2 events (rejected: keeps
  the reducer alive to preserve its own food supply).

## 4. Slices

- **Slice 0 — gap audit (~a day, gates everything).** Two checklists against
  v2's actual exports:
  - _Server (from libs/ernesto):_ `<Timeline>` render-prop + sliding-window,
    `<MCP>` in-process pair, `<Sandbox>` + file tools, `ctx.spawn`,
    `useData`, `useTickState`, `useComState`, `useContextInfo`,
    `useOnTickStart`, `createTool`, custom `<done/>` blocks, `UserContext`
    augmentation.
  - _Wire/client:_ streaming event parity for the reducer-replacement,
    `onToolConfirmation` ≙ elicitations, channel pub/sub ≙ wire
    subscriptions + commands, `openaiCompatPlugin` parity (they alias
    `ernesto` as an OpenAI-compatible endpoint), MCP **server** mounting over
    the gateway (`/mcp` + OAuth metadata) against mcp-next.
    Every miss becomes a named v2 issue before any porting starts.
- **Slice 1 — the thin vertical.** Minimal Ernesto on v2 at `/api/v3` via
  `fetchServerTransport`, identity callback wrapping their existing kAuth
  verification, in-memory stores, two real MCP tools (`query`,
  `list_items_create`), frontend panel on `client-angular` handles beside the
  existing one. Flagged, deletable. Legacy `/api/v2` (agentick v1) keeps
  serving.
- **Slice 2 — persistence adapters** over the v1 tables + conformance runs;
  history unification (timeline `loadOlder` replaces `InteractionMapper`).
- **Slice 3 — full Ernesto port** (identity JSX, RAG orchestrator,
  compaction, sandbox + TigerFS mounts, spawn) per the slice-0 checklist.
- **Slice 4 — client completion**: reducer retired, MCP-app relay on wire
  subs, `k-assistant-v2` fully on v2; delete the v1 path when parity holds.
- **Slice 5 (later) — voice/live** on ADR 88's media plane (their pipeline is
  client-VAD → 16kHz PCM binary frames + segment events; no WebRTC today).

## 5. The baggage firewall

One dependency rule: **knowify code may depend on agentick v2; agentick v2
never grows a knowify-shaped feature.** Integration pain goes to the friction
log and gets fixed in the framework; adapters live in their repo. Their
self-identified dead weight does NOT cross the line: `k-assistant-v2-old`
(1,265 dead lines), the native-WS binary protocol pair, `ask_knowify`
vestiges, the third "v2" naming collision, three parallel legacy LLM stacks.
Independent of the pivot, their repo has undeclared deps to fix now
(`libs/ernesto` imports `@agentick/mcp`, `@agentick/agent`, `@knowify/mcp`
transitively).

## 6. What v2 gets out of this

The friction log IS the deliverable: an Angular binding driven by a real
consumer, the ESM/CJS posture decision, OpenAI-compat + MCP-server-mount
parity checks, streaming-event vocabulary validation, and the first
external-schema store adapters run against the conformance suites. Every gap
found here is a gap Ernesto found before any other adopter could.
