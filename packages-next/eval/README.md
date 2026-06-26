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
| 2         | `.matrix(axes, { concurrency? })` parameter sweeps              | shipped |
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

| Method                            | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `t.app`                           | The `AppHarness` constructed by `definition.app(overrides)`.           |
| `t.send(prompt)`                  | Drive the agent. Returns the final response text.                      |
| `t.completed()`                   | Assert the most-recent send reached `stopReason: "end"`.               |
| `t.calledTool(name, { input?, isError? })` | Assert a specific tool was called; optionally deep-equal on `input` and outcome.   |
| `t.notCalledTool(name)`           | Assert a specific tool was NOT called. Critical for safety evals.      |
| `t.noFailedActions()`             | Assert every observed tool call's `outcome === "succeeded"`.           |

Assertions record into `result.assertions[]` rather than throwing.
Adopters who want fail-fast check `result.passed` and decide whether
to continue.

### `EvalResult`

```ts
interface EvalResult {
  description: string;
  passed: boolean;
  assertions: AssertionResult[];
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

### Matrix sweeps

`.matrix(axes, opts?)` runs the cartesian product of axis values.
One cell per combination; `passed` aggregates AND across cells.

```ts
const matrix = await calculatorAgent.matrix(
  {
    executor: [openaiExec, anthropicExec],
    promptVariant: ["concise", "verbose"],
  },
  { concurrency: 4 },   // default 1 — sequential — to avoid rate-limit blowups
);

console.log(`${matrix.cells.filter((c) => c.result.passed).length} / ${matrix.cells.length}`);
for (const cell of matrix.cells) {
  console.log(cell.axes, cell.result.passed);
}
```

Edge cases:
- `matrix({})` → 1 cell (equivalent to `myEval()`)
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

## Roadmap & known gaps

- **`t.judge(rubric)`** — LLM-as-judge. Subordinate Agentick session
  scores the primary's transcript against an explicit rubric.
- **Tool stubs** — `t.stubTool("name", fakeImpl)` for hermetic runs.
- **Fixtures / cassettes** — record-mode produces a deterministic
  trace; replay-mode plays it back so CI matches a known-good run
  exactly. Wire via `executor: replayExecutor(...)`.
- **Cost accounting** — per-invocation token + latency budgets;
  assertion sugar (`t.withinBudget({ tokens, latencyMs })`).
- **Streaming evals** — assertions against intermediate `delta`
  events (not just terminal outcomes).
