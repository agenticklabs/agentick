# Observability — trace, metrics, and the operation ladder (user-facing guide — DRAFT)

> Destination: website docs after the docs sweep. Code-first. Source of truth
> for the ctx observability + ops facets (ADR 64 / 78 / 19 / 83).
>
> The whole path is wired end to end: `telemetry: <anything>` threads a
> provider down to `ctx.trace` / `ctx.metrics` in your handlers, and the
> standard-OTel `createTelemetry` + `otlpSink` wiring (§6) exports spans and
> metrics with no Effect import. Every code block below compiles against shipped
> API.

## The whole mental model in one sentence

**Turn on `telemetry: true` and your agent has a trace tree shaped like itself;
the ctx facet is how YOUR code joins it.**

Every operation the framework runs — an execution, a tick, a model call, a tool
dispatch — is already an OTel span, auto-parented into a tree that mirrors the
agent's own structure. Your handler code reaches that same tree through three
verbs on `ctx`: **count it** (`ctx.metrics`), **see it** (`ctx.trace`), **run
it** (`ctx.run`). Nothing to register, no provider tree to thread — the surface
is flat on every `ctx`.

## 1. The one switch

```ts
const app = await createApp(<Agent />, { name: "triage-bot", telemetry: true });
```

That is all it takes to turn enrichment on. With the switch on, every operation
span carries agent-identity + model/tool/tick attributes and — on model calls —
token usage and estimated cost (`gen_ai.usage.input_tokens`,
`agentick.usage.cost_usd`, …). "What did this feature cost in tokens?" becomes a
trace query. See §6 for where the spans go.

> Verified by `packages-next/app/src/__tests__/telemetry.spec.ts`
> (`normalizeTelemetry`, enrichment on/off).

## 2. The three pillars on `ctx` — a real handler

A tool handler using all three verbs together. This is the whole surface:

```ts
import { createTool } from "@agentick/tool-next";
import { z } from "zod";

const Search = createTool({
  name: "search",
  description: "Search the knowledge base",
  input: z.object({ q: z.string() }),
  handler: async ({ q }, { ctx }) => {
    // COUNT — a tally. counter.add semantics.
    ctx.metrics.count("search.requests", 1, { tool: "search" });

    // SEE — a span for a sub-step of THIS handler's own work. No journal,
    // no hooks; just timing/attribution nested under the dispatch span.
    const hits = await ctx.trace("retrieval", async (span) => {
      span.setAttribute("query.length", q.length);
      const rows = await db.search(q);
      span.setAttribute("result.count", rows.length);
      return rows;
    });

    // RECORD — a distribution. histogram.record semantics.
    ctx.metrics.record("search.result_count", hits.length, { tool: "search" });

    // A structured diagnostic (always live, independent of the telemetry switch).
    ctx.log("info", { q, found: hits.length });

    return [{ type: "text", text: JSON.stringify(hits) }];
  },
});
```

> Verified by `packages-next/runtime/src/__tests__/observability.spec.ts`
> (off-path identity, live span parenting, metric fan-out) and the cross-surface
> `runObservabilityCtxConformance` suite.

## 3. The ladder — climb by how much the system should know about the work

The four verbs are not alternatives; they are **rungs**. Pick the one that
matches how much structure the work deserves.

| Rung | Call | You get | Climb when… |
| ---- | ---- | ------- | ----------- |
| 1 · count it | `ctx.metrics.count(name)` | a tally | you only need "how many / how much" |
| 2 · see it | `ctx.trace(name, fn)` | a span (timing/attribution) — **no** journal, hooks, guards | you want a sub-span inside a handler's own work |
| 3 · run it | `ctx.run(name, fn)` | a real **operation**: journal envelope + the inherited interceptor fold (guards + hooks) + outcome + a parented span — minted **inline** | the step deserves a durable record + guard/hook reach, but isn't worth a registered command |
| 3.5 · reach for the primitive | `ctx.runner.runOperation(op, body)` | the operation runner undiluted (tier-4 middleware, full `Operation` shape) | `ctx.run`'s options are too small |
| 4 · name it | a registered command | typed input/output, typed `onBefore/After<Command>` hooks, inbox addressability, wire-grantability | the verb is part of the system's contract |

**Rung 3 — `ctx.run` mints an operation inline:**

```ts
handler: async ({ orderId }, { ctx }) => {
  // A real operation: journaled as `tool:run:charge`, guard-vetoable,
  // hook-observable, its span parented under the dispatch op.
  const receipt = await ctx.run("charge", { input: { orderId } }, () =>
    payments.charge(orderId),
  );
  return [{ type: "text", text: receipt.id }];
};
```

`ctx.run(name, fn)` runs `fn` through the ambient harness's full `runOperation`
pipeline. The op is named `<surface>:run:<name>` (e.g. `tool:run:charge`), so a
guard or a string-keyed hook on the harness can reach it even though the name
isn't a registered command:

```ts
// A guard vetoes the ad-hoc op by matching its derived op key:
harness.guard((_input, opCtx) =>
  opCtx.op === "ToolRunCharge" ? { kind: "veto", reason: "over limit" } : undefined,
);
```

> Verified by `packages-next/tool-executor/src/__tests__/ctx-run.spec.ts`
> (journaled + parented + input-journaled + hook-observed + guard-vetoed) and
> `runOpsCtxConformance`.

**The frozen-small options + the escape hatch.** `ctx.run`'s options are
`{ input?, metadata?, spanAttributes?, signal? }` — per-call ENVELOPE data,
never behavior. This is deliberate: if `ctx.run` accepted middleware and typed
hooks it would collapse rung 4 (registered commands) into rung 3. The GAP — no
registry, no typed hooks, no addressability — is what makes the ladder work.

> **`ctx.run`'s options will not grow. If you need more, you want `ctx.runner`
> or a command.** `ctx.runner` is the ambient runner as a run-only view:
> `ctx.runner.runOperation(op, body)` is the primitive undiluted (tier-4
> call-scoped middleware composes inside it). It exposes only `runOperation` —
> never the runner's lifecycle or event-emission surface — so handler code
> can't tear down or reconfigure the harness.

> ### ⚠︎ Journaled ≠ memoized
>
> `ctx.run` writes a durable **observational** record — name, timing, input,
> outcome — to the operation journal. It is **NOT** a resumable/replayed
> checkpoint. If you come from Restate `ctx.run` or Inngest `step.run`, you will
> assume a completed step is skipped and its result replayed on retry. **It is
> not.** Re-invoking `ctx.run` re-executes `fn`. Durable kill/resume rides the
> store protocols (ADR 49), not this. The journal shape does not preclude a
> future replay story; none is built.

## 4. Metrics reference

Three verbs, mapping to the three OTel instrument kinds:

| Verb | OTel mapping | Semantics | Use for |
| ---- | ------------ | --------- | ------- |
| `ctx.metrics.count(name, n?, labels?)` | `counter.add` | monotonic, summed | event tallies (dispatches, errors, cache misses) |
| `ctx.metrics.record(name, value, labels?)` | `histogram.record` | distribution (buckets/quantiles) | latencies, sizes, token counts |
| `ctx.metrics.gauge(name, value, labels?)` | last-value (async gauge) | most-recent reading, **not** a sum or delta | point-in-time levels (queue depth, active sessions) |

**Names.** Your metric names are used **verbatim** — no forced prefix. Only
metrics the FRAMEWORK itself emits live under `${telemetryNamespace}.*` (default
`agentick.*`), renamable with `createApp({ telemetryNamespace: "acme" })`.

**Labels — low-cardinality only.** The ambient default labels are `{ tool, op }`
— plus `{ app }` (the app's `name`) when set, so metrics from apps sharing one
`MeterProvider` under a gateway stay distinguishable — all bounded sets.
High-cardinality identity (`sessionId`, `executionId`, a user
id, a free-form message) must **never** be a default metric label: every
distinct label value mints a new time series, and unbounded label values explode
cardinality until the metrics backend falls over. High-cardinality identity
rides **spans and logs**, which are built for it. Explicit per-call labels merge
over the defaults:

```ts
ctx.metrics.record("latency_ms", ms, { outcome: "ok" });
//  → labels { tool: "search", op: "ToolDispatch", outcome: "ok" }
```

You may add your own labels — the framework does not police them — but the safe
default keeps a naive `count(...)` from bankrupting your pipeline by construction.

> Verified by `packages-next/runtime/src/__tests__/observability.spec.ts`
> ("namespaces names, merges low-cardinality default labels, per-call overrides").

## 5. The agent-shaped span tree

Auto-parenting means the span tree mirrors the agent's own structure — you did
not build it:

```
execution ─┬─ tick 1 ─┬─ model:command:generate   (gen_ai.* + cost attributes)
           │          └─ tool:command:dispatch ─┬─ retrieval        (ctx.trace)
           │                                     └─ tool:run:charge  (ctx.run)
           └─ tick 2 ─── model:command:generate
```

Every rung shares **one** parenting mechanism: an operation span (framework),
a `ctx.trace` span, and a `ctx.run` op span all nest under the current
operation via the same ambient-fiber tree (ADR-77). Your `ctx.trace("retrieval")`
lands exactly where you'd expect — under the tool dispatch, under the tick,
under the execution. Because `gen_ai.request.model`, `gen_ai.usage.*`, and
`agentick.usage.cost_usd` ride the model-call spans in that same tree, cost and
token attribution are just trace queries scoped to a subtree.

> Verified by the parenting test in
> `packages-next/runtime/src/__tests__/observability.spec.ts` and the substrate
> enrichment in `packages-next/app/src/telemetry-defaults.ts`.

## 6. Sinks & providers — where the spans and metrics go

The framework bundles **no** OTel exporter. Enrichment annotates spans +
metrics; where they GO is your exporter wiring, expressed as **standard
OpenTelemetry objects**. `createTelemetry(options, ...sinks)` merges a set of
destination **sinks** into the app's `telemetry` switch — no Effect import.

**The primary form — `createTelemetry` + `otlpSink`:**

```ts
import { createApp, createTelemetry } from "@agentick/app-next/react";
import { otlpSink } from "@agentick/telemetry-otlp-next";

const telemetry = createTelemetry({ serviceName: "triage-bot" }, otlpSink());
createApp(<Agent />, { name: "triage-bot", telemetry });
```

`otlpSink()` returns a `TelemetrySink` — a `BatchSpanProcessor` +
`PeriodicExportingMetricReader` over the OTLP HTTP/proto exporters, with
`OTEL_EXPORTER_OTLP_ENDPOINT` / `_HEADERS` / `_PROTOCOL` env auto-fill (explicit
options beat env, per field). The OTel exporter deps live in that package, so
`@agentick/app-next` stays exporter-free.

**Bring your own OTel pieces — a raw sink literal:**

```ts
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

const telemetry = createTelemetry(
  { serviceName: "triage-bot" },
  {
    spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
    }),
  },
);
createApp(<Agent />, { name: "triage-bot", telemetry });
```

A raw `TelemetrySink = { spanProcessor?, metricReader?, attributes? }` object
literal IS a valid sink — the escape hatch is the primitive. Sampling,
filtering, and batching stay expressed as your standard OTel objects; the
framework adds **no** proprietary layer between you and OTel. `createTelemetry`
merges every sink (span processors concat, metric readers concat, `attributes`
merge under the options'), validates eagerly, and returns the existing
`TelemetrySetting` — the `createApp` slot union does not grow.

**The one switch + autodiscovery:**

```ts
createApp(<Agent />, { name: "triage-bot", telemetry: true });
```

`telemetry: true` turns enrichment on. With **no** exporter wired, it attempts
env-driven autodiscovery: if `OTEL_EXPORTER_OTLP_ENDPOINT` is set, it lazily
loads `@agentick/telemetry-otlp-next` and exports over OTLP; if that package
isn't installed, it logs one line naming the install and continues (never
crashes). This is a deliberate divergence from the OTel SDK's silent-localhost
default — autodiscovery fires **only** when the endpoint env is explicitly set,
so there's no accidental export spam. Opt out with
`createTelemetry({ autoDiscover: false })`. With no exporter and no endpoint env,
enrichment still annotates spans on the no-op tracer — annotation on, export off.

**The Effect-native escape hatch** (ADR-42 dichotomy — standard-vocabulary
shorthand above, live-instance hatch here). Prefer the sinks; reach for a raw
tracer `Layer` only when you already have one:

```ts
import { NodeSdk } from "@effect/opentelemetry";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const layer = NodeSdk.layer(() => ({
  resource: { serviceName: "triage-bot" },
  spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
}));
createApp(<Agent />, { name: "triage-bot", telemetry: { layer } });
```

A `layer` and `spanProcessor`s given together compose **additively** (both
export) — the `layer` is never overridden.

### Env precedence (`otlpSink` auto-fill)

| Field | Option | Env var | Precedence |
| ----- | ------ | ------- | ---------- |
| endpoint | `otlpSink({ endpoint })` | `OTEL_EXPORTER_OTLP_ENDPOINT` | explicit option wins |
| headers | `otlpSink({ headers })` | `OTEL_EXPORTER_OTLP_HEADERS` | per-key merge; explicit key wins, env-only kept |
| protocol | `otlpSink({ protocol })` | `OTEL_EXPORTER_OTLP_PROTOCOL` | explicit option wins; unknown env → `http/protobuf` |
| serviceName | `createTelemetry({ serviceName })` | `OTEL_SERVICE_NAME` | explicit option wins |
| attributes | `createTelemetry({ attributes })` | `OTEL_RESOURCE_ATTRIBUTES` | per-key; explicit key wins |

## 7. Testing your instrumentation

The telemetry testing double records the spans + metrics your code emits, so you
can assert your OWN instrumentation:

```ts
import { spyTelemetryProvider } from "@agentick/runtime-next/testing";
import { deriveObservability } from "@agentick/runtime-next";
import { Effect, ManagedRuntime } from "effect";

const spy = spyTelemetryProvider();
const rt = ManagedRuntime.make(spy.tracer!);

await rt.runPromise(
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    const ctx = deriveObservability({
      log: () => {},
      namespace: "acme",
      telemetry: { runtime, meter: spy.meter },
    });
    ctx.metrics.count("thing.happened", 1, { op: "X" });
    yield* Effect.promise(() =>
      ctx.trace("my.substep", (span) => span.setAttribute("k", "v")),
    );
  }).pipe(Effect.withSpan("enclosing.op")),
);

expect(spy.metrics).toContainEqual({
  kind: "count",
  name: "acme.thing.happened",
  value: 1,
  labels: { op: "X" },
});
// the substep span nested under the enclosing op:
expect(spy.spans.find((s) => s.name === "my.substep")?.parent).toBe("enclosing.op");
```

> Verified by `packages-next/runtime/src/__tests__/observability.spec.ts` (the
> spy double is exercised there for parenting + fan-out).

`spyTelemetryProvider` (above) tests instrumentation at the substrate level. To
test the **full app path** — `createApp({ telemetry })` threading a provider all
the way to `ctx.trace` / `ctx.metrics` in a real tool handler — wire a
`spyTelemetrySink()` (from `@agentick/runtime-next/testing`) through
`createTelemetry`; it records at the standard-OTel edge (proving the whole
Effect → OTel bridge), exposing `.spans` and `collectMetrics()` for assertions:

```ts
import { spyTelemetrySink } from "@agentick/runtime-next/testing";
import { createTelemetry } from "@agentick/app-next";

const spy = spyTelemetrySink();
const app = await createApp(<Agent />, {
  name: "triage-bot",
  telemetry: createTelemetry({}, spy),
});
// … drive a send that dispatches a tool calling ctx.trace / ctx.metrics …
expect(spy.spans.some((s) => s.name === "my.substep")).toBe(true);
expect(await spy.collectMetrics()).toContainEqual(
  expect.objectContaining({ name: "acme.search.requests" }),
);
```

> Verified by `packages-next/app/src/__tests__/telemetry-e2e.spec.tsx`.

## 8. Correlation — how `log`, `trace`, and `metrics` join up

`log` is a **bus** event (ADR 64): a structured diagnostic that projections
forward (MCP → `notifications/message`; the agentick client → `subscribe`/`onLog`).
`trace` and `metrics` go to the telemetry **provider** (the OTel tracer/meter),
never the bus. They join up by IDENTITY: logs and spans carry the work-path
coordinates (`sessionId`/`executionId`/`tickId`) and, in a wired backend, the
active trace/span id, so a log line and its span land on the same trace in your
backend. Metrics stay low-cardinality and are queried by their bounded labels,
then pivoted to the matching spans by time + service. (Stamping the active
trace/span id onto the log envelope is a small follow-up — not yet built.)

## 9. Where each piece lives

| Piece | Package | Symbol |
| ----- | ------- | ------ |
| The facet types | `@agentick/spec-next` | `Observability`, `Ops`, `Span`, `Metrics`, `RunOptions` |
| The switch + sink types | `@agentick/spec-next` | `TelemetrySetting`, `TelemetryOptions`, `TelemetrySink` |
| The derivations | `@agentick/runtime-next` | `deriveObservability`, `deriveOps` |
| The provider seam | `@agentick/runtime-next` | `TelemetryProvider`, `MetricSink` |
| Testing doubles | `@agentick/runtime-next/testing` | `spyTelemetryProvider`, `spyTelemetrySink` |
| Conformance | `@agentick/spec-conformance-next` | `runObservabilityCtxConformance`, `runOpsCtxConformance` |
| The one switch | `@agentick/app-next` | `createApp({ telemetry })` |
| Sink merge factory | `@agentick/app-next` | `createTelemetry(options, ...sinks)` |
| OTLP exporter sink | `@agentick/telemetry-otlp-next` | `otlpSink(options?)` |

> The runtime README's "The `ctx` facets" section is the substrate-level
> companion to this guide.
