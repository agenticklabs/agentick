/**
 * Configuration validation for `McpServerConfig`.
 *
 * Eager, structural validation only — verifies the shape adopters
 * supplied, throws a typed `McpServerConfigInvalid` on malformed
 * inputs. Does NOT verify that referenced transports / auth stages
 * actually exist or can connect; those errors surface from the
 * runtime layers (#171c+).
 */

import type { McpServerConfig, McpServerError } from "@agentick/spec-next";

/**
 * Validate + normalize an `McpServerConfig`. Throws
 * `McpServerConfigInvalid` on bad input. Returns the (frozen) config
 * with any normalization applied.
 *
 * Adopters never call this directly — `McpServerHarness` invokes it at
 * construction. Exported here for testing + composability.
 */
export function validateConfig(config: McpServerConfig): McpServerConfig {
  if (typeof config.name !== "string" || config.name.length === 0) {
    throw invalid("name must be a non-empty string", ["name"]);
  }
  if (!Array.isArray(config.transports) || config.transports.length === 0) {
    throw invalid("transports must be a non-empty array", ["transports"]);
  }
  for (const [i, transport] of config.transports.entries()) {
    if (transport == null || typeof transport !== "object") {
      throw invalid(`transports[${i}] must be a transport-spec object`, ["transports", String(i)]);
    }
    if (typeof (transport as { kind?: unknown }).kind !== "string") {
      throw invalid(`transports[${i}].kind must be a string`, ["transports", String(i), "kind"]);
    }
  }
  if (config.tools !== undefined && config.tools !== null && typeof config.tools !== "object") {
    throw invalid("tools must be a McpServerToolsConfig object", ["tools"]);
  }
  if (
    config.prompts !== undefined &&
    config.prompts !== null &&
    typeof config.prompts !== "object"
  ) {
    throw invalid("prompts must be a McpServerPromptsConfig object", ["prompts"]);
  }
  if (
    config.capabilities !== undefined &&
    config.capabilities !== null &&
    typeof config.capabilities !== "object"
  ) {
    throw invalid("capabilities must be a McpServerCapabilitiesConfig object", ["capabilities"]);
  }
  if (config.auth !== undefined && config.auth !== null && typeof config.auth !== "object") {
    throw invalid("auth must be a McpServerAuthConfig object", ["auth"]);
  }
  return config;
}

function invalid(reason: string, path?: readonly string[]): McpServerError {
  return {
    _tag: "McpServerConfigInvalid" as const,
    reason,
    ...(path ? { path } : {}),
  };
}
