# `@agentick/executor-anthropic-next`

Anthropic provider adapter for Agentick v2. Implements
`LanguageModelExecutor` from `@agentick/spec-next` against the
[`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript)
Messages API.

**Status:** scaffolded; executor body lands in the next commit. See
[`docs/proposals/v2/anthropic-adapter-plan.md`](../../docs/proposals/v2/anthropic-adapter-plan.md).

## Quick start (planned)

```ts
import { createApp } from "@agentick/core";
import { anthropic } from "@agentick/executor-anthropic-next";

const app = await createApp(<Agent />, {
  executor: anthropic("claude-3-5-sonnet-latest", {
    apiKey: process.env.ANTHROPIC_API_KEY,
    stream: true,
  }),
});
```

## Options (planned)

See `AnthropicExecutorOptions` in `src/anthropic-executor.ts`. Highlights:

- `model`, `apiKey`, `baseURL`, `headers`, `timeout`, `maxRetries`, `maxTokens`
- `anthropicVersion`, `betas` — header overrides
- `stream`, `parseThinkTags`, `customBlocks`
- `target` — override capability metadata

Environment variable fallbacks: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`.

## Provider-specific knobs (`target.providerOptions.anthropic`)

- `top_k`, `stop_sequences`, `metadata.user_id`
- `thinking: { type: "enabled", budget_tokens }` — extended thinking
- `tool_choice` — `auto` / `any` / `tool` / `none`
- `cacheControl: ["system" | "tools" | "last-message"]` — prompt-caching marker placement
- Arbitrary additional fields spread onto the request body

## Capabilities

| Model family            | contextWindow | maxOutputTokens  | vision | reasoning |
| ----------------------- | ------------- | ---------------- | ------ | --------- |
| Claude 3.5 Sonnet       | 200K          | 8K               | yes    | no        |
| Claude 3.5 Haiku        | 200K          | 8K               | no     | no        |
| Claude 3.7 Sonnet       | 200K          | 8K (64K w/ beta) | yes    | yes       |
| Claude 3 Opus           | 200K          | 4K               | yes    | no        |
| Claude 3 Sonnet / Haiku | 200K          | 4K               | yes    | no        |

## Limitations

- `frequencyPenalty` / `presencePenalty` are silently dropped — Anthropic doesn't expose them.
- `responseFormat` is silently dropped — Anthropic has no JSON-schema response mode (use tool-use instead).
- Multi-turn extended-thinking + tools: signature plumbing is opaque executor-side state, not surfaced on the projected message shape. See implementation plan §10.4.
