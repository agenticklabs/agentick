#!/usr/bin/env node
/**
 * `agentick-mcp-server` — Mode A standalone CLI.
 *
 * Loads a config file, spawns an `McpServerHarness` in a minimal
 * in-process shell, attaches transports, runs until SIGINT/SIGTERM.
 *
 * Usage:
 *   agentick-mcp-server --config ./mcp-server.config.ts
 *   agentick-mcp-server ./mcp-server.config.ts
 *
 * The config module must default-export a `SpawnStandaloneOptions`
 * object (or a function returning one — for dynamic config, env-var-
 * driven values, etc.).
 *
 *   // mcp-server.config.ts
 *   import { stdioTransport } from "@agentick/mcp-next/server";
 *   import { createTool } from "@agentick/tool-next";
 *   export default {
 *     config: { name: "my-server", transports: [{ kind: "stdio" }] },
 *     transports: [stdioTransport()],
 *     tools: [
 *       createTool({ name: "search", description: "...",
 *                    handler: async () => [{ type: "text", text: "ok" }] }),
 *     ],
 *   };
 *
 * See ADR 40 §10 for Mode A vs Mode B (gateway extension).
 */

import { spawnStandaloneMcpServer, type SpawnStandaloneOptions } from "./spawn.js";

interface CliArgs {
  readonly configPath: string;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let configPath: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--config" || arg === "-c") {
      configPath = argv[++i];
    } else if (!arg.startsWith("-")) {
      configPath = arg;
    } else {
      printErr(`Unknown argument: ${arg}`);
      process.exit(64); // EX_USAGE
    }
  }
  if (!configPath && !help) {
    printErr("Missing --config <path>. See --help.");
    process.exit(64);
  }
  return { configPath: configPath ?? "", help };
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "agentick-mcp-server — Mode A standalone MCP server",
      "",
      "Usage:",
      "  agentick-mcp-server --config <path>",
      "  agentick-mcp-server <path>",
      "",
      "The config module must default-export a SpawnStandaloneOptions",
      "object — see @agentick/mcp-next/server documentation for shape.",
      "",
      "ADR 40 §10 documents Mode A vs Mode B (gateway extension).",
    ].join("\n"),
  );
}

function printErr(message: string): void {
  // eslint-disable-next-line no-console
  console.error(`agentick-mcp-server: ${message}`);
}

async function loadConfig(path: string): Promise<SpawnStandaloneOptions> {
  // Resolve relative paths against the cwd so adopters can write
  // `./mcp-server.config.ts` without prefixing.
  const { resolve, isAbsolute } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const moduleSpecifier = pathToFileURL(absolute).href;
  const mod = (await import(moduleSpecifier)) as { default?: unknown };
  if (!mod.default) {
    throw new Error(
      `Config module at ${absolute} has no default export. Export a SpawnStandaloneOptions object.`,
    );
  }
  const candidate =
    typeof mod.default === "function"
      ? await (mod.default as () => SpawnStandaloneOptions | Promise<SpawnStandaloneOptions>)()
      : (mod.default as SpawnStandaloneOptions);
  return candidate;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  let config: SpawnStandaloneOptions;
  try {
    config = await loadConfig(args.configPath);
  } catch (cause) {
    printErr(`Failed to load config: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(78); // EX_CONFIG
    return;
  }

  let handle: { close(): Promise<void> } | null = null;
  try {
    handle = await spawnStandaloneMcpServer(config);
  } catch (cause) {
    printErr(`Failed to start server: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(70); // EX_SOFTWARE
    return;
  }

  // Graceful shutdown on signals. Both SIGINT (Ctrl-C) and SIGTERM
  // (systemd / docker stop) trigger a clean close — drain connections,
  // shut down the harness, then exit 0.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    printErr(`Received ${signal}, shutting down.`);
    try {
      await handle!.close();
    } catch (cause) {
      printErr(`Error during shutdown: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Stay alive — the transports keep the event loop occupied via their
  // open streams, but we'd exit otherwise if all transports immediately
  // close (e.g., a misconfigured stdio with no upstream connection).
  // Block on an unresolving promise; signal handlers do the unblock.
  await new Promise<never>(() => {});
}

void main();
