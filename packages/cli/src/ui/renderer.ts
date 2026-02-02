/**
 * Renderer - Terminal output rendering
 */

import chalk from "chalk";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

export interface RendererOptions {
  /** Enable markdown rendering */
  markdown?: boolean;

  /** Enable debug output */
  debug?: boolean;

  /** Enable colors (default: true) */
  colors?: boolean;
}

/**
 * Terminal renderer with markdown support
 */
export class Renderer {
  private options: RendererOptions;
  private marked: Marked;
  private _isStreaming = false;
  private streamBuffer = "";
  private _isDebug: boolean;

  constructor(options: RendererOptions = {}) {
    this.options = options;
    this._isDebug = options.debug ?? false;

    // Set up marked with terminal renderer
    this.marked = new Marked();
    this.marked.use(
      markedTerminal({
        // Customize terminal rendering
        code: chalk.cyan,
        blockquote: chalk.gray.italic,
        html: chalk.gray,
        heading: chalk.bold,
        firstHeading: chalk.bold.underline,
        hr: chalk.gray,
        listitem: chalk.reset,
        table: chalk.reset,
        paragraph: chalk.reset,
        strong: chalk.bold,
        em: chalk.italic,
        codespan: chalk.cyan,
        del: chalk.strikethrough,
        link: chalk.blue.underline,
        href: chalk.blue.underline,
      }),
    );
  }

  get isDebug(): boolean {
    return this._isDebug;
  }

  toggleDebug(): void {
    this._isDebug = !this._isDebug;
  }

  /**
   * Render markdown text
   */
  markdown(text: string): string {
    if (!this.options.markdown) {
      return text;
    }
    try {
      return this.marked.parse(text) as string;
    } catch {
      return text;
    }
  }

  /**
   * Print an info message
   */
  info(message: string): void {
    console.log(chalk.gray(message));
  }

  /**
   * Print an error message
   */
  error(message: string): void {
    console.error(chalk.red(`Error: ${message}`));
  }

  /**
   * Print a debug message
   */
  debug(message: string, data?: unknown): void {
    if (!this._isDebug) return;
    if (data !== undefined) {
      console.log(chalk.dim(`[DEBUG] ${message}`), data);
    } else {
      console.log(chalk.dim(`[DEBUG] ${message}`));
    }
  }

  /**
   * Start streaming output
   */
  streamStart(): void {
    this._isStreaming = true;
    this.streamBuffer = "";
    process.stdout.write(chalk.green("\nAgent: "));
  }

  /**
   * Add delta to stream
   */
  streamDelta(text: string): void {
    if (!this._isStreaming) return;
    this.streamBuffer += text;
    process.stdout.write(text);
  }

  /**
   * End streaming and render final output
   */
  streamEnd(): void {
    if (!this._isStreaming) return;
    this._isStreaming = false;

    // Move to new line after stream
    console.log("\n");

    this.streamBuffer = "";
  }

  /**
   * Show tool execution start
   */
  toolStart(name: string, args: Record<string, unknown>): void {
    const argsStr =
      Object.keys(args).length > 0 ? ` ${chalk.dim(JSON.stringify(args).slice(0, 50))}...` : "";
    console.log(chalk.yellow(`\n[tool: ${name}]${argsStr}`));
  }

  /**
   * Show tool execution end
   */
  toolEnd(name: string, _result: unknown): void {
    this.debug(`Tool ${name} completed`);
  }

  /**
   * Render a complete response (non-streaming)
   */
  response(text: string): void {
    console.log(chalk.green("\nAgent: ") + this.markdown(text) + "\n");
  }

  /**
   * Render user input echo
   */
  userInput(text: string): void {
    console.log(chalk.blue("You: ") + text);
  }

  /**
   * Print a separator line
   */
  separator(): void {
    console.log(chalk.dim("─".repeat(50)));
  }

  /**
   * Clear the screen
   */
  clear(): void {
    console.clear();
  }

  /**
   * Print JSON output
   */
  json(data: unknown): void {
    console.log(JSON.stringify(data, null, 2));
  }

  /**
   * Print plain text
   */
  plain(text: string): void {
    console.log(text);
  }
}
