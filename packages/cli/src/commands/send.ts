/**
 * Send command - Non-interactive message sending
 */

import * as fs from "fs";
import { CLI } from "../cli.js";
import { Renderer } from "../ui/renderer.js";
import { loadConfig } from "../config.js";

interface SendOptions {
  url?: string;
  session?: string;
  token?: string;
  stdin?: boolean;
  format?: "plain" | "json" | "markdown";
  stream?: boolean;
}

export async function sendCommand(message: string, options: SendOptions): Promise<void> {
  const config = loadConfig(options);

  if (!config.url) {
    console.error("Error: Server URL is required. Use --url or set TENTICKLE_URL.");
    process.exit(1);
  }

  const renderer = new Renderer({
    markdown: options.format === "markdown",
  });

  // Read stdin if requested
  let fullMessage = message;
  if (options.stdin) {
    const stdinData = fs.readFileSync(0, "utf-8");
    fullMessage = `${message}\n\n${stdinData}`;
  }

  const cli = new CLI({
    url: config.url,
    sessionId: config.sessionId,
    token: config.token,
    streaming: options.stream !== false,
  });

  try {
    let response = "";

    if (options.stream !== false) {
      // Stream mode - show output as it arrives
      cli.on("stream:delta", ({ text }) => {
        process.stdout.write(text);
      });

      cli.on("tool:start", ({ name }) => {
        if (options.format !== "json") {
          process.stderr.write(`\n[tool: ${name}]\n`);
        }
      });

      response = await cli.send(fullMessage);
      console.log(); // Newline after streaming
    } else {
      // Non-stream mode - wait for complete response
      response = await cli.send(fullMessage);
    }

    // Output based on format
    switch (options.format) {
      case "json":
        renderer.json({
          response,
          sessionId: cli.sessionId,
        });
        break;
      case "markdown":
        if (options.stream === false) {
          renderer.response(response);
        }
        break;
      case "plain":
      default:
        if (options.stream === false) {
          renderer.plain(response);
        }
        break;
    }

    cli.destroy();
    process.exit(0);
  } catch (error) {
    renderer.error(error instanceof Error ? error.message : String(error));
    cli.destroy();
    process.exit(1);
  }
}
