# @tentickle/google

Google AI / Vertex AI adapter for Tentickle.

## Installation

```bash
pnpm add @tentickle/google
```

## Usage

### Factory Pattern (Recommended)

```tsx
import { google } from '@tentickle/google';
import { createApp } from '@tentickle/core';

// Google AI Studio
const model = google({
  apiKey: process.env.GOOGLE_API_KEY,
  model: 'gemini-2.0-flash',
});

// Use with createApp
const app = createApp(MyAgent, { model });
const session = await app.session();
await session.run({ message: 'Hello!' });

// Or use as JSX component
function MyAgent() {
  return (
    <model temperature={0.7}>
      <System>You are helpful.</System>
      <Timeline />
    </model>
  );
}

// Or call directly
const result = await model.generate({
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Vertex AI

```tsx
const model = google({
  vertexai: true,
  project: process.env.GCP_PROJECT_ID,
  location: 'us-central1',
  model: 'gemini-2.0-flash',
  googleAuthOptions: {
    credentials: JSON.parse(process.env.GCP_CREDENTIALS),
  },
});
```

### JSX Component Pattern

```tsx
import { GoogleModel } from '@tentickle/google';

function MyAgent() {
  return (
    <GoogleModel
      apiKey={process.env.GOOGLE_API_KEY}
      model="gemini-2.0-flash"
      temperature={0.7}
    >
      <System>You are helpful.</System>
      <Timeline />
    </GoogleModel>
  );
}
```

## Configuration

| Option              | Type       | Description                           |
| ------------------- | ---------- | ------------------------------------- |
| `model`             | `string`   | Model name (e.g., `gemini-2.0-flash`) |
| `apiKey`            | `string?`  | Google AI Studio API key              |
| `vertexai`          | `boolean?` | Use Vertex AI instead                 |
| `project`           | `string?`  | GCP project ID (Vertex)               |
| `location`          | `string?`  | GCP region (Vertex)                   |
| `googleAuthOptions` | `object?`  | Auth options (Vertex)                 |
| `temperature`       | `number?`  | Sampling temperature                  |
| `maxTokens`         | `number?`  | Maximum tokens to generate            |

## Exports

- `google(config)` - Factory function returning `ModelClass`
- `createGoogleModel(config)` - Same as `google()`
- `GoogleModel` - JSX component for declarative usage
