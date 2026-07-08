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

See the website docs (`/docs/evals`) for the full guide.
