# @agentick/gateway — Configuration System

## Design Decisions

### Why gateway owns config

Config cascades down to apps and sessions the same way `GatewayHandle` is
injected into session ALS context. The gateway already owns app registration,
plugin lifecycle, and session management. Config is the same story — it's
process-level state that everything reads from.

### Module augmentation over union types

Each package extends `FileConfig` via `declare module "@agentick/gateway"`.
This means adding a new config section requires zero changes to the gateway
package — the connector/adapter/plugin just declares its shape and it's
automatically typed on `ConfigStore.get()`.

The alternative — a discriminated union or generic parameter — would require
gateway to know about every consumer's config shape. Module augmentation
avoids that entirely.

### ConfigStore as read path, not a bag of values

`store.get("connectors")` not `config.connectors`. This gives us:
- Hot-reload: `onChange()` handlers are wired from day one (just not triggered yet)
- Redaction: `store.redacted()` replaces secret-interpolated values with `"***"`
- Isolation: `resolved()` returns a frozen deep clone. Mutations are impossible.

### loadConfig() does NOT auto-bind

`loadConfig()` returns a `ConfigStore`. The caller is responsible for calling
`bindConfig(store)`. This was an explicit design choice after the first
implementation auto-bound — side effects hidden inside a "load" function are
a debugging nightmare.

### ZodLikeSchema instead of Zod

The schema registry uses `ZodLikeSchema` (an object with `parse()` and
`_output`). This avoids a hard dependency on Zod, which means:
- No Zod version conflicts between consumers
- Any validator that implements `parse()` works
- The gateway package stays dependency-light

### Secret path tracking via closure

`createConfigStore(config, secretPaths)` captures the secret paths in a
closure. `store.redacted()` uses them internally. The secret paths are NOT
exposed on the public API — earlier iteration leaked `_secretPaths` as a
public property, which was ugly and invited misuse.

## File Map

| File | Purpose |
|------|---------|
| `config.ts` | FileConfig, ConnectorConfigs, ProviderConfigs, ConfigStore, schema registry, global binding |
| `config-loader.ts` | `loadConfig()`, `interpolateConfig()`, `ConfigValidationError`, `deepMerge` |
| `types.ts` | `configStore?` + `configPath?` on GatewayConfig, `config` on PluginContext |
| `method-schemas.ts` | `"config"` built-in method, `"config:changed"` event type |
| `transport-protocol.ts` | `ConfigPayload`, `"config"` in BuiltInMethod union |

## Config Flow

```
                     agentick.config.json
                            │
                     readFileSync + JSON.parse
                            │
                     interpolateConfig()
                     ├── ${env:VAR} → process.env
                     └── ${secret:KEY} → SecretStore.get()
                            │
                     deepMerge(interpolated, overrides)
                            │
                     buildConfigSchema().parse(merged)
                            │
                     createConfigStore(validated, secretPaths)
                            │
                     bindConfig(store)    ← caller does this
                            │
              ┌─────────────┼─────────────┐
              │             │             │
         getConfig()   PluginContext   "config" RPC
         (any code)    .config         → redacted()
```

## Schema Registry

Packages register fragments at module load time:

```typescript
registerConfigSchema("connectors", {
  parse: (data) => connectorSchema.parse(data),
  _output: {} as ConnectorConfigs,
});
```

`buildConfigSchema()` merges all fragments into a composite validator.
Keys without schemas pass through (future-proofing). The merged schema is
built once and cached.

## Gateway Startup Sequence

1. Constructor receives optional `configStore` in `GatewayConfig`
2. If provided → use it. If not → `createConfigStore({})` (empty placeholder)
3. `bindConfig()` called immediately so plugins have a config reference
4. `start()` — if no pre-loaded store, `loadConfig({ path })` replaces it
5. `bindConfig()` called again with the file-loaded store
6. Config is available via `PluginContext.config` for all plugins

The constructor-before-start split ensures plugins initialized in the
constructor always have a valid `ConfigStore` reference — even if it's
empty until `start()` loads the file.

## Protocol

- **`config` method**: Returns `configStore.redacted()`. Secrets replaced with `"***"`.
- **`config:changed` event**: Declared in `GATEWAY_EVENT_TYPES`. Not emitted yet — reserved for hot-reload.
- Both appear automatically in schema discovery (`schema` method response).
