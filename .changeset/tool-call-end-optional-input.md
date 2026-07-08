---
"@agentick/core": patch
---

`AdapterDelta`'s `tool_call_end` variant now types `input` as optional. Nullish means "parse the JSON accumulated from `tool_call_delta` chunks" — the contract the stream accumulator already implements. Adapters must not pass placeholder values (a non-nullish `{}` overrides the accumulated arguments).
