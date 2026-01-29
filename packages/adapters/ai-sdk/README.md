# @tentickle/ai-sdk

Vercel AI SDK adapter for Tentickle.

## Installation

```bash
pnpm add @tentickle/ai-sdk ai @ai-sdk/openai
# or @ai-sdk/anthropic, @ai-sdk/google, etc.
```

## Usage

```tsx
import { AiSdkModel } from '@tentickle/ai-sdk';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';

// OpenAI
<AiSdkModel
  model={openai('gpt-5.2')}
  providerOptions={{
    apiKey: process.env.OPENAI_API_KEY,
  }}
/>

// Anthropic
<AiSdkModel
  model={anthropic('claude-3-5-sonnet-20241022')}
/>

// With options
<AiSdkModel
  model={openai('gpt-5.2')}
  temperature={0.7}
  maxTokens={4096}
/>
```

## Supported Providers

Any provider supported by the [Vercel AI SDK](https://sdk.vercel.ai/providers):

- OpenAI (`@ai-sdk/openai`)
- Anthropic (`@ai-sdk/anthropic`)
- Google (`@ai-sdk/google`)
- Mistral (`@ai-sdk/mistral`)
- Cohere (`@ai-sdk/cohere`)
- And more...

## Documentation

See the [full documentation](https://rlindgren.github.io/tentickle).
