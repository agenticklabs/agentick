import { useState, useCallback, useRef } from "react";

// --- Types ---

export interface SlashCommand {
  name: string;
  description: string;
  aliases?: string[];
  args?: string;
  handler: (args: string, ctx: CommandContext) => void | Promise<void>;
}

export interface CommandContext {
  sessionId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send: (...args: any[]) => any;
  abort: () => void;
  output: (text: string) => void;
  addCommand: (cmd: SlashCommand) => void;
  removeCommand: (name: string) => void;
}

// --- Built-in command factories ---

export function helpCommand(): SlashCommand {
  return {
    name: "help",
    description: "Show available commands",
    handler: (_args, ctx) => {
      // Access commands via closure — the registry ref is captured in useSlashCommands
      ctx.output("Unknown command registry — /help is wired internally");
    },
  };
}

export function clearCommand(onClear: () => void): SlashCommand {
  return {
    name: "clear",
    description: "Clear message history",
    handler: () => {
      onClear();
    },
  };
}

export function exitCommand(onExit: () => void): SlashCommand {
  return {
    name: "exit",
    description: "Exit",
    aliases: ["quit"],
    handler: () => {
      onExit();
    },
  };
}

export function loadCommand(): SlashCommand {
  return {
    name: "load",
    description: "Load a command from a file",
    args: "<path>",
    handler: async (args, ctx) => {
      const filePath = args.trim();
      if (!filePath) {
        ctx.output("Usage: /load <path>");
        return;
      }

      const resolved = filePath.startsWith("/") ? filePath : `${process.cwd()}/${filePath}`;

      try {
        const mod = await import(resolved);
        const cmd: SlashCommand | undefined = mod.command ?? mod.default;

        if (!cmd || !cmd.name || !cmd.description || !cmd.handler) {
          ctx.output(
            `Invalid command file: expected export const command: SlashCommand or export default`,
          );
          return;
        }

        ctx.addCommand(cmd);
        ctx.output(`Loaded /${cmd.name} — ${cmd.description}`);
      } catch (err) {
        ctx.output(
          `Failed to load ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

// --- Help formatting ---

function formatHelp(commands: SlashCommand[]): string {
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];

  for (const cmd of sorted) {
    const nameWithArgs = cmd.args ? `/${cmd.name} ${cmd.args}` : `/${cmd.name}`;
    const aliasStr =
      cmd.aliases && cmd.aliases.length > 0
        ? ` (aliases: ${cmd.aliases.map((a) => `/${a}`).join(", ")})`
        : "";
    const padded = nameWithArgs.padEnd(20);
    lines.push(`  ${padded}${cmd.description}${aliasStr}`);
  }

  return lines.join("\n");
}

// --- The hook ---

interface UseSlashCommandsResult {
  dispatch: (input: string) => boolean;
  commands: SlashCommand[];
  addCommand: (cmd: SlashCommand) => void;
  removeCommand: (name: string) => void;
}

export function useSlashCommands(
  initial: (SlashCommand | SlashCommand[])[],
  ctx: Omit<CommandContext, "addCommand" | "removeCommand">,
): UseSlashCommandsResult {
  const [registry, setRegistry] = useState<Map<string, SlashCommand>>(() => {
    const map = new Map<string, SlashCommand>();
    for (const item of initial.flat()) {
      map.set(item.name, item);
    }
    return map;
  });

  // Keep a ref so dispatch always sees current registry without re-creating the callback
  const registryRef = useRef(registry);
  registryRef.current = registry;

  const addCommand = useCallback((cmd: SlashCommand) => {
    setRegistry((prev) => {
      const next = new Map(prev);
      next.set(cmd.name, cmd);
      return next;
    });
  }, []);

  const removeCommand = useCallback((name: string) => {
    setRegistry((prev) => {
      const next = new Map(prev);
      next.delete(name);
      return next;
    });
  }, []);

  const dispatch = useCallback(
    (input: string): boolean => {
      if (!input.startsWith("/")) return false;

      const spaceIdx = input.indexOf(" ");
      const name = spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? "" : input.slice(spaceIdx + 1);

      const reg = registryRef.current;

      // Direct name match
      let cmd = reg.get(name);

      // Alias match
      if (!cmd) {
        for (const candidate of reg.values()) {
          if (candidate.aliases?.includes(name)) {
            cmd = candidate;
            break;
          }
        }
      }

      if (!cmd) {
        ctx.output(`Unknown command: /${name}. Type /help for available commands.`);
        return true;
      }

      // Special-case /help: format with current registry
      if (cmd.name === "help") {
        ctx.output(formatHelp([...reg.values()]));
        return true;
      }

      const fullCtx: CommandContext = {
        ...ctx,
        addCommand,
        removeCommand,
      };

      cmd.handler(args, fullCtx);
      return true;
    },
    [ctx, addCommand, removeCommand],
  );

  return {
    dispatch,
    commands: [...registry.values()],
    addCommand,
    removeCommand,
  };
}
