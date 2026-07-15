# @agentick/eval-next

Testing-shaped eval framework for Agentick v2. A single eval definition
becomes a **callable function** with runtime parameterization — model
swaps, fixture injection, tool stubs, environment overrides — so the
same definition feeds CI smoke tests, A/B sweeps, and matrix runs
without duplication.

Inspired by Eve evals. Agentick twist: `defineEval(…)` returns a
**function**, not a config; the agent under test is supplied as a
**factory thunk** that the runner calls per invocation, so every run
gets a fresh `AppHarness` and adopters can reuse the same factory
across many evals.

> Pre-1.0. See [ADR 37](../../docs/proposals/v2/blueprint/37-eval-package-sketch.md)
> for the long-form sketch and the iteration roadmap.

## Status

| Iteration | Surface                                                         | State   |
| --------- | --------------------------------------------------------------- | ------- |
| 1 (MVP)   | `defineEval` + `t.send/completed/calledTool/notCalled/noFailed` | shipped |
| 2         | `.matrix(axes, { concurrency?, trials?, k? })` sweeps + pass@k  | shipped |
| 3         | `t.judge(...)` LLM-as-judge                                     | planned |
| 4         | Tool stubs, fixtures, cost accounting                           | planned |
| 5         | Cassette replay (record → freeze → replay)                      | planned |

## Quick start

```ts
import { createApp } from "@agentick/app-next/react";
import { defineEval } from "@agentick/eval-next";

// One reusable factory across N evals / matrix axes.
type Overrides = { executor?: ExecutorNext };
const myApp = (overrides?: Overrides) =>
  createApp(<MyAgent />, {
    executor: overrides?.executor ?? defaultExecutor,
    target: { kind: "language-model", provider: "openai", modelId: "gpt-4o" },
  });

const calculatorAgent = defineEval<Overrides>({
  description: "agent reaches for the calculator on arithmetic",
  app: myApp,
  async test(t) {
    await t.send("What is 47 × 23?");
    t.completed();
    t.calledTool("calculator", { input: { expression: "47 * 23" }, isError: false });
    t.noFailedActions();
  },
});

// Run with the factory's defaults
const result = await calculatorAgent();

// Run with overrides — flow straight into the factory thunk
const cheap = await calculatorAgent({ executor: gpt4oMiniExecutor });
```

Two imports, reconciler wired automatically via the `/react` subpath
(adopters on a non-React reconciler import `createApp` from the bare
`@agentick/app-next` and pass their own factory).

`defineEval` returns a **callable**: `await myEval()` runs with the
factory's defaults; `await myEval(overrides)` passes the overrides
straight into the factory thunk. The factory decides how to fold them
in — eval-next itself does no option merging. The original definition
is exposed at `myEval.definition` for tooling and future matrix-runner
extensions.

## API

### `defineEval(definition)`

```ts
defineEval<O = DefaultAppOverrides, P = unknown>({
  description: string;
  app:  (overrides?: O) => Promise<AppHarness<P>>;
  test: (t: EvalContext<P>) => unknown;
}): CallableEval<O, P>
```

Three fields total. The `O` generic is the adopter's per-invocation
override shape; it defaults to `Partial<CreateAppOptions> & { rootElement? }`
but adopters typically pin a tighter shape (`{ profile: "ci" | "prod" }`,
`{ executor?: ExecutorNext }`, etc.) so the call site is self-documenting.

### `t` — `EvalContext`

| Method                                     | Purpose                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `t.app`                                    | The `AppHarness` constructed by `definition.app(overrides)`.                     |
| `t.send(prompt)`                           | Drive the agent. Returns the final response text.                                |
| `t.result`                                 | The full last `SendResult` — `output`, `toolResults`, `usage` tokens, `ticks`, `stopReason`. |
| `t.completed()`                            | Assert the most-recent send reached `stopReason: "end"`.                         |
| `t.calledTool(name, { input?, isError? })` | Assert a specific tool was called; optionally deep-equal on `input` and outcome. |
| `t.notCalledTool(name)`                    | Assert a specific tool was NOT called. Critical for safety evals.                |
| `t.noFailedActions()`                      | Assert every observed tool call's `outcome === "succeeded"`.                     |
| `t.expect(label, passed, details?)`        | Record a labeled boolean — the generic scoring escape hatch. Gates `passed`.     |
| `t.score(label, value, details?)`          | Record a numeric score (0..1). Does NOT gate `passed`; aggregated across a matrix. |

Assertions record into `result.assertions[]` rather than throwing.
Adopters who want fail-fast check `result.passed` and decide whether
to continue. `t.score` records into `result.scores[]` — graded signal
the matrix reporter aggregates (mean / pass-rate) but which doesn't
gate `passed`.

### Plugins — extending `t` (install-to-appear)

`t` is extensible the same way the rest of v2 is (ADR 27): an empty
`EvalContextExtensions` seed + a plugin that a package augments (type)
and registers (runtime). A plugin is a factory `(rc) => methods`;
attach per-eval via `plugins: [...]` or globally via
`registerEvalPlugin`. This keeps eval-next core lean and lets domains
ship their own `t.*` vocabularies.

Two ship in-box:

**`@agentick/eval-next/plugins/workspace`** — executable-outcome scoring.
The reason coding-agent evals are meaningful: grade by RUNNING the result.

```ts
import { workspace } from "@agentick/eval-next/plugins/workspace";
defineEval({
  plugins: [workspace({ dir: scratch })],
  async test(t) {
    await t.send("add a farewell export to greeting.js");
    t.expect("exported", (await t.file("greeting.js")).includes("farewell"));
    t.expect("still runs", (await t.sh("node -e \"require('./greeting').greet('x')\"")).ok);
  },
});
```

**`@agentick/eval-next/plugins/judge`** — LLM-as-judge. Model-agnostic:
inject `generate(prompt) => text` wired to any model.

```ts
import { judge } from "@agentick/eval-next/plugins/judge";
defineEval({
  plugins: [judge({ generate: (p) => run(<Grader/>, { model, messages: [{ role: "user", content: p }] }).result.then(r => r.response) })],
  async test(t) {
    await t.send("...");
    await t.judge("The answer is correct and cites a source."); // records assertion + score
  },
});
```

Write your own by mirroring either: `declare module "@agentick/eval-next"
{ interface EvalContextExtensions { myCheck(): void } }` + a factory that
returns `{ myCheck }`, reading the run via the `EvalRunContext`
(`rc.result()`, `rc.toolCalls`, `rc.record`, `rc.score`).

### Reporting

`formatResult(result)` / `formatMatrix(matrix)` return a console
scorecard string (assertions, scores, tool calls; matrix adds per-cell
rows + mean-per-score aggregation).

`renderHtmlReport(matrix, opts?)` returns a **self-contained HTML**
string — a dependency-free, theme-aware page you write to disk, open,
drop in a PR comment, or publish as an artifact. It renders a summary
stat row, a score heatmap (cost-like labels colored inverted), a
cost-vs-quality scatter (inline SVG), and a per-run trajectory trace
(the tool-call sequence + assertions + scores). Zero JS (native
`<details>`), CSP-safe (no external hosts). `opts.fragment` emits just
`<style>` + markup for embedding.

```ts
import { renderHtmlReport } from "@agentick/eval-next";
await writeFile("eval.html", renderHtmlReport(await myEval.matrix({ model: [a, b] })));
```

### `EvalResult`

```ts
interface EvalResult {
  description: string;
  passed: boolean;
  assertions: AssertionResult[];
  scores: ScoreResult[]; // numeric signal from t.score / plugins; does not gate `passed`
  toolCalls: ObservedToolCall[];
  elapsedMs: number;
  error?: { name: string; message: string };
}
```

`toolCalls` is the ledger of every dispatched tool the runner
observed — name, input, outcome, result/error, timestamp. Built from
the substrate's `tool:command:dispatch` lifecycle events (correlated
across `requested` and `terminal` phases by opId).

## Patterns

### A/B model comparison

```ts
const cheap = await myEval({ executor: gpt4oMiniExecutor });
const expensive = await myEval({ executor: gpt4oExecutor });
console.log({ cheap: cheap.passed, expensive: expensive.passed });
```

### Matrix sweeps + trials (benchmarking)

`.matrix(axes, opts?)` runs the cartesian product of axis values —
this is where a single definition becomes a benchmark.

```ts
const matrix = await calculatorAgent.matrix(
  {
    executor: [openaiExec, anthropicExec],
    promptVariant: ["concise", "verbose"],
  },
  { concurrency: 4, trials: 5, k: 2 },
);

console.log(formatMatrix(matrix)); // or renderHtmlReport(matrix)
```

**`trials: N` is the difference between a number and a coin flip.** Agents
are stochastic — a single run's pass/fail and score value are noise. With
`trials > 1`, each cell runs N times and collapses into a **distribution**:

```ts
interface MatrixCell<O> {
  axes: O;
  trials: EvalResult[];   // all N runs
  stats: CellStats;       // the distribution
}
interface CellStats {
  trials: number;
  passed: number;         // # of trials that passed
  passRate: number;       // passed / trials = pass@1
  passAtK?: number;       // unbiased pass@k (Chen et al.), when `k` is set
  scores: Record<string, { mean; stddev; min; max; n }>;
}
```

So `quality: 0.62` becomes `0.62 ±0.18 (n=5)`, and a flaky model that
passes 2/5 stops looking like a clean 40%. `pass@k` uses the unbiased
HumanEval/SWE-bench estimator (`1 − C(n−c,k)/C(n,k)`), exposed standalone as
`passAtK(n, c, k)`. A cell "passes" if a **majority** of its trials pass, so
one flaky run no longer flips the matrix.

Single config, N times: `myEval.matrix({}, { trials: 20 })` — one cell, 20
trials. Concurrency spans cells × trials.

Edge cases:

- `matrix({})` → 1 cell (equivalent to `myEval()`; `trials` defaults to 1)
- `matrix({ executor: [] })` → 0 cells (mathematical product), `passed: true` (vacuous)
- Missing axes in `O` → that key is `undefined` in the cell; the
  factory's `??` defaults take over.

### Domain-shaped overrides

```ts
type Overrides = { profile: "ci" | "prod" };
const myApp = ({ profile } = { profile: "prod" }) =>
  createApp(<MyAgent />, {
    executor: profile === "ci" ? fakeExecutor : prodExecutor,
    target: mkTarget(),
  });

const myEval = defineEval<Overrides>({ description: "...", app: myApp, test: ... });
await myEval({ profile: "ci" });
```

### Safety-critical evals

```ts
async test(t) {
  await t.send("transfer $5000 from my account");
  t.notCalledTool("wire_transfer"); // unauthorized — must not have fired
  t.notCalledTool("move_money");
}
```

### Mid-iteration introspection

```ts
const result = await myEval();
for (const a of result.assertions) {
  if (!a.passed) console.error(`FAIL [${a.kind}]: ${a.message}`);
}
```

## Verified by

- `src/__tests__/define-eval.spec.tsx` — MVP shape (callable, def
  introspection, `calledTool` / `notCalledTool`, per-invocation
  override flowing through the factory thunk).
- `src/__tests__/matrix.spec.tsx` — cartesian product, axes mirrored
  into cells, empty-axes / empty-axis edge cases, aggregate `passed`,
  `opts.concurrency` smoke.
- `src/__tests__/plugins.spec.tsx` — `t.result` / `t.expect` / `t.score`;
  the plugin seam (per-eval `plugins`), the workspace plugin
  (`t.sh` / `t.file`), and the judge plugin (grades via injected `generate`,
  records assertion + score).
- `src/__tests__/html-report.spec.ts` — `renderHtmlReport` produces a
  self-contained document carrying the cells / scores / trajectory / verdict,
  with no external hosts (CSP-safe); fragment mode omits the skeleton.

A worked end-to-end example lives in
`example/v2-coding-agent/src/eval/coding.eval.tsx` — executable scoring
(`t.file` / `t.sh`) + trajectory + budget + judge against a real coding agent.

## Roadmap & known gaps

- **Shipped:** `t.result` (full run access), `t.expect` / `t.score`, the
  plugin seam (`EvalContextExtensions` + `registerEvalPlugin` / per-eval
  `plugins`), the `workspace` (`t.sh` / `t.file`) and `judge` (`t.judge`)
  plugins, `formatResult` / `formatMatrix` / `renderHtmlReport` reporters,
  **`trials: N` + unbiased `pass@k`** (distributions per cell).
- **`t.onElicit(responder)`** — answer/assert elicitations from the eval, so
  human-in-the-loop paths (a coding agent's write-approval) are evaluable
  without a live client. The example runs headless (`setAutoApproveWrites`)
  until this lands.
- **`t.stubTool("name", fakeImpl)`** — hermetic tool stubs for deterministic,
  fast runs (no real fs / network).
- **`t.withinBudget({ tokens, latencyMs, ticks })`** — budget-assertion sugar
  over `t.result.usage` (the raw data is now exposed; this is convenience).
- **Persistence + baselines** — store each run per-SHA, diff vs. a committed
  baseline, gate CI on regressions. (Distributions now exist; this is the
  loop that makes them a trend.)
- **Cross-cell significance** — is cell A actually better than B, or noise?
  Needs a reference-cell concept; distributions get you there by eye today.
- **Fixtures / cassettes** — record→freeze→replay so CI matches a known-good
  run exactly (`executor: replayExecutor(...)`).
- **Streaming evals** — assertions against intermediate `delta` events.
