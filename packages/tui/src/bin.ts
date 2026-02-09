#!/usr/bin/env node

/**
 * CLI binary for launching the Agentick TUI.
 *
 * Usage:
 *   agentick-tui --app path/to/app.ts
 *   agentick-tui --app path/to/app.ts --export myApp
 *   agentick-tui --app path/to/app.ts --ui ./dashboard.tsx --ui-export MonitorDashboard
 *   agentick-tui --url https://my-app.fly.dev/api --session my-session
 */

import * as path from "node:path";
import { createTUI } from "./create-tui.js";
import type { TUIComponent } from "./create-tui.js";
import { builtinUIs, type BuiltinUIName } from "./ui/index.js";

// ============================================================================
// Arg parsing
// ============================================================================

interface ParsedArgs {
  app?: string;
  export?: string;
  url?: string;
  session?: string;
  ui?: string;
  uiExport?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  const positional = argv.slice(2);

  for (let i = 0; i < positional.length; i++) {
    const arg = positional[i]!;
    const next = positional[i + 1];

    switch (arg) {
      case "--app":
        args.app = next;
        i++;
        break;
      case "--export":
        args.export = next;
        i++;
        break;
      case "--url":
        args.url = next;
        i++;
        break;
      case "--session":
        args.session = next;
        i++;
        break;
      case "--ui":
        args.ui = next;
        i++;
        break;
      case "--ui-export":
        args.uiExport = next;
        i++;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
    }
  }

  return args;
}

function printUsage() {
  console.log(
    `
agentick-tui — Launch an Agentick app in the terminal

Usage:
  agentick-tui --app <path>     Load app from a local file
  agentick-tui --url <url>      Connect to a remote app

Options:
  --app <path>        Path to a file exporting an App instance
  --export <name>     Named export to use (default: auto-detect)
  --url <url>         Remote gateway URL
  --session <id>      Session ID (default: "main")
  --ui <name|path>    Built-in UI name or path to custom UI file (default: "chat")
  --ui-export <name>  Named export from custom UI file (default: auto-detect)
  --help, -h          Show this help

Built-in UIs:
  chat                Default conversational interface
  `.trim(),
  );
}

// ============================================================================
// Type guards
// ============================================================================

function isApp(value: unknown): value is { send: Function } {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof (value as any).send === "function"
  );
}

function isComponent(value: unknown): value is Function {
  return typeof value === "function";
}

// ============================================================================
// Module helpers
// ============================================================================

/** Load a module by file path, exit on failure. */
async function loadModule(filePath: string): Promise<Record<string, unknown>> {
  const resolved = path.resolve(process.cwd(), filePath);
  try {
    return await import(resolved);
  } catch (err) {
    console.error(`Error loading module from ${resolved}:`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/**
 * Scan a module for an export matching a predicate.
 * Tries well-known names first, then scans all exports.
 */
function findExport<T>(
  mod: Record<string, unknown>,
  check: (value: unknown) => value is T,
  wellKnownNames: string[],
): T | undefined {
  for (const name of wellKnownNames) {
    const exported = mod[name];
    if (check(exported)) return exported;
  }
  for (const value of Object.values(mod)) {
    if (check(value)) return value;
  }
  return undefined;
}

// ============================================================================
// App resolution
// ============================================================================

/** Find an App instance in a module. */
function findApp(mod: Record<string, unknown>, exportName?: string): { send: Function } {
  if (exportName) {
    const exported = mod[exportName];
    if (exported === undefined) {
      throw new Error(`Export "${exportName}" not found in module`);
    }
    if (!isApp(exported)) {
      throw new Error(`Export "${exportName}" does not appear to be an App (no .send method)`);
    }
    return exported;
  }

  const app = findExport(mod, isApp, ["app", "default"]);
  if (app) return app;

  throw new Error(
    "No App export found. Ensure your module exports an object with a .send() method, or use --export <name>.",
  );
}

// ============================================================================
// UI resolution
// ============================================================================

/** Find a TUI component in a module. */
function findUIComponent(mod: Record<string, unknown>, exportName?: string): TUIComponent {
  if (exportName) {
    const exported = mod[exportName];
    if (exported === undefined) {
      throw new Error(`Export "${exportName}" not found in UI module`);
    }
    if (!isComponent(exported)) {
      throw new Error(`Export "${exportName}" is not a function component`);
    }
    return exported as TUIComponent;
  }

  const component = findExport(mod, isComponent, ["default", "TUI", "UI"]);
  if (component) return component as TUIComponent;

  throw new Error(
    "No component export found. Export a React component, or use --ui-export <name>.",
  );
}

/** Resolve --ui flag: built-in name, file path, or undefined (use default). */
async function resolveUI(uiArg?: string, uiExport?: string): Promise<TUIComponent | undefined> {
  if (!uiArg) return undefined;

  if (uiArg in builtinUIs) {
    return builtinUIs[uiArg as BuiltinUIName];
  }

  const mod = await loadModule(uiArg);
  return findUIComponent(mod, uiExport);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!args.app && !args.url) {
    console.error("Error: Provide --app <path> or --url <url>\n");
    printUsage();
    process.exit(1);
  }

  if (args.app && args.url) {
    console.error("Error: --app and --url are mutually exclusive\n");
    printUsage();
    process.exit(1);
  }

  const ui = await resolveUI(args.ui, args.uiExport);

  if (args.url) {
    await createTUI({ url: args.url, sessionId: args.session, ui }).start();
    return;
  }

  const mod = await loadModule(args.app!);
  const app = findApp(mod, args.export);
  await createTUI({ app: app as any, sessionId: args.session, ui }).start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
