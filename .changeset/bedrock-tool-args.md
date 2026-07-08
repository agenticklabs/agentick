---
"@agentick/bedrock": patch
"@agentick/google": patch
---

Fix Bedrock tool calls arriving with empty arguments, and prefer enriched JSON Schema for tool specs in both adapters.

Two bugs, one visible symptom (Converse models calling tools with `{}`):

- **bedrock**: the stream mapper emitted `tool_call_end` with a hardcoded `input: {}`. The core stream accumulator uses `delta.input ?? parse(accumulatedJson)`, so the non-nullish empty object discarded every argument the `toolUse` deltas had streamed. The end event no longer carries `input`, letting the accumulator parse the accumulated JSON.
- **bedrock + google**: `mapToolDefinition`'s `{name, input}` branch shipped `input` — potentially a raw Zod schema — as the provider tool schema, ignoring the pre-converted JSON Schema that core's `enrichMetadata` places on `inputSchema`. Both adapters now prefer `inputSchema` when present. (Gemini often masked this by inferring fields from tool descriptions; Bedrock models got an uninterpretable schema.)
