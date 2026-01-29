# @tentickle/google

Google AI / Vertex AI adapter for Tentickle.

## Installation

```bash
pnpm add @tentickle/google
```

## Usage

```tsx
import { GoogleModel } from '@tentickle/google';

// Google AI Studio
<GoogleModel
  apiKey={process.env.GOOGLE_API_KEY}
  model="gemini-3-flash"
/>

// Vertex AI
<GoogleModel
  vertexai={true}
  project={process.env.GCP_PROJECT_ID}
  location="us-central1"
  model="gemini-3-flash"
  googleAuthOptions={{
    credentials: JSON.parse(process.env.GCP_CREDENTIALS),
  }}
/>
```

## Configuration

| Prop                | Type       | Description              |
| ------------------- | ---------- | ------------------------ |
| `model`             | `string`   | Model name               |
| `apiKey`            | `string?`  | Google AI Studio API key |
| `vertexai`          | `boolean?` | Use Vertex AI            |
| `project`           | `string?`  | GCP project ID (Vertex)  |
| `location`          | `string?`  | GCP region (Vertex)      |
| `googleAuthOptions` | `object?`  | Auth options (Vertex)    |
| `temperature`       | `number?`  | Sampling temperature     |
| `maxTokens`         | `number?`  | Maximum tokens           |

## Documentation

See the [full documentation](https://rlindgren.github.io/tentickle).
