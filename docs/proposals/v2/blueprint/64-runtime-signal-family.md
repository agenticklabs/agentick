# ADR 64 — Runtime signal family: `log` + `progress` as framework primitives, projected

**Status:** PROPOSED 2026-07-07 (Fable, for Ryan). MCP Wave 5 dependency (task #19). **Builds
on:** the `ElicitationHarness` precedent (framework primitive MCP projects), ADR 27 (bundled),
the existing client subscription/progress infra. **Reworks:** Wave 3a's MCP-only `ctx.log`
(`c92d99ac`).

## The gap

Wave 3a shipped `ctx.log` that emits **only to the MCP wire** (`sdkServer.sendLoggingMessage`).
So a tool's log goes *nowhere* unless it's running as an MCP server, and non-MCP components
(harnesses, the loop) have no structured logging at all. Same for progress: MCP has
`notifications/progress`, but there's no framework way for a long-running tool/component to emit
progress that reaches *either* a connected MCP client *or* the agentick app.

These are **out-of-band signals** (diagnostics + liveness), orthogonal to model-IR content. They
should be **framework runtime primitives** — exactly the elicitation pattern: emitted through the
runtime, **projected** to every consumer — not one-off MCP sinks.

## The shape: one emit → structured bus event → dual projection

A component (tool via its ctx, or any harness/the loop via the runtime `Context`) emits:

```ts
ctx.log(level: LogLevel, data: unknown, logger?: string): void      // syslog-severity levels
ctx.progress(token: ProgressToken, p: { progress: number; total?: number; message?: string }): void
```

Each emit produces **one structured event on the bus** (scoped to the session/component). It is
**not** sent to any wire directly. Two projections subscribe:

1. **MCP projection** (agentick-as-MCP-server): subscribes to the connection's scope →
   `notifications/message` (log, filtered by the client's `logging/setLevel`) + `notifications/
   progress` (correlated by `progressToken`). **Wave 3a's `logging.ts` becomes this subscriber** —
   `ctx.log` no longer calls `sdkServer.sendLoggingMessage` directly; it emits a bus event the
   projection forwards. Decouples the sink from MCP.
2. **agentick-client projection**: the events ride the **existing** client-receive infra — no new
   transport plumbing:
   - **log/status** → `client.transport.subscribe({kind:"session",id}, query)` (scoped, cursored;
     `subscriptions-next` + its react hooks are the app surface). Add typed sugar (`onLog` /
     `useLog`) over the generic subscribe so app code doesn't hand-roll the query.
   - **progress** → the existing `client.transport.progress(progressToken)` stream +
     `ProgressReporter` (`wire/extension.ts:153`) already carry per-execution progress; `ctx.progress`
     feeds it.

So: **emit once (framework), receive everywhere (MCP + app), via primitives that already exist.**

## Why a framework primitive, not per-consumer sinks (steel-manned)

Could each consumer just wire its own? That's what Wave 3a did (MCP-only) and it's the gap: a
tool can't log to the app, a harness can't log at all, progress has no framework path. The signal
*originates* at the component regardless of who's listening — so it belongs at the runtime, with
projections subscribing. Same reasoning as elicitation (one seam, many edges). Three consumers
already (MCP server, agentick client, dev/observability) — clears the bar.

## Design points

- **Where the emit lives.** Tools get `ctx.log`/`ctx.progress` on `ToolHandlerCtx` (where
  `ctx.elicit` already lives). Non-tool components emit via the runtime `Context` (the same bus).
  One event shape, two entry points.
- **Event shapes** (`spec-next` wire types): a structured `LogEvent { level, data, logger?, ts,
  scope }` and `ProgressEvent { token, progress, total?, message?, scope }`. Firewall types (they
  cross the wire to the client).
- **Level filtering** stays where 3a put it for MCP (per-connection `setLevel`); the app-side
  subscription filters client-side (or via the query). Below-level logs still emit as bus events
  (the app may want debug); each *projection* applies its own threshold.
- **Fire-and-forget.** Signals are never a control path — a dropped/failed projection never blocks
  the emitter (3a's rule, kept).
- **Compiler-general.** The emit is a runtime-ctx capability, not React/JSX — the functional
  compiler's `ctx` exposes the same `log`/`progress`.
- **Status.** Execution status (running/completed/error/aborted) is *already* tracked on the client
  exec handle + bus lifecycle events — so "status" is largely existing, not a new member. This ADR
  is **log + progress**; a thin `ctx.status` can layer on the same bus later if a need appears.

## Consequences / scope
- Wave 3a's MCP logging is reworked to a bus subscriber (no behavior change to the wire; the
  source moves to the framework seam).
- Wave 5's progress-sink item is subsumed here.
- The agentick client gains typed `onLog`/`useLog` sugar; progress reuses the existing stream.
- No new transport machinery — the client-receive is existing `subscribe`/`progress` + typed hooks.

## Open (build-time)
1. Exact `ctx` entry-point unification (one `ctx.log` shared by tool + component ctx vs a runtime
   `Context.log` the tool ctx re-exposes).
2. Whether `LogEvent`/`ProgressEvent` reuse existing bus event kinds or are new ones.
3. `ctx.status` — include a thin one now or defer (leaning defer; exec status already surfaces).
