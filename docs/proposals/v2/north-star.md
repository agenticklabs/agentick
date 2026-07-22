# North Star — the user's code (DRAFT for Ryan)

**Status:** DRAFT 2026-07-22 · Code-first; prose only where a decision needs words.
`✓` works today · `○` = B2 target. This page is the acceptance criterion: every B2
slice must move a `○` to `✓` without making any line here worse.

## The five principles (every line below is held to these)

1. Operator-safe by default; app policy opt-in.
2. User-facing keys readable without docs.
3. Interceptors transform the truth; projections transform a view.
4. Iterate bounded things; observe unbounded things.
5. Contracts are floors, not ceilings — we take what we need; you can give more.

## 1. The client, headless (the real north star)

```ts
const client = createClient({ url: "http://127.0.0.1:4783" });   // ✓
const session = client.session("sess_123");                       // ✓

// ── every handle, one contract: list / get / subscribe / verbs ──
session.timeline.list();                       // ○ (free factory today)
session.knobs.list();                          // ○ descriptors, not bare values
session.elicitations.list();                   // ○ pending asks — state, not events
session.tasks.list();                          // ~✓ closest today

session.timeline.subscribe(render);            // ○ (subscribe, cb no-args, read via list)

// ── your systems compose in ──
session.timeline.seed(await fetch("/my/api/history").then(r => r.json()));  // ✓ initial
session.timeline.prepend(olderPage);           // ✓
session.timeline.append(optimistic);           // ✓  (clientId reconciliation is yours)
session.timeline.clear();                      // ○
session.timeline.subscribe(() =>               // ✓ posture B: feed YOUR store
  myStore.ingest(session.timeline.list().map(toMyMessage)));

// ── asks ──
session.elicitations.subscribe(() => {
  for (const e of session.elicitations.list()) showDialog(e);     // ○
});
// dialog button:
await e.accept({ approved: true });            // ✓ (e.decline, e.cancel)

// ── client tools ──
await session.clientToolCalls.set([myToolDecl]);                  // ✓ (as setClientTools)
session.clientToolCalls.route({ open_file: async ({path}) => read(path) });  // ○ (loose fn today)
session.clientToolCalls.confirm("prompt");                        // ○ (loose fn today)

// ── knobs ──
await session.knobs.set("depth", 5);           // ✓ (key→id rename pending ○)

// ── the run: the ONE bounded stream, so the ONE for-await ──
const run = session.send("do the thing", {
  delivery: "steer",                            // ✓  ("followUp" | default)
  telemetry: { functionId: "checkout" },        // ✓
});
for await (const ev of run.events()) paint(ev); // ✓ a run ENDS — iteration is honest
await run.result;                               // ✓

// ── one hook seam (client twin of the server's) ──
client.use(async (params, next, ctx) => next(params));   // ○
const stop = session.knobs.use(audit); stop();            // ○

// ── your own wire methods, same mechanism as ours ──
declare module "@agentick/spec-next" {
  interface WireMethods { "billing/approve": { params: {orderId: string}; result: {ok: boolean} } }
}                                                          // ✓ mechanism
await session.billing.approve({ orderId });               // ✓ via ADR-87 registration
```

## 2. React (an appendix — each is ONE line over the contract)

```tsx
const entries = useTimeline(session);   // useSyncExternalStore(t.subscribe, t.list)  ○
const pending = useElicitations(session);                                          // ○
const knobs   = useKnobs(session);                                                 // ○
```

## 3. The config taxonomy (§8b — the options surfaces as ONE intentional page)

```ts
// ── createApp: WHAT the agent is and HOW it behaves ──
createApp(<Agent/>, {
  name: "support-agent",            // ✓ identity → app.name spans, functionId default
  model: openai("gpt-5"),           // ✓ | modelExecutor (BYO) — exactly-one NOT required ✓
  telemetry: true,                  // ✓ observability (opt-in; gen_ai.* + cost)
  narrate: true,                    // ✓ model self-narration (app policy)
  tools: [...],                     // ✓ app-wide tool floor
  extensions: [withMCP(...)],       // ✓ session extensions
  sessions: {                       // ✓ LIFECYCLE + LIMITS, grouped (the one group that earns it)
    store, maxActive: 100, idleTimeout: 30*60_000, maxSpawnDepth: 10,
    migrateSnapshot,                // ○ move here from top level? (Q for Ryan)
  },
  signal,                           // ✓ abort cascade
});

// ── createGateway: WHERE it's served and WHO may reach it ──
createGateway({
  transports: [httpServerTransport({ port: 4783 })],   // ✓
  security: {                        // ○ GROUP the operator posture (today: flat/transport-level)
    allowedOrigins, allowedHosts, trustProxy, csrf,    //   defaults stay safe-by-default
  },
  client: {                          // ○ GROUP app egress policy (opt-in territory)
    truncateToolResults: true,       //   (today: top-level — moves here)
  },
  authorizer,                        // ✓ who may call what
});
```

**The grouping rule (so this never rots):** a key earns a GROUP when it's one of ≥3
siblings sharing an axis (lifecycle, operator-security, egress-policy); otherwise it
stays flat. Axes, not grab-bags. New keys must name their axis in review or justify
flatness.

## 4. Open questions (carried from client-handles.md §9 + this page)

1. `clientToolCalls` verb names: `.route()` / `.confirm()` (my lean) vs longer?
2. `session.timeline` local verbs (`seed/prepend/append/clear`) — same table as wire
   verbs, no visual distinction (my lean)?
3. tasks: does anything beyond core+Enumerable earn a profile?
4. Write-verb derivation: convention+conformance now, codegen at handle #5 (my lean)?
5. `migrateSnapshot` → `sessions.migrateSnapshot`?
6. `security`/`client` gateway groups as drawn?
