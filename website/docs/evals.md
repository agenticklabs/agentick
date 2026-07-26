# Evals

`@agentick/eval` is a testing-shaped eval framework: define an eval once — an
app factory, a driving script, and assertions — and run it with different
parameters at call time. The headline feature is `.matrix(axes)`: run the
**same inputs and the same expectations across multiple models** (or any other
axis) and compare per-cell results.

```ts
import { defineEval } from "@agentick/eval";
```

## Defining an eval

An eval is three things: a description, an **app factory**, and a **test body**.

```ts
const billEval = defineEval<{ model?: string }>({
  description: "bill extraction against known fixtures",

  // Fresh app per invocation — state never leaks between runs or matrix cells.
  // The factory owns interpreting overrides; the eval package does no merging.
  app: async (o) =>
    createExtractorAgent(
      { ...billProfile, model: resolveModel(o?.model ?? "google/gemini-2.5-flash") },
      { maxTicks: 6 },
    ),

  test: async (t) => {
    // t.send accepts a string, or content blocks for documents/images:
    await t.send([fileBlock, { type: "text", text: "Extract the bill." }]);

    t.completed();
    t.calledTool("submit_extraction");
    t.noFailedActions();

    // Score against expected output — read the submit tool's payload:
    const got = t.lastToolCall("submit_extraction")?.input as Record<string, unknown>;
    t.expect("subtotal matches", Number(got?.SubTotal) === 187.5, {
      details: { got: got?.SubTotal, want: 187.5 },
    });
  },
});
```

Invoke it like a function:

```ts
const result = await billEval(); // factory defaults
const result2 = await billEval({ model: "bedrock/us.amazon.nova-2-lite-v1:0" });

result.passed; // every assertion held
result.assertions; // each one, with a message and details
result.toolCalls; // every observed tool call: name, input, outcome, result
result.elapsedMs;
```

## The matrix: multi-model comparison

`.matrix(axes)` runs the cartesian product of axis values — one eval run per
combination, each with a fresh app:

```ts
const sweep = await billEval.matrix(
  {
    model: [
      "google/gemini-2.5-flash",
      "bedrock/us.amazon.nova-2-lite-v1:0",
      "bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0",
    ],
  },
  { concurrency: 1 }, // sequential by default — protects rate limits
);

sweep.passed; // true iff every cell passed
for (const cell of sweep.cells) {
  console.log(
    cell.axes.model,
    cell.result.passed ? "PASS" : "FAIL",
    `${cell.result.elapsedMs}ms`,
    cell.result.assertions.filter((a) => !a.passed).map((a) => a.message),
  );
}
```

Axes compose: `{ model: [...], fixture: [...] }` runs every model against
every fixture. An empty axis array yields zero cells (mathematical product);
empty axes `{}` yields exactly one cell.

**Input/expected pairs ride ONE axis value.** Never split a document and its
expected output into separate axes — the cartesian product would score
document A against document B's expectations. Make the axis value the pair:

```ts
interface BillFixture {
  name: string;
  fileBlock: unknown;
  expected: Expected;
}

const sweep = await billEval.matrix({
  fixture: [acmeFixture, metroFixture], // pairs — document + expectations together
  model: ["google/gemini-2.5-flash", "bedrock/us.amazon.nova-2-lite-v1:0"],
});
```

Overrides reach the app factory, not the test body — so when assertions need
the pair, attach it to the per-invocation app and read it back from `t.app`
(one app per cell, so this is concurrency-safe):

```ts
app: async (o) => {
  const app = createMyAgent({ model: resolve(o?.model) });
  (app as any).__fixture = o?.fixture ?? defaultFixture;
  return app;
},
test: async (t) => {
  const { fileBlock, expected } = (t.app as any).__fixture;
  await t.send([fileBlock, { type: "text", text: "Extract it." }]);
  // ... t.expect against `expected`
},
```

For document-extraction pipelines the pattern is: one `defineEval` per
document/expected pair (or a fixture axis), a `model` axis across providers,
and `t.expect` assertions comparing the submitted extraction field-by-field
against the expected values.

## Running evals

Evals are plain TypeScript — there is no dedicated CLI. The two common
harnesses:

**As a test (recommended).** Wrap the eval in your test runner behind an
explicit opt-in so ordinary test runs never spend model tokens:

```ts
// bill-extraction.eval.spec.ts
const liveDescribe = process.env.OCR_LIVE === "1" ? describe : describe.skip;

liveDescribe("bill extraction eval", () => {
  jest.setTimeout(600_000);
  it("matrix across models", async () => {
    const sweep = await billEval.matrix({ model: MODELS });
    for (const cell of sweep.cells)
      console.log(cell.axes.model, cell.result.passed, cell.result.elapsedMs);
    expect(sweep.passed).toBe(true);
  });
});
```

```sh
OCR_LIVE=1 pnpm jest --testPathPattern my-suite.eval
```

CJS test runners (jest/ts-jest) need two extras, because this package is
ESM-only: load it via a native dynamic import that the transpiler can't
downlevel to `require` —

```ts
const importEsm = new Function("s", "return import(s)") as (s: string) => Promise<any>;
const { defineEval } = await importEsm("@agentick/eval");
```

— and run node with `NODE_OPTIONS=--experimental-vm-modules` so jest's VM
allows the dynamic import. ESM-native runners (vitest) import normally and
need neither.

**As a script.** `defineEval` returns a plain async callable, so a script
that runs it and prints `MatrixResult` works anywhere node does:

```sh
npx tsx run-evals.ts   # or node dist/run-evals.js
```

Exit non-zero on `!sweep.passed` to gate CI on eval regressions.

## Assertions

Assertions **record, never throw** — every failure shows up in one report,
and a broken expectation doesn't mask the ones after it.

| Assertion                                        | Checks                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `t.completed()`                                  | the most recent `t.send` finished without an error event         |
| `t.calledTool(name, { input?, isError? })`       | a matching tool call was observed (input deep-equals when given) |
| `t.notCalledTool(name)`                          | the tool was never called — safety evals                         |
| `t.noFailedActions()`                            | no observed tool call failed                                     |
| `t.expect(name, passed, { message?, details? })` | anything else — your own comparison, recorded with a name        |

`t.lastToolCall(name)` returns the most recent observed call with that name —
the usual way to read a submit tool's payload for expected-output scoring.

## Escape hatch

`t.app` is the app the factory built for this invocation, for anything the
`t` surface doesn't sugar (custom sessions, knob inspection, multi-session
evals). Use sparingly — the rest of `t` is the supported surface.
