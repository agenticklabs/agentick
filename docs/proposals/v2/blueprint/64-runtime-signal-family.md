# ADR 64 — Runtime signal family: `log` + `progress` as framework primitives, projected

**Status:** PROPOSED 2026-07-07 (Fable, for Ryan). MCP Wave 5 dependency (task #19). **Builds
on:** the `ElicitationHarness` precedent (framework primitive MCP projects), ADR 27 (bundled),
the existing client subscription/progress infra. **Reworks:** Wave 3a's MCP-only `ctx.log`
(`c92d99ac`).

## The gap

Wave 3a shipped `ctx.log` that emits **only to the MCP wire** (`sdkServer.sendLoggingMessage`).
So a tool's log goes _nowhere_ unless it's running as an MCP server, and non-MCP components
(harnesses, the loop) have no structured logging at all. Same for progress: MCP has
`notifications/progress`, but there's no framework way for a long-running tool/component to emit
progress that reaches _either_ a connected MCP client _or_ the agentick app.

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
_originates_ at the component regardless of who's listening — so it belongs at the runtime, with
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
  (the app may want debug); each _projection_ applies its own threshold.
- **Fire-and-forget.** Signals are never a control path — a dropped/failed projection never blocks
  the emitter (3a's rule, kept).
- **Compiler-general.** The emit is a runtime-ctx capability, not React/JSX — the functional
  compiler's `ctx` exposes the same `log`/`progress`.
- **Status.** Execution status (running/completed/error/aborted) is _already_ tracked on the client
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

---

## Amendment (2026-08-05) — frame identity: `op` on the payload, `parentOpId` on the envelope

**Status:** ACCEPTED (Ryan). Prompted by a real consumer failure: the ernesto compaction
progress bar, whose only way to answer "is this frame from a compaction?" was to sniff the
`timeline:compact:` prefix of an opaque token — a convention one emitter happens to follow,
promised by no type.

### The gap

A progress consumer needs three things from a frame: **who** sent it (which operation), **where**
the work stands (the numbers), and **when it is over**. The wire answered only the middle one by
contract. Identity was smuggled inside the token string; closure is deliberately the owning
operation's job (law 4). So the generic subscription every consumer is steered toward
(`*:signal:progress`) delivers frames that cannot be classified by operation — and the moment a
surface emits progress for a second kind of work, every consumer folding "surface = operation"
breaks silently.

The envelope models the correlation (`opId`/`parentOpId`) but signals never populated it: the
signal family bypasses the operation runner (`emitSignal`, bus-only by design), and every emit
site fires from a Promise context through `Effect.runFork`, where the ambient FiberRef op context
is already gone.

### The decision

1. **`ProgressEventPayload.op?: string`** — the owning operation's canonical name
   (`<surface>:command:<verb>`, e.g. `"timeline:command:compact"`), stamped by the emitter, which
   always knows it. Identity becomes a typed field a frame carries **alone** — the same
   late-joiner reasoning as law 1, extended from determinacy to identity. Absent when the emitter
   has no operation, and always absent on inbound third-party MCP frames.
2. **`parentOpId` on signal envelopes** — `emitProgress` accepts it explicitly and `emitSignal`
   stamps it. Explicit, not ambient: the fork boundary at every emit site makes FiberRef reading
   a false promise, so the site captures the id where it still exists. This is journal/
   observability causality, not the client story — a client filtering on it would be back to the
   join this amendment exists to remove.
3. **Token law** — the token SHOULD be the owning operation's own `opId` (the tasks precedent, "a
   task is its own token", generalized). Kills hand-rolled `<prefix>:<ulid>` minting. The token
   stays what MCP says it is — an opaque correlation key for folding concurrent streams — and
   `op` is what classifies; consumers classify by `op`, fold by `token`, close by the operation.

### Rejected

- **Per-operation event names** (`timeline:compact:progress`) — collapses the signal domain into
  the command domain, and converts every generic subscriber (the MCP projection, a progress UI,
  observability) into a maintainer of an open-ended name list. MCP itself has exactly one
  `notifications/progress`; the name-vs-token split is its own architecture.
- **Progress as lifecycle `delta` phases** on the command — the maximalist unification. Signals
  are bus-only precisely so fifty frames per fold never touch the journal; lifecycle events get
  no such exemption for free.
- **Identity via lifecycle join alone** (subscribe `timeline:command:compact`, extract `opId`,
  join frames on `parentOpId`) — real machinery in every consumer, and it fails the late joiner
  outright: a UI mounting mid-flight holds frames pointing at a `requested` envelope it never
  received.

### MCP compatibility

Unchanged in both directions. The projection maps `notifications/progress` params field-by-field
(`progressToken`, `progress`, `total`, `message`) and deliberately does not forward `op`; inbound
third-party frames simply lack it. The four laws on `ProgressUpdate` are untouched — `op` rides
`ProgressEventPayload`, beside the token, not the reporter grammar.

### Client surface

`OnSignalOptions.op` filters `onProgress` frames to one operation, matched against `payload.op`,
**strict**: an unstamped frame does not match a set filter — a consumer that asked for one
operation must not be fed frames of unknown provenance. `onLog` ignores it (logs stay anonymous
until a consumer appears; TODO(signal-identity) marks the seam).
