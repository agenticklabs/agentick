---
"@agentick/loop-executor": minor
"@agentick/model-google": minor
---

Tool calls continue the loop — whatever the provider called its stop reason.

Every Gemini tool call ended its execution. The tool ran, its result was
dispatched and persisted, the model never saw it, and the turn finished as if it
had answered. The user had to send a second message to make the agent look at what
it had just fetched, which is how a working agent reads as a broken one:

> **user:** show me my latest time entries
> **assistant:** _(calls `resource_read`)_ — turn ends
> **user:** so you're trying?
> **assistant:** Yes! I've successfully retrieved your user profile…

The continuation disposition was:

```ts
const provisionalContinue = result.stopReason === "tool_use" && tickToolResults.length > 0;
```

which made a loop invariant a property of each adapter's vocabulary. Three
adapters report tool use — anthropic natively, openai as `tool_calls`, ai-sdk as
`tool-calls` — so three worked. **Gemini has no tool-use finish reason at all:** a
candidate carrying `functionCall` parts still reports `finishReason: "STOP"`, which
normalizes to `"end"`. One provider silently broken, and no provider-agnostic test
could see it, because the fixtures that drive the loop set `stopReason` themselves.

## The loop keys on the calls

```ts
const provisionalContinue = (result.toolCalls?.length ?? 0) > 0 || tickToolResults.length > 0;
```

A tick that asked for tools has not finished answering. Either results are waiting
for a model that has never seen them, or the calls produced nothing and the model
is owed that fact. Ending there strands work that already happened and already
cost money.

This is safe as an unconditional disposition because it is the LOWEST tier of the
tick-end resolution: a terminal tool call (`terminalCapture`) and a gate `stop`
both short-circuit it to `false` before it is read, and `maxTicks` bounds it
either way. So it never overrides a deliberate stop — it only stops the loop
inventing one out of a provider's finish word.

## And the adapter stops lying

`@agentick/model-google` now reports the canonical `"tool_use"` when a candidate
carries function calls and Gemini said `STOP`, on both the streaming and
non-streaming paths. Translating provider vocabulary is the adapter's whole job,
so the correction belongs there and not in every consumer. It deliberately does
NOT overwrite a non-`STOP` finish reason: `MAX_TOKENS` with a partial call is a
truncation, and reporting `tool_use` would hide that the call may be incomplete.

Verified: the loop runs a second tick on a `stopReason: "end"` tick that carried
calls and still stops after a tick with none (`loop-executor`), and the adapter
reports `tool_use` on both paths, `end` for an ordinary answer, and `max_tokens`
for a truncated call (`model-google`).
