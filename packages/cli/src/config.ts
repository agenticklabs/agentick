/**
 * Configuration loading and management
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * CLI configuration
 */
export interface Config {
  url?: string;
  sessionId?: string;
  token?: string;
  debug?: boolean;
}

/**
 * Config file structure
 */
interface ConfigFile {
  defaultUrl?: string;
  defaultToken?: string;
  aliases?: Record<string, string>;
  debug?: boolean;
}

/**
 * Get config file path
 */
function getConfigPath(): string {
  return path.join(os.homedir(), ".tentickle", "config.json");
}

/**
 * Load config file
 */
function loadConfigFile(): ConfigFile | null {
  const configPath = getConfigPath();

  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(content) as ConfigFile;
    }
  } catch {
    // Ignore config file errors
  }

  return null;
}

/**
 * Resolve URL alias
 */
function resolveAlias(url: string, configFile: ConfigFile | null): string {
  if (configFile?.aliases && configFile.aliases[url]) {
    return configFile.aliases[url];
  }
  return url;
}

/**
 * Load configuration from environment, config file, and CLI options
 */
export function loadConfig(cliOptions: {
  url?: string;
  session?: string;
  token?: string;
  debug?: boolean;
}): Config {
  const configFile = loadConfigFile();

  // Priority: CLI > Environment > Config file
  let url = cliOptions.url ?? process.env.TENTICKLE_URL ?? configFile?.defaultUrl;

  // Resolve alias if URL looks like one
  if (url && !url.includes("://")) {
    url = resolveAlias(url, configFile);
  }

  const sessionId = cliOptions.session ?? process.env.TENTICKLE_SESSION;

  const token = cliOptions.token ?? process.env.TENTICKLE_TOKEN ?? configFile?.defaultToken;

  const debug =
    cliOptions.debug || process.env.TENTICKLE_DEBUG === "1" || configFile?.debug || false;

  return {
    url,
    sessionId,
    token,
    debug,
  };
}

/**
 * Save configuration
 */
export function saveConfig(config: Partial<ConfigFile>): void {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);

  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Load existing config
  let existing: ConfigFile = {};
  try {
    if (fs.existsSync(configPath)) {
      existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch {
    // Ignore
  }

  // Merge and save
  const merged = { ...existing, ...config };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
}
