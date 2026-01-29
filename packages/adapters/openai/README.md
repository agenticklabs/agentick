# @tentickle/openai

Direct OpenAI adapter for Tentickle.

## Installation

```bash
pnpm add @tentickle/openai
```

## Usage

```tsx
import { OpenAIModel } from '@tentickle/openai';

<OpenAIModel
  apiKey={process.env.OPENAI_API_KEY}
  model="gpt-5.2"
  temperature={0.7}
  maxTokens={4096}
/>

// With custom base URL (Azure, etc.)
<OpenAIModel
  apiKey={process.env.AZURE_OPENAI_KEY}
  baseURL="https://your-resource.openai.azure.com"
  model="gpt-5.2"
/>
```

## Configuration

| Prop          | Type      | Description                  |
| ------------- | --------- | ---------------------------- |
| `apiKey`      | `string`  | OpenAI API key               |
| `model`       | `string`  | Model name (e.g., `gpt-5.2`) |
| `baseURL`     | `string?` | Custom API endpoint          |
| `temperature` | `number?` | Sampling temperature         |
| `maxTokens`   | `number?` | Maximum tokens               |

## Documentation

See the [full documentation](https://rlindgren.github.io/tentickle).
