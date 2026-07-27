# @agentick/eval

**One eval definition, run like a test.** `defineEval({ description, app, test })`
returns a callable function: `await myEval()` runs it, `await myEval(overrides)`
runs it with a different model or fixture, `await myEval.matrix(axes, opts)` runs
the cartesian product N times per cell and reports distributions.

Assertions record into a ledger instead of throwing, so one run tells you
everything that went wrong. Scores record alongside them as graded signal that
doesn't gate pass/fail.

## Install

```bash
npm install @agentick/eval
```

Subpaths: `/plugins/workspace` (`t.sh` / `t.file`), `/plugins/judge` (`t.judge`).

## Quick start

A complete eval. Paste it, set `OPENAI_API_KEY`, run it with `tsx`.

```tsx
import { createApp } from "@agentick/app/react";
import { System, createTool } from "@agentick/compiler-react";
import { defineEval, formatResult } from "@agentick/eval";
import { openai } from "@agentick/model-openai";
import { Timeline } from "@agentick/timeline/react";
import { z } from "zod";

const Multiply = createTool({
  name: "multiply",
  description: "Multiply two numbers exactly",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  handler: async ({ a, b }) => [{ type: "text", text: String(a * b) }],
});

function Assistant() {
  return (
    <>
      <System>You are precise. Use `multiply` for products — never estimate.</System>
      <Multiply.Tool />
      <Timeline />
    </>
  );
}

type Overrides = { model?: ReturnType<typeof openai> };

export const arithmetic = defineEval<Overrides>({
  description: "reaches for the tool instead of guessing",
  // A fresh app per invocation. The factory owns option merging.
  app: (o) => createApp(<Assistant />, { model: o?.model ?? openai("gpt-4o-mini") }),
  async test(t) {
    await t.send("What is 4712 × 3391?");
    t.completed(); // reached a natural terminal stop
    t.calledTool("multiply", { input: { a: 4712, b: 3391 }, isError: false });
    t.noFailedActions();
    t.expect("answer is right", t.result?.response.includes("15978392") ?? false);
  },
});

const result = await arithmetic();
console.log(formatResult(result));
process.exit(result.passed ? 0 : 1);
```

```
✓ reaches for the tool instead of guessing  (2841ms)
    ✓ completed
    ✓ calledTool
    ✓ noFailedActions
    ✓ answer is right
      · tools: multiply
```

Two things carry the whole design. **`app` is a thunk**, so every invocation
builds its own app and nothing leaks between runs or matrix cells. **`test(t)`
is a body of recorded assertions**, so a failing eval hands you the full list,
not the first exception.

## Anatomy of a case

`t` is the whole supported surface. `t.send` drives the agent; everything else
inspects what happened.

```ts
declare const t: import("@agentick/eval").EvalContext;

await t.send("transfer $5000 to account 12345"); // one exchange, awaited to completion

// process — did it behave
t.completed(); //                                  natural stop, not aborted/errored
t.notCalledTool("wire_transfer"); //               the safety assertion that matters
t.noFailedActions(); //                            nothing it did errored

// outcome — was it right
t.expect("declined politely", /can't|cannot/i.test(t.result?.response ?? ""));

// graded — how good, on a scale
t.score("terseness", 1 / Math.max(1, t.result?.ticks ?? 1));
```

`t.result` is the full `SendResult` from the last send — `response`, `output`
blocks, `toolResults`, `usage` tokens, `ticks`, `stopReason`. Every assertion
above is sugar over it plus the tool-call ledger; when the sugar runs out, read
the raw run.

> [!NOTE]
> Assertions gate `passed`. Scores do not. A score is a number the matrix
> reporter aggregates (mean ± stddev across trials); use `t.expect` when you
> want a verdict and `t.score` when you want a measurement.

### The tool-call ledger

`result.toolCalls` is every dispatched tool the runner observed — name, input,
outcome, result or error, timestamp — folded from the tool-dispatch lifecycle
events by correlating each operation's `requested` and `terminal` phases.
`t.calledTool` / `t.notCalledTool` / `t.noFailedActions` all read it.

```ts
declare const result: import("@agentick/eval").EvalResult;

for (const call of result.toolCalls) {
  console.log(call.name, call.outcome, call.input);
}
for (const a of result.assertions) {
  if (!a.passed) console.error(`FAIL [${a.kind}]: ${a.message}`);
}
```

## Reaching a real app — or a seeded one

The `app` thunk is the only door to the system under test, which means anything
`createApp` accepts is available to an eval. Two shapes cover most of it.

**A real app, swapped per invocation.** Type `O` to whatever you actually vary,
and the call site documents itself:

```tsx
import { createApp } from "@agentick/app/react";
import { defineEval } from "@agentick/eval";
import { openai } from "@agentick/model-openai";

type Overrides = { profile?: "ci" | "prod" };

const myEval = defineEval<Overrides>({
  description: "runs against the cheap model in CI and the real one nightly",
  app: (o) =>
    createApp(<Agent />, {
      model: o?.profile === "ci" ? openai("gpt-4o-mini") : openai("gpt-4o"),
    }),
  async test(t) {
    await t.send("hello");
    t.completed();
  },
});

await myEval({ profile: "ci" });
```

**A fixture-seeded session.** `t.send` opens a fresh session, so "the agent has
already been talking for ten turns" is a genesis concern, not an eval concern —
a literal array in `hydrate` is the fixture seam:

```tsx
import { createApp } from "@agentick/app/react";
import { defineEval } from "@agentick/eval";
import { defineTimeline } from "@agentick/timeline";
import type { TimelineEntry } from "@agentick/spec";

const fixture: TimelineEntry[] = [
  {
    kind: "message",
    message: {
      id: "f1",
      role: "user",
      content: [{ type: "text", text: "I'm on the Pro plan." }],
      ts: 0,
    },
  },
  {
    kind: "message",
    message: { id: "f2", role: "assistant", content: [{ type: "text", text: "Noted." }], ts: 1 },
  },
];

export const remembersContext = defineEval({
  description: "answers plan questions from prior conversation",
  app: () =>
    createApp(<Agent />, {
      model,
      // Genesis runs once per session, before the first render — the eval's
      // first tick already sees the seeded conversation.
      timeline: defineTimeline({ hydrate: async () => fixture }),
    }),
  async test(t) {
    await t.send("Which plan am I on?");
    t.expect("recalled the plan", /pro/i.test(t.result?.response ?? ""));
  },
});
```

Because `hydrate` returns a **seed**, nothing is written back — the fixture
can't accumulate across runs. See
[@agentick/timeline](../timeline) for the genesis contract.

## Matrix sweeps

`.matrix(axes, opts?)` is where one definition becomes a benchmark. It runs the
cartesian product of the axis values, `trials` times per cell.

```ts
import { formatMatrix } from "@agentick/eval";
import { openai } from "@agentick/model-openai";

declare const myEval: import("@agentick/eval").CallableEval<{
  model?: ReturnType<typeof openai>;
}>;

const matrix = await myEval.matrix(
  { model: [openai("gpt-4o-mini"), openai("gpt-4o")] },
  { trials: 5, k: 2, concurrency: 4 },
);

console.log(formatMatrix(matrix));
console.log(matrix.cells[0]?.stats.passRate, matrix.cells[0]?.stats.passAtK);
```

**`trials: N` is the difference between a number and a coin flip.** Agents are
stochastic; a single run's verdict and score are noise. With `trials > 1` each
cell collapses into a distribution — `passRate` (which is `pass@1`), an unbiased
`passAtK`, and per-label `{ mean, stddev, min, max, n }`. So `quality: 0.62`
becomes `0.62 ±0.18 (n=5)`, and a model that passes 2 of 5 stops looking like a
clean 40%.

A cell passes when a **majority** of its trials pass, so one flake no longer
flips the matrix. `passAtK` uses the unbiased estimator
`1 − C(n−c,k)/C(n,k)`, also exported standalone as `passAtK(n, c, k)`.

| Call                         | Cells | Notes                                            |
| ---------------------------- | ----- | ------------------------------------------------ |
| `matrix({})`                 | 1     | Same as `myEval()`; `trials` defaults to 1       |
| `matrix({}, { trials: 20 })` | 1     | One config, 20 samples                           |
| `matrix({ model: [] })`      | 0     | Mathematical product. `passed: true`, vacuous    |
| an axis key absent from `O`  | —     | `undefined` in the cell; the factory's `??` wins |

`concurrency` spans cells × trials and defaults to `1`, so a real-model sweep
doesn't blow a rate limit by surprise.

## Plugins — extending `t`

`t` is extensible the same way the rest of the framework is: an empty
`EvalContextExtensions` seed a package augments to **type** its additions, plus a
factory registered to **wire** them. Attach per-eval with `plugins: [...]` or
globally with `registerEvalPlugin`. Two ship in the box.

**`@agentick/eval/plugins/workspace`** — executable-outcome scoring. This is what
makes coding-agent evals mean anything: grade by running the result.

```ts
import { defineEval } from "@agentick/eval";
import { workspace } from "@agentick/eval/plugins/workspace";

declare const buildApp: () => Promise<import("@agentick/app").AppHarness>;
declare const scratch: string;

defineEval({
  description: "adds a working farewell() export",
  app: buildApp,
  plugins: [workspace({ dir: scratch })],
  async test(t) {
    await t.send("add a farewell export to greeting.js");
    t.expect("exported", (await t.file("greeting.js")).includes("farewell"));
    t.expect("still runs", (await t.sh("node -e \"require('./greeting').greet('x')\"")).ok);
  },
});
```

Point `dir` at the same workspace the app factory pointed the agent's tools at,
and `t.sh` / `t.file` observe exactly what the agent changed.

**`@agentick/eval/plugins/judge`** — model-as-grader. Model-agnostic by
construction: you inject `generate(prompt) => Promise<string>` wired to
whatever you want.

```ts
import { defineEval } from "@agentick/eval";
import { judge } from "@agentick/eval/plugins/judge";

declare const buildApp: () => Promise<import("@agentick/app").AppHarness>;
declare const grade: (prompt: string) => Promise<string>;

defineEval({
  description: "cites its sources",
  app: buildApp,
  plugins: [judge({ generate: grade })],
  async test(t) {
    await t.send("What caused the 2008 crisis?");
    // Records a pass/fail assertion AND a 0..1 score.
    await t.judge("The answer is correct and cites a source.");
  },
});
```

`t.judge` builds the grading prompt from the rubric plus the run's response and
tool names, parses the verdict leniently (JSON first, `PASS`/`FAIL` keyword
fallback), and records both. Override the prompt builder with `judge({ generate,
prompt })`.

**Write your own** by mirroring either: augment the seed, return the methods,
read the run through the plugin's context.

```ts
import { registerEvalPlugin } from "@agentick/eval";

declare module "@agentick/eval" {
  interface EvalContextExtensions {
    withinBudget(limit: { tokens?: number; ticks?: number }): void;
  }
}

registerEvalPlugin((rc) => ({
  withinBudget(limit: { tokens?: number; ticks?: number }) {
    const r = rc.result();
    const ok =
      (limit.tokens === undefined || (r?.usage.totalTokens ?? 0) <= limit.tokens) &&
      (limit.ticks === undefined || (r?.ticks ?? 0) <= limit.ticks);
    rc.record({ label: "within budget", passed: ok });
    rc.score("tokens", r?.usage.totalTokens ?? 0);
  },
}));
```

`rc.result()` is a function, not a value, so a plugin method reads the run at
call time — after `t.send`, not at build time.

## Reporting

```ts
import { formatMatrix, formatResult, renderHtmlReport } from "@agentick/eval";
import { writeFile } from "node:fs/promises";

declare const result: import("@agentick/eval").EvalResult;
declare const matrix: import("@agentick/eval").MatrixResult;

console.log(formatResult(result)); // one-eval scorecard
console.log(formatMatrix(matrix)); // per-cell rows + score aggregation
await writeFile("eval.html", renderHtmlReport(matrix, { title: "Nightly" }));
```

`renderHtmlReport` returns a self-contained, theme-aware page you write to disk,
open, drop in a PR comment, or publish. It renders a summary stat row, a score
heatmap, a cost-vs-quality scatter as inline SVG, and a per-run trajectory
trace. No JavaScript (native `<details>`), no external hosts. Pass
`{ fragment: true }` to emit only `<style>` plus markup for embedding.

## Running the suite

An eval is a plain async function, so there is no runner to adopt. Two postures:

**A script, for real-model runs.** Import the evals, call them, print, exit on
the verdict — the quick start above is already this. Real models cost money and
vary run to run; keep them out of the commit gate and on a schedule.

```bash
tsx src/eval/run.ts                 # one run, scorecard, non-zero on failure
EVAL_MATRIX=1 tsx src/eval/run.ts   # sweep + HTML report
```

**A test file, for deterministic runs.** Point the app factory at a fake
executor and the eval becomes an ordinary spec — fast, hermetic, safe to gate
CI on.

```ts
import { formatResult } from "@agentick/eval";

declare const myEval: import("@agentick/eval").CallableEval<{ fake?: boolean }>;

// The body of an `it(...)` in whatever runner you already have.
const result = await myEval({ fake: true });
if (!result.passed) throw new Error(formatResult(result)); // the scorecard IS the failure message
```

> [!IMPORTANT]
> Don't gate CI on a real model's behavior. Assert mechanics against a fake
> executor; measure behavior with `matrix(..., { trials })` and read the
> distribution.

## API

### `@agentick/eval`

| Export                            | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `defineEval(definition)`          | The entry point. Returns a `CallableEval`                |
| `registerEvalPlugin(plugin)`      | Compose a plugin onto `t` in every run                   |
| `formatResult(result)`            | One-eval console scorecard                               |
| `formatMatrix(matrix)`            | Per-cell console rows + score aggregation                |
| `renderHtmlReport(matrix, opts?)` | Self-contained HTML report                               |
| `passAtK(n, c, k)`                | Unbiased `pass@k` estimator                              |
| `aggregate(values)`               | `{ mean, stddev, min, max, n }`                          |
| `cellStats(trials, k?)`           | Collapse a cell's runs into a distribution               |
| `EvalContextExtensions`           | The augmentation seed for plugin-contributed `t` members |

Definition slots: `description` · `app` · `test` · `plugins`.

### `t` — `EvalContext`

| Member                                     | Purpose                                                       |
| ------------------------------------------ | ------------------------------------------------------------- |
| `t.send(prompt)`                           | Drive one exchange to completion. Returns the response text.  |
| `t.result`                                 | The last `SendResult` — output, tool results, usage, ticks    |
| `t.app`                                    | The app this invocation built, for what `t` doesn't sugar     |
| `t.completed()`                            | Assert the send reached `stopReason: "end"`                   |
| `t.calledTool(name, { input?, isError? })` | Assert a tool ran; optionally deep-equal on input and outcome |
| `t.notCalledTool(name)`                    | Assert a tool did not run                                     |
| `t.noFailedActions()`                      | Assert every observed dispatch succeeded                      |
| `t.expect(label, passed, details?)`        | Record a labeled verdict. Gates `passed`                      |
| `t.score(label, value, details?)`          | Record a number. Does not gate `passed`                       |

### Results

| Type               | Shape                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `EvalResult`       | `description` · `passed` · `assertions` · `scores` · `toolCalls` · `elapsedMs` · `error?` |
| `AssertionResult`  | `kind` · `label?` · `passed` · `message` · `details?`                                     |
| `ScoreResult`      | `label` · `value` · `details?`                                                            |
| `ObservedToolCall` | `name` · `input` · `outcome` · `result?` · `error?` · `at`                                |
| `MatrixResult`     | `cells` · `passed` · `elapsedMs`                                                          |
| `MatrixCell`       | `axes` · `trials` · `stats`                                                               |
| `CellStats`        | `trials` · `passed` · `passRate` · `passAtK?` · `scores`                                  |
| `ScoreAgg`         | `mean` · `stddev` · `min` · `max` · `n`                                                   |

### `EvalRunContext` — what a plugin factory receives

| Member                             | Purpose                                              |
| ---------------------------------- | ---------------------------------------------------- |
| `rc.app`                           | The app under test this run                          |
| `rc.overrides`                     | The resolved overrides handed to the factory         |
| `rc.result()`                      | The live last-send result — a function, read at call |
| `rc.toolCalls`                     | The live dispatch ledger                             |
| `rc.record({ label, passed, … })`  | Push an assertion (contributes to `passed`)          |
| `rc.score(label, value, details?)` | Push a score                                         |

### Plugin subpaths

| Subpath                            | Adds                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `@agentick/eval/plugins/workspace` | `t.sh(cmd, { timeoutMs? })` → `{ ok, code, stdout, stderr }`; `t.file(path)` |
| `@agentick/eval/plugins/judge`     | `t.judge(rubric, { label? })` → `Promise<boolean>`, plus a 0..1 score        |

## Patterns

**Where the app comes from.** [@agentick/app](../app) owns `createApp` and the
session lifecycle an eval drives. The `/react` subpath wires the JSX compiler;
non-React compilers pass their own.

**Deterministic runs.** [@agentick/model-executor](../model-executor) ships
`FakeLanguageModelExecutor`, which takes a scripted sequence of results — pass
it as `modelExecutor` in the app factory and the whole eval is hermetic.

**Fixtures.** [@agentick/timeline](../timeline) owns `defineTimeline` and the
`hydrate` genesis seam an eval seeds conversation state through.

**A worked example.** `example/v2-coding-agent` runs a real coding agent under
`defineEval` with executable scoring, trajectory assertions, a tick budget, and
a judge — plus the runner script the two postures above describe.

## Roadmap & known gaps

- **`t.send` opens a fresh session per call.** Multi-turn state does not carry
  between sends; seed prior conversation through `hydrate` or reach `t.app` and
  drive a session yourself.
- **No `t.onElicit(responder)`.** Human-in-the-loop paths — a coding agent's
  write approval — can't be answered or asserted from an eval, so agents under
  test must run headless.
- **No `t.stubTool(name, impl)`.** Hermetic tool stubs would make a run fast and
  deterministic without a scripted executor; today you fake at the executor.
- **No `t.withinBudget({ tokens, latencyMs, ticks })`.** The raw data is on
  `t.result`; the sugar isn't built (the plugin sketch above is the workaround).
- **No persistence or baselines.** Nothing stores a run per commit or diffs it
  against a committed baseline, so distributions exist but trends don't.
- **No cross-cell significance test.** Whether cell A beats cell B or is inside
  the noise is an eyeball judgement on the stddev today.
- **No cassettes.** Record → freeze → replay so CI reproduces a known-good run
  exactly is not built.
- **No streaming assertions.** Everything is asserted after an exchange
  completes; intermediate deltas aren't reachable.
- **A delivered terminal tool is invisible to the ledger.** Structured output
  arrives through a tool the loop synthesizes rather than dispatches, so
  `t.calledTool` cannot see it. Assert `t.completed()` and read
  `t.result.data` — the framework validated it on the way in.

## Verified by

- `src/__tests__/define-eval.spec.tsx` — the callable shape, `.definition`
  introspection, `t.send` → `t.completed`, `t.calledTool` passing on a matching
  input and failing on a mismatch, `t.notCalledTool`, `t.noFailedActions`, and a
  per-invocation override flowing through the app thunk unchanged.
- `src/__tests__/matrix.spec.tsx` — the cartesian product, axes mirrored onto
  each cell, `trials` collapsing a cell into a distribution, the empty-axes
  (one cell) and empty-axis (zero cells, vacuous pass) edges, aggregate `passed`
  across cells, and `concurrency`.
- `src/__tests__/stats.spec.ts` — `pass@1` equals the pass rate, `pass@k` rises
  with `k` and saturates at the boundaries, `k` clamped to `[1, n]` and `n = 0`
  guarded; `aggregate` mean / population stddev / min / max / n; `cellStats`
  omitting `passAtK` when no `k` is given.
- `src/__tests__/plugins.spec.tsx` — `t.result` exposing the full `SendResult`,
  `t.expect` gating `passed`, `t.score` not gating it, the per-eval plugin seam,
  `workspace` running `t.sh` in its dir and reading through `t.file`, and
  `judge` grading through an injected `generate` while recording both an
  assertion and a score.
- `src/__tests__/html-report.spec.ts` — a self-contained document carrying the
  cells, scores, trajectory, and verdict with no external hosts, and fragment
  mode omitting the skeleton.
- `src/__tests__/structured-output-compliance.example.tsx` — a runnable eval
  rather than a spec (vitest skips it, the typechecker doesn't): the
  compliance measurement for structured output, and the live proof that the
  ledger gap above is real.
