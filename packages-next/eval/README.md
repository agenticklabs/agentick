# @agentick/eval-next

Testing-shaped eval framework for Agentick v2. A single eval definition
becomes a **callable function** with runtime parameterization — model
swaps, fixture injection, tool stubs, environment overrides — so the
same definition feeds CI smoke tests, A/B sweeps, and matrix runs
without duplication.

Inspired by Eve evals. Agentick twist: `defineEval(…)` returns a
**function**, not a config. Iteration 1 (MVP) lands the assertion
surface; iteration 2+ layers matrix sweeps, LLM-as-judge,
cost accounting, and cassette replay.

> Pre-1.0. See [ADR 37](../../docs/proposals/v2/blueprint/37-eval-package-sketch.md)
> for the long-form sketch and the iteration roadmap.

## Status

| Iteration | Surface                                                         | State   |
| --------- | --------------------------------------------------------------- | ------- |
| 1 (MVP)   | `defineEval` + `t.send/completed/calledTool/notCalled/noFailed` | shipped |
| 2         | `.matrix(axes)` parameter sweeps                                | planned |
| 3         | `t.judge(...)` LLM-as-judge                                     | planned |
| 4         | Tool stubs, fixtures, cost accounting                           | planned |
| 5         | Cassette replay (record → freeze → replay)                      | planned |

## Quick start

```ts
import { defineEval } from "@agentick/eval-next/react";

const calculatorAgent = defineEval({
  description: "agent reaches for the calculator on arithmetic",
  rootElement: <MyAgent />,
  executor: realOrFakeExecutor,
  target: { kind: "language-model", provider: "openai", modelId: "gpt-4o" },

  async test(t) {
    await t.send("What is 47 × 23?");
    t.completed();
    t.calledTool("calculator", { input: { expression: "47 * 23" }, isError: false });
    t.noFailedActions();
  },
});

// Run with definition defaults
const result = await calculatorAgent();

// Run with overrides — model swap for A/B
const cheap = await calculatorAgent({ executor: gpt4oMiniExecutor });
```

`defineEval` returns a **callable**: `await myEval()` runs with the
definition defaults; `await myEval({ executor: X, target: Y })`
overrides any `createApp` slot for one invocation. The original
definition is exposed at `myEval.definition` for tooling and future
matrix-runner extensions.

## Subpaths

- **`@agentick/eval-next`** — reconciler-agnostic. Adopter supplies
  the reconciler. Right pick if you ship a non-React reconciler
  (Angular, custom AST, etc.).
- **`@agentick/eval-next/react`** — defaults `reconciler` to
  `reactReconciler()` from `@agentick/reconciler-react-next`. Most
  JSX-agent adopters land here.

## API

### `defineEval(definition)`

Returns a `CallableEval`. The definition extends `CreateAppOptions`
(everything `createApp` takes) plus eval-specific fields:

| Field         | Type                          | Notes                                                                |
| ------------- | ----------------------------- | -------------------------------------------------------------------- |
| `description` | `string`                      | Surfaces in `result.description` and result reports.                 |
| `rootElement` | `unknown`                     | Agent root passed to `createApp`. Reconciler interprets the shape.   |
| `test`        | `(t: EvalContext) => unknown` | Eval body. Assertions record into the result ledger; they don't throw. |

Every other slot (`executor`, `target`, `reconciler`, `tools`,
`metadata`, …) maps 1:1 to `createApp`.

### `t` — `EvalContext`

| Method                            | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `t.app`                           | Direct `AppHarness` handle. Use sparingly.                             |
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

- `src/__tests__/define-eval.spec.tsx` — MVP shape (callable, defs,
  `calledTool` / `notCalledTool` / overrides).
- `src/__tests__/react-subpath.spec.tsx` — `/react` subpath defaults
  reconciler to `reactReconciler()`; honors explicit override.

## Roadmap & known gaps

- **`.matrix(axes)`** — combinatorial parameter sweeps (model × prompt
  × fixture). Returns one `EvalResult` per cell.
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
