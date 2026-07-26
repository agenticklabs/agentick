# Structured Outputs

**Ask for a shape. Get a typed, validated value back.**

Hand `session.send` an `output` schema and the final turn comes back as
`data` — parsed, validated, and typed to your schema. No "reply in JSON"
prompt, no regex, no hoping the model closed its braces.

```ts
import { z } from "zod";

const { data } = await (
  await session.send({
    messages: [{ role: "user", content: "Summarize this ticket." }],
    output: z.object({
      title: z.string(),
      priority: z.enum(["low", "medium", "high"]),
      tags: z.array(z.string()),
    }),
  })
).result;

data.priority; // ← "high"   (typed as "low" | "medium" | "high")
```

`data` is typed from the schema. If the model's answer doesn't fit the
schema, the send **rejects** with a typed error instead of handing you a
malformed object — errors over nulls, always.

## The idea: "done" and "shaped" are the same event

Most frameworks bolt structured output on as a _generation-time text
constraint_ — "make every token conform to this JSON Schema." That works
for a one-shot call, but it fights a real agent: it strangles the model's
narration on tool-using turns, only some providers support it, and it
never actually ties **being finished** to **emitting the shape**.

Agentick takes the other road. When your turn has tools, it injects a
**terminal tool** whose input schema _is_ your output schema. The model
calls it to deliver the final answer — and that call **is** the completion
event.

::: tip Why this is better
Delivering the answer and finishing the turn become one action. Validation
is free (every provider constrains tool arguments natively — yes, including
Anthropic), and the model keeps its full voice on every other tick.
:::

You don't wire any of this up. You pass `output`; the framework picks the
strategy, injects the tool, captures the answer, validates it, and hands
you `data`.

## Two ways to ask

|                   | `SendInput.output`        | `<Output>`                                   |
| ----------------- | ------------------------- | -------------------------------------------- |
| Scope             | **This** execution        | **Every** execution of the agent             |
| Where             | On the `send()` call      | In the agent tree                            |
| Reach for it when | A one-off structured turn | A dedicated extraction agent, a skill runner |
| Precedence        | **Wins** over `<Output>`  | The ambient default                          |

### Per-send: `output`

The one-off. Ask this turn to produce a shape:

```ts
const { data } = await (await session.send({ messages, output: mySchema })).result;
```

### Per-agent: `<Output>`

Declare "every run of this agent produces this shape" right in the tree —
ideal for extraction agents, skill runners, and forks:

```tsx
import { Output } from "@agentick/compiler-react-next";

function Extractor() {
  return (
    <>
      <System>Extract the invoice fields from the attached document.</System>
      <Output
        schema={z.object({
          vendor: z.string(),
          total: z.number(),
          dueDate: z.string(),
        })}
      />
    </>
  );
}
```

A per-send `output` overrides the tree declaration — explicit beats
ambient, the same rule as everywhere in agentick.

## Prose _and_ data in one turn

You don't have to choose between a human-readable answer and a typed one.
When the model writes a sentence alongside its terminal call — providers
allow both in one assistant turn — the prose lands in `response` and the
validated shape in `data`, in the **same turn, zero extra ticks**:

```ts
const { response, data } = await (
  await session.send({ messages, output: reportSchema, tools })
).result;

response; // "I found three anomalies worth flagging — details below."
data; //     { anomalies: [ … ] }   ← typed + validated
```

When the answer arrives this way, `stopReason` is `"output_delivered"` —
the turn ended because your declared output was delivered, not because a
tool call is pending.

## The guarantee ladder

Structured output is a chain of three guarantees, weakest-first — and the
docs are honest about which rung you're standing on:

1. **The natural path.** The terminal tool's presence and description
   ("call this when the task is complete with the final answer") usually
   elicit the call on its own. Whether a given model does so _unforced_ is
   model behavior — measure it with [`@agentick/eval-next`](/docs/evals),
   never assume it.
2. **The forced wrap-up (a hard guarantee).** If the model finishes
   _without_ delivering, the loop runs **one** more tick with
   `toolChoice` pinned to the terminal tool. The provider cannot respond
   without calling it, and the arguments are constrained to your schema.
   This is deterministic loop machinery — not a retry prompt.
3. **The typed failure (the honest floor).** If there's genuinely no room
   to force a wrap-up (you hit `maxTicks`), the send rejects with
   `StructuredOutputIncomplete`. If the delivered value doesn't satisfy
   the schema, it rejects with `ResponseValidationError` (carrying the
   `issues` and the `raw` value). You never get an unvalidated `data`.

::: info The provider gap, erased
Plain JSON-mode is strictly weaker: Anthropic and some adapters drop it
entirely, so "structured output" silently degrades to a best-effort hint.
The terminal-tool strategy leans on tool-argument constraints, which
**every** provider supports — so the guarantee holds across all of them.
:::

## Bare sends fall back to JSON mode — automatically

If a turn has **no tools**, there's nothing for a terminal tool to sit
beside, so agentick uses a plain `responseFormat` directive instead
(constrained decoding — this is `generateObject`'s home turf) and
validates the final text into `data`. You get the same `output` → `data`
ergonomics; the framework just picks the right mechanism per send.

Want to pin the choice? Set `strategy` on a tree-level `<Output>`:

```tsx
<Output schema={mySchema} strategy="tool" /> // or "responseFormat", default "auto"
```

## Built for skills to compose on

`output` is a **primitive**, deliberately thin — the framework ships the
mechanism and a good default, not a policy. Higher-level ergonomics build
on top of it.

The flagship is [`skills`](/docs/skills): `session.skills.run(name, {
output })` (landing next) is a skill's guidance plus a typed result in one
call — the skill guides the work, `output` shapes the result. Same
primitive, composed. You can write that composition yourself today:
`require` the skill, `send` its guidance with your `output` schema, read
`data`.

## Live schema vs. wire-safe directive

Two forms, one for each side of the wire:

- **`output` (live, in-process).** A `StandardSchemaV1` — Zod, Valibot,
  ArkType, `jsonSchema(...)`. A validator is a runtime function, so it
  **cannot cross the wire**; `output` is an in-process API. It's what
  produces the validated `SendResult.data`.
- **`responseFormat` (declarative, wire-safe).** The JSON-shaped directive
  the compiled tree already carries. Fully serializable — it rides
  `session/send` unchanged, so wire clients declare `responseFormat` and
  parse the returned text themselves.

::: warning Steering can't carry a shape
A steer (`onBusy: "steer"`) joins an **in-flight** turn — it has no final
turn of its own to shape. A structured send with an unset `onBusy` resolves
to `"queue"` under the smart default, so it never steers: it waits for
quiescence, then runs as its own fresh execution. Only an **explicit**
`onBusy: "steer"` carrying `output` or `responseFormat` while racing an
in-flight execution is rejected with `SteerCannotCarryStructuredOutput` —
omit `onBusy` (or set `onBusy: "queue"`) to queue it instead.
:::

## When to reach for it — and when not

Reach for structured output when you need a value your code will **act
on**: routing a ticket, extracting fields, a review verdict, anything that
feeds the next step programmatically.

Skip it when you just want text back — a chat reply, an explanation, a
draft. Wrapping prose in `{ "text": "…" }` buys nothing. And it isn't a
parser for arbitrary model output: the schema shapes _the model's own
delivery_, it doesn't post-process whatever the model happened to say.

## Errors reference

| Error                              | When                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ResponseValidationError`          | The delivered value failed the schema (carries `issues` + `raw`).                                      |
| `StructuredOutputIncomplete`       | No terminal call and no room to force a wrap-up (hit `maxTicks`).                                      |
| `TerminalToolNameCollision`        | A tree tool shares the terminal tool's name (default `submit_result`).                                 |
| `MultipleStructuredOutputs`        | The tree declares 2+ `<Output>`s — one execution, one shape.                                           |
| `SteerCannotCarryStructuredOutput` | An explicit `onBusy: "steer"` carried `output` / `responseFormat` while racing an in-flight execution. |

## What it does _not_ do (yet)

Honest edges, so you know where the floor is:

- **Anthropic + ai-sdk `responseFormat`.** On a _bare_ send those adapters
  drop the directive (`TODO(trail-anthropic-structured)`); validation
  still catches non-adherence. Tool-using turns are unaffected — that's the
  terminal-tool path, which every provider honors.
- **One shape per execution.** Multi-output extraction isn't supported yet;
  declare a single shape.
- **No repair loop.** A validation failure rejects; a cheap-model repair
  round is a tracked follow-up (`TODO(trail-object-repair)`), not today.

---

**See also:** [Sessions & Execution](/docs/sessions-and-execution) ·
[Skills](/docs/skills) · [Evals](/docs/evals) · [Tools](/docs/tools)
