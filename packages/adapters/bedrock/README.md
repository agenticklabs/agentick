# @agentick/bedrock

AWS Bedrock Converse API adapter for Agentick.

## Installation

```bash
pnpm add @agentick/bedrock @aws-sdk/client-bedrock-runtime
```

## Usage

### Factory Pattern (Recommended)

```tsx
import { bedrock } from "@agentick/bedrock";
import { createApp } from "@agentick/core";

const model = bedrock("us.anthropic.claude-sonnet-4-20250514-v1:0");

// Use with createApp
const app = createApp(MyAgent, { model });
const session = await app.session();
await session.run({ messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }] });

// Or with config object
const model = bedrock({
  model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
  region: "us-east-1",
  maxTokens: 8192,
});
```

### JSX Component Pattern

```tsx
import { BedrockModel } from "@agentick/bedrock";

function MyAgent() {
  return (
    <BedrockModel model="us.anthropic.claude-sonnet-4-20250514-v1:0" maxTokens={4096}>
      <System>You are helpful.</System>
      <Timeline />
    </BedrockModel>
  );
}
```

## Features

- **Streaming** - Full streaming support via ConverseStream
- **Tool calling** - Native tool use support
- **Multi-model** - Claude, Nova, Llama, Mistral, and more via Bedrock
- **S3 image support** - Image and document understanding
- **Guardrails** - Bedrock Guardrails integration

## Configuration

| Option            | Type                    | Description                                          |
| ----------------- | ----------------------- | ---------------------------------------------------- |
| `model`           | `string`                | Model ID (e.g., `us.anthropic.claude-sonnet-4-20250514-v1:0`) |
| `region`          | `string?`               | AWS region (env: `AWS_REGION`)                        |
| `credentials`     | `object?`               | Explicit `{ accessKeyId, secretAccessKey, sessionToken? }` |
| `profile`         | `string?`               | AWS profile name for credential chain                 |
| `client`          | `BedrockRuntimeClient?` | Pre-configured client instance                        |
| `maxTokens`       | `number?`               | Maximum tokens to generate                            |
| `customBlocks`    | `object?`               | Custom block definitions to intercept from output     |
| `deltaTransform`  | `function?`             | User-facing delta transform                           |

### Guardrails

```tsx
const model = bedrock({
  model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
  providerOptions: {
    bedrock: {
      guardrailConfig: {
        guardrailIdentifier: "my-guardrail-id",
        guardrailVersion: "1",
      },
    },
  },
});
```

## AWS Authentication

The adapter uses the standard AWS credential chain. Configure via any of:

| Method            | Description                           |
| ----------------- | ------------------------------------- |
| Environment vars  | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` |
| AWS profile       | `profile` option or `AWS_PROFILE` env var |
| IAM role          | EC2/ECS/Lambda instance role          |
| Explicit          | `credentials` config option           |

## Environment Variables

| Variable                  | Description              |
| ------------------------- | ------------------------ |
| `AWS_REGION`              | AWS region               |
| `AWS_DEFAULT_REGION`      | Fallback region          |
| `AWS_ACCESS_KEY_ID`       | AWS access key           |
| `AWS_SECRET_ACCESS_KEY`   | AWS secret key           |
| `AWS_SESSION_TOKEN`       | Session token (optional) |
| `AWS_PROFILE`             | Named profile            |

## Model IDs

```
# Claude
us.anthropic.claude-opus-4-20250514-v1:0
us.anthropic.claude-sonnet-4-20250514-v1:0
anthropic.claude-3-5-sonnet-20241022-v2:0
anthropic.claude-3-5-haiku-20241022-v1:0

# Amazon Nova
amazon.nova-pro-v1:0
amazon.nova-lite-v1:0
amazon.nova-micro-v1:0

# Meta Llama
meta.llama3-1-70b-instruct-v1:0
```

## Exports

- `bedrock(configOrModel)` - Factory function returning `ModelClass`
- `createBedrockModel(config)` - Same as `bedrock()`
- `BedrockModel` - JSX component for declarative usage
