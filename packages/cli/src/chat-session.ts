/**
 * ChatSession - Interactive chat session
 */

import * as readline from "readline";
import { CLI, type CLIConfig } from "./cli.js";
import { Renderer } from "./ui/renderer.js";

export interface ChatSessionOptions extends CLIConfig {
  /** Custom prompt (default: "You: ") */
  prompt?: string;

  /** Enable markdown rendering (default: true) */
  markdown?: boolean;
}

interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  handler: (args: string[]) => Promise<boolean> | boolean; // Return true to continue, false to exit
}

/**
 * Interactive chat session
 */
export class ChatSession {
  private cli: CLI;
  private renderer: Renderer;
  private options: ChatSessionOptions;
  private rl?: readline.Interface;
  private isRunning = false;
  private commands: Map<string, SlashCommand> = new Map();

  constructor(options: ChatSessionOptions) {
    this.options = options;
    this.cli = new CLI(options);
    this.renderer = new Renderer({
      markdown: options.markdown ?? true,
      debug: options.debug,
    });

    this.setupCommands();
    this.setupEventHandlers();
  }

  private setupCommands(): void {
    const commands: SlashCommand[] = [
      {
        name: "help",
        aliases: ["h", "?"],
        description: "Show available commands",
        handler: () => {
          this.showHelp();
          return true;
        },
      },
      {
        name: "quit",
        aliases: ["exit", "q"],
        description: "Exit the chat",
        handler: () => false,
      },
      {
        name: "status",
        description: "Show session status",
        handler: () => {
          this.showStatus();
          return true;
        },
      },
      {
        name: "clear",
        aliases: ["cls"],
        description: "Clear the screen",
        handler: () => {
          console.clear();
          return true;
        },
      },
      {
        name: "debug",
        description: "Toggle debug mode",
        handler: () => {
          this.renderer.toggleDebug();
          this.renderer.info(`Debug mode: ${this.renderer.isDebug ? "on" : "off"}`);
          return true;
        },
      },
    ];

    for (const cmd of commands) {
      this.commands.set(cmd.name, cmd);
      if (cmd.aliases) {
        for (const alias of cmd.aliases) {
          this.commands.set(alias, cmd);
        }
      }
    }
  }

  private setupEventHandlers(): void {
    this.cli.on("stream:delta", ({ text }) => {
      this.renderer.streamDelta(text);
    });

    this.cli.on("stream:start", () => {
      this.renderer.streamStart();
    });

    this.cli.on("stream:end", () => {
      this.renderer.streamEnd();
    });

    this.cli.on("tool:start", ({ name, args }) => {
      this.renderer.toolStart(name, args);
    });

    this.cli.on("tool:end", ({ name, result }) => {
      this.renderer.toolEnd(name, result);
    });

    this.cli.on("error", (error) => {
      this.renderer.error(error.message);
    });
  }

  private showHelp(): void {
    const uniqueCommands = new Map<string, SlashCommand>();
    for (const [name, cmd] of this.commands) {
      if (!uniqueCommands.has(cmd.name)) {
        uniqueCommands.set(cmd.name, cmd);
      }
    }

    this.renderer.info("\nAvailable commands:");
    for (const [name, cmd] of uniqueCommands) {
      const aliases = cmd.aliases?.length ? ` (${cmd.aliases.join(", ")})` : "";
      this.renderer.info(`  /${name}${aliases} - ${cmd.description}`);
    }
    console.log();
  }

  private showStatus(): void {
    const sessionId = this.cli.sessionId ?? "not connected";
    const connected = this.cli.isConnected ? "yes" : "no";

    this.renderer.info("\nSession Status:");
    this.renderer.info(`  Session ID: ${sessionId}`);
    this.renderer.info(`  Connected: ${connected}`);
    this.renderer.info(`  URL: ${this.options.url}`);
    console.log();
  }

  private async handleCommand(input: string): Promise<boolean> {
    const [cmdName, ...args] = input.slice(1).split(/\s+/);
    const cmd = this.commands.get(cmdName.toLowerCase());

    if (!cmd) {
      this.renderer.error(`Unknown command: /${cmdName}. Type /help for available commands.`);
      return true;
    }

    return cmd.handler(args);
  }

  private async handleMessage(message: string): Promise<void> {
    try {
      await this.cli.send(message);
    } catch (error) {
      this.renderer.error(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Start the interactive session
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Print welcome message
    this.renderer.info(`Connected to ${this.options.url}`);
    if (this.cli.sessionId) {
      this.renderer.info(`Session: ${this.cli.sessionId}`);
    }
    this.renderer.info("Type /help for commands, /quit to exit\n");

    const prompt = this.options.prompt ?? "You: ";

    const promptForInput = (): void => {
      if (!this.isRunning) return;

      this.rl!.question(prompt, async (input) => {
        const trimmed = input.trim();

        if (!trimmed) {
          promptForInput();
          return;
        }

        // Handle commands
        if (trimmed.startsWith("/")) {
          const shouldContinue = await this.handleCommand(trimmed);
          if (!shouldContinue) {
            this.stop();
            return;
          }
          promptForInput();
          return;
        }

        // Handle regular message
        await this.handleMessage(trimmed);
        promptForInput();
      });
    };

    // Handle Ctrl+C
    this.rl.on("close", () => {
      this.stop();
    });

    promptForInput();
  }

  /**
   * Stop the session
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    this.renderer.info("\nGoodbye!");
    this.rl?.close();
    this.cli.destroy();
    process.exit(0);
  }
}
