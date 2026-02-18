# @agentick/secrets

Platform-native secret storage for Agentick agents. Stores credentials in
the OS keychain on macOS and Linux, with env var fallback everywhere else.

## Install

```sh
pnpm add @agentick/secrets
```

## Quick Start

```typescript
import { createSecretStore } from "@agentick/secrets";

const secrets = await createSecretStore();

await secrets.set("telegram.token", "bot123:ABC-xyz");
const token = await secrets.get("telegram.token");
```

`createSecretStore()` auto-detects the best backend for the current platform.

## How It Works

```
createSecretStore()
    |
    v
Platform detection
    |
    +-- macOS ------> Keychain (security CLI)
    +-- Linux ------> libsecret (secret-tool CLI)
    +-- Fallback ---> Environment variables
```

All keychain operations use `execFile` with argument arrays — no shell
interpolation, no injection risk.

## Backends

### Keychain (macOS)

Stores secrets in the macOS Keychain via the `security` CLI. Secrets are
encrypted at rest, protected by the login keychain, and accessible to
Keychain Access.app.

```typescript
import { createKeychainStore } from "@agentick/secrets";

const secrets = createKeychainStore({ service: "my-agent" });
```

The `service` parameter scopes secrets (default: `"agentick"`). A manifest
key tracks all stored keys for `list()`.

### libsecret (Linux)

Stores secrets via `secret-tool`, the CLI for GNOME Keyring / KWallet.
Requires `libsecret` and a running secret service.

```typescript
import { createLibsecretStore } from "@agentick/secrets";

const secrets = createLibsecretStore({ service: "my-agent" });
```

`list()` uses `secret-tool search` natively — no manifest needed.

### Environment Variables

Reads from `process.env`. Dot-path keys are normalized to `UPPER_SNAKE_CASE`.

```typescript
import { createEnvStore } from "@agentick/secrets";

const secrets = createEnvStore({ prefix: "MYAGENT" });

// secrets.get("telegram.token") → process.env.MYAGENT_TELEGRAM_TOKEN
```

Without a prefix, keys map directly: `telegram.token` → `TELEGRAM_TOKEN`.

### Memory

In-memory Map. For testing.

```typescript
import { createMemoryStore } from "@agentick/secrets";

const secrets = createMemoryStore({ "api.key": "test-value" });
```

## Explicit Backend Selection

Override auto-detection when needed.

```typescript
const secrets = await createSecretStore({ backend: "env", envPrefix: "MYAPP" });
const secrets = await createSecretStore({ backend: "keychain", service: "my-agent" });
const secrets = await createSecretStore({ backend: "memory" });
```

## Use with Connectors

Pass a secret store to connectors instead of hardcoding tokens.

```typescript
import { createSecretStore } from "@agentick/secrets";
import { TelegramPlatform } from "@agentick/connector-telegram";

const secrets = await createSecretStore();
const token = await secrets.get("telegram.token");

const platform = new TelegramPlatform({ token: token! });
```

## SecretStore Interface

Defined in `@agentick/shared` so any package can accept it as a dependency.

```typescript
interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  list(): Promise<string[]>;
  readonly backend: string;
}
```

## Exports

```typescript
// Factory (auto-detects backend)
export { createSecretStore } from "./create-secret-store.js";
export type { CreateSecretStoreOptions, SecretStoreBackend } from "./create-secret-store.js";

// Backends
export { createKeychainStore } from "./keychain-store.js";
export { createLibsecretStore } from "./libsecret-store.js";
export { createEnvStore } from "./env-store.js";
export { createMemoryStore } from "./memory-store.js";
export type { KeychainStoreOptions } from "./keychain-store.js";
export type { LibsecretStoreOptions } from "./libsecret-store.js";
export type { EnvStoreOptions } from "./env-store.js";

// Interface (re-exported from @agentick/shared)
export type { SecretStore } from "@agentick/shared";
```
