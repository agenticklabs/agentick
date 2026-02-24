/**
 * Config Loader
 *
 * Reads a JSON config file, interpolates secrets/env vars, validates
 * against the merged schema, and returns a frozen ConfigStore.
 *
 * Merge order: schema defaults → config file → env overrides → explicit overrides.
 */

import { readFileSync, existsSync } from "node:fs";
import type { SecretStore } from "@agentick/shared";
import {
  type FileConfig,
  type ConfigStore,
  createConfigStore,
  buildConfigSchema,
} from "./config.js";

// ============================================================================
// Interpolation
// ============================================================================

const ENV_PATTERN = /^\$\{env:([^}]+)\}$/;
const SECRET_PATTERN = /^\$\{secret:([^}]+)\}$/;

/**
 * Resolve ${env:VAR} and ${secret:KEY} in string values.
 * Walks the object tree recursively. Returns a deep clone with resolved values.
 * Tracks which dot-paths came from secret interpolation (for redaction).
 */
export async function interpolateConfig(
  raw: Record<string, unknown>,
  secrets?: SecretStore,
): Promise<{ resolved: Record<string, unknown>; secretPaths: Set<string> }> {
  const secretPaths = new Set<string>();

  async function walk(obj: unknown, path: string): Promise<unknown> {
    if (typeof obj === "string") {
      const envMatch = obj.match(ENV_PATTERN);
      if (envMatch) {
        const varName = envMatch[1];
        const value = process.env[varName];
        if (value === undefined) {
          throw new ConfigValidationError(
            `Environment variable "${varName}" not set (referenced at ${path})`,
          );
        }
        return value;
      }

      const secretMatch = obj.match(SECRET_PATTERN);
      if (secretMatch) {
        const keyName = secretMatch[1];
        if (!secrets) {
          throw new ConfigValidationError(
            `Secret "${keyName}" referenced at ${path} but no SecretStore provided`,
          );
        }
        const value = await secrets.get(keyName);
        if (value === null) {
          throw new ConfigValidationError(`Secret "${keyName}" not found (referenced at ${path})`);
        }
        secretPaths.add(path);
        return value;
      }

      return obj;
    }

    if (Array.isArray(obj)) {
      return Promise.all(obj.map((item, i) => walk(item, `${path}[${i}]`)));
    }

    if (typeof obj === "object" && obj !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = await walk(value, path ? `${path}.${key}` : key);
      }
      return result;
    }

    return obj;
  }

  const resolved = (await walk(raw, "")) as Record<string, unknown>;
  return { resolved, secretPaths };
}

// ============================================================================
// Config Validation Error
// ============================================================================

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

// ============================================================================
// Loader
// ============================================================================

export interface LoadConfigOptions {
  /** Path to config file (default: ./agentick.config.json) */
  path?: string;
  /** Secret store for ${secret:KEY} interpolation */
  secrets?: SecretStore;
  /** CLI/env overrides applied after file (highest priority) */
  overrides?: Partial<FileConfig>;
}

/**
 * Load config from file, interpolate, validate, and return a ConfigStore.
 * Does NOT call bindConfig() — callers bind explicitly.
 */
export async function loadConfig(options?: LoadConfigOptions): Promise<ConfigStore> {
  const configPath = options?.path ?? "./agentick.config.json";

  // 1. Read file (or empty object if missing)
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      raw = JSON.parse(content);
    } catch (err) {
      throw new ConfigValidationError(
        `Failed to parse config file ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2. Interpolate secrets/env
  const { resolved: interpolated, secretPaths } = await interpolateConfig(raw, options?.secrets);

  // 3. Apply overrides (highest priority)
  const merged = deepMerge(interpolated, options?.overrides ?? {});

  // 4. Validate with merged schema
  const schema = buildConfigSchema();
  let validated: FileConfig;
  try {
    validated = schema.parse(merged) as FileConfig;
  } catch (err) {
    throw new ConfigValidationError(
      `Config validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 5. Create store (caller is responsible for binding)
  return createConfigStore(validated, secretPaths);
}

// ============================================================================
// Helpers
// ============================================================================

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}
