/**
 * Gateway Configuration System
 *
 * Type-safe, extensible configuration with module augmentation.
 * Packages extend FileConfig via `declare module "@agentick/gateway"`.
 *
 * ConfigStore is the read path — always use .get(key), never destructured
 * snapshots. Hot-reload-aware from day one (onChange handlers).
 *
 * Schema registry lets each package register a Zod fragment at module load
 * time. Gateway merges and validates once at startup.
 */

import type { ZodLikeSchema } from "./types.js";

// ============================================================================
// Config Interfaces (module augmentation targets)
// ============================================================================

/** Core gateway config — augmented by packages via `declare module` */
export interface FileConfig {
  gateway?: {
    port?: number;
    host?: string;
    transport?: "websocket" | "http" | "both";
    logging?: {
      /** Log level (default: "info"). Set to "trace" for full event stream visibility. */
      level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
      /** Log output file path. When set, logs are written here instead of stdout. */
      file?: string;
    };
  };
  connectors?: ConnectorConfigs;
  providers?: ProviderConfigs;
}

/** Connector config — each connector plugin augments this */
export interface ConnectorConfigs {}

/** Provider config — each adapter augments this */
export interface ProviderConfigs {}

// ============================================================================
// ConfigStore
// ============================================================================

export interface ConfigStore {
  /** Get a top-level config section */
  get<K extends keyof FileConfig>(key: K): FileConfig[K];

  /** Get the fully resolved config snapshot */
  resolved(): Readonly<FileConfig>;

  /** Get the config with secret values replaced by "***" */
  redacted(): Readonly<FileConfig>;

  /** Subscribe to changes (hot-reload ready, noop initially) */
  onChange(handler: (config: Readonly<FileConfig>) => void): () => void;
}

export function createConfigStore(resolved: FileConfig, secretPaths?: Set<string>): ConfigStore {
  const frozen = Object.freeze(structuredClone(resolved));
  const secrets = secretPaths ?? new Set<string>();
  const handlers = new Set<(config: Readonly<FileConfig>) => void>();

  return {
    get<K extends keyof FileConfig>(key: K): FileConfig[K] {
      return frozen[key];
    },

    resolved(): Readonly<FileConfig> {
      return frozen;
    },

    redacted(): Readonly<FileConfig> {
      if (secrets.size === 0) return frozen;
      return redactPaths(frozen, secrets);
    },

    onChange(handler: (config: Readonly<FileConfig>) => void): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

/** Replace values at dot-paths with "***" */
function redactPaths(config: Readonly<FileConfig>, secretPaths: Set<string>): FileConfig {
  const cloned = structuredClone(config) as Record<string, unknown>;

  for (const dotPath of secretPaths) {
    const parts = dotPath.split(".");
    let current: Record<string, unknown> = cloned;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (typeof current[part] !== "object" || current[part] === null) break;
      current = current[part] as Record<string, unknown>;
    }

    const lastKey = parts[parts.length - 1];
    if (lastKey in current) {
      current[lastKey] = "***";
    }
  }

  return Object.freeze(cloned) as FileConfig;
}

// ============================================================================
// Schema Registry
// ============================================================================

const schemaFragments = new Map<string, ZodLikeSchema>();
let builtSchema: ZodLikeSchema | null = null;

/** Register a config schema fragment (called at module load time) */
export function registerConfigSchema(key: string, schema: ZodLikeSchema): void {
  if (builtSchema) {
    throw new Error(
      `Cannot register schema for "${key}" after buildConfigSchema() has been called`,
    );
  }
  if (schemaFragments.has(key)) {
    throw new Error(`Config schema already registered for "${key}"`);
  }
  schemaFragments.set(key, schema);
}

/**
 * Build the merged schema from all registered fragments.
 * Returns a ZodLikeSchema whose parse() validates the full config.
 *
 * The merged schema is an object where each registered key maps to
 * its fragment schema (all optional at the top level).
 */
export function buildConfigSchema(): ZodLikeSchema {
  if (builtSchema) return builtSchema;

  // Build a composite validator from fragments
  const fragments = new Map(schemaFragments);

  builtSchema = {
    parse(data: unknown): FileConfig {
      if (typeof data !== "object" || data === null) {
        throw new Error("Config must be an object");
      }
      const obj = data as Record<string, unknown>;
      const result: Record<string, unknown> = {};

      for (const [key, schema] of fragments) {
        if (key in obj) {
          result[key] = schema.parse(obj[key]);
        }
      }

      // Pass through keys without schemas (future-proofing)
      for (const key of Object.keys(obj)) {
        if (!fragments.has(key)) {
          result[key] = obj[key];
        }
      }

      return result as FileConfig;
    },
    _output: {} as FileConfig,
  };

  return builtSchema;
}

/** Reset schema registry (for testing only) */
export function resetConfigSchemaRegistry(): void {
  schemaFragments.clear();
  builtSchema = null;
}

// ============================================================================
// Global Binding
// ============================================================================

let _configStore: ConfigStore | null = null;

export function bindConfig(store: ConfigStore): void {
  _configStore = store;
}

export function getConfig(): ConfigStore {
  if (!_configStore) {
    throw new Error("Config not bound — call bindConfig() during startup");
  }
  return _configStore;
}

export function getConfigOrNull(): ConfigStore | null {
  return _configStore;
}

/** Reset global binding (for testing only) */
export function resetConfigBinding(): void {
  _configStore = null;
}
