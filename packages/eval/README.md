# @agentick/eval

Testing-shaped eval framework for Agentick (v1). `defineEval(...)` returns a
callable with runtime parameterization; `.matrix(axes)` runs cartesian
parameter sweeps — the same inputs and expectations across multiple models —
and reports per-cell results.

Port of `@agentick/eval-next` (packages-next/eval) onto v1 core APIs, with
two extensions: `t.send` accepts content blocks (documents/images), and
`t.expect(...)` records custom assertions for expected-output scoring.

```ts
import { defineEval } from "@agentick/eval";

const billEval = defineEval<{ model?: string }>({
  description: "bill extraction against known fixtures",
  app: async (o) => createMyExtractorApp({ model: o?.model ?? "google/gemini-2.5-flash" }),
  test: async (t) => {
    await t.send([fileBlock, { type: "text", text: "Extract the bill." }]);
    t.completed();
    t.calledTool("submit_extraction");
    t.noFailedActions();

    const submitted = t.lastToolCall("submit_extraction")?.input as Record<string, unknown>;
    t.expect("subtotal matches", Number(submitted?.SubTotal) === 187.5, {
      details: { got: submitted?.SubTotal, want: 187.5 },
    });
  },
});

// One run with factory defaults:
const result = await billEval();

// The same document + expectations across models:
const sweep = await billEval.matrix(
  { model: ["google/gemini-2.5-flash", "bedrock/us.amazon.nova-2-lite-v1:0"] },
  { concurrency: 1 },
);
for (const cell of sweep.cells) {
  console.log(cell.axes.model, cell.result.passed, `${cell.result.elapsedMs}ms`);
}
```

Key properties:

- **Fresh app per invocation** — the `app` thunk runs once per eval call /
  matrix cell, so state never leaks between runs.
- **Assertions record, never throw** — every failure shows up in one report;
  check `result.passed` for fail-fast behavior.
- **Tool observation built in** — every `tool_call`/`tool_result` pair from
  the send handle's event stream lands in `result.toolCalls`, queryable via
  `t.lastToolCall(name)`.
- **Sequential by default** — `matrix` runs cells one at a time unless you
  raise `concurrency`, so real-model sweeps don't blow rate limits.
- **Input/expected pairs ride one axis value** — never separate axes, or the
  product mismatches them. Attach the pair to the per-invocation app in the
  factory and read it from `t.app` in the test body (see /docs/evals).

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
    for (const cell of sweep.cells) console.log(cell.axes.model, cell.result.passed, cell.result.elapsedMs);
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

See the website docs (`/docs/evals`) for the full guide.
